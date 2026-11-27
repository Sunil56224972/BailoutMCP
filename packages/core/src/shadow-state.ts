import fs from 'node:fs';
import path from 'node:path';
import { normalizeErrorSignature, normalizeFilePath } from './normalizer.js';
import { isSensitiveFilePath } from './security.js';
import type {
  BailoutConfig,
  FileHotspot,
  LineRange,
  MicroWinEvent,
  RecurringErrorSummary,
  SignalBreakdown,
  TelemetrySignal,
} from './types.js';

interface WeightedEvent {
  timestamp: number;
  category: keyof SignalBreakdown;
  weight: number;
  label: string;
}

interface InternalFileState {
  canonicalKey: string;
  filePath: string;
  events: WeightedEvent[];
  undoTimestamps: number[];
  recentRegionHashes: string[];
  oscillationCount: number;
  undoCount: number;
  churnCount: number;
  dwellMs: number;
  lastFocusAt?: number;
  lastActivityAt: number;
  hotspotRange?: LineRange;
  errorsByFingerprint: Map<string, RecurringErrorSummary>;
  attemptedFixes: string[];
  activeAgentModel?: string;
  cooldownUntil: number;
  dismissCount: number;
}

const CATEGORY_CAPS: Record<keyof SignalBreakdown, number> = {
  undoBurst: 32,
  editChurn: 28,
  fileDwell: 22,
  recurringErrors: 45,
  agentLoop: 40,
  promptHesitation: 25,
};

const MAX_RETAINED_EVENTS = 160;
const MAX_REGION_HISTORY = 12;
const MAX_ATTEMPTED_FIXES = 8;
const MAX_TRACKED_FILES = 200;
const STALE_FILE_TTL_MS = 30 * 60 * 1000;

const THIRD_PARTY_OR_BUILD_SEGMENTS = new Set([
  'node_modules',
  '.pnpm',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  'vendor',
  'site-packages',
  '.venv',
  'venv',
  'target',
]);

