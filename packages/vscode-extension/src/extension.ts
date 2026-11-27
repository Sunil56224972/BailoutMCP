import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BAILOUT_DIFF_SCHEME, BailoutDiffContentProvider } from './diff-provider';
import { IdeTelemetryCollector, type LocalSignalPayload } from './telemetry';

interface BridgeManifest {
  port: number;
  token: string;
  pid: number;
}

interface BailoutProposalDto {
  id: string;
  filePath: string;
  provider: string;
  model: string;
  frustrationScore: number;
  rootCause: string;
  summary: string;
  explanation: string;
  whyPreviousAttemptsFailed: string;
  confidence: number;
  offerMessage: string;
  patch: {
    filePath: string;
    startLine: number;
    endLine: number;
    originalCode: string;
    fixedCode: string;
    unifiedDiff: string;
    linesChanged: number;
  };
}

interface ShadowStateDto {
  phase: 'FLOW' | 'FRICTION' | 'STUCK' | 'BAILOUT_SOLVING' | 'BAILOUT_READY' | 'COOLDOWN';
  score: number;
  routerReady: boolean;
  activeProvider: string;
  activeModel: string;
  routerNotice?: string;
  lastError?: string;
  activeFile?: string;
  pendingBailout?: BailoutProposalDto;
  primaryHotspot?: {
    filePath: string;
    score: number;
    reasons: string[];
  };
}

