---
name: bailout-detector
description: >-
  Use BailoutMCP Shadow-State telemetry whenever debugging recurring compiler, runtime, or test errors, edit/undo oscillation loops, or stubborn state/type bugs. Records loop signals, checks for silently pre-solved heavy-model surgical fixes, distills secret-redacted local dossiers even offline, and surfaces validated patches calmly without interrupting active flow.
---

# BailoutMCP — Shadow-State Frustration & Silent Bailout Skill

Activate this skill whenever the `bailout` MCP server is connected (or the local `bailout-mcp` CLI is available) in Claude Code, Cursor, Windsurf, or Antigravity, especially when fixing non-trivial bugs or repeated test/build failures.

## Decision Workflow

### 1. Track Friction & Loop Signals Early
- **On repeated failure (2+ hits on the same error or file):** Call `record_signal` with:
  - `kind`: `"agent_tool_error"` (or `"terminal_error"` / `"diagnostic_error"`)
  - `filePath`: absolute path of the suspect file (or pass `workspaceRoot` + `message` with stack trace so BailoutMCP infers the exact user source file automatically, skipping `node_modules`/`dist`)
  - `message`: raw error / traceback snippet
  - `agentModel`: your model identifier if known
  - `attemptedFix`: concise 1-line summary of what failed so future dossiers avoid repeating it
- **On verification pass (Micro-Win reset):** Whenever a previously failing test, build, or typecheck turns green, call `record_signal` with `kind: "error_resolved"` and `filePath`. This resets frustration debt and auto-invalidates stale bailout proposals.

### 2. Check Pre-Solved Rescues Before Guessing a 3rd Time
- Before attempting a 3rd speculative edit on the same bug, call `get_shadow_state` or `get_pending_bailout`.
- If `phase === "BAILOUT_READY"` and a `proposal` is returned:
  1. **Stop trial-and-error editing immediately.**
  2. Present the rescue concisely in 2–3 sentences:
     - **Root cause:** `proposal.rootCause` (plus `proposal.whyPreviousAttemptsFailed` if non-empty)
     - **Surgical diff:** show `proposal.patch.unifiedDiff`
     - **Ask clearly:** confirm whether the developer wants to apply it.

### 3. Escalate or Distill Locally When Stuck (`score >= 60` or 2+ Failed Fixes)
- **When `routerReady === true`** and no proposal is pending yet:
  - Call `trigger_bailout({ filePath, errorMessage, attemptedFix, startLine, endLine })` once to distill a secret-redacted micro-dossier (including top-of-file imports/types and ±45 hotspot lines) and obtain a validated surgical patch from the configured frontier reasoning model (Opus, Gemini Pro, o3, OpenRouter, Ollama, or custom router).
- **When `routerReady === false` (no external heavy-model API key configured):**
  - Never fabricate or pretend a heavy model ran.
  - Call `preview_dossier({ filePath })` to generate the 100% local, secret-redacted `BailoutDossier` (normalized recurring error fingerprints, oscillation count, prior failed fixes, top-of-file imports, and numbered hotspot window). Use that structured dossier to step back and perform clean root-cause analysis, and mention honestly if the user asks that no external heavy provider is configured yet.

### 4. Respect Anti-Annoyance & Clean Lifecycle Discipline
- **Natural Pause Gate:** If `timingGate.canSurfaceNow === false` and the user did not explicitly ask about the bug, do not interrupt mid-typing.
- **Accepting a Fix:** When approved, call `accept_bailout({ id: proposal.id, applyToDisk: true })` (or apply via IDE edit and call `accept_bailout({ id: proposal.id, applyToDisk: false })`), then immediately run the project's test/typecheck command to verify the fix.
- **Declining a Fix:** If declined, call `dismiss_bailout({ id: proposal.id })` so exponential cooldown backoff (`1x -> 2x -> 4x`) silences repeat offers.
- **Switching Tasks:** When moving to an unrelated feature/task, call `reset_shadow_state({})` (or `reset_shadow_state({ filePath })`) for a clean slate.

## Tool & CLI Reference

For full parameter schemas of all 9 MCP tools, 3 MCP resources, prompt templates, and CLI verification commands (`bailout-mcp selftest`, `doctor`, `preview`, `escalate`), read [mcp-tools-reference.md](./references/mcp-tools-reference.md).
