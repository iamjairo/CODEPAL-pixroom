/**
 * pixroom ContentRouter (planning/end_product.md §5.1).
 *
 * A thin orchestration layer over the two engines that enforces the §3 partition —
 * exactly one engine per region — and unifies reversibility through one CCR store:
 *
 *   1. semantic stage (headroom): compress tool_result/content regions
 *   2. optical stage (pxpipe): image the static system+tools slab; own cache_control
 *   3. register both engines' reversible handles into the single CCR store
 *   4. inject `headroom_retrieve` last (after optical) so its description stays sharp
 *
 * Ordering matches the §4.3 data flow. Both stages self-gate and degrade to a safe
 * pass-through, so `route()` never fails closed.
 */

import type { Logger } from '../logger.js';
import { CCR_TOOL_NAME, type CcrStore } from '../ccr/store.js';
import { buildReport, summarizeReport } from '../measurement/savings.js';
import type {
  AuthMode,
  Compressor,
  Provider,
  RequestContext,
  ReversibleHandle,
  SavingsReport,
} from '../types.js';

export interface RouteResult {
  /** The transformed request body ready to forward upstream. */
  readonly body: Record<string, unknown>;
  readonly report: SavingsReport;
  readonly reversible: readonly ReversibleHandle[];
  /** True when pxpipe pinned the single Anthropic `cache_control` breakpoint. */
  readonly opticalOwnsCacheControl: boolean;
}

function toolName(tool: unknown): string | undefined {
  if (tool == null || typeof tool !== 'object') return undefined;
  const t = tool as { name?: unknown; function?: { name?: unknown } };
  if (typeof t.name === 'string') return t.name;
  if (t.function && typeof t.function.name === 'string') return t.function.name;
  return undefined;
}

export class ContentRouter {
  constructor(
    private readonly semantic: Compressor,
    private readonly optical: Compressor,
    private readonly ccr: CcrStore,
    private readonly log: Logger,
  ) {}

  async route(
    provider: Provider,
    model: string | null,
    body: Record<string, unknown>,
    authMode: AuthMode = 'payg',
  ): Promise<RouteResult> {
    const ctx: RequestContext = {
      provider,
      authMode,
      model,
      body,
      reversible: [],
      stages: [],
      opticalOwnsCacheControl: false,
    };

    // §4.3: semantic first (content), then optical (static slab + cache_control).
    await this.semantic.run(ctx);
    await this.optical.run(ctx);

    // Unify reversibility: both engines' handles live in one store (§5.2).
    this.ccr.registerReversible(ctx.reversible);

    // Inject the retrieve tool last so its description isn't imaged by pxpipe.
    if (this.ccr.hasOffloaded()) {
      this.injectCcrTool(ctx);
    }

    const report = buildReport(ctx);
    this.log.info(summarizeReport(report));

    return {
      body: ctx.body,
      report,
      reversible: ctx.reversible,
      opticalOwnsCacheControl: ctx.opticalOwnsCacheControl,
    };
  }

  private injectCcrTool(ctx: RequestContext): void {
    const existing = Array.isArray(ctx.body.tools) ? ctx.body.tools : [];
    if (existing.some((t) => toolName(t) === CCR_TOOL_NAME)) return;
    ctx.body.tools = [...existing, this.ccr.toolSchema(ctx.provider)];
    this.log.debug(`injected ${CCR_TOOL_NAME} tool (${this.ccr.size} offloaded originals)`);
  }
}
