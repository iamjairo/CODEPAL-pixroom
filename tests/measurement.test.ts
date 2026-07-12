import { describe, it, expect } from 'vitest';
import { buildReport, tokensFromChars, estimateTokens } from '../src/measurement/savings.js';
import type { RequestContext } from '../src/types.js';

function ctxWith(): RequestContext {
  return {
    provider: 'anthropic',
    authMode: 'payg',
    model: 'claude-fable-5',
    body: {},
    reversible: [{ id: 'rec_1', origin: 'optical' }],
    stages: [
      {
        stage: 'semantic',
        applied: true,
        reason: 'applied',
        counterfactual: { tokensText: 200, tokensCompressed: 250, tokensSaved: -50, basis: 'tiktoken' },
        reversible: [],
      },
      {
        stage: 'optical',
        applied: true,
        reason: 'applied',
        counterfactual: { tokensText: 1000, tokensCompressed: 300, tokensSaved: 700, basis: 'estimate' },
        reversible: [],
      },
    ],
    opticalOwnsCacheControl: true,
  };
}

describe('measurement', () => {
  it('sums stage counterfactuals and does NOT floor negative savings', () => {
    const r = buildReport(ctxWith());
    expect(r.tokensTextTotal).toBe(1200);
    expect(r.tokensCompressedTotal).toBe(550);
    expect(r.tokensSavedTotal).toBe(650); // 700 + (-50), negative row preserved
    expect(r.rows.find((x) => x.stage === 'semantic')!.tokensSaved).toBe(-50);
    expect(r.savedFraction).toBeCloseTo(650 / 1200, 5);
    expect(r.reversibleCount).toBe(1);
  });

  it('reports zero fraction on an empty baseline', () => {
    const r = buildReport({
      provider: 'openai',
      authMode: 'payg',
      model: null,
      body: {},
      reversible: [],
      stages: [],
      opticalOwnsCacheControl: false,
    });
    expect(r.savedFraction).toBe(0);
    expect(r.tokensSavedTotal).toBe(0);
  });

  it('token estimators are consistent', () => {
    expect(tokensFromChars(0)).toBe(0);
    expect(tokensFromChars(400, 4)).toBe(100);
    expect(estimateTokens('abcd', 4)).toBe(1);
    expect(estimateTokens('', 4)).toBe(0);
  });
});
