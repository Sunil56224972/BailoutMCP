import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BailoutConfig, BailoutProviderKind, ProviderCredentials } from './types.js';

export const DEFAULT_CONFIG: BailoutConfig = {
  provider: 'anthropic',
  fallbackProviders: [],
  providers: {
    anthropic: {
      model: 'claude-opus-4-6',
      baseUrl: 'https://api.anthropic.com/v1/messages',
    },
    gemini: {
      model: 'gemini-2.5-pro',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    },
    openai: {
      model: 'o3',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
    },
    openrouter: {
      model: 'anthropic/claude-opus-4.6',
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    },
    ollama: {
      model: 'qwen2.5-coder:32b',
      baseUrl: 'http://127.0.0.1:11434/api/chat',
    },
    custom: {
      model: '',
      baseUrl: '',
    },
  },
  stuckThreshold: 70,
  frictionThreshold: 35,
  decayHalfLifeMs: 8 * 60 * 1000,
  pauseGateMs: 3500,
  maxAutoSurfaceIdleMs: 90_000,
  cooldownMs: 5 * 60 * 1000,
  minConfidence: 0.72,
  maxBailoutsPerHour: 6,
  maxBailoutsPerDay: 25,
  maxPatchLines: 35,
  maxFileSizeBytes: 512 * 1024,
  solveTimeoutMs: 45_000,
  contextWindowRadius: 45,
  redactSecrets: true,
  bridgePort: 47821,
  autoSolve: true,
  allowedWorkspaceRoots: [],
};

const VALID_PROVIDERS: ReadonlySet<string> = new Set<BailoutProviderKind>([
  'anthropic',
  'gemini',
  'openai',
  'openrouter',
  'ollama',
  'custom',
]);

export function getGlobalConfigDir(): string {
  if (process.env.BAILOUT_HOME && process.env.BAILOUT_HOME.trim()) {
    return path.resolve(process.env.BAILOUT_HOME.trim());
  }
  return path.join(os.homedir(), '.bailout-mcp');
}

function safeReadJson(filePath: string): Partial<BailoutConfig> | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BailoutConfig>;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lightweight zero-dependency .env parser so users can configure `.env` in their
 * workspace or `~/.bailout-mcp/.env` without manual shell exports.
 */
function loadDotEnvFiles(paths: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const filePath of paths) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
        const eqIdx = cleaned.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = cleaned.slice(0, eqIdx).trim();
        let val = cleaned.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        } else {
          // Strip unquoted inline comments (e.g. `BAILOUT_STUCK_THRESHOLD=70 # default`)
          val = val.replace(/\s+#.*$/, '').trim();
        }
        if (key && val !== '') {
          vars[key] = val;
        }
      }
    } catch {
      // Ignore unreadable .env
    }
  }
  return vars;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

function mergeProviderCreds(
  base: ProviderCredentials,
  override?: Partial<ProviderCredentials>,
): ProviderCredentials {
  if (!override) return { ...base };
  return { ...base, ...stripUndefined(override) };
}

function deepMergeConfig(base: BailoutConfig, override?: Partial<BailoutConfig>): BailoutConfig {
  if (!override) return structuredClone(base);
  const cleanOverride = stripUndefined(override);
  const merged: BailoutConfig = {
    ...structuredClone(base),
    ...cleanOverride,
    providers: {
      anthropic: mergeProviderCreds(base.providers.anthropic, override.providers?.anthropic),
      gemini: mergeProviderCreds(base.providers.gemini, override.providers?.gemini),
      openai: mergeProviderCreds(base.providers.openai, override.providers?.openai),
      openrouter: mergeProviderCreds(base.providers.openrouter, override.providers?.openrouter),
      ollama: mergeProviderCreds(base.providers.ollama, override.providers?.ollama),
      custom: mergeProviderCreds(base.providers.custom, override.providers?.custom),
    },
  };
  if (override.fallbackProviders !== undefined) {
    merged.fallbackProviders = [...override.fallbackProviders];
  }
  if (override.allowedWorkspaceRoots !== undefined) {
    merged.allowedWorkspaceRoots = [...override.allowedWorkspaceRoots];
  }
  return merged;
}

