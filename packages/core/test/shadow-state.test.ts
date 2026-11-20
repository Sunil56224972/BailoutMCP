import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { hashContent } from '../src/normalizer.js';
import { ShadowStateTracker } from '../src/shadow-state.js';

test('calm coding in deep flow (long dwell + normal typing, no errors/undos) never falsely triggers stuck state', () => {
  const tracker = new ShadowStateTracker(loadConfig());
  const now = Date.now();
  const file = '/repo/src/Feature.ts';

  tracker.ingest({ kind: 'file_focus', filePath: file, timestamp: now });
  tracker.ingest({ kind: 'file_dwell', filePath: file, durationMs: 25 * 60 * 1000, timestamp: now + 1000 });
  tracker.ingest({ kind: 'keystroke_activity', filePath: file, timestamp: now + 2000 });

  const hotspot = tracker.getHotspot(file, now + 2500);
  assert.ok(hotspot);
  assert.equal(hotspot.score, 0);
  assert.equal(hotspot.breakdown.fileDwell, 0);
});

test('switching away to File B does not credit File B elapsed time onto File A dwell', () => {
  const tracker = new ShadowStateTracker(loadConfig());
  const t0 = 1_000_000;
  const fileA = '/repo/src/A.ts';
  const fileB = '/repo/src/B.ts';

  tracker.ingest({ kind: 'file_focus', filePath: fileA, timestamp: t0 });
  tracker.ingest({ kind: 'file_focus', filePath: fileB, timestamp: t0 + 5_000 });
  tracker.ingest({ kind: 'file_focus', filePath: fileA, timestamp: t0 + 95_000 });

  const hotspotA = tracker.getHotspot(fileA, t0 + 95_000)!;
  assert.equal(hotspotA.dwellMs, 0);
});

test('CLI terminal/agent error without explicit filePath infers real source file & line from stack trace', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailout-stack-'));
  const targetFile = path.join(tmpDir, 'CartService.ts');
  fs.writeFileSync(targetFile, 'export function calc() {\n  return 1;\n}\n', 'utf8');

  try {
    const tracker = new ShadowStateTracker(loadConfig({ workspaceRoot: tmpDir }));
    const outcome = tracker.ingest({
      kind: 'agent_tool_error',
      workspaceRoot: tmpDir,
      message: `TypeError: Cannot read properties of undefined\n    at calc (${targetFile}:2:10)`,
    });

    assert.ok(outcome.hotspot);
    assert.equal(path.resolve(outcome.hotspot.filePath), path.resolve(targetFile));
    assert.equal(outcome.hotspot.hotspotRange?.startLine, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('undo bursts + A->B->A oscillation + recurring errors + dwell cleanly crosses stuck threshold', () => {
  const cfg = loadConfig({ stuckThreshold: 70 });
  const tracker = new ShadowStateTracker(cfg);
  const now = Date.now();
  const file = '/repo/src/AuthStore.ts';

  tracker.ingest({ kind: 'file_dwell', filePath: file, durationMs: 10 * 60 * 1000, timestamp: now });
  tracker.ingest({ kind: 'undo_burst', filePath: file, count: 4, timestamp: now + 100 });

  const hA = hashContent('state = a');
  const hB = hashContent('state = b');
  tracker.ingest({ kind: 'edit_churn', filePath: file, regionHash: hA, timestamp: now + 200 });
  tracker.ingest({ kind: 'edit_churn', filePath: file, regionHash: hB, timestamp: now + 300 });
  tracker.ingest({ kind: 'edit_churn', filePath: file, regionHash: hA, timestamp: now + 400 });

  for (let i = 0; i < 3; i++) {
    tracker.ingest({
      kind: 'diagnostic_error',
      filePath: file,
      code: 'TS2345',
      message: "Argument of type 'string | undefined' is not assignable to parameter of type 'string'",
      timestamp: now + 500 + i * 100,
    });
  }

  const hotspot = tracker.getHotspot(file, now + 1000)!;
  assert.ok(hotspot.score >= 70, `Expected score >= 70, got ${hotspot.score}`);
  assert.equal(hotspot.oscillationCount, 1);
  assert.ok(hotspot.breakdown.fileDwell > 0);
  assert.ok(hotspot.reasons.length >= 2);
});

test('error_resolved emits a micro-win and decays frustration score sharply', () => {
  const cfg = loadConfig();
  const tracker = new ShadowStateTracker(cfg);
  const now = Date.now();
  const file = '/repo/src/Parser.ts';

  for (let i = 0; i < 3; i++) {
    tracker.ingest({
      kind: 'terminal_error',
      filePath: file,
      exitCode: 1,
      message: 'SyntaxError: Unexpected token } at Parser.ts:18:2',
      timestamp: now + i * 100,
    });
  }

  const before = tracker.getHotspot(file, now + 400)!;
  assert.ok(before.score >= 35);

  const outcome = tracker.ingest({
    kind: 'error_resolved',
    filePath: file,
    timestamp: now + 500,
  });

  assert.ok(outcome.microWin, 'Expected microWin event on error resolution');
  assert.ok(outcome.hotspot!.score < before.score * 0.4);
});

test('dismissal backoff doubles cooldown exponentially (1x -> 2x -> 4x)', () => {
  const cfg = loadConfig({ cooldownMs: 60_000 });
  const tracker = new ShadowStateTracker(cfg);
  const now = 1_000_000;
  const file = '/repo/src/App.tsx';

  const c1 = tracker.recordDismissal(file, now);
  const c2 = tracker.recordDismissal(file, now);
  const c3 = tracker.recordDismissal(file, now);

  assert.equal(c1 - now, 60_000);
  assert.equal(c2 - now, 120_000);
  assert.equal(c3 - now, 240_000);
});
