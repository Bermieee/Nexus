import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import {
    drainPostTurnEvaluatedWindow,
    inspectPostTurnBacklogForAdmission,
    inspectPostTurnEvaluationWindow,
    postTurnBacklogAuthoritySnapshot,
    postTurnEvaluationAuthoritySnapshot,
    isPostTurnEvaluationAuthorityCurrent,
    consumePostTurnEvaluatedWindow,
    discardPostTurnBacklog,
} from '../postturn/pipeline.js';
import {
    evaluateLifecycleWorkAdmission,
    lifecycleAdmissionFingerprint,
    evaluateLifecycleEvidenceRoute,
    lifecycleEvidenceRouteFingerprint,
    LIFECYCLE_DESTINATION,
    LIFECYCLE_ROUTE_THRESHOLD,
} from './decision-site.js';
import { getSceneScannerSnapshot } from '../scene/scanner.js';
import { getCurrentSceneChangeGate } from '../retrieval/change-gate.js';
import { getRetrievalState } from '../retrieval/state.js';
import { searchTree } from '../retrieval/search-engine.js';
import { getCharacterBanks } from '../memory/character-banks.js';
import { getNotebook } from '../memory/notebook.js';
import { getActiveMemories, getMemoryRecord, memoryRecordVersion, setMemoryRouteEvaluation } from '../memory/store.js';
import {
    characterStateSourceFromChatRange,
    reviewCharacterEvidence,
    reviewSummaryForCharacterState,
} from '../memory/character-state-review.js';
import { runLaneAModelWorkerBatch } from '../memory/model-worker.js';
import { evaluateSummaryDurableRoutingAssist, summaryDurableRoutingFingerprint, SUMMARY_DURABLE_ROUTING_SITE_ID } from '../memory/decision-sites.js';
import { routeMemoryToLore, settleAutomaticLoreRoutingNoop } from '../memory/lore-router.js';
import { logEvent } from '../observability/telemetry.js';

const MAX_EVIDENCE_CHARS = 24000;
const MAX_MESSAGE_CHARS = 9000;
const MAX_NOTEBOOK_CHARS = 1800;
const MAX_CHARACTER_STATE_CHARS = 3200;
const MAX_SUMMARY_STATE_CHARS = 1800;
const SUMMARY_DURABLE_CONFIDENT_NO_MAX = 0.30;

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function clip(value, max) { const text = String(value ?? ''); return text.length <= max ? text : `${text.slice(0, max)}…`; }
function clipBalanced(value, max) {
    const text = String(value ?? '');
    if (text.length <= max) return text;
    const budget = Math.max(300, Number(max) || 0);
    const head = Math.floor(budget * 0.38);
    const middle = Math.floor(budget * 0.24);
    const tail = Math.max(1, budget - head - middle - 90);
    const midStart = Math.max(head, Math.floor((text.length - middle) / 2));
    return `${text.slice(0, head)}\n[… middle evidence preserved below …]\n${text.slice(midStart, midStart + middle)}\n[… later evidence preserved below …]\n${text.slice(-tail)}`;
}
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function unique(values = []) { return [...new Set(values.map(value => clean(value)).filter(Boolean))]; }

function renderedEvidenceWindow(context, start, end) {
    const chat = context?.chat || [];
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return { text: '', sourceIds: [] };
    const rows = [];
    const sourceIds = [];
    for (let index = start; index <= end && index < chat.length; index += 1) {
        const message = chat[index];
        if (!message || message?.is_system === true) continue;
        const role = message?.is_user === true ? 'User' : 'Assistant';
        const id = String(message?.extra?.tv2_message_id || `index:${index}`);
        sourceIds.push(id);
        rows.push(`[${role} @ ${index} | ${id}] ${clipBalanced(message?.mes || '', MAX_MESSAGE_CHARS)}`);
    }
    let text = rows.join('\n\n');
    if (text.length > MAX_EVIDENCE_CHARS) {
        // Preserve both ends of the exact source window rather than silently
        // biasing the semantic decision toward only the newest messages.
        text = clipBalanced(text, MAX_EVIDENCE_CHARS);
    }
    return { text, sourceIds };
}

function sceneProjection(context) {
    const scan = getSceneScannerSnapshot({ chatId: context?.chatId ?? null });
    const gate = getCurrentSceneChangeGate({ chatId: context?.chatId ?? null });
    return {
        scene: clone(scan?.acceptedScene || {}),
        previousScene: clone(scan?.previousScene || {}),
        sceneDelta: clone(scan?.delta || gate?.sceneDelta || {}),
        references: clone(scan?.references || {}),
        sceneMeta: {
            scanRevision: scan?.scanRevision || null,
            scannerSource: scan?.source || null,
            scannerReasoning: clip(scan?.reasoning || '', 1400),
            degraded: scan?.degraded === true,
            updatedAt: Number(scan?.updatedAt) || null,
        },
        change: gate ? {
            mode: gate.mode || null,
            reason: gate.reason || gate.reasoning || null,
            confidence: Number.isFinite(Number(gate.confidence)) ? Number(gate.confidence) : null,
            sceneRevision: gate.sceneRevision || null,
            signals: clone(gate.signals || []),
            hardSignals: clone(gate.hardSignals || []),
            softSignals: clone(gate.softSignals || []),
        } : {},
    };
}

