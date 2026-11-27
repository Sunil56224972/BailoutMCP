import fs from 'node:fs';
import path from 'node:path';
import { hashContent, redactSecrets } from './normalizer.js';
import { assertSafeWorkspacePath } from './security.js';
import type { BailoutConfig, BailoutDossier, FileHotspot } from './types.js';

function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.vue': 'vue',
    '.svelte': 'svelte',
    '.astro': 'astro',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.cs': 'csharp',
    '.cpp': 'cpp',
    '.c': 'c',
    '.h': 'c',
    '.hpp': 'cpp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.scala': 'scala',
    '.dart': 'dart',
    '.lua': 'lua',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.sol': 'solidity',
    '.zig': 'zig',
    '.sh': 'bash',
    '.bash': 'bash',
    '.ps1': 'powershell',
    '.prisma': 'prisma',
    '.graphql': 'graphql',
    '.sql': 'sql',
    '.toml': 'toml',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
  };
  return map[ext] ?? 'text';
}

const HEADER_LINE_RE =
  /^\s*(?:import\s|from\s+\S+\s+import\s|const\s+\S+\s*=\s*require\(|use\s+|package\s+|#include\s|using\s+|export\s+(?:type|interface)\s|type\s+\w+|interface\s+\w+|\/\/|\/\*|\*)/;

function extractTopOfFileContext(
  lines: string[],
  windowStartLine: number,
  shouldRedact: boolean,
): { headerText?: string; redactedCount: number } {
  if (windowStartLine <= 3) return { redactedCount: 0 };

  const maxHeaderLine = Math.min(windowStartLine - 1, 30);
  const selected: string[] = [];
  for (let i = 0; i < maxHeaderLine && selected.length < 20; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (HEADER_LINE_RE.test(line) || i < 8) {
      const clipped = line.length > 300 ? `${line.slice(0, 300)} /* [truncated] */` : line;
      selected.push(`${String(i + 1).padStart(4, ' ')} | ${clipped}`);
    }
  }

  if (selected.length === 0) return { redactedCount: 0 };
  const joined = selected.join('\n');
  if (!shouldRedact) {
    return { headerText: joined, redactedCount: 0 };
  }
  const red = redactSecrets(joined);
  return { headerText: red.text, redactedCount: red.redactedCount };
}

export interface DistillOptions {
  fileContentOverride?: string;
  workspaceRoot?: string;
}

/**
 * Distills a noisy debugging session into a surgical ~1-2k token BailoutDossier:
 * - Enforces strict workspace boundary & sensitive-file denylist (.env, keys, creds)
 * - Rejects oversized, binary, or minified files
 * - Scrubs secrets before any code leaves the local machine
 */
export function distillBailoutDossier(
  hotspot: FileHotspot,
  config: BailoutConfig,
  options: DistillOptions = {},
): BailoutDossier {
  const safePath = assertSafeWorkspacePath(hotspot.filePath, config.allowedWorkspaceRoots);

  let fullContent = options.fileContentOverride;
  if (fullContent === undefined) {
    if (!fs.existsSync(safePath)) {
      throw new Error(`Target file not found: ${safePath}`);
    }
    const stat = fs.statSync(safePath);
    if (!stat.isFile()) {
      throw new Error(`Target path is not a regular file: ${safePath}`);
    }
    if (stat.size > config.maxFileSizeBytes) {
      throw new Error(
        `Target file exceeds maxFileSizeBytes (${stat.size} > ${config.maxFileSizeBytes}).`,
      );
    }
    const rawBuf = fs.readFileSync(safePath);
    if (rawBuf.includes(0)) {
      throw new Error(`Target file appears to be binary: ${path.basename(safePath)}`);
    }
    fullContent = rawBuf.toString('utf8');
  }

  const lines = fullContent.split(/\r?\n/);
  const totalLines = Math.max(1, lines.length);

  // Guard against minified bundles (single huge lines)
  const avgLineLength = fullContent.length / totalLines;
  if (avgLineLength > 450 && totalLines < 20) {
    throw new Error(`Target file appears to be minified: ${path.basename(safePath)}`);
  }

  const centerStart = hotspot.hotspotRange?.startLine ?? 1;
  const centerEnd = hotspot.hotspotRange?.endLine ?? Math.min(totalLines, centerStart + 25);

  const radius = Math.max(10, config.contextWindowRadius);
  const windowStartLine = Math.max(1, centerStart - radius);
  const windowEndLine = Math.min(totalLines, centerEnd + radius);

  const slice = lines
    .slice(windowStartLine - 1, windowEndLine)
    .map((line) => (line.length > 500 ? `${line.slice(0, 500)} /* [truncated] */` : line));
  const rawWindow = slice.join('\n');

  let redactedSecretsCount = 0;
  let safeWindow = rawWindow;

  if (config.redactSecrets) {
    const red = redactSecrets(rawWindow);
    safeWindow = red.text;
    redactedSecretsCount += red.redactedCount;
  }

  const safeLines = safeWindow.split(/\r?\n/);
  const numberedCodeWindow = safeLines
    .map((line, idx) => `${String(windowStartLine + idx).padStart(4, ' ')} | ${line}`)
    .join('\n');

  const topHeader = extractTopOfFileContext(lines, windowStartLine, config.redactSecrets);
  redactedSecretsCount += topHeader.redactedCount;

  const recurringErrors = hotspot.recurringErrors.slice(0, 3).map((err) => {
    let latestRaw = err.latestRaw;
    if (config.redactSecrets) {
      const red = redactSecrets(latestRaw);
      latestRaw = red.text;
      redactedSecretsCount += red.redactedCount;
    }
    return {
      count: err.count,
      normalized: err.normalized,
      latestRaw,
      code: err.code,
    };
  });

  const root = options.workspaceRoot ?? config.workspaceRoot;
  const relativePath =
    root && path.isAbsolute(safePath)
      ? path.relative(root, safePath).replace(/\\/g, '/')
      : path.basename(safePath);

  return {
    filePath: safePath,
    relativePath,
    language: inferLanguage(safePath),
    frustrationScore: hotspot.score,
    triggerReasons: hotspot.reasons,
    hotspotRange: {
      startLine: centerStart,
      endLine: centerEnd,
    },
    ...(topHeader.headerText ? { topOfFileContext: topHeader.headerText } : {}),
    numberedCodeWindow,
    rawCodeWindow: safeWindow,
    windowStartLine,
    windowEndLine,
    fileContentHash: hashContent(fullContent),
    recurringErrors,
    attemptedFixes: hotspot.attemptedFixes.slice(-5),
    lightweightModel: hotspot.activeAgentModel,
    dwellMinutes: Math.round((hotspot.dwellMs / 60_000) * 10) / 10,
    undoCount: hotspot.undoCount,
    oscillationCount: hotspot.oscillationCount,
    redactedSecretsCount,
  };
}
