/**
 * Optical compressor — the pxpipe stage (planning/pxpipe_integration.md §10.5).
 *
 * Wraps pxpipe's stable `transformAnthropicMessages` with the slab-only partition
 * lever `keepSharp: () => true`: pxpipe images the static system+tools slab (its
 * strongest, safest win — precisely the region headroom's I2 forbids mutating) while
 * keeping `reminder`/`tool_result` blocks as text for the semantic stage. pxpipe pins
 * the single Anthropic `ttl:'1h'` `cache_control` breakpoint; pixroom records that it
 * owns it so nothing stacks a second injector (planning/end_product.md §4.4).
 *
 * Anthropic-only in the MVP (optical route only on pxpipe-supported models); OpenAI
 * requests pass through untouched here and are handled by the semantic stage.
 */

import { transformAnthropicMessages, type PxpipeReason } from 'pxpipe-proxy/transform';
import { isPxpipeSupportedModel, setAllowedModelBases } from 'pxpipe-proxy/applicability';

import type { OpticalConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { parseBody, serializeBody } from '../anthropic.js';
import { counterfactual, tokensFromChars } from '../measurement/savings.js';
import {
  passthroughResult,
  type CompressionReason,
  type Compressor,
  type ReversibleHandle,
  type RequestContext,
  type StageOutcome,
  type StageResult,
} from '../types.js';

/** Dense static-slab text basis (~2 chars/token), matching pxpipe's SLAB_CHARS_PER_TOKEN. */
const SLAB_CHARS_PER_TOKEN = 2;
/** Anthropic bills ≈ ceil(W*H/750) tokens per image. */
const PX_PER_TOKEN = 750;
/** Max page geometry pxpipe clamps to (1568×728) — conservative fallback per page. */
const MAX_PAGE_PIXELS = 1568 * 728;

function mapReason(reason: PxpipeReason): CompressionReason {
  switch (reason) {
    case 'applied':
      return 'applied';
    case 'unsupported_model':
      return 'unsupported_model';
    case 'not_profitable':
      return 'not_profitable';
    case 'below_min_chars':
    case 'below_min_tokens':
      return 'below_threshold';
    case 'compress_disabled':
      return 'disabled';
    case 'parse_error':
    case 'transform_error':
      return 'error';
    default:
      return 'passthrough';
  }
}

export class OpticalCompressor implements Compressor {
  readonly stage = 'optical' as const;
  private scopeApplied = false;

  constructor(
    private readonly cfg: OpticalConfig,
    private readonly log: Logger,
  ) {}

  /** Apply the configured model scope to pxpipe once (null ⇒ keep pxpipe's default). */
  private ensureScope(): void {
    if (this.scopeApplied) return;
    if (this.cfg.allowedModelBases != null) {
      setAllowedModelBases([...this.cfg.allowedModelBases]);
      this.log.debug(`optical model scope set: [${this.cfg.allowedModelBases.join(', ') || '(none)'}]`);
    }
    this.scopeApplied = true;
  }

  applicable(ctx: RequestContext): boolean {
    if (!this.cfg.enabled) return false;
    if (ctx.provider !== 'anthropic') return false;
    this.ensureScope();
    return isPxpipeSupportedModel(ctx.model);
  }

  async run(ctx: RequestContext): Promise<StageOutcome> {
    if (!this.cfg.enabled) {
      const result = passthroughResult('optical', 'disabled');
      ctx.stages.push(result);
      return { context: ctx, result };
    }
    if (ctx.provider !== 'anthropic') {
      const result = passthroughResult('optical', 'passthrough', 'optical is anthropic-only');
      ctx.stages.push(result);
      return { context: ctx, result };
    }

    // Stealth: lossy imaging rewrites the system prompt into an image — too aggressive
    // for oauth/subscription traffic. Off unless explicitly opted in (§4.4).
    if (ctx.authMode !== 'payg' && !this.cfg.allowOnSubscription) {
      const result = passthroughResult(
        'optical',
        'stealth',
        `lossy optical disabled on ${ctx.authMode} auth (set PIXROOM_OPTICAL_ON_SUBSCRIPTION=1 to override)`,
      );
      ctx.stages.push(result);
      return { context: ctx, result };
    }

    this.ensureScope();

    if (!isPxpipeSupportedModel(ctx.model)) {
      const result = passthroughResult('optical', 'unsupported_model', ctx.model ?? undefined);
      ctx.stages.push(result);
      return { context: ctx, result };
    }

    try {
      const inputBody = serializeBody(ctx.body);
      const out = await transformAnthropicMessages({
        body: inputBody,
        model: ctx.model,
        options: {
          compress: true,
          // Slab-only: keep reminders/tool_results as text (semantic stage owns them).
          keepSharp: () => true,
          emitRecoverable: this.cfg.emitRecoverable,
        },
      });

      if (!out.applied) {
        const result = passthroughResult('optical', mapReason(out.reason), out.detail);
        ctx.stages.push(result);
        return { context: ctx, result };
      }

      // Adopt pxpipe's transformed body as the new working body.
      ctx.body = parseBody(out.body);
      ctx.opticalOwnsCacheControl = out.cache.ownsCacheControl;

      const reversible = this.collectRecoverable(out.info.recoverable);
      for (const h of reversible) ctx.reversible.push(h);

      const staticChars = out.info.staticChars || out.info.origChars;
      const pixels = out.info.imagePixels ?? out.info.imageCount * MAX_PAGE_PIXELS;
      const tokensText = tokensFromChars(staticChars, SLAB_CHARS_PER_TOKEN);
      const tokensImage = Math.ceil(pixels / PX_PER_TOKEN);

      const result: StageResult = {
        stage: 'optical',
        applied: true,
        reason: 'applied',
        detail: `images=${out.info.imageCount} staticChars=${staticChars} ownsCacheControl=${out.cache.ownsCacheControl}`,
        counterfactual: counterfactual(tokensText, tokensImage, 'estimate'),
        reversible,
      };
      ctx.stages.push(result);
      return { context: ctx, result };
    } catch (err) {
      const result = passthroughResult(
        'optical',
        'error',
        err instanceof Error ? err.message : String(err),
      );
      ctx.stages.push(result);
      this.log.warn(`optical stage error (degrading): ${result.detail}`);
      return { context: ctx, result };
    }
  }

  private collectRecoverable(
    recoverable: ReadonlyArray<{ id: string; text: string }> | undefined,
  ): ReversibleHandle[] {
    if (!recoverable) return [];
    return recoverable.map((r) => ({ id: r.id, origin: 'optical' as const, original: r.text }));
  }
}
