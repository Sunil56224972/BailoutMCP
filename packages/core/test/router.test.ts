import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { BailoutRouter } from '../src/router.js';
import type { BailoutDossier } from '../src/types.js';

function makeSampleDossier(): BailoutDossier {
  return {
    filePath: '/repo/src/Markdown.ts',
    relativePath: 'src/Markdown.ts',
    language: 'typescript',
    frustrationScore: 82,
    triggerReasons: ['Same error repeated 3x'],
    hotspotRange: { startLine: 4, endLine: 6 },
    topOfFileContext: '   1 | import { marked } from "marked";',
    numberedCodeWindow: '   4 | const fence = "```ts\\ncode\\n```";\n   5 | return fence;',
    rawCodeWindow: 'const fence = "```ts\\ncode\\n```";\nreturn fence;',
    windowStartLine: 4,
    windowEndLine: 5,
    fileContentHash: 'abc12345',
    recurringErrors: [
      { count: 3, normalized: 'TypeError: bad fence', latestRaw: 'TypeError: bad fence' },
    ],
    attemptedFixes: ['Tried trimming string'],
    lightweightModel: 'claude-haiku-4',
    dwellMinutes: 6.5,
    undoCount: 4,
    oscillationCount: 1,
    redactedSecretsCount: 0,
  };
}

test('BailoutRouter parses JSON safely even when fixedCode/originalCode contains inner triple backticks', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const payload = {
        rootCause: 'Backtick fence was missing newline',
        summary: 'Normalize triple-backtick code block',
        explanation: 'Preserves inner markdown code block.',
        whyPreviousAttemptsFailed: 'Regex stripped inner fences.',
        confidence: 0.91,
        patch: {
          startLine: 4,
          endLine: 5,
          originalCode: 'const fence = "```ts\\ncode\\n```";',
          fixedCode: 'const fence = "```ts\\ncode\\n```\\n";',
        },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                // Also test outer commentary with trailing braces after balanced JSON
                content: `Here is the JSON result:\n${JSON.stringify(payload)}\nNote: avoided {extra} edits.`,
              },
            },
          ],
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  try {
    const cfg = loadConfig({
      provider: 'custom',
      providers: {
        anthropic: { model: 'claude-opus-4-6' },
        gemini: { model: 'gemini-2.5-pro' },
        openai: { model: 'o3' },
        openrouter: { model: 'anthropic/claude-opus-4.6' },
        ollama: { model: 'qwen2.5-coder:32b', baseUrl: 'http://127.0.0.1:11434/api/chat' },
        custom: {
          model: 'test-router',
          baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
        },
      },
    });
    const router = new BailoutRouter(cfg);
    const solved = await router.solve(makeSampleDossier());
    assert.equal(solved.response.confidence, 0.91);
    assert.ok(solved.response.patch.fixedCode.includes('```ts'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('BailoutRouter filters Gemini thought parts and fails over cleanly across fallbackProviders', async () => {
  // Primary custom endpoint returns 503; fallback Gemini endpoint returns thought part + JSON part
  const failingPrimary = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Upstream overloaded');
    });
  });

  const geminiStub = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    thought: true,
                    text: 'Let me think step by step about { braces } and ```fences```...',
                  },
                  {
                    text: JSON.stringify({
                      rootCause: 'Resolved by Gemini fallback after skipping thought trace',
                      summary: 'Return trimmed fence',
                      explanation: 'Uses non-thought output part.',
                      whyPreviousAttemptsFailed: 'Primary failed.',
                      confidence: 0.95,
                      patch: {
                        startLine: 5,
                        endLine: 5,
                        originalCode: 'return fence;',
                        fixedCode: 'return fence.trim();',
                      },
                    }),
                  },
                ],
              },
            },
          ],
        }),
      );
    });
  });

  await Promise.all([
    new Promise<void>((resolve) => failingPrimary.listen(0, '127.0.0.1', () => resolve())),
    new Promise<void>((resolve) => geminiStub.listen(0, '127.0.0.1', () => resolve())),
  ]);

  const primaryPort = (failingPrimary.address() as { port: number }).port;
  const geminiPort = (geminiStub.address() as { port: number }).port;
  const fakeGemKey = ['AIza', 'SyRouterFallbackTest123456'].join('');

  try {
    const cfg = loadConfig({
      provider: 'custom',
      fallbackProviders: ['gemini'],
      providers: {
        anthropic: { model: 'claude-opus-4-6' },
        gemini: {
          apiKey: fakeGemKey,
          model: 'gemini-2.5-pro',
          baseUrl: `http://127.0.0.1:${geminiPort}/v1beta`,
        },
        openai: { model: 'o3' },
        openrouter: { model: 'anthropic/claude-opus-4.6' },
        ollama: { model: 'qwen2.5-coder:32b', baseUrl: 'http://127.0.0.1:11434/api/chat' },
        custom: {
          model: 'failing-primary',
          baseUrl: `http://127.0.0.1:${primaryPort}/v1/chat/completions`,
        },
      },
    });

    const router = new BailoutRouter(cfg);
    const solved = await router.solve(makeSampleDossier());
    assert.equal(solved.provider, 'gemini');
    assert.equal(solved.model, 'gemini-2.5-pro');
    assert.equal(solved.response.patch.fixedCode, 'return fence.trim();');
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => failingPrimary.close(() => resolve())),
      new Promise<void>((resolve) => geminiStub.close(() => resolve())),
    ]);
  }
});
