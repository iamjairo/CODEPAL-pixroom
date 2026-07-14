# pinpoint — End Product (The Plan)

> The capstone of the **pinpoint** planning set. Built from:
> - [`pxpipe_integration.md`](./pxpipe_integration.md) — optical/pixel compression (investigated).
> - [`headroom_integration.md`](./headroom_integration.md) — semantic compression (investigated).
>
> **STATUS: Firm.** Both upstreams have been investigated at the source level.
> The architecture decision below is made; §10 lists the few things a Phase-2
> spike must validate before code.

---

## 1. Vision

**pinpoint is one OSS tool that unifies optical and semantic context compression
to cut LLM token usage — reversibly and honestly — behind a single embeddable
interface (CLI first; SDK and standalone product from the same core).**

- From **pxpipe**: render the cache-stable, token-dense *static slab* (system
  prompt + tool docs) as dense PNGs — a large, cheap input-token cut on supported
  models. Lossy, so it is used only where identifiers are protected.
- From **headroom**: content-aware **semantic** compression of tool outputs, logs,
  JSON, code, RAG, and history — reversible via CCR — plus a mature multi-provider
  proxy, MCP server, one-command agent **wrap**, memory, and honest measurement.

Name: **pix** (px·pipe) + **room** (head·room).

---

## 2. The one principle that shapes everything: **compose, don't fork**

