import { describe, it, expect } from 'vitest';
import { createPinpoint } from '../src/pinpoint.js';

/**
 * Fidelity + honesty smoke tests (planning/end_product.md §7, Phase 3).
 * These run fully offline (optical only, no sidecar, no LLM).
 */

function bigSlab(): string {
  return 'You are a meticulous senior engineer. Follow the project conventions exactly. '.repeat(300);
}

describe('smoke: fidelity + honest measurement', () => {
  it('never lossy-compresses byte-exact identifiers in recent (protected) turns', async () => {
    const px = createPinpoint({ semantic: { enabled: false }, optical: { enabled: true } });
    const secret = 'sk-DEADBEEF0123456789abcdefCAFEBABE';
    const sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

    const routed = await px.route('anthropic', 'claude-fable-5', {
      model: 'claude-fable-5',
      // Big static slab (gets imaged) …
      system: [{ type: 'text', text: bigSlab(), cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'earlier turn' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        // … but the identifiers live in the most recent user turn, which must stay text.
        {
          role: 'user',
          content: [{ type: 'text', text: `Use API key ${secret} at commit ${sha}.` }],
        },
      ],
    });

    const serialized = JSON.stringify(routed.body);
    expect(serialized).toContain(secret);
    expect(serialized).toContain(sha);
    await px.shutdown();
  });

  it('reports honest zero savings on sparse prose (no fabricated wins)', async () => {
    const px = createPinpoint({ semantic: { enabled: false }, optical: { enabled: true } });
    const routed = await px.route('anthropic', 'claude-fable-5', {
      model: 'claude-fable-5',
      system: 'Be concise.', // far below the imaging threshold
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello there.' }] }],
    });
    const optical = routed.report.rows.find((r) => r.stage === 'optical')!;
    expect(optical.applied).toBe(false);
    expect(['below_threshold', 'not_profitable', 'passthrough']).toContain(optical.reason);
    // Honest: nothing applied ⇒ no savings claimed, and never negative-fabricated.
    expect(routed.report.tokensSavedTotal).toBe(0);
    expect(routed.report.savedFraction).toBe(0);
    await px.shutdown();
  });
});
