import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  BailoutEngine,
  pickSafeConfigUpdate,
  sanitizeConfigForDisplay,
  type BailoutConfig,
  type BailoutDossier,
  type BailoutProposal,
  type ManualBailoutOptions,
  type ShadowStateSnapshot,
  type TelemetrySignal,
} from '@bailout-mcp/core';
import { BridgeClient } from './bridge-client.js';
import { LocalBridgeServer } from './bridge-server.js';

export interface BailoutBackend {
  getState(): Promise<ShadowStateSnapshot>;
  recordSignal(signal: TelemetrySignal, fileContentOverride?: string): Promise<ShadowStateSnapshot>;
  getPendingBailout(includeGated?: boolean): Promise<BailoutProposal | null>;
  triggerBailout(options?: ManualBailoutOptions): Promise<BailoutProposal>;
  acceptBailout(
    id: string,
    applyToDisk?: boolean,
  ): Promise<{ proposal: BailoutProposal; appliedToDisk: boolean; applyError?: string }>;
  dismissBailout(id?: string): Promise<BailoutProposal | null>;
  getLastDossier(): Promise<BailoutDossier | null>;
  previewDossier(filePath?: string): Promise<BailoutDossier>;
  resetState(filePath?: string): Promise<ShadowStateSnapshot>;
  updateConfig(partial: Partial<BailoutConfig>): Promise<Record<string, unknown>>;
}

class EmbeddedBackend implements BailoutBackend {
  constructor(private readonly engine: BailoutEngine) {}

  async getState(): Promise<ShadowStateSnapshot> {
    return this.engine.getSnapshot();
  }
  async recordSignal(
    signal: TelemetrySignal,
    fileContentOverride?: string,
  ): Promise<ShadowStateSnapshot> {
    return this.engine.ingest(signal, fileContentOverride);
  }
  async getPendingBailout(includeGated = true): Promise<BailoutProposal | null> {
    return this.engine.getPendingBailout(includeGated) ?? null;
  }
  async triggerBailout(options?: ManualBailoutOptions): Promise<BailoutProposal> {
    return this.engine.triggerBailout(options);
  }
  async acceptBailout(id: string, applyToDisk = false) {
    return this.engine.acceptBailout(id, applyToDisk);
  }
  async dismissBailout(id?: string): Promise<BailoutProposal | null> {
    return this.engine.dismissBailout(id) ?? null;
  }
  async getLastDossier(): Promise<BailoutDossier | null> {
    return this.engine.getLastDossier() ?? null;
  }
  async previewDossier(filePath?: string): Promise<BailoutDossier> {
    return this.engine.previewDossier(filePath);
  }
  async resetState(filePath?: string): Promise<ShadowStateSnapshot> {
    return this.engine.resetState(filePath);
  }
  async updateConfig(partial: Partial<BailoutConfig>): Promise<Record<string, unknown>> {
    const safe = pickSafeConfigUpdate(partial as Record<string, unknown>);
    return sanitizeConfigForDisplay(this.engine.updateConfig(safe));
  }
}

function mcpError(err: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          { error: err instanceof Error ? err.message : String(err) },
          null,
          2,
        ),
      },
    ],
  };
}

