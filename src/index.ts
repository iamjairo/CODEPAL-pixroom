/**
 * pixroom SDK — the embeddable core (planning/end_product.md §6).
 *
 * `createPixroom()` returns the composed engine; `createProxyServer()` is the
 * standalone front door. Both consume pxpipe (optical, in-process) and headroom
 * (semantic, via the loopback sidecar) as pinned, unmodified dependencies.
 */

export { createPixroom } from './pixroom.js';
export type { Pixroom, SessionStats } from './pixroom.js';

export { createProxyServer } from './proxy/server.js';
export type { ProxyServer } from './proxy/server.js';

export { runMcpServer } from './mcp/server.js';

export { ContentRouter } from './router/content-router.js';
export type { RouteResult } from './router/content-router.js';

export { CcrStore, CCR_TOOL_NAME } from './ccr/store.js';
export type { CcrRetriever } from './ccr/store.js';

export { OpticalCompressor } from './compressors/optical.js';
export { SemanticCompressor } from './compressors/semantic.js';
export { HeadroomSidecar } from './sidecar/headroom-sidecar.js';
export type { SidecarState } from './sidecar/headroom-sidecar.js';

export { loadConfig } from './config.js';
export type {
  PixroomConfig,
  PixroomConfigOverrides,
  OpticalConfig,
  SemanticConfig,
  CcrConfig,
  LogLevel,
} from './config.js';

export {
  buildReport,
  formatReport,
  summarizeReport,
  counterfactual,
  estimateTokens,
} from './measurement/savings.js';

export type {
  Provider,
  Stage,
  TokenBasis,
  CompressionReason,
  Compressor,
  Counterfactual,
  ReversibleHandle,
  RequestContext,
  StageResult,
  StageOutcome,
  SavingsReport,
  SavingsRow,
} from './types.js';
