import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resultPath = join(
  root,
  'benchmarks',
  'results',
  'hcp-comparison.first-party-macos-arm64-20260716.json',
);
const hcpRepository = 'https://github.com/SymbolicLight-AGI/handle-capability-protocol.git';
const hcpCommit = 'e7eb50158f3d495f1dc99a2755abe08f0d0db716';
const fidesGatewayCommit = '3f39af1b38a9b6883064b3f79b6bb32661fa72af';
const temporary = mkdtempSync(join(tmpdir(), 'pinpoint-hcp-comparison-'));
const hcpRoot = join(temporary, 'handle-capability-protocol');
const adapterPath = join(root, 'benchmarks', 'competitors', 'hcp_same_workflow_adapter.mjs');
const pinpointGatePath = join(root, 'benchmarks', 'v2', 'mcp_oss_cross_server_gate.mjs');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function fingerprint(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseJsonOutput(runResult, label) {
  if (runResult.status !== 0) {
    throw new Error(`${label} failed: ${runResult.stderr.slice(-2_000)}`);
  }
  try {
    return JSON.parse(runResult.stdout);
  } catch (cause) {
    throw new Error(`${label} did not return JSON: ${cause.message}`);
  }
}

function integerMatch(text, pattern, label) {
  const value = text.match(pattern)?.[1];
  if (value == null) throw new Error(`HCP test output is missing ${label}`);
  return Number(value);
}

function sourceLines(path) {
  return readFileSync(path, 'utf8').split('\n').length;
}

function nonCommentLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('//'))
    .length;
}

