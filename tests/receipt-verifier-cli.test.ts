import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { McpOpaqueFlowEngine, parseMcpOpaqueFlowConfig } from '../src/mcp/flow.js';
import { VirtualContextStore, type VirtualContextQuery } from '../src/virtual-context/store.js';

const receiptPath = join(
  process.cwd(),
  'benchmarks',
  'results',
  'mcp-opaque-flow.first-party-macos-arm64-20260715.json',
);
const verifier = join(process.cwd(), 'bin', 'verify-receipt.js');

describe('standalone opaque-flow receipt verifier', () => {
  it('verifies the committed receipt without importing Pinpoint runtime code', () => {
    const source = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const output = JSON.parse(execFileSync(process.execPath, [
      verifier,
      receiptPath,
      '--path',
      'firstReceipt',
      '--signing-key-id',
      source.firstReceipt.signingKeyId,
    ], { encoding: 'utf8' }));

    expect(output).toMatchObject({
      valid: true,
      receiptHash: source.firstReceipt.receiptHash,
      signingKeyId: source.firstReceipt.signingKeyId,
      sequence: 1,
    });
  });

  it('rejects a modified receipt and a mismatched pinned key', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'pinpoint-receipt-verifier-'));
    try {
      const source = JSON.parse(readFileSync(receiptPath, 'utf8'));
      source.firstReceipt.items += 1;
      const tampered = join(temporary, 'tampered.json');
      writeFileSync(tampered, JSON.stringify(source));
      const tamperedRun = spawnSync(process.execPath, [verifier, tampered, '--path', 'firstReceipt'], {
        encoding: 'utf8',
      });
      const wrongKeyRun = spawnSync(process.execPath, [
        verifier,
        receiptPath,
        '--path',
        'firstReceipt',
        '--signing-key-id',
        '0'.repeat(64),
      ], { encoding: 'utf8' });

      expect(tamperedRun.status).toBe(1);
      expect(JSON.parse(tamperedRun.stdout)).toMatchObject({ valid: false });
      expect(wrongKeyRun.status).toBe(1);
      expect(JSON.parse(wrongKeyRun.stdout)).toMatchObject({ valid: false });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('pins a durable operator root and opens the exact fixed policy', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'pinpoint-authority-verifier-'));
    try {
      const policy = parseMcpOpaqueFlowConfig({
        version: 1,
        flows: [{
          name: 'deliver_active',
          sourceTool: 'accounts_list',
          sourceKind: 'json-array',
          destinationTool: 'campaign_deliver',
          destinationArgument: 'recipients',
          allowedOps: ['json_select'],
          fixedWhere: { active: true },
          allowedFields: ['email'],
        }],
      });
      const rows = [{ active: true, email: 'authority-test@example.invalid' }];
      const store = new VirtualContextStore(32_000, 8, 1024 * 1024);
      const descriptor = store.put(JSON.stringify(rows));
      const artifacts = {
        artifactInfo(id: string) {
          return id === descriptor.id ? { descriptor, sourceTool: 'accounts_list' } : undefined;
        },
        queryArtifact(query: VirtualContextQuery) {
          return store.query(query);
        },
      };
      const operator = generateKeyPairSync('ed25519');
      const engine = new McpOpaqueFlowEngine(artifacts, policy.flows, {
        authoritySigningKey: operator.privateKey,
        authorityPolicy: policy,
      });
      const plan = engine.prepare({
        flow: 'deliver_active',
        id: descriptor.id,
        op: 'json_select',
        fields: ['email'],
      });
      const completed = engine.complete(plan, { content: [{ type: 'text', text: 'accepted' }] });
      const receipt = JSON.parse(completed.content[0]?.text ?? '{}').pinpointFlow;
      const receiptFile = join(temporary, 'receipt.json');
      const policyFile = join(temporary, 'policy.json');
      const changedPolicyFile = join(temporary, 'changed-policy.json');
      const openingFile = join(temporary, 'opening.json');
      writeFileSync(receiptFile, JSON.stringify(receipt));
      writeFileSync(policyFile, JSON.stringify(policy));
      writeFileSync(changedPolicyFile, JSON.stringify({
        ...policy,
        flows: [{ ...policy.flows[0], fixedWhere: { active: false } }],
      }));
      writeFileSync(openingFile, JSON.stringify(engine.authorityRecord));

      const args = [
        verifier,
        receiptFile,
        '--operator-key-id',
        engine.authorityVerifier!.operatorKeyId,
        '--policy',
        policyFile,
        '--authority-opening',
        openingFile,
      ];
      const output = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
      const wrongOperator = spawnSync(process.execPath, [
        verifier,
        receiptFile,
        '--operator-key-id',
        '0'.repeat(64),
      ], { encoding: 'utf8' });
      const changedPolicy = spawnSync(process.execPath, [
        ...args.slice(0, args.indexOf(policyFile)),
        changedPolicyFile,
        '--authority-opening',
        openingFile,
      ], { encoding: 'utf8' });

      expect(output).toMatchObject({
        valid: true,
        operatorKeyId: engine.authorityVerifier!.operatorKeyId,
        policyCommitment: engine.receiptVerifier.authority!.policyCommitment,
      });
      expect(wrongOperator.status).toBe(1);
      expect(JSON.parse(wrongOperator.stdout)).toMatchObject({ valid: false });
      expect(changedPolicy.status).toBe(1);
      expect(JSON.parse(changedPolicy.stdout)).toMatchObject({ valid: false });
      expect(JSON.stringify(receipt)).not.toContain('authority-test@example.invalid');
      expect(JSON.stringify(receipt)).not.toContain('"active":true');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});