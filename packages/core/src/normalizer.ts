import crypto from 'node:crypto';
import path from 'node:path';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*[a-zA-Z]/g;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const CLOCK_TIME_PATTERN = /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const HEX_ADDR_PATTERN = /\b0x[0-9a-fA-F]{4,}\b/g;
const UUID_PATTERN = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\(?:[^\\:\s"'()]+\\)+([^\\:\s"'()]+)/g;
const POSIX_PATH_PATTERN = /(?:\/[A-Za-z0-9._-]+){2,}\/([A-Za-z0-9._-]+)/g;
const LINE_COL_PATTERN = /:\d+(?::\d+)?\b/g;
const LINE_WORD_PATTERN = /\bline\s+\d+\b/gi;
const PORT_PATTERN = /\b(?:localhost|127\.0\.0\.1):\d{2,5}\b/g;

export interface NormalizedError {
  normalized: string;
  fingerprint: string;
}

/**
 * Normalizes noisy compiler/runtime/terminal error messages into a stable
 * canonical signature so identical underlying bugs match even if timestamps,
 * paths, memory addresses, or line numbers shift slightly during edits.
 */
export function normalizeErrorSignature(raw: string, code?: string): NormalizedError {
  const firstMeaningfulLines = raw
    .replace(ANSI_PATTERN, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('at node:') && !line.startsWith('Node.js v'))
    .slice(0, 3)
    .join(' | ');

  let normalized = firstMeaningfulLines
    .replace(ISO_TIMESTAMP_PATTERN, '<TS>')
    .replace(CLOCK_TIME_PATTERN, '<TIME>')
    .replace(UUID_PATTERN, '<UUID>')
    .replace(HEX_ADDR_PATTERN, '<HEX>')
    .replace(PORT_PATTERN, 'localhost:<PORT>')
    .replace(WINDOWS_PATH_PATTERN, '$1')
    .replace(POSIX_PATH_PATTERN, '$1')
    .replace(LINE_COL_PATTERN, ':<LOC>')
    .replace(LINE_WORD_PATTERN, 'line <N>')
    .replace(/\s+/g, ' ')
    .trim();

  if (code) {
    normalized = `[${code}] ${normalized}`;
  }

  if (normalized.length > 260) {
    normalized = normalized.slice(0, 260);
  }

  const fingerprint = crypto
    .createHash('sha256')
    .update(normalized.toLowerCase())
    .digest('hex')
    .slice(0, 16);

  return { normalized, fingerprint };
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 20);
}

export function normalizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

interface SecretRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const SECRET_RULES: SecretRule[] = [
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    name: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
    replacement: '[REDACTED_ANTHROPIC_KEY]',
  },
  {
    name: 'openrouter-key',
    pattern: /\bsk-or-v1-[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED_OPENROUTER_KEY]',
  },
  {
    name: 'stripe-key',
    pattern: /\b[sr]k_(?:live|test)_[0-9a-zA-Z]{16,}\b/g,
    replacement: '[REDACTED_STRIPE_KEY]',
  },
  {
    name: 'openai-key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED_OPENAI_KEY]',
  },
  {
    name: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    replacement: '[REDACTED_GOOGLE_KEY]',
  },
  {
    name: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/g,
    replacement: '[REDACTED_SLACK_TOKEN]',
  },
  {
    name: 'sendgrid-key',
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
    replacement: '[REDACTED_SENDGRID_KEY]',
  },
  {
    name: 'huggingface-token',
    pattern: /\bhf_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED_HF_TOKEN]',
  },
  {
    name: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED_NPM_TOKEN]',
  },
  {
    name: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_AWS_KEY]',
  },
  {
    name: 'db-connection-uri',
    pattern: /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:)([^@\s]+)(@)/gi,
    replacement: '$1[REDACTED_DB_PASS]$3',
  },
  {
    name: 'bearer-or-basic-auth',
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._+/=-]{12,}\b/gi,
    replacement: '$1 [REDACTED_AUTH]',
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    name: 'env-secret-assignment',
    pattern:
      /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET)[A-Z0-9_]*)\s*([:=])\s*(["']?)([^\s"'`]{8,})\3/gi,
    replacement: '$1$2$3[REDACTED_SECRET]$3',
  },
];

export interface RedactionResult {
  text: string;
  redactedCount: number;
}

/**
 * Scrubs sensitive credentials before any code window or error trace leaves the local machine.
 */
export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let redactedCount = 0;

  for (const rule of SECRET_RULES) {
    text = text.replace(rule.pattern, (...args) => {
      redactedCount += 1;
      if (rule.name === 'env-secret-assignment') {
        const key = args[1] as string;
        const sep = args[2] as string;
        const quote = (args[3] as string) ?? '';
        return `${key}${sep}${quote}[REDACTED_SECRET]${quote}`;
      }
      if (rule.name === 'db-connection-uri') {
        return `${args[1] as string}[REDACTED_DB_PASS]${args[3] as string}`;
      }
      if (rule.name === 'bearer-or-basic-auth') {
        return `${args[1] as string} [REDACTED_AUTH]`;
      }
      return rule.replacement;
    });
  }

  return { text, redactedCount };
}
