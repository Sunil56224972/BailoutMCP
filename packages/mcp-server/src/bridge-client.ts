import fs from 'node:fs';
import type {
  BailoutConfig,
  BailoutDossier,
  BailoutProposal,
  ManualBailoutOptions,
  ShadowStateSnapshot,
  TelemetrySignal,
} from '@bailout-mcp/core';
import { getBridgeManifestPath, readBridgeManifest } from './bridge-auth.js';

export interface BridgeConnection {
  baseUrl: string;
  token: string;
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export class BridgeClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(conn: BridgeConnection) {
    this.baseUrl = conn.baseUrl.replace(/\/$/, '');
    this.token = conn.token;
  }

  static async discover(customDir?: string, timeoutMs = 600): Promise<BridgeClient | null> {
    const manifest = readBridgeManifest(customDir);
    if (!manifest) return null;

    const baseUrl = `http://127.0.0.1:${manifest.port}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        return new BridgeClient({ baseUrl, token: manifest.token });
      }
    } catch {
      // Unreachable bridge
    }

    // Clean up stale manifest if the owning PID is no longer alive
    if (!isPidAlive(manifest.pid)) {
      try {
        fs.unlinkSync(getBridgeManifestPath(customDir));
      } catch {
        // Ignore cleanup race
      }
    }
    return null;
  }

  async getState(): Promise<ShadowStateSnapshot> {
    return this.request<ShadowStateSnapshot>('GET', '/v1/state');
  }

  async recordSignal(
    signal: TelemetrySignal,
    fileContentOverride?: string,
  ): Promise<ShadowStateSnapshot> {
    return this.request<ShadowStateSnapshot>('POST', '/v1/signals', {
      signal,
      fileContentOverride,
    });
  }

  async getPendingBailout(includeGated = true): Promise<BailoutProposal | null> {
    const res = await this.request<{ proposal: BailoutProposal | null }>(
      'GET',
      `/v1/bailout/pending?includeGated=${includeGated ? 'true' : 'false'}`,
    );
    return res.proposal;
  }

  async triggerBailout(options: ManualBailoutOptions = {}): Promise<BailoutProposal> {
    const res = await this.request<{ proposal: BailoutProposal }>(
      'POST',
      '/v1/bailout/trigger',
      options,
    );
    return res.proposal;
  }

  async acceptBailout(
    id: string,
    applyToDisk = false,
  ): Promise<{ proposal: BailoutProposal; appliedToDisk: boolean; applyError?: string }> {
    return this.request('POST', '/v1/bailout/accept', { id, applyToDisk });
  }

  async dismissBailout(id?: string): Promise<BailoutProposal | null> {
    const res = await this.request<{ dismissed: BailoutProposal | null }>(
      'POST',
      '/v1/bailout/dismiss',
      { id },
    );
    return res.dismissed;
  }

  async getLastDossier(): Promise<BailoutDossier | null> {
    const res = await this.request<{ dossier: BailoutDossier | null }>('GET', '/v1/dossier');
    return res.dossier;
  }

  async previewDossier(filePath?: string): Promise<BailoutDossier> {
    const query = filePath ? `?filePath=${encodeURIComponent(filePath)}` : '';
    const res = await this.request<{ dossier: BailoutDossier }>(
      'GET',
      `/v1/dossier/preview${query}`,
    );
    return res.dossier;
  }

  async resetState(filePath?: string): Promise<ShadowStateSnapshot> {
    return this.request<ShadowStateSnapshot>('POST', '/v1/state/reset', { filePath });
  }

  async updateConfig(partial: Partial<BailoutConfig>): Promise<Record<string, unknown>> {
    const res = await this.request<{ config: Record<string, unknown> }>(
      'POST',
      '/v1/config',
      partial,
    );
    return res.config;
  }

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-bailout-token': this.token,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) {
      throw new Error(data.error ?? `Bridge HTTP ${res.status}`);
    }
    return data;
  }
}