const STACK_PATTERNS: Array<{ re: RegExp; pathIdx: number; lineIdx: number }> = [
  // Python traceback: File "/path/to/app.py", line 42
  { re: /File "([^"\r\n]+\.[A-Za-z0-9]{1,8})",\s*line\s+(\d+)/g, pathIdx: 1, lineIdx: 2 },
  // Rust compiler: --> src/main.rs:12:5
  { re: /-->\s+([^\s:()"']+\.[A-Za-z0-9]{1,8}):(\d+)(?::\d+)?/g, pathIdx: 1, lineIdx: 2 },
  // Windows drive path (both C:\ and C:/), supporting :line:col or (line,col)
  {
    re: /([A-Za-z]:[\\/][^:\r\n()"']+?\.[A-Za-z0-9]{1,8})(?::(\d+)(?::\d+)?|\((\d+),\d+\))/g,
    pathIdx: 1,
    lineIdx: 2,
  },
  // POSIX / relative path (including Next.js [id], (group), @scope), supporting :line:col or (line,col)
  {
    re: /((?:\.{0,2}[\\/])?[A-Za-z0-9_.@[\]()/-]+\.[A-Za-z0-9]{1,8})(?::(\d+)(?::\d+)?|\((\d+),\d+\))/g,
    pathIdx: 1,
    lineIdx: 2,
  },
];

function isThirdPartyOrBuildPath(resolvedPath: string): boolean {
  const segments = resolvedPath.split(/[\\/]/).map((s) => s.toLowerCase());
  return segments.some((seg) => THIRD_PARTY_OR_BUILD_SEGMENTS.has(seg));
}

/**
 * Extracts a real existing user source file path and line number from multi-frame
 * compiler/test/runtime stack traces (JS/TS, Python, Rust, Go, Java, C#) when a CLI
 * command fails without an explicit `filePath`. Prioritizes workspace source files
 * and refuses to blame `node_modules` / `site-packages` / build output directories.
 */
function inferFileFromErrorText(
  message: string | undefined,
  workspaceRoot: string | undefined,
): { filePath: string; line?: number } | undefined {
  if (!message) return undefined;

  const seen = new Set<string>();
  const candidates: Array<{ filePath: string; line?: number; isInWorkspace: boolean }> = [];
  const normalizedRoot = workspaceRoot ? normalizeFilePath(workspaceRoot) : undefined;

  for (const { re, pathIdx, lineIdx } of STACK_PATTERNS) {
    re.lastIndex = 0;
    for (const match of message.matchAll(re)) {
      const rawPath = match[pathIdx]?.trim();
      if (
        !rawPath ||
        rawPath.startsWith('node:') ||
        rawPath.startsWith('internal/') ||
        rawPath.startsWith('http://') ||
        rawPath.startsWith('https://') ||
        rawPath.startsWith('webpack:')
      ) {
        continue;
      }

      const candidate = path.isAbsolute(rawPath)
        ? path.normalize(rawPath)
        : workspaceRoot
          ? path.resolve(workspaceRoot, rawPath)
          : path.resolve(rawPath);

      const key = normalizeFilePath(candidate);
      if (seen.has(key)) continue;
      seen.add(key);

      if (isSensitiveFilePath(candidate) || isThirdPartyOrBuildPath(candidate)) {
        continue;
      }

      try {
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
          continue;
        }
      } catch {
        continue;
      }

      const rawLine = match[lineIdx] ?? match[lineIdx + 1];
      const lineNum = Number(rawLine);
      const isInWorkspace = normalizedRoot
        ? key === normalizedRoot || key.startsWith(normalizedRoot + path.sep)
        : true;

      candidates.push({
        filePath: candidate,
        line: Number.isFinite(lineNum) && lineNum > 0 ? lineNum : undefined,
        isInWorkspace,
      });
    }
  }

  return candidates.find((c) => c.isInWorkspace) ?? candidates[0];
}

export interface IngestOutcome {
  hotspot?: FileHotspot;
  microWin?: MicroWinEvent;
}

/**
 * ShadowStateTracker fuses silent local behavioral signals (undo bursts,
 * edit churn/oscillation, friction-gated file dwell, recurring normalized
 * error signatures, lightweight-agent error loops, and prompt abandonment)
 * into a time-decayed 0-100 frustration score per file.
 */
export class ShadowStateTracker {
  private readonly files = new Map<string, InternalFileState>();
  private activeFileKey?: string;
  private config: BailoutConfig;

  constructor(config: BailoutConfig) {
    this.config = config;
  }

  updateConfig(config: BailoutConfig): void {
    this.config = config;
  }

  getActiveFilePath(): string | undefined {
    if (!this.activeFileKey) return undefined;
    return this.files.get(this.activeFileKey)?.filePath;
  }

  ingest(signal: TelemetrySignal): IngestOutcome {
    const now = signal.timestamp ?? Date.now();
    let targetPath = signal.filePath;
    let inferredLine: number | undefined;

    if (!targetPath) {
      const inferred = inferFileFromErrorText(
        signal.message,
        signal.workspaceRoot ?? this.config.workspaceRoot,
      );
      if (inferred) {
        targetPath = inferred.filePath;
        inferredLine = inferred.line;
      } else {
        targetPath = this.getActiveFilePath();
      }
    }

    if (!targetPath || isSensitiveFilePath(targetPath)) {
      return {};
    }

    const state = this.getOrCreateFileState(targetPath, now);
    const wasSameActiveFile = this.activeFileKey === state.canonicalKey;
    this.activeFileKey = state.canonicalKey;

    if (wasSameActiveFile && state.lastFocusAt !== undefined && now > state.lastFocusAt) {
      const delta = now - state.lastFocusAt;
      if (delta <= 120_000) {
        state.dwellMs += delta;
      }
    }
    state.lastFocusAt = now;
    state.lastActivityAt = now;

    if (signal.lineRange) {
      state.hotspotRange = signal.lineRange;
    } else if (inferredLine !== undefined && !state.hotspotRange) {
      state.hotspotRange = { startLine: inferredLine, endLine: inferredLine };
    }
    if (signal.agentModel) {
      state.activeAgentModel = signal.agentModel;
    }
    if (signal.attemptedFix) {
      this.pushUnique(state.attemptedFixes, signal.attemptedFix.trim(), MAX_ATTEMPTED_FIXES);
    }

    let microWin: MicroWinEvent | undefined;

    switch (signal.kind) {
      case 'file_focus':
      case 'keystroke_activity': {
        break;
      }

      case 'undo_burst': {
        const count = Math.max(1, Math.min(50, signal.count ?? 1));
        for (let i = 0; i < count; i++) {
          state.undoTimestamps.push(now);
        }
        state.undoTimestamps = state.undoTimestamps.filter((ts) => now - ts <= 25_000);
        state.undoCount += count;

        const burstSize = state.undoTimestamps.length;
        const weight = burstSize >= 5 ? 16 : burstSize >= 3 ? 11 : 4.5 * count;
        this.pushEvent(state, {
          timestamp: now,
          category: 'undoBurst',
          weight,
          label: `${burstSize} rapid undos (Ctrl+Z burst)`,
        });
        break;
      }

      case 'edit_churn': {
        const count = Math.max(1, Math.min(20, signal.count ?? 1));
        state.churnCount += count;
        let weight = Math.min(12, 4.5 * count);
        let label = 'High edit churn on same lines';

        if (signal.regionHash) {
          const prevIdx = state.recentRegionHashes.lastIndexOf(signal.regionHash);
          const isImmediateRepeat = prevIdx === state.recentRegionHashes.length - 1;
          if (prevIdx !== -1 && !isImmediateRepeat) {
            state.oscillationCount += 1;
            weight += 12;
            label = `Code oscillation (A→B→A revert loop x${state.oscillationCount})`;
          }
          state.recentRegionHashes.push(signal.regionHash);
          if (state.recentRegionHashes.length > MAX_REGION_HISTORY) {
            state.recentRegionHashes.shift();
          }
        }

        this.pushEvent(state, {
          timestamp: now,
          category: 'editChurn',
          weight,
          label,
        });
        break;
      }

      case 'file_dwell': {
        if (signal.durationMs && signal.durationMs > 0) {
          state.dwellMs += Math.min(signal.durationMs, 30 * 60 * 1000);
        }
        break;
      }

      case 'diagnostic_error':
      case 'terminal_error': {
        const rawMsg =
          signal.message?.trim() ||
          (signal.exitCode !== undefined
            ? `Command failed with exit code ${signal.exitCode}`
            : 'Unknown error');
        const { normalized, fingerprint } = normalizeErrorSignature(rawMsg, signal.code);
        const existing = state.errorsByFingerprint.get(fingerprint);
        const repeatCount = existing ? existing.count + 1 : 1;

        state.errorsByFingerprint.set(fingerprint, {
          fingerprint,
          normalized,
          latestRaw: rawMsg.slice(0, 1200),
          count: repeatCount,
          firstSeenAt: existing?.firstSeenAt ?? now,
          lastSeenAt: now,
          code: signal.code ?? existing?.code,
        });

        const base = signal.kind === 'terminal_error' ? 9 : 7;
        const repeatBonus =
          repeatCount >= 4 ? 18 : repeatCount === 3 ? 14 : repeatCount === 2 ? 9 : 0;
        this.pushEvent(state, {
          timestamp: now,
          category: 'recurringErrors',
          weight: base + repeatBonus,
          label:
            repeatCount > 1
              ? `Same error repeated ${repeatCount}x: ${normalized.slice(0, 72)}`
              : `Error: ${normalized.slice(0, 72)}`,
        });
        break;
      }

      case 'agent_tool_error': {
        const rawMsg = signal.message?.trim() || 'Agent tool execution failed';
        const { normalized, fingerprint } = normalizeErrorSignature(rawMsg, signal.code);
        const existing = state.errorsByFingerprint.get(fingerprint);
        const repeatCount = existing ? existing.count + 1 : 1;

        state.errorsByFingerprint.set(fingerprint, {
          fingerprint,
          normalized,
          latestRaw: rawMsg.slice(0, 1200),
          count: repeatCount,
          firstSeenAt: existing?.firstSeenAt ?? now,
          lastSeenAt: now,
          code: signal.code ?? existing?.code,
        });

        const modelTag = state.activeAgentModel ?? 'coding agent';
        const weight = repeatCount >= 3 ? 22 : repeatCount === 2 ? 15 : 9;
        this.pushEvent(state, {
          timestamp: now,
          category: 'agentLoop',
          weight,
          label: `${modelTag} looping (${repeatCount}x): ${normalized.slice(0, 64)}`,
        });
        break;
      }

      case 'prompt_abandoned': {
        const count = Math.max(1, Math.min(10, signal.count ?? 1));
        this.pushEvent(state, {
          timestamp: now,
          category: 'promptHesitation',
          weight: Math.min(20, 10 * count),
          label:
            signal.message?.trim() ||
            `Prompt drafted and deleted/rewritten (${count}x hesitation)`,
        });
        break;
      }

      case 'error_resolved': {
        const before = this.computeHotspot(state, now);
        const hadMeaningfulFriction =
          before.score >= this.config.frictionThreshold ||
          state.errorsByFingerprint.size > 0;
        const resolvedCount = Array.from(state.errorsByFingerprint.values()).reduce(
          (sum, err) => sum + err.count,
          0,
        );

        state.errorsByFingerprint.clear();
        state.undoTimestamps = [];
        state.events = state.events
          .map((evt) => ({ ...evt, weight: evt.weight * 0.15 }))
          .filter((evt) => evt.weight >= 1);

        if (hadMeaningfulFriction && resolvedCount > 0) {
          const mins = Math.max(1, Math.round(state.dwellMs / 60_000));
          microWin = {
            filePath: state.filePath,
            timestamp: now,
            previousScore: before.score,
            resolvedErrorCount: resolvedCount,
            dwellMs: state.dwellMs,
            message: `Micro-win: cleared ${resolvedCount} recurring error signal(s) on ${state.filePath} after ~${mins}m.`,
          };
          state.dwellMs = 0;
          state.undoCount = 0;
          state.churnCount = 0;
          state.oscillationCount = 0;
        }
        break;
      }
    }

    this.pruneColdFiles(now);

    return {
      hotspot: this.computeHotspot(state, now),
      microWin,
    };
  }

  setCooldown(filePath: string, now: number, multiplier = 1): number {
    const state = this.getOrCreateFileState(filePath, now);
    const until = now + Math.round(this.config.cooldownMs * multiplier);
    state.cooldownUntil = Math.max(state.cooldownUntil, until);
    return state.cooldownUntil;
  }

  recordDismissal(filePath: string, now: number): number {
    const state = this.getOrCreateFileState(filePath, now);
    state.dismissCount += 1;
    const multiplier = Math.min(4, Math.pow(2, state.dismissCount - 1));
    return this.setCooldown(filePath, now, multiplier);
  }

  resetFileFriction(filePath: string): void {
    const key = normalizeFilePath(filePath);
    const state = this.files.get(key);
    if (!state) return;
    state.events = [];
    state.undoTimestamps = [];
    state.recentRegionHashes = [];
    state.errorsByFingerprint.clear();
    state.dwellMs = 0;
    state.undoCount = 0;
    state.churnCount = 0;
    state.oscillationCount = 0;
  }

  resetAll(): void {
    this.files.clear();
    this.activeFileKey = undefined;
  }

  getHotspot(filePath: string, now = Date.now()): FileHotspot | undefined {
    const state = this.files.get(normalizeFilePath(filePath));
    if (!state) return undefined;
    return this.computeHotspot(state, now);
  }

  getHotspots(now = Date.now()): FileHotspot[] {
    const result: FileHotspot[] = [];
    for (const state of this.files.values()) {
      const hotspot = this.computeHotspot(state, now);
      if (
        hotspot.score >= 1 ||
        state.canonicalKey === this.activeFileKey ||
        now - state.lastActivityAt < 15 * 60 * 1000
      ) {
        result.push(hotspot);
      }
    }
    return result.sort((a, b) => b.score - a.score);
  }

  private pruneColdFiles(now: number): void {
    if (this.files.size <= MAX_TRACKED_FILES) return;
    const candidates = Array.from(this.files.values())
      .filter((s) => s.canonicalKey !== this.activeFileKey)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);

    for (const state of candidates) {
      if (this.files.size <= MAX_TRACKED_FILES) break;
      if (now - state.lastActivityAt > STALE_FILE_TTL_MS || this.files.size > MAX_TRACKED_FILES) {
        this.files.delete(state.canonicalKey);
      }
    }
  }

  private getOrCreateFileState(filePath: string, now: number): InternalFileState {
    const canonicalKey = normalizeFilePath(filePath);
    let existing = this.files.get(canonicalKey);
    if (!existing) {
      existing = {
        canonicalKey,
        filePath,
        events: [],
        undoTimestamps: [],
        recentRegionHashes: [],
        oscillationCount: 0,
        undoCount: 0,
        churnCount: 0,
        dwellMs: 0,
        lastActivityAt: now,
        errorsByFingerprint: new Map(),
        attemptedFixes: [],
        cooldownUntil: 0,
        dismissCount: 0,
      };
      this.files.set(canonicalKey, existing);
    }
    return existing;
  }

  private pushEvent(state: InternalFileState, event: WeightedEvent): void {
    state.events.push(event);
    if (state.events.length > MAX_RETAINED_EVENTS) {
      state.events.splice(0, state.events.length - MAX_RETAINED_EVENTS);
    }
  }

  private pushUnique(list: string[], value: string, max: number): void {
    if (!value) return;
    if (list[list.length - 1] === value) return;
    list.push(value);
    if (list.length > max) {
      list.shift();
    }
  }

  private computeHotspot(state: InternalFileState, now: number): FileHotspot {
    const halfLife = Math.max(30_000, this.config.decayHalfLifeMs);
    const breakdown: SignalBreakdown = {
      undoBurst: 0,
      editChurn: 0,
      fileDwell: 0,
      recurringErrors: 0,
      agentLoop: 0,
      promptHesitation: 0,
    };

    const activeReasons = new Map<string, number>();

    for (const evt of state.events) {
      const ageMs = Math.max(0, now - evt.timestamp);
      const decay = Math.pow(0.5, ageMs / halfLife);
      const decayedWeight = evt.weight * decay;
      if (decayedWeight < 0.25) continue;

      breakdown[evt.category] += decayedWeight;
      activeReasons.set(evt.label, Math.max(activeReasons.get(evt.label) ?? 0, decayedWeight));
    }

    (Object.keys(CATEGORY_CAPS) as Array<keyof SignalBreakdown>).forEach((key) => {
      breakdown[key] = Math.min(CATEGORY_CAPS[key], Math.round(breakdown[key] * 10) / 10);
    });

    const nonDwellFriction =
      breakdown.undoBurst +
      breakdown.editChurn +
      breakdown.recurringErrors +
      breakdown.agentLoop +
      breakdown.promptHesitation;

    if (nonDwellFriction >= 15 && state.dwellMs >= 2 * 60 * 1000) {
      const minutes = state.dwellMs / 60_000;
      const dwellScore = Math.min(CATEGORY_CAPS.fileDwell, Math.round(minutes * 2.2 * 10) / 10);
      breakdown.fileDwell = dwellScore;
      if (minutes >= 3) {
        activeReasons.set(
          `Stuck on same file for ${Math.round(minutes)}m while errors persist`,
          dwellScore,
        );
      }
    }

    const activeCategories = (Object.values(breakdown) as number[]).filter((v) => v >= 8).length;
    const synergyBonus = activeCategories >= 4 ? 12 : activeCategories === 3 ? 7 : 0;

    const rawScore =
      breakdown.undoBurst +
      breakdown.editChurn +
      breakdown.fileDwell +
      breakdown.recurringErrors +
      breakdown.agentLoop +
      breakdown.promptHesitation +
      synergyBonus;

    const score = Math.min(100, Math.round(rawScore));

    const reasons = Array.from(activeReasons.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label]) => label);

    const recurringErrors = Array.from(state.errorsByFingerprint.values())
      .filter((err) => now - err.lastSeenAt <= halfLife * 3)
      .sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 5);

    return {
      filePath: state.filePath,
      score,
      breakdown,
      reasons,
      hotspotRange: state.hotspotRange,
      dwellMs: state.dwellMs,
      undoCount: state.undoCount,
      churnCount: state.churnCount,
      oscillationCount: state.oscillationCount,
      recurringErrors,
      attemptedFixes: [...state.attemptedFixes],
      activeAgentModel: state.activeAgentModel,
      lastActivityAt: state.lastActivityAt,
      cooldownUntil: state.cooldownUntil,
    };
  }
}
