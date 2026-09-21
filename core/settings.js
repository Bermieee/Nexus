import { extension_settings } from '../../../../extensions.js';
import { getRequestHeaders, saveSettings, saveSettingsDebounced } from '../../../../../script.js';
import { DEFAULT_VECTOR_PAGING } from '../paging/policy.js';
import { migrateLorebookBuilderSettings } from './settings-migrations.js';

export const EXTENSION_KEY = 'tv2';

// Keep migration defaults local so core Settings remains independently loadable.
const LEGACY_DECISION_OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const LEGACY_DECISION_OPENROUTER_MODEL = 'typesafe/jev-1.13';

export const DEFAULT_SIDECAR_PROFILE = Object.freeze({
    enabled: false,
    endpoint: '',
    apiKey: '',
    model: '',
    format: 'openai', // openai | anthropic | google
    // Provider/model physical capacity metadata. When known, Nexus derives the
    // request maximum from these real boundaries and the estimated input size.
    // When unknown, the client uses a generous emergency circuit breaker.
    providerMaxTokens: null,
    providerContextTokens: null,
    // Optional profile tuning/cost guardrails. inputBudgetTokens is a SOFT
    // packing hint only. outputCeilingTokens and totalBudgetTokens are treated
    // as explicit user cost limits when non-zero; defaults remain unlimited.
    inputBudgetTokens: null,
    outputCeilingTokens: null,
    totalBudgetTokens: null,
    temperature: 0.3,
    reasoningEffort: 'auto',
    timeoutMs: 120000,
    lastHealth: null, // lightweight provider-check result; never proof of current health
    // Per-worker participation. These are capability checkboxes in the Sidecar cards.
    // The central Bus still owns routing; a worker simply becomes ineligible for
    // stages it is not checked for.
    capabilities: {
        regionScan: true,
        nodeScan: true,
        search: true,
        smartContext: true,
        loreInjection: true,
        postTurn: true,
        summaries: true,
        maintenance: true,
        treeBuild: true,
    },
});