The hard requirement is *"always get the best of these repos ongoingly (if they
ever update)."* That single line rules out porting/merging their code into one
tree — a fork stops receiving upstream improvements the day it's cut, and both
projects ship **daily** (pxpipe pre-1.0 daily commits; headroom 161 releases,
PRs in the #1900s).

**Therefore pinpoint is an orchestration layer that consumes both upstreams as
pinned, unmodified dependencies** (npm `pxpipe-proxy`; PyPI `headroom-ai`).
Upgrades become *version bumps gated by smoke tests*, not re-ports. pinpoint owns
only the glue: a router, a unified reversible store, one measurement layer, and
one front door.

---

## 3. The architectural fit (why these two compose cleanly)

The investigations surfaced a near-perfect partition (see
[`headroom_integration.md`](./headroom_integration.md) §11):

- headroom's `CacheAligner` is **detector-only** and, by invariant **I2**,
  **never mutates the system prompt**. It *detects* volatile content there and
  warns — but leaves the slab intact.
- pxpipe's entire strength is **imaging exactly that static slab**.

So pxpipe fills precisely the gap headroom refuses to touch. pinpoint's router
gives each region to **exactly one** engine:

| Region | Engine | Why |
|---|---|---|
| Static system prompt + tool-docs slab | **pxpipe (optical)** | headroom won't touch it; pxpipe's strongest, safest win |
| Tool outputs, logs, JSON, code, search, RAG, history | **headroom (semantic)** | specialized reversible compressors + CCR, all providers |
| Recent turns, byte-exact IDs/secrets | **passthrough (text)** | fidelity — never lossy-compress these |

One **CCR store** makes both reversible (pxpipe's imaged originals are registered
into headroom's CCR so `headroom_retrieve` returns them too). No region is
double-compressed.

---

## 4. Architecture decision (resolved)

### 4.1 Backbone + stage
- **headroom is the backbone**: orchestration (ContentRouter), reversible store
  (CCR), multi-provider proxy, MCP, `wrap`, memory, and measurement.
- **pxpipe is the optical stage** for the static slab, on its supported models.

### 4.2 Core language / runtime
Decisive constraints from the investigations:
- pxpipe is **native TypeScript**, pure-JS, tiny — and its renderer *must* run in
  Node.
- headroom's engine is **Python + Rust**; its **TS SDK is only an HTTP client to
  the Python proxy** — there is no native-TS headroom engine to embed.

| Option | Backbone | Optical | Verdict |
|---|---|---|---|
| **A. Node front door + headroom proxy sidecar** ✅ | headroom proxy (Python) over HTTP | pxpipe in-process (TS) | **Recommended MVP.** pxpipe native; headroom reached exactly as its own TS SDK does (proven). Ships via `npx`; Docker bundles the sidecar. |
| B. Python backbone + pxpipe Node sidecar | headroom in-process (`compress()`) | pxpipe via Node sidecar | Full in-process headroom, but embeds a Node sidecar inside Python — more awkward to ship. |
| C. Single native Rust core | ported headroom-core + ported renderer | ported to Rust | Best embeddable end-state, **but a fork** → violates §2. Aspirational only (§9). |

**Decision: Option A**, refined to use headroom's **stateless `/v1/compress`
seam** rather than naive proxy-chaining. A thin **Node/TypeScript** orchestrator
(proxy + CLI + MCP) **owns the upstream transport** and the Anthropic
`cache_control` breakpoint (via pxpipe), runs pxpipe's transform in-process, and
calls a **managed `headroom proxy` sidecar** only for stateless content
compression (`POST /v1/compress`) and CCR retrieval (`/v1/retrieve*`). This keeps
both engines unmodified (§2), matches how headroom's own TS SDK already talks to
the proxy, and — critically — **sidesteps the breakpoint war** (§4.4).

### 4.3 Data flow (MVP)
```
 agent / client
   │  (Anthropic or OpenAI request; API keys held only by pinpoint)
   ▼
 pinpoint proxy  (Node/TS — owns transport, cache_control, streaming)
   │  1. Router: split request into regions (model-aware)
   │  2. tool_results/logs/JSON/code ──► headroom sidecar  POST /v1/compress
   │        (stateless; returns compressed msgs + ccr_hashes; NO upstream keys)
   │  3. static system+tools slab ──► pxpipe transform in-process (supported models)
   │        → PNG blocks; pxpipe pins the ONE ttl:'1h' cache_control breakpoint
   │  4. register pxpipe imaged originals into the shared CCR store
   │  5. inject headroom_retrieve tool; service CCR calls via sidecar /v1/retrieve*
   ▼
 upstream LLM  (Anthropic · OpenAI · Gemini · …)  ← single forward hop
```
Responses stream straight back through pinpoint (neither engine rewrites model
output; the sidecar never sees the response). If the sidecar is down pinpoint
degrades to pxpipe-only; if the model is pxpipe-unsupported it degrades to
semantic-only — never fail closed.

### 4.4 Conflict resolutions (verified in the deeper source pass)

Hazards found by reading both codebases, and how the `/v1/compress` design
neutralizes each:

- **`cache_control` breakpoint war (real).** Both systems actively own the single
  Anthropic breakpoint: pxpipe pins `ttl:'1h'` on its last image; headroom's
  *Anthropic transport handler* runs `normalize_message_cache_control` /
  `relocate_cache_breakpoint`. **Resolution:** call headroom via `/v1/compress`
  (content-only, no transport) so its breakpoint relocation never runs; **pinpoint
  + pxpipe own `cache_control`** end-to-end.
- **pxpipe's "slab-only" lever (public API).** pxpipe's `keepSharp(block)` is
  consulted only on `reminder` / `tool_result` blocks; returning `true` keeps them
  as **text**, while the static system+tools slab still images. So
  `transformAnthropicMessages({ options:{ keepSharp: () => true } })` yields
  exactly the §3 partition via pxpipe's **stable** exported API.
- **Image-compressor vs generated PNGs.** headroom ships an OCR image path
  (image→text — the *opposite* of pxpipe). It is **skipped in headroom's default
  CACHE mode**, so it won't OCR pxpipe's PNGs; pinpoint must keep it off (or exempt
  pxpipe blocks) if a non-cache mode is ever used.
- **Keyless sidecar (security win).** In the `/v1/compress` model the headroom
  sidecar never calls the LLM → it needs **no upstream API keys** and no egress;
  only pinpoint holds keys. `/v1/compress` + `/v1/retrieve*` are loopback-only.
- **headroom is highly tunable via `HEADROOM_*`** (`HEADROOM_MODE=cache` default,
  `HEADROOM_DISABLE_KOMPRESS_ANTHROPIC`, `HEADROOM_LOSSLESS`, `HEADROOM_CCR_*`,
  per-call `config` in the `/v1/compress` body) — pinpoint configures exactly which
  semantic stages run.
- **Tokenizer basis.** pxpipe counts with `gpt-tokenizer`; headroom with
  `tiktoken`/Rust. Unified measurement fixes one basis per provider (Anthropic
  `count_tokens` is the ground truth for the imaged slab).
- **Tool-definition non-overlap (verified).** headroom does **not** rewrite
  third-party `tools[]` schemas (it only counts Anthropic's native
  `tool_search`/`defer_loading`); pxpipe images the tool **definitions** as part
  of the slab. So slab (pxpipe) and message content (headroom) never collide on
  tools either.

---

## 5. Unified subsystems pinpoint owns (the glue)

1. **Content Router** — thin layer over headroom's ContentRouter that adds the
   optical route and enforces the §3 partition (one engine per region).
2. **Reversible store** — headroom **CCR** as the single store + retrieval tool
   (`headroom_retrieve` / MCP); pxpipe `emitRecoverable` originals registered in.
3. **Profitability gate + measurement** — one counterfactual/holdout layer for
   both stages (pxpipe's `count_tokens` counterfactual + headroom's savings
   tracker → one honest report; negative savings reported, not floored).
4. **Front door** — CLI + proxy + **MCP** + **`pinpoint wrap <agent>`** (adopt
   headroom's agent matrix; keep pxpipe's zero-config proxy ergonomics).
5. **Output-token reduction (inherited).** headroom's output shaper is
   **request-side** (`output_shaper.py` appends a verbosity-steering suffix + sets
   reasoning/effort), so it survives the `/v1/compress` seam: pinpoint applies it
   to the **live text** region (never the imaged slab, to keep the prompt cache
   warm). Net: pinpoint cuts **both input and output** tokens — pxpipe alone never
   touches output.

---

## 6. Packaging: CLI → SDK → product (from one core)

Mirror pxpipe's layering (thin bin → core) and headroom's distribution surface:

```
pinpoint proxy            # combined optical+semantic compression proxy
pinpoint wrap <agent>     # one-command wrap (claude, codex, copilot, cursor, …)
pinpoint mcp              # MCP server (compress / retrieve / stats)
pinpoint export <paths>   # offline render/compress + honest savings report
pinpoint doctor|stats     # health + per-region routing & savings view
```
- **Core library** (Node/TS): router + gate + CCR bridge + adapters, published
  with subpath exports → this *is* the SDK.
- **CLI**: thin shim over the core (like pxpipe's `bin/cli.js`).
- **Standalone/product**: the proxy + MCP + dashboard + Docker (Node front door +
  headroom sidecar), later a hosted/managed tier.

---

## 7. Roadmap

- [x] **Phase 0** — Repo setup (`~/repos-pinpoint/{pxpipe,headroom,pinpoint}`, private repo).
- [x] **Phase 1a** — Investigate pxpipe → [`pxpipe_integration.md`](./pxpipe_integration.md).
- [x] **Phase 1b** — Investigate headroom → [`headroom_integration.md`](./headroom_integration.md).
- [x] **Phase 2 — Architecture spike** (validate §10 unknowns): stood up a Node
      proxy that (a) images the static slab via pxpipe (`keepSharp:()=>true`) and
      owns `cache_control`, and (b) compresses the rest via a `headroom proxy`
      sidecar `POST /v1/compress`. **Verified in code + tests:** pxpipe pins
      *exactly one* `ttl:'1h'` breakpoint on a Claude-Code-shaped request
      (`ownsCacheControl:true`); the `keepSharp:()=>true` slab-only partition holds;
      the uniform compressor interface is locked (`src/types.ts`). _Remaining:_
      confirm the CCR interplay on one real Claude Code trace against a **live**
      headroom sidecar (fake-sidecar end-to-end passes today).
- [x] **Phase 3 — CLI MVP** *(complete)*: `pinpoint proxy` composes both engines
      via the §3/§4 partition (pxpipe in-process + headroom `/v1/compress`); unified
      CCR store + `headroom_retrieve`; one honest savings report; `export`, `doctor`,
      `stats`. Pinned `pxpipe-proxy@0.8.0` (npm) + `headroom-ai` (managed sidecar).
      **Validated against real upstreams:** live headroom sidecar + pxpipe compose
      for **80% total savings** on one request (semantic 7071→2436 + optical
      11700→1326), exactly one `cache_control` breakpoint. Smoke tests landed:
      verbatim-recall guard (identifiers in protected turns survive byte-exact) +
      honest zero-savings on sparse prose. _Remaining:_ gist-recall needs a live
      model (no automated coverage yet).
- [ ] **Phase 4 — SDK + docs**: publish core exports; embedding guide;
      `withPinpoint()` adapters.
- [ ] **Phase 5 — Distribution**: `pinpoint wrap` + MCP + dashboard + Docker;
      upstream-sync automation. *(`wrap <agent>` and the `mcp` stdio server are
      built; dashboard, Docker, and Renovate/PyPI-watch automation remain.)*
- [ ] **Phase 6 — Hardening / (optional) convergence**: evaluate a single native
      Rust core (§9) only if composition overhead justifies the fork tradeoff.

---

## 8. Staying current with both upstreams

1. **Track, don't fork.** `~/repos-pinpoint/{pxpipe,headroom}` stay as read-only
   tracking clones for review.
2. **Pin published packages**: `pxpipe-proxy` (npm), `headroom-ai` (PyPI). Depend
   on **public contracts** (pxpipe subpath exports; headroom `compress()` / proxy
   / MCP), never internal modules (both churn; headroom's Rust port is in flight).
3. **Automate detection**: Renovate/Dependabot + PyPI/`v*`-tag watch.
4. **Gate every bump** behind pinpoint's fidelity + savings smoke tests (model-read
   behavior shifts with model releases).
5. **Record** adopted versions + any local patches in `UPSTREAM.md` / `PATCHES.md`.

---

## 9. Optional future: single native Rust core (flagged tradeoff)

headroom is already porting its engine to Rust (`crates/headroom-core`); pxpipe's
renderer could be ported to a Rust `image` crate. A single Rust core exposed via
PyO3 (Python) + napi (Node) + a CLI would be the **best possible embeddable
end-state**. **But this is a fork** and directly trades away the §2 "always get
upstream" property. Pursue only if (a) operational overhead of the two-runtime
composition proves painful, and (b) we commit to upstreaming/vendoring discipline.
Default stance: **stay composed.**

---

## 10. Open questions for the Phase-2 spike

| # | Question | How to settle | Status |
|---|---|---|---|
| 1 | `cache_control` breakpoint ownership on Anthropic | Use `/v1/compress` (no headroom transport) → pxpipe owns the one `ttl:'1h'` breakpoint; replay one real trace, assert 1 breakpoint, no 400 | **Resolved in design (§4.4)** — verify on a trace |
| 2 | Region hand-off so nothing is double-compressed | pxpipe `keepSharp:()=>true` (slab-only) + headroom compresses the rest | **Resolved in design (§4.4)** — verify |
| 3 | Servicing `headroom_retrieve` when pinpoint owns transport | pinpoint injects the tool + calls sidecar `/v1/retrieve*`; or share one CCR store (`HEADROOM_CCR_*`) | Spike |
| 4 | Sidecar lifecycle (spawn/health/degrade) from Node | Manage `headroom proxy` as a child process; `/health` + fallback | Spike |
| 5 | Model-aware routing (pxpipe Fable-5 default vs all providers) | Optical route only on pxpipe-supported models; semantic always on | Design set — verify |
| 6 | Unified savings math + tokenizer basis | One counterfactual row/request; Anthropic `count_tokens` as slab ground truth | Spike |

---

## 11. License

Compose-as-dependencies keeps obligations light. Ship pinpoint under **Apache-2.0**
(headroom's license; pxpipe's **MIT** is compatible and may be combined under
Apache-2.0), with a `NOTICE` attributing both upstreams (and their bundled
attributions, e.g. RTK). Revisit if we ever vendor source (§9).

---

_Living document. Reflects source-level investigations of pxpipe (`v0.8.0`) and
headroom (`v0.31.0`). The composition architecture (§2–§4) is the firm
recommendation; §10 gates the first line of code._
