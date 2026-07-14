import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProcessorIntegration } from '../src/kernel/types.js';
import { createPinpoint, createRuntime } from '../src/pinpoint.js';
import { closeTestServer } from './helpers/http.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeTestServer));
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}/v1/traces`;
}

describe('OTLP HTTP telemetry', () => {
  it('exports content-free optimization spans and flushes on shutdown', async () => {
    const requests: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    const endpoint = await listen(
      http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          requests.push({
            headers: request.headers,
            body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
          });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
        });
      }),
    );
    const runtime = createPinpoint({
      telemetry: {
        endpoint,
        headers: { authorization: 'Bearer collector-test' },
        serviceName: 'pinpoint-test',
        timeoutMs: 1_000,
      },
      virtualContext: { enabled: false },
      semantic: { enabled: false },
      optical: { enabled: false },
      logLevel: 'silent',
    });

    await runtime.route(
      'openai',
      'gpt-test',
      { model: 'gpt-test', messages: [{ role: 'user', content: 'private prompt text' }] },
      'payg',
    );
    await runtime.shutdown();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.authorization).toBe('Bearer collector-test');
    const serialized = JSON.stringify(requests[0]?.body);
    expect(serialized).toContain('pinpoint.optimize');
    expect(serialized).toContain('pinpoint-test');
    expect(serialized).toContain('pinpoint.tokens.saved');
    expect(serialized).not.toContain('private prompt text');
    expect(runtime.telemetry.stats()).toEqual({ queued: 0, exported: 1, failed: 0, dropped: 0 });
  });

  it('does not export private text thrown by an integration', async () => {
    const requests: Record<string, unknown>[] = [];
    const endpoint = await listen(
      http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
        });
      }),
    );
    const secret = 'private prompt leaked through an exception';
    const throwing: ProcessorIntegration = {
      id: 'test.throwing',
      version: 'test',
      order: 1,
      capabilities: { regions: ['current-turn'], fidelity: 'lossless', cacheImpact: 'preserve' },
      async propose() {
        throw new Error(secret);
      },
    };
    const runtime = createRuntime({
      includeBuiltinIntegrations: false,
      integrations: [throwing],
      config: {
        telemetry: { endpoint, timeoutMs: 1_000 },
        semantic: { enabled: false },
        optical: { enabled: false },
        logLevel: 'silent',
      },
    });

    await runtime.route(
      'openai',
      'gpt-test',
      { model: 'gpt-test', messages: [{ role: 'user', content: secret }] },
      'payg',
    );
    await runtime.shutdown();

    const serialized = JSON.stringify(requests);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('test.throwing: proposal_failed');
  });

  it('does not fail routing when the collector rejects a span', async () => {
    const endpoint = await listen(
      http.createServer((request, response) => {
        request.resume();
        request.on('end', () => {
          response.writeHead(503);
          response.end('unavailable');
        });
      }),
    );
    const runtime = createPinpoint({
      telemetry: { endpoint, timeoutMs: 1_000 },
      virtualContext: { enabled: false },
      semantic: { enabled: false },
      optical: { enabled: false },
      logLevel: 'silent',
    });

    const routed = await runtime.route(
      'openai',
      'gpt-test',
      { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] },
      'payg',
    );
    await runtime.shutdown();

    expect(routed.body).toMatchObject({ model: 'gpt-test' });
    expect(runtime.telemetry.stats()).toEqual({ queued: 0, exported: 0, failed: 1, dropped: 0 });
  });
});