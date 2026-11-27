export type SignalKind =
  | 'undo_burst'
  | 'edit_churn'
  | 'file_dwell'
  | 'diagnostic_error'
  | 'terminal_error'
  | 'agent_tool_error'
  | 'prompt_abandoned'
  | 'keystroke_activity'
  | 'file_focus'
  | 'error_resolved';

export type SignalSource =
  | 'vscode-extension'
  | 'mcp-client'
  | 'claude-hook'
  | 'file-watcher'
  | 'cli'
  | 'unknown';

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface TelemetrySignal {
  kind: SignalKind;
  timestamp?: number;
  source?: SignalSource;
  filePath?: string;
  lineRange?: LineRange;
  /** Raw diagnostic, terminal stderr, or tool error message */
  message?: string;
  /** Optional diagnostic code or tool name */
  code?: string;
  /** Non-zero exit code for terminal errors */
  exitCode?: number;
  /** Number of events in a burst (e.g., undo count or rapid deletions) */
  count?: number;
  /** Dwell duration increment in milliseconds */
  durationMs?: number;
  /** Non-reversible hash of the edited region to detect A->B->A edit oscillation */
  regionHash?: string;
  /** Current lightweight model name when known (e.g., claude-sonnet-4) */
  agentModel?: string;
  /** Optional short summary of what the agent/user just tried */
  attemptedFix?: string;
  /** Optional workspace root path */
  workspaceRoot?: string;
  /** Optional extra non-sensitive structured metadata */
  metadata?: Record<string, string | number | boolean>;
}

export type ShadowPhase =
  | 'FLOW'
  | 'FRICTION'
  | 'STUCK'
  | 'BAILOUT_SOLVING'
  | 'BAILOUT_READY'
  | 'COOLDOWN';

export interface SignalBreakdown {
  undoBurst: number;
  editChurn: number;
  fileDwell: number;
  recurringErrors: number;
  agentLoop: number;
  promptHesitation: number;
}

export interface RecurringErrorSummary {
  fingerprint: string;
  normalized: string;
  latestRaw: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  code?: string;
}

export interface FileHotspot {
  filePath: string;
  score: number;
  breakdown: SignalBreakdown;
  reasons: string[];
  hotspotRange?: LineRange;
  dwellMs: number;
  undoCount: number;
  churnCount: number;
  oscillationCount: number;
  recurringErrors: RecurringErrorSummary[];
  attemptedFixes: string[];
  activeAgentModel?: string;
  lastActivityAt: number;
  cooldownUntil: number;
}

export interface TimingGateStatus {
  canSurfaceNow: boolean;
  idleMs: number;
  pauseGateMs: number;
  editsInLast5s: number;
  reason: string;
}

export interface EngineStats {
  signalsProcessed: number;
  bailoutsTriggered: number;
  bailoutsReady: number;
  bailoutsAccepted: number;
  bailoutsDismissed: number;
  bailoutsRejectedUnsafe: number;
  bailoutsFailed: number;
  selfResolvedCount: number;
  microWinsDetected: number;
  bailoutsThisHour: number;
  bailoutsToday: number;
}

export interface BailoutPatch {
  filePath: string;
  startLine: number;
  endLine: number;
  originalCode: string;
  fixedCode: string;
  unifiedDiff: string;
  linesChanged: number;
}

export type BailoutStatus =
  | 'ready'
  | 'surfaced'
  | 'accepted'
  | 'dismissed'
  | 'stale'
  | 'self_resolved';

export interface BailoutProposal {
  id: string;
  createdAt: number;
  filePath: string;
  fileContentHash: string;
  provider: BailoutProviderKind;
  model: string;
  frustrationScore: number;
  triggerReasons: string[];
  rootCause: string;
  summary: string;
  explanation: string;
  whyPreviousAttemptsFailed: string;
  confidence: number;
  patch: BailoutPatch;
  status: BailoutStatus;
  offerMessage: string;
  latencyMs: number;
}

