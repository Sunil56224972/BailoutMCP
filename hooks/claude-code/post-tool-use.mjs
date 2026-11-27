#!/usr/bin/env node
/**
 * Claude Code `PostToolUse` hook for BailoutMCP.
 * - Never blocks Claude Code (strict 350ms local HTTP timeout).
 * - Records genuine execution/edit errors AND green test/build resolutions (Micro-Win resets).
 * - Computes privacy-preserving SHA-256 `regionHash` on edits to catch A->B->A oscillation loops.
 * - Deduplicates repeated full-diff injections per bailout proposal ID.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MUTATING_OR_EXEC_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const VERIFICATION_CMD_RE =
  /\b(npm|pnpm|yarn|bun|npx|cargo|go|pytest|python3?\s+-m\s+pytest|vitest|jest|mocha|tsc|biome|eslint|ruff|mypy|gradle|mvn|dotnet)\b.*\b(test|check|typecheck|build|lint|verify)\b|\b(pytest|vitest|jest|tsc)\b/i;
const STRING_FAILURE_RE =
  /(?:^|\n)\s*(?:Exit code [1-9]\d*|Command failed|FAIL\s+\S+|ERROR:|Traceback \(most recent call last\)|error\[E\d+\]:|error TS\d+:)/;

function getBailoutDir() {
  if (process.env.BAILOUT_HOME && process.env.BAILOUT_HOME.trim()) {
    return path.resolve(process.env.BAILOUT_HOME.trim());
  }
  return path.join(os.homedir(), '.bailout-mcp');
}

function readManifest() {
  try {
    const p = path.join(getBailoutDir(), 'bridge.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function wasProposalAlreadyInjectedFull(proposalId) {
  try {
    const stateFile = path.join(getBailoutDir(), 'hook-state.json');
    if (!fs.existsSync(stateFile)) return false;
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return data?.lastInjectedId === proposalId && Date.now() - (data?.injectedAt ?? 0) < 120_000;
  } catch {
    return false;
  }
}

function markProposalInjected(proposalId) {
  try {
    const dir = getBailoutDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'hook-state.json'),
      JSON.stringify({ lastInjectedId: proposalId, injectedAt: Date.now() }),
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // Non-fatal
  }
}

function hashSnippet(text) {
  if (!text || typeof text !== 'string') return undefined;
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
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
    toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path ?? toolInput.filePath ?? undefined;

  const combinedOutput =
    typeof toolResp === 'string'
      ? toolResp
      : [toolResp?.stderr, toolResp?.stdout, toolResp?.error]
          .filter((s) => typeof s === 'string' && s.length > 0)
          .join('\n') || JSON.stringify(toolResp ?? {}).slice(0, 1000);

  const numericExit =
    typeof toolResp?.exit_code === 'number'
      ? toolResp.exit_code
      : typeof toolResp?.exitCode === 'number'
        ? toolResp.exitCode
        : undefined;

  const isExplicitError =
    Boolean(toolResp?.is_error || toolResp?.isError || toolResp?.error) ||
    (numericExit !== undefined && numericExit !== 0) ||
    (toolName === 'Bash' && numericExit === undefined && STRING_FAILURE_RE.test(combinedOutput));

  const commandStr = String(toolInput.command ?? '');

  if (isExplicitError) {
    await callBridge(manifest, '/v1/signals', {
      signal: {
        kind: 'agent_tool_error',
        source: 'claude-hook',
        filePath,
        workspaceRoot,
        code: toolName,
        exitCode: numericExit,
        message: combinedOutput.slice(0, 900),
        ...(process.env.ANTHROPIC_MODEL ? { agentModel: process.env.ANTHROPIC_MODEL } : {}),
      },
    });
  } else if (toolName === 'Bash' && VERIFICATION_CMD_RE.test(commandStr)) {
    // Test/build/typecheck command succeeded — emit error_resolved to trigger Micro-Win reset
    await callBridge(manifest, '/v1/signals', {
      signal: {
        kind: 'error_resolved',
        source: 'claude-hook',
        filePath,
        workspaceRoot,
        message: `Verification succeeded: ${commandStr.slice(0, 100)}`,
      },
    });
    return;
  } else if (
    toolName === 'Edit' ||
    toolName === 'Write' ||
    toolName === 'MultiEdit' ||
    toolName === 'NotebookEdit'
  ) {
    const editedBody =
      toolInput.new_string ??
      toolInput.content ??
      (Array.isArray(toolInput.edits)
        ? toolInput.edits.map((e) => e?.new_string ?? '').join('\n')
        : undefined);
    const regionHash = hashSnippet(editedBody);

    await callBridge(manifest, '/v1/signals', {
      signal: {
        kind: 'edit_churn',
        source: 'claude-hook',
        filePath,
        workspaceRoot,
        count: 1,
        ...(regionHash ? { regionHash } : {}),
        attemptedFix: `${toolName} on ${filePath ? path.basename(filePath) : 'file'}`,
      },
    });
  }

  const pending = await callBridge(manifest, '/v1/bailout/pending?includeGated=true');
  if (pending?.proposal) {
    const p = pending.proposal;
    const alreadySentFull = wasProposalAlreadyInjectedFull(p.id);
    markProposalInjected(p.id);

    const contextLines = alreadySentFull
      ? [
          `[BailoutMCP Reminder] Pre-solved fix ${p.id} from ${p.model} (${Math.round(p.confidence * 100)}% conf) is still pending for ${path.basename(p.filePath)}: "${p.summary}". Call get_pending_bailout / accept_bailout("${p.id}") or dismiss_bailout("${p.id}").`,
        ]
      : [
          `[BailoutMCP Pre-Solved Rescue Available from ${p.model} (${Math.round(p.confidence * 100)}% conf)]`,
          `Offer to user: ${p.offerMessage}`,
          `Root Cause: ${p.rootCause}`,
          p.whyPreviousAttemptsFailed ? `Why prior loop failed: ${p.whyPreviousAttemptsFailed}` : '',
          `Surgical Diff:\n${p.patch.unifiedDiff}`,
          `If the user agrees, apply this fix and call BailoutMCP's accept_bailout(id="${p.id}"). If declined, call dismiss_bailout(id="${p.id}").`,
        ];

    const output = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: contextLines.filter(Boolean).join('\n'),
      },
    };
    process.stdout.write(JSON.stringify(output));
  }
}

void main().catch(() => {});