function characterProjection(context, evidenceText, participants = [], references = {}) {
    const referenced = Array.isArray(references?.characters)
        ? references.characters.map(row => typeof row === 'string' ? row : row?.name)
        : [];
    const names = unique([...participants, ...referenced]);
    const lowerNames = names.map(value => value.toLocaleLowerCase());
    const configuredBanks = getCharacterBanks().filter(bank => bank?.enabled !== false);
    const banks = configuredBanks.filter(bank => {
        if (bank?.enabled === false) return false;
        const character = clean(bank?.character);
        const lowered = character.toLocaleLowerCase();
        return lowerNames.includes(lowered) || (character && evidenceText.toLocaleLowerCase().includes(lowered));
    }).slice(0, 8);
    const compactBanks = banks.map(bank => ({
        id: bank.id,
        character: bank.character,
        role: bank.role,
        state: bank.state || {},
        pendingStateProposals: (bank.stateProposals || []).filter(row => ['pending', 'staged', 'committing', 'recovery-required'].includes(String(row?.status || ''))).map(row => ({ field: row.field, status: row.status, proposedValue: row.proposedValue })).slice(0, 8),
    }));
    return {
        names,
        bankIds: banks.map(bank => bank.id),
        owners: {
            relevant: banks.slice(0, 12).map(bank => ({ bankId: bank.id, character: bank.character, role: bank.role })),
            configured: configuredBanks.slice(0, 32).map(bank => ({ bankId: bank.id, character: bank.character, role: bank.role })),
        },
        text: clip(JSON.stringify(compactBanks), MAX_CHARACTER_STATE_CHARS),
    };
}

function narrativeProjection() {
    const notebook = getNotebook();
    const memories = getActiveMemories().slice().sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)).slice(0, 6);
    return {
        notebook: clip(notebook?.text || '', MAX_NOTEBOOK_CHARS),
        summaryCoverage: clip(JSON.stringify(memories.map(memory => ({
            id: memory.id,
            layer: memory.layer,
            turnRange: memory.turnRange || null,
            topics: memory.topics || [],
            routeState: memory.routeState || 'unrouted',
            text: clip(memory.text || '', 260),
        }))), MAX_SUMMARY_STATE_CHARS),
    };
}

export function buildAutomaticPostTurnEvidenceContext({ context = getContext(), evaluationWindow = null } = {}) {
    const window = evaluationWindow || inspectPostTurnEvaluationWindow({ context });
    if (!(window?.pendingCount > 0) || !Number.isInteger(Number(window?.sourceStart)) || !Number.isInteger(Number(window?.targetIndex))) return null;
    const sourceStart = Number(window.sourceStart), targetIndex = Number(window.targetIndex);
    const rendered = renderedEvidenceWindow(context, sourceStart, targetIndex);
    const observed = sceneProjection(context);
    const participants = unique(observed.scene?.participants || []);
    const characters = characterProjection(context, rendered.text, participants, observed.references);
    const narrative = narrativeProjection();
    const retrieval = getRetrievalState();
    const routeContext = {
        sourceKind: 'post-turn',
        chatId: context?.chatId || null,
        chatRevision: context?.chat?.length || 0,
        sourceRange: [sourceStart, targetIndex],
        sourceIds: rendered.sourceIds,
        scene: observed.scene,
        previousScene: observed.previousScene,
        sceneMeta: observed.sceneMeta,
        change: { ...observed.change, sceneDelta: observed.sceneDelta },
        participants,
        references: observed.references,
        evidence: rendered.text,
        narrativeState: `NOTEBOOK\n${narrative.notebook || '(empty)'}\n\nRECENT SUMMARY COVERAGE\n${narrative.summaryCoverage || '(none)'}`,
        characterState: characters.text,
        characterStateOwners: characters.owners,
        canonicalHints: {
            canonicalLookupDeferredUntilDurableLore: true,
            activeInjectionRefs: (retrieval?.lastInjectedRefs || []).slice(0, 20).map(ref => ({ book: ref.book, uid: ref.uid })),
            activeInjectionContext: clip(retrieval?.lastInjectedText || '', 2600),
            reason: 'Existing foreground Retrieval output is reused read-only; broader canonical lookup is deferred until Durable Lore admission.',
        },
        pending: {
            pendingCount: window.pendingCount,
            ageAssistantTurns: window.ageAssistantTurns,
            budgetLimited: window.budgetLimited === true,
            remainingAfterWindow: Array.isArray(window.remainingPendingIndices) ? window.remainingPendingIndices.length : 0,
        },
        policy: {
            cadenceIsEligibilityOnly: true,
            automaticModeOnly: true,
            mutationAuthorityRemainsWithDestinationSubsystem: true,
            characterStateIsNotGenericLore: true,
        },
    };
    routeContext.sourceFingerprint = lifecycleEvidenceRouteFingerprint(routeContext);
    return { routeContext, window, characterBankIds: characters.bankIds, characterNames: characters.names };
}


/**
 * Add bounded, read-only canonical novelty context for Jev. This reuses the
 * existing deterministic Tree search index; it does not invoke Retrieval,
 * Sidecars, or any mutation surface. Active injection remains useful scene
 * context, while nearestCanonicalCandidates lets Jev distinguish genuinely new
 * canon from a cold lore card that simply is not injected in the current scene.
 */