export function createBailoutMcpServer(backend: BailoutBackend): McpServer {
  const server = new McpServer({
    name: 'bailout-mcp',
    version: '0.1.0',
  });

  // 1. Tool: get_shadow_state
  server.tool(
    'get_shadow_state',
    'Get the real local Shadow-State frustration score (0-100), phase (FLOW/FRICTION/STUCK/BAILOUT_READY), provider readiness, hotspot file, signal breakdown, timing gate status, and any pre-solved heavy-model bailout.',
    {},
    async () => {
      try {
        const state = await backend.getState();
        return {
          content: [{ type: 'text', text: JSON.stringify(state, null, 2) }],
        };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  // 2. Tool: record_signal
  server.tool(
    'record_signal',
    'Record a real local behavioral or error telemetry signal (undo_burst, edit_churn, file_dwell, diagnostic_error, terminal_error, agent_tool_error, prompt_abandoned, error_resolved) into Shadow-State. Triggers silent heavy-model bailout when stuckThreshold is crossed and a real model provider is configured.',
    {
      kind: z.enum([
        'undo_burst',
        'edit_churn',
        'file_dwell',
        'diagnostic_error',
        'terminal_error',
        'agent_tool_error',
        'prompt_abandoned',
        'keystroke_activity',
        'file_focus',
        'error_resolved',
      ]),
      filePath: z.string().optional().describe('Absolute path to the file being worked on'),
      workspaceRoot: z
        .string()
        .optional()
        .describe('Workspace root directory used to infer source file paths from stack traces'),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
      message: z.string().optional().describe('Error text, stderr snippet, or hesitation context'),
      code: z.string().optional().describe('Diagnostic error code or failing tool name'),
      exitCode: z.number().int().optional(),
      count: z.number().int().positive().optional(),
      durationMs: z.number().nonnegative().optional(),
      regionHash: z.string().optional(),
      agentModel: z.string().optional().describe('Currently active lightweight model'),
      attemptedFix: z.string().optional().describe('Short summary of what was just tried'),
    },
    async (args) => {
      try {
        const signal: TelemetrySignal = {
          kind: args.kind,
          source: 'mcp-client',
          filePath: args.filePath,
          workspaceRoot: args.workspaceRoot,
          lineRange:
            args.startLine !== undefined
              ? { startLine: args.startLine, endLine: args.endLine ?? args.startLine }
              : undefined,
          message: args.message,
          code: args.code,
          exitCode: args.exitCode,
          count: args.count,
          durationMs: args.durationMs,
          regionHash: args.regionHash,
          agentModel: args.agentModel,
          attemptedFix: args.attemptedFix,
        };
        const snapshot = await backend.recordSignal(signal);
        return {
          content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }],
        };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  // 3. Tool: get_pending_bailout
  server.tool(
    'get_pending_bailout',
    'Fetch the silently pre-solved heavy-model bailout proposal (root cause, confidence, exact surgical unified diff, and offer message) if ready.',
    {
      includeGated: z
        .boolean()
        .optional()
        .default(true)
        .describe('When false, returns null while user is mid-typing inside the pause gate'),
    },
    async ({ includeGated }) => {
      try {
        const proposal = await backend.getPendingBailout(includeGated);
        if (!proposal) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ ready: false, proposal: null }, null, 2),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ready: true, proposal }, null, 2),
            },
          ],
        };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  // 4. Tool: trigger_bailout
  server.tool(
    'trigger_bailout',
    'Distill a secret-redacted minimal dossier for a workspace file and escalate to the configured real heavy reasoning model (Anthropic Opus, Gemini Pro, OpenAI, OpenRouter, local Ollama, or custom LiteLLM router) for a validated surgical patch.',
    {
      filePath: z.string().optional().describe('Target workspace file path (defaults to current hotspot)'),
      errorMessage: z.string().optional().describe('Optional latest compiler/test/runtime error message'),
      attemptedFix: z.string().optional().describe('Optional summary of prior failed fix attempts'),
      startLine: z.number().int().positive().optional().describe('Optional 1-indexed hotspot start line'),
      endLine: z.number().int().positive().optional().describe('Optional 1-indexed hotspot end line'),
      force: z.boolean().optional().default(false).describe('Bypass hourly/daily rate cap'),
    },
    async ({ filePath, errorMessage, attemptedFix, startLine, endLine, force }) => {
      try {
        const proposal = await backend.triggerBailout({
          filePath,
          errorMessage,
          attemptedFix,
          startLine,
          endLine,
          force,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(proposal, null, 2) }],
        };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  // 5. Tool: accept_bailout
  server.tool(
    'accept_bailout',
    'Accept a pending bailout proposal (optionally writing the validated surgical patch atomically to disk within workspace security boundaries) and reset frustration debt.',
    {
      id: z.string().describe('Bailout proposal ID'),
      applyToDisk: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, verifies workspace bounds + snippet integrity and writes atomically'),
    },
    async ({ id, applyToDisk }) => {
      try {
        const result = await backend.acceptBailout(id, applyToDisk);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  // 6. Tool: dismiss_bailout
  server.tool(
    'dismiss_bailout',
    'Dismiss the pending bailout proposal and apply exponential anti-annoyance cooldown backoff for that file.',
    {
      id: z.string().optional().describe('Optional bailout proposal ID'),
    },
    async ({ id }) => {
      try {
        const dismissed = await backend.dismissBailout(id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ dismissed }, null, 2) }],
        };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  // 7. Tool: configure_bailout_router (strictly non-secret tuning only; never exposes/mutates API keys or URLs)
  server.tool(
    'configure_bailout_router',
    'Update non-sensitive runtime BailoutMCP thresholds or switch between already-configured real providers (anthropic, gemini, openai, openrouter, ollama, custom). API keys and URLs must be set via local env or config file.',
    {
      provider: z
        .enum(['anthropic', 'gemini', 'openai', 'openrouter', 'ollama', 'custom'])
        .optional(),
      stuckThreshold: z.number().min(20).max(100).optional(),
      frictionThreshold: z.number().min(10).max(95).optional(),
      pauseGateMs: z.number().min(500).max(30_000).optional(),
      cooldownMs: z.number().min(10_000).max(3_600_000).optional(),
      minConfidence: z.number().min(0.3).max(0.99).optional(),
      autoSolve: z.boolean().optional(),
    },
    async (args) => {
      try {
        const updated = await backend.updateConfig(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
        };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  // 8. Tool: preview_dossier (100% local, works even when routerReady === false)
  server.tool(
    'preview_dossier',
    'Distill and inspect the secret-redacted local BailoutDossier (hotspot score, normalized recurring error fingerprints, top-of-file imports, numbered code window, and attempted fixes) 100% locally with zero external API calls. Ideal when routerReady is false or before triggering escalation.',
    {
      filePath: z.string().optional().describe('Target workspace file path (defaults to current hotspot)'),
    },
    async ({ filePath }) => {
      try {
        const dossier = await backend.previewDossier(filePath);
        return {
          content: [{ type: 'text', text: JSON.stringify(dossier, null, 2) }],
        };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  // 9. Tool: reset_shadow_state
  server.tool(
    'reset_shadow_state',
    'Clear Shadow-State frustration debt and stale bailout proposals for a specific file or for the entire workspace session when switching tasks.',
    {
      filePath: z
        .string()
        .optional()
        .describe('Optional file path to reset; omit to reset the entire workspace session'),
    },
    async ({ filePath }) => {
      try {
        const snapshot = await backend.resetState(filePath);
        return {
          content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }],
        };
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  // Resources
  server.resource(
    'shadow-state',
    'bailout://shadow-state',
    { description: 'Live local Shadow-State frustration snapshot & hotspots' },
    async () => ({
      contents: [
        {
          uri: 'bailout://shadow-state',
          mimeType: 'application/json',
          text: JSON.stringify(await backend.getState(), null, 2),
        },
      ],
    }),
  );

  server.resource(
    'pending-bailout',
    'bailout://pending-bailout',
    { description: 'Currently pre-solved heavy-model bailout proposal and surgical diff' },
    async () => ({
      contents: [
        {
          uri: 'bailout://pending-bailout',
          mimeType: 'application/json',
          text: JSON.stringify(await backend.getPendingBailout(true), null, 2),
        },
      ],
    }),
  );

  server.resource(
    'last-dossier',
    'bailout://last-dossier',
    { description: 'Last secret-redacted minimal context dossier sent to the heavy model' },
    async () => ({
      contents: [
        {
          uri: 'bailout://last-dossier',
          mimeType: 'application/json',
          text: JSON.stringify(await backend.getLastDossier(), null, 2),
        },
      ],
    }),
  );

  server.prompt(
    'present-bailout',
    'Format a ready BailoutMCP heavy-model fix into a calm, ultra-concise developer offer.',
    {},
    async () => {
      const proposal = await backend.getPendingBailout(true);
      if (!proposal) {
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: 'No bailout proposal is currently pending. Stay silent and do not interrupt the user.',
              },
            },
          ],
        };
      }
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'Present this silently pre-solved heavy-model bailout in 2 concise sentences + the unified diff, and ask if the developer wants to apply it:',
                `Offer: ${proposal.offerMessage}`,
                `Root Cause: ${proposal.rootCause}`,
                proposal.whyPreviousAttemptsFailed
                  ? `Why Previous Attempts Looped: ${proposal.whyPreviousAttemptsFailed}`
                  : '',
                'Diff:',
                '```diff',
                proposal.patch.unifiedDiff,
                '```',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          },
        ],
      };
    },
  );

  return server;
}

export interface StartMcpRuntimeResult {
  server: McpServer;
  bridge?: LocalBridgeServer;
  mode: 'shared-bridge' | 'embedded-bridge';
}

export async function startStdioMcpServer(
  configOverrides?: Partial<BailoutConfig>,
): Promise<StartMcpRuntimeResult> {
  const existingBridge = await BridgeClient.discover();
  let backend: BailoutBackend;
  let bridge: LocalBridgeServer | undefined;
  let mode: 'shared-bridge' | 'embedded-bridge' = 'shared-bridge';

  if (existingBridge) {
    backend = existingBridge;
  } else {
    const engine = new BailoutEngine(configOverrides);
    backend = new EmbeddedBackend(engine);
    mode = 'embedded-bridge';

    bridge = new LocalBridgeServer(engine);
    try {
      await bridge.start();
    } catch {
      bridge = undefined;
    }
  }

  const server = createBailoutMcpServer(backend);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return { server, bridge, mode };
}
