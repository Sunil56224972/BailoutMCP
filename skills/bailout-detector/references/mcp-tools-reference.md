# BailoutMCP Tools, Resources & CLI Reference

## MCP Tools (9 Tools)

| Tool | Key Parameters | When to Use |
| :--- | :--- | :--- |
| `get_shadow_state` | *(none)* | Inspect live frustration `score` (`0-100`), `phase` (`FLOW`, `FRICTION`, `STUCK`, `BAILOUT_SOLVING`, `BAILOUT_READY`, `COOLDOWN`), `routerReady`, `primaryHotspot`, `timingGate`, and `stats`. |
| `record_signal` | `kind`, `filePath?`, `workspaceRoot?`, `startLine?`, `endLine?`, `message?`, `code?`, `exitCode?`, `count?`, `durationMs?`, `regionHash?`, `agentModel?`, `attemptedFix?` | Record behavioral/error signals (`agent_tool_error`, `terminal_error`, `diagnostic_error`, `edit_churn`, `undo_burst`, `prompt_abandoned`, `error_resolved`). |
| `get_pending_bailout` | `includeGated?` (`default: true`) | Retrieve a silently pre-solved heavy-model `BailoutProposal` (`rootCause`, `confidence`, `patch.unifiedDiff`, `offerMessage`). Pass `includeGated: false` to respect the active typing pause gate. |
| `trigger_bailout` | `filePath?`, `errorMessage?`, `attemptedFix?`, `startLine?`, `endLine?`, `force?` | Distill a secret-redacted dossier and escalate to the configured heavy reasoning model in a single call. |
| `preview_dossier` | `filePath?` | Generate and inspect the secret-redacted `BailoutDossier` (normalized recurring errors, oscillation count, top-of-file imports, numbered code window) **100% locally with zero API spend**. Works even when `routerReady === false`. |
| `accept_bailout` | `id`, `applyToDisk?` (`default: false`) | Mark proposal accepted, optionally apply the validated surgical patch atomically to disk, reset file friction, and start post-fix cooldown. |
| `dismiss_bailout` | `id?` | Dismiss pending proposal and apply exponential per-file cooldown backoff (`1x -> 2x -> 4x`). |
| `reset_shadow_state` | `filePath?` | Clear Shadow-State friction debt and stale proposals for one file or the entire workspace session. |
| `configure_bailout_router` | `provider?`, `stuckThreshold?`, `frictionThreshold?`, `pauseGateMs?`, `cooldownMs?`, `minConfidence?`, `autoSolve?` | Tune safe non-secret runtime thresholds or switch between configured providers (`anthropic`, `gemini`, `openai`, `openrouter`, `ollama`, `custom`). |

## MCP Resources & Prompts

- `bailout://shadow-state` — Real-time Shadow-State JSON snapshot
- `bailout://pending-bailout` — Currently ready heavy-model proposal & surgical diff
- `bailout://last-dossier` — Exact secret-redacted context dossier last distilled (full auditability)
- `present-bailout` — Prompt template formatting a pending proposal into a calm 2-sentence + unified diff offer

## CLI Verification & Diagnostic Commands

```bash
# Run instant self-contained verification of scoring, stack inference, redaction, security & MCP boot
node packages/mcp-server/dist/src/cli.js selftest

# Check provider readiness, endpoint SSRF safety, and workspace security boundaries
node packages/mcp-server/dist/src/cli.js doctor

# Preview the secret-redacted local dossier for a file without calling any external API
node packages/mcp-server/dist/src/cli.js preview ./src/buggyFile.ts --error "TypeError: ..."

# Run a live heavy-model escalation from the terminal (add --apply to write atomically)
node packages/mcp-server/dist/src/cli.js escalate ./src/buggyFile.ts --error "TypeError: ..."
```