export interface ShadowStateSnapshot {
  timestamp: number;
  phase: ShadowPhase;
  score: number;
  routerReady: boolean;
  activeProvider: BailoutProviderKind;
  activeModel: string;
  routerNotice?: string;
  lastError?: string;
  activeFile?: string;
  primaryHotspot?: FileHotspot;
  hotspots: FileHotspot[];
  timingGate: TimingGateStatus;
  pendingBailout?: BailoutProposal;
  stats: EngineStats;
}

export interface BailoutDossier {
  filePath: string;
  relativePath: string;
  language: string;
  frustrationScore: number;
  triggerReasons: string[];
  hotspotRange: LineRange;
  /** Optional redacted top-of-file imports / type declarations when code window starts below line 1 */
  topOfFileContext?: string;
  numberedCodeWindow: string;
  rawCodeWindow: string;
  windowStartLine: number;
  windowEndLine: number;
  fileContentHash: string;
  recurringErrors: Array<{
    count: number;
    normalized: string;
    latestRaw: string;
    code?: string;
  }>;
  attemptedFixes: string[];
  lightweightModel?: string;
  dwellMinutes: number;
  undoCount: number;
  oscillationCount: number;
  redactedSecretsCount: number;
}

/**
 * Strictly real LLM / router providers — zero fake or hardcoded mock analyzers.
 */
export type BailoutProviderKind =
  | 'anthropic'
  | 'gemini'
  | 'openai'
  | 'openrouter'
  | 'ollama'
  | 'custom';

export interface ProviderCredentials {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
}

export interface BailoutConfig {
  /** Primary heavy reasoning provider for silent bailout */
  provider: BailoutProviderKind;
  /** Optional ordered fallback providers if primary fails */
  fallbackProviders: BailoutProviderKind[];
  providers: {
    anthropic: ProviderCredentials;
    gemini: ProviderCredentials;
    openai: ProviderCredentials;
    openrouter: ProviderCredentials;
    ollama: ProviderCredentials;
    custom: ProviderCredentials;
  };
  /** Score (0-100) at which silent background bailout triggers */
  stuckThreshold: number;
  /** Score (0-100) at which phase becomes FRICTION */
  frictionThreshold: number;
  /** Half-life for time-decaying frustration signals (ms) */
  decayHalfLifeMs: number;
  /** Minimum idle pause before surfacing a ready bailout (ms) */
  pauseGateMs: number;
  /** Maximum idle window after friction where auto-toast still feels relevant (ms) */
  maxAutoSurfaceIdleMs: number;
  /** Per-file cooldown after a bailout (ms) */
  cooldownMs: number;
  /** Minimum model self-reported confidence (0-1) required to surface fix */
  minConfidence: number;
  /** Safety budget limits */
  maxBailoutsPerHour: number;
  maxBailoutsPerDay: number;
  /** Maximum lines a surgical bailout patch is allowed to replace */
  maxPatchLines: number;
  /** Maximum target file size in bytes (guards against huge/minified/binary files) */
  maxFileSizeBytes: number;
  /** Timeout for outbound heavy-model HTTP requests (ms) */
  solveTimeoutMs: number;
  /** Lines of context above and below hotspot */
  contextWindowRadius: number;
  /** Scrub API keys/tokens before sending dossier to external provider */
  redactSecrets: boolean;
  /** Local IPC bridge port */
  bridgePort: number;
  /** Enable automatic background solving when stuckThreshold is crossed */
  autoSolve: boolean;
  /** Optional workspace root */
  workspaceRoot?: string;
  /** Allowed workspace roots for strict path-traversal protection */
  allowedWorkspaceRoots: string[];
  /** True when allowedWorkspaceRoots was explicitly pinned via env, config file, or constructor */
  explicitRootsLocked?: boolean;
}

export interface RawModelBailoutResponse {
  rootCause: string;
  summary: string;
  explanation: string;
  whyPreviousAttemptsFailed: string;
  confidence: number;
  patch: {
    startLine: number;
    endLine: number;
    originalCode: string;
    fixedCode: string;
  };
}

export interface MicroWinEvent {
  filePath: string;
  timestamp: number;
  previousScore: number;
  resolvedErrorCount: number;
  dwellMs: number;
  message: string;
}
