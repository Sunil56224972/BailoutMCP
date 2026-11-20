import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BailoutEngine } from '../src/engine.js';
import { hashContent } from '../src/normalizer.js';
import type { RawModelBailoutResponse } from '../src/types.js';

function startTestRouterServer(
  handler: (headers: http.IncomingHttpHeaders, body: string) => RawModelBailoutResponse,
): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const responseObj = handler(req.headers, rawBody);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(responseObj) } }],
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1/chat/completions` });
    });
  });
}

test('BailoutEngine NEVER fakes results when no real provider is configured', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailout-unconf-'));
  const filePath = path.join(tmpDir, 'App.ts');
  fs.writeFileSync(filePath, 'export const value = 1;\n', 'utf8');

  try {
    const engine = new BailoutEngine({
      workspaceRoot: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      provider: 'anthropic',
      providers: {
        anthropic: { apiKey: '', model: 'claude-opus-4-6' },
        gemini: { apiKey: '', model: 'gemini-2.5-pro' },
        openai: { apiKey: '', model: 'o3' },
        openrouter: { apiKey: '', model: 'anthropic/claude-opus-4.6' },
        ollama: { model: '', baseUrl: '' },
        custom: { model: '', baseUrl: '' },
      },
    });

    const snap = engine.getSnapshot();
    assert.equal(snap.routerReady, false);
    assert.ok(snap.routerNotice);

    await assert.rejects(
      () => engine.triggerBailout({ filePath, force: true }),
      /not configured/i,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('BailoutEngine escalates silently over real HTTP router, enforces pause gate, and patches exact target line', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailout-engine-test-'));
  const filePath = path.join(tmpDir, 'Counter.tsx');
  // Put identical line twice to verify closest-line matching (Bug #1 regression test)
  fs.writeFileSync(
    filePath,
    [
      'export function safeHandler(setCount: any, count: number) {',
      '  setCount(count + 1);',
      '}',
      '',
      'export function buggyTimer(setCount: any, count: number) {',
      '  setInterval(() => {',
      '    setCount(count + 1);',
      '  }, 1000);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  let receivedHeaders: http.IncomingHttpHeaders = {};
  let receivedPrompt = '';
  const { server, baseUrl } = await startTestRouterServer((headers, body) => {
    receivedHeaders = headers;
    receivedPrompt = body;
    return {
      rootCause: 'Stale closure inside setInterval captures initial count',
      summary: 'Use functional state updater inside setInterval',
      explanation: 'Functional updater reads latest React state on every tick.',
      whyPreviousAttemptsFailed: 'Previous attempts left direct count capture inside setInterval.',
      confidence: 0.94,
      patch: {
        startLine: 7,
        endLine: 7,
        originalCode: '    setCount(count + 1);',
        fixedCode: '    setCount((prev) => prev + 1);',
      },
    };
  });

  try {
    const engine = new BailoutEngine({
      workspaceRoot: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      provider: 'custom',
      stuckThreshold: 70,
      pauseGateMs: 400,
      autoSolve: true,
      providers: {
        anthropic: { model: 'claude-opus-4-6' },
        gemini: { model: 'gemini-2.5-pro' },
        openai: { model: 'o3' },
        openrouter: { model: 'anthropic/claude-opus-4.6' },
        ollama: { model: 'qwen2.5-coder:32b', baseUrl: 'http://127.0.0.1:11434/api/chat' },
        custom: { model: 'opus-bailout', baseUrl, apiKey: 'router-token' },
      },
    });

    const readyPromise = new Promise<void>((resolve) => {
      engine.once('bailout_ready', () => resolve());
    });

    const t = Date.now() - 500;
    engine.ingest({ kind: 'file_dwell', filePath, durationMs: 10 * 60 * 1000, lineRange: { startLine: 6, endLine: 8 }, timestamp: t });
    engine.ingest({ kind: 'undo_burst', filePath, count: 3, timestamp: t + 10 });
    engine.ingest({ kind: 'edit_churn', filePath, regionHash: hashContent('a'), timestamp: t + 20 });
    engine.ingest({ kind: 'edit_churn', filePath, regionHash: hashContent('b'), timestamp: t + 30 });
    engine.ingest({ kind: 'edit_churn', filePath, regionHash: hashContent('a'), timestamp: t + 40 });
    engine.ingest({
      kind: 'agent_tool_error',
      filePath,
      agentModel: 'claude-sonnet-4',
      message: 'AssertionError: count stays stuck at 1',
      timestamp: t + 50,
    });
    engine.ingest({
      kind: 'agent_tool_error',
      filePath,
      agentModel: 'claude-sonnet-4',
      message: 'AssertionError: count stays stuck at 1',
      timestamp: t + 60,
    });

    await readyPromise;

    assert.equal(receivedHeaders['x-bailout-trigger'], 'shadow-state');
    assert.equal(receivedHeaders['x-bailout-original-model'], 'claude-sonnet-4');
    assert.match(receivedPrompt, /<UNTRUSTED_CODE_[0-9a-f]+>/);

    // Gated while actively typing
    const activeAt = Date.now();
    engine.ingest({ kind: 'keystroke_activity', filePath, timestamp: activeAt });
    assert.equal(engine.getPendingBailout(false, activeAt + 100), undefined);
    assert.equal(engine.checkSurfaceable(activeAt + 500), undefined);

    // Surfaces after natural pause past 1.5x rapid-burst guard
    const surfaced = engine.checkSurfaceable(activeAt + 800);
    assert.ok(surfaced);
    assert.equal(surfaced.patch.startLine, 7);

    const accepted = engine.acceptBailout(surfaced.id, true);
    assert.equal(accepted.appliedToDisk, true);

    const updatedLines = fs.readFileSync(filePath, 'utf8').split('\n');
    // Line 2 MUST stay untouched; line 7 MUST be patched!
    assert.equal(updatedLines[1], '  setCount(count + 1);');
    assert.equal(updatedLines[6], '    setCount((prev) => prev + 1);');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('BailoutEngine blocks unsafe prompt-injected patches and sensitive .env files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailout-safety-'));
  const codeFile = path.join(tmpDir, 'Handler.ts');
  const envFile = path.join(tmpDir, '.env');
  fs.writeFileSync(codeFile, 'export function run(x: string) {\n  return x.trim();\n}\n', 'utf8');
  const syntheticSecret = ['sk', 'live', '1234567890abcdef123456'].join('_');
  fs.writeFileSync(envFile, `STRIPE_SECRET=${syntheticSecret}\n`, 'utf8');

  const { server, baseUrl } = await startTestRouterServer(() => ({
    rootCause: 'Injected malicious payload',
    summary: 'Sneaky eval injection',
    explanation: 'Bad model output',
    whyPreviousAttemptsFailed: '',
    confidence: 0.99,
    patch: {
      startLine: 2,
      endLine: 2,
      originalCode: '  return x.trim();',
      fixedCode: '  return eval(x);',
    },
  }));

  try {
    const engine = new BailoutEngine({
      workspaceRoot: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      provider: 'custom',
      autoSolve: false,
      providers: {
        anthropic: { model: 'claude-opus-4-6' },
        gemini: { model: 'gemini-2.5-pro' },
        openai: { model: 'o3' },
        openrouter: { model: 'anthropic/claude-opus-4.6' },
        ollama: { model: 'qwen2.5-coder:32b', baseUrl: 'http://127.0.0.1:11434/api/chat' },
        custom: { model: 'test-model', baseUrl },
      },
    });

    // Sensitive .env file MUST be rejected immediately
    await assert.rejects(
      () => engine.triggerBailout({ filePath: envFile, force: true }),
      /SecurityError/,
    );

    // Unsafe eval() patch from model MUST be rejected
    await assert.rejects(
      () => engine.triggerBailout({ filePath: codeFile, force: true }),
      /safety validation/i,
    );
    assert.equal(engine.getSnapshot().stats.bailoutsRejectedUnsafe, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('BailoutEngine auto-invalidates queued bailout on micro-win error resolution', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailout-self-resolve-'));
  const filePath = path.join(tmpDir, 'Api.ts');
  fs.writeFileSync(
    filePath,
    'export async function load(url: string) {\n  const res = fetch(url);\n  return res;\n}\n',
    'utf8',
  );

  const { server, baseUrl } = await startTestRouterServer(() => ({
    rootCause: 'Missing await on fetch()',
    summary: 'Await fetch call',
    explanation: 'Add await before fetch(url).',
    whyPreviousAttemptsFailed: 'Returned pending Promise.',
    confidence: 0.93,
    patch: {
      startLine: 2,
      endLine: 2,
      originalCode: '  const res = fetch(url);',
      fixedCode: '  const res = await fetch(url);',
    },
  }));

  try {
    const engine = new BailoutEngine({
      workspaceRoot: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      provider: 'custom',
      pauseGateMs: 5000,
      autoSolve: false,
      providers: {
        anthropic: { model: 'claude-opus-4-6' },
        gemini: { model: 'gemini-2.5-pro' },
        openai: { model: 'o3' },
        openrouter: { model: 'anthropic/claude-opus-4.6' },
        ollama: { model: 'qwen2.5-coder:32b', baseUrl: 'http://127.0.0.1:11434/api/chat' },
        custom: { model: 'opus-bailout', baseUrl },
      },
    });

    engine.ingest({
      kind: 'diagnostic_error',
      filePath,
      message: "Property 'json' does not exist on type 'Promise<Response>'",
    });

    const proposal = await engine.triggerBailout({ filePath, force: true });
    assert.ok(proposal.patch.fixedCode.includes('await fetch(url)'));

    let invalidatedReason = '';
    engine.once('bailout_invalidated', (e) => {
      invalidatedReason = e.reason;
    });

    engine.ingest({ kind: 'error_resolved', filePath });

    assert.equal(engine.getPendingBailout(true), undefined);
    assert.match(invalidatedReason, /micro-win/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
