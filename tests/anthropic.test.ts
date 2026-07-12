import { describe, it, expect } from 'vitest';
import {
  collectToolResultTargets,
  applyCompressedToolResults,
  totalChars,
  parseBody,
  serializeBody,
  readModel,
} from '../src/anthropic.js';

function body(messages: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: 'claude-fable-5', messages, ...extra };
}

describe('anthropic region extraction', () => {
  it('collects string and text-array tool_result content above the floor', () => {
    const big = 'x'.repeat(500);
    const b = body([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: big },
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: [{ type: 'text', text: big }],
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]);
    const targets = collectToolResultTargets(b, { protectRecent: 0, minChars: 200 });
    expect(targets).toHaveLength(2);
    expect(targets[0]!.toolUseId).toBe('t1');
    expect(totalChars(targets)).toBe(1000);
  });

  it('protects the last N turns', () => {
    const big = 'y'.repeat(500);
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: big }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'recent', content: big }] },
    ];
    const targets = collectToolResultTargets(body(msgs), { protectRecent: 2, minChars: 200 });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.toolUseId).toBe('old');
  });

  it('skips tool_result containing non-text blocks (fidelity guard)', () => {
    const b = body([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'img',
            content: [
              { type: 'text', text: 'z'.repeat(500) },
              { type: 'image', source: { type: 'base64', data: 'AAAA' } },
            ],
          },
        ],
      },
    ]);
    const targets = collectToolResultTargets(b, { protectRecent: 0, minChars: 10 });
    expect(targets).toHaveLength(0);
  });

  it('reinjects compressed text in order and round-trips through serialize', () => {
    const big = 'w'.repeat(500);
    const b = body([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] },
    ]);
    const targets = collectToolResultTargets(b, { protectRecent: 0, minChars: 200 });
    applyCompressedToolResults(b, targets, ['SMALL <<ccr:h0>>']);
    const round = parseBody(serializeBody(b));
    const msg = (round.messages as Array<{ content: Array<{ content: string }> }>)[0]!;
    expect(msg.content[0]!.content).toBe('SMALL <<ccr:h0>>');
    expect(readModel(round)).toBe('claude-fable-5');
  });

  it('refuses to reinject on length mismatch', () => {
    const b = body([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a'.repeat(500) }] },
    ]);
    const targets = collectToolResultTargets(b, { protectRecent: 0, minChars: 200 });
    expect(() => applyCompressedToolResults(b, targets, [])).toThrow(/refusing to reinject/);
  });
});