async function enrichCanonicalHints(built) {
    if (!built?.routeContext) return built;
    const routeContext = built.routeContext;
    const refs = routeContext.references || {};
    const referenceNames = [
        ...(Array.isArray(refs.characters) ? refs.characters.map(row => typeof row === 'string' ? row : row?.name) : []),
        ...(Array.isArray(refs.locations) ? refs.locations.map(row => typeof row === 'string' ? row : row?.name) : []),
        ...(Array.isArray(refs.organizations) ? refs.organizations.map(row => typeof row === 'string' ? row : row?.name) : []),
        ...(Array.isArray(refs.items) ? refs.items.map(row => typeof row === 'string' ? row : row?.name) : []),
        ...(Array.isArray(refs.concepts) ? refs.concepts.map(row => typeof row === 'string' ? row : row?.name) : []),
    ];
    const query = [
        ...(routeContext.participants || []),
        ...referenceNames,
        clipBalanced(routeContext.evidence || '', 10000),
    ].map(clean).filter(Boolean).join(' ');
    try {
        const nearest = query
            ? await searchTree({ query, includeContent: true, limit: 8 })
            : [];
        routeContext.canonicalHints = {
            ...(routeContext.canonicalHints || {}),
            canonicalLookupDeferredUntilDurableLore: false,
            lookupStatus: 'ready',
            nearestCanonicalCandidates: nearest.map(row => ({
                book: row.book,
                uid: row.uid,
                title: row.title,
                path: Array.isArray(row.path) ? row.path.slice(0, 8) : [],
                keys: Array.isArray(row.keys) ? row.keys.slice(0, 12) : [],
                score: Number(row.score) || 0,
                content: clip(row.content || '', 700),
            })),
            reason: 'Read-only deterministic Tree search supplies bounded existing-canon candidates before Jev; broader catalog authority still belongs to the destination lore worker.',
        };
    } catch (error) {
        routeContext.canonicalHints = {
            ...(routeContext.canonicalHints || {}),
            canonicalLookupDeferredUntilDurableLore: true,
            lookupStatus: 'unavailable',
            lookupError: clean(error?.message || error).slice(0, 240),
            nearestCanonicalCandidates: [],
            reason: 'Canonical preflight lookup was unavailable; active foreground Retrieval hints remain read-only context and no mutation authority is implied.',
        };
    }
    routeContext.sourceFingerprint = lifecycleEvidenceRouteFingerprint(routeContext);
    return built;
}

async function currentPostTurnEvidenceFingerprint(expectedChatId = null) {
    const liveContext = getContext();
    if (expectedChatId != null && String(liveContext?.chatId || '') !== String(expectedChatId || '')) return null;
    const current = await enrichCanonicalHints(buildAutomaticPostTurnEvidenceContext({ context: liveContext }));
    return current?.routeContext?.sourceFingerprint || null;
}

async function postTurnEvidenceStillFresh(built) {
    if (!built?.routeContext?.sourceFingerprint) return false;
    const current = await currentPostTurnEvidenceFingerprint(built.routeContext.chatId);
    return Boolean(current && String(current) === String(built.routeContext.sourceFingerprint));
}

async function largeBacklogAdmission({ context, evaluationWindow }) {
    const settings = getSettings();
    const metrics = inspectPostTurnBacklogForAdmission({ context });
    const policy = settings.postTurn || {};
    const staleCount = Math.max(1, Number(policy.staleBacklogPendingCount) || 20);
    const staleAge = Math.max(1, Number(policy.staleBacklogAssistantTurns) || 20);
    const largeBacklog = metrics.pendingCount >= staleCount || metrics.ageAssistantTurns >= staleAge;
    if (!largeBacklog) return { action: 'CONTINUE', metrics, largeBacklog: false };
    const backlogAuthority = postTurnBacklogAuthoritySnapshot({ context });
    const rendered = renderedEvidenceWindow(context, Number(evaluationWindow?.sourceStart), Number(evaluationWindow?.targetIndex));
    const decisionContext = {
        task: 'post-turn',
        chatId: context?.chatId || null,
        chatRevision: context?.chat?.length || 0,
        metrics: { ...metrics, largeBacklog: true, stalePendingThreshold: staleCount, staleAgeThreshold: staleAge },
        evidence: rendered.text,
        policy: { cadenceIsEligibilityOnly: true, largeBacklogMustNotAutoDrain: true, dropStaleMeansDiscardHistoricalWork: true },
    };
    decisionContext.sourceFingerprint = lifecycleAdmissionFingerprint(decisionContext);
    decisionContext.readCurrentSourceFingerprint = () => {
        const liveContext = getContext();
        if (String(liveContext?.chatId || '') !== String(decisionContext.chatId || '')) return null;
        const liveWindow = inspectPostTurnEvaluationWindow({ context: liveContext });
        if (!(liveWindow?.pendingCount > 0)) return null;
        const liveMetrics = inspectPostTurnBacklogForAdmission({ context: liveContext });
        const liveLargeBacklog = liveMetrics.pendingCount >= staleCount || liveMetrics.ageAssistantTurns >= staleAge;
        const liveRendered = renderedEvidenceWindow(liveContext, Number(liveWindow?.sourceStart), Number(liveWindow?.targetIndex));
        return lifecycleAdmissionFingerprint({
            ...decisionContext,
            chatId: liveContext?.chatId || null,
            chatRevision: liveContext?.chat?.length || 0,
            metrics: { ...liveMetrics, largeBacklog: liveLargeBacklog, stalePendingThreshold: staleCount, staleAgeThreshold: staleAge },
            evidence: liveRendered.text,
        });
    };
    const decision = await evaluateLifecycleWorkAdmission(decisionContext).catch(error => ({ handled: false, reason: 'decision-error', error }));
    if (!decision?.handled) return { action: 'DEFER', metrics, largeBacklog: true, reason: decision?.reason || 'decision-unavailable', result: decision?.result || null, backlogAuthority };
    const currentFingerprint = await decisionContext.readCurrentSourceFingerprint();
    if (!currentFingerprint || String(currentFingerprint) !== String(decisionContext.sourceFingerprint)) {
        return { action: 'DEFER', handled: false, metrics, largeBacklog: true, reason: 'lifecycle-admission-source-changed', result: decision?.result || null, stale: true, backlogAuthority };
    }
    return { ...decision, metrics, largeBacklog: true, backlogAuthority };
}

