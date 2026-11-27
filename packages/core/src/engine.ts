import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { getRouterReadiness, loadConfig } from './config.js';
import { distillBailoutDossier } from './distiller.js';
import { normalizeFilePath } from './normalizer.js';
import {
  applyProposalToDisk,
  isProposalStillValidForContent,
  validateAndBuildPatch,
} from './patcher.js';
import { BailoutRouter } from './router.js';
import {
  assertSafeWorkspacePath,
  isPathInsideRoot,
  isSafeWorkspaceRootDir,
  isSensitiveFilePath,
} from './security.js';
import { ShadowStateTracker } from './shadow-state.js';
import { TimingGate } from './timing-gate.js';
import type {
  BailoutConfig,
  BailoutDossier,
  BailoutProposal,
  EngineStats,
  FileHotspot,
  MicroWinEvent,
  ShadowPhase,
  ShadowStateSnapshot,
  TelemetrySignal,
} from './types.js';

export interface BailoutEngineEvents {
  state_changed: [ShadowStateSnapshot];
  bailout_solving: [{ filePath: string; score: number; reasons: string[] }];
  bailout_ready: [BailoutProposal];
  bailout_surfaceable: [BailoutProposal];
  bailout_accepted: [BailoutProposal];
  bailout_dismissed: [BailoutProposal];
  bailout_invalidated: [{ proposal: BailoutProposal; reason: string }];
  micro_win: [MicroWinEvent];
  error: [Error];
}

export interface ManualBailoutOptions {
  filePath?: string;
  fileContentOverride?: string;
  force?: boolean;
  errorMessage?: string;
  attemptedFix?: string;
  startLine?: number;
  endLine?: number;
}

