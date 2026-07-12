# pixroom

A context-compression layer for AI agents that combines two complementary
approaches to cutting LLM token usage:

- **[pxpipe](https://github.com/teamchong/pxpipe)** — *pixel* compression:
  renders bulky text context (system prompt, tool docs, history) as compact
  PNG images, since an image's token cost is fixed by its pixel dimensions
  rather than the amount of text inside it.
- **[headroom](https://github.com/headroomlabs-ai/headroom)** — *semantic*
  compression: content-aware compressors for tool outputs, logs, RAG chunks,
  files, and conversation history before they reach the model.

The name is a portmanteau of **pix** (pxpipe) + **room** (headroom).

pixroom **composes, it does not fork** — both upstreams are consumed as pinned,
unmodified dependencies (see [`UPSTREAM.md`](./UPSTREAM.md) and
[`planning/end_product.md`](./planning/end_product.md) §2). It owns only the glue:
a router, one reversible store, one measurement layer, and one front door.

## Install

```bash
npm install            # pulls pxpipe-proxy (optical engine, in-process)
npm run build
```

The optical stage (pxpipe) works with **no external dependencies**. The semantic
stage additionally needs a [headroom](https://github.com/headroomlabs-ai/headroom)
sidecar (`pip install headroom-ai`); pixroom auto-spawns and health-checks it, and
**degrades to optical-only if it is absent** — it never fails closed.

## Quickstart

```bash
# 1. Offline: compress files and print an honest, per-stage savings report (no LLM).
pixroom export path/to/big-context.md

# 2. Health check: toolchain, pxpipe, and the headroom sidecar.
pixroom doctor

# 3. Run the combined proxy, then point your agent at it.
pixroom proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:8788 claude

# …or wrap the agent in one command (starts the proxy + launches it):
pixroom wrap claude

# 4. Expose pixroom to an MCP host (tools: pixroom_compress / _retrieve / _stats).
pixroom mcp
```

Or embed the core directly:

```ts
import { createPixroom } from 'pixroom';

const px = createPixroom();
const { body, report } = await px.route('anthropic', 'claude-fable-5', anthropicRequestBody);
console.log(report.tokensSavedTotal, report.savedFraction);
```

## How it works

pixroom's router gives each region of a request to **exactly one** engine, so
nothing is double-compressed, and unifies reversibility through one CCR store:

| Region | Engine | Why |
|---|---|---|
| Static system + tool-docs slab | **optical** (pxpipe, in-process) | headroom's `CacheAligner` refuses to mutate it; pxpipe's strongest, safest win |
| Tool outputs, logs, JSON, code, history | **semantic** (headroom sidecar) | reversible, content-aware compressors + CCR |
| Recent turns, byte-exact IDs/secrets | **passthrough** | fidelity — never lossy-compressed |

```
 agent / client
   │  (Anthropic or OpenAI request; client API keys pass straight through)
   ▼
 pixroom proxy  (Node/TS — owns transport, cache_control, streaming)
   │  1. semantic: tool_results → headroom sidecar POST /v1/compress (keyless, loopback)
   │  2. optical:  static slab → pxpipe transform in-process (pins the one ttl:'1h' breakpoint)
   │  3. register both engines' originals into the shared CCR store
   │  4. inject headroom_retrieve; one honest savings report
   ▼
 upstream LLM  (single forward hop; responses stream back untouched)
```

Both engines own disjoint regions, so pixroom cuts input tokens optically **and**
semantically. If the sidecar is down it degrades to optical-only; if the model is
not pxpipe-supported it degrades to semantic-only.

## Configuration (environment)

| Env | Purpose | Default |
|---|---|---|
| `PIXROOM_HOST` / `PIXROOM_PORT` | listen interface / port | `127.0.0.1` / `8788` |
| `PIXROOM_MODELS` | optical model-scope CSV; `off` disables; unset = pxpipe default (Fable-5) | unset |
| `PIXROOM_OPTICAL` / `PIXROOM_SEMANTIC` | master switches | `on` |
| `PIXROOM_HEADROOM_URL` | headroom sidecar base URL | `http://127.0.0.1:8787` |
| `PIXROOM_HEADROOM_AUTOSPAWN` | auto-start `headroom proxy` if unreachable | `on` |
| `PIXROOM_OPTICAL_ON_SUBSCRIPTION` | allow lossy optical on oauth/subscription (stealth) | `off` |
| `PIXROOM_LOG` | `silent`\|`error`\|`warn`\|`info`\|`debug` | `info` |

### Optical model scope (e.g. enabling opus 4.8)

Optical imaging is opt-in **per model** because dense renders are lossy and some
models read them poorly. To add opus 4.8 (or any model), list it in
`PIXROOM_MODELS` — the list *replaces* the default scope, so include Fable-5 if
you still want it:

```bash
PIXROOM_MODELS=claude-fable-5,claude-opus-4-8 pixroom proxy
```

Measured on live opus 4.8: pxpipe's **factsheet keeps fragile identifiers (hex,
UUIDs, numbers, paths) as text**, so they stay byte-exact — only the prose bulk is
imaged, which opus reads acceptably (the language prior repairs minor misreads).
That said, opus is a **weaker image reader** than Fable-5, the factsheet is
heuristic (an unusual identifier could still be imaged and misread), and on a
Claude subscription imaging is additionally gated by
`PIXROOM_OPTICAL_ON_SUBSCRIPTION=1` and can bust Claude Code's prompt cache (see
[`benchmarks/REPORT.md`](./benchmarks/REPORT.md)). Optical stays **off for opus by
default**; enable it deliberately on PAYG/API traffic where it pays off.

## Development

```bash
npm run typecheck
npm test          # unit + real pxpipe optical integration + fake-sidecar end-to-end
```

## Status

**Phase 3 (CLI MVP) complete.** Working today: the composed core, both compressor
stages behind one uniform interface, the ContentRouter partition, the unified CCR
store + retrieve tool, one honest savings report, the Node proxy (Anthropic +
OpenAI), the CLI (`proxy`, `export`, `doctor`, `stats`, `wrap`), and an MCP server
(`mcp`). See [`planning/end_product.md`](./planning/end_product.md) §7.

**Validated against real upstreams** (not mocks): pxpipe in-process, and a live
headroom sidecar. On one combined request, both engines composed for **80% total
token savings** (semantic 7071→2436 + optical 11700→1326) while pxpipe held
exactly one `cache_control` breakpoint. To reproduce the live tests:

```bash
pip install headroom-ai fastapi uvicorn 'httpx[http2]' websockets magika
headroom proxy --port 8787 &
PIXROOM_LIVE_SIDECAR=http://127.0.0.1:8787 npm test
```

Next: Docker packaging and upstream-sync automation (Phases 5–6).

The two upstream projects are cloned as siblings of this directory for reference:

```
repos-pixroom/
├── headroom/   # cloned OSS (Apache-2.0) — tracking clone, not built from
├── pxpipe/     # cloned OSS (MIT)        — tracking clone, not built from
└── pixroom/    # this project
```

## License

Apache-2.0. Bundles attribution for pxpipe (MIT) and headroom (Apache-2.0); see
[`NOTICE`](./NOTICE).

