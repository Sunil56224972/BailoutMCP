import fs from 'node:fs';
import path from 'node:path';
import { hashContent } from './normalizer.js';
import { assertSafeWorkspacePath, validatePatchSafety } from './security.js';
import type { BailoutPatch, BailoutProposal, RawModelBailoutResponse } from './types.js';

export interface ValidatedPatchResult {
  patch: BailoutPatch;
  patchedFullContent: string;
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function lineNumberAtOffset(normalizedText: string, charOffset: number): number {
  if (charOffset <= 0) return 1;
  let line = 1;
  const end = Math.min(charOffset, normalizedText.length);
  for (let i = 0; i < end; i++) {
    if (normalizedText.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function buildUnifiedDiff(
  filePath: string,
  startLine: number,
  originalCode: string,
  fixedCode: string,
): string {
  const base = path.basename(filePath);
  const oldLines = normalizeEol(originalCode).split('\n');
  const newLines = normalizeEol(fixedCode).split('\n');

  const header = [
    `--- a/${base}`,
    `+++ b/${base}`,
    `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`,
  ];

  const body = [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];

  return [...header, ...body].join('\n');
}

export interface ValidatePatchOptions {
  maxPatchLines?: number;
}

/**
 * Validates that the heavy model's proposed originalCode genuinely exists in
 * the real file (preventing hallucinated or unsafe diffs) and builds an exact
 * line-mapped patch + unified diff anchored by line distance to startLine.
 */
export function validateAndBuildPatch(
  filePath: string,
  fileContent: string,
  raw: RawModelBailoutResponse['patch'],
  options: ValidatePatchOptions = {},
): ValidatedPatchResult | null {
  const hasCrlf = fileContent.includes('\r\n');
  const normalizedFile = normalizeEol(fileContent);
  const normalizedOriginal = normalizeEol(raw.originalCode);
  const normalizedFixed = normalizeEol(raw.fixedCode);

  if (!normalizedOriginal.trim()) return null;
  if (normalizedOriginal === normalizedFixed) return null;

  const safety = validatePatchSafety(
    normalizedOriginal,
    normalizedFixed,
    options.maxPatchLines ?? 35,
  );
  if (!safety.safe) {
    return null;
  }

  let matchIndex = -1;
  let actualOriginal = normalizedOriginal;
  let bestLineDistance = Number.POSITIVE_INFINITY;
  let totalMatches = 0;

  // 1. Direct exact substring match (selecting match closest in line number to raw.startLine)
  let searchFrom = 0;
  while (searchFrom <= normalizedFile.length) {
    const idx = normalizedFile.indexOf(normalizedOriginal, searchFrom);
    if (idx === -1) break;
    totalMatches += 1;
    const candidateLine = lineNumberAtOffset(normalizedFile, idx);
    const lineDist = Math.abs(candidateLine - raw.startLine);
    if (lineDist < bestLineDistance) {
      bestLineDistance = lineDist;
      matchIndex = idx;
    }
    searchFrom = idx + 1;
  }

  // 2. Fallback: line-trimmed match closest in line number to raw.startLine
  if (matchIndex === -1) {
    const fileLines = normalizedFile.split('\n');
    const origLines = normalizedOriginal.split('\n').map((l) => l.trimEnd());
    const trimmedFileLines = fileLines.map((l) => l.trimEnd());

    for (let i = 0; i <= trimmedFileLines.length - origLines.length; i++) {
      let ok = true;
      for (let j = 0; j < origLines.length; j++) {
        if (trimmedFileLines[i + j] !== origLines[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        totalMatches += 1;
        const candidateLine = i + 1;
        const lineDist = Math.abs(candidateLine - raw.startLine);
        if (lineDist < bestLineDistance) {
          bestLineDistance = lineDist;
          actualOriginal = fileLines.slice(i, i + origLines.length).join('\n');
          matchIndex = i === 0 ? 0 : fileLines.slice(0, i).join('\n').length + 1;
        }
      }
    }
  }

  if (matchIndex === -1) {
    return null;
  }

  // If the snippet occurs multiple times in the file, reject ambiguous matches far from startLine
  if (totalMatches > 1 && bestLineDistance > 15) {
    return null;
  }

  const startLine = lineNumberAtOffset(normalizedFile, matchIndex);
  const origLineCount = actualOriginal.split('\n').length;
  const endLine = startLine + origLineCount - 1;

  const patchedNormalized =
    normalizedFile.slice(0, matchIndex) +
    normalizedFixed +
    normalizedFile.slice(matchIndex + actualOriginal.length);

  const patchedFullContent = hasCrlf
    ? patchedNormalized.replace(/\n/g, '\r\n')
    : patchedNormalized;

  const oldSet = actualOriginal.split('\n');
  const newSet = normalizedFixed.split('\n');
  const linesChanged = Math.max(oldSet.length, newSet.length);

  return {
    patch: {
      filePath,
      startLine,
      endLine,
      originalCode: actualOriginal,
      fixedCode: normalizedFixed,
      unifiedDiff: buildUnifiedDiff(filePath, startLine, actualOriginal, normalizedFixed),
      linesChanged,
    },
    patchedFullContent,
  };
}

export interface ApplyPatchOutcome {
  applied: boolean;
  reason?: string;
  newHash?: string;
}

/**
 * Safely applies a BailoutProposal to disk after re-verifying workspace
 * boundary, sensitive-file denylist, patch safety, and target snippet integrity.
 */
export function applyProposalToDisk(
  proposal: BailoutProposal,
  allowedRoots: string[] = [],
  maxPatchLines = 35,
): ApplyPatchOutcome {
  let safePath: string;
  try {
    safePath = assertSafeWorkspacePath(proposal.filePath, allowedRoots);
  } catch (err) {
    return {
      applied: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (!fs.existsSync(safePath)) {
    return { applied: false, reason: `File does not exist: ${safePath}` };
  }

  let currentContent: string;
  try {
    currentContent = fs.readFileSync(safePath, 'utf8');
  } catch (err) {
    return {
      applied: false,
      reason: `Failed to read target file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validated = validateAndBuildPatch(
    safePath,
    currentContent,
    {
      startLine: proposal.patch.startLine,
      endLine: proposal.patch.endLine,
      originalCode: proposal.patch.originalCode,
      fixedCode: proposal.patch.fixedCode,
    },
    { maxPatchLines },
  );

  if (!validated) {
    return {
      applied: false,
      reason: 'Target code changed or failed safety validation since bailout was prepared.',
    };
  }

  const tmpPath = `${safePath}.bailout-tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, validated.patchedFullContent, 'utf8');
    fs.renameSync(tmpPath, safePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup
    }
    return {
      applied: false,
      reason: `Failed to write patched file atomically: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    applied: true,
    newHash: hashContent(validated.patchedFullContent),
  };
}

export function isProposalStillValidForContent(
  proposal: BailoutProposal,
  currentContent: string,
  maxPatchLines = 35,
): boolean {
  const validated = validateAndBuildPatch(
    proposal.filePath,
    currentContent,
    {
      startLine: proposal.patch.startLine,
      endLine: proposal.patch.endLine,
      originalCode: proposal.patch.originalCode,
      fixedCode: proposal.patch.fixedCode,
    },
    { maxPatchLines },
  );
  return validated !== null;
}
