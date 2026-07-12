// Shared benchmark helpers: Copilot-shaped payloads, the live prompt suite,
// consistent token accounting, and markdown utilities.
//
// Token accounting (offline arm): a SINGLE consistent basis across configs so the
// comparison is fair — gpt-tokenizer for text (base64 image data stripped) PLUS
// pxpipe's image-token estimate (pixels / 750) for imaged regions. Absolute counts
// are not Anthropic-exact, but RELATIVE savings across configs are apples-to-apples.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'gpt-tokenizer';

export function countTokens(text) {
  return encode(text).length;
}

// ── Copilot-shaped request payloads ─────────────────────────────────────────

/** A large, static coding-agent system prompt + tool schemas (the optical slab). */
export function makeSystemSlab() {
  const preamble = [
    'You are a meticulous senior software engineer operating as an autonomous coding agent.',
    'Follow the repository conventions exactly. Prefer the standard library over new dependencies.',
    'Keep changes minimal, reversible, and well-scoped. Never break unrelated flows.',
    'Read files before editing them. Validate every change with the available tools.',
    'When uncertain, gather context with search and read tools before acting.',
  ].join(' ');
  const guidance = [];
  for (let i = 0; i < 60; i++) {
    guidance.push(
      `Guideline ${i + 1}: When handling task category ${i + 1}, first inspect the relevant module, ` +
        `then outline the change, then apply it in the smallest safe increment, then verify with tests ` +
        `and linters before moving on. Prefer explicit error handling only at genuine system boundaries.`,
    );
  }
  const tools = [];
  for (const name of ['read_file', 'edit_file', 'run_terminal', 'grep_search', 'file_search', 'list_dir']) {
    tools.push({
      name,
      description:
        `Use ${name} to perform its namesake operation. Provide precise arguments. This tool is ` +
        `expensive; batch calls when possible. Returns structured results the agent must parse ` +
        `carefully. Respect workspace boundaries and never operate outside the project root. ` +
        `Handles large outputs by truncation; request specific ranges to stay efficient.`,
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative path.' },
          query: { type: 'string', description: 'Search query or command to execute.' },
          maxResults: { type: 'number', description: 'Cap on returned results.' },
        },
        required: ['path'],
      },
    });
  }
  return `${preamble}\n\n${guidance.join('\n')}\n\nTOOL REFERENCE:\n${JSON.stringify(tools, null, 2)}`;
}

/** A large JSON tool output (SmartCrusher target). */
export function makeJsonToolResult(rows = 150) {
  const data = [];
  for (let i = 0; i < rows; i++) {
    data.push({
      id: i,
      name: `record_${i}`,
      email: `user${i}@example.com`,
      score: (i * 37) % 100,
      active: i % 2 === 0,
      tags: ['alpha', 'beta', 'gamma'].slice(0, (i % 3) + 1),
      updatedAt: `2026-07-${String((i % 28) + 1).padStart(2, '0')}T12:00:00Z`,
    });
  }
  return JSON.stringify(data, null, 2);
}

/** A large build/test log (LogCompressor target). */
export function makeLogToolResult(lines = 400) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    const lvl = i % 17 === 0 ? 'WARN' : i % 41 === 0 ? 'ERROR' : 'INFO';
    out.push(
      `2026-07-10T12:00:${String(i % 60).padStart(2, '0')}.123Z ${lvl} [worker-${i % 8}] ` +
        `compiled module ${i} in ${(i % 500) + 5}ms (cache ${i % 2 ? 'hit' : 'miss'})`,
    );
  }
  return out.join('\n');
}

/** Real repository source concatenated (CodeAwareCompressor target). */
export function makeCodeToolResult(repoRoot) {
  const files = ['src/proxy/server.ts', 'src/router/content-router.ts', 'src/wrap/runner.ts'];
  const parts = [];
  for (const f of files) {
    try {
      parts.push(`// FILE: ${f}\n${readFileSync(join(repoRoot, f), 'utf8')}`);
    } catch {
      /* skip missing */
    }
  }
  return parts.join('\n\n');
}

/** Build the benchmark payloads (Anthropic Messages shape). */
export function buildPayloads(repoRoot) {
  const system = [{ type: 'text', text: makeSystemSlab(), cache_control: { type: 'ephemeral' } }];
  const mk = (name, description, toolText, toolId) => ({
    name,
    description,
    body: {
      model: 'claude-fable-5',
      system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze the attached tool output and summarize the key facts.' },
            { type: 'tool_result', tool_use_id: toolId, content: toolText },
          ],
        },
      ],
    },
  });
  return [
    mk('json-data', 'Large JSON API response (150 rows)', makeJsonToolResult(150), 't_json'),
    mk('build-log', 'Verbose build/test log (400 lines)', makeLogToolResult(400), 't_log'),
    mk('source-code', 'Concatenated TypeScript source', makeCodeToolResult(repoRoot), 't_code'),
  ];
}

