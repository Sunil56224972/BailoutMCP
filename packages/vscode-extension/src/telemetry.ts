import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface LocalSignalPayload {
  kind:
    | 'undo_burst'
    | 'edit_churn'
    | 'file_dwell'
    | 'diagnostic_error'
    | 'terminal_error'
    | 'keystroke_activity'
    | 'file_focus'
    | 'error_resolved';
  source: 'vscode-extension';
  timestamp: number;
  filePath?: string;
  workspaceRoot?: string;
  lineRange?: { startLine: number; endLine: number };
  message?: string;
  code?: string;
  exitCode?: number;
  count?: number;
  durationMs?: number;
  regionHash?: string;
}

export type SignalEmitter = (signal: LocalSignalPayload) => void;

const SENSITIVE_FILE_RE =
  /(^|[\\/])(\.env(\..+)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials(\.json)?|secrets?\.(json|ya?ml)|id_(rsa|dsa|ecdsa|ed25519)|master\.key)$|\.(pem|key|p12|pfx|kdbx|sqlite|sqlite3|db|ovpn|asc|gpg)$/i;
const SENSITIVE_DIR_RE =
  /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.bailout-mcp|\.docker|\.gcloud|\.azure)([\\/]|$)/i;

function isSensitiveUri(filePath: string): boolean {
  return SENSITIVE_FILE_RE.test(filePath) || SENSITIVE_DIR_RE.test(filePath);
}

function getWorkspaceRootForUri(uri: vscode.Uri): string | undefined {
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
}