function readBridgeManifest(): BridgeManifest | undefined {
  const dir =
    process.env.BAILOUT_HOME && process.env.BAILOUT_HOME.trim()
      ? path.resolve(process.env.BAILOUT_HOME.trim())
      : path.join(os.homedir(), '.bailout-mcp');
  const manifestPath = path.join(dir, 'bridge.json');
  try {
    if (!fs.existsSync(manifestPath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<BridgeManifest>;
    if (typeof parsed.port === 'number' && typeof parsed.token === 'string') {
      return { port: parsed.port, token: parsed.token, pid: parsed.pid ?? 0 };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function lineNumberAtOffset(text: string, charOffset: number): number {
  if (charOffset <= 0) return 1;
  let line = 1;
  const end = Math.min(charOffset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Finds the exact occurrence of `needle` inside `haystack` closest in LINE NUMBER
 * to `preferredStartLine` (1-indexed), immune to CRLF vs LF line endings and rejecting
 * ambiguous distant duplicate matches so wrong functions are never patched.
 */
function findClosestSnippetOffset(
  haystack: string,
  needle: string,
  preferredStartLine: number,
): number {
  let searchFrom = 0;
  let bestIdx = -1;
  let bestLineDist = Number.POSITIVE_INFINITY;
  let totalMatches = 0;

  while (searchFrom <= haystack.length) {
    const idx = haystack.indexOf(needle, searchFrom);
    if (idx === -1) break;
    totalMatches += 1;
    const candidateLine = lineNumberAtOffset(haystack, idx);
    const lineDist = Math.abs(candidateLine - preferredStartLine);
    if (lineDist < bestLineDist) {
      bestLineDist = lineDist;
      bestIdx = idx;
    }
    searchFrom = idx + 1;
  }

  if (totalMatches > 1 && bestLineDist > 15) {
    return -1;
  }

  return bestIdx;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('BailoutMCP');
  const diffProvider = new BailoutDiffContentProvider();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
  statusBar.command = 'bailout.showStatus';
  statusBar.text = '$(pulse) Bailout: Waiting';
  statusBar.tooltip = 'BailoutMCP Shadow-State Detector (waiting for local bridge)';
  statusBar.show();

  let currentState: ShadowStateDto | undefined;
  let currentProposal: BailoutProposalDto | undefined;
  let lastToastedProposalId: string | undefined;
  let sseReq: http.ClientRequest | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let isConnected = false;

  const signalQueue: LocalSignalPayload[] = [];
  let flushingQueue = false;

  const getManifest = () => readBridgeManifest();

  async function bridgeRequest<T>(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<T | undefined> {
    const manifest = getManifest();
    if (!manifest) return undefined;

    try {
      const res = await fetch(`http://127.0.0.1:${manifest.port}${pathname}`, {
        method,
        signal: AbortSignal.timeout(4000),
        headers: {
          'content-type': 'application/json',
          'x-bailout-token': manifest.token,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) return undefined;
      return (await res.json()) as T;
    } catch {
      return undefined;
    }
  }

  async function flushSignalQueue(): Promise<void> {
    if (flushingQueue) return;
    flushingQueue = true;
    try {
      while (signalQueue.length > 0) {
        const next = signalQueue.shift()!;
        await bridgeRequest('POST', '/v1/signals', { signal: next });
      }
    } finally {
      flushingQueue = false;
    }
  }

  function enqueueSignal(signal: LocalSignalPayload): void {
    if (
      signal.kind === 'keystroke_activity' &&
      signalQueue.length > 0 &&
      signalQueue[signalQueue.length - 1].kind === 'keystroke_activity'
    ) {
      signalQueue[signalQueue.length - 1] = signal;
    } else {
      if (signalQueue.length >= 64) {
        signalQueue.shift();
      }
      signalQueue.push(signal);
    }
    void flushSignalQueue();
  }

  function renderStatusBar(): void {
    if (!collector.isEnabled()) {
      statusBar.text = '$(debug-pause) Bailout: Paused';
      statusBar.backgroundColor = undefined;
      statusBar.command = 'bailout.showStatus';
      return;
    }
    if (!isConnected || !currentState) {
      statusBar.text = '$(pulse) Bailout: Waiting';
      statusBar.tooltip = 'Start `bailout-mcp` or `bailout-mcp daemon` to connect Shadow-State';
      statusBar.backgroundColor = undefined;
      statusBar.command = 'bailout.showStatus';
      return;
    }

    const { phase, score, routerReady, routerNotice } = currentState;

    if (phase === 'BAILOUT_READY' && currentProposal) {
      const pct = Math.round(currentProposal.confidence * 100);
      statusBar.text = `$(lifebuoy) Bailout Ready (${pct}%)`;
      statusBar.tooltip = currentProposal.offerMessage;
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBar.command = 'bailout.viewDiff';
      return;
    }

    if (!routerReady) {
      statusBar.text = `$(warning) Bailout: Setup (${score})`;
      statusBar.tooltip = routerNotice ?? 'Configure a real heavy-model provider API key or Ollama';
      statusBar.backgroundColor = undefined;
      statusBar.command = 'bailout.showStatus';
      return;
    }

    switch (phase) {
      case 'BAILOUT_SOLVING':
        statusBar.text = `$(sync~spin) Bailout Solving (${score})`;
        statusBar.tooltip = `Silently escalating context to ${currentState.activeModel}...`;
        statusBar.backgroundColor = undefined;
        statusBar.command = 'bailout.showStatus';
        break;
      case 'STUCK':
      case 'FRICTION':
        statusBar.text = `$(flame) Shadow: ${score}/100`;
        statusBar.tooltip =
          currentState.primaryHotspot?.reasons.join('\n') || 'Elevated coding friction detected';
        statusBar.backgroundColor = undefined;
        statusBar.command = 'bailout.showStatus';
        break;
      case 'COOLDOWN':
        statusBar.text = '$(shield) Bailout: Cooldown';
        statusBar.tooltip = 'Staying quiet during cooldown window';
        statusBar.backgroundColor = undefined;
        statusBar.command = 'bailout.showStatus';
        break;
      default:
        statusBar.text = `$(pulse) Flow (${score})`;
        statusBar.tooltip = `BailoutMCP Shadow-State (${currentState.activeProvider}:${currentState.activeModel})`;
        statusBar.backgroundColor = undefined;
        statusBar.command = 'bailout.showStatus';
    }
  }

  async function viewProposalDiff(proposal: BailoutProposalDto): Promise<void> {
    if (!fs.existsSync(proposal.filePath)) {
      void vscode.window.showWarningMessage(`BailoutMCP: File not found: ${proposal.filePath}`);
      return;
    }
    const originalUri = vscode.Uri.file(proposal.filePath);
    const doc = await vscode.workspace.openTextDocument(originalUri);
    const currentText = doc.getText();
    const hasCrlf = currentText.includes('\r\n');
    const normalized = currentText.replace(/\r\n/g, '\n');
    const normOrig = proposal.patch.originalCode.replace(/\r\n/g, '\n');
    const normFixed = proposal.patch.fixedCode.replace(/\r\n/g, '\n');

    const matchIdx = findClosestSnippetOffset(normalized, normOrig, proposal.patch.startLine);
    if (matchIdx === -1) {
      void vscode.window.showInformationMessage(
        'BailoutMCP: Target code already changed; dismissing stale bailout.',
      );
      await bridgeRequest('POST', '/v1/bailout/dismiss', { id: proposal.id });
      return;
    }

    const previewNormalized =
      normalized.slice(0, matchIdx) + normFixed + normalized.slice(matchIdx + normOrig.length);
    const virtualUri = vscode.Uri.parse(
      `${BAILOUT_DIFF_SCHEME}:/${path.basename(proposal.filePath)}?id=${proposal.id}`,
    );
    diffProvider.setContent(
      virtualUri,
      hasCrlf ? previewNormalized.replace(/\n/g, '\r\n') : previewNormalized,
    );

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      virtualUri,
      `BailoutMCP Fix (${proposal.model}): ${proposal.summary}`,
    );

    const action = await vscode.window.showInformationMessage(
      `${proposal.summary} — Root cause: ${proposal.rootCause}`,
      'Apply Fix',
      'Dismiss',
    );
    if (action === 'Apply Fix') {
      await applyProposal(proposal);
    } else if (action === 'Dismiss') {
      await dismissProposal(proposal);
    }
  }

  async function applyProposal(proposal: BailoutProposalDto): Promise<void> {
    const uri = vscode.Uri.file(proposal.filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const fullText = doc.getText();
    const eol = fullText.includes('\r\n') ? '\r\n' : '\n';
    const normOrig = proposal.patch.originalCode.replace(/\r\n/g, '\n');
    const normFixed = proposal.patch.fixedCode.replace(/\r\n/g, '\n');
    const rawOrig = normOrig.replace(/\n/g, eol);
    const rawFixed = normFixed.replace(/\n/g, eol);

    const rawIdx = findClosestSnippetOffset(fullText, rawOrig, proposal.patch.startLine);
    if (rawIdx === -1) {
      void vscode.window.showWarningMessage(
        'BailoutMCP: Could not apply fix cleanly because the target lines changed.',
      );
      return;
    }

    const startPos = doc.positionAt(rawIdx);
    const endPos = doc.positionAt(rawIdx + rawOrig.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(startPos, endPos), rawFixed);

    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      await doc.save();
      await bridgeRequest('POST', '/v1/bailout/accept', {
        id: proposal.id,
        applyToDisk: false,
      });
      currentProposal = undefined;
      void vscode.window.showInformationMessage(
        `BailoutMCP: Applied ${proposal.patch.linesChanged}-line fix from ${proposal.model} (Ctrl+Z to undo anytime).`,
      );
    }
  }

  async function dismissProposal(proposal: BailoutProposalDto): Promise<void> {
    await bridgeRequest('POST', '/v1/bailout/dismiss', { id: proposal.id });
    currentProposal = undefined;
    renderStatusBar();
  }

  async function surfaceBailoutToast(proposal: BailoutProposalDto): Promise<void> {
    const autoToast = vscode.workspace
      .getConfiguration('bailout')
      .get<boolean>('autoToastOnPause', true);
    if (!autoToast) return;
    if (lastToastedProposalId === proposal.id) return;
    lastToastedProposalId = proposal.id;

    const choice = await vscode.window.showInformationMessage(
      proposal.offerMessage,
      'View Diff',
      'Apply Fix',
      'Dismiss',
    );
    if (choice === 'View Diff') {
      await viewProposalDiff(proposal);
    } else if (choice === 'Apply Fix') {
      await applyProposal(proposal);
    } else if (choice === 'Dismiss') {
      await dismissProposal(proposal);
    }
  }

  function handleSseEvent(eventName: string, rawData: string): void {
    try {
      const payload = JSON.parse(rawData) as unknown;
      if (eventName === 'state_changed') {
        currentState = payload as ShadowStateDto;
        currentProposal = currentState.pendingBailout;
        renderStatusBar();
      } else if (eventName === 'bailout_ready') {
        currentProposal = payload as BailoutProposalDto;
        output.appendLine(`[Ready] ${currentProposal.summary} (${currentProposal.model})`);
        renderStatusBar();
      } else if (eventName === 'bailout_surfaceable') {
        currentProposal = payload as BailoutProposalDto;
        renderStatusBar();
        void surfaceBailoutToast(currentProposal);
      } else if (eventName === 'bailout_invalidated') {
        currentProposal = undefined;
        renderStatusBar();
      } else if (eventName === 'micro_win') {
        const win = payload as { message?: string };
        if (win.message) {
          output.appendLine(`[Micro-Win] ${win.message}`);
        }
      }
    } catch {
      // Ignore malformed SSE frame
    }
  }

  function connectSse(): void {
    if (sseReq) {
      sseReq.destroy();
      sseReq = undefined;
    }

    const manifest = getManifest();
    if (!manifest) {
      isConnected = false;
      renderStatusBar();
      scheduleReconnect();
      return;
    }

    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: manifest.port,
        path: '/v1/events',
        headers: {
          'x-bailout-token': manifest.token,
          accept: 'text/event-stream',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          isConnected = false;
          renderStatusBar();
          res.resume();
          scheduleReconnect();
          return;
        }

        isConnected = true;
        output.appendLine(`Connected to BailoutMCP bridge on 127.0.0.1:${manifest.port}`);
        renderStatusBar();

        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            let eventName = 'message';
            const dataLines: string[] = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith(':')) continue;
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            }
            if (dataLines.length > 0) {
              handleSseEvent(eventName, dataLines.join('\n'));
            }
          }
        });

        res.on('end', () => {
          isConnected = false;
          renderStatusBar();
          scheduleReconnect();
        });
      },
    );

    req.on('error', () => {
      isConnected = false;
      renderStatusBar();
      scheduleReconnect();
    });

    sseReq = req;
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connectSse();
    }, 4000);
  }

  const collector = new IdeTelemetryCollector(enqueueSignal);
  const initialEnabled = vscode.workspace
    .getConfiguration('bailout')
    .get<boolean>('enabled', true);
  collector.setEnabled(initialEnabled);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BAILOUT_DIFF_SCHEME, diffProvider),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('bailout.enabled')) {
        const nextEnabled = vscode.workspace
          .getConfiguration('bailout')
          .get<boolean>('enabled', true);
        collector.setEnabled(nextEnabled);
        renderStatusBar();
      }
    }),
    statusBar,
    output,
    collector,
    vscode.commands.registerCommand('bailout.showStatus', async () => {
      const state = await bridgeRequest<ShadowStateDto>('GET', '/v1/state');
      if (!state) {
        void vscode.window.showWarningMessage(
          'BailoutMCP local bridge is not running. Start `bailout-mcp` or `bailout-mcp daemon`.',
        );
        return;
      }
      if (!state.routerReady && state.routerNotice) {
        void vscode.window.showWarningMessage(`BailoutMCP Setup Needed: ${state.routerNotice}`);
        return;
      }
      const reasons = state.primaryHotspot?.reasons.join(' • ') || 'Smooth flow';
      const buttons = state.pendingBailout
        ? ['View Diff', 'Dismiss']
        : ['Trigger Bailout Now', collector.isEnabled() ? 'Pause Telemetry' : 'Resume Telemetry'];
      const pick = await vscode.window.showInformationMessage(
        `BailoutMCP (${state.activeProvider}:${state.activeModel}) — Phase: ${state.phase} | Score: ${state.score}/100 | ${reasons}`,
        ...buttons,
      );
      if (pick === 'View Diff' && state.pendingBailout) {
        await viewProposalDiff(state.pendingBailout);
      } else if (pick === 'Dismiss' && state.pendingBailout) {
        await dismissProposal(state.pendingBailout);
      } else if (pick === 'Trigger Bailout Now') {
        await vscode.commands.executeCommand('bailout.triggerNow');
      } else if (pick === 'Pause Telemetry' || pick === 'Resume Telemetry') {
        await vscode.commands.executeCommand('bailout.toggleEnabled');
      }
    }),
    vscode.commands.registerCommand('bailout.viewDiff', async () => {
      if (!currentProposal) {
        const res = await bridgeRequest<{ proposal: BailoutProposalDto | null }>(
          'GET',
          '/v1/bailout/pending',
        );
        currentProposal = res?.proposal ?? undefined;
      }
      if (!currentProposal) {
        void vscode.window.showInformationMessage('BailoutMCP: No pending bailout fix right now.');
        return;
      }
      await viewProposalDiff(currentProposal);
    }),
    vscode.commands.registerCommand('bailout.applyFix', async () => {
      if (!currentProposal) {
        void vscode.window.showInformationMessage('BailoutMCP: No pending bailout fix to apply.');
        return;
      }
      await applyProposal(currentProposal);
    }),
    vscode.commands.registerCommand('bailout.dismissFix', async () => {
      if (!currentProposal) return;
      await dismissProposal(currentProposal);
    }),
    vscode.commands.registerCommand('bailout.triggerNow', async () => {
      const activeDoc = vscode.window.activeTextEditor?.document;
      const filePath = activeDoc?.uri.fsPath;
      const workspaceRoot = activeDoc
        ? vscode.workspace.getWorkspaceFolder(activeDoc.uri)?.uri.fsPath
        : undefined;
      if (filePath && workspaceRoot) {
        await bridgeRequest('POST', '/v1/signals', {
          signal: {
            kind: 'file_focus',
            source: 'vscode-extension',
            filePath,
            workspaceRoot,
            timestamp: Date.now(),
          },
        });
      }
      const res = await bridgeRequest<{ proposal?: BailoutProposalDto; error?: string }>(
        'POST',
        '/v1/bailout/trigger',
        { filePath, force: true },
      );
      if (res?.proposal) {
        currentProposal = res.proposal;
        await viewProposalDiff(res.proposal);
      } else {
        void vscode.window.showWarningMessage(
          `BailoutMCP: ${res?.error ?? 'Could not generate a validated bailout patch for the active file.'}`,
        );
      }
    }),
    vscode.commands.registerCommand('bailout.toggleEnabled', () => {
      collector.setEnabled(!collector.isEnabled());
      renderStatusBar();
    }),
    {
      dispose: () => {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (sseReq) sseReq.destroy();
      },
    },
  );

  connectSse();
}

export function deactivate(): void {
  // Handled cleanly via context.subscriptions
}