function dispositionName(destinations = []) {
    if (destinations.includes(LIFECYCLE_DESTINATION.DURABLE_LORE)) return LIFECYCLE_DESTINATION.DURABLE_LORE;
    if (destinations.includes(LIFECYCLE_DESTINATION.CHARACTER_STATE)) return LIFECYCLE_DESTINATION.CHARACTER_STATE;
    if (destinations.includes(LIFECYCLE_DESTINATION.NARRATIVE_MEMORY)) return LIFECYCLE_DESTINATION.NARRATIVE_MEMORY;
    return LIFECYCLE_DESTINATION.NONE;
}

export function planLifecycleDispatch(destinations = []) {
    const narrativeMemory = destinations.includes(LIFECYCLE_DESTINATION.NARRATIVE_MEMORY);
    const characterState = destinations.includes(LIFECYCLE_DESTINATION.CHARACTER_STATE);
    const durableLore = destinations.includes(LIFECYCLE_DESTINATION.DURABLE_LORE);
    const serializeMutationDestinations = characterState && durableLore;
    return {
        narrativeMemory,
        characterStateNow: characterState,
        durableLoreNow: durableLore && !serializeMutationDestinations,
        durableLoreDeferred: durableLore && serializeMutationDestinations,
        serializeMutationDestinations,
    };
}


export function hasMatchingUncertainSummaryAssessment(memory, sourceFingerprint) {
    const prior = memory?.routeEvaluation || null;
    return !!(
        prior?.contractId === SUMMARY_DURABLE_ROUTING_SITE_ID &&
        prior?.disposition === 'uncertain-no-worker' &&
        String(prior?.sourceFingerprint || '') === String(sourceFingerprint || '')
    );
}


async function buildAutomaticSummaryDecisionContext(memory, context = getContext()) {
    const sourceVersion = memoryRecordVersion(memory);
    const characters = characterProjection(context, memory?.text || '', memory?.characters || [], { characters: [] });
    const query = [
        memory?.text || '',
        ...(memory?.characters || []),
        ...(memory?.locations || []),
        ...(memory?.topics || []),
        ...(memory?.threads || []),
    ].map(clean).filter(Boolean).join(' ');
    let canonicalHints;
    try {
        const nearest = query ? await searchTree({ query, includeContent: true, limit: 8 }) : [];
        canonicalHints = {
            lookupStatus: 'ready',
            nearestCanonicalCandidates: nearest.map(row => ({
                book: row.book,
                uid: row.uid,
                title: row.title,
                path: Array.isArray(row.path) ? row.path.slice(0, 8) : [],
                keys: Array.isArray(row.keys) ? row.keys.slice(0, 12) : [],
                score: Number(row.score) || 0,
                content: clip(row.content || '', 700),
            })),
            reason: 'Read-only deterministic Tree search compares the Summary against existing canon before any Lore Router worker is admitted.',
        };
    } catch (error) {
        canonicalHints = {
            lookupStatus: 'unavailable',
            nearestCanonicalCandidates: [],
            lookupError: clean(error?.message || error).slice(0, 240),
            reason: 'Canonical comparison lookup unavailable; this state grants no mutation authority.',
        };
    }
    const decisionContext = {
        record: memory,
        chatId: context?.chatId || '',
        sourceVersion,
        characterState: characters.text,
        characterStateOwners: characters.owners,
        canonicalHints,
    };
    decisionContext.sourceFingerprint = summaryDurableRoutingFingerprint(memory, {
        chatId: decisionContext.chatId,
        sourceVersion,
        characterState: decisionContext.characterState,
        characterStateOwners: decisionContext.characterStateOwners,
        canonicalHints,
    });
    return decisionContext;
}

/**
 * Automatic Summary-to-Lore admission wrapper. It does not change the Lore
 * Router worker: Jev decides whether that already-existing worker should be
 * invoked. Character State review and no-op routing settlement remain owned by
 * their existing subsystems.
 */