export function isProviderConfigured(
  provider: BailoutProviderKind,
  config: BailoutConfig,
): boolean {
  const creds = config.providers[provider];
  if (!creds || !creds.model || !creds.model.trim()) return false;
  switch (provider) {
    case 'anthropic':
    case 'gemini':
    case 'openai':
    case 'openrouter':
      return Boolean(creds.apiKey && creds.apiKey.trim().length > 0);
    case 'custom':
      return Boolean(creds.baseUrl && creds.baseUrl.trim().length > 0);
    case 'ollama':
      // Ollama is considered configured when actively selected or explicitly set via env/config
      return (
        (config.provider === 'ollama' ||
          config.fallbackProviders.includes('ollama') ||
          Boolean(process.env.BAILOUT_OLLAMA_MODEL || process.env.BAILOUT_OLLAMA_URL)) &&
        Boolean(creds.baseUrl && creds.baseUrl.trim().length > 0)
      );
  }
}

export function getRouterReadiness(config: BailoutConfig): {
  ready: boolean;
  notice?: string;
} {
  const chain: BailoutProviderKind[] = [
    config.provider,
    ...config.fallbackProviders.filter((p) => p !== config.provider),
  ];

  const anyReady = chain.some((p) => isProviderConfigured(p, config));
  if (anyReady) {
    return { ready: true };
  }

  return {
    ready: false,
    notice:
      `Provider "${config.provider}" is not configured. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, BAILOUT_ROUTER_URL + BAILOUT_ROUTER_MODEL, or BAILOUT_PROVIDER=ollama for local LLM bailouts.`,
  };
}

function parseProvider(value: string | undefined): BailoutProviderKind | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (VALID_PROVIDERS.has(normalized)) {
    return normalized as BailoutProviderKind;
  }
  return undefined;
}

