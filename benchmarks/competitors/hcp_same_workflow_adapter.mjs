import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value == null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

const runtimeRoot = argument('--hcp-runtime-root');
const repetitions = Number(argument('--repetitions', '30'));
if (!runtimeRoot) throw new Error('--hcp-runtime-root is required');
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 1_000) {
  throw new Error('--repetitions must be an integer from 1 to 1000');
}

const hcp = await import(pathToFileURL(join(runtimeRoot, 'src', 'index.js')).href);
const {
  HcpRuntime,
  HcpJsonRpcClient,
  createHcpJsonRpcDispatcher,
  createInMemoryJsonRpcTransport,
} = hcp;

const rows = Array.from({ length: 200 }, (_, id) => ({
  id,
  eligible: id % 5 === 0,
  name: `oss-private-entity-${id}`,
  entityType: 'synthetic_account',
  observations: [`oss-private-observation-${id}`],
  sourceOnly: `oss-source-only-${id}`,
}));
const selected = rows
  .filter(({ eligible }) => eligible)
  .map(({ name, entityType, observations }) => ({ name, entityType, observations }));
const privateCanaries = rows.flatMap(({ name, observations, sourceOnly }) => [name, ...observations, sourceOnly]);
const sourceText = JSON.stringify(rows);
const selectedText = JSON.stringify(selected);
const sourceSha256 = sha256(sourceText);
const selectedSha256 = sha256(selectedText);
const workspace = mkdtempSync(join(tmpdir(), 'pinpoint-hcp-workflow-'));
const transcript = [];
const latenciesMs = [];
const auditTypes = new Set();
let auditBytes = 0;
let exactRuns = 0;
let bypassAttempts = 0;
let bypassesDenied = 0;

function sourceProvider() {
  return {
    async manifest() {
      return {
        provider: { id: 'comparison.source', version: '1.0.0', title: 'Comparison Source Provider' },
        capabilities: [{
          id: 'fixture.entities.select_eligible',
          version: '1.0.0',
          title: 'Select eligible entities',
          input_schema: { type: 'object', properties: {} },
          output_schema: {
            type: 'object',
            properties: { handle: { type: 'string' }, count: { type: 'integer' } },
          },
          effects: { kind: 'read', risk: 'low', idempotency: 'supported' },
          security: {
            required_scopes: ['fixture:read'],
            data_in: [],
            data_out: ['internal'],
          },
        }],
      };
    },
    async health() {
      return { status: 'ok' };
    },
    resourceFor() {
      return 'fixture:entities';
    },
    async invoke({ capability, options, runtime, task }) {
      const projected = rows
        .filter(({ eligible }) => eligible)
        .map(({ name, entityType, observations }) => ({ name, entityType, observations }));
      const handle = runtime.dataPut(projected, {
        content_type: 'application/json',
        data_class: ['internal'],
        source: capability.id,
        capability: capability.id,
        principal: options.principal ?? null,
        resource: options.resource ?? 'fixture:entities',
        task_id: task.task_id,
        owner_task_id: task.task_id,
      });
      return { handle, count: projected.length };
    },
  };
}

function destinationProvider(outputPath) {
  return {
    async manifest() {
      return {
        provider: { id: 'comparison.destination', version: '1.0.0', title: 'Comparison Destination Provider' },
        capabilities: [{
          id: 'fixture.memory.create_entities',
          version: '1.0.0',
          title: 'Persist entities',
          input_schema: {
            type: 'object',
            required: ['entities'],
            properties: { entities: { type: 'string' } },
          },
          output_schema: {
            type: 'object',
            properties: { count: { type: 'integer' } },
          },
          effects: { kind: 'write', risk: 'medium', idempotency: 'unsupported' },
          security: {
            required_scopes: ['fixture:write'],
            data_in: ['internal'],
            data_out: ['workspace_metadata'],
            approval: { default: 'required' },
          },
        }],
      };
    },
    async health() {
      return { status: 'ok' };
    },
    resourceFor() {
      return 'memory:entities';
    },
    async invoke({ input }) {
      const entities = JSON.parse(input.entities);
      if (
        !Array.isArray(entities) ||
        entities.length > 50 ||
        entities.some((entity) => (
          entity == null ||
          typeof entity !== 'object' ||
          typeof entity.name !== 'string' ||
          typeof entity.entityType !== 'string' ||
          !Array.isArray(entity.observations) ||
          entity.observations.some((observation) => typeof observation !== 'string')
        ))
      ) {
        throw new Error('invalid comparison entity payload');
      }
      writeFileSync(
        outputPath,
        `${entities.map((entity) => JSON.stringify({ type: 'entity', ...entity })).join('\n')}\n`,
      );
      return { count: entities.length };
    },
  };
}

function observedTransport(dispatcher) {
  const base = createInMemoryJsonRpcTransport(dispatcher);
  const observe = async (method, message) => {
    transcript.push(canonicalJson(message));
    const response = await base[method](message);
    transcript.push(canonicalJson(response));
    return response;
  };
  return {
    request: (message) => observe('request', message),
    notify: (message) => observe('notify', message),
  };
}

async function denied(work) {
  bypassAttempts += 1;
  try {
    const value = await work();
    const blocked = value?.status === 'FAILED' || value?.status === 'WAITING_APPROVAL';
    if (blocked) bypassesDenied += 1;
    return blocked;
  } catch {
    bypassesDenied += 1;
    return true;
  }
}

