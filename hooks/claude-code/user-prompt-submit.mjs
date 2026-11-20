#!/usr/bin/env node
/**
 * Claude Code `UserPromptSubmit` hook for BailoutMCP.
 * - Detects correction/retry friction phrases without blocking.
 * - Surfaces any silently pre-solved heavy-model bailout right as the user submits a prompt.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FRICTION_HINT_RE =
  /\b(still (broken|failing|not working|getting)|same error|didn'?t work|does not work|doesn'?t work|try again|undo that|that'?s wrong|stuck|looping)\b/i;

function readManifest() {
  try {
    const p = path.join(os.homedir(), '.bailout-mcp', 'bridge.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function callBridge(manifest, pathname, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 350);
  try {
    const res = await fetch(`http://127.0.0.1:${manifest.port}${pathname}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        'x-bailout-token': manifest.token,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const manifest = readManifest();
  if (!manifest) return;

  const payload = await readStdin();
  const promptText = String(payload.prompt ?? payload.user_prompt ?? '');
  const workspaceRoot =
    typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  if (FRICTION_HINT_RE.test(promptText)) {
    await callBridge(manifest, '/v1/signals', {
      signal: {
        kind: 'prompt_abandoned',
        source: 'claude-hook',
        workspaceRoot,
        count: 1,
        message: 'User reported recurring failure / correction loop in prompt',
      },
    });
  }

  const pending = await callBridge(manifest, '/v1/bailout/pending?includeGated=true');
  if (pending?.proposal) {
    const p = pending.proposal;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: [
            `[BailoutMCP Shadow-State Rescue Ready — ${p.model}, ${Math.round(p.confidence * 100)}% confidence]`,
            `${p.offerMessage}`,
            `Root cause: ${p.rootCause}`,
            `Unified diff:\n${p.patch.unifiedDiff}`,
          ].join('\n'),
        },
      }),
    );
  }
}

void main().catch(() => {});
