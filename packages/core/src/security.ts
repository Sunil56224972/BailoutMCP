import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isProviderConfigured } from './config.js';
import type { BailoutConfig } from './types.js';

const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.dockercfg',
  '.git-credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'authorized_keys',
  'known_hosts',
  'credentials',
  'credentials.json',
  'service-account.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'bridge.json',
  'shadow',
  'passwd',
  'master.key',
]);

const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|crt|der|ovpn|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[._-])(secret|secrets|credential|credentials|privatekey|private_key)([._-]|$)/i,
  /\.(sqlite|sqlite3|db)$/i,
];

const SENSITIVE_DIR_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.bailout-mcp',
  '.docker',
  '.gcloud',
  '.azure',
]);

const SYSTEM_ROOT_PREFIXES_POSIX = ['/etc/', '/proc/', '/sys/', '/dev/', '/boot/', '/root/'];
const SYSTEM_ROOT_PREFIXES_WIN = ['c:\\windows\\', 'c:\\program files\\', 'c:\\program files (x86)\\'];

/**
 * Blocks sensitive credential, key, certificate, database, and OS system files
 * from EVER being read into a BailoutDossier or patched on disk.
 */
export function isSensitiveFilePath(filePath: string): boolean {
  const normalized = path.resolve(filePath);
  const lowerFull = normalized.toLowerCase();

  if (process.platform === 'win32') {
    if (SYSTEM_ROOT_PREFIXES_WIN.some((p) => lowerFull.startsWith(p))) return true;
  } else {
    if (SYSTEM_ROOT_PREFIXES_POSIX.some((p) => lowerFull.startsWith(p))) return true;
  }

  const base = path.basename(normalized).toLowerCase();
  if (SENSITIVE_BASENAMES.has(base)) return true;

  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(base)) return true;
  }

  const segments = normalized.split(/[\\/]/).map((s) => s.toLowerCase());
  return segments.some((seg) => SENSITIVE_DIR_SEGMENTS.has(seg));
}

function resolveRealOrParent(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    try {
      return path.join(fs.realpathSync(parent), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

export function isPathInsideRoot(candidate: string, root: string): boolean {
  const realCandidate = resolveRealOrParent(candidate);
  const realRoot = resolveRealOrParent(root);

  const cmpCandidate =
    process.platform === 'win32' ? realCandidate.toLowerCase() : realCandidate;
  const cmpRoot =
    process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;

  if (cmpCandidate === cmpRoot) return true;
  const sep = path.sep;
  const rootWithSep = cmpRoot.endsWith(sep) ? cmpRoot : cmpRoot + sep;
  return cmpCandidate.startsWith(rootWithSep);
}

/**
 * Validates whether a workspace directory reported by an authenticated local IDE
 * or CLI hook is safe to register as an allowed workspace root.
 */
export function isSafeWorkspaceRootDir(dirPath: string): boolean {
  if (!dirPath || typeof dirPath !== 'string' || dirPath.includes('\0')) return false;
  const resolved = path.resolve(dirPath);
  // Reject filesystem root itself ("/" or "C:\")
  if (path.dirname(resolved) === resolved) return false;
  if (isSensitiveFilePath(resolved)) return false;
  return true;
}

/**
 * Enforces workspace boundary & sensitive-file denylist to prevent path traversal,
 * symlink escape, and accidental credential exfiltration.
 */
export function assertSafeWorkspacePath(
  filePath: string,
  allowedRoots: string[],
): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('SecurityError: filePath is required.');
  }
  if (filePath.includes('\0')) {
    throw new Error('SecurityError: null byte detected in filePath.');
  }

  const resolved = path.resolve(filePath);

  if (isSensitiveFilePath(resolved)) {
    throw new Error(
      `SecurityError: Access blocked for sensitive file "${path.basename(resolved)}".`,
    );
  }

  if (allowedRoots.length > 0) {
    const allowed = allowedRoots.some((root) => isPathInsideRoot(resolved, root));
    if (!allowed) {
      throw new Error(
        `SecurityError: File "${resolved}" is outside allowed workspace roots.`,
      );
    }
  }

  return resolved;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const BLOCKED_HOSTS = new Set([
  '0.0.0.0',
  '::',
  '[::]',
  '169.254.169.254',
  '169.254.170.2',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
  'fd00:ec2::254',
]);

function isBlockedIpAddress(host: string): boolean {
  const clean = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTS.has(clean)) return true;

  // IPv6 link-local (fe80::/10), unique-local (fc00::/7), or IPv4-mapped metadata
  if (
    clean.startsWith('fe80:') ||
    clean.startsWith('fc') ||
    clean.startsWith('fd') ||
    clean.includes('169.254.') ||
    clean.includes('a9fe:')
  ) {
    return true;
  }

  const match = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // Link-local / Cloud IMDS
  if (a === 10) return true; // RFC1918 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16.0.0/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Alibaba IMDS
  return false;
}

/**
 * Validates outbound model/router URLs to block SSRF (cloud metadata IPs,
 * private RFC1918/link-local ranges, embedded credentials, file:// URIs,
 * and plaintext HTTP to non-loopback hosts).
 */
export function validateEndpointUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`SecurityError: Invalid endpoint URL "${rawUrl}".`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('SecurityError: Endpoint URL must not contain embedded credentials.');
  }

  const host = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) {
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed;
    }
    throw new Error(`SecurityError: Unsupported protocol "${parsed.protocol}" for loopback endpoint.`);
  }

  if (BLOCKED_HOSTS.has(host) || isBlockedIpAddress(host)) {
    throw new Error(`SecurityError: Blocked internal/metadata host "${host}".`);
  }

  if (parsed.protocol === 'https:') {
    return parsed;
  }

  throw new Error(
    `SecurityError: Endpoint "${rawUrl}" must use https:// (plain http:// is allowed only for loopback 127.0.0.1/localhost).`,
  );
}