export async function runAutomaticLoreRoutingLifecycle({ cycleId = null, ids = null, maxPerCycle = null, enqueueSidecar = null, directorMeta = null, context = getContext() } = {}) {
    let memories = (Array.isArray(ids) && ids.length
        ? ids.map(getMemoryRecord)
        : getActiveMemories().filter(record => record?.routeState === 'unrouted' && !record?.promotedTo))
        .filter(Boolean)
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    const configured = Number(maxPerCycle ?? getSettings().memoryBank?.loreRouting?.maxPerCycle);
    if (Number.isFinite(configured) && configured > 0) memories = memories.slice(0, configured);
    const results = [];
    for (const memory of memories) {
        const sourceVersion = memoryRecordVersion(memory);
        const decisionContext = await buildAutomaticSummaryDecisionContext(memory, context);
        const priorRouteEvaluation = memory?.routeEvaluation || null;
        if (hasMatchingUncertainSummaryAssessment(memory, decisionContext?.sourceFingerprint)) {
            const row = {
                skipped: true,
                uncertain: true,
                cached: true,
                reason: 'summary-worthiness-uncertain-cached',
                classification: priorRouteEvaluation?.classification || LIFECYCLE_DESTINATION.NARRATIVE_MEMORY,
                evaluatedDestinations: [],
                memoryId: memory.id,
                routeStatePreserved: 'unrouted',
                loreWorkerLaunched: false,
                characterWorkerLaunched: false,
                routeEvaluation: clone(priorRouteEvaluation),
            };
            results.push(row);
            logEvent('lifecycle', 'automatic-summary-worthiness-uncertain-cached', {
                cycleId,
                memoryId: memory.id,
                sourceFingerprint: decisionContext.sourceFingerprint,
                evaluatedAt: priorRouteEvaluation?.evaluatedAt || 0,
                routeStatePreserved: 'unrouted',
                workerSkipped: true,
                jevSkipped: true,
            }, 'info');
            continue;
        }
        decisionContext.readCurrentSourceFingerprint = async () => {
            const live = getMemoryRecord(memory.id);
            if (!live) return null;
            const liveContext = getContext();
            if (String(liveContext?.chatId || '') !== String(decisionContext.chatId || '')) return null;
            const current = await buildAutomaticSummaryDecisionContext(live, liveContext);
            return current?.sourceFingerprint || null;
        };
        const decision = await evaluateSummaryDurableRoutingAssist(decisionContext).catch(error => ({ handled: false, reason: 'decision-error', error }));
        if (!decision?.handled) {
            const row = { deferred: true, reason: decision?.reason || 'summary-worthiness-decision-unavailable', memoryId: memory.id, decision };
            results.push(row);
            logEvent('lifecycle', 'automatic-summary-routing-deferred', { cycleId, memoryId: memory.id, reason: row.reason, workerSkipped: true }, 'warn');
            break;
        }
        const destinations = [];
        if (decision.character >= LIFECYCLE_ROUTE_THRESHOLD.characterState) destinations.push(LIFECYCLE_DESTINATION.CHARACTER_STATE);
        if (decision.lore >= LIFECYCLE_ROUTE_THRESHOLD.durableLore) destinations.push(LIFECYCLE_DESTINATION.DURABLE_LORE);
        const uncertainSummaryWorthiness = !destinations.length && (
            decision.character > SUMMARY_DURABLE_CONFIDENT_NO_MAX ||
            decision.lore > SUMMARY_DURABLE_CONFIDENT_NO_MAX
        );
        if (uncertainSummaryWorthiness) {
            let currentDecisionFingerprint = null;
            try {
                currentDecisionFingerprint = await decisionContext.readCurrentSourceFingerprint();
            } catch {}
            if (String(currentDecisionFingerprint || '') !== String(decisionContext.sourceFingerprint || '')) {
                const row = {
                    deferred: true,
                    uncertain: true,
                    stale: true,
                    reason: 'summary-worthiness-state-changed-before-assessment-settlement',
                    classification: LIFECYCLE_DESTINATION.NARRATIVE_MEMORY,
                    evaluatedDestinations: [],
                    memoryId: memory.id,
                    lifecycleDecision: decision,
                    routeStatePreserved: 'unrouted',
                    loreWorkerLaunched: false,
                    characterWorkerLaunched: false,
                };
                results.push(row);
                logEvent('lifecycle', 'automatic-summary-worthiness-uncertain-stale', {
                    cycleId,
                    memoryId: memory.id,
                    expectedFingerprint: decisionContext.sourceFingerprint,
                    currentFingerprint: currentDecisionFingerprint,
                    routeStatePreserved: 'unrouted',
                    workerSkipped: true,
                }, 'info');
                continue;
            }
            const routeEvaluation = {
                contractId: SUMMARY_DURABLE_ROUTING_SITE_ID,
                sourceFingerprint: decisionContext.sourceFingerprint,
                disposition: 'uncertain-no-worker',
                reason: 'summary-worthiness-uncertain',
                classification: LIFECYCLE_DESTINATION.NARRATIVE_MEMORY,
                scores: {
                    lore: decision.lore,
                    characterState: decision.character,
                    primarilyTemporary: decision.temporary,
                },
                evaluatedAt: Date.now(),
            };
            let assessmentPersisted = false;
            try {
                assessmentPersisted = !!(await setMemoryRouteEvaluation(memory.id, routeEvaluation, { expectedVersion: sourceVersion }));
            } catch (error) {
                const row = {
                    deferred: true,
                    uncertain: true,
                    reason: 'summary-worthiness-assessment-persistence-failed',
                    classification: LIFECYCLE_DESTINATION.NARRATIVE_MEMORY,
                    evaluatedDestinations: [],
                    memoryId: memory.id,
                    lifecycleDecision: decision,
                    routeStatePreserved: 'unrouted',
                    loreWorkerLaunched: false,
                    characterWorkerLaunched: false,
                    error: error?.message || String(error),
                };
                results.push(row);
                logEvent('lifecycle', 'automatic-summary-worthiness-uncertain-persist-failed', {
                    cycleId,
                    memoryId: memory.id,
                    error: row.error,
                    routeStatePreserved: 'unrouted',
                    workerSkipped: true,
                }, 'warn');
                continue;
            }
            const row = {
                skipped: true,
                uncertain: true,
                reason: 'summary-worthiness-uncertain',
                classification: LIFECYCLE_DESTINATION.NARRATIVE_MEMORY,
                evaluatedDestinations: [],
                memoryId: memory.id,
                lifecycleDecision: decision,
                routeStatePreserved: 'unrouted',
                loreWorkerLaunched: false,
                characterWorkerLaunched: false,
                assessmentPersisted,
                routeEvaluation,
            };
            results.push(row);
            logEvent('lifecycle', 'automatic-summary-worthiness-uncertain', {
                cycleId,
                memoryId: memory.id,
                lore: decision.lore,
                characterState: decision.character,
                primarilyTemporary: decision.temporary,
                sourceFingerprint: decisionContext.sourceFingerprint,
                assessmentPersisted,
                routeStatePreserved: 'unrouted',
                workerSkipped: true,
            }, 'info');
            continue;
        }
        const dispatch = planLifecycleDispatch(destinations);
        let characterReview = null;
        if (dispatch.characterStateNow) {
            try {
                characterReview = await reviewSummaryForCharacterState(memory.id, { runBatch: options => runLaneAModelWorkerBatch(options, enqueueSidecar) });
            } catch (error) {
                const row = { deferred: true, reason: 'character-state-review-failed', memoryId: memory.id, error: error?.message || String(error), decision };
                results.push(row);
                logEvent('lifecycle', 'automatic-summary-character-state-failed', { cycleId, memoryId: memory.id, error: row.error, workerSkipped: true }, 'error');
                break;
            }
        }
        // One source record must never be handed to two mutation-producing
        // workers in the same Automatic evaluation. Jev may correctly identify
        // both an owned Character State change and separate durable generic
        // canon in the same Summary. Character State gets first ownership;
        // the Summary intentionally remains unrouted so a later intelligence
        // pass can re-evaluate lore worthiness against the newly staged/current
        // Character State. No worker implementation is changed by this policy.
        if (dispatch.serializeMutationDestinations) {
            const row = {
                skipped: true,
                serialized: true,
                reason: 'mixed-evidence-character-state-first',
                classification: LIFECYCLE_DESTINATION.CHARACTER_STATE,
                evaluatedDestinations: destinations,
                memoryId: memory.id,
                lifecycleDecision: decision,
                characterReview,
                durableLoreDeferred: true,
                durableLoreDeferredTo: 'next-summary-lore-evaluation',
                routeStatePreserved: 'unrouted',
            };
            results.push(row);
            logEvent('lifecycle', 'automatic-summary-mixed-destination-serialized', {
                cycleId,
                memoryId: memory.id,
                destinations,
                worker: 'character-state-review',
                loreWorkerLaunched: false,
                routeStatePreserved: 'unrouted',
                durableLoreDeferredTo: row.durableLoreDeferredTo,
            }, 'info');
            continue;
        }
        if (dispatch.durableLoreNow) {
            const routed = await routeMemoryToLore(memory.id, {
                cycleId,
                manual: false,
                enqueueSidecar,
                directorMeta,
                expectedMemoryVersion: sourceVersion,
                expectedChatId: context?.chatId || null,
                automaticAuthority: {
                    canonicalHomeResolution: true,
                    allowedOperationTypes: ['remember', 'update'],
                    structuralMaintenanceAllowed: false,
                },
            });
            results.push({ ...routed, classification: LIFECYCLE_DESTINATION.DURABLE_LORE, evaluatedDestinations: destinations, lifecycleDecision: decision, characterReview });
            if (routed?.failed || routed?.deferred) break;
        } else {
            const classification = destinations.includes(LIFECYCLE_DESTINATION.CHARACTER_STATE)
                ? LIFECYCLE_DESTINATION.CHARACTER_STATE
                : LIFECYCLE_DESTINATION.NARRATIVE_MEMORY;
            const settled = await settleAutomaticLoreRoutingNoop(memory.id, { context, classification, expectedMemoryVersion: sourceVersion, expectedChatId: context?.chatId || null, decision: { ...decision, destinations, scores: { durableLore: decision.lore, characterState: decision.character, primarilyTransient: decision.temporary } } });
            results.push({ ...settled, classification, evaluatedDestinations: destinations, lifecycleDecision: decision, characterReview });
            if (settled?.failed || settled?.deferred) break;
        }
        logEvent('lifecycle', 'automatic-summary-classified', {
            cycleId,
            memoryId: memory.id,
            lore: decision.lore,
            characterState: decision.character,
            primarilyTemporary: decision.temporary,
            destinations,
            loreWorkerLaunched: destinations.includes(LIFECYCLE_DESTINATION.DURABLE_LORE),
        }, 'info');
    }
    return {
        count: results.length,
        results,
        failed: results.some(row => row?.failed),
        deferred: results.some(row => row?.deferred),
    };
}

