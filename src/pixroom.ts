/**
 * pixroom core assembly — wires config, logger, the headroom sidecar, both
 * compressor stages, the unified CCR store, and the ContentRouter into one object.
 * This is the embeddable core the SDK, proxy, MCP, and CLI all build on
 * (planning/end_product.md §6).
 */

import { loadConfig, type PixroomConfig, type PixroomConfigOverrides } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { CcrStore } from './ccr/store.js';
import { OpticalCompressor } from './compressors/optical.js';
import { SemanticCompressor } from './compressors/semantic.js';
import { HeadroomSidecar, type SidecarState } from './sidecar/headroom-sidecar.js';
import { ContentRouter, type RouteResult } from './router/content-router.js';
import type { AuthMode, Provider, SavingsReport } from './types.js';

/** Running session totals for the `stats` view. */
export interface SessionStats {
  requests: number;
  tokensTextTotal: number;
  tokensCompressedTotal: number;
  tokensSavedTotal: number;
  reversibleTotal: number;
  opticalApplied: number;
  semanticApplied: number;
}

export interface Pixroom {
  readonly config: PixroomConfig;
  readonly log: Logger;
  readonly router: ContentRouter;
  readonly ccr: CcrStore;
  readonly sidecar: HeadroomSidecar;
  /** Compress + route a parsed provider request body. Never throws (degrades). */
  route(
    provider: Provider,
    model: string | null,
    body: Record<string, unknown>,
    authMode?: AuthMode,
  ): Promise<RouteResult>;
  /** Retrieve an offloaded original by CCR hash / rec_ id. */
  retrieve(id: string): Promise<string | null>;
  /** Ensure the semantic sidecar is up (or degrade). Safe to call repeatedly. */
  warmup(): Promise<{ sidecar: SidecarState }>;
  /** Snapshot of running session savings. */
  stats(): SessionStats;
  /** Stop any managed sidecar child. */
  shutdown(): Promise<void>;
}

export function createPixroom(overrides: PixroomConfigOverrides = {}): Pixroom {
  const config = loadConfig(overrides);
  const log = createLogger(config.logLevel);

  const sidecar = new HeadroomSidecar(config.semantic, log.child('sidecar'));
  const semantic = new SemanticCompressor(config.semantic, sidecar, log.child('semantic'));
  const optical = new OpticalCompressor(config.optical, log.child('optical'));
  // The semantic compressor doubles as the CCR retriever for headroom hashes.
  const ccr = new CcrStore(semantic);
  const router = new ContentRouter(semantic, optical, ccr, log.child('router'));

  const totals: SessionStats = {
    requests: 0,
    tokensTextTotal: 0,
    tokensCompressedTotal: 0,
    tokensSavedTotal: 0,
    reversibleTotal: 0,
    opticalApplied: 0,
    semanticApplied: 0,
  };

  function accumulate(report: SavingsReport): void {
    totals.requests += 1;
    totals.tokensTextTotal += report.tokensTextTotal;
    totals.tokensCompressedTotal += report.tokensCompressedTotal;
    totals.tokensSavedTotal += report.tokensSavedTotal;
    totals.reversibleTotal += report.reversibleCount;
    for (const row of report.rows) {
      if (!row.applied) continue;
      if (row.stage === 'optical') totals.opticalApplied += 1;
      else totals.semanticApplied += 1;
    }
  }

  return {
    config,
    log,
    router,
    ccr,
    sidecar,
    async route(provider, model, body, authMode) {
      const result = await router.route(provider, model, body, authMode);
      accumulate(result.report);
      return result;
    },
    retrieve: (id) => ccr.retrieve(id),
    async warmup() {
      await sidecar.ensureHealthy();
      return { sidecar: sidecar.status };
    },
    stats: () => ({ ...totals }),
    shutdown: () => sidecar.stop(),
  };
}
