# Nexus 0.7.0 — Prompt Loader Adapters CP001

**Date:** 2026-09-22  
**Repository:** `Bermieee/Development`  
**Branch:** `Development-New-Features`  
**Baseline:** `96746cccee96c87a1d9971a32dbe88ee529b201b`  
**Checkpoint head:** `ec27abfaf9ff532d84884f636e014360b8891673`  
**Status:** SOURCE GREEN / LIVE MULTI-PROVIDER ACCEPTANCE PENDING

## Purpose

CP001 converts Prompt Loader from diagnostics-only observation into a model-aware Nexus presentation layer while preserving existing semantic and physical prompt authority.

Prompt Loader adapters may alter **Nexus-owned presentation only**. They do not own:
- SillyTavern/provider chat templates or special tokens,
- retrieval/lore selection,
- memory selection,
- Generation Frame publication authority,
- physical Main prompt writes,
- model sampling/reasoning controls.

`nexus/generation-frame.js` remains the single physical writer for Nexus Main context.

## Implemented

### 1. Model-family adapter registry

Added `nexus/prompt-loader-adapters.js` with automatic family detection for:
- DeepSeek
- GLM
- Gemini
- Claude
- MiMo
- Qwen
- OpenAI
- Generic fallback

The selected adapter is sealed into the exact Generation Frame so a profile cannot change mid-generation.

### 2. Source-aware SillyTavern Main model detection

`resolveMainModelHint()` no longer scans populated provider model fields in arbitrary order.

SillyTavern keeps multiple provider selections populated simultaneously. For example, `openai_model`, `claude_model`, `google_model`, and `openrouter_model` may all contain values while the active source is OpenRouter.

The resolver now:
1. accepts exact request model metadata when available,
2. resolves the active chat-completion source,
3. selects the model field belonging to that source,
4. separately handles text-completion backends,
5. refuses to infer an active provider from unrelated top-level `type` / `source` metadata.

Regression coverage explicitly verifies:
`chat_completion_source=openrouter + openai_model=gpt-* + openrouter_model=xiaomi/mimo-* -> MiMo`, not OpenAI.

### 3. Family-specific Nexus presentation

Current presentation profiles:

| Family | Nexus wrapper | Basis |
| --- | --- | --- |
| Claude | XML sections | Provider-documented structured XML prompting |
| Gemini | XML sections | Provider-documented consistent XML/Markdown delimiters |
| DeepSeek | Nexus brackets | Conservative Nexus format |
| GLM | Nexus brackets | Conservative Nexus format |
| MiMo | Nexus brackets | Conservative Nexus format |
| Qwen | Nexus brackets | Conservative Nexus format |
| OpenAI | Nexus brackets | Conservative Nexus format |
| Generic | Nexus brackets | Conservative Nexus format |

XML presentation uses Nexus-owned wrappers such as:
`<nexus_context_legend>`
and
`<nexus_section id="retrieval-lore" label="LORE:SELECTED">`.

Semantic outlet content is unchanged.

### 4. Cache-safe adapter switching

Compiled Generation Frame sections are now keyed by Prompt Loader presentation identity.

A section compiled under the Claude/Gemini XML presentation cannot be reused after switching to a bracket-family adapter, and vice versa.

Regression coverage verifies sealed Claude recomposition remains Claude/XML and produces the same serialized bytes/hash.

### 5. Stable-prefix policy

All profiles currently retain canonical Nexus outlet order and:
`cachePolicy = stable-prefix-volatile-tail`.

Stable/reusable Nexus material stays ahead of volatile Scene/Delta material. Prompt Loader does not reorder by model score, completion timing, or dynamic relevance.

### 6. Provider-route-aware cache evidence

Cache guarantees are attributed to the actual provider route, not blindly inherited from the model family.

