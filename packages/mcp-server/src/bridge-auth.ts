import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getGlobalConfigDir } from '@bailout-mcp/core';

export interface BridgeManifest {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

export function getBridgeManifestPath(customDir?: string): string {
  return path.join(customDir ?? getGlobalConfigDir(), 'bridge.json');
}

export function generateBridgeToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function writeBridgeManifest(manifest: BridgeManifest, customDir?: string): void {
  const filePath = getBridgeManifestPath(customDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export function readBridgeManifest(customDir?: string): BridgeManifest | undefined {
  const filePath = getBridgeManifestPath(customDir);
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BridgeManifest>;
    if (
      typeof parsed.port === 'number' &&
      typeof parsed.token === 'string' &&
      typeof parsed.pid === 'number'
    ) {
      return {
        port: parsed.port,
        token: parsed.token,
        pid: parsed.pid,
        startedAt: parsed.startedAt ?? 0,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function removeBridgeManifestIfOwned(pid: number, customDir?: string): void {
  const manifest = readBridgeManifest(customDir);
  if (manifest && manifest.pid === pid) {
    try {
      fs.unlinkSync(getBridgeManifestPath(customDir));
    } catch {
      // Ignore cleanup race
    }
  }
}
