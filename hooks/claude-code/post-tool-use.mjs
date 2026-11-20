#!/usr/bin/env node
/**
 * Claude Code `PostToolUse` hook for BailoutMCP.
 * - Never blocks Claude Code (strict 350ms local HTTP timeout).
 * - Only records genuine execution/edit errors (never triggers false positives on Read/Grep output).
 * - Passes `workspaceRoot` so stack-trace file inference works even when Bash commands omit `filePath`.
 * - Injects a pre-solved heavy-model bailout into Claude Code when ready.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MUTATING_OR_EXEC_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

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
  const toolName = String(payload.tool_name ?? payload.toolName ?? 'unknown');
  if (!MUTATING_OR_EXEC_TOOLS.has(toolName)) return;

  const toolInput = payload.tool_input ?? payload.toolInput ?? {};
  const toolResp = payload.tool_response ?? payload.toolResponse ?? {};
  const workspaceRoot =
    typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  const filePath =
    toolInput.file_path ?? toolInput.path ?? toolInput.filePath ?? undefined;

  const stderrText =
    typeof toolResp?.stderr === 'string'
      ? toolResp.stderr
      : typeof toolResp === 'string'
        ? toolResp
        : JSON.stringify(toolResp ?? {}).slice(0, 1000);

  const isExplicitError =
    Boolean(toolResp?.is_error || toolResp?.isError) ||
    (typeof toolResp?.exit_code === 'number' && toolResp.exit_code !== 0) ||
    (typeof toolResp?.exitCode === 'number' && toolResp.exitCode !== 0);

  if (isExplicitError) {
    await callBridge(manifest, '/v1/signals', {
      signal: {
        kind: 'agent_tool_error',
        source: 'claude-hook',
        filePath,
        workspaceRoot,
        code: toolName,
        message: stderrText.slice(0, 600),
        ...(process.env.ANTHROPIC_MODEL ? { agentModel: process.env.ANTHROPIC_MODEL } : {}),
      },
    });
  } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    await callBridge(manifest, '/v1/signals', {
      signal: {
        kind: 'edit_churn',
        source: 'claude-hook',
        filePath,
        workspaceRoot,
        count: 1,
        attemptedFix: `${toolName} on ${filePath ? path.basename(filePath) : 'file'}`,
      },
    });
  }

  const pending = await callBridge(manifest, '/v1/bailout/pending?includeGated=true');
  if (pending?.proposal) {
    const p = pending.proposal;
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: [
          `[BailoutMCP Pre-Solved Rescue Available from ${p.model} (${Math.round(p.confidence * 100)}% conf)]`,
          `Offer to user: ${p.offerMessage}`,
          `Root Cause: ${p.rootCause}`,
          p.whyPreviousAttemptsFailed ? `Why prior loop failed: ${p.whyPreviousAttemptsFailed}` : '',
          `Surgical Diff:\n${p.patch.unifiedDiff}`,
          `If the user agrees, apply this fix and call BailoutMCP's accept_bailout(id="${p.id}").`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    };
    process.stdout.write(JSON.stringify(output));
  }
}

void main().catch(() => {});