export const DEFAULT_SETTINGS = Object.freeze({
    vectorPaging: { ...DEFAULT_VECTOR_PAGING },
    enabled: false,
    // Compatibility UI state only. Nexus now has one Technical presentation; these
    // fields never change runtime routing, scheduling, mutation authority, Sidecar
    // execution, or retrieval semantics.
    ui: {
        presentationMode: 'technical',
        onboardingComplete: true,
        sidecarsCollapsed: true,
        lifecycleCollapsed: true,
    },
    // Nexus 0.6.2 coordination gates. These are intentionally OFF while the
    // legacy Nexus lifecycle remains the source of truth.  They permit shadow
    // planning and isolated subsystem migration without changing a working
    // Nexus setup merely because the new files are installed.
    nexus: {
        enabled: false,
        useLegacyFallback: true,
        workDirector: { enabled: false, shadowOnly: true, settleMs: 60, settleAttempts: 2 },
        transactionLedger: { enabled: false },
        executionEngine: { enabled: false },
        // Allow SillyTavern Main to participate as a Nexus model-worker by default
        // on fresh installs so Nexus remains usable without configured Sidecars.
        // Existing saved values remain authoritative: an explicit false stays off.
        // Main connectivity and Main-model boundary access are separate truths;
        // this switch only controls whether MAIN may participate in Nexus workloads.
        modelWorker: { useMain: true },
        // Foreground preflight uses the short value as a STALL watchdog. Any
        // authoritative outlet progress resets it. The hard cap remains the
        // final anti-hang circuit breaker for current-prompt work.
        foregroundPreflightTimeoutMs: 15000,
        foregroundPreflightHardCapMs: 60000,
        // Nexus-only Sidecar workload batching. This is deliberately outside
        // Call Center: Main/ST tool calls are never collected, delayed, or
        // batch-dispatched by this setting.
        // Sidecar workload resource targets are planning/packing preferences
        // only. They shape slicing, batching and synthesis compaction; they do
        // not terminate logical work or become transport max_tokens values.
        resourcePolicy: {
            enabled: true,
            defaultInputTargetTokens: 16000,
            defaultOutputTargetTokens: 3072,
            roleInputTargets: { retrieval: 24000, loreInjection: 20000, postTurn: 16000, summaries: 20000, maintenance: 12000, treeBuild: 24000, 'connectivity-test': 1000 },
            stageInputTargets: { diagnostics: 1000, retrieval: 24000, 'tree-region-scan': 24000, 'tree-region-condense': 20000, 'tree-node-scan': 24000, 'tree-node-condense': 20000, 'lore-injection': 20000, 'smart-context-warm': 12000, 'search-reasoning': 12000, 'postturn-memory': 16000, summary: 20000, 'memory-recall': 12000, 'summary-promotion': 18000, 'summary-lore-route': 20000, maintenance: 12000, 'tree-build': 24000 },
            domainInputTargets: { 'uid-summarizer': 12000, merge: 18000, tree: 24000, notebook: 12000, 'memory-bank': 20000, lorebook: 20000, reasoning: 12000 },
            roleOutputTargets: { retrieval: 4096, loreInjection: 3072, postTurn: 3072, summaries: 3072, maintenance: 2048, treeBuild: 4096, 'connectivity-test': 256 },
            stageOutputTargets: { diagnostics: 256, retrieval: 4096, 'tree-region-scan': 4096, 'tree-region-condense': 3072, 'tree-node-scan': 4096, 'tree-node-condense': 3072, 'lore-injection': 3072, 'smart-context-warm': 1600, 'search-reasoning': 1600, 'postturn-memory': 3072, summary: 3072, 'memory-recall': 1600, 'summary-promotion': 3072, 'summary-lore-route': 3072, maintenance: 2048, 'tree-build': 4096 },
            domainOutputTargets: { 'uid-summarizer': 4096, merge: 4096, tree: 4096, notebook: 2400, 'memory-bank': 3072, lorebook: 3072, reasoning: 1800 },
            phaseOutputTargets: { 'parallel-synthesis': 2048, 'consensus-review': 2048, 'cascade-second': 3072 },
            synthesis: { candidateTargetTokens: 2400, promptTargetTokens: 12000 },
        },
        batchLayer: {
            enabled: true,
            coalesceMs: 45,
            maxBatchItems: 10,
            targetInputTokens: 7000,
            summaryInputTokens: 7000,
            mergeInputTokens: 9000,
            recoveryAttempts: 1,
            domains: {
                'uid-summarizer': true,
                merge: true,
                tree: true,
                notebook: true,
                'memory-bank': true,
                lorebook: true,
                reasoning: true,
            },
        },
        lorebookBuilder: {
            // Builder-owned semantic request shape. Physical A/B scheduling remains
            // under nexus.batchLayer and is consumed read-only at plan creation.
            configVersion: 0,
            semanticPacking: {
                maxEntriesPerRequest: 12,
                targetInputTokens: 3500,
            },
        },
        callCenter: {
            enabled: false,
            mode: 'native',
            mainModelAccess: false,
            allowAutomatic: false,
            cooldownMs: 1500,
            testHarnessEnabled: true,
            switchboard: { notebook: 'sidecar', summarizer: 'sidecar', lorebook: 'sidecar', reasoning: 'sidecar', memoryBank: 'sidecar' },
            policy: {
                search: 'allow',
                'read-memory': 'allow',
                'cold-open': 'ask',
                remember: 'ask',
                update: 'ask',
                summarize: 'ask',
                organize: 'ask',
                merge: 'ask',
                split: 'ask',
                delete: 'deny',
            },
        },
        migration: { migratedWorkloads: [] },
    },
    trees: {},
    selectedLorebook: null,
    uidSummarizer: { detail: 'balanced', targetTokens: 320, includeKeywords: true },
    loreWriteValve: { mode: 'review', books: {} },
    // Experimental: one chat-scoped rolling world-state document. Its prompt
    // stays stable until an operator or sidecar refresh deliberately changes it.
    notebook: { enabled: true, automatic: true, contextMessages: 8, timeoutMs: 120000, reasoningEffort: 'medium', targetTokens: 1400, maxTokens: 1800, revisionLimit: 6, coldStart: { enabled: true, maxTokens: 700 } },
    enabledLorebooks: {},
    // Per-lorebook operator policy. Empty maps mean Read+Write and Nexus injection.
    bookPermissions: {},
    bookInjectionModes: {},
    bookDescriptions: {},
    // Provider-neutral bounded semantic judgment infrastructure. Decision Core
    // starts fully inert; no provider is required for Nexus correctness.
    decisionCore: {
        enabled: false,
        mode: 'off', // off | shadow (authoritative mode intentionally unavailable)
        provider: 'auto', // auto | openrouter-jev | typesafe-direct | llm-fallback-only
        fallbackEnabled: true,
        timeoutMs: 10000,
        connection: {
            endpoint: '',
            apiKey: '',
            model: 'jev-latest',
            lastTest: null,
        },
        openRouter: {
            // Compatibility metadata only. OpenRouter Jev now uses the explicit
            // Decision Core connection and never borrows Sidecar credentials.
            model: 'typesafe/jev-1.13',
            lastTest: null,
        },
        typeSafe: {
            apiKey: '',
            model: 'jev-latest',
            lastTest: null,
        },
    },
    sidecars: {
        A: { ...DEFAULT_SIDECAR_PROFILE },
        B: { ...DEFAULT_SIDECAR_PROFILE },
    },
    routing: {
        retrieval: 'A',
        loreInjection: 'A',
        postTurn: 'B',
        summaries: 'B',
        maintenance: 'B',
        treeBuild: 'B',
        modes: {
            retrieval: 'adaptive',
            loreInjection: 'adaptive',
            postTurn: 'adaptive',
            summaries: 'adaptive',
            maintenance: 'adaptive',
            treeBuild: 'adaptive',
        },
        // Hard locks override preferred-worker, load balancing, multi-worker modes,
        // and failure fallback for the named stage. null = broker-controlled.
        locks: {
            retrieval: null,
            loreInjection: null,
        },
        fallback: true,
        loadBalance: true,
    },
    retrieval: {
        enabled: false,
        contextMessages: 10,
        // When Nexus owns a story-scoped lorebook but no Tree exists yet,
        // select a bounded deterministic subset locally and suppress the rest
        // of native SillyTavern WI for that generation. If no safe subset can
        // be produced, native WI is retained fail-safe.
        bootstrapAdmission: { enabled: true, targetTokens: 3500, maxEntries: 24 },
        changeGateEnabled: true,
        // Shallow depth shown to regional pass 1. Pass 2 gets the full selected subtrees.
        regionPreviewDepth: 2,
        // NO_CHANGE can reuse proven injection. After this many consecutive reuses,
        // promote one turn to MINOR_CHANGE for a targeted freshness check.
        refreshAfterNoChangeTurns: 3,
        // Scatter/gather retrieval. When a regional/node prompt is larger than
        // the activation threshold, Nexus slices the Tree view and lets A+B drain
        // independent batches concurrently. The target is a packing goal, not a
        // hidden cap.
        batchFireEnabled: true,
        batchActivationInputTokens: 9000,
        batchTargetInputTokens: 6000,
        batchCondense: true,
        batchCondenseMinCandidates: 5,
        batchRerouteOnFailure: true,
        batchLoreInjectionEnabled: true,
        batchLoreInjectionThresholdTokens: 9000,
        // Explicitly allow completed slices to continue if one slice fails after
        // bounded cross-worker retry. Degradation is always logged visibly.
        batchAllowPartial: true,
        // null/0 = no Nexus injection budget. If the user explicitly sets one,
        // Nexus respects it at whole-entry boundaries and logs omissions.
        maxInjectionTokens: 0,
    },
    smartContext: {
        enabled: true,
        contextMessages: 8,
        sidecarRerank: true,
        // Adaptive Smart Warm is a Scene Scanner budget policy, not a new
        // prompt path: continuity pins remain stable and only the additional
        // predictive candidates scale 1 / 2 / 6 with immediate branch width.
        adaptiveWarm: {
            enabled: true,
            promoteAfter: 3,
            maxEarnedPins: 3,
        },
        // Protect character-driven beats from collapsing to a location-only
        // lore injection when explicit scene names map to Tree voice/dynamics.
        sceneAnchorGuard: true,
        // null/0 = no Nexus candidate-count cap; observe actual pool size in logs.
        candidatePoolSize: 0,
        cacheMaxAgeMs: 300000,
        decay: {
            enabled: true,
            maxMisses: 3,
        },
    },
    postTurn: {
        enabled: false,
        contextMessages: 10,
        // Logical post-turn jobs reshape above this soft packing target. Physical
        // provider calls remain governed by the hard Nexus resource policy.
        softPackingTargetTokens: 16000,
        // Post-turn analysis is intentionally allowed more wall-clock time than
        // foreground-adjacent retrieval. GLM-class reasoning models can spend
        // well over two minutes on a large memory review.
        timeoutMs: 240000,
        // Large reconstructed historical catch-up is never allowed to drain
        // silently. It must pass Lifecycle Decision admission first; when Jev
        // is unavailable the scheduler defers rather than processing stale lore.
        staleBacklogPendingCount: 20,
        staleBacklogAssistantTurns: 20,
    },
    scheduler: {
        enabled: true,
        automatic: true,
        tasks: {
            postTurn: true,
            summary: true,
            promotion: true,
            loreRouting: true,
            smartWarm: true,
            housekeeper: true,
        },
        // Per-chat automatic cadence. 0 preserves the legacy behavior: run the
        // enabled task after every completed assistant generation. Positive
        // values run after that many completed assistant turns.
        intervals: {
            postTurn: 3,
            // Rolling Notebook is periodic on ordinary turns, but the Work
            // Director may still run it immediately for a MAJOR scene change.
            notebook: 3,
            summary: 0,
            promotion: 0,
            loreRouting: 0,
            smartWarm: 0,
            housekeeper: 5,
        },
    },
    housekeeper: {
        enabled: true,
        // A sidecar-assisted maintenance pass is deliberately infrequent so it
        // cannot compete with current-scene retrieval on every generation.
        intervalMinutes: 30,
        maxBooksPerRun: 4,
        mergeThresholdPercent: 65,
        maxMergeSuggestions: 12,
        oversizedEntryChars: 7000,
    },
    memoryBank: {
        // Off on upgrade until the user explicitly enables recursive memory for
        // the chat. This avoids immediately processing a large existing backlog.
        enabled: false,
        verbatimTurns: 10,
        turnsPerSummary: 3,
        // Large imported/long-running chats catch up in wider chronological
        // spans while preserving the recent verbatim tail. Summary's existing
        // reshape pipeline slices these spans safely before provider dispatch.
        catchUpAssistantTurns: 24,
        catchUpThresholdAssistantTurns: 12,
        // Main RP raw-history governor. Once Summary Bank has valid contiguous
        // coverage, Nexus can stop paying to resend that covered history. The
        // start boundary is frozen across ordinary turns and rolls only in
        // blocks, preserving provider prefix-cache reuse.
        mainContext: {
            enabled: true,
            maxRawAssistantTurns: 18,
        },
        snippetsPerLayer: 20,
        snippetsPerPromotion: 3,
        maxLayers: 5,
        timeoutMs: 240000,
        reasoningEffort: 'high',
        recall: {
            enabled: true,
            sidecarRerank: true,
            contextMessages: 8,
            timeoutMs: 120000,
            // Foreground historical recall fails over earlier than long-running
            // maintenance work. The router still gets its normal A → B fallback.
            foregroundFallbackTimeoutMs: 60000,
            reasoningEffort: 'medium',
            // null/0 = no Nexus historical-memory injection ceiling.
            maxInjectionTokens: null,
        },
        loreRouting: {
            enabled: true,
            mode: 'balanced', // conservative | balanced | expansive
            maxPerCycle: 1,
            timeoutMs: 240000,
            reasoningEffort: 'high',
        },
        // Character Memory Banks are user-configured continuity lenses. Lead
        // banks keep their linked Nexus-readable lore refs warm; Supporting banks
        // warm only while scene-present by default; Background banks track
        // character memory without biasing retrieval.
        characterBanks: {
            enabled: true,
            banks: [],
        },
    },
    jobs: {
        // null/0 = no global Nexus concurrency cap. Sidecar resource locks still
        // serialize work per physical Sidecar while A and B may run together.
        maxConcurrent: null,
    },
    appearance: {
        preset: 'black-gold',
        font: 'inherit',
        shape: 'soft',
        background: '#070707',
        surface: '#0f0f10',
        surfaceAlt: '#171715',
        accent: '#d4af37',
        accent2: '#f0d878',
        text: '#e8d590',
        muted: '#a9965e',
        border: '#5f5026',
    },
    observability: {
        enabled: true,
        persistSession: true,
        capturePayloads: true,
        maxEvents: 500,
        captureChars: 4000,
    },
});

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function mergeDefaults(target, defaults) {
    let changed = false;
    for (const [key, value] of Object.entries(defaults)) {
        if (target[key] === undefined || target[key] === null) {
            target[key] = clone(value);
            changed = true;
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
                if (mergeDefaults(target[key], value)) changed = true;
            } else {
                target[key] = clone(value);
                changed = true;
            }
        }
    }
    return changed;
}

