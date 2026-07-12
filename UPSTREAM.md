# Upstream dependency pins

pixroom **composes, does not fork** (see `planning/end_product.md` §2 and §8).
Both upstreams are consumed as pinned, unmodified dependencies. Bumps are gated
by pixroom's fidelity + savings smoke tests.

| Upstream | Package | Registry | Pinned version | License | Access mode |
|---|---|---|---|---|---|
| pxpipe  | `pxpipe-proxy` | npm  | `0.8.0`  | MIT        | in-process (subpath exports) |
| headroom | `headroom-ai` | PyPI | `>=0.31.0` (managed sidecar) | Apache-2.0 | `headroom proxy` sidecar over loopback HTTP |

## Consumed public contracts (never internal modules)

**pxpipe** (`pxpipe-proxy@0.8.0`), via documented subpath exports:
- `pxpipe-proxy/transform` — `transformAnthropicMessages`, `renderTextToImages`
- `pxpipe-proxy/applicability` — `isPxpipeSupportedModel`, `setAllowedModelBases`
- `pxpipe-proxy/measurement` — `buildCountTokensBodies`, `countCacheControlMarkers`

**headroom** (`headroom-ai`), via the stateless proxy seam (no transport, no
`cache_control` relocation — pixroom + pxpipe own the breakpoint):
- `POST /v1/compress` (loopback-only)
- `POST /v1/retrieve`, `GET /v1/retrieve/{hash}`, `POST /v1/retrieve/tool_call`
- `GET /health`

## Tracking clones (read-only, for review only — not built from)

- `~/repos-pixroom/pxpipe`   — upstream `teamchong/pxpipe`
- `~/repos-pixroom/headroom` — upstream `headroomlabs-ai/headroom`

## Update procedure

1. Renovate/Dependabot (npm) + PyPI/`v*`-tag watch surface a new version.
2. Bump the pin here + in `package.json` (pxpipe) / sidecar version guard (headroom).
3. Re-run `npm test` (fidelity + savings smoke tests) before adopting.
4. Record the adopted version and any local patches here.
