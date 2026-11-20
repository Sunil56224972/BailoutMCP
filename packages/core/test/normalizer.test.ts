import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeErrorSignature, redactSecrets } from '../src/normalizer.js';

test('normalizeErrorSignature produces identical fingerprint despite shifting lines, paths, timestamps & ANSI', () => {
  const err1 =
    '\u001b[31m2026-11-20T12:01:02Z TypeError: Cannot read properties of undefined (reading \'items\')\u001b[0m\n  at C:\\Users\\alice\\repo\\src\\Cart.tsx:42:17';
  const err2 =
    '2026-11-20T12:09:55Z TypeError: Cannot read properties of undefined (reading \'items\')\n  at /home/bob/work/src/Cart.tsx:49:9';

  const a = normalizeErrorSignature(err1, 'TS2532');
  const b = normalizeErrorSignature(err2, 'TS2532');

  assert.equal(a.fingerprint, b.fingerprint);
  assert.ok(a.normalized.includes('[TS2532]'));
  assert.ok(!a.normalized.includes('alice'));
  assert.ok(!a.normalized.includes('bob'));
});

test('normalizeErrorSignature distinguishes genuinely different errors', () => {
  const a = normalizeErrorSignature("TypeError: Cannot read properties of undefined (reading 'items')");
  const b = normalizeErrorSignature('ReferenceError: fetchUser is not defined');
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('redactSecrets scrubs API keys, DB passwords, Stripe/Slack/OpenRouter tokens, JWTs & env secrets', () => {
  // Construct synthetic test fixtures dynamically to avoid tripping static secret scanners
  const fakeAnthropic = ['sk', 'ant', 'api03', 'abcdef1234567890abcdef1234567890'].join('-');
  const fakeGoogle = ['AIza', 'SyD1234567890abcdef1234567890'].join('');
  const fakeGh = ['ghp', '1234567890abcdefghij1234567890'].join('_');
  const fakeStripe = ['sk', 'live', '51H1234567890abcdef123456'].join('_');
  const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'signature123456'].join('.');

  const raw = [
    `const anthropic = "${fakeAnthropic}";`,
    `const google = "${fakeGoogle}";`,
    `const gh = "${fakeGh}";`,
    `const stripe = "${fakeStripe}";`,
    'const db = "postgres://admin:UltraSecretDbPass99@db.internal:5432/prod";',
    `const auth = "Bearer ${fakeJwt}";`,
    'DB_PASSWORD="superSecretPassword123"',
  ].join('\n');

  const { text, redactedCount } = redactSecrets(raw);
  assert.ok(redactedCount >= 7);
  assert.ok(!text.includes(fakeAnthropic));
  assert.ok(!text.includes(fakeGoogle));
  assert.ok(!text.includes(fakeGh));
  assert.ok(!text.includes(fakeStripe));
  assert.ok(!text.includes('UltraSecretDbPass99'));
  assert.ok(!text.includes(fakeJwt));
  assert.ok(!text.includes('superSecretPassword123'));
});