function sha256Short(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

interface TrackedDiag {
  lastEmittedAt: number;
  message: string;
  code?: string;
  line: number;
}

/**
 * Privacy-first IDE signal collector for professional workflows:
 * - NEVER logs raw keystrokes or reads sensitive files (.env, keys, .ssh, .aws).
 * - Uses native VS Code Undo/Redo change reasons.
 * - Debounces LSP diagnostics (2.5s) and only increments recurring error count on file
 *   save or sustained persistence (>= 15s) so normal mid-line typing NEVER causes false positives.
 */
export class IdeTelemetryCollector implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly recentEditCountByFile = new Map<
    string,
    { count: number; windowStart: number; lastRegion: string }
  >();
  private readonly activeErrorsByFile = new Map<string, Map<string, TrackedDiag>>();
  private readonly diagDebounceTimers = new Map<string, NodeJS.Timeout>();
  private lastKeystrokeSentAt = 0;
  private lastUndoAt = 0;
  private lastTerminalFailed = false;
  private dwellTimer?: NodeJS.Timeout;
  private enabled = true;

  constructor(private readonly emitSignal: SignalEmitter) {
    this.registerListeners();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private registerListeners(): void {
    // 1. Native Undo / Redo-oscillation + Edit Churn + Pause-Gate Activity Heartbeat
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!this.enabled) return;
        const doc = event.document;
        if (doc.uri.scheme !== 'file' || event.contentChanges.length === 0) return;

        const filePath = doc.uri.fsPath;
        if (isSensitiveUri(filePath)) return;

        const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (activePath && path.resolve(activePath) !== path.resolve(filePath)) return;

        const now = Date.now();
        const workspaceRoot = getWorkspaceRootForUri(doc.uri);
        const firstChange = event.contentChanges[0];
        const startLine = firstChange.range.start.line + 1;
        const endLine = Math.max(startLine, firstChange.range.end.line + 1);

        if (event.reason === vscode.TextDocumentChangeReason.Undo) {
          this.lastUndoAt = now;
          this.emitSignal({
            kind: 'undo_burst',
            source: 'vscode-extension',
            timestamp: now,
            filePath,
            workspaceRoot,
            lineRange: { startLine, endLine },
            count: 1,
          });
          return;
        }

        if (
          event.reason === vscode.TextDocumentChangeReason.Redo &&
          now - this.lastUndoAt <= 10_000
        ) {
          this.emitSignal({
            kind: 'edit_churn',
            source: 'vscode-extension',
            timestamp: now,
            filePath,
            workspaceRoot,
            lineRange: { startLine, endLine },
            count: 1,
          });
          return;
        }

        if (now - this.lastKeystrokeSentAt >= 750) {
          this.lastKeystrokeSentAt = now;
          this.emitSignal({
            kind: 'keystroke_activity',
            source: 'vscode-extension',
            timestamp: now,
            filePath,
            workspaceRoot,
            lineRange: { startLine, endLine },
          });
        }

        const regionBucket = `${Math.floor(startLine / 10)}`;
        const prev = this.recentEditCountByFile.get(filePath);
        const withinWindow =
          prev && now - prev.windowStart <= 20_000 && prev.lastRegion === regionBucket;
        const nextCount = withinWindow ? prev.count + 1 : 1;

        this.recentEditCountByFile.set(filePath, {
          count: nextCount,
          windowStart: withinWindow ? prev.windowStart : now,
          lastRegion: regionBucket,
        });

        const isLargeDeletion = firstChange.rangeLength >= 25 && firstChange.text.length === 0;
        if (isLargeDeletion || (nextCount >= 12 && nextCount % 6 === 0)) {
          const sliceStart = Math.max(0, startLine - 6);
          const sliceEnd = Math.min(doc.lineCount - 1, endLine + 6);
          const regionText = doc.getText(
            new vscode.Range(sliceStart, 0, sliceEnd, doc.lineAt(sliceEnd).text.length),
          );

          this.emitSignal({
            kind: 'edit_churn',
            source: 'vscode-extension',
            timestamp: now,
            filePath,
            workspaceRoot,
            lineRange: { startLine, endLine },
            count: isLargeDeletion ? 2 : 1,
            regionHash: sha256Short(regionText),
          });
        }
      }),
    );

    // 2. Active Editor Focus
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!this.enabled || !editor || editor.document.uri.scheme !== 'file') return;
        const filePath = editor.document.uri.fsPath;
        if (isSensitiveUri(filePath)) return;
        this.emitSignal({
          kind: 'file_focus',
          source: 'vscode-extension',
          timestamp: Date.now(),
          filePath,
          workspaceRoot: getWorkspaceRootForUri(editor.document.uri),
          lineRange: {
            startLine: editor.selection.active.line + 1,
            endLine: editor.selection.active.line + 1,
          },
        });
      }),
    );

    // 3. Explicit File Save -> emit currently persisting LSP errors immediately
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!this.enabled || doc.uri.scheme !== 'file') return;
        const filePath = doc.uri.fsPath;
        if (isSensitiveUri(filePath)) return;
        this.flushDiagnosticsForUri(doc.uri, true);
      }),
    );

    // 4. Debounced LSP / TypeScript / Linter Diagnostics + Micro-Win Resolution
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics((event) => {
        if (!this.enabled) return;
        for (const uri of event.uris) {
          if (uri.scheme !== 'file') continue;
          const filePath = uri.fsPath;
          if (isSensitiveUri(filePath)) continue;

          const existingTimer = this.diagDebounceTimers.get(filePath);
          if (existingTimer) clearTimeout(existingTimer);

          const timer = setTimeout(() => {
            this.diagDebounceTimers.delete(filePath);
            this.flushDiagnosticsForUri(uri, false);
          }, 2500);
          this.diagDebounceTimers.set(filePath, timer);
        }
      }),
    );

    // 5. Terminal Shell Execution Errors (VS Code 1.93+ Shell Integration API)
    const winAny = vscode.window as unknown as {
      onDidEndTerminalShellExecution?: (
        listener: (e: {
          execution: { commandLine?: { value?: string } };
          exitCode?: number;
        }) => void,
      ) => vscode.Disposable;
    };

    if (typeof winAny.onDidEndTerminalShellExecution === 'function') {
      this.disposables.push(
        winAny.onDidEndTerminalShellExecution((event) => {
          if (!this.enabled) return;
          const activeDoc = vscode.window.activeTextEditor?.document;
          const filePath =
            activeDoc && activeDoc.uri.scheme === 'file' && !isSensitiveUri(activeDoc.uri.fsPath)
              ? activeDoc.uri.fsPath
              : undefined;
          const workspaceRoot =
            activeDoc && activeDoc.uri.scheme === 'file'
              ? getWorkspaceRootForUri(activeDoc.uri)
              : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const cmd = event.execution.commandLine?.value ?? 'terminal command';
          const exitCode = event.exitCode;

          if (exitCode !== undefined && exitCode !== 0) {
            this.lastTerminalFailed = true;
            this.emitSignal({
              kind: 'terminal_error',
              source: 'vscode-extension',
              timestamp: Date.now(),
              filePath,
              workspaceRoot,
              exitCode,
              message: `Command "${cmd.slice(0, 120)}" exited with code ${exitCode}`,
            });
          } else if (exitCode === 0 && this.lastTerminalFailed && filePath) {
            this.lastTerminalFailed = false;
            this.emitSignal({
              kind: 'error_resolved',
              source: 'vscode-extension',
              timestamp: Date.now(),
              filePath,
              workspaceRoot,
              message: `Command "${cmd.slice(0, 80)}" succeeded`,
            });
          }
        }),
      );
    }

    // 6. Periodic File Dwell Tracker (every 30s on active focused window)
    this.dwellTimer = setInterval(() => {
      if (!this.enabled || !vscode.window.state.focused) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') return;
      const filePath = editor.document.uri.fsPath;
      if (isSensitiveUri(filePath)) return;

      this.emitSignal({
        kind: 'file_dwell',
        source: 'vscode-extension',
        timestamp: Date.now(),
        filePath,
        workspaceRoot: getWorkspaceRootForUri(editor.document.uri),
        durationMs: 30_000,
        lineRange: {
          startLine: editor.selection.active.line + 1,
          endLine: editor.selection.active.line + 1,
        },
      });
    }, 30_000);
  }

  private flushDiagnosticsForUri(uri: vscode.Uri, fromSave: boolean): void {
    const filePath = uri.fsPath;
    const workspaceRoot = getWorkspaceRootForUri(uri);
    const now = Date.now();
    const diagnostics = vscode.languages
      .getDiagnostics(uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);

    const prevMap = this.activeErrorsByFile.get(filePath) ?? new Map<string, TrackedDiag>();
    const nextMap = new Map<string, TrackedDiag>();

    for (const diag of diagnostics.slice(0, 5)) {
      const code =
        typeof diag.code === 'object' && diag.code !== null
          ? String(diag.code.value)
          : diag.code !== undefined
            ? String(diag.code)
            : undefined;
      const key = `${code ?? ''}:${diag.message}`;
      const prev = prevMap.get(key);
      const line = diag.range.start.line + 1;

      const shouldEmit = fromSave || !prev || now - prev.lastEmittedAt >= 15_000;

      if (shouldEmit) {
        this.emitSignal({
          kind: 'diagnostic_error',
          source: 'vscode-extension',
          timestamp: now,
          filePath,
          workspaceRoot,
          lineRange: { startLine: line, endLine: diag.range.end.line + 1 },
          message: diag.message,
          code,
        });
        nextMap.set(key, { lastEmittedAt: now, message: diag.message, code, line });
      } else {
        nextMap.set(key, prev);
      }
    }

    if (prevMap.size > 0 && nextMap.size === 0) {
      this.emitSignal({
        kind: 'error_resolved',
        source: 'vscode-extension',
        timestamp: now,
        filePath,
        workspaceRoot,
      });
    }

    if (nextMap.size === 0) {
      this.activeErrorsByFile.delete(filePath);
    } else {
      this.activeErrorsByFile.set(filePath, nextMap);
    }
  }

  dispose(): void {
    if (this.dwellTimer) {
      clearInterval(this.dwellTimer);
      this.dwellTimer = undefined;
    }
    for (const timer of this.diagDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.diagDebounceTimers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
