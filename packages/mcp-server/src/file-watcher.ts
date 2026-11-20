import fs from 'node:fs';
import path from 'node:path';
import { hashContent, isSensitiveFilePath, type BailoutEngine } from '@bailout-mcp/core';

const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.bailout-mcp',
  'coverage',
  '__pycache__',
  '.venv',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.cpp',
  '.c',
  '.rb',
  '.php',
  '.swift',
  '.kt',
  '.vue',
  '.svelte',
]);

/**
 * CLI-friendly local file watcher that detects rapid save-churn and A->B->A
 * content oscillations even when no VS Code/Cursor extension is installed.
 */
export class WorkspaceChurnWatcher {
  private readonly rootDir: string;
  private readonly engine: BailoutEngine;
  private watcher?: fs.FSWatcher;
  private readonly lastHashes = new Map<string, { hash: string; at: number; rapidSaves: number }>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(rootDir: string, engine: BailoutEngine) {
    this.rootDir = path.resolve(rootDir);
    this.engine = engine;
  }

  start(): void {
    if (this.watcher) return;
    this.watcher = fs.watch(
      this.rootDir,
      { recursive: true },
      (_eventType, filename) => {
        if (!filename) return;
        const rel = filename.toString();
        if (this.shouldIgnore(rel)) return;
        const fullPath = path.join(this.rootDir, rel);
        if (isSensitiveFilePath(fullPath)) return;
        this.scheduleInspect(fullPath);
      },
    );

    // Prevent unhandled fs.watch errors (e.g. deleted watched folder or EPERM on Windows)
    this.watcher.on('error', (err) => {
      console.error(`[BailoutMCP Watcher] Non-fatal fs.watch error: ${err.message}`);
    });
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  private shouldIgnore(relativePath: string): boolean {
    const ext = path.extname(relativePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) return true;
    const parts = relativePath.split(/[\\/]/);
    return parts.some((part) => IGNORED_SEGMENTS.has(part));
  }

  private scheduleInspect(filePath: string): void {
    const prev = this.debounceTimers.get(filePath);
    if (prev) clearTimeout(prev);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.inspectFile(filePath);
    }, 300);
    timer.unref();
    this.debounceTimers.set(filePath, timer);
  }

  private inspectFile(filePath: string): void {
    try {
      if (isSensitiveFilePath(filePath)) return;
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 512 * 1024) return;

      const content = fs.readFileSync(filePath, 'utf8');
      const currentHash = hashContent(content);
      const now = Date.now();
      const prev = this.lastHashes.get(filePath);

      if (!prev) {
        this.lastHashes.set(filePath, { hash: currentHash, at: now, rapidSaves: 1 });
        this.engine.ingest({
          kind: 'file_focus',
          filePath,
          source: 'file-watcher',
          timestamp: now,
        });
        return;
      }

      if (prev.hash === currentHash) return;

      const deltaMs = now - prev.at;
      const rapidSaves = deltaMs <= 45_000 ? prev.rapidSaves + 1 : 1;
      this.lastHashes.set(filePath, { hash: currentHash, at: now, rapidSaves });

      if (rapidSaves >= 2) {
        this.engine.ingest(
          {
            kind: 'edit_churn',
            filePath,
            regionHash: currentHash,
            count: 1,
            source: 'file-watcher',
            timestamp: now,
          },
          content,
        );
      } else {
        this.engine.ingest({
          kind: 'keystroke_activity',
          filePath,
          source: 'file-watcher',
          timestamp: now,
        });
      }
    } catch {
      // Ignore transient read lock errors while editors save atomically
    }
  }
}
