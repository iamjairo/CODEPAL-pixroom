# headroom Integration

> Part of the **pinpoint** planning set. Read alongside:
> - [`end_product.md`](./end_product.md) — the unified plan this feeds into.
> - [`pxpipe_integration.md`](./pxpipe_integration.md) — the optical-compression half.
>
> **Scope of this document:** a source-level investigation of
> [`headroomlabs-ai/headroom`](https://github.com/headroomlabs-ai/headroom)
> (repo also known upstream as `chopratejas/headroom`) and the concrete plan for
> folding its capabilities into pinpoint. This is the **semantic / content-aware
> compression** half of the merge.

---

## 0. TL;DR

headroom is a **context-optimization layer** that compresses everything an agent
reads — tool outputs, logs, RAG chunks, files, code, conversation history —
using **content-aware, reversible, mostly-lossless** compression, before the
prompt reaches the LLM. It ships as a Python package (with a **Rust core**), an
HTTP **proxy**, an **MCP server**, and a one-command **agent wrapper**.

Two facts dominate the merge and were confirmed from source:

1. **The engine is Python + Rust and proxy-centric.** headroom's own npm
   TypeScript SDK **does not compress** — it is an HTTP client that forwards to
   the Python proxy (`localhost:8787`) and falls back to *uncompressed* if the
   proxy is down. SmartCrusher's Python implementation was **retired**; it now
   runs in **Rust via PyO3** (`headroom._core`), and a byte-faithful Python→Rust
   port ("REALIGNMENT") is ongoing.
2. **It is philosophically the opposite of pxpipe.** headroom is
   **byte-faithful and reversible**; its `CacheAligner` is now *detector-only*
   and **never mutates the system prompt** (invariant I2). pxpipe is aggressively
   **lossy** and *images the system prompt*. → They are **complementary**, and
   they partition a request almost perfectly (see §11).

For pinpoint, headroom is the **semantic engine and the orchestration/distribution
backbone**; pxpipe is the **optical stage** that fills exactly the gap headroom
refuses to touch.

---

## 1. What headroom is (at a glance)

| Attribute | Value |
|---|---|
| Repo | `headroomlabs-ai/headroom` (upstream `chopratejas/headroom`) |
| Python package | **`headroom-ai`** (v0.31.0 at investigation time) |
| npm package | `headroom-ai` (TS SDK — **HTTP client to the proxy**, not an engine) |
| License | **Apache-2.0** |
| Languages | Python ~81%, **Rust ~15%**, TypeScript ~2.5% |
| Build | **maturin** → one wheel = Python source **+** compiled Rust `headroom/_core.so` (PyO3, from `crates/headroom-py`) |
| Python | 3.10–3.14 |
| CLI | `headroom` → `headroom.cli:main` (click) |
| Core deps (light) | `tiktoken`, `pydantic`, `litellm` (lazy, `<3.14`), `click`, `rich`, `opentelemetry-api`, `ast-grep-cli` |
| Heavy deps | all optional extras: `[proxy]`, `[code]`, `[ml]`, `[memory]`, `[vector]`, `[relevance]`, `[image]`, … `[all]` |
| Modes | library · proxy (`headroom proxy`) · MCP server · agent wrap |
| Reversibility | **CCR** (Compress-Cache-Retrieve) |
| Docker | `ghcr.io/chopratejas/headroom` |
| Telemetry | **off by default** (opt-in `HEADROOM_TELEMETRY=on`) |
| Upstream cadence | extremely active: 161 releases, daily PRs (#1900s), 183 contributors; release-please (python), tags `v*` |

Claimed savings: **60–95%** on JSON/data tool outputs, **15–20%** on coding-agent
traffic. Attribution: bundles **RTK** for shell-output rewriting; can use
`lean-ctx` (`HEADROOM_CONTEXT_TOOL=lean-ctx`).

---

## 2. Core mechanism (how it compresses)

Pipeline (Python): `parse_messages` → `TransformPipeline([ContentRouter,
CacheAligner, …])` → provider transport. The **proxy** wraps this same pipeline
and adds serving concerns.

### 2.1 ContentRouter (`transforms/content_router.py`, ~4.9k lines)
The dispatcher. It detects content type (a **magika** ML detector + regex, with
a **native Rust detector** behind a circuit breaker), handles **mixed content by
splitting** into sections, routes each section to the best compressor, and
**reassembles** with routing metadata. This is conceptually the exact router
pinpoint needs — pxpipe just becomes one more route.

### 2.2 Compressors (`transforms/`)
| Compressor | Content | Notes |
|---|---|---|
| **SmartCrusher** (`smart_crusher.py`) | JSON / arrays | **Rust-backed** via PyO3; statistical row dedup/drop; 70–90% on tool outputs; emits CCR sentinels |
| **CodeAwareCompressor** (`code_compressor.py`) | source code | **AST via tree-sitter**; guarantees valid syntax; preserves imports/signatures/types/error-handlers, compresses bodies; Py/JS/TS + Go/Rust/Java/C/C++; based on LongCodeZip (arXiv 2510.00446) |
| **KompressCompressor** (`kompress_compressor.py`) | plain text | **ModernBERT** ONNX INT8 model `chopratejas/kompress-v2-base` (auto-downloaded); token-drop with a **must-keep regex** (numbers, ALLCAPS, dotted/unix paths, extensions, CLI flags, CamelCase) so fragile identifiers survive |
| SearchCompressor | grep/ripgrep results | |
| LogCompressor | build/test output | |
| DiffCompressor | diffs | |
| HtmlExtractor / spreadsheet_ingest / tabular_ingest / text_crusher | HTML, xlsx, tables, prose | |

Support transforms: `cross_turn_dedup`, `lossless_compaction`, `read_lifecycle`
/ `read_maturation` (relevance-based expansion of recently-read content),
`tag_protector`, `anchor_selector`, `adaptive_sizer`, `compression_policy`,
`relevance_split`.

### 2.3 CacheAligner (`transforms/cache_aligner.py`) — detector-only
**Key finding.** Because of invariant **I2 (never mutate the cache hot zone /
system prompt)**, `CacheAligner` no longer rewrites anything. It only **detects**
volatile content in the system prompt (UUIDs, ISO-8601 timestamps, JWTs, hex
hashes — via structural parsers, not regex) and **emits warnings** so callers
know their cache prefix is unstable. Contrast with pxpipe, which *splits and
images* that same slab. → This is the seam that makes them non-conflicting (§11).

### 2.4 The proxy (`proxy/server.py`, ~5k lines)
FastAPI/uvicorn. `python -m headroom.proxy.server --port 8787`;
`ANTHROPIC_BASE_URL=http://localhost:8787 claude`. Features: context optimization
(SmartCrusher + CacheAligner, **live-zone-only after Phase B**), semantic caching,
rate limiting (token bucket), retry w/ backoff, cost tracking/budgets, provider
fallback, Prometheus metrics, full logging, and **CCR tool injection**. Degrades
gracefully if the `[proxy]` extra is absent (`FASTAPI_AVAILABLE` guard).

**Default posture = CACHE mode** (`HEADROOM_MODE`, default `PROXY_MODE_CACHE`):
delta-only compression at ~0 prefix-cache busts, and **image compression is
skipped**. In cache mode the **Anthropic transport handler owns the single
forwarded `cache_control` breakpoint** (`normalize_message_cache_control` /
`relocate_cache_breakpoint`) — a direct conflict with pxpipe if both run on the
same `/v1/messages` transport (avoided by calling `/v1/compress` instead; see
[`end_product.md`](./end_product.md) §4.4). Extensively tunable via `HEADROOM_*`
(`DISABLE_KOMPRESS[_ANTHROPIC]`, `LOSSLESS`, `CODE_AWARE_ENABLED`,
`CCR_BACKEND`/`CCR_TTL_SECONDS`/`CCR_SQLITE_PATH`, `SAVINGS_PROFILE`, …) plus a
per-call `config`.

---

## 3. Repository & module map

### Python package `headroom/` (~174k LOC)
| Area | Modules | Role |
|---|---|---|
| Public API | `__init__.py`, `client.py`, `compress.py` | `compress()` one-fn + `HeadroomClient` wrapper |
| Pipeline | `pipeline.py`, `parser.py`, `tokenizer.py`, `config.py` | orchestration |
| **Transforms** | `transforms/*` | routing + all compressors (§2) |
| **CCR** | `ccr/*` | reversible store (§8) |
| Proxy | `proxy/*` (39 files; handlers for `openai`, `anthropic`, `gemini`, `streaming`, `batch`) | serving |
| Providers | `providers/*` (codex, opencode, …) | provider routing |
| Memory | `memory/*` (23 files) | per-project vector memory + SharedContext |
| Learn | `learn/*` | failure-mining → `CLAUDE.local.md` |
| Cache | `cache/*` | semantic cache, compression store |
| Models | `models/*` | Kompress model glue |
| Relevance | `relevance/*` | BM25 / embedding / hybrid scorers |
| Image | `image/*` | OCR (rapidocr) + SigLIP routing — **image→text**, the *opposite* of pxpipe's text→image (skipped in CACHE mode, so it won't OCR pxpipe's PNGs) |
| Telemetry | `telemetry/toin.py` | TOIN learning loop (§7) |
| Ops | `cli/*` (23), `install/*`, `subscription/*`, `dashboard/*`, `perf/*`, `pricing/*`, `observability/*` | |

### Rust workspace `crates/`
`headroom-core` (auth_mode, cache_control, `ccr`, compression_policy, onnx_cpu,
`relevance`, `signals`, `tokenizer`, `transforms`), `headroom-proxy`,
**`headroom-py`** (PyO3 cdylib → `_core.so`), **`headroom-parity`** (asserts
byte-equality vs the Python it replaced). serde_json is configured for
byte-faithful round-trips (`preserve_order` + `arbitrary_precision` + `raw_value`)
to satisfy invariant **I1 (byte-faithful passthrough on unmutated bytes)**.

### TS SDK `sdk/typescript/`
`src/{client,compress,simulate,hooks,shared-context,types,errors}.ts` + adapters
(`vercel-ai`, `openai`, `anthropic`, `gemini`). Ships `parity.test.ts`. **It is an
HTTP client to the proxy**, not a native engine.

---

## 4. Public API surface

### 4.1 Python — `compress()` (the embeddable one-function API)
```python
from headroom import compress
result = compress(messages, model="claude-sonnet-4-5")
result.messages           # same format, fewer tokens
result.tokens_saved
result.compression_ratio
```
`CompressConfig`: `compress_user_messages=False`, `compress_system_messages=True`,
`protect_recent=4`, `protect_analysis_context=True`, `target_ratio`,
`min_tokens_to_compress=250`, `kompress_model` (`'disabled'` skips ML),
`savings_profile` (e.g. `'agent-90'`). Framework-agnostic (Anthropic/OpenAI/
LiteLLM/httpx).

### 4.2 Python — `HeadroomClient` (wrapper)
Wraps an OpenAI/Anthropic client; modes `audit` | `optimize`; `.simulate()` for a
dry-run savings plan; `.get_stats()`. Per-call knobs (`headroom_mode`,
`headroom_keep_turns`, `headroom_tool_profiles`, …).

### 4.3 MCP server
Tools: **`headroom_compress`**, **`headroom_retrieve`**, **`headroom_stats`** —
for Claude Code / Cursor / any MCP host.

### 4.4 Proxy routes (and the stateless seam pinpoint uses)
Transport: `/v1/chat/completions`, `/v1/messages`, `/v1/responses`
(Codex/gpt-5.4+ via WebSocket), plus `/stats`, `/metrics`, `/health`,
`/dashboard`.

**Stateless compression seam (key for pinpoint):**
- `POST /v1/compress` (loopback-only) → `handle_compress`. Body
  `{"messages":[...], "model":"...", "config":{}}`; returns `{messages,
  tokens_before, tokens_after, tokens_saved, compression_ratio,
  transforms_applied, ccr_hashes}`. `x-headroom-bypass: true` passes through.
  **Compresses content WITHOUT calling the LLM and WITHOUT touching
  transport-level `cache_control`** — so the caller can own its own breakpoint.
- `POST /v1/retrieve`, `POST /v1/retrieve/tool_call`, `GET /v1/retrieve/{hash}`
  (loopback-only) — CCR retrieval, for servicing `headroom_retrieve` out of band.
- `POST /admin/runtime-env` (loopback-only) — hot-reload settings without restart.

### 4.5 SDK/framework wrappers
`withHeadroom(anthropic)` / `withHeadroom(openai)`, Vercel AI SDK middleware,
LangChain, Agno, Strands, LiteLLM callback (all 100+ providers).

---

## 5. CLI & runtime surface

`headroom <cmd>` (click). Commands: **`proxy`**, **`wrap`**, **`mcp`**, `memory`,
`learn`, `doctor`, `perf`, `savings`, `output-savings`, `audit`, `capture`,
`init`, `install`, `update`, `tools`, `evals`, `agent-savings`, `copilot-auth`.

**`headroom wrap <agent>`** — the flagship distribution UX: starts the proxy +
context tool and launches the agent, one command. Supports `claude`, `codex`,
`copilot`, `cursor` (prints config), `aider`, `opencode`, `cline`, `continue`,
`goose`, `openhands`, `openclaw` (plugin), `vibe`. Flags: `--port`,
`--no-context-tool`, and `-- <passthrough args>`. Undo with `headroom unwrap`.

Config: env (`HEADROOM_*`) + config file; persistent installs via
`headroom init` / `headroom install apply`.

---

## 6. Providers & agent matrix

Providers: Anthropic, OpenAI (Chat + Responses/Codex), Gemini, Bedrock, LiteLLM
(100+), any-llm. Agents (via `wrap`): Claude Code, Codex, Cursor, Aider, Copilot
CLI (+ subscription OAuth via `copilot-auth`), OpenClaw, OpenCode, Cline,
Continue, Goose, OpenHands, Mistral Vibe. Any OpenAI-compatible client works via
the proxy; MCP-native via `headroom mcp install`.

---

## 7. Measurement & learning

- **Savings tracker** (`proxy/savings_tracker.py`): honest counterfactual;
  supports a **holdout control group** (`HEADROOM_OUTPUT_HOLDOUT`) for *measured*
  (not estimated) output savings; dollar figures via LiteLLM pricing (needs
  Python <3.14).
- **Output-token reduction**: verbosity steering (terse-note appended to system
  prompt so prompt cache still hits) + effort routing (dial down "thinking" on
  routine resume turns). `HEADROOM_OUTPUT_SHAPER=1`.
- **TOIN** (`telemetry/toin.py`, ~1.6k lines): a learning loop —
  `record_compression()` feeds observed compressions back into future decisions.
- **`headroom learn`**: mines failed sessions and writes corrections to
  `CLAUDE.local.md` (default, gitignored) / `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`.

**Takeaway:** headroom's measurement is a superset of pxpipe's counterfactual
idea and can be pinpoint's unified measurement layer (§ [`end_product.md`](./end_product.md)).

---

## 8. Fidelity & reversibility — CCR

`ccr/` = **Compress-Cache-Retrieve**. When a compressor drops content it is not
gone: the original is cached and the LLM can fetch it on demand.

- **Tool injection** (`tool_injection.py`): the proxy injects a `headroom_retrieve`
  tool (`CCR_TOOL_NAME`) into the request when compression occurs.
- **Response handler** (`response_handler.py`): intercepts responses (incl.
  streaming) and auto-services CCR tool calls.
- **Context tracker** (`context_tracker.py`): tracks compressed content across
  turns; can proactively re-expand.
- **Batch processor**: handles CCR calls in batch-API results.
- **Sentinel**: SmartCrusher appends `{"_ccr_dropped": "<<ccr:HASH
  N_rows_offloaded>>"}` to a compressed array so the model sees the offload and
  can retrieve it.
- Two channels: **tool injection OR MCP server** (skips injection when MCP is
  configured, to avoid duplicate tools). Cross-provider (Anthropic/OpenAI/Google).

**Fidelity posture:** lossless-first dispatch; byte-faithful passthrough
(invariants I1/I2); Kompress's must-keep guard protects identifiers; recent turns
protected (`protect_recent`). This is the mirror image of pxpipe's `keepSharp` +
factsheet + `emitRecoverable` — the two reversibility models should **unify**
(§11, [`end_product.md`](./end_product.md)).

---

## 9. Strengths to take / constraints to respect

**Take:**
- **ContentRouter** — the multi-type routing pinpoint needs (pxpipe = one more route).
- **CCR** — a mature, cross-provider, reversible store + retrieval tool + MCP.
- **`wrap <agent>` + MCP + multi-provider proxy** — best-in-class distribution/UX.
- **Measurement/learning** (holdout, TOIN, output-shaper) — reusable as pinpoint's.
- **Rust core direction** — the long-term home for a single native engine.
- **Memory + SharedContext**, `headroom learn` — features pxpipe has no analog for.

**Respect / watch:**
- **Heavy & polyglot.** Python + Rust + optional ONNX/torch/HF/tree-sitter. `[all]`
  is large; base install is light but the interesting compressors need extras.
- **Proxy-centric.** In-process use = Python `compress()`; everything else assumes
  a running proxy. The **TS SDK is not a native engine.**
- **Native build.** maturin/PyO3; prebuilt wheels exist but sdist needs Rust.
- **Very fast-moving** (daily releases) — pin and gate upgrades.
- Runtime caveats: AVX2 for ONNX on x86 (auto-fallback), TLS/CA in corporate nets,
  LiteLLM `<3.14` for dollar figures.

---

## 10. Integration plan — the headroom side of the merge

### 10.1 Role in pinpoint
headroom is the **semantic compression engine** *and* the **orchestration +
distribution backbone**: its ContentRouter, CCR store, multi-provider proxy,
`wrap`, and MCP become pinpoint's spine. pxpipe plugs in as the **optical route**
for the static slab that headroom deliberately won't mutate (§11).

### 10.2 Embedding strategy (recommended)
**Consume headroom as a pinned dependency; do not fork.** Three access modes,
pick per pinpoint's core language (decided in [`end_product.md`](./end_product.md) §4):
- **Python in-process** — `from headroom import compress` (+ `HeadroomClient`,
  CCR, ContentRouter). Best fidelity/coverage; requires a Python core.
- **Proxy sidecar over HTTP** — run `headroom proxy`, talk to it (exactly how
  headroom's own TS SDK works). Language-agnostic; the natural fit if pinpoint's
  orchestrator is Node/TS.
- **Rust crates** — link `crates/headroom-core` directly (long-term, if pinpoint
  builds a Rust core alongside a ported pxpipe renderer).

### 10.3 Staying current with upstream ("always get the best")
- Keep `~/repos-pinpoint/headroom` as a **read-only tracking clone**.
- **Pin** `headroom-ai` (PyPI) / `headroom-ai` (npm) exact versions; automate
  update detection (Renovate/Dependabot + release-`v*`/PyPI watch).
- **Gate every bump** behind pinpoint's fidelity + savings smoke tests.
- Prefer the **public `compress()` / proxy / MCP contracts** over internal modules
  (internals churn daily; the Rust port is in flight).
- Record adopted versions + patches in pinpoint `UPSTREAM.md` / `PATCHES.md`.

### 10.4 Concrete steps (when implementation starts)
1. Stand up headroom as pinpoint's semantic backbone (in-process Python **or**
   sidecar proxy, per §10.2 / [`end_product.md`](./end_product.md)).
2. Wrap headroom behind pinpoint's uniform `SemanticCompressor` adapter
   (`compress()` + profitability + counterfactual + reversible handle) — mirror
   of pxpipe's `OpticalCompressor` (see [`pxpipe_integration.md`](./pxpipe_integration.md) §10.5).
3. Make **CCR the unified reversible store**: register pxpipe's imaged-block
   originals into the CCR store so `headroom_retrieve` returns them too.
4. Adopt **`wrap` + MCP** as pinpoint's front door; extend the agent matrix.
5. Use headroom's savings tracker/holdout as pinpoint's measurement layer.

### 10.5 Risks & mitigations
| Risk | Mitigation |
|---|---|
| Heavy/native install burden | Keep base light; make ML/optical stages opt-in extras; ship Docker |
| Daily upstream churn / Rust port in flight | Depend on public contracts; pin; gate on smoke tests |
| Double-compression overlap with pxpipe (tool_results/history) | Router assigns each region to exactly one engine (§11) |
| Cross-language ops complexity | Prefer one backbone process; sidecar only where required |
| Dollar-figure gaps (LiteLLM/AVX2/TLS) | Lead with token savings (like pxpipe); document env caveats |

---

## 11. The pxpipe ↔ headroom relationship (why they compose cleanly)

| | pxpipe (optical) | headroom (semantic) |
|---|---|---|
| Method | render text → PNG (lossy) | content-aware compress (lossless-first, reversible) |
| System prompt / static slab | **images it** | **refuses to touch it** (CacheAligner detector-only, I2) |
| Tool outputs / logs / JSON / code / RAG | can image (its default) | **specialized compressors + CCR** |
| Reversibility | `emitRecoverable` / factsheet / `keepSharp` | **CCR** retrieval tool + sentinels |
| Providers | Anthropic + OpenAI (scoped, Fable-5 default) | Anthropic/OpenAI/Gemini/Bedrock/LiteLLM |
| Language | TypeScript (tiny, pure-JS) | Python + Rust (heavy) |
| Distribution | `npx` proxy | `wrap`/MCP/proxy/library |

**The clean partition (pinpoint MVP):** pxpipe handles **only the static
system/tool-docs slab** (its strongest, safest win, on its supported models) —
precisely the region headroom's I2 forbids mutating. headroom handles
**everything else** (tool_results, history, logs, JSON, code, RAG, search) with
reversible semantic compression across all providers. One **content router**
assigns each region to exactly one engine so nothing is double-compressed; one
**CCR store** makes both reversible. Details in [`end_product.md`](./end_product.md).

---

_Investigation basis: `pyproject.toml`, `Cargo.toml`, `llms.txt`,
`headroom/__init__.py`, `client.py`, `compress.py`,
`transforms/{content_router,smart_crusher,cache_aligner,kompress_compressor,code_compressor}.py`,
`ccr/__init__.py`, `proxy/server.py`, `cli/{main,wrap}.py`, the `crates/` Rust
workspace, and `sdk/typescript/{package.json,client.ts,compress.ts,index.ts}`,
plus release config and commit cadence, at headroom `main` (v0.31.0, commit
`1d2b76e7`)._
