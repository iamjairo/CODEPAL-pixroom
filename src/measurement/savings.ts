/**
 * Unified measurement — one honest, cache-aware savings view per request.
 *
 * Both stages emit a {@link Counterfactual} in the same shape; this layer sums them
 * into a single {@link SavingsReport}. Savings can be negative (e.g. optical imaging
 * of sparse prose, or semantic overhead on tiny inputs) and are reported as-is,
 * never floored (planning/pxpipe_integration.md §7, planning/end_product.md §5.3).
 */

import type {
  Counterfactual,
  RequestContext,
  SavingsReport,
  SavingsRow,
  TokenBasis,
} from '../types.js';

/** Conservative default chars-per-token (matches pxpipe's default gate basis). */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/** Estimate token count for a text region. Labeled `estimate` at the call site. */
export function estimateTokens(text: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / Math.max(1, charsPerToken));
}

/** Estimate token count from a raw character count. */
export function tokensFromChars(chars: number, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / Math.max(1, charsPerToken));
}

/** Build a counterfactual from explicit before/after token counts. */
export function counterfactual(
  tokensText: number,
  tokensCompressed: number,
  basis: TokenBasis,
): Counterfactual {
  return {
    tokensText,
    tokensCompressed,
    tokensSaved: tokensText - tokensCompressed,
    basis,
  };
}

/** Combine all stage results on a context into one report. */
export function buildReport(ctx: RequestContext): SavingsReport {
  const rows: SavingsRow[] = ctx.stages.map((s) => ({
    stage: s.stage,
    applied: s.applied,
    reason: s.reason,
    tokensText: s.counterfactual.tokensText,
    tokensCompressed: s.counterfactual.tokensCompressed,
    tokensSaved: s.counterfactual.tokensSaved,
    basis: s.counterfactual.basis,
  }));

  const tokensTextTotal = rows.reduce((a, r) => a + r.tokensText, 0);
  const tokensCompressedTotal = rows.reduce((a, r) => a + r.tokensCompressed, 0);
  const tokensSavedTotal = tokensTextTotal - tokensCompressedTotal;
  const savedFraction = tokensTextTotal > 0 ? tokensSavedTotal / tokensTextTotal : 0;

  return {
    provider: ctx.provider,
    model: ctx.model,
    rows,
    tokensTextTotal,
    tokensCompressedTotal,
    tokensSavedTotal,
    savedFraction,
    reversibleCount: ctx.reversible.length,
  };
}

/** One-line human summary for logs. */
export function summarizeReport(r: SavingsReport): string {
  const pct = (r.savedFraction * 100).toFixed(1);
  const stages = r.rows
    .map((row) => `${row.stage}:${row.applied ? `${row.tokensSaved}t` : row.reason}`)
    .join(' ');
  return `${r.provider}/${r.model ?? '?'} saved ${r.tokensSavedTotal}t (${pct}%) [${stages}] ccr=${r.reversibleCount}`;
}

/** Multi-line table for the CLI `stats` / `export` report. */
export function formatReport(r: SavingsReport): string {
  const lines: string[] = [];
  lines.push(`provider: ${r.provider}   model: ${r.model ?? '(none)'}`);
  lines.push('stage      applied  reason           text→compressed   saved   basis');
  lines.push('---------  -------  ---------------  ----------------  ------  ---------------------');
  for (const row of r.rows) {
    lines.push(
      [
        row.stage.padEnd(9),
        (row.applied ? 'yes' : 'no').padEnd(7),
        row.reason.padEnd(15),
        `${row.tokensText}→${row.tokensCompressed}`.padEnd(16),
        String(row.tokensSaved).padEnd(6),
        row.basis,
      ].join('  '),
    );
  }
  lines.push('---------  -------  ---------------  ----------------  ------  ---------------------');
  const pct = (r.savedFraction * 100).toFixed(1);
  lines.push(
    `TOTAL      ${r.tokensTextTotal}→${r.tokensCompressedTotal}   saved ${r.tokensSavedTotal}t (${pct}%)   reversible=${r.reversibleCount}`,
  );
  return lines.join('\n');
}
