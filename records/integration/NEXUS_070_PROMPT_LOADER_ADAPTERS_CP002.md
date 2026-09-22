# Nexus 0.7.0 — Prompt Loader Adapters CP002

**Date:** 2026-09-22  
**Repository:** `Bermieee/Development`  
**Branch:** `Development-New-Features`  
**CP001 record commit:** `91ef7a440b5c4dce84b4d827e6f48cf7808c77d5`  
**Checkpoint head:** `c53b77dae8c4d8d7f625a1c9a0ce150724edbbfd`  
**Status:** SOURCE GREEN / LIVE PROVIDER ACCEPTANCE PENDING

## Purpose

CP002 turns Prompt Loader's lore presentation-cache shadow into an active, evidence-gated cache-preservation policy without changing Retrieval semantics.

The optimization is presentation-only:
- Retrieval selects the same lore candidates.
- Required refs remain required.
- Optional budget admission is unchanged.
- Included UID membership is unchanged.
- Tree/region/node routing is unchanged.
- Generation Frame remains the only physical Nexus Main-context writer.
- Native World Info suppression/rollback authority is unchanged.

Only the serialization order of already-admitted `LORE:SELECTED` entries may change.

## Stable survivor ordering

For a verified cache-capable provider route, Prompt Loader uses:

`stable-survivors-append`

Policy:
1. Keep currently-selected entries that survived from the prior published lore block in their prior presentation order.
2. Remove entries Retrieval no longer selected.
3. Append genuinely new selected entries deterministically in canonical book/UID/title order.

Example:
- prior published: `B, C`
- current selected set: `A, B, C`
- published: `B, C, A`

Next:
- prior published: `B, C, A`
- current selected set: `C, A, D`
- published: `C, A, D`

No stale entry is retained merely for cache continuity.

## Evidence gating

Active survivor ordering is enabled only when the actual provider route has a documented prefix/prompt-cache contract.

Examples:
- direct DeepSeek -> active
- direct OpenAI -> active
- direct Xiaomi MiMo -> active
- Alibaba Model Studio / DashScope Qwen or hosted GLM -> active
- OpenRouter -> canonical / shadow only
- arbitrary Custom/proxy -> canonical / shadow only
- unknown provider -> canonical / shadow only

Model family and provider route are separate facts. A DeepSeek/MiMo/Qwen model through OpenRouter does not inherit the first-party provider's cache guarantee.

## SillyTavern Custom first-party route recognition

The provider resolver now recognizes verified first-party hosts behind SillyTavern's `custom` chat-completion source.

### Xiaomi MiMo
Recognized:
- `api.xiaomimimo.com`
- `*.xiaomimimo.com` including Token Plan endpoints

### DeepSeek
Recognized:
- `api.deepseek.com`

### OpenAI
Recognized:
- `api.openai.com`

### Alibaba Model Studio
Recognized narrowly:
- DashScope hosts such as `dashscope.aliyuncs.com`, `dashscope-intl.aliyuncs.com`, `dashscope-us.aliyuncs.com`, regional DashScope variants
- workspace-specific `*.maas.aliyuncs.com`

Unrelated `aliyuncs.com` services are not trusted as Model Studio endpoints.

No Z.AI Custom endpoint classifier was added because CP002 did not obtain sufficiently authoritative current endpoint evidence. Direct Z.AI Custom remains conservative.

## Retrieval cache-state fencing

Successful Retrieval now remembers:
- Main model
- normalized Main provider route
- lore presentation policy
- injection budget

Cached injection text is reusable only when those boundaries remain compatible.

A provider/policy transition such as:
`OpenRouter MiMo -> direct Xiaomi MiMo`
forces a clean re-render rather than reusing text serialized under the prior route policy.

## Presentation history lifecycle

Lore presentation history is:
- scoped by chat + Nexus epoch,
- bounded to a small number of scopes,
- explicitly cleared on chat change.

Stale/rolled-back Retrieval work still cannot update presentation history; observation occurs only after publication freshness checks and successful Retrieval state commit.

## Realized gain telemetry

CP002 retains both:
- the actual published lore order, and
- the canonical counterfactual for the same admitted UID set.

Diagnostics can therefore report:
- canonical/shadow potential prefix gain, or
- active survivor ordering with **realized prefix tokens preserved vs canonical**.

This avoids the old measurement problem where an active stable-order policy compared against itself and appeared to save zero tokens.

## Adapter/rendering hardening included since CP001

- Compiled Generation Frame sections are shared across adapter families only when their renderer contracts are byte-compatible.
- Bracket families can share compiled sections.
- Claude/Gemini XML families can share compiled sections.
- XML <-> bracket changes do not share compiled sections.
- Stable-prefix comparison is reset across incompatible presentation formats rather than reporting a false cache collapse.
- XML-only Nexus frames are recognized by final-prompt telemetry.
- Adapter match/mismatch is retained outside the bounded telemetry ring.
- Diagnostics show adapter evidence basis, request verification, comparison resets, lore ordering strategy, and realized cache gain.

## Provider evidence

- Xiaomi MiMo API first-party OpenAI endpoints:
  - `https://api.xiaomimimo.com/v1`
  - Token Plan first-party `*.xiaomimimo.com` endpoints
- DeepSeek first-party API:
  - `https://api.deepseek.com`
- Alibaba Model Studio:
  - DashScope compatible-mode endpoints
  - workspace-specific `*.maas.aliyuncs.com` endpoints
- Provider cache semantics remain evidence-tagged in the adapter profile.

## Changed files since CP001 record

- `.github/workflows/prompt-loader-adapter-validation.yml`
- `index.js`
- `nexus/generation-frame.js`
- `nexus/prompt-loader-adapters.js`
- `observability/prompt-loader-telemetry.js`
- `observability/token-estimator.js`
- `observability/ui.js`
- `retrieval/presentation-cache-analysis.js`
- `retrieval/retriever.js`
- `retrieval/state.js`
- `tests/prompt-loader-adapters.mjs`

## Validation

Workflow: `Prompt Loader Adapter Validation`  
Run: `35689661867`

Result:
- Prompt Loader adapter/cache regression: **PASS**
- Full JS/MJS syntax sweep: **PASS**
- Syntax files checked: **338**
- Workflow conclusion: **SUCCESS**

Coverage includes:
- model-family adapter selection,
- source-aware ST model resolution,
- verified Custom MiMo routes,
- verified Alibaba Model Studio routes,
- rejection of unrelated proxy/cloud hosts,
- provider-route cache evidence,
- survivor-first lore planning,
- exact selected-set preservation,
- canonical fallback,
- provider/policy reuse fences,
- XML/bracket renderer isolation,
- realized prefix-gain measurement,
- request-time adapter verification,
- diagnostics retention.

## Pending live acceptance

1. Run real consecutive generations on a direct cache-capable route and verify:
   - adapter request verification = match,
   - presentation strategy = `stable-survivors-append`,
   - realized prefix tokens > 0 when new lore is appended behind survivors.
2. Confirm provider-reported cache-hit accounting if/when SillyTavern exposes reliable frontend usage fields.
3. Compare observed billing/cache metrics before and after active lore ordering.
4. Keep OpenRouter/custom unknown routes canonical until route-specific evidence justifies activation.