function normalizeAuthorityBooleans(target, defaults) {
    let changed = false;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return changed;
    for (const [key, defaultValue] of Object.entries(defaults || {})) {
        if (typeof defaultValue === 'boolean') {
            const before = target[key];
            // Missing values were already filled by mergeDefaults(). For an
            // explicitly malformed stored authority value, fail closed rather
            // than inheriting truthiness or the default-true value.
            target[key] = before === true;
            if (before !== target[key]) changed = true;
            continue;
        }
        if (defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue)) {
            if (normalizeAuthorityBooleans(target[key], defaultValue)) changed = true;
        }
    }
    return changed;
}

export function getSettings() {
    if (!extension_settings[EXTENSION_KEY]) extension_settings[EXTENSION_KEY] = {};
    const settings = extension_settings[EXTENSION_KEY];
    // 0.7.0 forward UI migration: the retired Simple/Technical split now has one
    // canonical surface. Keep compatibility fields durable, but always migrate
    // presentation state to Technical so no hidden branch can survive upgrades.
    const hadSidecarsCollapseState = settings.ui?.sidecarsCollapsed != null;
    const hadLifecycleCollapseState = settings.ui?.lifecycleCollapsed != null;
    let repaired = mergeDefaults(settings, DEFAULT_SETTINGS);
    if (settings.ui.presentationMode !== 'technical') { settings.ui.presentationMode = 'technical'; repaired = true; }
    if (settings.ui.onboardingComplete !== true) { settings.ui.onboardingComplete = true; repaired = true; }
    if (!hadSidecarsCollapseState) { settings.ui.sidecarsCollapsed = true; repaired = true; }
    if (!hadLifecycleCollapseState) { settings.ui.lifecycleCollapsed = true; repaired = true; }
    const normalizedSidecarsCollapsed = settings.ui.sidecarsCollapsed !== false;
    const normalizedLifecycleCollapsed = settings.ui.lifecycleCollapsed !== false;
    if (settings.ui.sidecarsCollapsed !== normalizedSidecarsCollapsed) { settings.ui.sidecarsCollapsed = normalizedSidecarsCollapsed; repaired = true; }
    if (settings.ui.lifecycleCollapsed !== normalizedLifecycleCollapsed) { settings.ui.lifecycleCollapsed = normalizedLifecycleCollapsed; repaired = true; }
    const markRepair = changed => { if (changed) repaired = true; };

    // 0.7.0 UI/wiring repair: provider selection is not a second master
    // enable/disable switch. Preserve the intent of the retired provider-level
    // "disabled" value by migrating it to the canonical master-off state.
    if (settings.decisionCore?.provider === 'disabled') {
        settings.decisionCore.provider = 'auto';
        settings.decisionCore.enabled = false;
        settings.decisionCore.mode = 'off';
        repaired = true;
    }

    // Decision Core currently exposes one user-visible operating state: on =
    // Shadow, off = Off. Keep the durable mode field for future modes without
    // presenting a duplicate off switch in Settings.
    if (settings.decisionCore) {
        const canonicalMode = settings.decisionCore.enabled === true ? 'assist' : 'off';
        if (settings.decisionCore.mode !== canonicalMode) { settings.decisionCore.mode = canonicalMode; repaired = true; }
    }

    // 0.7.0 Decision Core credential-boundary repair: retire the old
    // Sidecar-profile credential selector without throwing away non-secret Jev
    // connection metadata. A legacy OpenRouter selection may restore the known
    // Decisions endpoint/model, but NEVER copies or derives an API key from A/B.
    const legacyOpenRouterProfile = settings.decisionCore?.openRouter?.profile;
    if (settings.decisionCore?.openRouter && 'profile' in settings.decisionCore.openRouter) {
        settings.decisionCore.connection ||= {};
        if (legacyOpenRouterProfile && !String(settings.decisionCore.connection.endpoint || '').trim()) {
            settings.decisionCore.connection.endpoint = LEGACY_DECISION_OPENROUTER_ENDPOINT;
        }
        const currentModel = String(settings.decisionCore.connection.model || '').trim();
        if (legacyOpenRouterProfile && (!currentModel || currentModel === 'jev-latest')) {
            settings.decisionCore.connection.model = String(settings.decisionCore.openRouter.model || '').trim() || LEGACY_DECISION_OPENROUTER_MODEL;
        }
        delete settings.decisionCore.openRouter.profile;
        repaired = true;
    }

    // Stored booleans are authority values, not truthy/falsy suggestions.
    // Normalize every boolean represented by the settings schema, including
    // default-true fields. An explicitly malformed value always fails closed.
    markRepair(normalizeAuthorityBooleans(settings, DEFAULT_SETTINGS));

    // Development builds briefly placed batch tuning under Call Center. Move it
    // once into the Sidecar-only Nexus batch layer so no stored configuration
    // implies Main/ST tool calls can ever be batched.
    const legacyBatching = settings.nexus?.callCenter?.batching;
    if (legacyBatching && settings.nexus?.batchLayer && settings.nexus?.batchLayerMigrated !== true) {
        for (const key of ['enabled', 'summaryInputTokens', 'mergeInputTokens', 'maxBatchItems']) {
            if (legacyBatching[key] !== undefined) settings.nexus.batchLayer[key] = legacyBatching[key];
        }
        delete settings.nexus.callCenter.batching;
        settings.nexus.batchLayerMigrated = true;
        repaired = true;
    }

    // One-way Dev 2 compatibility migration. Tree semantic configuration now
    // belongs exclusively to Lorebook Builder; shared Batch Layer retains only
    // physical Sidecar scheduling configuration.
    markRepair(migrateLorebookBuilderSettings(settings.nexus));

    // v0.2.1: retire Nexus's old universal maxTokens ceiling. OpenAI-compatible
    // and Google profiles now use provider/model defaults unless the provider
    // itself requires an explicit ceiling. Preserve an old value only for an
    // Anthropic profile where max_tokens is a required request field.
    for (const slot of ['A', 'B']) {
        const profile = settings.sidecars?.[slot];
        if (!profile) continue;
        if (profile.providerMaxTokens == null && profile.format === 'anthropic' && Number(profile.maxTokens) > 0) {
            profile.providerMaxTokens = Number(profile.maxTokens);
            repaired = true;
        }
        if (Object.prototype.hasOwnProperty.call(profile, 'maxTokens')) { delete profile.maxTokens; repaired = true; }
    }
    // v0.3.0: the old scaffold silently imposed a 6000-token MiMo injection
    // ceiling. Treat that stock value as legacy and remove it; explicit custom
    // values survive as user-selected budgets.
    if (Number(settings.retrieval?.maxInjectionTokens) === 6000) { settings.retrieval.maxInjectionTokens = 0; repaired = true; }
    if (repaired) saveSettingsDebounced();
    return settings;
}

