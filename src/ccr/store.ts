/**
 * Unified reversible store (CCR bridge).
 *
 * pixroom keeps both engines reversible through one store and one retrieval tool
 * (planning/end_product.md §5.2):
 *   - pxpipe imaged blocks arrive as inline `recoverable` originals (text in hand).
 *   - headroom offloads arrive as CCR hashes whose originals live in the sidecar.
 * A single `retrieve(id)` resolves either: inline first, else fetch the hash from
 * the sidecar. One `headroom_retrieve` tool is injected so the model can pull back
 * verbatim content on demand.
 */

import type { Provider, ReversibleHandle } from '../types.js';

export const CCR_TOOL_NAME = 'headroom_retrieve';

/** Fetches originals for headroom CCR hashes from the sidecar. */
export interface CcrRetriever {
  retrieveHash(hash: string): Promise<string | null>;
}

export class CcrStore {
  /** pxpipe `rec_…` id → original text (held in-process). */
  private readonly inline = new Map<string, string>();
  /** headroom CCR hashes seen this session (originals live in the sidecar). */
  private readonly hashes = new Set<string>();

  constructor(private readonly retriever?: CcrRetriever) {}

  /** Register pxpipe imaged-block originals (optical stage, inline text). */
  registerReversible(handles: readonly ReversibleHandle[]): void {
    for (const h of handles) {
      if (h.origin === 'optical' && typeof h.original === 'string') {
        this.inline.set(h.id, h.original);
      } else if (h.origin === 'semantic') {
        this.hashes.add(h.id);
      }
    }
  }

  /** Register headroom CCR hashes (semantic stage). */
  registerHashes(hashes: readonly string[]): void {
    for (const h of hashes) if (h) this.hashes.add(h);
  }

  /** Number of distinct offloaded originals tracked. */
  get size(): number {
    return this.inline.size + this.hashes.size;
  }

  /** True when anything has been offloaded (⇒ the retrieve tool is worth injecting). */
  hasOffloaded(): boolean {
    return this.size > 0;
  }

  /** Resolve an id to its original content. Inline (pxpipe) first, else sidecar (headroom). */
  async retrieve(id: string): Promise<string | null> {
    const local = this.inline.get(id);
    if (local != null) return local;
    if (this.hashes.has(id) && this.retriever) {
      return this.retriever.retrieveHash(id);
    }
    // Unknown id: still try the sidecar (hash may have been created out of band).
    return this.retriever ? this.retriever.retrieveHash(id) : null;
  }

  /**
   * Tool definition for the model to retrieve offloaded originals, shaped per provider.
   * Anthropic: top-level tool with `input_schema`; OpenAI: `{type:'function', function}`.
   */
  toolSchema(provider: Provider): Record<string, unknown> {
    const description =
      'Retrieve the full, original content that was compressed or imaged out of this ' +
      'context. Call with the reference id shown in a <<ccr:…>> sentinel (or a rec_ id) ' +
      'to get the verbatim bytes back.';
    if (provider === 'openai') {
      return {
        type: 'function',
        function: {
          name: CCR_TOOL_NAME,
          description,
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'The CCR hash or rec_ id to retrieve.' },
            },
            required: ['id'],
          },
        },
      };
    }
    return {
      name: CCR_TOOL_NAME,
      description,
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The CCR hash or rec_ id to retrieve.' },
        },
        required: ['id'],
      },
    };
  }
}