export function loadConfig(
  overrides?: Partial<BailoutConfig>,
  workspaceRoot?: string,
): BailoutConfig {
  let config = structuredClone(DEFAULT_CONFIG);

  const globalDir = getGlobalConfigDir();
  const globalCfg = safeReadJson(path.join(globalDir, 'config.json'));
  config = deepMergeConfig(config, globalCfg);

  const root = path.resolve(workspaceRoot ?? overrides?.workspaceRoot ?? process.cwd());
  const projectCfg = safeReadJson(path.join(root, '.bailout.json'));
  config = deepMergeConfig(config, projectCfg);
  config.workspaceRoot = root;

  // Read .env files (process.env always takes precedence over .env files)
  const dotEnvVars = loadDotEnvFiles([
    path.join(globalDir, '.env'),
    path.join(root, '.env'),
  ]);
  const getEnv = (name: string): string | undefined => process.env[name] ?? dotEnvVars[name];
  const getNumEnv = (name: string): number | undefined => {
    const raw = getEnv(name);
    if (!raw) return undefined;
    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
  };

  const envProvider = parseProvider(getEnv('BAILOUT_PROVIDER'));
  if (envProvider) config.provider = envProvider;

  const fallbackRaw = getEnv('BAILOUT_FALLBACK_PROVIDERS');
  if (fallbackRaw) {
    config.fallbackProviders = fallbackRaw
      .split(',')
      .map((s) => parseProvider(s))
      .filter((p): p is BailoutProviderKind => Boolean(p));
  }

  if (getEnv('ANTHROPIC_API_KEY')) {
    config.providers.anthropic.apiKey = getEnv('ANTHROPIC_API_KEY');
  }
  if (getEnv('BAILOUT_ANTHROPIC_MODEL')) {
    config.providers.anthropic.model = getEnv('BAILOUT_ANTHROPIC_MODEL')!;
  }

  if (getEnv('GEMINI_API_KEY') || getEnv('GOOGLE_API_KEY')) {
    config.providers.gemini.apiKey = getEnv('GEMINI_API_KEY') ?? getEnv('GOOGLE_API_KEY');
  }
  if (getEnv('BAILOUT_GEMINI_MODEL')) {
    config.providers.gemini.model = getEnv('BAILOUT_GEMINI_MODEL')!;
  }

  if (getEnv('OPENAI_API_KEY')) {
    config.providers.openai.apiKey = getEnv('OPENAI_API_KEY');
  }
  if (getEnv('BAILOUT_OPENAI_MODEL')) {
    config.providers.openai.model = getEnv('BAILOUT_OPENAI_MODEL')!;
  }

  if (getEnv('OPENROUTER_API_KEY')) {
    config.providers.openrouter.apiKey = getEnv('OPENROUTER_API_KEY');
  }
  if (getEnv('BAILOUT_OPENROUTER_MODEL')) {
    config.providers.openrouter.model = getEnv('BAILOUT_OPENROUTER_MODEL')!;
  }

  if (getEnv('BAILOUT_OLLAMA_URL')) {
    config.providers.ollama.baseUrl = getEnv('BAILOUT_OLLAMA_URL');
  }
  if (getEnv('BAILOUT_OLLAMA_MODEL')) {
    config.providers.ollama.model = getEnv('BAILOUT_OLLAMA_MODEL')!;
  }

  if (getEnv('BAILOUT_ROUTER_URL')) {
    config.providers.custom.baseUrl = getEnv('BAILOUT_ROUTER_URL');
  }
  if (getEnv('BAILOUT_ROUTER_API_KEY')) {
    config.providers.custom.apiKey = getEnv('BAILOUT_ROUTER_API_KEY');
  }
  if (getEnv('BAILOUT_ROUTER_MODEL')) {
    config.providers.custom.model = getEnv('BAILOUT_ROUTER_MODEL')!;
  }

  // Auto-select the first genuinely configured real provider when none was pinned
  const providerExplicitlyPinned = Boolean(
    envProvider || globalCfg?.provider || projectCfg?.provider || overrides?.provider,
  );
  if (!providerExplicitlyPinned) {
    if (isProviderConfigured('custom', config)) {
      config.provider = 'custom';
    } else if (isProviderConfigured('anthropic', config)) {
      config.provider = 'anthropic';
    } else if (isProviderConfigured('gemini', config)) {
      config.provider = 'gemini';
    } else if (isProviderConfigured('openrouter', config)) {
      config.provider = 'openrouter';
    } else if (isProviderConfigured('openai', config)) {
      config.provider = 'openai';
    } else if (getEnv('BAILOUT_OLLAMA_MODEL') || getEnv('BAILOUT_OLLAMA_URL')) {
      config.provider = 'ollama';
    }
  }

  const stuckThreshold = getNumEnv('BAILOUT_STUCK_THRESHOLD');
  if (stuckThreshold !== undefined) config.stuckThreshold = stuckThreshold;

  const frictionThreshold = getNumEnv('BAILOUT_FRICTION_THRESHOLD');
  if (frictionThreshold !== undefined) config.frictionThreshold = frictionThreshold;

  const pauseGateMs = getNumEnv('BAILOUT_PAUSE_GATE_MS');
  if (pauseGateMs !== undefined) config.pauseGateMs = pauseGateMs;

  const cooldownMs = getNumEnv('BAILOUT_COOLDOWN_MS');
  if (cooldownMs !== undefined) config.cooldownMs = cooldownMs;

  const minConfidence = getNumEnv('BAILOUT_MIN_CONFIDENCE');
  if (minConfidence !== undefined) config.minConfidence = minConfidence;

  const maxPerHour = getNumEnv('BAILOUT_MAX_PER_HOUR');
  if (maxPerHour !== undefined) config.maxBailoutsPerHour = maxPerHour;

  const maxPatchLines = getNumEnv('BAILOUT_MAX_PATCH_LINES');
  if (maxPatchLines !== undefined) config.maxPatchLines = maxPatchLines;

  const solveTimeoutMs = getNumEnv('BAILOUT_SOLVE_TIMEOUT_MS');
  if (solveTimeoutMs !== undefined) config.solveTimeoutMs = solveTimeoutMs;

  const bridgePort = getNumEnv('BAILOUT_BRIDGE_PORT');
  if (bridgePort !== undefined) config.bridgePort = bridgePort;

  if (getEnv('BAILOUT_AUTO_SOLVE') === 'false') {
    config.autoSolve = false;
  }

  const allowedRootsRaw = getEnv('BAILOUT_ALLOWED_ROOTS');
  if (allowedRootsRaw) {
    config.allowedWorkspaceRoots = allowedRootsRaw
      .split(path.delimiter)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => path.resolve(r));
  }

  const explicitRootsConfigured = Boolean(
    overrides?.explicitRootsLocked ||
      (overrides?.allowedWorkspaceRoots && overrides.allowedWorkspaceRoots.length > 0) ||
      allowedRootsRaw ||
      (projectCfg?.allowedWorkspaceRoots && projectCfg.allowedWorkspaceRoots.length > 0) ||
      (globalCfg?.allowedWorkspaceRoots && globalCfg.allowedWorkspaceRoots.length > 0),
  );

  const finalConfig = deepMergeConfig(config, overrides);
  finalConfig.explicitRootsLocked = explicitRootsConfigured;
  if (finalConfig.frictionThreshold > finalConfig.stuckThreshold) {
    finalConfig.frictionThreshold = Math.max(10, finalConfig.stuckThreshold - 10);
  }
  if (finalConfig.allowedWorkspaceRoots.length === 0 && finalConfig.workspaceRoot) {
    finalConfig.allowedWorkspaceRoots = [path.resolve(finalConfig.workspaceRoot)];
  }
  return finalConfig;
}