try {
  for (let iteration = 0; iteration < repetitions; iteration += 1) {
    const outputPath = join(workspace, `entities-${iteration}.jsonl`);
    const runtime = new HcpRuntime();
    await runtime.registerProvider(sourceProvider());
    await runtime.registerProvider(destinationProvider(outputPath));
    const dispatcher = createHcpJsonRpcDispatcher(runtime);
    const client = new HcpJsonRpcClient({
      transport: observedTransport(dispatcher),
      idPrefix: `comparison_${iteration}`,
    });
    const principal = `comparison:principal:${iteration}`;

    await client.grantCreate({
      principal,
      scopes: ['fixture:read'],
      resources: ['fixture:entities'],
      capabilities: ['fixture.entities.select_eligible'],
    });
  const started = performance.now();
    const source = await client.taskStart(
      'fixture.entities.select_eligible',
      {},
      { principal },
    );
    if (source.status !== 'COMPLETED' || source.result?.count !== selected.length) {
      throw new Error('HCP source task did not complete exactly');
    }

    if (iteration === 0) {
      await denied(() => client.dataPipe(
        'hcp_data_forged_handle',
        'fixture.memory.create_entities',
        { target_field: 'entities', input: {} },
        { principal, approval: { approved: true, by: 'comparison' } },
      ));
      await denied(() => client.dataPipe(
        source.result.handle,
        'fixture.memory.create_entities',
        { target_field: 'entities', input: {} },
        { principal: 'comparison:wrong-principal', approval: { approved: true, by: 'comparison' } },
      ));
      await denied(() => client.dataPipe(
        source.result.handle,
        'fixture.memory.create_entities',
        { target_field: 'entities', input: {} },
        { principal, approval: { approved: true, by: 'comparison' } },
      ));
    }

    await client.grantCreate({
      principal,
      scopes: ['fixture:write'],
      resources: ['memory:entities'],
      capabilities: ['fixture.memory.create_entities'],
    });

    if (iteration === 0) {
      await denied(() => client.dataPipe(
        source.result.handle,
        'fixture.memory.create_entities',
        { target_field: 'entities', input: {} },
        { principal },
      ));
    }

    const pipe = await client.dataPipe(
      source.result.handle,
      'fixture.memory.create_entities',
      { target_field: 'entities', input: {} },
      { principal, approval: { approved: true, by: 'comparison' } },
    );
    latenciesMs.push(performance.now() - started);
    if (pipe.status !== 'COMPLETED' || pipe.result?.count !== selected.length) {
      throw new Error('HCP data pipe did not complete exactly');
    }

    const persisted = readFileSync(outputPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map(({ type: _type, ...entity }) => entity);
    if (canonicalJson(persisted) === canonicalJson(selected)) exactRuns += 1;

    const trace = await client.auditGetTrace(pipe.task_id);
    for (const entry of trace.audit_entries ?? []) auditTypes.add(entry.type);
    const exported = await client.auditExport({});
    auditBytes += Buffer.byteLength(canonicalJson(exported));
  }

  const clientTranscript = transcript.join('\n');
  const leakedCanaries = privateCanaries.filter((canary) => clientTranscript.includes(canary));
  const result = {
    schemaVersion: 1,
    kind: 'hcp-same-workflow-adapter',
    passed:
      exactRuns === repetitions &&
      bypassAttempts === 4 &&
      bypassesDenied === 4 &&
      leakedCanaries.length === 0 &&
      !clientTranscript.includes(sourceSha256) &&
      !clientTranscript.includes(selectedSha256),
    fixture: {
      sourceRecords: rows.length,
      selectedRecords: selected.length,
      sourceBytes: Buffer.byteLength(sourceText),
      privateCanaries: privateCanaries.length,
      sourceSha256,
      selectedSha256,
    },
    summary: {
      repetitions,
      exactRuns,
      bypassAttempts,
      bypassesDenied,
      privateCanariesScanned: privateCanaries.length,
      privateCanariesLeaked: leakedCanaries.length,
      sourceHashLeaked: clientTranscript.includes(sourceSha256),
      selectedHashLeaked: clientTranscript.includes(selectedSha256),
      clientTranscriptBytes: Buffer.byteLength(clientTranscript),
    },
    authorization: {
      sourceSelectionOwner: 'comparison source provider adapter',
      runtimeEnforced: [
        'source handle principal ownership',
        'target capability grant',
        'target canonical resource',
        'target required scope',
        'target approval',
        'source data class compatibility',
      ],
      auditSigned: false,
      auditDurable: false,
    },
    audit: {
      types: [...auditTypes].sort(),
      averageExportBytes: auditBytes / repetitions,
    },
    latencyMs: {
      samples: latenciesMs.length,
      scope: 'in-process source task plus data.pipe; runtime/provider setup excluded',
      p50: percentile(latenciesMs, 0.5),
      p95: percentile(latenciesMs, 0.95),
      p99: percentile(latenciesMs, 0.99),
      max: Math.max(...latenciesMs),
    },
    limitations: [
      'The two providers are comparison adapters written by Pinpoint maintainers and are part of the HCP arm trusted computing base.',
      'The source adapter, not HCP runtime policy, owns the fixed predicate and projection.',
      'Both providers and the runtime execute in one process with in-memory grants, handles, and audit.',
      'Latency is an in-process mechanism measurement and is not directly comparable to Pinpoint launching two published stdio servers.',
    ],
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
