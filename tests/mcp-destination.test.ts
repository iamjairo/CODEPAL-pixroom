import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { McpDestinationPeer } from '../src/mcp/destination.js';

const destinationServer = String.raw`
  import { createInterface } from 'node:readline';
  process.stderr.write('PRIVATE_DESTINATION_STDERR\n');
  process.stdout.write('PRIVATE_NON_JSON_OUTPUT\n');
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'private-destination', version: '1.0.0' },
        },
      }) + '\n');
    } else if (message.method === 'notifications/initialized') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'destination-request', method: 'sampling/createMessage' }) + '\n');
    } else if (message.id === 'destination-request') {
      // The peer rejects server requests locally; no value reaches its caller.
    } else if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'private_write', inputSchema: { type: 'object' } }] },
      }) + '\n');
    } else if (message.method === 'tools/call') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({
            received: message.params.arguments,
            destinationOnly: process.env.DESTINATION_ONLY ?? null,
            sourceOnly: process.env.SOURCE_ONLY ?? null,
            requestId: message.id,
          }) }],
        },
      }) + '\n');
    }
  }
`;

describe('private MCP destination peer', () => {
  it('initializes, catalogs, and calls a destination with an isolated request namespace and environment', async () => {
    process.env.SOURCE_ONLY = 'must-not-cross';
    const diagnostics = new PassThrough();
    let diagnosticText = '';
    diagnostics.on('data', (chunk) => { diagnosticText += String(chunk); });
    const peer = new McpDestinationPeer({
      id: 'crm',
      command: process.execPath,
      args: ['--input-type=module', '--eval', destinationServer],
      env: { DESTINATION_ONLY: 'destination-domain' },
    }, (message) => diagnostics.write(message));

    try {
      const catalog = await peer.initialize('2024-11-05');
      expect(catalog).toEqual(new Set(['private_write']));
      expect(peer.state).toBe('ready');

      const result = await peer.callTool('private_write', { records: [{ id: 7 }] });
      const payload = JSON.parse(result.content[0]?.text ?? '{}');
      expect(payload).toMatchObject({
        received: { records: [{ id: 7 }] },
        destinationOnly: 'destination-domain',
        sourceOnly: null,
      });
      expect(payload.requestId).toMatch(/^pinpoint-destination:/);
      expect(diagnosticText).toContain('destination stderr suppressed');
      expect(diagnosticText).not.toContain('PRIVATE_DESTINATION_STDERR');
      expect(diagnosticText).not.toContain('PRIVATE_NON_JSON_OUTPUT');
    } finally {
      delete process.env.SOURCE_ONLY;
      await peer.close();
    }
    expect(peer.state).toBe('closed');
  });
});