/**
 * Constant-time string comparison to prevent timing side-channel leaks on auth tokens.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

interface DangerousPatchRule {
  label: string;
  pattern: RegExp;
}

const DANGEROUS_NEW_CODE_RULES: DangerousPatchRule[] = [
  { label: 'dynamic eval()', pattern: /\beval\s*\(/i },
  { label: 'new Function()', pattern: /\bnew\s+Function\s*\(/i },
  {
    label: 'child_process execution',
    pattern: /\b(child_process|execSync|spawnSync|execFileSync|execFile|spawn)\b/,
  },
  {
    label: 'destructive filesystem deletion',
    pattern: /\bfs\.(?:promises\.)?(rmSync|rmdirSync|unlinkSync|rm|rmdir)\s*\(/,
  },
  {
    label: 'remote dynamic import',
    pattern: /\bimport\s*\(\s*['"`]https?:\/\//i,
  },
  {
    label: 'piped shell download',
    pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh|pwsh|powershell)\b/i,
  },
  {
    label: 'encoded powershell execution',
    pattern: /\b(powershell|pwsh)\b[^\n]*-(enc|encodedcommand)\b/i,
  },
  { label: 'destructive recursive delete', pattern: /\brm\s+-rf\s+\/(\s|$)/i },
  {
    label: 'redaction placeholder overwrite',
    pattern: /\[REDACTED_[A-Z0-9_]+\]/,
  },
];

export interface PatchSafetyResult {
  safe: boolean;
  reason?: string;
}

/**
 * Defends against prompt-injected model outputs sneaking dangerous execution
 * primitives or oversized rewrites into a surgical bailout patch.
 */
export function validatePatchSafety(
  originalCode: string,
  fixedCode: string,
  maxPatchLines: number,
): PatchSafetyResult {
  const origLines = originalCode.replace(/\r\n/g, '\n').split('\n');
  const fixedLines = fixedCode.replace(/\r\n/g, '\n').split('\n');

  if (Math.max(origLines.length, fixedLines.length) > maxPatchLines) {
    return {
      safe: false,
      reason: `Patch exceeds surgical limit (${Math.max(origLines.length, fixedLines.length)} > ${maxPatchLines} lines).`,
    };
  }

  for (const rule of DANGEROUS_NEW_CODE_RULES) {
    if (rule.pattern.test(fixedCode) && !rule.pattern.test(originalCode)) {
      return {
        safe: false,
        reason: `Blocked potentially unsafe newly-introduced pattern: ${rule.label}.`,
      };
    }
  }

  return { safe: true };
}

/**
 * Strips all API keys & sensitive headers from config objects before logging
 * or returning over MCP/HTTP interfaces.
 */
export function sanitizeConfigForDisplay(
  config: BailoutConfig,
  isConfiguredFn?: (provider: keyof BailoutConfig['providers'], cfg: BailoutConfig) => boolean,
): Record<string, unknown> {
  const providers: Record<string, { model: string; baseUrl?: string; configured: boolean }> = {};
  for (const [name, creds] of Object.entries(config.providers)) {
    const providerKey = name as keyof BailoutConfig['providers'];
    const configured = isConfiguredFn
      ? isConfiguredFn(providerKey, config)
      : isProviderConfigured(providerKey, config);
    providers[name] = {
      model: creds.model,
      baseUrl: creds.baseUrl,
      configured,
    };
  }

  return {
    provider: config.provider,
    fallbackProviders: config.fallbackProviders,
    providers,
    stuckThreshold: config.stuckThreshold,
    frictionThreshold: config.frictionThreshold,
    pauseGateMs: config.pauseGateMs,
    cooldownMs: config.cooldownMs,
    minConfidence: config.minConfidence,
    maxBailoutsPerHour: config.maxBailoutsPerHour,
    maxBailoutsPerDay: config.maxBailoutsPerDay,
    maxPatchLines: config.maxPatchLines,
    redactSecrets: config.redactSecrets,
    autoSolve: config.autoSolve,
    allowedWorkspaceRoots: config.allowedWorkspaceRoots,
  };
}