export function updateSettings(mutator) {
    const settings = getSettings();
    mutator(settings);
    saveSettingsDebounced();
    return settings;
}

// Authority-bearing settings are different from cosmetic/runtime preferences:
// Nexus must not begin using a new mutation boundary merely because the live
// extension_settings object changed.  This small state machine makes that
// uncertainty observable and gives mutation entry points a fail-closed gate.
let authoritySettingsState = { status: 'ready', label: null, error: null, paths: [], changedAt: 0 };
function authorityStatusEvent() {
    try { globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-authority-settings-status', { detail: getAuthoritySettingsStatus() })); } catch {}
}
export function getAuthoritySettingsStatus() {
    return {
        status: String(authoritySettingsState.status || 'ready'),
        label: authoritySettingsState.label || null,
        error: authoritySettingsState.error ? String(authoritySettingsState.error?.message || authoritySettingsState.error) : null,
        paths: (authoritySettingsState.paths || []).map(path => [...path]),
        changedAt: Number(authoritySettingsState.changedAt) || 0,
    };
}
export function assertAuthoritySettingsReady(label = 'Nexus authority') {
    if (authoritySettingsState.status === 'ready') return true;
    const detail = authoritySettingsState.error ? ` ${authoritySettingsState.error?.message || authoritySettingsState.error}` : '';
    const error = new Error(`${label} is blocked while operator authority settings are ${authoritySettingsState.status}.${detail}`);
    error.name = 'TV2AuthoritySettingsUnresolved';
    error.authoritySettings = getAuthoritySettingsStatus();
    throw error;
}
function setProjectionValue(root, path, snapshot) {
    if (!Array.isArray(path) || !path.length) throw new Error('Authority settings projection cannot target the settings root.');
    let current = root;
    for (let i = 0; i < path.length - 1; i++) {
        const segment = String(path[i]);
        if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) current[segment] = {};
        current = current[segment];
    }
    const key = String(path[path.length - 1]);
    if (snapshot?.exists === false) delete current[key];
    else current[key] = clone(snapshot?.value);
}
function sameProjectionValue(a, b) {
    return a?.exists === b?.exists && (a?.exists === false || canonicalJson(a?.value) === canonicalJson(b?.value));
}

