import { NEXUS_JOB_KIND, NEXUS_JOB_ROUTE } from '../nexus/contracts.js';
import { markModelWorkerExecutor } from '../nexus/sidecar-job-adapter.js';
import { enqueueNexusModelWorkerJob, dispatchNexusModelWorkerUnits } from '../nexus/model-worker-bus.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import { createBuilder2PhysicalExecutionKey } from './execution-boundary.js';
import { packBuilder2SemanticValues } from './semantic-packing.js';
import { estimateContentTokens } from '../observability/token-estimator.js';
import { builder2Fingerprint, createBuilder2Classification } from './contracts.js';
import { createAdaptiveProfileKey, recommendAdaptiveBatchSize } from '../nexus/adaptive-throughput.js';
import { recordBuilder2AuthoritativeSemanticWork } from './decision-benchmark.js';

function clean(value) { return String(value ?? '').trim(); }
function resultText(value) {
    if (typeof value === 'string') return value;
    if (typeof value?.text === 'string') return value.text;
    if (typeof value?.content === 'string') return value.content;
    if (typeof value?.response === 'string') return value.response;
    if (typeof value?.response?.text === 'string') return value.response.text;
    return JSON.stringify(value ?? '');
}
function abortError(reason = 'Builder 2 semantic work cancelled.') {
    if (reason instanceof Error) return reason;
    if (typeof DOMException === 'function') return new DOMException(String(reason), 'AbortError');
    const error = new Error(String(reason)); error.name = 'AbortError'; return error;
}
function throwIfAborted(signal) { if (signal?.aborted) throw abortError(signal.reason); }
function json(value) { return JSON.stringify(value, null, 2); }
function slug(value) { return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'node'; }


function semanticResourceForPlan(plan = {}) {
    const stored = clean(plan?.metadata?.semanticResource || 'model-worker').toLowerCase();
    const requested = clean(plan?.metadata?.requestMetadata?.semanticResource || 'auto').toLowerCase();
    // Demo.4/HOTFIX37 auto-runs were persisted as "sidecar" because the old
    // resolver collapsed auto to one physical resource. On resume, only migrate
    // those old auto runs into the abstract pool; an explicit operator Sidecar
    // request remains Sidecar-constrained.
    if (stored === 'sidecar' && (!requested || requested === 'auto')) return 'model-worker';
    return ['main','sidecar','model-worker'].includes(stored) ? stored : 'model-worker';
}
function semanticBatchUsage(batchResult={}, specs=[]){
    const completed=batchResult.completed||[];let input=0,output=0,cost=0;
    for(const row of completed){const response=row?.response||{},usage=response.usageNormalized||response.usage||response.usageEstimated||{};input+=Number(usage.inputTokens)||0;output+=Number(usage.outputTokens)||0;cost+=Number(usage.cost)||0;}
    if(!input)input=(specs||[]).reduce((sum,spec)=>sum+estimateContentTokens(`${spec.systemPrompt||''}
${spec.prompt||''}`),0);
    return{calls:(specs||[]).length,inputTokens:input,outputTokens:output,cost,recovered:Number(batchResult.recoveredCount)||0};
}

function builderModelWorkerConstraints(plan = {}) {
    const resource = semanticResourceForPlan(plan);
    return {
        semanticResource: resource,
        mainEligible: resource !== 'sidecar',
        forceMain: resource === 'main',
    };
}