function safeReadTextFile(filePath: string, maxBytes: number): string | undefined {
  try {
    if (isSensitiveFilePath(filePath) || !fs.existsSync(filePath)) return undefined;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * BailoutEngine orchestrates the real-world Shadow-State lifecycle:
 *   Local Telemetry Signals -> Time-Decayed Frustration Score ->
 *   Workspace & Secret Guard -> Silent Real Heavy-Model Solve ->
 *   Exact Snippet & Safety Validation -> Anti-Annoyance Pause-Gated Delivery.
 */
export class BailoutEngine extends EventEmitter {
  private config: BailoutConfig;
  private readonly explicitRootsLocked: boolean;
  private readonly tracker: ShadowStateTracker;
  private readonly timingGate: TimingGate;
  private readonly router: BailoutRouter;

  private solvingFiles = new Set<string>();
  private pendingBailout?: BailoutProposal;
  private lastDossier?: BailoutDossier;
  private lastError?: string;
  private bailoutTimestamps: number[] = [];
  private stats: EngineStats = {
    signalsProcessed: 0,
    bailoutsTriggered: 0,
    bailoutsReady: 0,
    bailoutsAccepted: 0,
    bailoutsDismissed: 0,
    bailoutsRejectedUnsafe: 0,
    bailoutsFailed: 0,
    selfResolvedCount: 0,
    microWinsDetected: 0,
    bailoutsThisHour: 0,
    bailoutsToday: 0,
  };

  constructor(configOverrides?: Partial<BailoutConfig>) {
    super();
    this.config = loadConfig(configOverrides);
    this.explicitRootsLocked = Boolean(this.config.explicitRootsLocked);
    this.tracker = new ShadowStateTracker(this.config);
    this.timingGate = new TimingGate(this.config);
    this.router = new BailoutRouter(this.config);
  }

  getConfig(): BailoutConfig {
    return structuredClone(this.config);
  }

  updateConfig(partial: Partial<BailoutConfig>): BailoutConfig {
    const cleanPartial: Partial<BailoutConfig> = {};
    for (const [k, v] of Object.entries(partial)) {
      if (v !== undefined) {
        (cleanPartial as Record<string, unknown>)[k] = v;
      }
    }
    this.config = loadConfig({ ...this.config, ...cleanPartial }, this.config.workspaceRoot);
    this.tracker.updateConfig(this.config);
    this.timingGate.updateConfig(this.config);
    this.router.updateConfig(this.config);
    this.lastError = undefined;
    this.emit('state_changed', this.getSnapshot());
    return this.getConfig();
  }

  getLastDossier(): BailoutDossier | undefined {
    return this.lastDossier;
  }

  /**
   * Distills and returns a secret-redacted BailoutDossier 100% locally without making
   * any outbound LLM API calls — ideal for dry-run inspection or offline root-cause debugging.
   */
  previewDossier(filePath?: string, fileContentOverride?: string): BailoutDossier {
    const now = Date.now();
    const targetPath = filePath ?? this.tracker.getActiveFilePath();
    if (!targetPath) {
      throw new Error('No active filePath specified or tracked in Shadow-State.');
    }
    const safePath = assertSafeWorkspacePath(targetPath, this.config.allowedWorkspaceRoots);
    let hotspot = this.tracker.getHotspot(safePath, now);
    if (!hotspot) {
      const { hotspot: created } = this.tracker.ingest({
        kind: 'file_focus',
        filePath: safePath,
        timestamp: now,
        source: 'mcp-client',
      });
      hotspot = created!;
    }
    const dossier = distillBailoutDossier(hotspot, this.config, { fileContentOverride });
    this.lastDossier = dossier;
    return dossier;
  }

  /**
   * Resets Shadow-State friction debt for a single file or the entire workspace session.
   */
  resetState(filePath?: string, now = Date.now()): ShadowStateSnapshot {
    if (filePath) {
      this.tracker.resetFileFriction(filePath);
      if (
        this.pendingBailout &&
        normalizeFilePath(this.pendingBailout.filePath) === normalizeFilePath(filePath)
      ) {
        const stale = this.pendingBailout;
        stale.status = 'stale';
        this.pendingBailout = undefined;
        this.emit('bailout_invalidated', {
          proposal: stale,
          reason: 'Shadow-State friction explicitly reset for file.',
        });
      }
    } else {
      this.tracker.resetAll();
      if (this.pendingBailout) {
        const stale = this.pendingBailout;
        stale.status = 'stale';
        this.pendingBailout = undefined;
        this.emit('bailout_invalidated', {
          proposal: stale,
          reason: 'Shadow-State session explicitly reset.',
        });
      }
      this.lastError = undefined;
    }

    const snap = this.getSnapshot(now);
    this.emit('state_changed', snap);
    return snap;
  }

  /**
   * Registers a safe local workspace root reported by an authenticated IDE/CLI client
   * when strict root locking (`BAILOUT_ALLOWED_ROOTS`) was not pinned.
   */
  private maybeRegisterWorkspaceRoot(candidateDir?: string): void {
    if (this.explicitRootsLocked || !candidateDir) return;
    if (!isSafeWorkspaceRootDir(candidateDir)) return;
    const resolved = path.resolve(candidateDir);
    const alreadyCovered = this.config.allowedWorkspaceRoots.some((root) =>
      isPathInsideRoot(resolved, root),
    );
    if (!alreadyCovered && this.config.allowedWorkspaceRoots.length < 16) {
      this.config.allowedWorkspaceRoots.push(resolved);
    }
  }

  /**
   * Ingest a single local behavioral/error telemetry signal.
   */
  ingest(signal: TelemetrySignal, fileContentOverride?: string): ShadowStateSnapshot {
    const now = signal.timestamp ?? Date.now();
    this.stats.signalsProcessed += 1;

    if (signal.workspaceRoot) {
      this.maybeRegisterWorkspaceRoot(signal.workspaceRoot);
    }

    const isEdit =
      signal.kind === 'keystroke_activity' ||
      signal.kind === 'edit_churn' ||
      signal.kind === 'undo_burst';

    if (isEdit || signal.kind === 'file_focus') {
      this.timingGate.recordActivity(now, isEdit);
    }

    const { hotspot, microWin } = this.tracker.ingest({ ...signal, timestamp: now });

    if (microWin) {
      this.stats.microWinsDetected += 1;
      if (
        this.pendingBailout &&
        normalizeFilePath(this.pendingBailout.filePath) === normalizeFilePath(microWin.filePath)
      ) {
        const stale = this.pendingBailout;
        stale.status = 'self_resolved';
        this.pendingBailout = undefined;
        this.stats.selfResolvedCount += 1;
        this.emit('bailout_invalidated', {
          proposal: stale,
          reason: 'Developer resolved the bug themselves (micro-win reset).',
        });
      }
      this.emit('micro_win', microWin);
    }

    if (this.pendingBailout && isEdit && signal.filePath) {
      if (
        normalizeFilePath(this.pendingBailout.filePath) === normalizeFilePath(signal.filePath)
      ) {
        const currentContent =
          fileContentOverride ??
          safeReadTextFile(signal.filePath, this.config.maxFileSizeBytes);
        if (
          currentContent !== undefined &&
          !isProposalStillValidForContent(
            this.pendingBailout,
            currentContent,
            this.config.maxPatchLines,
          )
        ) {
          const stale = this.pendingBailout;
          stale.status = 'stale';
          this.pendingBailout = undefined;
          this.emit('bailout_invalidated', {
            proposal: stale,
            reason: 'Target lines changed before bailout was applied.',
          });
        }
      }
    }

    if (this.config.autoSolve && hotspot && this.shouldTriggerAutoSolve(hotspot, now)) {
      void this.solveInBackground(hotspot, fileContentOverride, now);
    }

    const snapshot = this.getSnapshot(now);
    this.emit('state_changed', snapshot);
    return snapshot;
  }

  /**
   * Checks if a silently prepared bailout has cleared the Anti-Annoyance Natural Pause Gate.
   */
  checkSurfaceable(now = Date.now()): BailoutProposal | undefined {
    if (!this.pendingBailout || this.pendingBailout.status !== 'ready') {
      return undefined;
    }

    const hotspot = this.tracker.getHotspot(this.pendingBailout.filePath, now);
    const gate = this.timingGate.evaluate(now, hotspot?.cooldownUntil ?? 0);
    if (!gate.canSurfaceNow) {
      return undefined;
    }

    const current = safeReadTextFile(
      this.pendingBailout.filePath,
      this.config.maxFileSizeBytes,
    );
    if (
      current !== undefined &&
      !isProposalStillValidForContent(
        this.pendingBailout,
        current,
        this.config.maxPatchLines,
      )
    ) {
      const stale = this.pendingBailout;
      stale.status = 'stale';
      this.pendingBailout = undefined;
      this.emit('bailout_invalidated', {
        proposal: stale,
        reason: 'File drifted before bailout surfaced.',
      });
      return undefined;
    }

    this.pendingBailout.status = 'surfaced';
    this.emit('bailout_surfaceable', this.pendingBailout);
    this.emit('state_changed', this.getSnapshot(now));
    return this.pendingBailout;
  }

  /**
   * Explicitly triggers a real heavy-model bailout solve.
   */
  async triggerBailout(options: ManualBailoutOptions = {}): Promise<BailoutProposal> {
    const now = Date.now();
    const targetPath = options.filePath ?? this.tracker.getActiveFilePath();
    if (!targetPath) {
      throw new Error('No active filePath specified or tracked in Shadow-State.');
    }

    const safePath = assertSafeWorkspacePath(targetPath, this.config.allowedWorkspaceRoots);

    const readiness = getRouterReadiness(this.config);
    if (!readiness.ready) {
      throw new Error(readiness.notice ?? 'No real bailout provider configured.');
    }

    if (options.errorMessage || options.attemptedFix || options.startLine !== undefined) {
      this.tracker.ingest({
        kind: options.errorMessage ? 'agent_tool_error' : 'file_focus',
        filePath: safePath,
        timestamp: now,
        source: 'mcp-client',
        message: options.errorMessage,
        attemptedFix: options.attemptedFix,
        lineRange:
          options.startLine !== undefined
            ? { startLine: options.startLine, endLine: options.endLine ?? options.startLine }
            : undefined,
      });
    }

    let hotspot = this.tracker.getHotspot(safePath, now);
    if (!hotspot) {
      const { hotspot: created } = this.tracker.ingest({
        kind: 'file_focus',
        filePath: safePath,
        timestamp: now,
        source: 'mcp-client',
      });
      hotspot = created!;
    }

    if (!options.force && !this.withinBudget(now)) {
      throw new Error('Bailout rate limit reached (maxBailoutsPerHour / maxBailoutsPerDay).');
    }

    const proposal = await this.solveNow(hotspot, options.fileContentOverride, now);
    if (!proposal) {
      throw new Error(
        this.lastError ??
          `Heavy model did not return a validated safe patch meeting minConfidence=${this.config.minConfidence}.`,
      );
    }
    return proposal;
  }

  getPendingBailout(includeGated = true, now = Date.now()): BailoutProposal | undefined {
    if (!this.pendingBailout) return undefined;

    // Auto-invalidate if the file on disk drifted externally (e.g. git checkout / external editor)
    const current = safeReadTextFile(this.pendingBailout.filePath, this.config.maxFileSizeBytes);
    if (
      current !== undefined &&
      !isProposalStillValidForContent(this.pendingBailout, current, this.config.maxPatchLines)
    ) {
      const stale = this.pendingBailout;
      stale.status = 'stale';
      this.pendingBailout = undefined;
      this.emit('bailout_invalidated', {
        proposal: stale,
        reason: 'Target file changed externally before bailout was consumed.',
      });
      this.emit('state_changed', this.getSnapshot(now));
      return undefined;
    }

    if (includeGated) return this.pendingBailout;
    const hotspot = this.tracker.getHotspot(this.pendingBailout.filePath, now);
    const gate = this.timingGate.evaluate(now, hotspot?.cooldownUntil ?? 0);
    return gate.canSurfaceNow || this.pendingBailout.status === 'surfaced'
      ? this.pendingBailout
      : undefined;
  }

  acceptBailout(
    id: string,
    applyToDisk = false,
    now = Date.now(),
  ): { proposal: BailoutProposal; appliedToDisk: boolean; applyError?: string } {
    if (!this.pendingBailout || this.pendingBailout.id !== id) {
      throw new Error(`No pending bailout with id "${id}".`);
    }

    const proposal = this.pendingBailout;
    let appliedToDisk = false;
    let applyError: string | undefined;

    if (applyToDisk) {
      const outcome = applyProposalToDisk(
        proposal,
        this.config.allowedWorkspaceRoots,
        this.config.maxPatchLines,
      );
      appliedToDisk = outcome.applied;
      applyError = outcome.reason;
      if (!outcome.applied) {
        // Prevent wedging the engine forever on an unapplicable stale proposal
        proposal.status = 'stale';
        this.pendingBailout = undefined;
        this.emit('bailout_invalidated', {
          proposal,
          reason: applyError ?? 'Patch could not be applied to disk.',
        });
        this.emit('state_changed', this.getSnapshot(now));
        return { proposal, appliedToDisk: false, applyError };
      }
    }

    proposal.status = 'accepted';
    this.pendingBailout = undefined;
    this.stats.bailoutsAccepted += 1;
    this.tracker.resetFileFriction(proposal.filePath);
    this.tracker.setCooldown(proposal.filePath, now, 1);

    this.emit('bailout_accepted', proposal);
    this.emit('state_changed', this.getSnapshot(now));

    return { proposal, appliedToDisk, applyError };
  }

  dismissBailout(id?: string, now = Date.now()): BailoutProposal | undefined {
    if (!this.pendingBailout) return undefined;
    if (id && this.pendingBailout.id !== id) return undefined;

    const proposal = this.pendingBailout;
    proposal.status = 'dismissed';
    this.pendingBailout = undefined;
    this.stats.bailoutsDismissed += 1;
    this.tracker.recordDismissal(proposal.filePath, now);

    this.emit('bailout_dismissed', proposal);
    this.emit('state_changed', this.getSnapshot(now));
    return proposal;
  }

  getSnapshot(now = Date.now()): ShadowStateSnapshot {
    this.pruneBudgetWindow(now);
    const hotspots = this.tracker.getHotspots(now);
    const primaryHotspot = hotspots[0];
    const score = primaryHotspot?.score ?? 0;
    const timingGate = this.timingGate.evaluate(now, primaryHotspot?.cooldownUntil ?? 0);
    const readiness = getRouterReadiness(this.config);
    const activeProvider = this.config.provider;
    const activeModel = this.config.providers[activeProvider]?.model ?? '';

    let phase: ShadowPhase = 'FLOW';
    if (
      this.pendingBailout &&
      (this.pendingBailout.status === 'ready' || this.pendingBailout.status === 'surfaced')
    ) {
      phase = 'BAILOUT_READY';
    } else if (this.solvingFiles.size > 0) {
      phase = 'BAILOUT_SOLVING';
    } else if (primaryHotspot && now < primaryHotspot.cooldownUntil) {
      phase = 'COOLDOWN';
    } else if (score >= this.config.stuckThreshold) {
      phase = 'STUCK';
    } else if (score >= this.config.frictionThreshold) {
      phase = 'FRICTION';
    }

    return {
      timestamp: now,
      phase,
      score,
      routerReady: readiness.ready,
      activeProvider,
      activeModel,
      routerNotice: readiness.notice,
      lastError: this.lastError,
      activeFile: this.tracker.getActiveFilePath(),
      primaryHotspot,
      hotspots: hotspots.slice(0, 6),
      timingGate,
      pendingBailout: this.pendingBailout,
      stats: { ...this.stats },
    };
  }

  dispose(): void {
    this.removeAllListeners();
    this.solvingFiles.clear();
  }

  private shouldTriggerAutoSolve(hotspot: FileHotspot, now: number): boolean {
    if (hotspot.score < this.config.stuckThreshold) return false;
    if (now < hotspot.cooldownUntil) return false;
    if (!getRouterReadiness(this.config).ready) return false;

    const key = normalizeFilePath(hotspot.filePath);
    if (this.solvingFiles.has(key)) return false;
    if (
      this.pendingBailout &&
      normalizeFilePath(this.pendingBailout.filePath) === key &&
      (this.pendingBailout.status === 'ready' || this.pendingBailout.status === 'surfaced')
    ) {
      return false;
    }
    return this.withinBudget(now);
  }

  private pruneBudgetWindow(now: number): void {
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const hourAgo = now - 60 * 60 * 1000;
    this.bailoutTimestamps = this.bailoutTimestamps.filter((ts) => ts >= dayAgo);
    this.stats.bailoutsToday = this.bailoutTimestamps.length;
    this.stats.bailoutsThisHour = this.bailoutTimestamps.filter((ts) => ts >= hourAgo).length;
  }

  private withinBudget(now: number): boolean {
    this.pruneBudgetWindow(now);
    return (
      this.stats.bailoutsThisHour < this.config.maxBailoutsPerHour &&
      this.stats.bailoutsToday < this.config.maxBailoutsPerDay
    );
  }

  private async solveInBackground(
    hotspot: FileHotspot,
    fileContentOverride?: string,
    now = Date.now(),
  ): Promise<void> {
    try {
      await this.solveNow(hotspot, fileContentOverride, now);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.lastError = error.message;
      this.stats.bailoutsFailed += 1;
      this.tracker.setCooldown(hotspot.filePath, Date.now(), 0.5);
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
      this.emit('state_changed', this.getSnapshot());
    }
  }

  private async solveNow(
    hotspot: FileHotspot,
    fileContentOverride?: string,
    now = Date.now(),
  ): Promise<BailoutProposal | null> {
    const key = normalizeFilePath(hotspot.filePath);
    if (this.solvingFiles.has(key)) return null;

    this.solvingFiles.add(key);
    this.lastError = undefined;

    this.emit('bailout_solving', {
      filePath: hotspot.filePath,
      score: hotspot.score,
      reasons: hotspot.reasons,
    });
    this.emit('state_changed', this.getSnapshot(now));

    try {
      const dossier = distillBailoutDossier(hotspot, this.config, {
        fileContentOverride,
      });
      this.lastDossier = dossier;

      // Charge rate-limit budget only once local dossier validation passes and outbound solve begins
      this.stats.bailoutsTriggered += 1;
      this.bailoutTimestamps.push(now);
      this.pruneBudgetWindow(now);

      const result = await this.router.solve(dossier);

      if (result.response.confidence < this.config.minConfidence) {
        this.lastError = `Model confidence ${result.response.confidence.toFixed(2)} below minConfidence ${this.config.minConfidence}.`;
        this.tracker.setCooldown(hotspot.filePath, Date.now(), 0.5);
        return null;
      }

      const latestContent =
        fileContentOverride ??
        safeReadTextFile(dossier.filePath, this.config.maxFileSizeBytes) ??
        '';

      const validated = validateAndBuildPatch(
        dossier.filePath,
        latestContent,
        result.response.patch,
        { maxPatchLines: this.config.maxPatchLines },
      );

      if (!validated) {
        this.stats.bailoutsRejectedUnsafe += 1;
        this.lastError =
          'Model patch rejected: failed exact-snippet matching or surgical safety validation.';
        this.tracker.setCooldown(hotspot.filePath, Date.now(), 0.5);
        return null;
      }

      const fileName = path.basename(dossier.filePath);
      const lineLabel = `${validated.patch.linesChanged}-line`;
      const confPct = Math.round(result.response.confidence * 100);
      const offerMessage =
        `Stuck on ${fileName}? Escalated to ${result.model} and validated a ${lineLabel} fix ` +
        `(${confPct}% confidence): "${result.response.summary}". Review diff?`;

      const proposal: BailoutProposal = {
        id: crypto.randomUUID().slice(0, 12),
        createdAt: Date.now(),
        filePath: dossier.filePath,
        fileContentHash: dossier.fileContentHash,
        provider: result.provider,
        model: result.model,
        frustrationScore: hotspot.score,
        triggerReasons: [...hotspot.reasons],
        rootCause: result.response.rootCause,
        summary: result.response.summary,
        explanation: result.response.explanation,
        whyPreviousAttemptsFailed: result.response.whyPreviousAttemptsFailed,
        confidence: result.response.confidence,
        patch: validated.patch,
        status: 'ready',
        offerMessage,
        latencyMs: result.latencyMs,
      };

      this.pendingBailout = proposal;
      this.stats.bailoutsReady += 1;
      this.emit('bailout_ready', proposal);

      this.checkSurfaceable(Date.now());
      this.emit('state_changed', this.getSnapshot(Date.now()));

      return proposal;
    } finally {
      this.solvingFiles.delete(key);
      this.emit('state_changed', this.getSnapshot(Date.now()));
    }
  }
}
