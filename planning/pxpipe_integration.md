# pxpipe Integration

> Part of the **pixroom** planning set. Read alongside:
> - [`end_product.md`](./end_product.md) — the unified vision this plan serves.
> - [`headroom_integration.md`](./headroom_integration.md) — the semantic-compression half (next phase).
>
> **Scope of this document:** a source-level investigation of
> [`teamchong/pxpipe`](https://github.com/teamchong/pxpipe) and the concrete plan
> for folding its capabilities into pixroom. This is the **optical / pixel
> compression** half of the merge. Cross-references to the headroom side are
> marked _(see [`headroom_integration.md`](./headroom_integration.md))_ and are
> intentionally left open until that investigation runs.

---

## 0. TL;DR

pxpipe is a **local proxy + library that cuts LLM _input_ tokens by rendering
bulky, cache-stable context (system prompt, tool docs, old history) as dense
PNG images.** An image's token cost is fixed by its pixel dimensions, not the
amount of text inside it, so dense text (~3 chars/token as text) becomes far
cheaper as pixels. It is lossy — a deliberate, measured trade — and it protects
byte-exact data (IDs, hashes) by keeping it as text.

For pixroom, pxpipe is the **optical compressor**: one content-type-specialized
stage in a unified compression pipeline. It is the cleaner of the two upstreams
to embed (tiny dependency surface, pure-JS runtime, documented subpath exports,
runtime-agnostic proxy core), and its packaging is the model we lean toward for
pixroom's own embedding story _(final decision in [`end_product.md`](./end_product.md))_.

---

## 1. What pxpipe is (at a glance)

| Attribute | Value |
|---|---|
| Repo | `teamchong/pxpipe` |
| npm package | `pxpipe-proxy` (v0.8.0 at investigation time) |
| License | **MIT** |
| Language | TypeScript (ESM, `"type": "module"`) |
| Runtimes | Node ≥18 **and** Cloudflare Workers (dual target) |
| Runtime deps | **`gpt-tokenizer`** only (everything else is build-time) |
| CLI binary | `pxpipe` → `bin/cli.js` (thin shim into `dist/node.js`) |
| Core idea | Render cache-stable text context → dense PNG image blocks |
| Providers | Anthropic Messages API + OpenAI Chat Completions/Responses (+ Cloudflare AI Gateway) |
| Default model scope | `claude-fable-5` only; others opt-in |
| Distribution | `npx pxpipe-proxy`; point `ANTHROPIC_BASE_URL` at it |
| Upstream cadence | Very active (daily commits); pre-1.0 semver; npm publish via GH Actions on `v*` tags (OIDC trusted publisher) |

The durable claim is the **token cut** (measured per-request against a free
`count_tokens` counterfactual), not the dollar figure (prices move). On dense
Claude Code traffic it lands ~59–73% end-to-end.

---

## 2. Core mechanism (how it works on the wire)

Canonical source: `src/core/transform.ts` (2237 lines, the heart). Design doc:
`docs/TRANSFORM_INFO.md`.

1. **Static / dynamic split.** Claude Code sends a large, mostly-static prefix
   every turn (CLAUDE.md, agent defs, tool catalogue + schemas, skill
   reminders). pxpipe walks the system text and partitions it:
   - `staticText` — byte-identical turn-to-turn → **rendered to PNG**.
   - `dynamicText` — per-turn blocks (`<env>`, `<context>`, `<git_status>`,
     `<directoryStructure>`, `<system-reminder>`) → **kept as text**.

   The split exists **for the cache**: if the daily-changing `<env>` block were
   baked into the image, the PNG bytes would change and the prompt-cache hit
   rate would collapse. Splitting first freezes the image bytes.

2. **Render the static slab to image pages.** The renderer blits atlas glyphs
   into a grayscale framebuffer and PNG-encodes. Anthropic bills roughly
   `ceil(W*H/750)` tokens/image; pages are clamped to **1568×728** so pixels
   survive Anthropic's server-side resample.

3. **Splice back cache-friendly.** Images ride on the **first user message**
   (the `system` field rejects images with `400 system.N.type`). A single
   `cache_control: {ephemeral, ttl:'1h'}` breakpoint is stamped on the **last**
   image.

4. **The one-breakpoint invariant.** Anthropic allows **4** `cache_control`
   breakpoints/request; Claude Code already uses 3 (last tool, system,
   messages). pxpipe gets exactly **one**, and it must be `ttl:'1h'` (a `5m`
   breakpoint landing before Claude Code's own `1h` breakpoint would `400`).
   _This is the single most important invariant to preserve if we vendor or
   re-implement any of this._

5. **Reflow.** Image-bound text is repacked into a `↵`-delimited stream
   (hard newlines become a visible `↵` glyph) to fill the row width
   (~29% → 75–80% glyph fill). Fully reconstructable.

6. **Forward** to the upstream. Responses stream back untouched — **pxpipe
   compresses the request only, never the model's output.**

---

## 3. Repository & module map

The parts pixroom cares about (ignoring `eval/`, `bench/`, `demo/`):

| Path | Role | pixroom relevance |
|---|---|---|
| `src/core/transform.ts` | Anthropic Messages transformer (the heart) | **Core optical compressor** |
| `src/core/render.ts` + `atlas*.ts` + `png.ts` | Text→PNG renderer, glyph atlases, PNG encoder | **The rendering engine** |
| `src/core/openai.ts`, `openai-history.ts`, `gpt-model-profiles.ts` | OpenAI Chat/Responses path + per-model geometry | Multi-provider support |
| `src/core/applicability.ts` | Model/route gate + runtime scope override | Safety gate to reuse |
| `src/core/measurement.ts` + `baseline.ts` | `count_tokens` probe bodies + cache-aware savings math | **Honest measurement** |
| `src/core/proxy.ts` | Runtime-agnostic **single `fetch` handler** | **Embedding pattern to adopt** |
| `src/node.ts` / `src/worker.ts` | Thin runtime adapters (http server / Workers) | Adapter pattern |
| `src/core/library.ts` + `index.ts` | Public SDK surface | **What we consume** |
| `src/core/export.ts` + `export-collect.ts` | Offline `pxpipe export` (files/diff → PNG + report) | Batch/offline mode |
| `src/core/factsheet.ts` | Verbatim identifier extraction (kept as text) | **Fidelity guard** |
| `src/core/history.ts` | History-collapse framing (shared Anthropic/GPT) | History compaction |
| `src/core/schema-strip.ts` | Strips verbose tool-schema descriptions | Tool-doc compaction |
| `src/dashboard*.ts`, `sessions.ts`, `stats.ts`, `tracker.ts` | Live dashboard + telemetry | Observability model |

---

## 4. Public API surface (what we can embed)

pxpipe ships **documented subpath exports** (from `package.json` `exports`) — a
clean SDK, not just a CLI:

| Import | Exposes |
|---|---|
| `pxpipe-proxy` (`.`) | Everything below, re-exported from `core/index.ts` |
| `pxpipe-proxy/transform` | `transformAnthropicMessages()`, `renderTextToImages()` — **the SDK entry** |
| `pxpipe-proxy/measurement` | `buildCountTokensBodies()` and friends |
| `pxpipe-proxy/applicability` | model/route gate + `setAllowedModelBases()` |
| `pxpipe-proxy/proxy` | `createProxy()` (runtime-agnostic) |
| `pxpipe-proxy/node` | Node http entry |
| `pxpipe-proxy/worker` | Cloudflare Workers entry |

Two functions matter most for embedding:

- **`renderTextToImages(text, opts)`** — the clean, documented render primitive
  (cols, shrink, multiCol, reflow, style, maxHeightPx → `{ pages, droppedChars,
  pixels }`). This is the surface SDK consumers _should_ use instead of reaching
  into `render.ts`. **This is pixroom's most reusable single function.**
- **`transformAnthropicMessages({ body, model, options })`** — model gate +
  machine-readable `reason` (`applied` / `unsupported_model` / `not_profitable`
  / `image_limit` / …) + a `cache.ownsCacheControl` flag that **prevents a host
  from stacking a second cache-control injector.** Designed for embedding into a
  larger proxy — exactly pixroom's use case.

Fidelity knobs on `TransformOptions` we will surface in pixroom:
`keepSharp(block)` (pin a block as text), `emitRecoverable` (return originals of
imaged blocks for byte-exact restore), `compress` (master switch),
`historyAmortizationHorizon`, `charsPerToken`.

---

## 5. CLI & runtime surface

- **`pxpipe`** — runs the proxy. Deliberately **zero flags** ("exactly ONE way
  to run it"); everything is env-var or dashboard-driven.
- **`pxpipe export [...]`** — offline: render files/diff to PNG pages + a
  cost report + factsheet. This is the batch/library path, not the proxy.
- **Dashboard** at `http://127.0.0.1:47821/` — live savings, per-conversion
  text→image view, kill switch, model chips. **Loopback-only by default**
  (unauthenticated, serves captured request context).

Configuration (all env; file config at `~/.config/pxpipe/config.json`):

| Env | Purpose |
|---|---|
| `PORT` / `HOST` | listen port / interface (default `127.0.0.1`) |
| `PXPIPE_MODELS` | CSV model scope; `off` disables; unset ⇒ Fable-5 only |
| `PXPIPE_UPSTREAM` / `ANTHROPIC_UPSTREAM` / `OPENAI_UPSTREAM` | upstream bases |
| `OPENAI_API_KEY` | optional key override |
| `PXPIPE_PROVIDER` / `PXPIPE_GATEWAY_*` | Cloudflare AI Gateway routing |
| `PXPIPE_LOG` | events file (default `~/.pxpipe/events.jsonl`) |

Event log (`~/.pxpipe/events.jsonl`) records both sides of each request
(compressed + `count_tokens` counterfactual) in the same row — the basis for
honest, reproducible savings.

---

## 6. Providers & model scope (safety posture)

- **Anthropic Messages**: `/v1/messages`, `/anthropic/v1/messages`,
  `/anthropic/messages` (exact matches; `count_tokens` route excluded).
- **OpenAI**: Chat Completions **and** Responses (`/v1/responses`, e.g. Codex).
  No cache-control markers; images as `image_url` / `input_image`; tools keep
  native names/schema shape.
- **Cloudflare AI Gateway**: route both families through one gateway base URL.

**Model scope is a safety feature, not a limitation to remove.** Default is
`claude-fable-5` only because it reads dense renders well (100/100 on novel
arithmetic; 13/15 verbatim hex vs **0/15 on Opus 4.8** on identical pages).
Opus 4.7/4.8, GPT 5.5, `gpt-5.6-sol`, and Grok are **opt-in** — each failed
exact-recall pilots at production density. pixroom **must preserve this
opt-in-per-model posture** rather than silently imaging weak readers.

---

## 7. Profitability gate & honest measurement

pxpipe never blindly images. A **per-block break-even gate**
(`isCompressionProfitable`) compares:

- **text cost**: `chars / charsPerToken` (conservative `charsPerToken=4`;
  `SLAB_CHARS_PER_TOKEN=2.0` for the dense static slab).
- **image cost**: pixel area `W*H/750` × a `1.10` safety margin, using the
  **same resolved render profile** the renderer will use (gate/renderer parity
  is enforced — see `docs/RENDER_SIZING.md`).

Cache dynamics are modeled explicitly (`baseline.ts`): a cache-aware baseline
counterfactual prices the "what if we'd sent text" path with the **same
observed cache state** (`cr > 0` is the only warm/cold signal), so savings are
never fabricated from cache assumptions. Savings can go **negative** and are
reported honestly, never floored.

**Takeaway for pixroom:** the gate + measurement design is a model to reuse.
Any compressor in the unified pipeline (optical or semantic) should carry its
own profitability gate and log a counterfactual, so pixroom can prove
end-to-end savings the same way.

---

## 8. Fidelity, reversibility & the fundamental limitation

pxpipe is **lossy by design**, and it is unusually honest about it
(`docs/NOT-OCR.md`, `FINDINGS.md`):

- A VLM does **not** OCR: the image becomes patch embeddings, never discrete
  characters. There is no per-glyph confidence, so **misses are silent
  confabulations, not loud errors.**
- **Prose survives density; identifiers corrupt.** The language prior repairs
  low-entropy text but has zero signal on a hex string.
- Accuracy is **monotonic in pixels-per-glyph** and bounded by the API resample
  ceiling — a **capacity bound** no font/color/layout trick removes.

Mitigations pxpipe ships (all reusable in pixroom):

1. **Factsheet** (`factsheet.ts`): extract exact identifiers (SHAs, numbers,
   paths) and ride them alongside as **text**.
2. **Recent turns stay text** — only cache-stable bulk / old history is imaged.
3. **`keepSharp(block)`** — caller pins byte-exact blocks as text.
4. **`emitRecoverable`** — return originals so a stateful harness can restore
   verbatim content (pixroom's bridge to headroom's reversible-store idea —
   _see [`headroom_integration.md`](./headroom_integration.md) §CCR_).

> **Design rule for pixroom:** optical compression is for token-dense,
> gist-recallable bulk. Byte-exact data must never depend on OCR. This rule
> shapes the content router _(see [`end_product.md`](./end_product.md) §Router)_.

---

## 9. Strengths to take / constraints to respect

**Take:**
- The **runtime-agnostic `createProxy` fetch handler** + thin adapters — the
  cleanest embedding pattern of the two upstreams.
- `renderTextToImages()` + `transformAnthropicMessages()` as drop-in SDK calls.
- Gate/renderer parity + cache-aware counterfactual measurement.
- Tiny dependency surface (one runtime dep) — trivial to embed.
- Multi-provider request rewriting (Anthropic + OpenAI) already solved.

**Respect / watch:**
- The **one `cache_control` breakpoint + `ttl:'1h'`** invariant.
- **Model-scope opt-in** safety posture.
- Lossiness boundary — never image byte-exact data.
- Anthropic-specific request shape assumptions (Claude Code's static/dynamic
  block tags) — coupling to a specific client's prompt layout.
- Pre-1.0, fast-moving upstream — internal (`transform.ts`) APIs will churn;
  the **published subpath exports** are the stable contract.

---

## 10. Integration plan — the pxpipe side of the merge

### 10.1 Role in pixroom
pxpipe becomes the **`optical` compressor stage** in pixroom's content-aware
pipeline: content router detects "cache-stable, token-dense, gist-recallable
bulk" → routes to the optical stage → pxpipe renders it → factsheet + recent
turns preserved as text. Semantic compressors (headroom) handle JSON/AST/prose
that must stay textual _(routing rules finalized in
[`end_product.md`](./end_product.md))_.

### 10.2 Embedding strategy (recommended)
**Consume the published npm package as a versioned dependency**, not a code
fork, wherever the public exports suffice:

- Use `pxpipe-proxy/transform` (`renderTextToImages`, `transformAnthropicMessages`)
  and `pxpipe-proxy/applicability` directly.
- Wrap pxpipe's `createProxy` inside pixroom's proxy, or call the transform
  functions inline from pixroom's own content router.
- Pin an exact version; treat the subpath exports as the stable contract.

**Fall back to a vendored git subtree** only for capabilities not exposed via
the package (e.g. reaching into `render.ts` profiles, or if we need to patch the
one-breakpoint logic). Keep patches in a documented `PATCHES.md`-style file so
upstream re-syncs are auditable (the pattern already used in the user's Formy
repo via `UPSTREAM.md` / `check-upstream-pin`).

### 10.3 Cross-language reality
pxpipe is TypeScript; headroom is Python/Rust (with a TS SDK). This is **the**
architectural decision for pixroom and is deferred to
[`end_product.md`](./end_product.md). Two viable shapes:
- **TS-first core** (adopt pxpipe wholesale; call headroom's TS SDK / shell out
  to its CLI / talk to its proxy over HTTP), or
- **Polyglot pipeline** (pixroom orchestrates both as subprocess/HTTP stages).

pxpipe's clean packaging makes it easy to embed **either way** — it does not
force the decision.

### 10.4 Staying current with upstream ("always get the best")
- Keep `~/repos-pixroom/pxpipe` as a **read-only tracking clone** (`origin` =
  upstream) for source review and vendoring.
- **Pin** `pxpipe-proxy` in pixroom's `package.json`; automate update checks
  (Dependabot/Renovate or a `check-upstream-pin`-style script) that watch npm +
  the `v*` tags.
- On each bump: re-run the fidelity/savings smoke tests (§10.5) before adopting,
  because pxpipe's model-read behavior changes with model releases.
- Record adopted version + any local patches in a pixroom `UPSTREAM.md`.

### 10.5 Concrete steps (when implementation starts)
1. Add `pxpipe-proxy` (pinned) to the pixroom CLI package.
2. Build a thin `OpticalCompressor` adapter over `renderTextToImages` /
   `transformAnthropicMessages` exposing pixroom's uniform compressor interface
   (`compress()` + profitability gate + counterfactual + reversible handle).
   **Slab-only partition lever:** pass `options.keepSharp = () => true` —
   `keepSharp` is consulted only on `reminder`/`tool_result` blocks, so returning
   `true` keeps those as text (for headroom) while the static system+tools slab
   still images. This is the §10.1 partition via pxpipe's stable public API.
3. Port pxpipe's `count_tokens` counterfactual into pixroom's measurement layer
   so optical + semantic stages report savings identically.
4. Wire `keepSharp` / `emitRecoverable` into pixroom's reversible store
   (headroom-CCR bridge).
5. Preserve the one-breakpoint + model-scope invariants: pixroom + pxpipe **own**
   the single Anthropic `cache_control` breakpoint; headroom is called via its
   stateless `/v1/compress` (no transport, no breakpoint relocation) so the two
   never fight over it (see [`end_product.md`](./end_product.md) §4.4).
6. Smoke tests: verbatim-recall guard (identifiers via factsheet), gist recall,
   and a negative-savings regression on sparse prose.

### 10.6 Risks & mitigations
| Risk | Mitigation |
|---|---|
| Upstream internal API churn (pre-1.0) | Depend on published subpath exports only; pin versions |
| Model-read regressions on new models | Re-run recall/savings smoke tests per bump; keep opt-in scope |
| Silent verbatim corruption | Enforce factsheet + keepSharp + text-tail rules in the router |
| Cache-breakpoint conflicts in a combined proxy | Honor `cache.ownsCacheControl`; single injector |
| Cross-language friction with headroom | Decide core language in `end_product.md` before deep coupling |

---

## 11. Open questions (deferred)

- Language/runtime of the unified core (TS vs polyglot) → [`end_product.md`](./end_product.md).
- How optical vs semantic compressors are sequenced/selected → router design in [`end_product.md`](./end_product.md).
- Whether pixroom's reversible store subsumes both pxpipe `emitRecoverable` and headroom CCR → [`headroom_integration.md`](./headroom_integration.md).
- Distribution UX: adopt headroom-style `wrap <agent>` + MCP over pxpipe's zero-flag proxy? → [`end_product.md`](./end_product.md).

---

_Investigation basis: full read of `package.json`, `src/core/{index,types,library,
applicability,baseline,transform,proxy,openai,export,render}.ts`, `src/node.ts`,
`bin/cli.js`, and `docs/{TRANSFORM_INFO,RENDER_SIZING,NOT-OCR}.md`, plus
`FINDINGS.md`, `CHANGELOG.md`, and the release workflow, at pxpipe `main`
(v0.8.0, commit `8d7ba3e`)._