Examples:
- direct DeepSeek route -> `provider-documented-prefix-cache`
- direct OpenAI route -> `provider-documented-prompt-cache`
- direct Xiaomi/MiMo route -> `provider-documented-prefix-cache`
- Alibaba/DashScope Qwen or hosted GLM route -> `provider-documented-prefix-cache`
- OpenRouter -> `router-dependent-unverified`
- custom/proxy endpoint -> `custom-endpoint-unverified`
- unknown provider -> `provider-unidentified`

This prevents Nexus from claiming first-party cache behavior when a model is reached through a router or unknown proxy.

### 7. Request-time adapter verification

When SillyTavern emits the actual `CHAT_COMPLETION_SETTINGS_READY` request model/provider, Nexus compares it with the adapter sealed into the Generation Frame.

Telemetry emits:
- `prompt-loader / adapter-verified`, or
- `prompt-loader / adapter-mismatch`.

Mismatch does not rewrite the already-sealed in-flight prompt. It is reported as a warning and the observed request metadata is retained for subsequent generations.

### 8. Durable diagnostic visibility

Prompt Loader diagnostics now retain:
- active family,
- adapter ID/layout,
- wrapper style,
- cache policy,
- evidence basis,
- latest actual-request verification.

The latest verification lives outside the bounded event ring so noisy post-turn telemetry cannot erase the last mismatch.

Diagnostics can display:
- `request verified`, or
- `REQUEST MISMATCH sealed <family> -> actual <family>`.

## Provider evidence used

- Anthropic prompting guidance: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/prompt-templates-and-variables
- Google Gemini prompt design guidance: https://ai.google.dev/gemini-api/docs/prompting-strategies
- DeepSeek context caching: https://api-docs.deepseek.com/guides/kv_cache/
- Alibaba Model Studio context cache: https://www.alibabacloud.com/help/en/model-studio/context-cache
- Xiaomi MiMo API/cache usage: https://mimo.mi.com/docs/en-US/api/chat/openai-api
- Xiaomi MiMo pricing/cache-hit behavior: https://mimo.mi.com/docs/en-US/price/pay-as-you-go

The evidence contract is intentionally conservative when the current route is OpenRouter/custom because the first-party model provider's cache implementation cannot be assumed to survive an intermediary route unchanged.

## Changed files

- `.github/workflows/prompt-loader-adapter-validation.yml`
- `index.js`
- `nexus/generation-frame-bus.js`
- `nexus/generation-frame-contract.js`
- `nexus/generation-frame.js`
- `nexus/prompt-loader-adapters.js`
- `observability/prompt-loader-telemetry.js`
- `observability/telemetry.js`
- `observability/token-estimator.js`
- `observability/ui.js`
- `tests/prompt-loader-adapters.mjs`

## Validation

GitHub Actions workflow:
`Prompt Loader Adapter Validation`

Run:
`35688594034`

Result:
- Prompt Loader adapter regression: **PASS**
- Full JS/MJS syntax sweep: **PASS**
- Syntax files checked: **338**
- Workflow conclusion: **SUCCESS**

Regression coverage includes:
- family detection,
- source-aware OpenRouter model resolution,
- unrelated context metadata collision resistance,
- XML vs bracket presentation,
- semantic payload preservation,
- cross-profile compiled-cache isolation,
- sealed-profile recomposition,
- request adapter match/mismatch comparison,
- evidence retention,
- durable mismatch diagnostics.

## Still pending

1. Live acceptance against real SillyTavern requests for representative direct/OpenRouter/custom routes.
2. Provider-reported cache hit/miss ingestion if SillyTavern exposes a reliable frontend event or response hook. No trustworthy existing hook was found during CP001 inspection.
3. MiMo/GLM/Qwen presentation divergence beyond conservative bracket formatting. Do not add model-specific syntax without provider evidence or measured live Prompt Loader results.
4. Any future adapter tuning must preserve Generation Frame semantic selection, canonical mutation ownership, and the single physical Main writer boundary.
