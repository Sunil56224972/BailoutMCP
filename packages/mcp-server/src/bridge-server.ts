import http from 'node:http';
import {
  constantTimeEqual,
  sanitizeConfigForDisplay,
  type BailoutConfig,
  type BailoutEngine,
  type BailoutProviderKind,
  type ManualBailoutOptions,
  type TelemetrySignal,
} from '@bailout-mcp/core';
import {
  generateBridgeToken,
  removeBridgeManifestIfOwned,
  writeBridgeManifest,
} from './bridge-auth.js';

export interface BridgeServerOptions {
  port?: number;
  host?: string;
  token?: string;
  manifestDir?: string;
  writeManifest?: boolean;
  surfaceCheckIntervalMs?: number;
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SSE_CLIENTS = 16;
const SSE_HEARTBEAT_MS = 25_000;

const ALLOWED_RUNTIME_PROVIDERS = new Set<BailoutProviderKind>([
  'anthropic',
  'gemini',
  'openai',
  'openrouter',
  'ollama',
  'custom',
]);

function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

/**
 * Hardened localhost-only HTTP + SSE bridge server:
 * - Constant-time token authentication via X-Bailout-Token header ONLY (no URL tokens)
 * - Strict Host header validation (defeats DNS rebinding)
 * - Blocks cross-origin requests carrying browser Origin header (defeats localhost CSRF)
 * - Strict config allowlist (never allows remote mutation of API keys, URLs, or workspace roots)
 * - Automatic ephemeral port fallback if default port is occupied by another app
 */
export class LocalBridgeServer {
  private readonly engine: BailoutEngine;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly token: string;
  private readonly manifestDir?: string;
  private readonly shouldWriteManifest: boolean;
  private readonly surfaceCheckIntervalMs: number;

  private server?: http.Server;
  private actualPort = 0;
  private surfaceTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly sseClients = new Set<http.ServerResponse>();

  constructor(engine: BailoutEngine, options: BridgeServerOptions = {}) {
    this.engine = engine;
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? engine.getConfig().bridgePort;
    this.token = options.token ?? generateBridgeToken();
    this.manifestDir = options.manifestDir;
    this.shouldWriteManifest = options.writeManifest ?? true;
    this.surfaceCheckIntervalMs = options.surfaceCheckIntervalMs ?? 1000;

    this.bindEngineEvents();
  }

  getPort(): number {
    return this.actualPort;
  }

  getToken(): string {
    return this.token;
  }

  getBaseUrl(): string {
    return `http://${this.host}:${this.actualPort}`;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    try {
      await this.listenOnPort(this.requestedPort);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EADDRINUSE' && this.requestedPort !== 0) {
        // Fallback to an OS-assigned loopback port so another app on 47821 never breaks BailoutMCP
        await this.listenOnPort(0);
      } else {
        this.server = undefined;
        throw err;
      }
    }

    if (this.shouldWriteManifest) {
      writeBridgeManifest(
        {
          port: this.actualPort,
          token: this.token,
          pid: process.pid,
          startedAt: Date.now(),
        },
        this.manifestDir,
      );
    }

    this.surfaceTimer = setInterval(() => {
      this.engine.checkSurfaceable();
    }, this.surfaceCheckIntervalMs);
    this.surfaceTimer.unref();

    this.heartbeatTimer = setInterval(() => {
      for (const client of this.sseClients) {
        if (!client.writableEnded) {
          client.write(': keepalive\n\n');
        }
      }
    }, SSE_HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.surfaceTimer) {
      clearInterval(this.surfaceTimer);
      this.surfaceTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = undefined;
    }

    if (this.shouldWriteManifest) {
      removeBridgeManifestIfOwned(process.pid, this.manifestDir);
    }
  }

