<div align="center">

# 🛟 BailoutMCP

### Shadow-State Frustration Detector & Silent Pre-Solved Heavy-Model Bailout Trigger

**Stop waiting until you're furious to switch models.**  
BailoutMCP detects when you (or a fast coding model) are silently trapped in an undo/oscillation/error loop, quietly escalates a secret-redacted micro-context to a frontier reasoning model, validates the surgical diff, and offers it **only during a natural micro-pause**.

[![CI](https://github.com/Sunil56224972/BailoutMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/Sunil56224972/BailoutMCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Stdio%20%2B%20Local%20Bridge-7C3AED)](https://modelcontextprotocol.io)

[Why BailoutMCP](#-the-problem-nobody-solved) •
[Architecture](#-architecture) •
[Quick Start](#-quick-start) •
[Providers](#-supported-heavy-model-providers) •
[MCP Reference](#-mcp-tools-resources--prompts) •
[Security Model](#-security--privacy-model)

</div>

---

## 🔥 The Problem Nobody Solved

Every developer using AI coding assistants hits the exact same wall every day:

1. You run a fast, affordable model (like Sonnet, Flash, or a local model) to preserve speed and quota.
2. You hit a tricky state, concurrency, or type bug. You spend **10+ minutes on the same file** — spamming `Ctrl+Z`, oscillating `A → B → A` on the same lines, hitting the same compiler/test error 4 times, while the lightweight model patches symptoms in circles.
3. **The AI has zero clue you're stuck** until you angrily type *"this still doesn't work, stop guessing!"* — and then you have to manually switch to Opus / Gemini Pro / o3 and re-explain everything from scratch.

**BailoutMCP closes that loop silently in the background:**

> *"Stuck on `CartCounter.tsx`? Escalated to `claude-opus-4-6` and validated a 1-line fix (94% confidence): 'Use functional React state updater to fix stale closure'. Review diff?"*

- **100% Real Data & Real Models:** Zero fake/mock analyzers, zero hardcoded fallbacks. If no real model provider is configured, BailoutMCP honestly reports `routerReady: false`.
- **Zero-Clippy Anti-Annoyance Gate:** Never pops up mid-keystroke. Waits silently for a natural micro-pause (`>= 3.5s` idle), auto-invalidates if you solve the bug yourself (**Micro-Win reset**), and backs off exponentially (`1x → 2x → 4x`) whenever dismissed.
- **Privacy-First & Hardened:** Raw keystrokes are never logged or transmitted. Sensitive files (`.env*`, keys, `.ssh`, `.aws`, DBs) are strictly blocked, and secrets are scrubbed before any code snippet leaves your machine.

---

## ⚡ How It Differs From Existing Tools

| Capability | Regex Frustration Checks | Proxy Stall Routers (LiteLLM / Advisor) | **BailoutMCP** |
| :--- | :---: | :---: | :---: |
| Detects frustration **before** you type an angry prompt | ❌ | ❌ | ✅ |
| Tracks native `Ctrl+Z` undo bursts & `A→B→A` edit oscillation | ❌ | ❌ | ✅ |
| Bridges **IDE behavioral signals** (VS Code/Cursor) with **CLI agents** (Claude Code) | ❌ | ❌ | ✅ |
| Silently **pre-solves** & validates exact surgical diff in background | ❌ | ❌ | ✅ |
| **Natural-pause timing gate** (never interrupts mid-typing) | ❌ | ❌ | ✅ |
| **Micro-Win reset** (auto-clears friction & discards stale bailout when errors drop to 0) | ❌ | ❌ | ✅ |
| Cross-provider heavy routing (Opus, Gemini Pro, o3, OpenRouter, Ollama, LiteLLM) | ❌ | Partial | ✅ |

---

## 🏗 Architecture

```mermaid
flowchart LR
    subgraph Sensors["100% Local Structural Sensors (No Keylogging)"]
        IDE["VS Code / Cursor Extension\n• Native Ctrl+Z Undo/Redo\n• Edit Churn & A→B→A Hash\n• Debounced LSP Diagnostics\n• Terminal Non-Zero Exits"]
        HOOKS["Claude Code Hooks & Watcher\n• PostToolUse Exec Errors\n• Prompt Retry Signals\n• File-Save Churn Watcher"]
    end

    subgraph Bridge["@bailout-mcp/server (127.0.0.1 Token Auth + Host/CSRF Guard)"]
        SSE["HTTP + SSE Shared Telemetry Bus"]
        MCP["Stdio MCP Server\n7 Tools • 3 Resources • 1 Prompt"]
    end

    subgraph Core["@bailout-mcp/core"]
        SS["Shadow-State Scorer (0–100)\n+ Micro-Win Reset"]
        DIST["Context Distiller (±45 lines)\n+ Workspace Jail + Secret Redactor"]
        ROUTER["Universal Bailout Router\nOpus • Gemini Pro • o3 • Ollama • LiteLLM"]
        PATCH["Patch Validator + Safety Guard\nExact Line Anchor + Atomic Write"]
        GATE["Anti-Annoyance Timing Gate\nWaits for Natural Micro-Pause"]
    end

    IDE -->|X-Bailout-Token| SSE
    HOOKS -->|X-Bailout-Token| SSE
    SSE --> SS
    MCP --> SS
    SS -->|score >= 70| DIST
    DIST --> ROUTER
    ROUTER --> PATCH
    PATCH --> GATE
    GATE -->|SSE Toast / Diff| IDE
    GATE -->|Hook / MCP Tool| MCP
```

### Monorepo Layout

| Package / Path | Purpose |
| :--- | :--- |
| [`packages/core`](packages/core) | Zero-dependency TypeScript core: Shadow-State scorer, error signature normalizer, secret redactor, security jail, context distiller, universal model router, surgical patcher, and pause timing gate |
| [`packages/mcp-server`](packages/mcp-server) | Stdio MCP server (`@modelcontextprotocol/sdk`), hardened `127.0.0.1` HTTP/SSE bridge daemon, CLI workspace churn watcher, `doctor`, `escalate`, `status`, and `init` commands |
| [`packages/vscode-extension`](packages/vscode-extension) | Thin VS Code / Cursor companion extension with calm Status Bar HUD, native side-by-side `vscode.diff` viewer, and `Ctrl+Z`-undoable 1-click `WorkspaceEdit` apply |
| [`hooks/claude-code`](hooks/claude-code) | Non-blocking `PostToolUse` & `UserPromptSubmit` hooks that stream agent loops and inject pre-solved heavy-model rescues directly into Claude Code |
| [`skills/bailout-detector`](skills/bailout-detector/SKILL.md) | Standard Agent Skill (`SKILL.md`) teaching coding agents how to report loops, check `bailout://shadow-state`, and surface rescues calmly |

---

## 🚀 Quick Start

### 1. Clone, Install, Build & Test

```bash
git clone https://github.com/Sunil56224972/BailoutMCP.git
cd BailoutMCP
pnpm install
pnpm run build
pnpm run test
```

### 2. Configure Your Real Heavy-Model Provider

Copy `.env.example` to `.env` (in your workspace root or `~/.bailout-mcp/.env`) and add **at least one** real provider:

```bash
cp .env.example .env
```

Example `.env` (Anthropic Opus primary, Gemini Pro fallback):

```dotenv
BAILOUT_PROVIDER=anthropic
BAILOUT_FALLBACK_PROVIDERS=gemini
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIza...
```

Verify provider readiness & security configuration:

```bash
pnpm run doctor
```

### 3. Connect BailoutMCP to Claude Code / Cursor / Windsurf / Antigravity

Generate your local `.bailout.json` and exact MCP JSON snippet:

```bash
node packages/mcp-server/dist/src/cli.js init
```

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "bailout": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/BailoutMCP/packages/mcp-server/dist/src/cli.js"],
      "env": {
        "BAILOUT_PROVIDER": "anthropic",
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

> When the MCP server starts, it automatically connects to an existing local bridge or starts one on `127.0.0.1:47821` (with ephemeral port fallback on collision) so VS Code, Cursor, and Claude Code hooks share the exact same live Shadow-State.

### 4. Enable the VS Code / Cursor Companion Extension (Optional)

1. Open `packages/vscode-extension` in VS Code or Cursor and press `F5` (or build a `.vsix` package).
2. It auto-discovers `~/.bailout-mcp/bridge.json` and shows a subtle Status Bar pill:
   - `Flow (0)` — calm coding (long dwell without errors never triggers false alarms)
   - `Shadow: 58/100` — elevated undo/error friction
   - `Bailout Solving (78)` — silently running heavy reasoning model in background
   - `Bailout Ready (94%)` — validated diff waiting cleanly for a natural pause or click

### 5. Enable Claude Code Hooks & Skill (Optional)

- Merge [`hooks/claude-code/settings.snippet.json`](hooks/claude-code/settings.snippet.json) into `~/.claude/settings.json`.
- Copy [`skills/bailout-detector/SKILL.md`](skills/bailout-detector/SKILL.md) into your agent skills directory.

### 6. CLI Mode (Zero IDE Extension Required)

```bash
# Run standalone local bridge daemon + file-save churn & oscillation watcher
node packages/mcp-server/dist/src/cli.js daemon --watch .

# Inspect live Shadow-State
node packages/mcp-server/dist/src/cli.js status

# Run an immediate secret-redacted heavy-model escalation on a stubborn file
node packages/mcp-server/dist/src/cli.js escalate ./src/buggyFile.ts --error "TypeError: ..."
```

---

## 🧠 Supported Heavy-Model Providers

| Provider (`BAILOUT_PROVIDER`) | Env / Config | Default Model | Notes |
| :--- | :--- | :--- | :--- |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-opus-4-6` | Native Messages API |
| `gemini` | `GEMINI_API_KEY` | `gemini-2.5-pro` | `x-goog-api-key` header + JSON schema mime output |
| `openai` | `OPENAI_API_KEY` | `o3` | Auto-detects `o1`/`o3`/`o4` (`max_completion_tokens`, omits `temperature`) |
| `openrouter` | `OPENROUTER_API_KEY` | `anthropic/claude-opus-4.6` | Unified multi-model routing |
| `ollama` | `BAILOUT_OLLAMA_URL`, `BAILOUT_OLLAMA_MODEL` | `qwen2.5-coder:32b` | 100% local offline real reasoning LLM |
| `custom` | `BAILOUT_ROUTER_URL`, `BAILOUT_ROUTER_MODEL` | *(your router)* | Works with LiteLLM / custom proxies; sends `X-Bailout-Trigger: shadow-state`, `X-Bailout-Frustration-Score`, `X-Bailout-Original-Model` |

Set `BAILOUT_FALLBACK_PROVIDERS=gemini,openrouter` to enable automatic failover across providers.

---

## 🛠 MCP Tools, Resources & Prompts

### Tools
| Tool | Description |
| :--- | :--- |
| `get_shadow_state` | Live frustration score (`0–100`), phase, provider readiness, primary hotspot, signal breakdown, timing gate status, and stats |
| `record_signal` | Ingest `undo_burst`, `edit_churn`, `file_dwell`, `diagnostic_error`, `terminal_error`, `agent_tool_error`, `prompt_abandoned`, or `error_resolved` |
| `get_pending_bailout` | Retrieve silently pre-solved heavy-model fix, root cause, confidence, and unified diff |
| `trigger_bailout` | Explicitly distill a redacted dossier and escalate a workspace file to the configured heavy model |
| `accept_bailout` | Accept proposal (optionally applying the validated surgical patch atomically to disk) and clear friction |
| `dismiss_bailout` | Dismiss pending fix and apply exponential cooldown backoff (`1x → 2x → 4x`) |
| `configure_bailout_router` | Safely tune runtime thresholds or switch between already-configured providers (never exposes/mutates keys or URLs) |

### Resources & Prompts
- `bailout://shadow-state` — Real-time Shadow-State snapshot JSON
- `bailout://pending-bailout` — Pre-solved heavy-model bailout proposal + unified diff
- `bailout://last-dossier` — Exact secret-redacted context window sent to the heavy model (full transparency)
- `present-bailout` — Prompt template for calm, 2-sentence + diff presentation

---

## 🔒 Security & Privacy Model

BailoutMCP is engineered for real professional codebases from day one:

| Threat Vector | Defense Implemented |
| :--- | :--- |
| **Keystroke Spyware Concerns** | Raw keystrokes are **never** recorded or sent. The VS Code companion reads only structural events (`TextDocumentChangeReason.Undo/Redo`, line ranges, non-reversible SHA-256 region hashes, debounced diagnostics, exit codes). |
| **Credential / Secret Leakage** | Sensitive files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.ssh/*`, `.aws/*`, `.npmrc`, `credentials.json`, `bridge.json`, `*.sqlite`, OS system dirs) are strictly blocked. An automated redactor scrubs API keys (Anthropic, OpenAI, Google, OpenRouter, Stripe, GitHub, Slack, SendGrid, HF, npm, AWS), JWTs, Basic/Bearer auth, PEM blocks, and DB URI passwords before egress. |
| **Path Traversal & Symlink Escape** | Symlink-resolved `assertSafeWorkspacePath` enforces workspace boundaries on both dossier reads and atomic disk writes. |
| **Localhost DNS Rebinding & CSRF** | Bridge binds strictly to `127.0.0.1`, verifies a 48-hex-char random token (`0600`) using `crypto.timingSafeEqual` in `X-Bailout-Token` header only (URL query tokens rejected), validates strict `Host` headers (`403`), and rejects browser `Origin` headers (`403`). |
| **SSRF & Runtime Hijacking** | `validateEndpointUrl` blocks AWS/GCP metadata IPs (`169.254.169.254`, `metadata.google.internal`), RFC1918 private IPs, `0.0.0.0`, IPv6 link-local/ULA, embedded URL credentials, `file://`, and non-loopback plaintext `http://`. MCP/HTTP config calls cannot mutate API keys, `baseUrl`, or `allowedWorkspaceRoots`. |
| **Prompt Injection in Untrusted Repos** | Untrusted workspace code and logs are isolated inside per-request random nonce delimiters (`<UNTRUSTED_CODE_nonce>`). `validatePatchSafety` rejects oversized rewrites (`> 35` lines) and newly-introduced dangerous primitives (`eval()`, `new Function()`, `child_process`, `fs.rmSync`, remote `import()`, piped shell downloads, encoded PowerShell). |
| **Runaway API Spend** | Single-flight solve lock, `AbortSignal.timeout(45s)`, minimum confidence filter (`>= 0.72`), hard hourly (`6/hr`) & daily (`25/day`) caps, and per-file cooldowns. |

---

## 📄 License

Released under the [MIT License](LICENSE).
