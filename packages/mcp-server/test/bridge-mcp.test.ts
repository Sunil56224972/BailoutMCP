import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BailoutEngine } from '@bailout-mcp/core';
import { BridgeClient } from '../src/bridge-client.js';
import { LocalBridgeServer } from '../src/bridge-server.js';
import { createBailoutMcpServer } from '../src/mcp.js';

function startLocalRouterStub(): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    rootCause: 'Missing await on fetch(url)',
                    summary: 'Add missing await before fetch',
                    explanation: 'Await the fetch promise before returning.',
                    whyPreviousAttemptsFailed: 'Returned unresolved Promise.',
                    confidence: 0.94,
                    patch: {
                      startLine: 2,
                      endLine: 2,
                      originalCode: '  const response = fetch(url);',
                      fixedCode: '  const response = await fetch(url);',
                    },
                  }),
                },
              },
            ],
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1/chat/completions` });
    });
  });
}

test('LocalBridgeServer enforces DNS rebinding, CSRF, header-only auth, config allowlist, and full MCP lifecycle', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailout-mcp-test-'));
  const filePath = path.join(tmpDir, 'UserProfile.ts');
  fs.writeFileSync(
    filePath,
    'export async function fetchUser(url: string) {\n  const response = fetch(url);\n  return response;\n}\n',
    'utf8',
  );

  const routerStub = await startLocalRouterStub();

  const fakeAntSecret = ['sk', 'ant', 'should-never-leak'].join('-');
  const engine = new BailoutEngine({
    workspaceRoot: tmpDir,
    allowedWorkspaceRoots: [tmpDir],
    provider: 'custom',
    autoSolve: false,
    pauseGateMs: 100,
    providers: {
      anthropic: { apiKey: fakeAntSecret, model: 'claude-opus-4-6' },
      gemini: { model: 'gemini-2.5-pro' },
      openai: { model: 'o3' },
      openrouter: { model: 'anthropic/claude-opus-4.6' },
      ollama: { model: 'qwen2.5-coder:32b', baseUrl: 'http://127.0.0.1:11434/api/chat' },
      custom: { model: 'test-heavy-router', baseUrl: routerStub.baseUrl },
    },
  });

  const bridge = new LocalBridgeServer(engine, {
    port: 0,
    manifestDir: tmpDir,
    writeManifest: true,
    surfaceCheckIntervalMs: 50,
  });
  await bridge.start();

  try {
    // 1. Missing token -> 401
    const unauth = await fetch(`${bridge.getBaseUrl()}/v1/state`);
    assert.equal(unauth.status, 401);

    // 2. Query-string token MUST be rejected (header-only auth)
    const queryTok = await fetch(
      `${bridge.getBaseUrl()}/v1/state?token=${encodeURIComponent(bridge.getToken())}`,
    );
    assert.equal(queryTok.status, 401);

    // 3. Cross-origin browser request (Origin header) -> 403 CSRF block
    const csrf = await fetch(`${bridge.getBaseUrl()}/v1/state`, {
      headers: {
        origin: 'https://evil.example',
        'x-bailout-token': bridge.getToken(),
      },
    });
    assert.equal(csrf.status, 403);

    // 4. DNS rebinding check (invalid Host header) -> 403
    const rebindStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: bridge.getPort(),
          path: '/health',
          headers: { host: `evil.com:${bridge.getPort()}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(rebindStatus, 403);

    // 5. POST /v1/config MUST ignore injected baseUrl/apiKey and NEVER leak secrets
    const cfgRes = await fetch(`${bridge.getBaseUrl()}/v1/config`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bailout-token': bridge.getToken(),
      },
      body: JSON.stringify({
        stuckThreshold: 75,
        allowedWorkspaceRoots: ['/'],
        providers: { custom: { baseUrl: 'http://evil.com/steal', apiKey: 'hacked' } },
      }),
    });
    assert.equal(cfgRes.status, 200);
    const cfgText = await cfgRes.text();
    assert.ok(!cfgText.includes(fakeAntSecret));
    assert.ok(!cfgText.includes('evil.com'));
    assert.equal(engine.getConfig().providers.custom.baseUrl, routerStub.baseUrl);
    assert.deepEqual(engine.getConfig().allowedWorkspaceRoots, [tmpDir]);

    // 6. Full MCP Server end-to-end via InMemoryTransport + BridgeClient
    const clientBridge = await BridgeClient.discover(tmpDir);
    assert.ok(clientBridge);

    const mcpServer = createBailoutMcpServer(clientBridge);
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      mcpServer.connect(serverTransport),
      mcpClient.connect(clientTransport),
    ]);

    await mcpClient.callTool({
      name: 'record_signal',
      arguments: {
        kind: 'diagnostic_error',
        filePath,
        message: "Property 'json' does not exist on type 'Promise<Response>'",
      },
    });

    const trigRes = await mcpClient.callTool({
      name: 'trigger_bailout',
      arguments: { filePath, force: true },
    });
    const trigText = (trigRes.content as Array<{ type: string; text: string }>)[0].text;
    const proposal = JSON.parse(trigText) as { id: string; patch: { fixedCode: string } };
    assert.ok(proposal.id);
    assert.ok(proposal.patch.fixedCode.includes('await fetch(url)'));

    const resource = await mcpClient.readResource({ uri: 'bailout://shadow-state' });
    const firstContent = resource.contents[0];
    assert.ok('text' in firstContent && typeof firstContent.text === 'string');
    const stateJson = JSON.parse(firstContent.text) as {
      phase: string;
      routerReady: boolean;
      pendingBailout?: { id: string };
    };
    assert.equal(stateJson.phase, 'BAILOUT_READY');
    assert.equal(stateJson.routerReady, true);
    assert.equal(stateJson.pendingBailout?.id, proposal.id);

    const acceptRes = await mcpClient.callTool({
      name: 'accept_bailout',
      arguments: { id: proposal.id, applyToDisk: true },
    });
    const acceptJson = JSON.parse(
      (acceptRes.content as Array<{ type: string; text: string }>)[0].text,
    ) as { appliedToDisk: boolean };
    assert.equal(acceptJson.appliedToDisk, true);
    assert.ok(fs.readFileSync(filePath, 'utf8').includes('await fetch(url)'));

    await mcpClient.close();
  } finally {
    await bridge.stop();
    await new Promise<void>((resolve) => routerStub.server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
