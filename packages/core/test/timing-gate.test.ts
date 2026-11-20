import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { TimingGate } from '../src/timing-gate.js';

test('TimingGate blocks surfacing while user is actively typing and opens on natural pause', () => {
  const cfg = loadConfig({ pauseGateMs: 3500, maxAutoSurfaceIdleMs: 60_000 });
  const gate = new TimingGate(cfg);
  const t0 = 10_000;

  gate.recordActivity(t0, true);

  const active = gate.evaluate(t0 + 1000, 0);
  assert.equal(active.canSurfaceNow, false);

  const paused = gate.evaluate(t0 + 4000, 0);
  assert.equal(paused.canSurfaceNow, true);

  const afk = gate.evaluate(t0 + 120_000, 0);
  assert.equal(afk.canSurfaceNow, false);
});

test('TimingGate respects active cooldown', () => {
  const cfg = loadConfig({ pauseGateMs: 1000 });
  const gate = new TimingGate(cfg);
  const t0 = 10_000;

  gate.recordActivity(t0, false);
  const status = gate.evaluate(t0 + 5000, t0 + 60_000);
  assert.equal(status.canSurfaceNow, false);
  assert.match(status.reason, /Cooldown active/);
});
