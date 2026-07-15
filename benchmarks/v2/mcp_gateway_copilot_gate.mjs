import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(root, 'bin', 'cli.js');
const expected = 'user733@example.com';
const temporary = mkdtempSync(join(tmpdir(), 'pinpoint-copilot-mcp-gate-'));

const upstream = String.raw`
  import { createInterface } from 'node:readline';
  const rows = Array.from({ length: 1000 }, (_, accountId) => ({
    accountId,
    email: 'user' + accountId + '@example.com',
    active: accountId % 2 === 0,
    region: ['us-east', 'eu-west', 'ap-south'][accountId % 3],
  }));
  const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send(message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'accounts', version: '1.0.0' },
      });
    } else if (message.method === 'tools/list') {
      send(message.id, {
        tools: [{
          name: 'accounts_list',
          description: 'Return every account. This upstream API has no filtering parameter.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: {
            type: 'object',
            properties: {
              requestId: { type: 'string' },
              data: { type: 'object' },
            },
            required: ['requestId', 'data'],
          },
        }],
      });
    } else if (message.method === 'tools/call') {
      send(message.id, {
        content: [{ type: 'text', text: 'Returned 1000 accounts in structured content.' }],
        structuredContent: { requestId: 'synthetic_gate', data: { accounts: rows } },
      });
    }
  }
`;

const config = JSON.stringify({
  mcpServers: {
    accounts: {
      type: 'local',
      command: process.execPath,
      args: [
        cli,
        'mcp',
        'gateway',
        '--min-chars',
        '1000',
        '--',
        process.execPath,
        '--input-type=module',
        '--eval',
        upstream,
      ],
      tools: ['*'],
    },
  },
});

function runCopilot() {
  const args = [
    '--prompt',
    'Use the accounts MCP server to find the email for accountId 733. Return only the email address. Do not use repository files or shell commands.',
    '--model',
    'auto',
    '--output-format',
    'json',
    '--stream',
    'off',
    '--additional-mcp-config',
    config,
    '--disable-builtin-mcps',
    '--available-tools=accounts',
    '--allow-tool=accounts',
    '--no-ask-user',
    '--no-remote-export',
    '--log-level',
    'error',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('copilot', args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let exceeded = false;
    const timeout = setTimeout(() => child.kill('SIGTERM'), 120_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 5_000_000) {
        exceeded = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, exceeded });
    });
  });
}

function nestedStrings(value, keyPattern, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) nestedStrings(item, keyPattern, found);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (keyPattern.test(key) && typeof item === 'string') found.push(item);
      nestedStrings(item, keyPattern, found);
    }
  }
  return found;
}

try {
  const run = await runCopilot();
  const events = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const serialized = events.map((event) => JSON.stringify(event));
  const upstreamCalled = serialized.some((line) => line.includes('accounts_list'));
  const queryCalled = serialized.some(
    (line) => line.includes('pinpoint_query') && line.includes('vctx_28a153ae144607feab1b3cf97a0d785e'),
  );
  const artifactIds = [...new Set(
    serialized.flatMap((line) => line.match(/vctx_[a-f0-9]{32,64}/g) ?? []),
  )];
  const answers = events.flatMap((event) => nestedStrings(event, /^(?:content|result|text)$/i));
  const answer = [...answers].reverse().find((value) => value.trim() === expected)?.trim() ?? '';
  const toolCompletions = events.filter((event) => event.type === 'tool.execution_complete');
  const maxToolCompletionEventChars = Math.max(
    0,
    ...toolCompletions.map((event) => JSON.stringify(event).length),
  );
  const resultEvent = [...events].reverse().find((event) => event.type === 'result');
  const models = [...new Set(events.flatMap((event) => nestedStrings(event, /^model$/i)))];
  const passed =
    run.code === 0 &&
    !run.exceeded &&
    upstreamCalled &&
    queryCalled &&
    artifactIds.length === 1 &&
    maxToolCompletionEventChars < 10_000 &&
    answer === expected;

  console.log(JSON.stringify({
    passed,
    agentExitCode: run.code,
    upstreamCalled,
    queryCalled,
    toolCalls: ['accounts_list', 'pinpoint_query'],
    artifactIds,
    maxToolCompletionEventChars,
    answer,
    expected,
    models,
    eventTypes: [...new Set(events.map((event) => event.type))],
    usage: resultEvent?.usage ?? null,
  }, null, 2));

  if (!passed) {
    const redacted = run.stderr
      .replace(/(?:gh[opsu]_|sk-)[A-Za-z0-9_-]+/g, '[REDACTED]')
      .slice(-4_000);
    if (redacted.trim()) console.error(redacted);
    process.exitCode = 1;
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}