function objectValidator(shape) {
    return value => {
        try {
            const out = shape(value);
            return { valid: true, score: 100, value: out };
        } catch (error) {
            return { valid: false, score: 0, reason: error?.message || String(error) };
        }
    };
}
function requireObject(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`); return value; }
function requireArray(value, label) { if (!Array.isArray(value)) throw new Error(`${label} must be an array.`); return value; }

// HOTFIX21: Sidecar-facing classification validation must be at least as strict
// as the canonical Builder classification contract. A logical slice cannot
// become resident-complete if a row would later be rejected by contracts.js.
// This is deliberately performed before semantic workspace checkpointing so a
// malformed row invalidates/retries only its logical slice instead of poisoning
// every future resume of the Builder run.
function validateClassificationSemanticResult(value, { entries = [], taxonomy = [], taxonomyRevision = null, classificationRevision = null } = {}) {
    const o = requireObject(value, 'classification result');
    const rows = requireArray(o.classifications, 'classifications');
    const entryByRef = new Map(entries.map(row => [clean(row?.ref), row]));
    const taxa = new Map(taxonomy.map(row => [clean(row?.taxonId), row]));
    const seen = new Set();
    const normalizedRows = [];
    for (const row of rows) {
        const ref = clean(row?.ref);
        if (!entryByRef.has(ref) || seen.has(ref)) throw new Error('Classification must contain every supplied REF exactly once and no others.');
        seen.add(ref);
        if (row?.path || row?.newNodeLabel || row?.parentNodeId) throw new Error('Classifier attempted to invent structure.');
        const entry = entryByRef.get(ref) || {};
        const decision = clean(row?.decision);
        // HOTFIX22: a non-classified decision already withholds placement authority.
        // Some providers redundantly echo a best/nearest taxonId alongside an
        // ambiguous or taxonomy_gap decision. That field is schema noise, not a
        // reason to replay expensive semantic work. Strip only the forbidden
        // authority field locally; keep the decision, candidates, reason and
        // confidence intact, then run the canonical contract over the repaired row.
        const semanticTaxonId = decision === 'classified' ? row?.taxonId : null;
        const canonical = createBuilder2Classification({
            sourceKey: clean(entry.sourceKey) || ref,
            sourceFingerprint: clean(entry.sourceFingerprint || entry.fingerprint),
            taxonomyRevision: clean(taxonomyRevision) || 'semantic-validation-taxonomy',
            classificationRevision: clean(classificationRevision) || clean(taxonomyRevision) || 'semantic-validation-classification',
            decision,
            taxonId: semanticTaxonId,
            candidates: row?.candidates,
            reason: row?.reason,
            confidence: row?.confidence,
        });
        if (canonical.decision === 'classified') {
            const taxon = taxa.get(clean(canonical.taxonId));
            if (!taxon) throw new Error(`Unknown classified taxon ${canonical.taxonId}.`);
            if (taxon.entryPolicy === 'container-only') throw new Error(`Classifier may not attach ${ref} to container-only taxon ${canonical.taxonId}.`);
        }
        const candidates = canonical.candidates || [];
        if (candidates.some(candidate => !taxa.has(clean(candidate?.taxonId)))) throw new Error('Classification candidate is outside the supplied taxonomy window.');
        const normalized = { ...row, ref, decision: canonical.decision };
        if (canonical.decision === 'classified') normalized.taxonId = canonical.taxonId;
        else delete normalized.taxonId;
        normalizedRows.push(normalized);
    }
    if (seen.size !== entryByRef.size) throw new Error('Classification slice omitted one or more supplied REFs.');
    return { ...o, classifications: normalizedRows };
}

// HOTFIX14: Builder's semantic slice size remains the correctness boundary,
// but it no longer has to be the physical provider-call boundary. Several
// independent logical slices can share one JSON-mode request, each retaining
// its own validator and deterministic output slot. This cuts the 47-request
// survey/classification pattern without increasing what one logical slice is
// allowed to decide.
function semanticSpecTokens(spec) {
    const text = `${clean(spec?.systemPrompt)}

${clean(spec?.prompt)}`;
    const measured = estimateContentTokens(text);
    return measured > 0 ? measured : Math.max(1, Math.ceil(text.length / 4));
}
function packSemanticPhysicalBundles(specs = [], { targetInputTokens = 7000, maxMembers = 2 } = {}) {
    const target = Math.max(4000, Math.min(12000, Number(targetInputTokens) || 7000));
    const memberLimit = Math.max(1, Math.min(4, Math.floor(Number(maxMembers) || 2)));
    const bundles = [];
    let current = null;
    for (const spec of specs) {
        const fullTokens = semanticSpecTokens(spec);
        const sharesBundlePrefix = current && current.members.length > 0 && spec.bundleKey && current.bundleKey === spec.bundleKey;
        const incrementalTokens = sharesBundlePrefix && Number.isFinite(Number(spec.bundleIncrementTokens))
            ? Math.max(1, Number(spec.bundleIncrementTokens))
            : fullTokens;
        const incompatibleBundleKey = current && current.members.length > 0 && ((current.bundleKey || null) !== (spec.bundleKey || null));
        const wouldOverflow = current && current.members.length > 0 && current.estimatedInputTokens + incrementalTokens > target;
        const wouldOverfill = current && current.members.length >= memberLimit;
        if (!current || incompatibleBundleKey || wouldOverflow || wouldOverfill) {
            current = { index: bundles.length, members: [], estimatedInputTokens: 0, bundleKey: spec.bundleKey || null };
            bundles.push(current);
        }
        const cost = current.members.length > 0 && spec.bundleKey && current.bundleKey === spec.bundleKey && Number.isFinite(Number(spec.bundleIncrementTokens))
            ? Math.max(1, Number(spec.bundleIncrementTokens))
            : fullTokens;
        current.members.push(spec);
        current.estimatedInputTokens += cost;
    }
    return { bundles, targetInputTokens: target, maxMembers: memberLimit };
}

// HOTFIX18: logical semantic slices are the Builder correctness boundary;
// physical multiplexing must never turn them into provider-sized megarequests.
// The live 490-entry corpus showed four-way ~8-15k token envelopes producing
// two 180s timeouts, tripping the parent circuit, and forcing ten recovery
// bundles. Keep physical geometry bounded around the existing 7k work-wave
// contract. Larger projects create more bounded bundles rather than fatter ones.
function builderPhysicalPackingPolicy(stage, semanticPacking = {}, remainingItems = null) {
    const logicalTarget = Number.isFinite(Number(semanticPacking?.targetInputTokens)) && Number(semanticPacking.targetInputTokens) >= 1000
        ? Math.max(1000, Math.min(100000, Math.floor(Number(semanticPacking.targetInputTokens))))
        : 3500;
    const targetInputTokens = Math.max(5000, Math.min(8000, logicalTarget * 2));
    // HOTFIX15/18 established two independent semantic contracts as the proven
    // safe physical ceiling. HOTFIX46 learns inside that envelope first: a slow
    // or unreliable profile may shrink to one slice, then recover conservatively
    // toward two. Wider adaptive envelopes remain available to workloads whose
    // own contracts explicitly permit them.
    const maxMembers = 2;
    const adaptiveProfileKey = createAdaptiveProfileKey({
        workloadType: `builder2:${stage}`, provider:'AUTO', profile:'AUTO', model:'AUTO', worker:'AUTO', contractVersion:'hf46-v1',
    });
    const adaptiveMaxMembers = recommendAdaptiveBatchSize({
        profileKey:adaptiveProfileKey, currentSize:maxMembers, minSize:1, maxSize:maxMembers, remainingItems,
    });
    return { stage, logicalTargetInputTokens: logicalTarget, targetInputTokens, maxMembers:adaptiveMaxMembers, adaptiveProfileKey };
}
function multiplexEnvelopeValidator(members = []) {
    return value => {
        const o = requireObject(value, 'multiplex semantic result');
        const groups = requireArray(o.groups, 'multiplex groups');
        const expectedIds = members.map((_, index) => `G${index + 1}`);
        const expected = new Set(expectedIds);
        const rowsById = new Map();
        const ignoredGroupIds = [];
        for (const row of groups) {
            const id = clean(row?.groupId);
            // HOTFIX16: the physical multiplex envelope is only a transport
            // container. Unknown/extra rows have no logical authority, so they
            // must never poison valid required siblings. Required-group
            // completeness and uniqueness are resolved below and recovered at
            // the logical-slice layer rather than failing the whole provider call.
            if (!expected.has(id)) { ignoredGroupIds.push(id || '<missing-groupId>'); continue; }
            if (!rowsById.has(id)) rowsById.set(id, []);
            rowsById.get(id).push(row);
        }
        const normalized = [];
        const missingGroupIds = [];
        const duplicateGroupIds = [];
        for (const groupId of expectedIds) {
            const rows = rowsById.get(groupId) || [];
            if (!rows.length) { missingGroupIds.push(groupId); continue; }
            if (rows.length > 1) { duplicateGroupIds.push(groupId); continue; }
            normalized.push({ groupId, result: rows[0].result });
        }
        return { groups: normalized, ignoredGroupIds, missingGroupIds, duplicateGroupIds };
    };
}
function physicalSpecForBundle(bundle, stage, executionKey) {
    const members = bundle.members || [];
    if (members.length === 1) {
        const member = members[0];
        return { ...member, physicalIndex: bundle.index, logicalMembers: members, logicalIndexes: [member.index], multiplexed: false, sliceExecutionKey: member.sliceExecutionKey };
    }
    const validator = multiplexEnvelopeValidator(members);
    const sharedClassification = stage === 'classification'
        && members.every(member => member.bundleKind === 'classification' && member.bundleKey === members[0].bundleKey && member.sharedPrompt && member.groupPrompt);
    const systemPrompt = sharedClassification
        ? members[0].systemPrompt
        : 'You are Nexus Builder 2 multiplex semantic worker. Complete every independent GROUP exactly once. Never blend evidence, IDs, or decisions between groups. Return exact JSON only.';
    const prompt = sharedClassification ? [
        `Classify ${members.length} independent entry groups against the ONE shared taxonomy below. Each GROUP has a local REF namespace; never mix REFs between groups.`,
        'Return exactly: {"groups":[{"groupId":"G1","result":{"classifications":[...]}}, ...]}. Include every groupId exactly once.',
        members[0].sharedPrompt,
        ...members.flatMap((member, index) => [`===== GROUP G${index + 1} =====`, member.groupPrompt]),
    ].join('\n\n') : [
        `Complete ${members.length} independent ${stage} semantic groups. Each GROUP keeps its own contract and local REF namespace.`,
        'Return exactly: {"groups":[{"groupId":"G1","result":{...}}, ...]}. Include every groupId exactly once. The result object for each group must satisfy that group contract.',
        ...members.flatMap((member, index) => [
            `===== GROUP G${index + 1} =====`,
            `GROUP SYSTEM INSTRUCTION: ${member.systemPrompt}`,
            member.prompt,
        ]),
    ].join('\n\n');
    return {
        index: bundle.index,
        physicalIndex: bundle.index,
        logicalMembers: members,
        logicalIndexes: members.map(member => member.index),
        multiplexed: true,
        systemPrompt,
        prompt,
        temperature: Math.min(...members.map(member => Number(member.temperature ?? 0.15))),
        validator,
        sliceExecutionKey: `${executionKey}:physical:${bundle.index + 1}`,
    };
}
function inspectPhysicalSemanticValues(physicalSpecs = [], values = [], logicalCount = 0) {
    const logical = Array.from({ length: logicalCount }, () => undefined);
    const failures = [];
    for (let index = 0; index < physicalSpecs.length; index += 1) {
        const spec = physicalSpecs[index], value = values[index];
        if (!spec?.multiplexed) {
            const member = spec.logicalMembers[0];
            logical[member.index] = value;
            continue;
        }
        const groups = Array.isArray(value?.groups) ? value.groups : [];
        const missingGroupIds = new Set(Array.isArray(value?.missingGroupIds) ? value.missingGroupIds.map(clean) : []);
        const duplicateGroupIds = new Set(Array.isArray(value?.duplicateGroupIds) ? value.duplicateGroupIds.map(clean) : []);
        for (let groupIndex = 0; groupIndex < spec.logicalMembers.length; groupIndex += 1) {
            const member = spec.logicalMembers[groupIndex], expected = `G${groupIndex + 1}`;
            if (duplicateGroupIds.has(expected)) { failures.push({ member, error:new Error(`Multiplex result ${index + 1} duplicated required ${expected}.`) }); continue; }
            const group = groups.find(row => clean(row?.groupId) === expected);
            if (missingGroupIds.has(expected) || !group) { failures.push({ member, error:new Error(`Multiplex result ${index + 1} omitted ${expected}.`) }); continue; }
            try { logical[member.index] = member.validator(group.result); }
            catch (error) { failures.push({ member, error }); }
        }
    }
    return { logical, failures };
}

// HOTFIX12: recovery must tell a semantic worker what it actually violated.
// Repeating the original prompt with a generic "try again" caused models to
// reproduce the same structurally-valid-but-contract-invalid answer. Keep the
// validator as authority, but feed its bounded reason back into the one allowed
// recovery attempt so the retry can make a targeted correction.
function semanticRecoveryCorrection(outcome = null) {
    const raw = clean(outcome?.error?.message || outcome?.error?.reason || outcome?.response?.semanticValidation?.reason);
    const reason = raw ? raw.replace(/\s+/g, ' ').slice(0, 600) : 'The prior answer did not satisfy the exact semantic contract.';
    const lines = [
        `VALIDATION FAILURE: ${reason}`,
        'Correct the stated failure in this retry. Return exact JSON only and preserve materially distinct information while satisfying every hard contract constraint.',
    ];
    const maxMatch = reason.match(/more than\s+(\d+)\s+candidates/i);
    if (maxMatch) {
        const max = Math.max(1, Number(maxMatch[1]) || 1);
        lines.push(`HARD COUNT LIMIT: return between 1 and ${max} candidates. If more concepts appear distinct, merge the closest abstractions and preserve displaced concepts in purpose/aliases. Returning ${max + 1}+ candidates will be rejected.`);
    }
    if (/requires? label/i.test(reason)) lines.push('Every returned candidate must have a non-empty label.');
    if (/must be (?:a|an) (?:json )?object/i.test(reason)) lines.push('Return one JSON object with exactly the requested top-level shape.');
    if (/must be an array/i.test(reason)) lines.push('Return the requested field as a JSON array, even when it contains only one item.');
    return lines.join(' ');
}

export class NexusBuilder2SemanticAdapter {
    constructor({ runtime, store, runId, logEvent = null, timeoutMs = 180000, enqueue = null, runBatch = null, semanticPacking = null } = {}) {
        if (!runtime?.director || !runtime?.coordinator) throw new Error('Builder 2 semantic adapter requires Nexus Work Director and WorkCoordinator.');
        if (!store?.read) throw new Error('Builder 2 semantic adapter requires PlanStore.');
        this.runtime = runtime;
        this.store = store;
        this.runId = clean(runId);
        this.logEvent = typeof logEvent === 'function' ? logEvent : () => {};
        this.timeoutMs = Math.max(30000, Math.min(300000, Number(timeoutMs) || 180000));
        this.sequence = 0;
        this.enqueue = typeof enqueue === 'function' ? enqueue : null;
        this.runBatch = typeof runBatch === 'function' ? runBatch : null;
        this.semanticPacking = {
            maxEntries: Number.isFinite(Number(semanticPacking?.maxEntries)) && Number(semanticPacking.maxEntries) >= 1
                ? Math.max(1, Math.min(50, Math.floor(Number(semanticPacking.maxEntries))))
                : 24,
            targetInputTokens: Number.isFinite(Number(semanticPacking?.targetInputTokens)) && Number(semanticPacking.targetInputTokens) >= 1000
                ? Math.max(1000, Math.min(100000, Math.floor(Number(semanticPacking.targetInputTokens))))
                : null,
            multiplexTaxonomy: semanticPacking?.multiplexTaxonomy !== false,
        };
    }

    async #readTaxonomyCheckpoint(inputFingerprint) {
        const plan = await this.store.read(this.runId);
        const checkpoint = plan?.taxonomyPlanning;
        if (!checkpoint || clean(checkpoint.inputFingerprint) !== clean(inputFingerprint)) return null;
        return structuredClone(checkpoint);
    }

    async #writeTaxonomyCheckpoint(inputFingerprint, patch = {}) {
        let plan = await this.store.read(this.runId);
        if (!plan) throw new Error(`Builder 2 taxonomy checkpoint cannot find plan ${this.runId}.`);
        const prior = clean(plan.taxonomyPlanning?.inputFingerprint) === clean(inputFingerprint) ? plan.taxonomyPlanning : {};
        plan = await this.store.transition(this.runId, plan.phase, {
            taxonomyPlanning: {
                ...structuredClone(prior || {}),
                ...structuredClone(patch || {}),
                inputFingerprint,
                updatedAt: Date.now(),
            },
        });
        this.logEvent('builder2', 'taxonomy-workspace-checkpoint', {
            runId: this.runId,
            phase: plan.phase,
            checkpointStage: patch.stage || prior?.stage || null,
            consolidationRound: patch.consolidationRound ?? prior?.consolidationRound ?? 0,
            candidateCount: Array.isArray(patch.taxonomyInput) ? patch.taxonomyInput.length : Array.isArray(prior?.taxonomyInput) ? prior.taxonomyInput.length : null,
            hasArchitectResult: !!(patch.architectResult || prior?.architectResult),
        }, 'debug');
        return plan.taxonomyPlanning;
    }

    #semanticSliceFingerprint(stage, spec) {
        return `semantic-slice:${builder2Fingerprint({ stage, slice:spec?.slice, bundleKey:spec?.bundleKey || null })}`;
    }

    async #readSemanticBatchWorkspace(stage, workspaceFingerprint) {
        const plan = await this.store.read(this.runId);
        const workspace = plan?.metadata?.semanticBatchWorkspace?.[stage];
        if (!workspace || clean(workspace.workspaceFingerprint) !== clean(workspaceFingerprint)) return null;
        return structuredClone(workspace);
    }

    async #writeSemanticBatchWorkspace(stage, workspaceFingerprint, specs, logicalValues) {
        let plan = await this.store.read(this.runId);
        if (!plan) throw new Error(`Builder 2 semantic checkpoint cannot find plan ${this.runId}.`);
        const existing = plan.metadata?.semanticBatchWorkspace?.[stage];
        const prior = clean(existing?.workspaceFingerprint) === clean(workspaceFingerprint) ? existing : {};
        const results = { ...(prior?.results || {}) };
        let completedCount = 0;
        for (const spec of specs || []) {
            const value = logicalValues?.[spec.index];
            if (value === undefined) continue;
            results[this.#semanticSliceFingerprint(stage, spec)] = structuredClone(value);
        }
        completedCount = Object.keys(results).length;
        const semanticBatchWorkspace = {
            ...(plan.metadata?.semanticBatchWorkspace || {}),
            [stage]: {
                workspaceFingerprint,
                results,
                logicalSliceCount: specs.length,
                completedCount,
                updatedAt: Date.now(),
            },
        };
        await this.store.transition(this.runId, plan.phase, { metadata:{ ...(plan.metadata || {}), semanticBatchWorkspace } });
        this.logEvent('builder2','semantic-workspace-checkpoint',{runId:this.runId,stage,completedCount,logicalSliceCount:specs.length},'debug');
    }

    async #execute({ stage, systemPrompt, prompt, validator, signal = null, temperature = 0.15 } = {}) {
        throwIfAborted(signal);
        const plan = await this.store.read(this.runId);
        if (!plan) throw new Error(`Builder 2 semantic adapter cannot find plan ${this.runId}.`);
        const seq = ++this.sequence;
        const type = `builder2-${stage}-${seq}`;
        const worker = builderModelWorkerConstraints(plan);
        const directorPlan = this.runtime.director.buildRequestedPlan({
            source: 'lorebook-builder2',
            classification: { subsystem: 'lorebook-builder2', stage, book: plan.book, runId: plan.runId },
            decisions: [{ action: 'run', job: type, route: NEXUS_JOB_ROUTE.MODEL_WORKER, reason: `Builder 2 ${stage} semantic stage` }],
            jobs: [{
                type,
                name: `Builder 2 · ${stage}`,
                kind: NEXUS_JOB_KIND.ROUTE,
                route: NEXUS_JOB_ROUTE.MODEL_WORKER,
                priority: 18,
                transactionRequired: false,
                metadata: { builder2: true, builderRunId: plan.runId, builderPlanRevision: plan.planRevision, stage, semanticResource: worker.semanticResource },
            }],
            metadata: {
                builder2: true,
                builderRunId: plan.runId,
                sourceRevision: plan.sourceRevision,
                corpusRevision: plan.corpusRevision,
                treeRevision: plan.treeRevision,
                semanticResource: worker.semanticResource,
            },
        });
        const executionKey = createBuilder2PhysicalExecutionKey({ plan, jobId: type, route: 'model-worker', profileIdentity: `builder2:${stage}` });
        const executor = markModelWorkerExecutor(async (_job, _plan, context = {}) => {
            const enqueueWorker = this.enqueue || enqueueNexusModelWorkerJob;
            const handle = enqueueWorker('tree', 'tree-build', {
                systemPrompt,
                prompt,
                responseFormat: 'json_object',
                temperature,
                timeoutMs: this.timeoutMs,
                label: `Builder 2 · ${stage}`,
                role: 'treeBuild',
                executionMode: 'adaptive',
                mainEligible: worker.mainEligible,
                forceMain: worker.forceMain,
                dedupKey: executionKey,
                structuredValidator: objectValidator(validator),
                allowSameProviderModelTimeoutRetry: true,
                telemetry: {
                    builder2: true,
                    builderRunId: plan.runId,
                    builderPlanRevision: plan.planRevision,
                    builderSourceRevision: plan.sourceRevision,
                    builderCorpusRevision: plan.corpusRevision,
                    builderTreeRevision: plan.treeRevision,
                    builderStage: stage,
                    builderExecutionKey: executionKey,
                    builderSemanticResource: worker.semanticResource,
                },
            });
            const cancel = () => { try { handle.cancel?.(context.signal?.reason || signal?.reason || 'Builder 2 semantic work cancelled.'); } catch {} };
            (context.signal || signal)?.addEventListener?.('abort', cancel, { once: true });
            try {
                const response = await handle.promise;
                if ((context.signal || signal)?.aborted) throw abortError((context.signal || signal).reason);
                return { modelWorker: true, handleId: handle.id || null, jobId: handle.jobId || null, response };
            } finally {
                (context.signal || signal)?.removeEventListener?.('abort', cancel);
            }
        });
        this.logEvent('builder2', 'semantic-dispatch', { runId: plan.runId, book: plan.book, stage, directorPlanId: directorPlan.id, executionKey, semanticResource: worker.semanticResource }, 'debug');
        const snapshot = await this.runtime.coordinator.run(directorPlan, {
            executors: { [type]: executor },
            signal,
            isFresh: () => !signal?.aborted,
        });
        throwIfAborted(signal);
        const job = snapshot.jobs?.[0];
        if (!job) throw new Error(`Builder 2 ${stage} WorkCoordinator returned no job result.`);
        if (job.state === 'cancelled') throw abortError(job.error || `Builder 2 ${stage} cancelled.`);
        if (job.state !== 'succeeded') {
            const error = new Error(`Builder 2 ${stage} ${job.state}: ${job.error || 'semantic job did not succeed'}`);
            error.name = job.state === 'blocked' || job.state === 'skipped' ? 'TV2Builder2SemanticBlocked' : 'TV2Builder2SemanticFailure';
            throw error;
        }
        const physical = job.result?.value;
        const response = physical?.response ?? physical;
        const parsed = parseStructuredJsonCandidate(resultText(response), { validator: objectValidator(validator), label: `Builder 2 ${stage}` });
        this.logEvent('builder2', 'semantic-complete', { runId: plan.runId, book: plan.book, stage, directorPlanId: directorPlan.id, semanticResource: worker.semanticResource }, 'debug');
        return parsed;
    }

    async #executeBatch({ stage, slices = [], buildSpec, signal = null } = {}) {
        throwIfAborted(signal);
        if (!Array.isArray(slices) || !slices.length) return [];
        if (typeof buildSpec !== 'function') throw new Error(`Builder 2 ${stage} batch requires buildSpec().`);
        const plan = await this.store.read(this.runId);
        if (!plan) throw new Error(`Builder 2 semantic adapter cannot find plan ${this.runId}.`);
        const seq = ++this.sequence;
        const type = `builder2-${stage}-batch-${seq}`;
        const worker = builderModelWorkerConstraints(plan);
        const directorPlan = this.runtime.director.buildRequestedPlan({
            source: 'lorebook-builder2',
            classification: { subsystem: 'lorebook-builder2', stage, book: plan.book, runId: plan.runId, batched: true },
            decisions: [{ action: 'run', job: type, route: NEXUS_JOB_ROUTE.MODEL_WORKER, reason: `Builder 2 ${stage} batched semantic stage` }],
            jobs: [{
                type,
                name: `Builder 2 · ${stage} batch`,
                kind: NEXUS_JOB_KIND.ROUTE,
                route: NEXUS_JOB_ROUTE.MODEL_WORKER,
                priority: 18,
                transactionRequired: false,
                metadata: { builder2: true, builderRunId: plan.runId, builderPlanRevision: plan.planRevision, stage, batched: true, sliceCount: slices.length, semanticResource: worker.semanticResource },
            }],
            metadata: {
                builder2: true,
                builderRunId: plan.runId,
                sourceRevision: plan.sourceRevision,
                corpusRevision: plan.corpusRevision,
                treeRevision: plan.treeRevision,
                batched: true,
                sliceCount: slices.length,
                semanticResource: worker.semanticResource,
            },
        });
        const executionKey = createBuilder2PhysicalExecutionKey({ plan, jobId: type, route: 'model-worker', profileIdentity: `builder2:${stage}:batch` });
        const specs = slices.map((slice, index) => {
            const spec = buildSpec(slice, index);
            if (!spec || typeof spec !== 'object' || typeof spec.validator !== 'function') throw new Error(`Builder 2 ${stage} slice ${index + 1} did not produce a valid semantic request spec.`);
            return { ...spec, slice, index, sliceExecutionKey: `${executionKey}:slice:${index + 1}` };
        });
        // Survey/classification are durable logical workspaces. Physical requests
        // are disposable transport. If an earlier attempt already resolved a
        // logical slice with the same exact inputs, reuse that validated result and
        // dispatch only the unresolved slice fingerprints.
        const durableLogicalWorkspace = stage === 'survey' || stage === 'classification';
        const workspaceFingerprint = `semantic-workspace:${builder2Fingerprint({stage,slices:specs.map(spec=>this.#semanticSliceFingerprint(stage,spec))})}`;
        const cachedLogical = Array.from({length:specs.length},()=>undefined);
        let pendingSpecs = specs;
        if(durableLogicalWorkspace){
            const workspace=await this.#readSemanticBatchWorkspace(stage,workspaceFingerprint);
            if(workspace?.results){
                const pending=[];
                let repairedResidentCount=0;
                for(const spec of specs){
                    const key=this.#semanticSliceFingerprint(stage,spec),cached=workspace.results[key];
                    if(cached===undefined){pending.push(spec);continue;}
                    try{
                        const validated=spec.validator(structuredClone(cached));
                        cachedLogical[spec.index]=validated;
                        if(stage==='classification'&&JSON.stringify(validated)!==JSON.stringify(cached))repairedResidentCount+=1;
                    }
                    catch{pending.push(spec);}
                }
                pendingSpecs=pending;
                if(repairedResidentCount){
                    await this.#writeSemanticBatchWorkspace(stage,workspaceFingerprint,specs,cachedLogical);
                    this.logEvent('builder2','semantic-workspace-repaired',{runId:plan.runId,book:plan.book,stage,repairedResidentCount,pendingLogicalSliceCount:pendingSpecs.length},'info');
                }
                if(pendingSpecs.length<specs.length)this.logEvent('builder2','semantic-workspace-reused',{runId:plan.runId,book:plan.book,stage,reusedLogicalSliceCount:specs.length-pendingSpecs.length,pendingLogicalSliceCount:pendingSpecs.length},'info');
                if(!pendingSpecs.length)return cachedLogical;
            }
        }
        const physicalPolicy = builderPhysicalPackingPolicy(stage, this.semanticPacking, pendingSpecs.length);
        const multiplexStage = stage === 'survey' || stage === 'classification' || this.semanticPacking.multiplexTaxonomy;
        const packing = multiplexStage
            ? packSemanticPhysicalBundles(pendingSpecs, { targetInputTokens: physicalPolicy.targetInputTokens, maxMembers: physicalPolicy.maxMembers })
            : { bundles:pendingSpecs.map((spec,index)=>({index,members:[spec],estimatedInputTokens:semanticSpecTokens(spec)})), targetInputTokens:physicalPolicy.targetInputTokens, maxMembers:1 };
        const physicalSpecs = packing.bundles.map(bundle => physicalSpecForBundle(bundle, stage, executionKey));
        if (physicalSpecs.length < specs.length) this.logEvent('builder2', 'semantic-batch-coalesced', {
            runId: plan.runId, book: plan.book, stage,
            semanticSliceCount: specs.length,
            physicalRequestCount: physicalSpecs.length,
            bundleSizes: physicalSpecs.map(spec => spec.logicalMembers.length),
            bundleEstimatedInputTokens: packing.bundles.map(bundle => Math.round(bundle.estimatedInputTokens || 0)),
            physicalInputTargetTokens: packing.targetInputTokens,
            physicalMaxMembers: packing.maxMembers,
            oversizeSingletonCount: packing.bundles.filter(bundle => bundle.members.length === 1 && bundle.estimatedInputTokens > packing.targetInputTokens).length,
        }, 'info');
        const resolveRunBatch = async () => this.runBatch || (await import('../nexus/batch-layer.js')).runNexusModelWorkerBatch;
        const modelWorkerDispatch = input => dispatchNexusModelWorkerUnits({ ...input, enqueue: this.enqueue });
        const executor = markModelWorkerExecutor(async (_job, _plan, context = {}) => {
            const runBatch = await resolveRunBatch();
            const batchResult = await runBatch({
                domain: 'tree',
                stage: 'tree-build',
                items: physicalSpecs,
                buildRequest: spec => ({
                    systemPrompt: spec.systemPrompt,
                    prompt: spec.prompt,
                    responseFormat: 'json_object',
                    temperature: spec.temperature ?? 0.15,
                    timeoutMs: this.timeoutMs,
                    label: spec.multiplexed ? `Builder 2 · ${stage} · bundle ${spec.physicalIndex + 1}/${physicalSpecs.length} · ${spec.logicalMembers.length} slices` : `Builder 2 · ${stage} · slice ${spec.logicalIndexes[0] + 1}/${specs.length}`,
                    role: 'treeBuild',
                    executionMode: 'adaptive',
                    mainEligible: worker.mainEligible,
                    forceMain: worker.forceMain,
                    structuredValidator: objectValidator(spec.validator),
                    telemetry: {
                        builder2: true,
                        builderRunId: plan.runId,
                        builderPlanRevision: plan.planRevision,
                        builderSourceRevision: plan.sourceRevision,
                        builderCorpusRevision: plan.corpusRevision,
                        builderTreeRevision: plan.treeRevision,
                        builderStage: stage,
                        builderBatch: true,
                        builderBatchSliceIndex: spec.logicalIndexes[0],
                        builderBatchSliceCount: specs.length,
                        builderPhysicalBundleIndex: spec.physicalIndex,
                        builderPhysicalBundleCount: physicalSpecs.length,
                        builderLogicalSliceIndexes: spec.logicalIndexes,
                        builderLogicalSliceCount: spec.logicalMembers.length,
                        adaptiveWorkloadType: `builder2:${stage}`,
                        adaptiveBatchItems: spec.logicalMembers.length,
                        adaptiveContractVersion: 'hf46-v1',
                        builderExecutionKey: spec.sliceExecutionKey,
                    },
                }),
                parse: (text, spec) => parseStructuredJsonCandidate(text, { validator: objectValidator(spec.validator), label: spec.multiplexed ? `Builder 2 ${stage} bundle ${spec.physicalIndex + 1}` : `Builder 2 ${stage} slice ${spec.logicalIndexes[0] + 1}` }),
                validate: () => true,
                buildRecovery: (spec, outcome) => {
                    const correction = semanticRecoveryCorrection(outcome);
                    return {
                    systemPrompt: `${spec.systemPrompt} RECOVERY: The prior answer violated the semantic contract. Apply the validator feedback exactly and return only valid JSON.`,
                    prompt: `${spec.prompt}\n\n${correction}`,
                    responseFormat: 'json_object',
                    temperature: Math.min(Number(spec.temperature ?? 0.15), 0.08),
                    timeoutMs: this.timeoutMs,
                    label: spec.multiplexed ? `Builder 2 · ${stage} recovery · bundle ${spec.physicalIndex + 1}/${physicalSpecs.length}` : `Builder 2 · ${stage} recovery · slice ${spec.logicalIndexes[0] + 1}/${specs.length}`,
                    role: 'treeBuild',
                    executionMode: 'adaptive',
                    structuredValidator: objectValidator(spec.validator),
                    telemetry: {
                        builder2: true,
                        builderRunId: plan.runId,
                        builderPlanRevision: plan.planRevision,
                        builderStage: stage,
                        builderBatch: true,
                        builderBatchRecovery: true,
                        builderBatchSliceIndex: spec.logicalIndexes[0],
                        builderBatchSliceCount: specs.length,
                        builderPhysicalBundleIndex: spec.physicalIndex,
                        builderPhysicalBundleCount: physicalSpecs.length,
                        builderLogicalSliceIndexes: spec.logicalIndexes,
                        builderLogicalSliceCount: spec.logicalMembers.length,
                        adaptiveWorkloadType: `builder2:${stage}`,
                        adaptiveBatchItems: spec.logicalMembers.length,
                        adaptiveContractVersion: 'hf46-v1',
                        builderExecutionKey: spec.sliceExecutionKey,
                    },
                };
                },
                label: `Builder 2 · ${stage} batch`,
                priority: 18,
                role: 'treeBuild',
                executionMode: 'adaptive',
                requestedBatch: physicalSpecs.length > 1,
                allowPartial: true,
                dedupKey: executionKey,
                telemetry: {
                    builder2: true,
                    builderRunId: plan.runId,
                    builderPlanRevision: plan.planRevision,
                    builderSourceRevision: plan.sourceRevision,
                    builderCorpusRevision: plan.corpusRevision,
                    builderTreeRevision: plan.treeRevision,
                    builderStage: stage,
                    builderBatch: true,
                    builderBatchSliceCount: specs.length,
                    builderPhysicalRequestCount: physicalSpecs.length,
                    builderBundleSizes: physicalSpecs.map(spec => spec.logicalMembers.length),
                    builderExecutionKey: executionKey,
                    builderSemanticResource: worker.semanticResource,
                },
                executionClass: 'model-worker',
                dispatchUnits: modelWorkerDispatch,
                signal: context.signal || signal,
            });
            recordBuilder2AuthoritativeSemanticWork(plan.runId,{stage,...semanticBatchUsage(batchResult,physicalSpecs)});
            const physicalValues = Array.from({length:physicalSpecs.length},()=>undefined);
            const completedRows=batchResult.completed||[];
            for(let completedIndex=0;completedIndex<completedRows.length;completedIndex+=1){
                const row=completedRows[completedIndex],item=row?.unit?.item;
                const index=Number.isInteger(item?.physicalIndex)?item.physicalIndex:Number.isInteger(row?.unit?.index)?row.unit.index:(completedRows.length===physicalSpecs.length?completedIndex:null);
                if(index!=null&&index>=0&&index<physicalValues.length)physicalValues[index]=row.value;
            }
            const ignoredMultiplexGroupIds = physicalValues.flatMap((value, physicalIndex) =>
                Array.isArray(value?.ignoredGroupIds) && value.ignoredGroupIds.length
                    ? value.ignoredGroupIds.map(groupId => ({ physicalIndex, groupId }))
                    : []);
            if (ignoredMultiplexGroupIds.length) this.logEvent('builder2', 'semantic-multiplex-extra-groups-ignored', {
                runId: plan.runId, book: plan.book, stage,
                ignoredCount: ignoredMultiplexGroupIds.length,
                ignored: ignoredMultiplexGroupIds,
            }, 'warn');
            const partialMultiplexEnvelopes = physicalValues.flatMap((value, physicalIndex) => {
                const missingGroupIds = Array.isArray(value?.missingGroupIds) ? value.missingGroupIds : [];
                const duplicateGroupIds = Array.isArray(value?.duplicateGroupIds) ? value.duplicateGroupIds : [];
                return missingGroupIds.length || duplicateGroupIds.length
                    ? [{ physicalIndex, missingGroupIds, duplicateGroupIds }]
                    : [];
            });
            if (partialMultiplexEnvelopes.length) this.logEvent('builder2', 'semantic-multiplex-partial-envelope', {
                runId: plan.runId, book: plan.book, stage,
                physicalEnvelopeCount: partialMultiplexEnvelopes.length,
                envelopes: partialMultiplexEnvelopes,
            }, 'warn');
            const inspected = inspectPhysicalSemanticValues(physicalSpecs, physicalValues, specs.length);
            const checkpointLogical=cachedLogical.slice();
            for(let i=0;i<inspected.logical.length;i+=1)if(inspected.logical[i]!==undefined)checkpointLogical[i]=inspected.logical[i];
            if(durableLogicalWorkspace)await this.#writeSemanticBatchWorkspace(stage,workspaceFingerprint,specs,checkpointLogical);
            if (batchResult.failed?.length) {
                const failedLogicalCount = batchResult.failed.reduce((sum, row) => sum + Math.max(1, row?.unit?.item?.logicalMembers?.length || 1), 0);
                const error = new Error(`Builder 2 ${stage} batch failed ${failedLogicalCount}/${specs.length} semantic slice(s); completed logical slices were checkpointed for resume.`);
                error.name = 'TV2Builder2SemanticBatchFailure';
                error.failures = batchResult.failed;
                throw error;
            }
            let semanticRecoveredCount = 0;
            if (inspected.failures.length) {
                this.logEvent('builder2', 'semantic-bundle-partial-recovery', {
                    runId: plan.runId, book: plan.book, stage,
                    failedLogicalSliceCount: inspected.failures.length,
                    logicalSliceIndexes: inspected.failures.map(row => row.member.index),
                    retainedLogicalSliceCount: specs.length - inspected.failures.length,
                }, 'warn');
                const recoveryItems = inspected.failures.map(({ member, error }, index) => ({
                    ...member,
                    physicalIndex:index,
                    logicalMembers:[member],
                    logicalIndexes:[member.index],
                    multiplexed:false,
                    validationError:error,
                }));
                const recoveryResult = await runBatch({
                    domain:'tree', stage:'tree-build', items:recoveryItems,
                    buildRequest: spec => ({
                        systemPrompt: `${spec.systemPrompt} RECOVERY: The prior multiplexed answer violated this logical slice contract. Apply the validator feedback exactly and return only valid JSON.`,
                        prompt: `${spec.prompt}\n\n${semanticRecoveryCorrection({ error:spec.validationError })}`,
                        responseFormat:'json_object', temperature:Math.min(Number(spec.temperature ?? 0.15),0.08), timeoutMs:this.timeoutMs,
                        label:`Builder 2 · ${stage} logical recovery · slice ${spec.logicalIndexes[0] + 1}/${specs.length}`,
                        role:'treeBuild', executionMode:'adaptive', mainEligible:worker.mainEligible, forceMain:worker.forceMain, structuredValidator:objectValidator(spec.validator),
                        telemetry:{ builder2:true,builderRunId:plan.runId,builderPlanRevision:plan.planRevision,builderStage:stage,builderBatch:true,builderBatchRecovery:true,builderMultiplexPartialRecovery:true,builderBatchSliceIndex:spec.logicalIndexes[0],builderBatchSliceCount:specs.length,builderExecutionKey:spec.sliceExecutionKey },
                    }),
                    parse:(text,spec)=>parseStructuredJsonCandidate(text,{validator:objectValidator(spec.validator),label:`Builder 2 ${stage} logical recovery slice ${spec.logicalIndexes[0] + 1}`}),
                    validate:()=>true,
                    // This is the one semantic correction attempt for an invalid
                    // multiplex group. Do not recursively add a second semantic retry.
                    buildRecovery:null,
                    label:`Builder 2 · ${stage} logical recovery`, priority:18, role:'treeBuild', executionMode:'adaptive',
                    requestedBatch:recoveryItems.length>1, allowPartial:true, dedupKey:`${executionKey}:logical-recovery`,
                    telemetry:{builder2:true,builderRunId:plan.runId,builderPlanRevision:plan.planRevision,builderStage:stage,builderMultiplexPartialRecovery:true,builderExecutionKey:executionKey,builderSemanticResource:worker.semanticResource},
                    executionClass:'model-worker', dispatchUnits:modelWorkerDispatch,
                    signal:context.signal||signal,
                });
                recordBuilder2AuthoritativeSemanticWork(plan.runId,{stage:`${stage}:logical-recovery`,...semanticBatchUsage(recoveryResult,recoveryItems)});
                for (const row of recoveryResult.completed || []) {
                    const member=row?.unit?.item;
                    if (member && Number.isInteger(member.index)) inspected.logical[member.index]=row.value;
                }
                const recoveredCheckpoint=cachedLogical.slice();
                for(let i=0;i<inspected.logical.length;i+=1)if(inspected.logical[i]!==undefined)recoveredCheckpoint[i]=inspected.logical[i];
                if(durableLogicalWorkspace)await this.#writeSemanticBatchWorkspace(stage,workspaceFingerprint,specs,recoveredCheckpoint);
                if (recoveryResult.failed?.length) {
                    const error = new Error(`Builder 2 ${stage} logical recovery failed ${recoveryResult.failed.length}/${inspected.failures.length} invalid semantic slice(s); retained sibling slices were checkpointed and will not replay.`);
                    error.name='TV2Builder2SemanticBatchFailure';error.failures=recoveryResult.failed;throw error;
                }
                semanticRecoveredCount = recoveryResult.completed?.length || 0;
            }
            const response = cachedLogical.slice();
            for(let i=0;i<inspected.logical.length;i+=1)if(inspected.logical[i]!==undefined)response[i]=inspected.logical[i];
            if(durableLogicalWorkspace)await this.#writeSemanticBatchWorkspace(stage,workspaceFingerprint,specs,response);
            if (response.some(value => value === undefined)) throw new Error(`Builder 2 ${stage} batch did not resolve every logical semantic slice.`);
            return {
                sidecarOnly: false,
                modelWorker: true,
                mainEligible: worker.mainEligible,
                semanticResource: worker.semanticResource,
                batchLayer: true,
                batched: physicalSpecs.length > 1,
                response,
                batchSummary: {
                    itemCount: specs.length,
                    physicalRequestCount: physicalSpecs.length,
                    bundleSizes: physicalSpecs.map(spec => spec.logicalMembers.length),
                    completedCount: response.length,
                    failedCount: batchResult.failed?.length || 0,
                    recoveredCount: (batchResult.recoveredCount || 0) + semanticRecoveredCount,
                    semanticRecoveredCount,
                    plannedBatchCount: Number(batchResult.plan?.batchCount) || 0,
                    maxBatchItems: Number(batchResult.plan?.maxBatchItems) || null,
                },
            };
        });
        this.logEvent('builder2', 'semantic-batch-dispatch', { runId: plan.runId, book: plan.book, stage, directorPlanId: directorPlan.id, executionKey, sliceCount: specs.length, physicalRequestCount: physicalSpecs.length, bundleSizes: physicalSpecs.map(spec => spec.logicalMembers.length), bundleEstimatedInputTokens: packing.bundles.map(bundle => Math.round(bundle.estimatedInputTokens || 0)), physicalInputTargetTokens: packing.targetInputTokens, physicalMaxMembers: packing.maxMembers, semanticResource: worker.semanticResource }, 'info');
        const snapshot = await this.runtime.coordinator.run(directorPlan, {
            executors: { [type]: executor },
            signal,
            isFresh: () => !signal?.aborted,
        });
        throwIfAborted(signal);
        const job = snapshot.jobs?.[0];
        if (!job) throw new Error(`Builder 2 ${stage} WorkCoordinator returned no batched job result.`);
        if (job.state === 'cancelled') throw abortError(job.error || `Builder 2 ${stage} batch cancelled.`);
        if (job.state !== 'succeeded') {
            const error = new Error(`Builder 2 ${stage} batch ${job.state}: ${job.error || 'semantic batch did not succeed'}`);
            error.name = job.state === 'blocked' || job.state === 'skipped' ? 'TV2Builder2SemanticBlocked' : 'TV2Builder2SemanticFailure';
            throw error;
        }
        const values = job.result?.value?.response;
        if (!Array.isArray(values) || values.length !== specs.length) throw new Error(`Builder 2 ${stage} batch returned ${Array.isArray(values) ? values.length : 0}/${specs.length} slice results.`);
        this.logEvent('builder2', 'semantic-batch-complete', { runId: plan.runId, book: plan.book, stage, directorPlanId: directorPlan.id, sliceCount: specs.length, physicalRequestCount: physicalSpecs.length }, 'info');
        return values;
    }

    analyzeSurveySlice = async ({ entries = [], signal = null } = {}) => {
        const refToSource = new Map(entries.map(row => [row.ref, row.sourceKey]));
        const payload = entries.map(row => ({ ref: row.ref, title: row.title, keys: row.keys, content: row.content }));
        const raw = await this.#execute({
            stage: 'survey', signal,
            systemPrompt: 'You are Nexus Builder 2 corpus survey. Describe semantic themes only. You do not design Tree structure. Return exact JSON only.',
            prompt: [
                'Survey this bounded corpus slice. Group related lore into reusable semantic themes. Do not propose folders, paths, node IDs, or per-entry categories.',
                'ENTRIES:', json(payload),
                'Return JSON: {"themes":[{"themeId":"S1","label":"...","purpose":"...","aliases":["..."],"evidenceRefs":["R1"]}],"notes":"brief"}',
                'evidenceRefs may contain only supplied REF values.',
            ].join('\n\n'),
            validator: value => {
                const o = requireObject(value, 'survey result');
                const themes = requireArray(o.themes || [], 'survey themes');
                const legal = new Set(entries.map(row => row.ref));
                for (const theme of themes) {
                    if (!clean(theme?.label)) throw new Error('Survey theme requires label.');
                    const refs = requireArray(theme?.evidenceRefs || [], 'survey evidenceRefs').map(clean);
                    if (!refs.length || refs.some(ref => !legal.has(ref))) throw new Error('Survey evidenceRefs must be a non-empty subset of supplied REFs.');
                }
                return o;
            },
        });
        return {
            themes: (raw.themes || []).map((theme, index) => ({
                themeId: clean(theme.themeId) || `survey-${index + 1}`,
                label: clean(theme.label),
                purpose: clean(theme.purpose),
                aliases: Array.isArray(theme.aliases) ? theme.aliases.map(clean).filter(Boolean) : [],
                evidenceSourceKeys: [...new Set((theme.evidenceRefs || []).map(ref => refToSource.get(clean(ref))).filter(Boolean))],
            })),
            notes: clean(raw.notes),
        };
    };

    analyzeSurveySlices = async ({ slices = [], signal = null } = {}) => {
        const values = await this.#executeBatch({
            stage: 'survey',
            slices,
            signal,
            buildSpec: slice => {
                const entries = Array.isArray(slice?.entries) ? slice.entries : [];
                const legal = new Set(entries.map(row => row.ref));
                return {
                    systemPrompt: 'You are Nexus Builder 2 corpus survey. Describe semantic themes only. You do not design Tree structure. Return exact JSON only.',
                    prompt: [
                        'Survey this bounded corpus slice. Group related lore into reusable semantic themes. Do not propose folders, paths, node IDs, or per-entry categories.',
                        'ENTRIES:', json(entries.map(row => ({ ref: row.ref, title: row.title, keys: row.keys, content: row.content }))),
                        'Return JSON: {"themes":[{"themeId":"S1","label":"...","purpose":"...","aliases":["..."],"evidenceRefs":["R1"]}],"notes":"brief"}',
                        'evidenceRefs may contain only supplied REF values.',
                    ].join('\n\n'),
                    temperature: 0.15,
                    validator: value => {
                        const o = requireObject(value, 'survey result');
                        const themes = requireArray(o.themes || [], 'survey themes');
                        for (const theme of themes) {
                            if (!clean(theme?.label)) throw new Error('Survey theme requires label.');
                            const refs = requireArray(theme?.evidenceRefs || [], 'survey evidenceRefs').map(clean);
                            if (!refs.length || refs.some(ref => !legal.has(ref))) throw new Error('Survey evidenceRefs must be a non-empty subset of supplied REFs.');
                        }
                        return o;
                    },
                };
            },
        });
        return values.map((raw, index) => {
            const entries = slices[index]?.entries || [];
            const refToSource = new Map(entries.map(row => [row.ref, row.sourceKey]));
            return {
                themes: (raw.themes || []).map((theme, themeIndex) => ({
                    themeId: clean(theme.themeId) || `survey-${themeIndex + 1}`,
                    label: clean(theme.label),
                    purpose: clean(theme.purpose),
                    aliases: Array.isArray(theme.aliases) ? theme.aliases.map(clean).filter(Boolean) : [],
                    evidenceSourceKeys: [...new Set((theme.evidenceRefs || []).map(ref => refToSource.get(clean(ref))).filter(Boolean))],
                })),
                notes: clean(raw.notes),
            };
        });
    };

    planTaxonomy = async ({ semanticMap = [], existingTaxonomy = [], sourceRevision, corpusRevision, treeRevision, signal = null } = {}) => {
        const semanticRows = semanticMap.map(row => ({
            label: row.label,
            purpose: row.purpose,
            aliases: row.aliases,
            evidenceCount: row.evidenceSourceKeys?.length || 0,
        }));
        const existingRows = existingTaxonomy.map(row => ({
            taxonId: row.taxonId,
            parentTaxonId: row.parentTaxonId,
            label: row.label,
            purpose: row.purpose,
            aliases: row.aliases,
            origin: row.origin,
            protection: row.protection,
            entryPolicy: row.entryPolicy,
            canonicalNodeId: row.canonicalNodeId,
        }));
        const validateTaxonomy = value => {
            const o = requireObject(value, 'taxonomy result');
            const nodes = requireArray(o.nodes || [], 'taxonomy nodes');
            const existing = new Set(existingTaxonomy.map(row => row.taxonId));
            const proposed = new Set();
            for (const [index, node] of nodes.entries()) {
                let id = clean(node?.taxonId);
                if (!id) id = `builder:${slug(node?.label)}-${index + 1}`;
                node.taxonId = id;
                if (proposed.has(id)) throw new Error(`Duplicate proposed taxonId ${id}.`);
                proposed.add(id);
                if (!clean(node?.label)) throw new Error(`Taxonomy node ${id} requires label.`);
            }
            const legal = new Set([...existing, ...proposed]);
            for (const node of nodes) {
                const parent = clean(node.parentTaxonId);
                if (parent && !legal.has(parent)) throw new Error(`Taxonomy node ${node.taxonId} references unknown parent ${parent}.`);
                if (!existing.has(node.taxonId) && !node.taxonId.startsWith('builder:')) throw new Error(`New taxon ${node.taxonId} must use builder: identity.`);
            }
            return o;
        };

        // Taxonomy is a durable workspace, not a disposable conversation.
        // Every expensive reduction stage checkpoints its resident artifact so a
        // retry/resume continues from the last completed semantic product instead
        // of replaying seed/consolidation work already accepted by this run.
        const taxonomyPlanningInputFingerprint = `taxonomy-workspace:${builder2Fingerprint({
            sourceRevision, corpusRevision, treeRevision: treeRevision || null,
            semanticRows, existingRows,
            packing: { maxEntries: this.semanticPacking.maxEntries, targetInputTokens: this.semanticPacking.targetInputTokens },
        })}`;
        let taxonomyCheckpoint = await this.#readTaxonomyCheckpoint(taxonomyPlanningInputFingerprint);
        if (taxonomyCheckpoint?.architectResult) {
            const reused = validateTaxonomy(structuredClone(taxonomyCheckpoint.architectResult));
            this.logEvent('builder2', 'taxonomy-workspace-reused', {
                runId: this.runId,
                stage: 'architect-result',
                consolidationRound: Number(taxonomyCheckpoint.consolidationRound || 0),
                candidateCount: Array.isArray(taxonomyCheckpoint.taxonomyInput) ? taxonomyCheckpoint.taxonomyInput.length : null,
            }, 'info');
            return {
                nodes: (reused.nodes || []).map(node => ({
                    ...node,
                    taxonId: clean(node.taxonId),
                    parentTaxonId: clean(node.parentTaxonId) || null,
                    label: clean(node.label),
                    purpose: clean(node.purpose),
                    aliases: Array.isArray(node.aliases) ? node.aliases.map(clean).filter(Boolean) : [],
                    evidenceSourceKeys: [],
                    origin: clean(node.origin) || 'builder',
                    entryPolicy: node.entryPolicy === 'container-only' ? 'container-only' : 'allow',
                })),
                reason: clean(reused.reason),
            };
        }

        let taxonomyInput = Array.isArray(taxonomyCheckpoint?.taxonomyInput)
            ? structuredClone(taxonomyCheckpoint.taxonomyInput)
            : semanticRows;
        let taxonomyInputLabel = clean(taxonomyCheckpoint?.taxonomyInputLabel) || 'GLOBAL SEMANTIC MAP:';
        const packedTaxonomy = packBuilder2SemanticValues(semanticRows, {
            maxEntries: this.semanticPacking.maxEntries,
            targetInputTokens: this.semanticPacking.targetInputTokens,
        });
        const semanticChars = JSON.stringify(semanticRows).length;
        let consolidationRound = Math.max(0, Number(taxonomyCheckpoint?.consolidationRound || 0));

        if (packedTaxonomy.sliceCount > 1) {
            const slices = packedTaxonomy.slices.map(slice => ({
                rows: slice.entries,
                estimatedInputTokens: slice.estimatedInputTokens,
                oversized: slice.oversized === true,
            }));

            if (!Array.isArray(taxonomyCheckpoint?.taxonomyInput)) {
                const seedResults = await this.#executeBatch({
                    stage: 'taxonomy-seed',
                    slices,
                    signal,
                    buildSpec: (slice, index) => ({
                        systemPrompt: 'You are Nexus Builder 2 taxonomy seed analyst. Propose broad reusable semantic categories only. You do not own final Tree structure. Return exact JSON only.',
                        prompt: [
                            `Analyze semantic-map shard ${index + 1}/${slices.length}. Produce at most 10 broad reusable taxonomy candidates that summarize this shard.`,
                            'Do not create taxon IDs, parent paths, or one category per theme. Prefer categories that can absorb several related themes.',
                            'SEMANTIC THEMES:', json(slice.rows),
                            'Return JSON: {"candidates":[{"label":"Characters","purpose":"...","aliases":["..."]}],"reason":"brief"}',
                        ].join('\n\n'),
                        temperature: 0.10,
                        validator: value => {
                            const o = requireObject(value, 'taxonomy seed result');
                            const candidates = requireArray(o.candidates || [], 'taxonomy seed candidates');
                            if (candidates.length > 10) throw new Error('Taxonomy seed returned more than 10 candidates.');
                            for (const candidate of candidates) if (!clean(candidate?.label)) throw new Error('Taxonomy seed candidate requires label.');
                            return o;
                        },
                    }),
                });
                const byLabel = new Map();
                for (const result of seedResults) for (const candidate of result?.candidates || []) {
                    const label = clean(candidate?.label), key = label.toLowerCase();
                    if (!label || byLabel.has(key)) continue;
                    byLabel.set(key, {
                        label,
                        purpose: clean(candidate?.purpose),
                        aliases: Array.isArray(candidate?.aliases) ? candidate.aliases.map(clean).filter(Boolean).slice(0, 12) : [],
                    });
                }
                taxonomyInput = [...byLabel.values()];
                consolidationRound = 0;
                taxonomyCheckpoint = await this.#writeTaxonomyCheckpoint(taxonomyPlanningInputFingerprint, {
                    stage: 'seeded',
                    taxonomyInput,
                    taxonomyInputLabel: 'BATCHED TAXONOMY SEEDS (advisory; consolidate globally):',
                    consolidationRound,
                    consolidationComplete: false,
                    sourceThemeCount: semanticRows.length,
                    seedShardCount: slices.length,
                });
            } else {
                this.logEvent('builder2', 'taxonomy-workspace-reused', {
                    runId: this.runId,
                    stage: taxonomyCheckpoint.stage || 'seeded',
                    consolidationRound,
                    candidateCount: taxonomyInput.length,
                }, 'info');
            }

            const architectSeedTokenTarget = Math.max(3500, Math.min(8000,
                (Number(this.semanticPacking.targetInputTokens) || 3500) * 2));
            const architectSeedMaxCandidates = 64;
            const architectSeedHardTokenLimit = Math.max(
                architectSeedTokenTarget,
                Math.min(12000, architectSeedTokenTarget + 5000),
            );
            const architectSeedHardMaxCandidates = 96;
            const maxConsolidationRounds = 6;
            const seedTokenCount = values => packBuilder2SemanticValues(values, {
                maxEntries: Math.max(1, values.length || 1),
                targetInputTokens: null,
            }).slices.reduce((sum, slice) => sum + Number(slice.estimatedInputTokens || 0), 0);
            let taxonomySeedTokens = seedTokenCount(taxonomyInput);

            while (!taxonomyCheckpoint?.consolidationComplete
                && (taxonomyInput.length > architectSeedMaxCandidates || taxonomySeedTokens > architectSeedTokenTarget)
                && consolidationRound < maxConsolidationRounds) {
                consolidationRound += 1;
                const roundTargetCandidates = consolidationRound >= 5 ? 4 : consolidationRound >= 3 ? 6 : 8;
                const packedSeeds = packBuilder2SemanticValues(taxonomyInput, {
                    maxEntries: this.semanticPacking.maxEntries,
                    targetInputTokens: this.semanticPacking.targetInputTokens,
                });
                const consolidationSlices = packedSeeds.slices.map(slice => ({
                    rows: slice.entries,
                    estimatedInputTokens: slice.estimatedInputTokens,
                    oversized: slice.oversized === true,
                }));
                const consolidatedResults = await this.#executeBatch({
                    stage: `taxonomy-consolidate-r${consolidationRound}`,
                    slices: consolidationSlices,
                    signal,
                    buildSpec: (slice, index) => ({
                        systemPrompt: 'You are Nexus Builder 2 taxonomy evidence consolidator. Merge overlapping advisory categories only. You do not own final Tree structure. Return exact JSON only.',
                        prompt: [
                            `Consolidate advisory taxonomy shard ${index + 1}/${consolidationSlices.length}. Target ${roundTargetCandidates} or fewer broad reusable candidates by merging synonyms and near-duplicates while preserving materially distinct domains.`,
                            `COMPRESSION TARGET: 1-${roundTargetCandidates} candidates. If the shard truly contains more than ${roundTargetCandidates} materially distinct domains, preserve them rather than inventing a false merge; Nexus can run another hierarchical consolidation round.`,
                            `HARD SAFETY LIMIT: do not expand the shard beyond its ${slice.rows.length} input candidates.`,
                            'Do not create taxon IDs, parents, paths, or final Tree structure.',
                            'ADVISORY CANDIDATES:', json(slice.rows),
                            'Return JSON: {"candidates":[{"label":"Characters","purpose":"...","aliases":["..."]}],"reason":"brief"}',
                        ].join('\n\n'),
                        temperature: 0.08,
                        validator: value => {
                            const o = requireObject(value, 'taxonomy consolidation result');
                            const candidates = requireArray(o.candidates || [], 'taxonomy consolidation candidates');
                            if (!candidates.length && slice.rows.length) throw new Error('Taxonomy consolidation must preserve at least one candidate for a non-empty shard.');
                            if (candidates.length > slice.rows.length) throw new Error(`Taxonomy consolidation expanded ${slice.rows.length} input candidates into ${candidates.length}; consolidation may not increase candidate count.`);
                            for (const candidate of candidates) if (!clean(candidate?.label)) throw new Error('Taxonomy consolidation candidate requires label.');
                            return o;
                        },
                    }),
                });
                consolidatedResults.forEach((result, index) => {
                    const candidateCount = Array.isArray(result?.candidates) ? result.candidates.length : 0;
                    if (candidateCount > roundTargetCandidates) this.logEvent('builder2', 'taxonomy-consolidation-soft-target-missed', {
                        runId: this.runId,
                        round: consolidationRound,
                        shardIndex: index,
                        shardCount: consolidationSlices.length,
                        inputCandidateCount: consolidationSlices[index]?.rows?.length || 0,
                        outputCandidateCount: candidateCount,
                        targetCandidateCount: roundTargetCandidates,
                        action: 'accepted-for-next-hierarchical-round',
                    }, 'warn');
                });
                const consolidatedByLabel = new Map();
                for (const result of consolidatedResults) for (const candidate of result?.candidates || []) {
                    const label = clean(candidate?.label), key = label.toLowerCase();
                    if (!label || consolidatedByLabel.has(key)) continue;
                    consolidatedByLabel.set(key, {
                        label,
                        purpose: clean(candidate?.purpose),
                        aliases: Array.isArray(candidate?.aliases) ? candidate.aliases.map(clean).filter(Boolean).slice(0, 12) : [],
                    });
                }
                const beforeCount = taxonomyInput.length;
                const beforeTokens = taxonomySeedTokens;
                taxonomyInput = [...consolidatedByLabel.values()];
                taxonomySeedTokens = seedTokenCount(taxonomyInput);
                taxonomyCheckpoint = await this.#writeTaxonomyCheckpoint(taxonomyPlanningInputFingerprint, {
                    stage: `consolidated-r${consolidationRound}`,
                    taxonomyInput,
                    taxonomyInputLabel: 'CONSOLIDATED TAXONOMY SEEDS (advisory; architect owns final structure):',
                    consolidationRound,
                    consolidationComplete: false,
                });
                this.logEvent('builder2', 'taxonomy-seeds-consolidated', {
                    runId: this.runId,
                    round: consolidationRound,
                    beforeCount,
                    afterCount: taxonomyInput.length,
                    beforeTokens,
                    afterTokens: taxonomySeedTokens,
                    targetTokens: architectSeedTokenTarget,
                    maxCandidates: architectSeedMaxCandidates,
                    shardCount: consolidationSlices.length,
                    packingContract: 'builder-semantic',
                }, 'info');
                if (taxonomyInput.length >= beforeCount && taxonomySeedTokens >= beforeTokens) break;
            }

            const overArchitectSoftEnvelope = taxonomyInput.length > architectSeedMaxCandidates
                || taxonomySeedTokens > architectSeedTokenTarget;
            const overArchitectHardEnvelope = taxonomyInput.length > architectSeedHardMaxCandidates
                || taxonomySeedTokens > architectSeedHardTokenLimit;
            if (overArchitectSoftEnvelope && !overArchitectHardEnvelope) {
                this.logEvent('builder2', 'taxonomy-architect-soft-envelope-exceeded', {
                    runId: this.runId,
                    consolidationRounds: consolidationRound,
                    candidateCount: taxonomyInput.length,
                    inputTokens: taxonomySeedTokens,
                    softMaxCandidates: architectSeedMaxCandidates,
                    softTokenTarget: architectSeedTokenTarget,
                    hardMaxCandidates: architectSeedHardMaxCandidates,
                    hardTokenLimit: architectSeedHardTokenLimit,
                    action: 'proceed-within-hard-safety-envelope',
                }, 'warn');
            }
            if (overArchitectHardEnvelope) {
                const error = new Error(`Builder 2 taxonomy evidence remained above the hard architect envelope after ${consolidationRound} consolidation round(s): ${taxonomyInput.length} candidates / ~${taxonomySeedTokens} tokens (soft ${architectSeedMaxCandidates} / ${architectSeedTokenTarget}; hard ${architectSeedHardMaxCandidates} / ${architectSeedHardTokenLimit}).`);
                error.name = 'TV2Builder2TaxonomyEvidenceTooLarge';
                throw error;
            }
            taxonomyInputLabel = consolidationRound
                ? 'CONSOLIDATED TAXONOMY SEEDS (advisory; architect owns final structure):'
                : 'BATCHED TAXONOMY SEEDS (advisory; consolidate globally):';
            taxonomyCheckpoint = await this.#writeTaxonomyCheckpoint(taxonomyPlanningInputFingerprint, {
                stage: 'architect-ready',
                taxonomyInput,
                taxonomyInputLabel,
                consolidationRound,
                consolidationComplete: true,
                architectSeedTokenTarget,
                architectSeedMaxCandidates,
                architectSeedHardTokenLimit,
                architectSeedHardMaxCandidates,
            });
            this.logEvent('builder2', 'taxonomy-plan-sharded', {
                runId: this.runId,
                sourceThemeCount: semanticRows.length,
                sourceChars: semanticChars,
                shardCount: slices.length,
                seedCount: taxonomyInput.length,
                seedInputTokens: taxonomySeedTokens,
                consolidationRounds: consolidationRound,
                architectSeedTokenTarget,
                architectSeedMaxCandidates,
                architectSeedHardTokenLimit,
                architectSeedHardMaxCandidates,
                maxConsolidationRounds,
                proceededOverSoftEnvelope: overArchitectSoftEnvelope,
                maxEntriesPerShard: packedTaxonomy.entryLimit,
                semanticInputTargetTokens: packedTaxonomy.targetInputTokens,
                shardInputTokens: packedTaxonomy.slices.map(slice => slice.estimatedInputTokens),
                oversizedShardCount: packedTaxonomy.slices.filter(slice => slice.oversized).length,
                packingContract: 'builder-semantic',
            }, 'info');
        } else {
            taxonomyCheckpoint = await this.#writeTaxonomyCheckpoint(taxonomyPlanningInputFingerprint, {
                stage: 'architect-ready',
                taxonomyInput,
                taxonomyInputLabel,
                consolidationRound: 0,
                consolidationComplete: true,
            });
        }

        const raw = await this.#execute({
            stage: 'taxonomy-plan', signal, temperature: 0.12,
            systemPrompt: 'You are Nexus Builder 2 centralized taxonomy architect. You alone may propose Tree structure. Return exact JSON only.',
            prompt: [
                'Design one coherent taxonomy for the whole lorebook from the supplied global semantic evidence and existing Tree. Reuse existing structure when sensible. Do not create one leaf per lore entry unless the corpus truly requires it.',
                'If the evidence is batched taxonomy seeds, treat them as advisory compression: merge synonyms, recover broad hierarchy, and do not assume one seed equals one final node.',
                'Existing nodes marked locked/protected are authoritative and may not be deleted, renamed, moved, or repurposed.',
                'The Root taxon is container-only. Prefer stable broad categories with meaningful subcategories. Avoid duplicate sibling labels and synonym fragmentation.',
                `AUTHORITY: sourceRevision=${sourceRevision} corpusRevision=${corpusRevision} treeRevision=${treeRevision || 'none'}`,
                taxonomyInputLabel, json(taxonomyInput),
                'EXISTING TAXONOMY:', json(existingRows),
                'Return JSON: {"nodes":[{"taxonId":"builder:stable-id","parentTaxonId":null,"label":"Characters","purpose":"...","aliases":[],"entryPolicy":"allow","origin":"builder"}],"reason":"brief"}',
                'For new nodes, taxonId must be a unique stable string beginning with "builder:". parentTaxonId must reference an existing taxonId or another node returned here. You may omit unchanged existing nodes.',
            ].join('\n\n'),
            validator: validateTaxonomy,
        });
        await this.#writeTaxonomyCheckpoint(taxonomyPlanningInputFingerprint, {
            stage: 'architect-complete',
            taxonomyInput,
            taxonomyInputLabel,
            consolidationRound,
            consolidationComplete: true,
            architectResult: structuredClone(raw),
        });
        return {
            nodes: (raw.nodes || []).map(node => ({
                ...node,
                taxonId: clean(node.taxonId),
                parentTaxonId: clean(node.parentTaxonId) || null,
                label: clean(node.label),
                purpose: clean(node.purpose),
                aliases: Array.isArray(node.aliases) ? node.aliases.map(clean).filter(Boolean) : [],
                evidenceSourceKeys: [],
                origin: clean(node.origin) || 'builder',
                entryPolicy: node.entryPolicy === 'container-only' ? 'container-only' : 'allow',
            })),
            reason: clean(raw.reason),
        };
    };

    routeTaxonomy = async ({ entries = [], candidates = [], signal = null } = {}) => this.#execute({
        stage: 'taxonomy-route', signal, temperature: 0.05,
        systemPrompt: 'You are Nexus Builder 2 taxonomy router. Choose only supplied taxon IDs. Return exact JSON only.',
        prompt: [
            'Choose the smallest set of candidate branches that could plausibly contain these entries. Never invent structure or IDs.',
            'ENTRIES:', json(entries.map(row => ({ ref: row.ref, title: row.title, keys: row.keys, content: row.content }))),
            'CANDIDATES:', json(candidates),
            'Return JSON: {"taxonIds":["exact-supplied-id"]}. At least one ID is required.',
        ].join('\n\n'),
        validator: value => {
            const o = requireObject(value, 'taxonomy route');
            const legal = new Set(candidates.map(row => row.taxonId));
            const ids = requireArray(o.taxonIds || (o.taxonId ? [o.taxonId] : []), 'taxonIds').map(clean);
            if (!ids.length || ids.some(id => !legal.has(id))) throw new Error('Taxonomy router must return one or more supplied taxon IDs only.');
            return { taxonIds: [...new Set(ids)] };
        },
    });

    classifySlice = async ({ entries = [], taxonomy = [], taxonomyRevision, classificationRevision, signal = null } = {}) => this.#execute({
        stage: 'classification', signal, temperature: 0.08,
        systemPrompt: 'You are Nexus Builder 2 lore classifier. You classify only. You may not create Tree structure. Return exact JSON only.',
        prompt: [
            'Classify every supplied REF exactly once against the supplied taxonomy window.',
            'Legal decisions are: "classified", "taxonomy_gap", "ambiguous".',
            'For classified, use exactly one supplied taxonId. Never attach to a container-only taxon.',
            'For taxonomy_gap, OMIT taxonId entirely; do not invent a node or path; explain the missing concept briefly.',
            'For ambiguous, OMIT taxonId entirely and return at least two supplied candidate taxon IDs with confidence values.',
            'For ambiguous, candidates MUST be an array of objects shaped {taxonId, confidence}; never return candidate IDs as bare strings. Each taxonId must exactly match one ID from TAXONOMY WINDOW.',
            'Never output path, newNodeLabel, parentNodeId, internal Tree IDs, or lorebook UIDs.',
            `TAXONOMY REVISION: ${taxonomyRevision} / ${classificationRevision}`,
            'TAXONOMY WINDOW:', json(taxonomy),
            'ENTRIES:', json(entries.map(row => ({ ref: row.ref, title: row.title, keys: row.keys, content: row.content }))),
            'Return JSON: {"classifications":[{"ref":"R1","decision":"classified","taxonId":"exact-id","candidates":[],"reason":"brief","confidence":0.9}]}',
        ].join('\n\n'),
        validator: value => validateClassificationSemanticResult(value, { entries, taxonomy, taxonomyRevision, classificationRevision }),
    });

    classifySlices = async ({ slices = [], signal = null } = {}) => this.#executeBatch({
        stage: 'classification',
        slices,
        signal,
        buildSpec: slice => {
            const entries = Array.isArray(slice?.entries) ? slice.entries : [];
            const taxonomy = Array.isArray(slice?.taxonomy) ? slice.taxonomy : [];
            const taxonomyRevision = slice?.taxonomyRevision;
            const classificationRevision = slice?.classificationRevision;
            const entryPayload = entries.map(row => ({ ref: row.ref, title: row.title, keys: row.keys, content: row.content }));
            const sharedPrompt = [
                'Classify every supplied REF exactly once against the supplied taxonomy window.',
                'Legal decisions are: "classified", "taxonomy_gap", "ambiguous".',
                'For classified, use exactly one supplied taxonId. Never attach to a container-only taxon.',
                'For taxonomy_gap, OMIT taxonId entirely; do not invent a node or path; explain the missing concept briefly.',
                'For ambiguous, OMIT taxonId entirely and return at least two supplied candidate taxon IDs with confidence values.',
                'For ambiguous, candidates MUST be an array of objects shaped {taxonId, confidence}; never return candidate IDs as bare strings. Each taxonId must exactly match one ID from TAXONOMY WINDOW.',
                'Never output path, newNodeLabel, parentNodeId, internal Tree IDs, or lorebook UIDs.',
                `TAXONOMY REVISION: ${taxonomyRevision} / ${classificationRevision}`,
                'TAXONOMY WINDOW:', json(taxonomy),
            ].join('\n\n');
            const groupPrompt = [
                'ENTRIES:', json(entryPayload),
                'Return JSON: {"classifications":[{"ref":"R1","decision":"classified","taxonId":"exact-id","candidates":[],"reason":"brief","confidence":0.9}]}',
            ].join('\n\n');
            const bundleIncrementTokens = Math.max(256, estimateContentTokens(groupPrompt) || Math.ceil(groupPrompt.length / 4));
            return {
                systemPrompt: 'You are Nexus Builder 2 lore classifier. You classify only. You may not create Tree structure. Return exact JSON only.',
                prompt: `${sharedPrompt}\n\n${groupPrompt}`,
                bundleKind: 'classification',
                bundleKey: `classification:${clean(taxonomyRevision)}:${clean(classificationRevision)}:${JSON.stringify(taxonomy)}`,
                bundleIncrementTokens,
                sharedPrompt,
                groupPrompt,
                temperature: 0.08,
                validator: value => validateClassificationSemanticResult(value, { entries, taxonomy, taxonomyRevision, classificationRevision }),
            };
        },
    });

    consolidateGaps = async ({ gaps = [], taxonomy = [], signal = null } = {}) => {
        const refMap = new Map();
        const gapRows = gaps.map((gap, index) => {
            const ref = `G${index + 1}`;
            refMap.set(ref, gap.sourceKey);
            return { ref, reason: gap.reason, source: gap.source ? { title: gap.source.title, keys: gap.source.keys, content: gap.source.content } : null };
        });
        const raw = await this.#execute({
            stage: 'gap-consolidation', signal, temperature: 0.1,
            systemPrompt: 'You are Nexus Builder 2 taxonomy gap consolidator. Propose minimal centralized taxonomy additions. Return exact JSON only.',
            prompt: [
                'Consolidate related taxonomy gaps. Prefer one reusable category for several related gaps over per-entry leaves. You may also propose placement under an existing parent taxon. Every supplied gap REF must appear in exactly one evidenceRefs list. Never silently omit a gap. If an existing taxonomy node appears suitable, still include that gap in a proposal so the operator can choose Merge into existing during review.',
                'GAPS:', json(gapRows),
                'CURRENT TAXONOMY:', json(taxonomy.map(row => ({ taxonId: row.taxonId, parentTaxonId: row.parentTaxonId, label: row.label, purpose: row.purpose, entryPolicy: row.entryPolicy }))),
                'Return JSON: {"proposals":[{"proposalId":"P1","parentTaxonId":null,"label":"...","purpose":"...","aliases":[],"entryPolicy":"allow","evidenceRefs":["G1"]}]}',
            ].join('\n\n'),
            validator: value => {
                const o = requireObject(value, 'gap consolidation');
                const legalRefs = new Set(gapRows.map(row => row.ref));
                const legalTaxa = new Set(taxonomy.map(row => row.taxonId));
                for (const row of requireArray(o.proposals || [], 'gap proposals')) {
                    if (!clean(row?.label)) throw new Error('Gap proposal requires label.');
                    const refs = requireArray(row.evidenceRefs || [], 'gap evidenceRefs').map(clean);
                    if (!refs.length || refs.some(ref => !legalRefs.has(ref))) throw new Error('Gap evidenceRefs must reference supplied gaps.');
                    const parent = clean(row.parentTaxonId);
                    if (parent && !legalTaxa.has(parent)) throw new Error(`Gap proposal references unknown parent ${parent}.`);
                }
                return o;
            },
        });
        return {
            proposals: (raw.proposals || []).map(row => ({
                proposalId: clean(row.proposalId), parentTaxonId: clean(row.parentTaxonId) || null,
                label: clean(row.label), purpose: clean(row.purpose), aliases: Array.isArray(row.aliases) ? row.aliases.map(clean).filter(Boolean) : [],
                entryPolicy: row.entryPolicy === 'container-only' ? 'container-only' : 'allow',
                evidenceSourceKeys: [...new Set((row.evidenceRefs || []).map(ref => refMap.get(clean(ref))).filter(Boolean))],
            })),
        };
    };

    proposeReconciliation = async ({ taxonomy = [], classifications = [], signal = null } = {}) => this.#execute({
        stage: 'reconciliation', signal, temperature: 0.08,
        systemPrompt: 'You are Nexus Builder 2 taxonomy reconciliation reviewer. Suggest only high-confidence structural cleanup. Return exact JSON only.',
        prompt: [
            'Inspect the taxonomy after classification. Propose a cleanup only for clear synonym duplication, misplaced branches, or an obviously overloaded category. Protected/locked existing nodes must not be modified.',
            'It is valid and preferred to return no proposals when the taxonomy is coherent.',
            'TAXONOMY:', json(taxonomy.map(row => ({ taxonId: row.taxonId, parentTaxonId: row.parentTaxonId, label: row.label, purpose: row.purpose, aliases: row.aliases, protection: row.protection, entryPolicy: row.entryPolicy }))),
            'CLASSIFICATION COUNTS:', json(Object.entries(classifications.reduce((out, row) => { if (row.taxonId) out[row.taxonId] = (out[row.taxonId] || 0) + 1; return out; }, {})).map(([taxonId, count]) => ({ taxonId, count }))),
            'Return JSON: {"proposals":[]} or proposals using actions rename/move/merge/split and exact supplied taxon IDs. For split, include children with unique builder: taxonId values and affectedSourceKeys only when known.',
        ].join('\n\n'),
        validator: value => {
            const o = requireObject(value, 'reconciliation result');
            const legal = new Set(taxonomy.map(row => row.taxonId));
            for (const row of requireArray(o.proposals || [], 'reconciliation proposals')) {
                if (!['rename', 'move', 'merge', 'split'].includes(clean(row?.action))) throw new Error(`Unknown reconciliation action ${row?.action}.`);
                for (const id of row.taxonIds || [row.taxonId, row.fromTaxonId, row.toTaxonId].filter(Boolean)) if (id && !legal.has(clean(id))) throw new Error(`Reconciliation references unknown taxon ${id}.`);
            }
            return o;
        },
    });
}