const ALLOWED_RUNTIME_PROVIDERS: ReadonlySet<string> = VALID_PROVIDERS;

/**
 * Strictly filters untrusted IPC/MCP runtime config updates to safe non-secret tuning knobs.
 * API keys, endpoint URLs, headers, and allowedWorkspaceRoots can NEVER be mutated via IPC/MCP.
 */
export function pickSafeConfigUpdate(body: Record<string, unknown>): Partial<BailoutConfig> {
  const safe: Partial<BailoutConfig> = {};

  if (typeof body.provider === 'string' && ALLOWED_RUNTIME_PROVIDERS.has(body.provider)) {
    safe.provider = body.provider as BailoutProviderKind;
  }
  if (
    typeof body.stuckThreshold === 'number' &&
    Number.isFinite(body.stuckThreshold) &&
    body.stuckThreshold >= 20 &&
    body.stuckThreshold <= 100
  ) {
    safe.stuckThreshold = body.stuckThreshold;
  }
  if (
    typeof body.frictionThreshold === 'number' &&
    Number.isFinite(body.frictionThreshold) &&
    body.frictionThreshold >= 10 &&
    body.frictionThreshold <= 95
  ) {
    safe.frictionThreshold = body.frictionThreshold;
  }
  if (
    typeof body.pauseGateMs === 'number' &&
    Number.isFinite(body.pauseGateMs) &&
    body.pauseGateMs >= 500 &&
    body.pauseGateMs <= 30_000
  ) {
    safe.pauseGateMs = body.pauseGateMs;
  }
  if (
    typeof body.cooldownMs === 'number' &&
    Number.isFinite(body.cooldownMs) &&
    body.cooldownMs >= 10_000 &&
    body.cooldownMs <= 3_600_000
  ) {
    safe.cooldownMs = body.cooldownMs;
  }
  if (
    typeof body.minConfidence === 'number' &&
    Number.isFinite(body.minConfidence) &&
    body.minConfidence >= 0.3 &&
    body.minConfidence <= 0.99
  ) {
    safe.minConfidence = body.minConfidence;
  }
  if (typeof body.autoSolve === 'boolean') {
    safe.autoSolve = body.autoSolve;
  }

  return safe;
}
