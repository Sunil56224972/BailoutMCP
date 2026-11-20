---
name: bailout-detector
description: Use BailoutMCP Shadow-State telemetry to detect when the developer or a lightweight model is stuck in an undo/error/oscillation loop, retrieve silently pre-solved heavy-model surgical fixes, and present them calmly without interrupting active flow.
---

# BailoutMCP — Shadow-State Frustration & Silent Bailout Skill

Use this skill whenever the `bailout` MCP server is connected in Claude Code, Cursor, Windsurf, or Antigravity.

## Core Rules

1. **Detect Loops Early (Record Signals):**
   - If you (the active coding agent) hit the same compiler, runtime, or test error **2+ times** on the same file, call `record_signal` with `kind: "agent_tool_error"`, `filePath`, `message`, `agentModel`, and `attemptedFix`.
   - When a previously failing test or error suite turns green, call `record_signal` with `kind: "error_resolved"` and `filePath` so BailoutMCP resets frustration debt and invalidates stale bailouts.

2. **Check for Pre-Solved Heavy-Model Rescues:**
   - Before trying a 3rd speculative patch on the same bug, call `get_shadow_state` or `get_pending_bailout`.
   - If `phase === "BAILOUT_READY"` and a proposal exists:
     - **Stop guessing.** Do NOT attempt another trial-and-error edit first.
     - Present the pre-solved heavy-model fix concisely in 2–3 lines:
       - State the root cause + why previous attempts looped.
       - Show the exact unified diff (`patch.unifiedDiff`).
       - Ask clearly if the developer wants you to apply it.

3. **Respect Anti-Annoyance Discipline:**
   - If `timingGate.canSurfaceNow === false` and the user did not ask about the bug, stay silent.
   - If the developer declines a bailout, call `dismiss_bailout(id)` immediately so exponential cooldown backoff takes effect.
   - If the developer accepts, apply the diff (or call `accept_bailout(id, applyToDisk: true)`) and verify tests/build.

4. **Manual Escalation When Truly Stuck:**
   - If `routerReady === true`, `score >= 60`, and no bailout is pending yet, you may call `trigger_bailout({ filePath })` to distill a secret-redacted minimal dossier and escalate once to the configured real heavy reasoning model (Opus / Gemini Pro / OpenAI / OpenRouter / local Ollama / custom router).
   - If `routerReady === false`, inform the user honestly that no heavy-model provider is configured — never fabricate a bailout result.
