import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { distillBailoutDossier } from '../src/distiller.js';
import { validateAndBuildPatch } from '../src/patcher.js';
import { ShadowStateTracker } from '../src/shadow-state.js';

test('validateAndBuildPatch recovers when model includes dossier line-number prefixes ("  12 | ")', () => {
  const content = [
    'export function computeTotal(items: number[]) {',
    '  let sum = 0;',
    '  for (let i = 0; i <= items.length; i++) {',
    '    sum += items[i];',
    '  }',
    '  return sum;',
    '}',
  ].join('\n');

  const result = validateAndBuildPatch(
    '/repo/src/math.ts',
    content,
    {
      startLine: 3,
      endLine: 4,
      originalCode: '   3 |   for (let i = 0; i <= items.length; i++) {\n   4 |     sum += items[i];',
      fixedCode: '   3 |   for (let i = 0; i < items.length; i++) {\n   4 |     sum += items[i];',
    },
    { maxPatchLines: 35 },
  );

  assert.ok(result, 'Expected patcher to strip dossier line prefixes and match');
  assert.equal(result.patch.startLine, 3);
  assert.equal(result.patch.linesChanged, 1);
  assert.ok(result.patchedFullContent.includes('for (let i = 0; i < items.length; i++) {'));
  assert.ok(!result.patchedFullContent.includes('3 |'));
});

test('validateAndBuildPatch recovers from uniform leading-indentation drift and preserves file indentation', () => {
  const content = [
    'export class Cart {',
    '  update() {',
    '    if (this.items) {',
    '      this.total = this.items.reduce((a, b) => a + b);',
    '    }',
    '  }',
    '}',
  ].join('\n');

  // Model returned 2-space indent instead of 4/6-space indent
  const result = validateAndBuildPatch(
    '/repo/src/Cart.ts',
    content,
    {
      startLine: 3,
      endLine: 5,
      originalCode: [
        '  if (this.items) {',
        '    this.total = this.items.reduce((a, b) => a + b);',
        '  }',
      ].join('\n'),
      fixedCode: [
        '  if (this.items) {',
        '    this.total = this.items.reduce((a, b) => a + b, 0);',
        '  }',
      ].join('\n'),
    },
    { maxPatchLines: 35 },
  );

  assert.ok(result, 'Expected indentation-delta fallback to match and re-indent');
  assert.equal(result.patch.linesChanged, 1);
  assert.ok(
    result.patchedFullContent.includes('      this.total = this.items.reduce((a, b) => a + b, 0);'),
  );
  // Unified diff includes context lines (" ") and only 1 "-" / "+" line
  assert.match(result.patch.unifiedDiff, /\n- {6}this\.total = this\.items\.reduce\(\(a, b\) => a \+ b\);/);
  assert.match(result.patch.unifiedDiff, /\n\+ {6}this\.total = this\.items\.reduce\(\(a, b\) => a \+ b, 0\);/);
});

test('validateAndBuildPatch blocks overwriting real secrets with [REDACTED_*] placeholders', () => {
  const content = [
    'const DEFAULT_KEY = "real_secret_value_123";',
    'export function ping() { return false; }',
  ].join('\n');

  const blocked = validateAndBuildPatch(
    '/repo/src/client.ts',
    content,
    {
      startLine: 1,
      endLine: 2,
      originalCode: content,
      fixedCode: [
        'const DEFAULT_KEY = "[REDACTED_SECRET]";',
        'export function ping() { return true; }',
      ].join('\n'),
    },
    { maxPatchLines: 35 },
  );

  assert.equal(blocked, null);
});

test('distillBailoutDossier includes redacted top-of-file imports when hotspot is deep in file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailout-distill-'));
  const filePath = path.join(tmpDir, 'Service.ts');
  const fakeTok = ['ghp', '1234567890abcdefghij1234567890'].join('_');

  const filler = Array.from({ length: 90 }, (_, idx) => `const line_${idx} = ${idx};`);
  const source = [
    'import { z } from "zod";',
    'import type { UserRecord } from "./models.js";',
    `const BOOT_TOKEN = "${fakeTok}";`,
    ...filler,
    'export function validateUser(input: unknown): UserRecord {',
    '  return input as UserRecord;',
    '}',
  ].join('\n');

  fs.writeFileSync(filePath, source, 'utf8');

  try {
    const cfg = loadConfig({
      workspaceRoot: tmpDir,
      allowedWorkspaceRoots: [tmpDir],
      contextWindowRadius: 15,
    });
    const tracker = new ShadowStateTracker(cfg);
    const { hotspot } = tracker.ingest({
      kind: 'diagnostic_error',
      filePath,
      lineRange: { startLine: 94, endLine: 95 },
      message: 'Unsafe cast',
    });

    const dossier = distillBailoutDossier(hotspot!, cfg);
    assert.ok(dossier.windowStartLine > 50);
    assert.ok(dossier.topOfFileContext, 'Expected topOfFileContext when windowStartLine > 3');
    assert.ok(dossier.topOfFileContext.includes('import { z } from "zod"'));
    assert.ok(dossier.topOfFileContext.includes('UserRecord'));
    assert.ok(!dossier.topOfFileContext.includes(fakeTok));
    assert.ok(dossier.redactedSecretsCount >= 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