/** Effective input tokens for a routed body: text (base64 stripped) + optical image tokens. */
export function effectiveTokens(routedBody, report) {
  const imageTokens = report.rows
    .filter((r) => r.stage === 'optical' && r.applied)
    .reduce((a, r) => a + r.tokensCompressed, 0);
  const clone = structuredClone(routedBody);
  stripImages(clone);
  return countTokens(JSON.stringify(clone)) + imageTokens;
}

function stripImages(obj) {
  if (Array.isArray(obj)) {
    for (const v of obj) stripImages(v);
    return;
  }
  if (obj && typeof obj === 'object') {
    if (obj.type === 'image' && obj.source && typeof obj.source === 'object') {
      obj.source.data = '';
    }
    for (const v of Object.values(obj)) stripImages(v);
  }
}

// ── Live Copilot prompt suite (correctness-checkable) ────────────────────────

export function countTsFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) n += countTsFiles(p);
    else if (e.endsWith('.ts')) n += 1;
  }
  return n;
}

export function copilotSuite(repoRoot) {
  const tsCount = countTsFiles(join(repoRoot, 'src'));
  return [
    {
      id: 'echo',
      kind: 'exact',
      prompt: 'Reply with exactly this token and nothing else: BENCH_ECHO_7Q',
      check: (out) => /BENCH_ECHO_7Q/.test(out),
      expected: 'BENCH_ECHO_7Q',
    },
    {
      id: 'math',
      kind: 'reasoning',
      prompt: 'Compute 1234 * 5678. Reply with only the integer, no commas.',
      check: (out) => /7006652/.test(out.replace(/,/g, '')),
      expected: '7006652',
    },
    {
      id: 'files',
      kind: 'agentic-tool',
      prompt:
        'How many files ending in .ts are under the src directory (recursively) of this repository? Reply with only the number.',
      check: (out) => new RegExp(`\\b${tsCount}\\b`).test(out),
      expected: String(tsCount),
    },
    {
      id: 'classes',
      kind: 'verbatim-fidelity',
      prompt:
        'Name the two exported compressor classes defined in src/compressors/optical.ts and src/compressors/semantic.ts. Reply as a comma-separated list.',
      check: (out) => /OpticalCompressor/.test(out) && /SemanticCompressor/.test(out),
      expected: 'OpticalCompressor, SemanticCompressor',
    },
    {
      id: 'summary',
      kind: 'gist',
      prompt: 'In one sentence, what is the purpose of src/wrap/runner.ts in this repository?',
      check: (out) => /(wrap|launch|delegat|copilot|agent|proxy)/i.test(out),
      expected: '(gist: launches/delegates wrapped agents)',
    },
  ];
}

// ── output parsing ───────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(s) {
  return s.replace(ANSI, '');
}

/** Extract the agent's actual answer from noisy wrap/proxy output. */
export function extractAnswer(clean) {
  const NOISE =
    /[╔╚║╗╝═┃●▪]|HEADROOM|Starting proxy|Proxy ready|Proxy on|Launching|COPILOT_|Logs:|Dashboard|Extra args|\brtk\b|Rust Token|pixroom wrap|delegating to headroom|Copilot compression|savings appear|Setting up|Downloading|installed at|instructions injected|Resume|^Changes\b/i;
  const lines = clean
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l));
  const footerIdx = lines.findIndex((l) => /^(Tokens|Duration|Total duration)\b/.test(l));
  const bodyLines = footerIdx >= 0 ? lines.slice(0, footerIdx) : lines;
  return bodyLines.slice(-4).join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** Parse Copilot's "Tokens ↑ 16.1k • ↓ 5" summary. Returns {input,output} or null. */
export function parseTokens(text) {
  const clean = stripAnsi(text);
  const up = clean.match(/[↑▲]\s*([\d.]+\s*[kmKM]?)/);
  const down = clean.match(/[↓▼]\s*([\d.]+\s*[kmKM]?)/);
  if (!up && !down) return null;
  return {
    input: up ? toNumber(up[1]) : null,
    output: down ? toNumber(down[1]) : null,
  };
}

function toNumber(raw) {
  const m = String(raw).trim().match(/([\d.]+)\s*([kmKM]?)/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const suf = m[2].toLowerCase();
  if (suf === 'k') n *= 1000;
  else if (suf === 'm') n *= 1000000;
  return Math.round(n);
}

// ── markdown ─────────────────────────────────────────────────────────────────

export function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  return [line(headers), sep, ...rows.map((r) => line(r))].join('\n');
}

export function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}