  private listenOnPort(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server?.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        const addr = this.server!.address();
        this.actualPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve();
      };
      this.server!.once('error', onError);
      this.server!.once('listening', onListening);
      this.server!.listen(port, this.host);
    });
  }

  private bindEngineEvents(): void {
    const forward = (event: string) => (payload: unknown) => {
      this.broadcastSse(event, payload);
    };
    this.engine.on('state_changed', forward('state_changed'));
    this.engine.on('bailout_solving', forward('bailout_solving'));
    this.engine.on('bailout_ready', forward('bailout_ready'));
    this.engine.on('bailout_surfaceable', forward('bailout_surfaceable'));
    this.engine.on('bailout_accepted', forward('bailout_accepted'));
    this.engine.on('bailout_dismissed', forward('bailout_dismissed'));
    this.engine.on('bailout_invalidated', forward('bailout_invalidated'));
    this.engine.on('micro_win', forward('micro_win'));
  }

  private broadcastSse(event: string, data: unknown): void {
    if (this.sseClients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      if (!client.writableEnded) {
        client.write(frame);
      }
    }
  }

  private isAllowedHost(req: http.IncomingMessage): boolean {
    const hostHeader = req.headers.host?.toLowerCase();
    if (!hostHeader) return false;
    const allowed = new Set([
      `127.0.0.1:${this.actualPort}`,
      `localhost:${this.actualPort}`,
      `[::1]:${this.actualPort}`,
    ]);
    return allowed.has(hostHeader);
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const rawHeader = req.headers['x-bailout-token'];
    const token = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!token || typeof token !== 'string') return false;
    return constantTimeEqual(token, this.token);
  }

  private pickSafeConfigUpdate(body: Record<string, unknown>): Partial<BailoutConfig> {
    // Strictly allow ONLY non-secret runtime tuning knobs over IPC/MCP.
    // API keys, endpoint URLs, headers, and allowedWorkspaceRoots MUST come from local env/files.
    const safe: Partial<BailoutConfig> = {};

    if (
      typeof body.provider === 'string' &&
      ALLOWED_RUNTIME_PROVIDERS.has(body.provider as BailoutProviderKind)
    ) {
      safe.provider = body.provider as BailoutProviderKind;
    }
    if (
      typeof body.stuckThreshold === 'number' &&
      body.stuckThreshold >= 20 &&
      body.stuckThreshold <= 100
    ) {
      safe.stuckThreshold = body.stuckThreshold;
    }
    if (
      typeof body.pauseGateMs === 'number' &&
      body.pauseGateMs >= 500 &&
      body.pauseGateMs <= 30_000
    ) {
      safe.pauseGateMs = body.pauseGateMs;
    }
    if (
      typeof body.cooldownMs === 'number' &&
      body.cooldownMs >= 10_000 &&
      body.cooldownMs <= 3_600_000
    ) {
      safe.cooldownMs = body.cooldownMs;
    }
    if (
      typeof body.minConfidence === 'number' &&
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

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // 1. Defeat DNS rebinding & browser localhost CSRF
    if (!this.isAllowedHost(req)) {
      sendJson(res, 403, { error: 'Forbidden: invalid Host header' });
      return;
    }
    if (req.headers.origin) {
      sendJson(res, 403, { error: 'Forbidden: cross-origin browser requests are blocked' });
      return;
    }

    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${this.host}:${this.actualPort || 80}`);

    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'bailout-mcp-bridge',
        version: '0.1.0',
      });
      return;
    }

    if (!this.isAuthorized(req)) {
      sendJson(res, 401, { error: 'Unauthorized: invalid or missing X-Bailout-Token header' });
      return;
    }

    try {
      if (method === 'GET' && url.pathname === '/v1/state') {
        sendJson(res, 200, this.engine.getSnapshot());
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/dossier') {
        sendJson(res, 200, { dossier: this.engine.getLastDossier() ?? null });
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/bailout/pending') {
        const includeGated = url.searchParams.get('includeGated') !== 'false';
        const proposal = this.engine.getPendingBailout(includeGated) ?? null;
        sendJson(res, 200, { proposal });
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/signals') {
        const body = await readJsonBody<{
          signal?: TelemetrySignal;
          fileContentOverride?: string;
        } & TelemetrySignal>(req);
        const signal: TelemetrySignal = body.signal ?? body;
        if (!signal || !signal.kind) {
          sendJson(res, 400, { error: 'Missing required field: kind' });
          return;
        }
        const snapshot = this.engine.ingest(signal, body.fileContentOverride);
        sendJson(res, 200, snapshot);
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/bailout/trigger') {
        const body = await readJsonBody<ManualBailoutOptions>(req);
        const proposal = await this.engine.triggerBailout(body);
        sendJson(res, 200, { proposal });
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/bailout/accept') {
        const body = await readJsonBody<{ id?: string; applyToDisk?: boolean }>(req);
        if (!body.id) {
          sendJson(res, 400, { error: 'Missing required field: id' });
          return;
        }
        const outcome = this.engine.acceptBailout(body.id, Boolean(body.applyToDisk));
        sendJson(res, 200, outcome);
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/bailout/dismiss') {
        const body = await readJsonBody<{ id?: string }>(req);
        const dismissed = this.engine.dismissBailout(body.id);
        sendJson(res, 200, { dismissed: dismissed ?? null });
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/config') {
        const body = await readJsonBody<Record<string, unknown>>(req);
        const safePartial = this.pickSafeConfigUpdate(body);
        const updated = this.engine.updateConfig(safePartial);
        sendJson(res, 200, { config: sanitizeConfigForDisplay(updated) });
        return;
      }

      if (method === 'GET' && url.pathname === '/v1/events') {
        if (this.sseClients.size >= MAX_SSE_CLIENTS) {
          sendJson(res, 429, { error: 'Too many concurrent SSE subscribers' });
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-content-type-options': 'nosniff',
        });
        res.write(`event: state_changed\ndata: ${JSON.stringify(this.engine.getSnapshot())}\n\n`);
        this.sseClients.add(res);
        req.on('close', () => {
          this.sseClients.delete(res);
        });
        return;
      }

      sendJson(res, 404, { error: `Unknown endpoint: ${method} ${url.pathname}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.startsWith('SecurityError:') ? 403 : 500;
      sendJson(res, status, { error: msg });
    }
  }
}