try {
  const beforeStatus = run('git', ['status', '--short'], { cwd: root }).stdout;
  const clone = run('git', ['clone', '--quiet', '--no-tags', hcpRepository, hcpRoot]);
  if (clone.status !== 0) throw new Error(`HCP clone failed: ${clone.stderr.slice(-2_000)}`);
  const checkout = run('git', ['checkout', '--quiet', '--detach', hcpCommit], { cwd: hcpRoot });
  if (checkout.status !== 0) throw new Error(`HCP checkout failed: ${checkout.stderr.slice(-2_000)}`);
  const checkedCommit = run('git', ['rev-parse', 'HEAD'], { cwd: hcpRoot }).stdout.trim();
  if (checkedCommit !== hcpCommit) throw new Error(`HCP commit mismatch: ${checkedCommit}`);

  const hcpRuntimeRoot = join(hcpRoot, 'hcp-runtime');
  const hcpTests = run('npm', ['test'], { cwd: hcpRuntimeRoot });
  const hcpTestOutput = `${hcpTests.stdout}${hcpTests.stderr}`;
  const hcpTestFailures = [...new Set(
    [...hcpTestOutput.matchAll(/^✖ (.+?) \([\d.]+ms\)$/gm)].map((match) => match[1]),
  )];
  const hcpTestGrade = {
    exitCode: hcpTests.status,
    tests: integerMatch(hcpTestOutput, /ℹ tests (\d+)/, 'test count'),
    passed: integerMatch(hcpTestOutput, /ℹ pass (\d+)/, 'pass count'),
    failed: integerMatch(hcpTestOutput, /ℹ fail (\d+)/, 'failure count'),
    failures: hcpTestFailures,
    expectedPublicCommitFailurePreserved:
      hcpTests.status === 1 &&
      hcpTestFailures.includes('release metadata stays aligned with v1 alpha readiness positioning'),
  };

  const hcpDemo = run('npm', ['run', 'demo:datapipe'], { cwd: hcpRuntimeRoot });
  const hcpDemoPassed = hcpDemo.status === 0 && hcpDemo.stdout.includes('data-pipe-demo-ok');
  const hcpArm = parseJsonOutput(run(process.execPath, [
    adapterPath,
    '--hcp-runtime-root',
    hcpRuntimeRoot,
    '--repetitions',
    '30',
  ], { cwd: root }), 'HCP same-workflow adapter');

  const pinpointArm = parseJsonOutput(
    run(process.execPath, [pinpointGatePath], { cwd: root }),
    'Pinpoint same-workflow gate',
  );
  const afterStatus = run('git', ['status', '--short'], { cwd: root }).stdout;
  const hcpStatus = run('git', ['status', '--short'], { cwd: hcpRoot }).stdout;
  const fixtureMatched =
    hcpArm.fixture.sourceSha256 === pinpointArm.fixture.sourceSha256 &&
    hcpArm.fixture.selectedSha256 === pinpointArm.fixture.selectedSha256 &&
    hcpArm.fixture.sourceRecords === pinpointArm.fixture.sourceRecords &&
    hcpArm.fixture.selectedRecords === pinpointArm.fixture.selectedRecords &&
    hcpArm.fixture.privateCanaries === pinpointArm.fixture.privateCanaries;

  const result = {
    schemaVersion: 1,
    evidenceLevel: 'comparative-mechanism-evaluation',
    kind: 'pinpoint-vs-hcp-same-workflow',
    date: new Date().toISOString().slice(0, 10),
    passed:
      pinpointArm.passed === true &&
      hcpArm.passed === true &&
      hcpDemoPassed &&
      fixtureMatched &&
      hcpTestGrade.expectedPublicCommitFailurePreserved &&
      hcpStatus === '' &&
      beforeStatus === afterStatus,
    environment: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      node: process.version,
    },
    pins: {
      pinpointCommit: run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim(),
      pinpointVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
      hcpRepository,
      hcpCommit,
      hcpRuntimeVersion: '0.3.0',
    },
    fixture: {
      matched: fixtureMatched,
      sourceRecords: pinpointArm.fixture.sourceRecords,
      selectedRecords: pinpointArm.fixture.selectedRecords,
      privateCanaries: pinpointArm.fixture.privateCanaries,
      sourceSha256: pinpointArm.fixture.sourceSha256,
      selectedSha256: pinpointArm.fixture.selectedSha256,
    },
    repositoryValidation: {
      pinpointCurrentSuite: 'validated separately by npm test; not rerun inside this comparison process',
      hcp: hcpTestGrade,
      hcpNativeDataPipeDemoPassed: hcpDemoPassed,
      hcpCloneCleanAfterRun: hcpStatus === '',
      pinpointWorktreeUnchangedByGate: beforeStatus === afterStatus,
    },
    commonOutcome: {
      pinpoint: {
        exactPersistedProjection: pinpointArm.summary.exactPersistedProjection,
        exactRuns: 1,
        bypassesDenied: `${pinpointArm.summary.bypassesDenied}/${pinpointArm.summary.bypassAttempts}`,
        bypassClasses: [
          'direct hidden destination',
          'forged capability',
          'fixed-predicate override',
          'forbidden projection',
        ],
        canariesLeaked: `${pinpointArm.summary.privateCanariesLeaked}/${pinpointArm.summary.privateCanariesScanned}`,
      },
      hcp: {
        exactPersistedProjection: hcpArm.summary.exactRuns === hcpArm.summary.repetitions,
        exactRuns: hcpArm.summary.exactRuns,
        repetitions: hcpArm.summary.repetitions,
        bypassesDenied: `${hcpArm.summary.bypassesDenied}/${hcpArm.summary.bypassAttempts}`,
        bypassClasses: [
          'forged handle',
          'wrong source principal',
          'missing target grant',
          'missing target approval',
        ],
        canariesLeaked: `${hcpArm.summary.privateCanariesLeaked}/${hcpArm.summary.privateCanariesScanned}`,
      },
    },
    authorityAndEvidence: {
      pinpoint: {
        sourceSelectionOwner: 'versioned operator flow policy',
        runtimeEnforced: [
          'fixed predicate and projection',
          'source provenance and random capability',
          'hidden destination and destination server id',
          'item and byte limits',
          'separate process catalogs and destination-exclusive environment names',
        ],
        evidence: 'operator-rooted Ed25519 signed receipt with HMAC commitments and hash chain',
        evidenceDurability: 'returned to caller; external retention required',
      },
      hcp: {
        sourceSelectionOwner: hcpArm.authorization.sourceSelectionOwner,
        runtimeEnforced: hcpArm.authorization.runtimeEnforced,
        evidence: 'rich unsigned task and data-pipe audit trace',
        evidenceDurability: 'in-memory in the reference runtime',
      },
    },
    interoperabilityAndTcb: {
      pinpoint: {
        providers: 'two pinned unmodified published MCP packages',
        logicalProcesses: 3,
        relevantSourceLines: [
          'src/mcp/destination.ts',
          'src/mcp/flow.ts',
          'src/mcp/gateway.ts',
          'src/virtual-context/store.ts',
        ].reduce((sum, path) => sum + sourceLines(join(root, path)), 0),
      },
      hcp: {
        providers: 'two comparison-specific HCP-native adapters',
        logicalProcesses: 1,
        runtimeSourceLines: [
          'src/runtime.js',
          'src/jsonrpc.js',
          'src/provider-sdk.js',
        ].reduce((sum, path) => sum + sourceLines(join(hcpRuntimeRoot, path)), 0),
        adapterNonCommentLines: nonCommentLines(adapterPath),
      },
      warning: 'Line counts and process counts describe reviewed surfaces; they are not security scores.',
    },
    timing: {
      pinpoint: {
        elapsedMs: pinpointArm.summary.elapsedMs,
        scope: 'cold gateway plus two npx-launched published stdio servers and one flow',
      },
      hcp: hcpArm.latencyMs,
      comparableRanking: false,
      reason: 'HCP is an in-process mechanism timing with setup excluded; Pinpoint includes cold process/package startup.',
    },
    fidesGateway: {
      commitInspected: fidesGatewayCommit,
      includedAsScoredArm: false,
      reason: 'The public gateway evaluates and reports policy decisions but does not provide a faithful policy-bound hidden source-to-destination dispatch for this workflow. Adding one would create a new system rather than evaluate Fides.',
    },
    source: {
      fingerprints: {
        'benchmarks/competitors/hcp_same_workflow_adapter.mjs': fingerprint(adapterPath),
        'benchmarks/v2/hcp_comparison_gate.mjs': fingerprint(fileURLToPath(import.meta.url)),
        'benchmarks/v2/mcp_oss_cross_server_gate.mjs': fingerprint(pinpointGatePath),
        'hcp-runtime/src/runtime.js': fingerprint(join(hcpRuntimeRoot, 'src', 'runtime.js')),
        'hcp-runtime/src/jsonrpc.js': fingerprint(join(hcpRuntimeRoot, 'src', 'jsonrpc.js')),
        'hcp-runtime/src/provider-sdk.js': fingerprint(join(hcpRuntimeRoot, 'src', 'provider-sdk.js')),
      },
    },
    verdict: {
      winner: null,
      pinpointStrengths: [
        'unmodified MCP interoperability',
        'operator-fixed exact row/field policy and bounds',
        'separate source/destination processes and environment filtering',
        'signed operator-rooted receipts',
      ],
      hcpStrengths: [
        'principal-bound handle ownership',
        'grant, scope, canonical-resource, capability, approval, and data-class checks',
        'richer deny-path audit semantics',
        'lower-complexity in-process mechanism topology',
      ],
      fieldClaim: 'The systems solve overlapping but non-identical layers. The result supports Pinpoint as a distinct interoperability and disclosure-bounded execution mechanism, not universal superiority.',
    },
    limitations: [
      'Both same-workflow adapters and this harness were authored by Pinpoint maintainers; this is not independent validation.',
      'The HCP source adapter owns the fixed predicate/projection because HCP runtime policy does not express row-level selection.',
      'The Pinpoint arm uses two unmodified published MCP packages; the HCP arm uses two comparison-specific native providers.',
      'Native denial classes differ and are reported by name rather than collapsed into one security score.',
      'Timing scopes differ materially and no speed ranking is claimed.',
      'HCP public commit repository-test failures are preserved and do not invalidate its separately passing data-pipe mechanism arm.',
    ],
  };

  if (process.argv.includes('--write')) writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
