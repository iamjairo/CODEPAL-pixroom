import { describe, it, expect } from 'vitest';
import { CcrStore, CCR_TOOL_NAME } from '../src/ccr/store.js';
import type { ReversibleHandle } from '../src/types.js';

describe('CcrStore', () => {
  it('registers inline pxpipe originals and retrieves them locally', async () => {
    const store = new CcrStore();
    const handles: ReversibleHandle[] = [
      { id: 'rec_abc', origin: 'optical', original: 'ORIGINAL SLAB TEXT' },
    ];
    store.registerReversible(handles);
    expect(store.size).toBe(1);
    expect(store.hasOffloaded()).toBe(true);
    expect(await store.retrieve('rec_abc')).toBe('ORIGINAL SLAB TEXT');
  });

  it('delegates unknown/headroom hashes to the sidecar retriever', async () => {
    const store = new CcrStore({
      retrieveHash: async (h) => (h === 'h1' ? 'FETCHED FROM SIDECAR' : null),
    });
    store.registerHashes(['h1']);
    expect(store.size).toBe(1);
    expect(await store.retrieve('h1')).toBe('FETCHED FROM SIDECAR');
    expect(await store.retrieve('missing')).toBeNull();
  });

  it('shapes the retrieve tool per provider', () => {
    const store = new CcrStore();
    const anthropic = store.toolSchema('anthropic') as { name: string; input_schema: unknown };
    expect(anthropic.name).toBe(CCR_TOOL_NAME);
    expect(anthropic.input_schema).toBeDefined();

    const openai = store.toolSchema('openai') as {
      type: string;
      function: { name: string; parameters: unknown };
    };
    expect(openai.type).toBe('function');
    expect(openai.function.name).toBe(CCR_TOOL_NAME);
    expect(openai.function.parameters).toBeDefined();
  });
});