/**
 * Apply an authority-bearing settings change under an awaited, projection-
 * specific durability barrier.  During the barrier all canonical mutation
 * entry points can fail closed through assertAuthoritySettingsReady().
 *
 * On failure only projection values still owned by this caller are restored;
 * a later same-path writer is never overwritten.  The authority state remains
 * explicitly failed until a later durable authority update succeeds.
 */
export async function updateAuthoritySettingsDurably(label, paths, mutator) {
    if (authoritySettingsState.status === 'pending') {
        const error = new Error(`Another authority settings durability barrier is already pending (${authoritySettingsState.label || 'Nexus authority'}).`);
        error.name = 'TV2AuthoritySettingsBusy';
        throw error;
    }
    const normalizedPaths = [...new Map((Array.isArray(paths) ? paths : []).map(path => {
        const normalized = (Array.isArray(path) ? path : []).map(String);
        return [normalized.join('\u0000'), normalized];
    })).values()].filter(path => path.length);
    if (!normalizedPaths.length) throw new Error('Authority settings durability requires at least one explicit projection path.');
    const settings = getSettings();
    const retryingFailedAuthority = authoritySettingsState.status === 'failed';
    const before = normalizedPaths.map(path => ({ path, ...projectionValue(settings, path) }));
    authoritySettingsState = { status: 'pending', label: String(label || 'Nexus authority settings'), error: null, paths: normalizedPaths, changedAt: Date.now() };
    authorityStatusEvent();
    try {
        mutator(settings);
    } catch (error) {
        for (const row of before) setProjectionValue(settings, row.path, row);
        authoritySettingsState = { status: 'failed', label: String(label || 'Nexus authority settings'), error, paths: normalizedPaths, changedAt: Date.now() };
        authorityStatusEvent();
        throw error;
    }
    const after = normalizedPaths.map(path => ({ path, ...projectionValue(settings, path) }));
    if (!retryingFailedAuthority && after.every((row, index) => sameProjectionValue(row, before[index]))) {
        authoritySettingsState = { status: 'ready', label: null, error: null, paths: [], changedAt: Date.now() };
        authorityStatusEvent();
        return settings;
    }
    try {
        await flushSettingsPersistence(label, { expected: after });
        authoritySettingsState = { status: 'ready', label: null, error: null, paths: [], changedAt: Date.now() };
        authorityStatusEvent();
        return settings;
    } catch (error) {
        // Roll back only values that are still exactly this caller's candidate.
        // If a later writer changed a path, preserve it and keep authority failed.
        for (let i = 0; i < after.length; i++) {
            const current = projectionValue(settings, after[i].path);
            if (sameProjectionValue(current, after[i])) setProjectionValue(settings, before[i].path, before[i]);
        }
        authoritySettingsState = { status: 'failed', label: String(label || 'Nexus authority settings'), error, paths: normalizedPaths, changedAt: Date.now() };
        authorityStatusEvent();
        throw error;
    }
}