/**
 * Shared Automatic-mode Post-turn lifecycle authority used by both the legacy
 * scheduler executor and the migrated Work Director executor.
 *
 * This function may route work to existing owners, but it owns no canonical
 * mutation path itself. Manual Post-turn remains outside this gate.
 */
export async function runAutomaticPostTurnLifecycle({ context = getContext(), cycleId = null, directorMeta = null, enqueueSidecar = null } = {}) {
    const evaluationWindow = inspectPostTurnEvaluationWindow({ context });
    if (!(evaluationWindow?.pendingCount > 0)) return { skipped: true, reason: 'nothing-pending', classification: LIFECYCLE_DESTINATION.NONE };
    const evaluationAuthority = postTurnEvaluationAuthoritySnapshot({ context, sourceStart: evaluationWindow.sourceStart, targetIndex: evaluationWindow.targetIndex });
    if (!evaluationAuthority) return { deferred: true, reason: 'evaluation-source-authority-unavailable', pendingPreserved: true };

    const admission = await largeBacklogAdmission({ context, evaluationWindow });
    if (admission.action === 'DROP_STALE') {
        const discarded = await discardPostTurnBacklog({ context, reason: 'jev-lifecycle-admission', rejectPending: true, expectedAuthority: admission.backlogAuthority || null });
        if (discarded?.discarded !== true) return { ...discarded, admission, deferred: true, classification: 'DROP_STALE', pendingPreserved: true };
        logEvent('lifecycle', 'automatic-disposition', { cycleId, classification: 'DROP_STALE', worker: 'discard-postturn-backlog', sourceRange: [evaluationWindow.sourceStart, evaluationWindow.targetIndex], discardedPending: discarded.discardedPending || 0 }, 'warn');
        return { ...discarded, admission, classification: 'DROP_STALE' };
    }
    if (admission.action === 'DEFER') return { deferred: true, reason: 'lifecycle-admission-unavailable-stale-backlog', admission, sourceRange: [evaluationWindow.sourceStart, evaluationWindow.targetIndex] };
    if (admission.action === 'SKIP') {
        const consumed = await consumePostTurnEvaluatedWindow({ context, sourceStart: evaluationWindow.sourceStart, targetIndex: evaluationWindow.targetIndex, reason: 'lifecycle-work-admission-skip', classification: LIFECYCLE_DESTINATION.NONE, expectedAuthority: evaluationAuthority });
        if (consumed?.consumed !== true) return { ...consumed, admission, skipped: true, deferred: true, classification: LIFECYCLE_DESTINATION.NONE, sourceRange: [evaluationWindow.sourceStart, evaluationWindow.targetIndex], pendingPreserved: true };
        return { ...consumed, admission, skipped: true, classification: LIFECYCLE_DESTINATION.NONE, sourceRange: [evaluationWindow.sourceStart, evaluationWindow.targetIndex] };
    }

    const built = await enrichCanonicalHints(buildAutomaticPostTurnEvidenceContext({ context, evaluationWindow }));
    if (!built) return { deferred: true, reason: 'evidence-window-unavailable' };
    built.routeContext.readCurrentSourceFingerprint = () => currentPostTurnEvidenceFingerprint(built.routeContext.chatId);
    const decision = await evaluateLifecycleEvidenceRoute(built.routeContext).catch(error => ({ handled: false, reason: 'decision-error', error }));
    if (!decision?.handled) {
        logEvent('lifecycle', 'automatic-evaluation-deferred', { cycleId, reason: decision?.reason || 'decision-unavailable', sourceRange: built.routeContext.sourceRange }, 'warn');
        return { deferred: true, reason: decision?.reason || 'lifecycle-evidence-decision-unavailable', decision, sourceRange: built.routeContext.sourceRange };
    }
    if (!(await postTurnEvidenceStillFresh(built))) {
        logEvent('lifecycle', 'automatic-evaluation-stale-before-route', { cycleId, sourceRange: built.routeContext.sourceRange, pendingPreserved: true }, 'info');
        return { deferred: true, stale: true, reason: 'lifecycle-evidence-changed-before-route', decision, sourceRange: built.routeContext.sourceRange };
    }

    const destinations = decision.destinations || [];
    const dispatch = planLifecycleDispatch(destinations);
    const classification = dispositionName(destinations);
    logEvent('lifecycle', 'automatic-classified', {
        cycleId,
        sourceRange: built.routeContext.sourceRange,
        classification,
        destinations,
        scores: decision.scores || null,
        primarilyTransient: decision.scores?.primarilyTransient ?? null,
        uncertainty: decision.uncertain || null,
    }, 'info');

    let characterReview = null;
    if (dispatch.characterStateNow) {
        try {
            const source = characterStateSourceFromChatRange({ context, sourceRange: built.routeContext.sourceRange, label: `Lifecycle ${built.routeContext.sourceRange[0]}-${built.routeContext.sourceRange[1]}` });
            characterReview = await reviewCharacterEvidence({
                source,
                text: built.routeContext.evidence,
                characters: built.characterNames,
                bankIds: built.characterBankIds.length ? built.characterBankIds : null,
                runBatch: options => runLaneAModelWorkerBatch(options, enqueueSidecar),
            });
        } catch (error) {
            logEvent('lifecycle', 'automatic-character-state-failed', { cycleId, sourceRange: built.routeContext.sourceRange, error: error?.message || String(error), pendingPreserved: true }, 'error');
            return { deferred: true, reason: 'character-state-review-failed', error: error?.message || String(error), decision, sourceRange: built.routeContext.sourceRange };
        }
    }

    // The exact Post-turn evidence window must not be interpreted by two
    // independent mutation-producing workers in the same Automatic pass.
    // When Jev identifies both destinations, Character State owns the urgent
    // pass. The exact Post-turn window is settled so it cannot repeat, while
    // normal Summary memory retains the chat evidence and may later route any
    // remaining generic durable canon after Character State ownership is known.
    if (dispatch.serializeMutationDestinations) {
        const consumed = await consumePostTurnEvaluatedWindow({
            context,
            sourceStart: built.routeContext.sourceRange[0],
            targetIndex: built.routeContext.sourceRange[1],
            reason: 'mixed-evidence-character-state-first',
            classification: LIFECYCLE_DESTINATION.CHARACTER_STATE,
            expectedAuthority: evaluationAuthority,
        });
        logEvent('lifecycle', 'automatic-mixed-destination-serialized', {
            cycleId,
            sourceRange: built.routeContext.sourceRange,
            destinations,
            worker: 'character-state-review',
            postTurnConsumed: consumed?.consumed === true,
            loreWorkerLaunched: false,
            durableLoreDeferredTo: 'summary-lore-evaluation',
            characterStateReviewed: characterReview?.reviewed || 0,
        }, 'info');
        if (consumed?.consumed !== true) return {
            ...consumed,
            deferred: true,
            skipped: true,
            classification: LIFECYCLE_DESTINATION.CHARACTER_STATE,
            evaluatedDestinations: destinations,
            decision,
            characterReview,
            durableLoreDeferred: true,
            durableLoreDeferredTo: 'summary-lore-evaluation',
            pendingPreserved: true,
        };
        return {
            ...consumed,
            skipped: true,
            serialized: true,
            classification: LIFECYCLE_DESTINATION.CHARACTER_STATE,
            evaluatedDestinations: destinations,
            decision,
            characterReview,
            durableLoreDeferred: true,
            durableLoreDeferredTo: 'summary-lore-evaluation',
            narrativeMemory: destinations.includes(LIFECYCLE_DESTINATION.NARRATIVE_MEMORY),
        };
    }

    if (dispatch.durableLoreNow) {
        // Jev already passed the full semantic freshness check above. From this
        // point forward only the exact admitted chat prefix is source authority;
        // a later generation or other derived lifecycle state must not make the
        // approved prefix repeat. The worker wrapper rechecks the same authority
        // again after acquiring its drain lease.
        if (!isPostTurnEvaluationAuthorityCurrent(evaluationAuthority, { context: getContext() })) {
            logEvent('lifecycle', 'automatic-durable-route-source-stale', { cycleId, sourceRange: built.routeContext.sourceRange, pendingPreserved: true }, 'info');
            return { deferred: true, stale: true, reason: 'lifecycle-source-changed-before-durable-worker', decision, sourceRange: built.routeContext.sourceRange, characterReview };
        }
        const result = await drainPostTurnEvaluatedWindow({ expectedSourceRange: built.routeContext.sourceRange, expectedAuthority: evaluationAuthority, force: false, enqueueSidecar, directorMeta, automaticAuthority: { canonicalHomeResolution: true, allowedOperationTypes: ['remember','update'], structuralMaintenanceAllowed: false } });
        logEvent('lifecycle', 'automatic-dispatched', { cycleId, sourceRange: built.routeContext.sourceRange, classification, worker: 'post-turn-durable-lore', operationCount: result?.operations || 0, stagedCount: result?.staged?.length || 0, characterStateReviewed: characterReview?.reviewed || 0 }, result?.failed ? 'error' : 'info');
        if (result?.skipped && !result?.consumed) return { ...result, deferred: true, reason: result.reason || 'durable-worker-did-not-settle', classification, destinations, decision, characterReview, pendingPreserved: true };
        return { ...result, classification, destinations, decision, characterReview };
    }

    const consumed = await consumePostTurnEvaluatedWindow({
        context,
        sourceStart: built.routeContext.sourceRange[0],
        targetIndex: built.routeContext.sourceRange[1],
        reason: destinations.includes(LIFECYCLE_DESTINATION.CHARACTER_STATE) ? 'character-state-owned' : destinations.includes(LIFECYCLE_DESTINATION.NARRATIVE_MEMORY) ? 'narrative-memory-only' : 'no-lifecycle-work',
        classification,
        expectedAuthority: evaluationAuthority,
    });
    logEvent('lifecycle', 'automatic-dispatched', { cycleId, sourceRange: built.routeContext.sourceRange, classification, worker: 'none', postTurnConsumed: consumed.consumed === true, narrativeMemory: destinations.includes(LIFECYCLE_DESTINATION.NARRATIVE_MEMORY), characterStateReviewed: characterReview?.reviewed || 0 }, 'info');
    if (consumed?.consumed !== true) return { ...consumed, deferred: true, skipped: true, classification, destinations, decision, characterReview, narrativeMemory: destinations.includes(LIFECYCLE_DESTINATION.NARRATIVE_MEMORY), pendingPreserved: true };
    return { ...consumed, skipped: true, classification, destinations, decision, characterReview, narrativeMemory: destinations.includes(LIFECYCLE_DESTINATION.NARRATIVE_MEMORY) };
}
