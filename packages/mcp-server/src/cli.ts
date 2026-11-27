#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BailoutEngine,
  getRouterReadiness,
  hashContent,
  isProviderConfigured,
  isSensitiveFilePath,
  loadConfig,
  redactSecrets,
  sanitizeConfigForDisplay,
  validateAndBuildPatch,
  validateEndpointUrl,
  type BailoutProposal,
  type BailoutProviderKind,
  type MicroWinEvent,
} from '@bailout-mcp/core';
import { BridgeClient } from './bridge-client.js';
import { LocalBridgeServer } from './bridge-server.js';
import { WorkspaceChurnWatcher } from './file-watcher.js';
import { createBailoutMcpServer, startStdioMcpServer } from './mcp.js';

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

async function runDaemon(args: string[]): Promise<void> {
  const portRaw = parseArg(args, '--port');
  const watchDir = parseArg(args, '--watch');
  const port = portRaw ? Number(portRaw) : undefined;
  const resolvedRoot = watchDir ? path.resolve(watchDir) : process.cwd();

  const engine = new BailoutEngine({
    ...(port ? { bridgePort: port } : {}),
    workspaceRoot: resolvedRoot,
  });

  const bridge = new LocalBridgeServer(engine, { port });
  await bridge.start();

  let watcher: WorkspaceChurnWatcher | undefined;
  if (watchDir) {
    watcher = new WorkspaceChurnWatcher(resolvedRoot, engine);
    watcher.start();
  }

  const cfg = engine.getConfig();
  const readiness = getRouterReadiness(cfg);
  console.error(
    `[BailoutMCP] Local bridge listening on ${bridge.getBaseUrl()} (provider=${cfg.provider}, model=${cfg.providers[cfg.provider].model || 'unset'}, ready=${readiness.ready})`,
  );
  if (!readiness.ready && readiness.notice) {
    console.error(`[BailoutMCP] Notice: ${readiness.notice}`);
  }
  if (watchDir) {
    console.error(`[BailoutMCP] Watching workspace churn in ${resolvedRoot}`);
  }

  engine.on('bailout_solving', (info: { filePath: string; score: number }) => {
    console.error(
      `[BailoutMCP] Frustration ${info.score}/100 on ${path.basename(info.filePath)} — silently escalating to ${cfg.provider}...`,
    );
  });
  engine.on('bailout_ready', (proposal: BailoutProposal) => {
    console.error(
      `[BailoutMCP] Validated fix ready (${Math.round(proposal.confidence * 100)}% conf, ${proposal.latencyMs}ms) — waiting for natural pause gate...`,
    );
  });
  engine.on('bailout_surfaceable', (proposal: BailoutProposal) => {
    console.error(`[BailoutMCP] BAILOUT TRIGGER: ${proposal.offerMessage}`);
  });
  engine.on('micro_win', (evt: MicroWinEvent) => {
    console.error(`[BailoutMCP] MICRO-WIN: ${evt.message}`);
  });
  engine.on('error', (err: Error) => {
    console.error(`[BailoutMCP] Error: ${err.message}`);
  });

  const shutdown = async () => {
    watcher?.stop();
    engine.dispose();
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function runStatus(): Promise<void> {
  const client = await BridgeClient.discover();
  if (!client) {
    console.log('BailoutMCP bridge is not running. Start it with: bailout-mcp daemon --watch .');
    process.exitCode = 1;
    return;
  }
  const state = await client.getState();
  console.log(JSON.stringify(state, null, 2));
}

async function runDoctor(): Promise<void> {
  const cfg = loadConfig();
  const readiness = getRouterReadiness(cfg);
  const bridge = await BridgeClient.discover();

  const providers: BailoutProviderKind[] = [
    'anthropic',
    'gemini',
    'openai',
    'openrouter',
    'ollama',
    'custom',
  ];

  const providerChecks = providers.map((name) => {
    const creds = cfg.providers[name];
    let endpointValid = true;
    let endpointError: string | undefined;
    if (creds.baseUrl) {
      try {
        validateEndpointUrl(creds.baseUrl);
      } catch (err) {
        endpointValid = false;
        endpointError = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      provider: name,
      active: cfg.provider === name,
      configured: isProviderConfigured(name, cfg),
      model: creds.model || null,
      endpointValid,
      ...(endpointError ? { endpointError } : {}),
    };
  });

  const report = {
    nodeVersion: process.version,
    bridgeRunning: Boolean(bridge),
    routerReady: readiness.ready,
    ...(readiness.notice ? { routerNotice: readiness.notice } : {}),
    security: {
      redactSecrets: cfg.redactSecrets,
      maxPatchLines: cfg.maxPatchLines,
      maxFileSizeBytes: cfg.maxFileSizeBytes,
      allowedWorkspaceRoots: cfg.allowedWorkspaceRoots,
    },
    providers: providerChecks,
    sanitizedConfig: sanitizeConfigForDisplay(cfg, isProviderConfigured),
  };

  console.log(JSON.stringify(report, null, 2));
  if (!readiness.ready) {
    process.exitCode = 1;
  }
}

async function runEscalate(args: string[]): Promise<void> {
  const filePathArg = args.find((a) => !a.startsWith('--'));
  const errorMsg = parseArg(args, '--error');
  const applyFlag = args.includes('--apply');

  if (!filePathArg) {
    console.error('Usage: bailout-mcp escalate <filePath> [--error "error text"] [--apply]');
    process.exitCode = 1;
    return;
  }

  const resolvedFile = path.resolve(filePathArg);
  const cwd = path.resolve(process.cwd());
  const fileDir = path.dirname(resolvedFile);
  const workspaceRoot = resolvedFile.toLowerCase().startsWith(cwd.toLowerCase() + path.sep)
    ? cwd
    : fileDir;
  const engine = new BailoutEngine({
    workspaceRoot,
    allowedWorkspaceRoots: [cwd, fileDir],
    autoSolve: false,
  });

  if (errorMsg) {
    engine.ingest({
      kind: 'terminal_error',
      source: 'cli',
      filePath: resolvedFile,
      message: errorMsg,
    });
  }

  const proposal = await engine.triggerBailout({ filePath: resolvedFile, force: true });
  console.log(
    JSON.stringify(
      {
        id: proposal.id,
        provider: proposal.provider,
        model: proposal.model,
        confidence: proposal.confidence,
        latencyMs: proposal.latencyMs,
        rootCause: proposal.rootCause,
        summary: proposal.summary,
        explanation: proposal.explanation,
        whyPreviousAttemptsFailed: proposal.whyPreviousAttemptsFailed,
        unifiedDiff: proposal.patch.unifiedDiff,
      },
      null,
      2,
    ),
  );

  if (applyFlag) {
    const res = engine.acceptBailout(proposal.id, true);
    console.error(
      res.appliedToDisk
        ? `[BailoutMCP] Patch applied cleanly to ${resolvedFile}`
        : `[BailoutMCP] Patch NOT applied: ${res.applyError}`,
    );
  }
}

async function runPreview(args: string[]): Promise<void> {
  const filePathArg = args.find((a) => !a.startsWith('--'));
  const errorMsg = parseArg(args, '--error');

  if (!filePathArg) {
    console.error('Usage: bailout-mcp preview <filePath> [--error "error text"]');
    process.exitCode = 1;
    return;
  }

  const resolvedFile = path.resolve(filePathArg);
  const cwd = path.resolve(process.cwd());
  const fileDir = path.dirname(resolvedFile);
  const workspaceRoot = resolvedFile.toLowerCase().startsWith(cwd.toLowerCase() + path.sep)
    ? cwd
    : fileDir;
  const engine = new BailoutEngine({
    workspaceRoot,
    allowedWorkspaceRoots: [cwd, fileDir],
    autoSolve: false,
  });

  if (errorMsg) {
    engine.ingest({
      kind: 'terminal_error',
      source: 'cli',
      filePath: resolvedFile,
      message: errorMsg,
    });
  }

  const dossier = engine.previewDossier(resolvedFile);
  console.log(JSON.stringify(dossier, null, 2));
}

async function runSelftest(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailout-selftest-'));
  const sampleFile = path.join(tmpDir, 'Counter.ts');
  const fakeKey = ['sk', 'ant', 'api03', 'selftest1234567890abcdef'].join('-');
  fs.writeFileSync(
    sampleFile,
    [
      'import { useState } from "react";',
      `const API_TOKEN = "${fakeKey}";`,
      'export function tick(count: number) {',
      '  return count + 1;',
      '}',
    ].join('\n'),
    'utf8',
  );

  const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];
  try {
    const engine = new BailoutEngine({
      workspaceRoot: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      autoSolve: false,
    });

    engine.ingest({ kind: 'undo_burst', filePath: sampleFile, count: 4 });
    engine.ingest({
      kind: 'edit_churn',
      filePath: sampleFile,
      regionHash: hashContent('a'),
    });
    engine.ingest({
      kind: 'edit_churn',
      filePath: sampleFile,
      regionHash: hashContent('b'),
    });
    engine.ingest({
      kind: 'edit_churn',
      filePath: sampleFile,
      regionHash: hashContent('a'),
    });
    const snap = engine.ingest({
      kind: 'agent_tool_error',
      workspaceRoot: tmpDir,
      message: `TypeError: failed\n    at tick (${sampleFile}:4:3)`,
    });
    checks.push({
      check: 'shadow_state_scoring_and_stack_inference',
      ok: snap.score >= 35 && (snap.primaryHotspot?.oscillationCount ?? 0) === 1,
      detail: `score=${snap.score}, oscillations=${snap.primaryHotspot?.oscillationCount ?? 0}`,
    });

    const dossier = engine.previewDossier(sampleFile);
    const secretScrubbed =
      !dossier.numberedCodeWindow.includes(fakeKey) && dossier.redactedSecretsCount >= 1;
    checks.push({
      check: 'secret_redaction_and_dossier_distillation',
      ok: secretScrubbed,
      detail: `redactedSecretsCount=${dossier.redactedSecretsCount}`,
    });

    const patchRes = validateAndBuildPatch(
      sampleFile,
      fs.readFileSync(sampleFile, 'utf8'),
      {
        startLine: 4,
        endLine: 4,
        originalCode: '   4 |   return count + 1;',
        fixedCode: '   4 |   return count + 2;',
      },
      { maxPatchLines: 35 },
    );
    checks.push({
      check: 'surgical_patcher_and_line_prefix_recovery',
      ok: Boolean(patchRes && patchRes.patch.linesChanged === 1),
    });

    const envBlocked = isSensitiveFilePath(path.join(tmpDir, '.env.local'));
    let ssrfBlocked = false;
    try {
      validateEndpointUrl('http://169.254.169.254/latest/meta-data/');
    } catch {
      ssrfBlocked = true;
    }
    checks.push({
      check: 'security_denylist_and_ssrf_guard',
      ok: envBlocked && ssrfBlocked && redactSecrets(fakeKey).redactedCount >= 1,
    });

    const bridge = new LocalBridgeServer(engine, {
      port: 0,
      manifestDir: tmpDir,
      writeManifest: true,
    });
    await bridge.start();
    const client = await BridgeClient.discover(tmpDir);
    const mcp = client ? createBailoutMcpServer(client) : null;
    await bridge.stop();
    checks.push({
      check: 'local_bridge_and_mcp_server_boot',
      ok: Boolean(client && mcp),
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const allPassed = checks.every((c) => c.ok);
  console.log(JSON.stringify({ ok: allPassed, checks }, null, 2));
  if (!allPassed) {
    process.exitCode = 1;
  }
}

async function runInit(): Promise<void> {
  const cwd = process.cwd();
  const targetConfig = path.join(cwd, '.bailout.json');
  if (!fs.existsSync(targetConfig)) {
    const sample = {
      provider: 'anthropic',
      fallbackProviders: ['gemini', 'openrouter'],
      stuckThreshold: 70,
      pauseGateMs: 3500,
      cooldownMs: 300000,
      minConfidence: 0.72,
      maxBailoutsPerHour: 6,
      maxPatchLines: 35,
      redactSecrets: true,
    };
    fs.writeFileSync(targetConfig, JSON.stringify(sample, null, 2) + '\n', 'utf8');
    console.log(`Created ${targetConfig}`);
  } else {
    console.log(`${targetConfig} already exists — kept intact.`);
  }

  const cliPath = path.resolve(process.argv[1] ?? 'bailout-mcp');
  console.log('\nAdd this to your Claude Code / Cursor / Antigravity MCP config:\n');
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          bailout: {
            command: 'node',
            args: [cliPath],
            env: {
              BAILOUT_PROVIDER: 'anthropic',
              ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}',
            },
          },
        },
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  switch (subcommand) {
    case 'daemon':
      await runDaemon(args.slice(1));
      break;
    case 'status':
      await runStatus();
      break;
    case 'doctor':
      await runDoctor();
      break;
    case 'escalate':
      await runEscalate(args.slice(1));
      break;
    case 'preview':
      await runPreview(args.slice(1));
      break;
    case 'selftest':
      await runSelftest();
      break;
    case 'init':
      await runInit();
      break;
    case '--help':
    case '-h':
      console.log(`BailoutMCP — Shadow-State Frustration Detector & Silent Heavy-Model Bailout

Usage:
  bailout-mcp                             Start Stdio MCP server (auto-attaches/starts local bridge)
  bailout-mcp daemon [--watch .]          Run standalone local bridge daemon + file churn watcher
  bailout-mcp status                      Print live Shadow-State from the running local bridge
  bailout-mcp doctor                      Verify real provider credentials, endpoints & security guards
  bailout-mcp selftest                    Run fast end-to-end local verification of engine, security & MCP
  bailout-mcp preview <file> [--error]    Preview the secret-redacted local BailoutDossier (zero API calls)
  bailout-mcp escalate <file> [--error]   Run a real secret-redacted heavy-model escalation on <file>
  bailout-mcp init                        Create .bailout.json and print MCP client config snippet
`);
      break;
    default: {
      const runtime = await startStdioMcpServer();
      const shutdown = async () => {
        await runtime.bridge?.stop();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      break;
    }
  }
}

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE' || err.code === 'EOF') {
    process.exit(0);
  }
});

void main().catch((err) => {
  console.error('[BailoutMCP Error]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