function durabilityError(label, detail) {
    const error = new Error(`${label} durability barrier is unavailable: ${detail}`);
    error.name = 'TV2DurabilityBarrierUnavailable';
    return error;
}

let settingsDurabilityTail = Promise.resolve();
function projectionValue(root, path = []) {
    let current = root;
    for (const segment of path) {
        if (current == null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) return { exists: false, value: null };
        current = current[segment];
    }
    return { exists: true, value: current };
}
function normalizeSettingsProjection(expected) {
    if (!Array.isArray(expected)) return null;
    return expected.map(row => ({
        path: Array.isArray(row?.path) ? row.path.map(String) : [],
        exists: row?.exists !== false,
        value: clone(row?.value),
    }));
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

async function readPersistedNexusSettings(label) {
    if (typeof getRequestHeaders !== 'function') throw durabilityError(label, 'host request headers are unavailable.');
    let response;
    try {
        response = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), cache: 'no-store' });
    } catch (cause) {
        const error = durabilityError(label, 'saved settings could not be reloaded for verification.');
        error.cause = cause;
        throw error;
    }
    if (!response?.ok) throw durabilityError(label, `saved settings verification returned HTTP ${response?.status ?? 'unknown'}.`);
    let data;
    try { data = await response.json(); } catch (cause) {
        const error = durabilityError(label, 'saved settings verification returned unreadable JSON.');
        error.cause = cause;
        throw error;
    }
    let persisted = data?.settings;
    if (typeof persisted === 'string') {
        try { persisted = JSON.parse(persisted); } catch (cause) {
            const error = durabilityError(label, 'saved settings payload could not be decoded.');
            error.cause = cause;
            throw error;
        }
    }
    const nexus = persisted?.extension_settings?.[EXTENSION_KEY];
    if (!nexus || typeof nexus !== 'object') throw durabilityError(label, 'persisted Nexus settings could not be verified.');
    return nexus;
}

