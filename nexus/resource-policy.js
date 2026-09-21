/**
 * Nexus Sidecar Resource Policy
 * -----------------------------
 * Workload values are planning/packing hints only. They may shape batching,
 * slicing, scheduling, and compaction, but they never define a transport-time
 * hard stop. Hard request boundaries belong to the Sidecar client where Nexus
 * can reconcile real provider/model capacity, explicit user cost limits, and
 * emergency runaway protection.
 */

/**
 * Static resource classification for Director-planned lifecycle work. These
 * descriptors are planning metadata only: they do not dispatch a worker or
 * select SC-A/SC-B.
 */
export const NEXUS_WORKLOAD_RESOURCE_INTENTS = Object.freeze({
    'smart-warm': Object.freeze({ role: 'retrieval', stage: 'smart-context-warm', domain: 'reasoning' }),
    'post-turn-extract': Object.freeze({ role: 'postTurn', stage: 'postturn-memory', domain: 'lorebook' }),
    'notebook-refresh': Object.freeze({ role: 'maintenance', stage: 'maintenance', domain: 'notebook' }),
    'summary': Object.freeze({ role: 'summaries', stage: 'summary', domain: 'memory-bank' }),
    'summary-promotion': Object.freeze({ role: 'summaries', stage: 'summary-promotion', domain: 'memory-bank' }),
    'lore-routing': Object.freeze({ role: 'summaries', stage: 'summary-lore-route', domain: 'lorebook' }),
    'maintenance': Object.freeze({ role: 'maintenance', stage: 'maintenance', domain: 'reasoning' }),
});

export function getNexusWorkloadResourceIntent(workloadType = '') {
    const row = NEXUS_WORKLOAD_RESOURCE_INTENTS[String(workloadType || '').trim()] || null;
    return row ? { ...row } : null;
}

/**
 * These numbers deliberately retain the historical Nexus tuning values, but
 * their authority has changed: they are SOFT TARGETS. Existing installations
 * may still have the legacy *Budget/*Ceiling keys persisted in settings; the
 * merger below interprets those legacy values as soft targets too.
 */
export const DEFAULT_NEXUS_RESOURCE_POLICY = Object.freeze({
    enabled: true,
    defaultInputTargetTokens: 16000,
    defaultOutputTargetTokens: 3072,
    roleInputTargets: {
        retrieval: 24000,
        loreInjection: 20000,
        postTurn: 16000,
        summaries: 20000,
        maintenance: 12000,
        treeBuild: 24000,
        'connectivity-test': 1000,
    },
    stageInputTargets: {
        diagnostics: 1000,
        retrieval: 24000,
        'tree-region-scan': 24000,
        'tree-region-condense': 20000,
        'tree-node-scan': 24000,
        'tree-node-condense': 20000,
        'lore-injection': 20000,
        'smart-context-warm': 12000,
        'search-reasoning': 12000,
        'postturn-memory': 16000,
        summary: 20000,
        'memory-recall': 12000,
        'summary-promotion': 18000,
        'summary-lore-route': 20000,
        maintenance: 12000,
        'tree-build': 24000,
    },
    domainInputTargets: {
        'uid-summarizer': 12000,
        merge: 18000,
        tree: 24000,
        notebook: 12000,
        'memory-bank': 20000,
        lorebook: 20000,
        reasoning: 12000,
    },
    roleOutputTargets: {
        retrieval: 4096,
        loreInjection: 3072,
        postTurn: 3072,
        summaries: 3072,
        maintenance: 2048,
        treeBuild: 4096,
        'connectivity-test': 256,
    },
    stageOutputTargets: {
        diagnostics: 256,
        retrieval: 4096,
        'tree-region-scan': 4096,
        'tree-region-condense': 3072,
        'tree-node-scan': 4096,
        'tree-node-condense': 3072,
        'lore-injection': 3072,
        'smart-context-warm': 1600,
        'search-reasoning': 1600,
        'postturn-memory': 3072,
        summary: 3072,
        'memory-recall': 1600,
        'summary-promotion': 3072,
        'summary-lore-route': 3072,
        maintenance: 2048,
        'tree-build': 4096,
    },
    domainOutputTargets: {
        'uid-summarizer': 4096,
        merge: 4096,
        tree: 4096,
        notebook: 2400,
        'memory-bank': 3072,
        lorebook: 3072,
        reasoning: 1800,
    },
    phaseOutputTargets: {
        'parallel-synthesis': 2048,
        'consensus-review': 2048,
        'cascade-second': 3072,
    },
    synthesis: {
        candidateTargetTokens: 2400,
        promptTargetTokens: 12000,
    },
});

function positiveInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function mergeTargetMap(defaults, modern, legacy) {
    // Legacy aliases remain readable for migration, but they can never override
    // an explicitly configured modern target.
    return { ...(defaults || {}), ...(legacy || {}), ...(modern || {}) };
}

function mergedPolicy(settings = {}) {
    const configured = settings?.nexus?.resourcePolicy || {};
    const defaults = DEFAULT_NEXUS_RESOURCE_POLICY;
    return {
        enabled: configured.enabled !== false,
        // Legacy names are intentionally accepted as SOFT target overrides.
        defaultInputTargetTokens: positiveInt(configured.defaultInputTargetTokens)
            || positiveInt(configured.defaultInputBudgetTokens)
            || defaults.defaultInputTargetTokens,
        defaultOutputTargetTokens: positiveInt(configured.defaultOutputTargetTokens)
            || positiveInt(configured.defaultOutputCeilingTokens)
            || defaults.defaultOutputTargetTokens,
        roleInputTargets: mergeTargetMap(defaults.roleInputTargets, configured.roleInputTargets, configured.roleInputBudgets),
        stageInputTargets: mergeTargetMap(defaults.stageInputTargets, configured.stageInputTargets, configured.stageInputBudgets),
        domainInputTargets: mergeTargetMap(defaults.domainInputTargets, configured.domainInputTargets, configured.domainInputBudgets),
        roleOutputTargets: mergeTargetMap(defaults.roleOutputTargets, configured.roleOutputTargets, configured.roleOutputCeilings),
        stageOutputTargets: mergeTargetMap(defaults.stageOutputTargets, configured.stageOutputTargets, configured.stageOutputCeilings),
        domainOutputTargets: mergeTargetMap(defaults.domainOutputTargets, configured.domainOutputTargets, configured.domainOutputCeilings),
        phaseOutputTargets: mergeTargetMap(defaults.phaseOutputTargets, configured.phaseOutputTargets, configured.phaseOutputCeilings),
        synthesis: {
            ...defaults.synthesis,
            ...(configured.synthesis || {}),
            candidateTargetTokens: positiveInt(configured.synthesis?.candidateTargetTokens)
                || positiveInt(configured.synthesis?.maxCandidateTokens)
                || defaults.synthesis.candidateTargetTokens,
            promptTargetTokens: positiveInt(configured.synthesis?.promptTargetTokens)
                || positiveInt(configured.synthesis?.maxPromptTokens)
                || defaults.synthesis.promptTargetTokens,
        },
    };
}

function smallestPositive(values = []) {
    const numbers = values.map(positiveInt).filter(Boolean);
    return numbers.length ? Math.min(...numbers) : null;
}