export function resolveNexusBuilder2SemanticResource(request, runtime) {
    const preference = clean(request?.metadata?.semanticResource || 'auto').toLowerCase();
    const profile = runtime?.executionProfile || {};
    const sidecar = profile.internalSidecarWorkAvailable === true;
    const main = profile.mainWorkerAvailable === true || profile.mainBoundaryAvailable === true;
    if (preference === 'main') {
        if (main) return 'main';
        const error = new Error('Builder 2 was explicitly constrained to Main, but the Nexus Main worker is not currently available.');
        error.name = 'TV2Builder2MainWorkerUnavailable';
        throw error;
    }
    if (preference === 'sidecar') {
        if (sidecar) return 'sidecar';
        const error = new Error('Builder 2 was explicitly constrained to Sidecars, but no Sidecar worker is enabled.');
        error.name = 'TV2Builder2SidecarUnavailable';
        throw error;
    }
    if (preference !== 'auto' && preference !== 'model-worker') {
        const error = new Error(`Unknown Builder 2 semantic resource preference: ${preference}.`);
        error.name = 'TV2Builder2SemanticResourceInvalid';
        throw error;
    }
    if (profile.modelWorkerAvailable === true || main || sidecar) return 'model-worker';
    const error = new Error('Builder 2 has no enabled Model Worker resource. Enable Main worker participation or connect an operator-approved Sidecar worker.');
    error.name = 'TV2Builder2SemanticResourceUnavailable';
    throw error;
}