/**
 * Cross the SillyTavern settings durability boundary and prove the exact Nexus
 * extension projection reached host persistence. SillyTavern's debounced saver
 * is intentionally not treated as flushable: its public debounce helper does
 * not expose a flush API in the supported host.
 */
export async function flushSettingsPersistence(label = 'Nexus settings', { expected = null } = {}) {
    const projection = normalizeSettingsProjection(expected);
    // Freeze whole-state caller intent at the call boundary, before this request
    // can wait behind an earlier settings durability task.
    const expectedFull = projection ? null : clone(extension_settings[EXTENSION_KEY] || {});
    const task = async () => {
        if (typeof saveSettings !== 'function') throw durabilityError(label, 'direct host settings save is unavailable.');
        try { await Promise.resolve(saveSettings()); } catch (cause) {
            const error = durabilityError(label, 'direct host settings save failed.');
            error.cause = cause;
            throw error;
        }
        const persisted = await readPersistedNexusSettings(label);
        if (projection) {
            for (const row of projection) {
                const actual = projectionValue(persisted, row.path);
                if (actual.exists !== row.exists || (row.exists && canonicalJson(actual.value) !== canonicalJson(row.value))) {
                    throw durabilityError(label, `host persistence did not match the requested Nexus projection at ${row.path.join('.') || '(root)'}.`);
                }
            }
        } else if (canonicalJson(persisted) !== canonicalJson(expectedFull)) {
            throw durabilityError(label, 'host persistence did not match the requested Nexus state.');
        }
        return true;
    };
    const run = settingsDurabilityTail.then(task, task);
    settingsDurabilityTail = run.catch(() => {});
    return await run;
}


export function getSidecarProfile(slot) {
    const key = String(slot || '').toUpperCase();
    if (!['A', 'B'].includes(key)) throw new Error(`Unknown Nexus Sidecar slot: ${slot}`);
    return getSettings().sidecars[key];
}