export function resolveNexusSidecarResourcePolicy({
    role = '',
    stage = '',
    domain = '',
    phase = '',
    requestedMaxTokens = null,
    settings = {},
} = {}) {
    const policy = mergedPolicy(settings);
    const requested = positiveInt(requestedMaxTokens);
    if (!policy.enabled) {
        return {
            enabled: false,
            requestedMaxTokens: requested,
            softInputTargetTokens: null,
            softOutputTargetTokens: requested,
            softTotalTargetTokens: null,
            // Deprecated aliases retained for planners during dev.20 migration.
            // They are never transport hard stops.
            inputBudgetTokens: null,
            outputCeilingTokens: requested,
            totalBudgetTokens: null,
            role: String(role || ''),
            stage: String(stage || ''),
            domain: String(domain || ''),
            phase: String(phase || ''),
            inputSources: [],
            sources: ['caller-soft-target'],
            hardStopAuthority: false,
        };
    }

    const roleInput = positiveInt(policy.roleInputTargets?.[role]);
    const stageInput = positiveInt(policy.stageInputTargets?.[stage]);
    const domainInput = positiveInt(policy.domainInputTargets?.[domain]);
    const defaultInput = positiveInt(policy.defaultInputTargetTokens);
    const classifiedInput = smallestPositive([roleInput, stageInput, domainInput]);
    const softInputTargetTokens = classifiedInput || defaultInput;

    const roleTarget = positiveInt(policy.roleOutputTargets?.[role]);
    const stageTarget = positiveInt(policy.stageOutputTargets?.[stage]);
    const domainTarget = positiveInt(policy.domainOutputTargets?.[domain]);
    const phaseTarget = positiveInt(policy.phaseOutputTargets?.[phase]);
    const defaultTarget = positiveInt(policy.defaultOutputTargetTokens);
    const classifiedTarget = smallestPositive([roleTarget, stageTarget, domainTarget, phaseTarget]);
    const policyTarget = classifiedTarget || defaultTarget;
    const softOutputTargetTokens = smallestPositive([requested, policyTarget]);
    const softTotalTargetTokens = softInputTargetTokens && softOutputTargetTokens
        ? softInputTargetTokens + softOutputTargetTokens
        : null;

    const inputSources = [];
    if (roleInput) inputSources.push(`role-soft:${roleInput}`);
    if (stageInput) inputSources.push(`stage-soft:${stageInput}`);
    if (domainInput) inputSources.push(`domain-soft:${domainInput}`);
    if (!classifiedInput && defaultInput) inputSources.push(`default-soft:${defaultInput}`);
    const sources = [];
    if (requested) sources.push(`caller-soft:${requested}`);
    if (roleTarget) sources.push(`role-soft:${roleTarget}`);
    if (stageTarget) sources.push(`stage-soft:${stageTarget}`);
    if (domainTarget) sources.push(`domain-soft:${domainTarget}`);
    if (phaseTarget) sources.push(`phase-soft:${phaseTarget}`);
    if (!classifiedTarget && defaultTarget) sources.push(`default-soft:${defaultTarget}`);

    return {
        enabled: true,
        requestedMaxTokens: requested,
        softInputTargetTokens,
        softOutputTargetTokens,
        softTotalTargetTokens,
        // Deprecated aliases retained so existing reshape code can migrate
        // without changing semantics in one risky sweep. These are soft only.
        inputBudgetTokens: softInputTargetTokens,
        outputCeilingTokens: softOutputTargetTokens,
        totalBudgetTokens: softTotalTargetTokens,
        inputSources,
        role: String(role || ''),
        stage: String(stage || ''),
        domain: String(domain || ''),
        phase: String(phase || ''),
        sources,
        hardStopAuthority: false,
    };
}

export function getNexusSynthesisResourcePolicy(settings = {}) {
    const policy = mergedPolicy(settings);
    const candidateTargetTokens = positiveInt(policy.synthesis?.candidateTargetTokens)
        || DEFAULT_NEXUS_RESOURCE_POLICY.synthesis.candidateTargetTokens;
    const promptTargetTokens = positiveInt(policy.synthesis?.promptTargetTokens)
        || DEFAULT_NEXUS_RESOURCE_POLICY.synthesis.promptTargetTokens;
    return {
        enabled: policy.enabled,
        candidateTargetTokens,
        promptTargetTokens,
        // Deprecated aliases: planning hints only, never rejection thresholds.
        maxCandidateTokens: candidateTargetTokens,
        maxPromptTokens: promptTargetTokens,
        hardStopAuthority: false,
    };
}
