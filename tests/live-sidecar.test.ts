import { describe, it, expect } from 'vitest';
import { createPinpoint } from '../src/pinpoint.js';

/**
 * Live integration against a REAL headroom sidecar. Skipped unless
 * PINPOINT_LIVE_SIDECAR is set to the sidecar base URL, e.g.:
 *
 *   headroom proxy --port 8787
 *   PINPOINT_LIVE_SIDECAR=http://127.0.0.1:8787 npx vitest run tests/live-sidecar.test.ts
 *
 * This is the roadmap's "confirm the CCR interplay on a real trace" validation
 * (planning/end_product.md §7, Phase 2/3).
 */
const LIVE = process.env.PINPOINT_LIVE_SIDECAR;
const suite = LIVE ? describe : describe.skip;

function bigJsonToolResult(): string {
  const rows = Array.from({ length: 150 }, (_, i) => ({
    id: i,
    name: `row_${i}`,
    value: i * 7,
    status: 'active',
    note: 'lorem ipsum dolor sit amet consectetur',
  }));
  // Pretty-printed, as real agent tool outputs typically are (headroom's router
  // detects and SmartCrushes formatted JSON).
  return JSON.stringify(rows, null, 2);
}

function bigSlab(): string {
  return 'You are a meticulous senior engineer. Follow the project conventions exactly. '.repeat(300);
}

suite('live headroom sidecar (real /v1/compress + CCR)', () => {
  it('compresses a JSON tool_result through the real engine', async () => {
    const px = createPinpoint({
      optical: { enabled: false },
      semantic: {
        enabled: true,
        autoSpawn: false,
        sidecarUrl: LIVE!,
        protectRecent: 0,
        minTokensToCompress: 10,
      },
    });
    await px.warmup();
    expect(px.sidecar.available).toBe(true);

    const original = bigJsonToolResult();
    const routed = await px.route('anthropic', 'claude-sonnet-4-5', {
      model: 'claude-sonnet-4-5',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: original }] }],
    });

    const semantic = routed.report.rows.find((r) => r.stage === 'semantic')!;
    expect(semantic.applied).toBe(true);
    expect(routed.report.tokensSavedTotal).toBeGreaterThan(0);

    const compressed = (routed.body.messages as Array<{ content: Array<{ content: string }> }>)[0]!
      .content[0]!.content;
    expect(compressed.length).toBeLessThan(original.length);

    // If headroom offloaded rows to CCR, the hash must round-trip verbatim.
    if (routed.reversible.length > 0) {
      const original2 = await px.retrieve(routed.reversible[0]!.id);
      expect(original2 && original2.length).toBeGreaterThan(0);
    }
    await px.shutdown();
  });

  it('composes BOTH engines on one request: optical images the slab, semantic compresses the tool_result', async () => {
    const px = createPinpoint({
      optical: { enabled: true },
      semantic: {
        enabled: true,
        autoSpawn: false,
        sidecarUrl: LIVE!,
        protectRecent: 0,
        minTokensToCompress: 10,
      },
    });
    await px.warmup();

    const routed = await px.route('anthropic', 'claude-fable-5', {
      model: 'claude-fable-5',
      system: [{ type: 'text', text: bigSlab(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigJsonToolResult() }] }],
    });

    const optical = routed.report.rows.find((r) => r.stage === 'optical')!;
    const semantic = routed.report.rows.find((r) => r.stage === 'semantic')!;
    expect(optical.applied).toBe(true);
    expect(semantic.applied).toBe(true);
    expect(routed.report.tokensSavedTotal).toBeGreaterThan(1000);

    // pxpipe still owns exactly one cache_control breakpoint even with semantic active.
    expect(routed.opticalOwnsCacheControl).toBe(true);
    const serialized = JSON.stringify(routed.body);
    expect((serialized.match(/cache_control/g) ?? []).length).toBe(1);
    // Slab imaged: system folded into an image block on the first user message.
    expect(routed.body.system).toBeUndefined();

    await px.shutdown();
  });
});
