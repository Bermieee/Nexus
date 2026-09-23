import { getContext } from '../../../../st-context.js';
import { getSettings, getSidecarProfile } from '../core/settings.js';
import { getActiveBooks } from '../lore/active-books.js';
import { captureLoreCorpus } from '../lore/corpus-authority.js';
import { loadBook, findEntryByUid } from '../lore/store.js';
import { getTree } from '../tree/store.js';
import { findNode } from '../tree/model.js';
import { resolveCurrentTreeRef } from '../tree/ref-resolver.js';
import { logEvent, recordWarmInjectionUtilization } from '../observability/telemetry.js';
import { estimateContentTokens, resolveMainModelHint, resolveMainProviderHint } from '../observability/token-estimator.js';
import { canonicalLorePresentation, observeLorePresentationCache, planLorePresentationCache, sameLorePresentationMembership } from './presentation-cache-analysis.js';
import { enqueueBusBatch, canDispatchSidecarWork, BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { enqueueNexusModelWorkerJob } from '../nexus/model-worker-bus.js';
import { disableSidecarAfterRepeatedTimeout } from '../sidecar/router.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import { isSchemaPlaceholder, validateRetrievalRefPayload } from '../sidecar/semantic-validation.js';
import {
    buildOpaqueInjectionRefCatalog,
    candidateKey,
    emptyReplacementDisposition,
    isNarrativeSceneMessage,
    tailNarrativeSceneMessages,
    mergeInjectionSliceSelections,
    missingRequiredCandidates,
    normalizeExactCandidateEntryRefs,
    resolveOpaqueInjectionRefs,
    selectRequestedCandidates,
    shouldCondenseInjectionGather,
    treeCoreCandidates,
    validateAuthoritativeSelection,
    validateOpaqueInjectionSelection,
} from './handoff-policy.js';
import {
    formatRegionOverview,
    formatSelectedRegionOverview,
    resolveNodeEntries,
    validateTreeRefs,
    dedupeEntryRefs,
    buildTreeEntryIndex,
    searchTree,
    topRegionRefForNode,
    listRegionDecisionCandidates,
    listNodeDecisionCandidates,
} from './search-engine.js';
import { RETRIEVAL_CHANGE, applyContextDriftToRetrievalChange, applyReuseFreshness, buildChangeWorkPlan, consumeSceneChangeGateForRetrieval, acknowledgeSceneChangeGateRetrievalExecution } from './change-gate.js';
import { ensureSceneAuthority } from '../scene/runtime.js';
import { getSceneScannerSnapshot } from '../scene/scanner.js';
import { RETRIEVAL_EXECUTION, planRetrievalExecution } from './execution-plan.js';
import { buildRetrievalReusePlan } from './reuse-plan.js';
import { buildOverviewBatches, batchTokenSummary } from './batching.js';
import { getRetrievalState, hasReusableInjection, rememberSuccessfulRetrieval, clearRetrievalState, dedupeTreeRefs, getPendingWarmContextRefresh, acknowledgeWarmContextRefresh } from './state.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh } from '../nexus/work-scope.js';
import { isIntentionalCancellation } from '../core/cancellation.js';
import {
    getPinnedRefs,
    getManualPinnedRefs,
    getPinnedNodeRefs,
    getWarmCandidates,
    getWarmReuseAuthorityRefs,
    getWarmNodeRefs,
    pinActiveInjection,
    preWarmSmartContext,
} from '../smart-context/warmer.js';

import { prepareLorePaging, markLorePagingUsed, loreEntryResidencyStatus } from '../paging/lore-runtime.js';
import { clearRetrievalPrompt, applyRetrievalPrompt } from './prompt-bridge.js';
import { buildCandidateShadowFingerprint, evaluateRetrievalTreeAdmissionAssist, buildTreeAdmissionFingerprint, evaluateRetrievalCandidateAdmissionAssist } from './decision-sites.js';
import { recordRetrievalCandidateDiagnostics, recordRetrievalPublicationDiagnostics } from './diagnostics.js';
import { resolveNexusSidecarResourcePolicy } from '../nexus/resource-policy.js';
import { currentNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';
import { resolvePromptLoaderAdapter, resolvePromptLoaderLoreOrderPolicy } from '../nexus/prompt-loader-adapters.js';

// Retrieval is an exact JSON selection task, not creative RP.  These bounds
// keep a high-quality reasoning model from spending minutes on internal
// deliberation while preserving a generous window for large Tree slices.
const TREE_SELECTION_REASONING_EFFORT = 'medium';
const INJECTION_SELECTION_REASONING_EFFORT = 'low';
const SELECTION_MAX_TOKENS = 4096;
let retrievalWorkerBatchSeq = 0;

function enqueueRetrievalWorkerJob(stage, options = {}) {
    // Generation-scoped retrieval is on the foreground deadline.  A+B
    // parallel/consensus execution is a throughput/quality shape, not a
    // correctness requirement, and can consume the entire preflight window
    // before required lore retrieval reaches publication.  Use one adaptive
    // worker with provider/slot fallback for this critical path; background
    // and non-generation-scoped work may still honor the configured mode.
    const deadlineCritical = options.foregroundAdjacent !== false && options.nexusScope?.generationId != null;
    return enqueueNexusModelWorkerJob('reasoning', stage, {
        ...options,
        role: options.role || 'retrieval',
        mainPreferred: false,
        mainEligible: options.mainEligible !== false,
        foregroundAdjacent: options.foregroundAdjacent !== false,
        executionMode: deadlineCritical ? 'adaptive' : options.executionMode,
        telemetry: {
            ...(options.telemetry || {}),
            ...(deadlineCritical ? {
                foregroundDeadlineCritical: true,
                configuredExecutionMode: getSettings()?.routing?.modes?.retrieval || 'adaptive',
            } : {}),
        },
    });
}

function enqueueRetrievalWorkerBatch(stage, requests = [], common = {}) {
    if (canDispatchSidecarWork(stage, { role: common.role || 'retrieval' })) return enqueueBusBatch(stage, requests, common);
    const id = `nexus_retrieval_worker_batch_${Date.now()}_${++retrievalWorkerBatchSeq}`;
    let cancelled = false, cancelReason = null, active = null;
    const handle = {
        id, jobId:id, state:'queued', error:null,
        cancel(reason='Nexus retrieval worker batch cancelled.') {
            if (['completed','failed','cancelled'].includes(handle.state)) return false;
            cancelled = true; cancelReason = reason instanceof Error ? reason : new Error(String(reason));
            handle.state='cancelled'; handle.error=cancelReason;
            try { active?.cancel?.(cancelReason); } catch {}
            return true;
        },
        promise:null,
    };
    handle.promise=(async()=>{
        handle.state='executing';
        const batches=[],failures=[],slots=[];
        for(let index=0;index<requests.length;index+=1){
            if(cancelled) throw cancelReason;
            const request=requests[index]||{};
            const merged={...common,...request,telemetry:{...(common.telemetry||{}),...(request.telemetry||{}),mainOnlyBatchFallback:true,batchIndex:index,batchCount:requests.length}};
            delete merged.allowPartial;
            active=enqueueRetrievalWorkerJob(stage,merged);
            try{
                const response=await active.promise;
                const slot=response?.tv2?.slot||null; if(slot&&!slots.includes(slot))slots.push(slot);
                batches.push({index,batchNumber:index+1,response,batch:request,slot});
            }catch(error){
                if(isIntentionalCancellation(error)) throw error;
                failures.push({index,batchNumber:index+1,error,batch:request,slot:null,reason:error?.message||String(error)});
                if(common.allowPartial===false) throw error;
            }finally{ active=null; }
        }
        return {batches,failures,tv2:{slotsUsed:slots,degraded:failures.length>0,mainOnlyBatchFallback:true}};
    })().then(value=>{if(handle.state!=='cancelled')handle.state='completed';return value;},error=>{if(handle.state!=='cancelled')handle.state='failed';handle.error=error;throw error;});
    return handle;
}

function recentChat(maxMessages, sourceChat = null) {
    const chat = Array.isArray(sourceChat)?sourceChat:(getContext()?.chat || []);
    return tailNarrativeSceneMessages(chat, Math.max(1, Number(maxMessages) || 10))
        .map(m => `[${m.is_user ? 'User' : 'Assistant'}]: ${String(m.mes || '')}`)
        .join('\n\n');
}

function tailText(value, limit) {
    const chars = Array.from(String(value || ''));
    return chars.length > limit ? `…${chars.slice(-limit).join('')}` : chars.join('');
}

function headText(value, limit) {
    const chars = Array.from(String(value || ''));
    return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('');
}

function stableStringCompare(left, right) {
    const a = String(left ?? '').normalize('NFKC');
    const b = String(right ?? '').normalize('NFKC');
    return a < b ? -1 : a > b ? 1 : 0;
}

function headTailText(value, headLimit = 900, tailLimit = 3200) {
    const chars = Array.from(String(value || ''));
    if (chars.length <= headLimit + tailLimit + 32) return chars.join('');
    return `${chars.slice(0, headLimit).join('')}\n… [middle omitted] …\n${chars.slice(-tailLimit).join('')}`;
}

function immediateSceneChat(maxMessages = 4, sourceChat = null) {
    const chat = tailNarrativeSceneMessages(Array.isArray(sourceChat)?sourceChat:(getContext()?.chat || []), 3);
    if (!chat.length) return '';
    const latest = chat[chat.length - 1];
    const previous = chat.length > 1 ? chat[chat.length - 2] : null;
    const older = chat.length > 2 ? chat[chat.length - 3] : null;
    const rows = [];
    if (older && Number(maxMessages) > 2) rows.push(`[${older.is_user ? 'User' : 'Assistant'} · PRIOR]: ${tailText(older.mes, 900)}`);
    if (previous) rows.push(`[${previous.is_user ? 'User' : 'Assistant'} · PREVIOUS BEAT]: ${previous.is_user ? tailText(previous.mes, 2400) : headTailText(previous.mes, 900, 3400)}`);
    rows.push(`[${latest.is_user ? 'User' : 'Assistant'} · CURRENT]: ${tailText(latest.mes, latest.is_user ? 3200 : 4200)}`);
    return rows.join('\n\n');
}

function hydrationEligibleMessage(message) {
    if (!isNarrativeSceneMessage(message)) return false;
    if (message?.is_system === true || message?.isSystem === true) return false;
    if (message?.rejected === true || message?.is_rejected === true || message?.isRejected === true) return false;
    if (message?.incomplete === true || message?.is_incomplete === true || message?.isIncomplete === true) return false;
    if (message?.failed === true || message?.is_failed === true || message?.isFailed === true) return false;
    if (message?.transportOnly === true || message?.transport_only === true) return false;
    return String(message?.mes || '').trim().length > 0;
}

function hasLocalSceneContext(limit = 10, sourceChat = null) {
    const chat = Array.isArray(sourceChat) ? sourceChat : (getContext()?.chat || []);
    return chat.filter(hydrationEligibleMessage).slice(-Math.max(1, Number(limit) || 10)).length > 0;
}

function parseJson(input, label = 'Sidecar', validator = null) {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        if (!validator) return input;
        const verdict = validator(input);
        if (verdict?.valid) return verdict.value ?? input;
    }
    return parseStructuredJsonCandidate(String(input || ''), { validator, label });
}


function treeKey(book, nodeId) { return JSON.stringify([String(book),String(nodeId)]); }

function identitySignature(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    let hash = 1469598103934665603n;
    for (let i = 0; i < text.length; i++) {
        hash ^= BigInt(text.charCodeAt(i));
        hash = BigInt.asUintN(64, hash * 1099511628211n);
    }
    return `${text.length}:${hash.toString(36)}`;
}

function effectiveSidecarSlot(settings, route = 'retrieval') {
    const lock = String(settings?.routing?.locks?.[route] || '').toUpperCase();
    if (lock === 'A' || lock === 'B') return lock;
    const preferred = String(settings?.routing?.[route] || settings?.routing?.retrieval || 'A').toUpperCase();
    return preferred === 'B' ? 'B' : 'A';
}
function effectiveSidecarModel(settings, route = 'retrieval') {
    return getSidecarProfile(effectiveSidecarSlot(settings, route))?.model || '';
}

function anchorKind(title = '') {
    const value = String(title || '').normalize('NFKC');
    if (/(?:^|[^\p{L}\p{N}])(?:relationship|relationships|dynamic|bond|marriage|relaci[oó]n|relaciones|din[aá]mica|v[ií]nculo|matrimonio|beziehung|bindung|ehe|relation|lien|mariage)(?=$|[^\p{L}\p{N}])|関係|絆|婚姻|关系|關係|羁绊|羈絆/iu.test(value)) return 'relationship';
    if (/(?:^|[^\p{L}\p{N}])(?:personality|demeanor|presence|voice|personalidad|car[aá]cter|presencia|voz|pers[oö]nlichkeit|auftreten|stimme|personnalit[eé]|caract[eè]re|pr[eé]sence|voix)(?=$|[^\p{L}\p{N}])|性格|人柄|存在感|声|個性|声音/iu.test(value)) return 'personality';
    if (/(?:^|[^\p{L}\p{N}])(?:identity|role|divine|identidad|rol|divin[oa]|identit[aä]t|rolle|g[oö]ttlich|identit[eé]|r[oô]le|divin)(?=$|[^\p{L}\p{N}])|身分|役割|神性|身份|角色/iu.test(value)) return 'identity';
    return '';
}
function anchorScore(title = '') {
    const kind = anchorKind(title);
    return kind === 'relationship' ? 30 : kind === 'personality' ? 25 : kind === 'identity' ? 20 : 0;
}

function characterNameForTitle(title = '') {
    const cleaned = String(title || '').trim();
    if (!cleaned || !anchorKind(cleaned)) return '';
    // Tight conventional titles handle one-character and non-Latin names.
    const tight = cleaned.match(/^(.{1,64}?)(?:\s+(?:[-:—–])\s*|\s*[:—–]\s*|\s+\()/u);
    if (tight?.[1]) return String(tight[1]).trim();
    // Compatibility fallback for older cards such as "Character Relationships".
    const markerPattern = /(?:^|[^\p{L}\p{N}])(?:relationship|relationships|dynamic|bond|marriage|relaci[oó]n|relaciones|din[aá]mica|v[ií]nculo|matrimonio|beziehung|bindung|ehe|relation|lien|mariage|personality|demeanor|presence|voice|personalidad|car[aá]cter|presencia|voz|pers[oö]nlichkeit|auftreten|stimme|personnalit[eé]|caract[eè]re|pr[eé]sence|voix|identity|role|divine|identidad|rol|divin[oa]|identit[aä]t|rolle|g[oö]ttlich|identit[eé]|r[oô]le|divin)(?=$|[^\p{L}\p{N}])|関係|絆|婚姻|关系|關係|羁绊|羈絆|性格|人柄|存在感|声|個性|声音|身分|役割|神性|身份|角色/iu;
    const match = markerPattern.exec(cleaned);
    if (!match || match.index < 1) return '';
    const marker = match.index + (/^[^\p{L}\p{N}]/u.test(match[0]) ? 1 : 0);
    return cleaned.slice(0, marker).replace(/[\s:—–-]+$/u, '').replace(/\($/, '').trim().slice(0, 64);
}

function participantBaseName(item) { return String(item?.displayName || item?.name || '').trim(); }
function boundedNameMention(value, name) {
    const hay=String(value||'').normalize('NFKC').toLocaleLowerCase();
    const needle=String(name||'').normalize('NFKC').toLocaleLowerCase();
    if(!needle)return false;
    let from=0;
    while(from<=hay.length-needle.length){
        const at=hay.indexOf(needle,from);if(at<0)return false;
        const before=at>0?hay[at-1]:'';const after=at+needle.length<hay.length?hay[at+needle.length]:'';
        if((!before||!/[\p{L}\p{N}]/u.test(before))&&(!after||!/[\p{L}\p{N}]/u.test(after)))return true;
        from=at+Math.max(1,needle.length);
    }
    return false;
}
function relationshipRowMentions(row, counterpart) {
    return boundedNameMention(`${row?.title||''} ${(row?.keys||[]).join(' ')} ${row?.content||''}`, counterpart);
}

function buildCharacterAnchorCatalog(index = []) {
    const raw = new Map();
    for (const row of index) {
        const baseName = characterNameForTitle(row.title);
        const kind = anchorKind(row.title);
        if (!baseName || !kind) continue;
        const key = `${String(row.book||'')}\u0000${baseName.toLocaleLowerCase()}`;
        if (!raw.has(key)) raw.set(key, { displayName:baseName, book:String(row.book||''), rows: [] });
        raw.get(key).rows.push({ ...row, anchorKind: kind });
    }
    const items=[...raw.values()];
    const counts=new Map();
    for(const item of items){const key=item.displayName.toLocaleLowerCase();counts.set(key,(counts.get(key)||0)+1);}
    return items.map(item => ({
        ...item,
        name:(counts.get(item.displayName.toLocaleLowerCase())||0)>1?`${item.displayName} [${item.book}]`:item.displayName,
        rows:item.rows.sort((a,b)=>anchorScore(b.title)-anchorScore(a.title)||(String(a.title).normalize('NFKC')<String(b.title).normalize('NFKC')?-1:String(a.title).normalize('NFKC')>String(b.title).normalize('NFKC')?1:0)||(String(a.book).normalize('NFKC')<String(b.book).normalize('NFKC')?-1:String(a.book).normalize('NFKC')>String(b.book).normalize('NFKC')?1:0)||Number(a.uid)-Number(b.uid)),
    })).sort((a,b)=>String(a.name).normalize('NFKC')<String(b.name).normalize('NFKC')?-1:String(a.name).normalize('NFKC')>String(b.name).normalize('NFKC')?1:0);
}

function resolveSceneCatalogParticipants(catalog = [], activeCharacters = []) {
    const wanted = (Array.isArray(activeCharacters) ? activeCharacters : [])
        .map((name, index) => ({ name:String(name || '').trim(), key:String(name || '').trim().toLocaleLowerCase(), index }))
        .filter(row => row.key);
    const matched = [];
    const used = new Set();
    for (const requested of wanted) {
        const candidates = (catalog || []).filter(item => {
            const exact = String(item?.name || '').trim().toLocaleLowerCase();
            const visible = participantBaseName(item).toLocaleLowerCase();
            return exact === requested.key || visible === requested.key;
        });
        const item = candidates[0];
        if (!item) continue;
        const key = `${item.book}\u0000${String(item.name || '').toLocaleLowerCase()}`;
        if (used.has(key)) continue;
        used.add(key);
        matched.push({ item, order:requested.index });
    }
    return matched.sort((a,b)=>a.order-b.order).map(row=>row.item);
}

/**
 * Scene anchors consume the authoritative Scene Scanner participant set. They
 * no longer launch an independent participant-model call and therefore cannot
 * disagree with the scene topology that Change Gate and Character Banks use.
 */
async function deriveSceneAnchorCandidates({ activeCharacters = [], relationshipFocus = false, books = [], gate = null, scope = null } = {}) {
    let catalog=[];
    try {
        const index = await buildTreeEntryIndex({ books });
        if (scope && !isNexusWorkScopeFresh(scope,getContext())) return { anchors:[], degraded:false, stale:true };
        catalog = buildCharacterAnchorCatalog(index);
    } catch (error) {
        if (isIntentionalCancellation(error)) throw error;
        logEvent('retrieval','scene-anchor-catalog-failed',{gate,error},'warn');
        return { anchors:[], degraded:true, reason:'scene-anchor-catalog-failed' };
    }
    const activeCatalog = resolveSceneCatalogParticipants(catalog, activeCharacters);
    const effectiveCloseDyad = relationshipFocus === true && activeCatalog.length === 2;
    const anchors = [];
    for (const item of activeCatalog) {
        const added = new Set();
        const counterpart = effectiveCloseDyad ? activeCatalog.find(other=>other!==item) : null;
        const counterpartName = participantBaseName(counterpart);
        const relationshipRows = item.rows.filter(row=>row.anchorKind==='relationship');
        const specificRelationshipRows = counterpartName ? relationshipRows.filter(row=>relationshipRowMentions(row,counterpartName)) : [];
        for (const row of item.rows) {
            const kind = row.anchorKind;
            if (added.has(kind)) continue;
            if ((kind === 'identity' || kind === 'personality') && (added.has('identity') || added.has('personality'))) continue;
            if (kind === 'relationship') {
                if (!effectiveCloseDyad) continue;
                if (!counterpartName || !specificRelationshipRows.includes(row)) continue;
            }
            added.add(kind);
            anchors.push({ ...row, sceneAnchor:true, anchorCharacter:participantBaseName(item), anchorParticipantRef:item.name, anchorKind:kind });
        }
    }
    const resolved = dedupeEntryRefs(anchors).slice(0,12);
    const unresolved = (Array.isArray(activeCharacters)?activeCharacters:[]).filter(name=>!activeCatalog.some(item=>participantBaseName(item).toLocaleLowerCase()===String(name||'').trim().toLocaleLowerCase()||String(item.name||'').trim().toLocaleLowerCase()===String(name||'').trim().toLocaleLowerCase()));
    logEvent('retrieval','scene-participants-resolved',{
        gate,source:'scene-scanner',activeCharacters:activeCatalog.map(item=>item.name),unresolvedCharacters:unresolved,
        closeDyad:effectiveCloseDyad,relationshipFocus:relationshipFocus===true,anchorCount:resolved.length,
    },'info');
    return { anchors:resolved, degraded:false, unresolvedCharacters:unresolved };
}


function batchTargetInputTokens(settings, capability = 'regionScan') {
    const configured = Math.max(256, Number(settings?.retrieval?.batchTargetInputTokens) || 6000);
    const lock = String(settings?.routing?.locks?.retrieval || '').toUpperCase();
    const slots = lock === 'A' || lock === 'B' ? [lock] : ['A', 'B'];
    const budgets = slots.map(slot => getSidecarProfile(slot))
        .filter(profile => profile?.enabled && profile?.capabilities?.[capability] !== false)
        .map(profile => Number(profile?.inputBudgetTokens))
        .filter(value => Number.isFinite(value) && value > 0);
    if (!budgets.length) return configured;
    return Math.max(256, Math.min(configured, Math.floor(Math.min(...budgets) * 0.88)));
}

function retrievalBatchingAllowed(settings) {
    // Executor preference and physical packing are separate contracts.
    return settings?.retrieval?.batchFireEnabled !== false;
}

function batchActivationThreshold(settings, targetInputTokens) {
    const configured = Number(settings?.retrieval?.batchActivationInputTokens);
    const target=Math.max(1200,Number(targetInputTokens)||6000);
    if (Number.isFinite(configured) && configured > 0) return Math.min(target,Math.max(1200, configured));
    return target;
}

function batchCondenseMinCandidates(settings) {
    const value = Number(settings?.retrieval?.batchCondenseMinCandidates);
    return Number.isFinite(value) && value > 1 ? Math.floor(value) : 5;
}

function shouldBatchReroute(error, settings) {
    if (settings?.retrieval?.batchRerouteOnFailure === false) return false;
    const text = `${error?.name || ''} ${error?.message || ''} ${error?.code || ''}`.toLowerCase();
    return /timeout|timed out|abort|context|token|too large|payload|413/.test(text);
}

function injectionBatchTargetInputTokens(settings) {
    const configured = Math.max(1200, Number(settings?.retrieval?.batchTargetInputTokens) || 6000);
    const lock = String(settings?.routing?.locks?.loreInjection || '').toUpperCase();
    const slots = lock === 'A' || lock === 'B' ? [lock] : ['A', 'B'];
    const budgets = slots.map(slot => getSidecarProfile(slot))
        .filter(profile => profile?.enabled && profile?.capabilities?.loreInjection !== false)
        .map(profile => Number(profile?.inputBudgetTokens))
        .filter(value => Number.isFinite(value) && value > 0);
    return budgets.length ? Math.max(1200, Math.min(configured, Math.floor(Math.min(...budgets) * 0.88))) : configured;
}

function condensationSoftInputTarget(settings, { role = 'retrieval', stage = BUS_STAGE.LORE_INJECTION } = {}) {
    const resolved = resolveNexusSidecarResourcePolicy({ role, stage, settings: settings || {} });
    return Math.max(1200, Number(resolved?.softInputTargetTokens) || 20000);
}

function splitOversizedInjectionCandidate(candidate, buildPrompt, targetInputTokens, model = '') {
    const target = Math.max(1200, Number(targetInputTokens) || 6000);
    if (estimateContentTokens(buildPrompt([candidate]), model) <= target) return [candidate];
    const content = String(candidate?.content || '');
    const safeTarget = Math.max(1000, Math.floor(target * 0.94));
    const emptyProbe = { ...candidate, content: '', _physicalFragment: true, _physicalChunkIndex: 0, _physicalChunkCount: 1 };
    if (estimateContentTokens(buildPrompt([emptyProbe]), model) >= safeTarget) {
        const error = new Error('Lore candidate metadata exceeds the physical Sidecar review budget; no safe content slice can be dispatched.');
        error.name = 'TV2InjectionPhysicalCapacityError';
        error.targetInputTokens = target;
        throw error;
    }
    const raw = [];
    let offset = 0;
    while (offset < content.length) {
        let low = 1;
        let high = content.length - offset;
        let best = 0;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const probe = { ...candidate, content: content.slice(offset, offset + mid), _physicalFragment: true, _physicalChunkIndex: raw.length, _physicalChunkCount: 999 };
            if (estimateContentTokens(buildPrompt([probe]), model) <= safeTarget) {
                best = mid;
                low = mid + 1;
            } else high = mid - 1;
        }
        if (best <= 0) {
            const error = new Error('Lore candidate could not be reshaped below the physical Sidecar review budget.');
            error.name = 'TV2InjectionPhysicalCapacityError';
            error.targetInputTokens = target;
            throw error;
        }
        let take = best;
        if (best > 900) {
            const window = content.slice(offset, offset + best);
            const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
            if (boundary >= Math.floor(best * 0.68)) take = boundary + (window.slice(boundary, boundary + 2) === '\n\n' ? 2 : 1);
        }
        raw.push(content.slice(offset, offset + take));
        offset += take;
    }
    const count = raw.length;
    return raw.map((fragment, index) => ({
        ...candidate,
        content: fragment,
        _physicalFragment: true,
        _physicalChunkIndex: index,
        _physicalChunkCount: count,
    }));
}

function buildInjectionCandidateBatches(candidates, buildPrompt, targetInputTokens, model = '') {
    const target = Math.max(1200, Number(targetInputTokens) || 6000);
    // Physical slicing changes only the Sidecar review representation. Every
    // fragment retains the same canonical (book, uid), and final validation
    // resolves a selected fragment back to the complete live lore entry.
    const physicalCandidates = [];
    for (const candidate of candidates || []) {
        physicalCandidates.push(...splitOversizedInjectionCandidate(candidate, buildPrompt, target, model));
    }
    const batches = [];
    let current = [];
    const flush = () => {
        if (!current.length) return;
        const prompt = buildPrompt(current);
        batches.push({ candidates: current, prompt, estimatedInputTokens: estimateContentTokens(prompt, model) });
        current = [];
    };
    for (const candidate of physicalCandidates) {
        const trial = [...current, candidate];
        const tokens = estimateContentTokens(buildPrompt(trial), model);
        if (current.length && tokens > target) {
            flush();
            current = [candidate];
        } else current = trial;
    }
    flush();
    return batches;
}

function timeoutFailures(result = {}) {
    return (result?.failures || []).filter(row => row?.error?.name === 'TV2SidecarTimeout');
}

async function retryTimedOutOverviewSlices({
    stage, failed = [], buildPrompt, model, label, systemPrompt, priority, telemetry, kind,
    targetInputTokens, parentJobId, scope = null,
} = {}) {
    const recovered = [];
    const unresolvedFailures = [];
    const repeatedTimeouts = [];
    for (const failedRow of failed) {
        const original = failedRow?.batch;
        if (!original?.treeText) {
            unresolvedFailures.push({ ...failedRow, recoveryReason: 'missing-source-slice' });
            continue;
        }
        const retryTarget = Math.max(700, Math.floor(Math.min(targetInputTokens, Number(original.estimatedInputTokens) || targetInputTokens) / 2));
        const retryBatches = buildOverviewBatches({ overview: original.treeText, buildPrompt, targetInputTokens: retryTarget, model });
        if (retryBatches.length < 2) {
            logEvent('retrieval', 'batch-timeout-recovery-unavailable', { parentJobId, failedSlot: failedRow.slot, retryTarget, reason: 'slice-cannot-split' }, 'error');
            unresolvedFailures.push({ ...failedRow, recoveryReason: 'slice-cannot-split' });
            continue;
        }
        logEvent('retrieval', 'batch-timeout-slice-recovery', {
            parentJobId, failedSlot: failedRow.slot, originalEstimatedInputTokens: original.estimatedInputTokens,
            retryTarget, retryBatchCount: retryBatches.length,
        }, 'warn');
        const parent = enqueueRetrievalWorkerBatch(stage, retryBatches.map((batch, index) => ({
            prompt: batch.prompt, systemPrompt, responseFormat: 'json_object', excludeReasoning: true,
            structuredValidator: treeSelectionValidator(kind, batch.treeText), reasoningEffort: TREE_SELECTION_REASONING_EFFORT,
            maxTokens: SELECTION_MAX_TOKENS,
            label: `${label} · timeout recovery ${index + 1}/${retryBatches.length}`,
            telemetry: { ...telemetry, timeoutRecovery: true, timeoutRecoveryFromSlot: failedRow.slot, estimatedBatchInputTokens: batch.estimatedInputTokens },
        })), {
            systemPrompt, reasoningEffort: TREE_SELECTION_REASONING_EFFORT, maxTokens: SELECTION_MAX_TOKENS,
            priority, foregroundAdjacent: true, preemptible: false,
            label: `${label} · smaller-slice recovery`, telemetry: { ...telemetry, timeoutRecovery: true },
            allowPartial: true,
            nexusScope: scope,
        });
        const result = await parent.promise;
        for (const completed of result.batches || []) {
            recovered.push({
                ...completed,
                batch: retryBatches[completed.index],
                recovery: true,
                originBatchIndex: failedRow.index,
                originBatchNumber: failedRow.batchNumber,
            });
        }
        // Preserve *every* retry failure. A timeout that becomes HTTP/semantic/etc.
        // is still an unresolved piece of the original Tree slice and must not
        // disappear merely because its error class changed.
        for (const row of result.failures || []) {
            const unresolved = {
                ...row,
                batch: retryBatches[row.index],
                parentJobId: parent.id,
                originBatchIndex: failedRow.index,
                originBatchNumber: failedRow.batchNumber,
                recoveryFromSlot: failedRow.slot,
            };
            unresolvedFailures.push(unresolved);
            if (row?.error?.name === 'TV2SidecarTimeout') repeatedTimeouts.push(unresolved);
        }
    }
    for (const row of repeatedTimeouts) {
        disableSidecarAfterRepeatedTimeout(row.slot, { parentJobId, recoveryJobId: row.parentJobId || null, reason: row.reason || 'smaller-slice timeout', priorTimeoutCount: 1 });
    }
    return { recovered, unresolvedFailures, repeatedTimeouts };
}

function allowedKeysFromOverview(overview = '') {
    const set = new Set();
    const structural = /^\s*\[book=("(?:[^"\\]|\\.)*")\s+node=("(?:[^"\\]|\\.)*")(?:\s+region="(?:[^"\\]|\\.)*")?\](?:\s+.+(?:\(\d+\s+direct\s+\/\s+\d+\s+total(?:;[^)]*)?\)|\(\d+\s+direct\s+entries\)))?\s*$/;
    for (const line of String(overview || '').split(/\r?\n/)) {
        const match = line.match(structural);
        if (!match) continue;
        try { set.add(treeKey(JSON.parse(match[1]), JSON.parse(match[2]))); } catch {}
    }
    return set;
}

function treeSelectionValidator(kind, overview = '') {
    const field = kind === 'nodes' ? 'nodes' : 'regions';
    const allowedKeys = allowedKeysFromOverview(overview);
    const naked = new Map();
    for (const key of allowedKeys) {
        try {
            const [book,nodeId] = JSON.parse(key);
            const id = String(nodeId || '');
            if (!naked.has(id)) naked.set(id, []);
            naked.get(id).push({ book:String(book || ''), nodeId:id });
        } catch {}
    }
    return value => validateRetrievalRefPayload(value, {
        field,
        allowedKeys,
        normalizeRef: ref => {
            if (typeof ref === 'string' || typeof ref === 'number') {
                const matches = naked.get(String(ref).trim()) || [];
                return matches.length === 1 ? matches[0] : null;
            }
            return { book: String(ref?.book || ref?.lorebook || '').trim(), nodeId: String(ref?.nodeId ?? ref?.node_id ?? ref?.node ?? ref?.id ?? '').trim() };
        },
        keyOf: ref => treeKey(ref.book, ref.nodeId),
        requireReasoning: true,
    });
}

function entrySelectionValidator(candidates = []) {
    const allowedKeys = new Set(candidates.map(row => candidateKey(row.book, row.uid)));
    return value => validateRetrievalRefPayload(normalizeExactCandidateEntryRefs(value, candidates), {
        field: 'entries',
        allowedKeys,
        normalizeRef: ref => ({ book: String(ref?.book || ref?.lorebook || '').trim(), uid: Number(ref?.uid) }),
        keyOf: ref => Number.isInteger(ref.uid) && ref.uid >= 0 ? candidateKey(ref.book, ref.uid) : '',
        requireReasoning: true,
    });
}

function injectionRefSelectionValidator(candidates = []) {
    return value => validateOpaqueInjectionSelection(value, candidates);
}


function restrictRefsToOverview(refs = [], overview = '') {
    const allowed = allowedKeysFromOverview(overview);
    return allowed.size ? refs.filter(ref => allowed.has(treeKey(ref.book, ref.nodeId))) : [];
}

function treeRefLabel(ref, treeCache = null) {
    const book=String(ref?.book||'');
    let tree;
    if (treeCache instanceof Map) { if (!treeCache.has(book)) treeCache.set(book,getTree(book)); tree=treeCache.get(book); }
    else tree=getTree(book);
    const node = tree?.root ? findNode(tree.root, ref?.nodeId) : null;
    return node?.label || ref?.nodeLabel || ref?.nodeId || 'Unknown';
}

function gatherBatchTreeRefs(batchRows = []) {
    const map = new Map();
    for (const row of batchRows) {
        for (const ref of row.refs || []) {
            const key = treeKey(ref.book, ref.nodeId);
            if (!map.has(key)) map.set(key, { ...ref, support: 1, occurrences: 0, batches: [], slots: [], reasons: [] });
            const item = map.get(key);
            item.occurrences += 1;
            if (!item.batches.includes(row.batchNumber)) item.batches.push(row.batchNumber);
            if (row.slot && !item.slots.includes(row.slot)) item.slots.push(row.slot);
            if (row.reasoning && !item.reasons.includes(row.reasoning)) item.reasons.push(row.reasoning);
        }
    }
    return [...map.values()];
}

function canonicalOverviewEvidence(ref, batchRows = []) {
    const wanted = treeKey(ref?.book, ref?.nodeId);
    const structural = /^\s*\[book=("(?:[^"\\]|\\.)*")\s+node=("(?:[^"\\]|\\.)*")(?:\s+region="(?:[^"\\]|\\.)*")?\](?:\s+.*)?$/;
    for (const row of batchRows) {
        if (!(row?.refs || []).some(item => treeKey(item.book, item.nodeId) === wanted)) continue;
        const lines = String(row?.treeText || '').split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            const match = lines[index].match(structural);
            if (!match) continue;
            let key = '';
            try { key = treeKey(JSON.parse(match[1]), JSON.parse(match[2])); } catch {}
            if (key !== wanted) continue;
            const evidence = [lines[index]];
            for (let next = index + 1; next < lines.length && evidence.length < 5; next++) {
                if (structural.test(lines[next])) break;
                if (lines[next].trim()) evidence.push(lines[next]);
            }
            return headText(evidence.join('\n'), 1600);
        }
    }
    return '';
}

function canonicalBatchEvidence(gathered = [], batchRows = []) {
    return gathered.map(ref => ({ ref, evidence: canonicalOverviewEvidence(ref, batchRows) }));
}

function buildBatchCondensePrompt({ kind = 'regions', gathered = [], batchRows = [], chat = '', gate } = {}) {
    const field = kind === 'nodes' ? 'nodes' : 'regions';
    const treeCache = new Map();
    const candidates = gathered.map(ref => `- [book=${JSON.stringify(ref.book)} node=${JSON.stringify(ref.nodeId)}] ${treeRefLabel(ref,treeCache)} | returned by batch(es) ${ref.batches.join(', ')} | worker(s) ${ref.slots.join(', ') || 'unknown'}`).join('\n');
    const reasons = batchRows.map(row => `Batch ${row.batchNumber} (${row.slot || 'unknown'}): ${headText(row.reasoning || '(no reason)', 1200)}`).join('\n');
    const evidence = canonicalBatchEvidence(gathered, batchRows).map(row => `[book=${JSON.stringify(row.ref.book)} node=${JSON.stringify(row.ref.nodeId)}]\n${row.evidence}`).join('\n\n');
    return `Nexus BATCH GATHER / CONDENSE\n\nIndependent Sidecar workers reviewed disjoint Tree slices. Reassemble them into ONE minimal load-bearing ${kind} selection for the immediate next roleplay beat. You may ONLY keep candidates listed below. Batch inclusion means \"best candidate in that slice\", not \"must survive globally\". Drop stale topical/history matches that are not needed now.\n\nLOAD-BEARING TEST\nCould the next response be written accurately and in-character without this candidate? If yes, drop it.\n\nCHANGE GATE\n${gate?.mode || 'UNKNOWN'}: ${gate?.reason || ''}\n\nGATHERED CANDIDATES\n${candidates || '(none)'}\n\nCANONICAL CANDIDATE EVIDENCE\n${evidence || '(none)'}\n\nBATCH WORKER REASONS\n${reasons || '(none)'}\n\nIMMEDIATE SCENE\n${chat}\n\nOUTPUT CONTRACT
Return ONLY one JSON object with keys "${field}" and "reasoning". Every item in "${field}" MUST copy the exact book and nodeId pair from GATHERED CANDIDATES. The reasoning MUST be one non-empty JSON string; do not return a reasoning object/map. Do not emit schema placeholders, example values, invented books, or invented node IDs.`;
}

async function condenseBatchTreeRefs({ kind, gathered, batchRows, chat, gate, books, priority = 100, parentLabel = 'Retrieval', settings = null, model = '', scope = null } = {}) {
    if (gathered.length <= 1) return { refs: gathered.map(({ support, occurrences, batches, slots, reasons, ...ref }) => ref), reasoning: batchRows.map(row => row.reasoning).filter(Boolean).join(' | '), response: null, job: null, degraded: false };
    const canonicalEvidence = canonicalBatchEvidence(gathered, batchRows);
    if (canonicalEvidence.some(row => !row.evidence)) {
        const refs = gathered.map(({ support, occurrences, batches, slots, reasons, ...ref }) => ref);
        logEvent('retrieval', 'batch-condense-skipped-missing-canonical-evidence', {
            kind,
            missing: canonicalEvidence.filter(row=>!row.evidence).map(row=>({book:row.ref.book,nodeId:row.ref.nodeId})),
        }, 'warn');
        return { refs, reasoning:'Global condensation skipped because at least one gathered ref lacked canonical slice evidence; preserved all validated gathered selections.', response:null, job:null, degraded:true };
    }
    const stage = kind === 'nodes' ? BUS_STAGE.NODE_CONDENSE : BUS_STAGE.REGION_CONDENSE;
    const prompt = buildBatchCondensePrompt({ kind, gathered, batchRows, chat, gate });
    const packingTarget = batchTargetInputTokens(settings || getSettings(), kind === 'nodes' ? 'nodeScan' : 'regionScan');
    const condenseStage = kind === 'nodes' ? BUS_STAGE.NODE_CONDENSE : BUS_STAGE.REGION_CONDENSE;
    const softInputTarget = condensationSoftInputTarget(settings || getSettings(), { role:'retrieval', stage:condenseStage });
    const estimatedInputTokens = estimateContentTokens(prompt, model);
    if (estimatedInputTokens > softInputTarget) {
        logEvent('retrieval', 'batch-condense-soft-target-exceeded', {
            kind,
            gatheredCount:gathered.length,
            estimatedInputTokens,
            softInputTargetTokens:softInputTarget,
            batchPackingTargetTokens:packingTarget,
            authorityAction:'attempt-global-condense',
        }, 'warn');
    }
    const condenseOverview = gathered.map(ref => `[book=${JSON.stringify(ref.book)} node=${JSON.stringify(ref.nodeId)}]`).join('\n');
    const validator = treeSelectionValidator(kind, condenseOverview);
    const job = enqueueRetrievalWorkerJob(stage, {
        prompt,
        systemPrompt: `You are Nexus batch ${kind} condensation. Select only from the gathered exact Tree refs. Return exact JSON only.`,
        responseFormat: 'json_object',
        excludeReasoning: true,
        structuredValidator: validator,
        reasoningEffort: TREE_SELECTION_REASONING_EFFORT,
        maxTokens: SELECTION_MAX_TOKENS,
        priority,
        foregroundAdjacent: true,
        preemptible: false,
        dedupKey: `${kind}-condense:${getContext()?.chat?.length || 0}:${gate?.mode || 'unknown'}:${identitySignature(gathered.map(ref=>[ref.book,ref.nodeId]))}`,
        nexusScope: scope,
        label: `${parentLabel} · gather / condense`,
        telemetry: { retrievalPhase: `${kind}-batch-condense`, gatheredCount: gathered.length },
    });
    try {
        const response = await job.promise;
        const parsed = response?.structuredPayload ?? parseJson(response.text, `Batch ${kind} Condense Sidecar`, validator);
        const raw = kind === 'nodes'
            ? (parsed.nodes ?? parsed.nodeRefs ?? parsed.nodeIds ?? parsed.node_ids ?? [])
            : (parsed.regions ?? parsed.regionRefs ?? parsed.region_ids ?? []);
        const gatheredKeys = new Set(gathered.map(ref => treeKey(ref.book, ref.nodeId)));
        const refs = normalizeResponseTreeRefs(raw, books).filter(ref => gatheredKeys.has(treeKey(ref.book, ref.nodeId)));
        return { refs, reasoning: String(parsed.reasoning || ''), response, job, degraded: response?.tv2?.multi?.degraded === true };
    } catch (error) {
        if (isIntentionalCancellation(error)) throw error;
        const refs = gathered.map(({ support, occurrences, batches, slots, reasons, ...ref }) => ref);
        logEvent('retrieval', 'batch-condense-degraded-to-gather', {
            kind,
            jobId: job?.id || null,
            gatheredCount: refs.length,
            error,
        }, 'warn');
        return { refs, reasoning: `Condense failed; preserved deterministic gathered ${kind}.`, response: null, job, degraded: true };
    }
}

function clearPrompt({ generationId = null, force = false } = {}) {
    return clearRetrievalPrompt({generationId,force});
}
function applyPrompt(text, generationId = null) {
    return applyRetrievalPrompt(text,generationId);
}

function selectableHintRefs(refs = [], overview = '', { projectToTopRegion = false } = {}) {
    const allowed = allowedKeysFromOverview(overview);
    if (!allowed.size) return [];
    const out = new Map();
    for (const ref of refs || []) {
        let candidate = ref;
        let key = treeKey(candidate?.book, candidate?.nodeId);
        if (!allowed.has(key) && projectToTopRegion) {
            const tree = getTree(ref?.book);
            const projected = tree ? topRegionRefForNode(ref?.book, tree, ref?.nodeId) : null;
            if (projected) {
                key = treeKey(projected.book, projected.nodeId);
                if (allowed.has(key)) candidate = { ...projected, nodeLabel: treeRefLabel(projected), title: ref?.title || '' };
            }
        }
        key = treeKey(candidate?.book, candidate?.nodeId);
        if (allowed.has(key) && !out.has(key)) out.set(key, candidate);
    }
    return [...out.values()].slice(0, 24);
}

function clipHint(value, max = 140) { const chars=Array.from(String(value||'')); return chars.length>max?`${chars.slice(0,max).join('')}…`:chars.join(''); }
function treeHintLines(refs = [], label) {
    if (!refs.length) return '';
    const bounded=(refs||[]).slice(0,24);
    return `${label}\n${bounded.map(ref => `- ${clipHint(ref.book,80)} :: ${clipHint(ref.nodeId,80)}${ref.nodeLabel ? ` :: ${clipHint(ref.nodeLabel)}` : ''}${ref.title ? ` :: ${clipHint(ref.title)}` : ''}`).join('\n')}`;
}

function normalizeResponseTreeRefs(rawRefs, books) {
    const list = Array.isArray(rawRefs) ? rawRefs : [];
    const refs = [];
    for (const item of list) {
        if (typeof item === 'object' && item) {
            refs.push({ book: String(item.book || item.lorebook || ''), nodeId: String(item.nodeId || item.node_id || item.id || '') });
            continue;
        }
        const nodeId = String(item || '').trim();
        if (!nodeId) continue;
        // Compatibility for a model that returns naked IDs. Only accept if that
        // node ID resolves unambiguously to one active Tree.
        const matches = [];
        for (const book of books) {
            const tree = getTree(book);
            if (tree?.root && findNode(tree.root, nodeId)) matches.push(book);
        }
        if (matches.length === 1) refs.push({ book: matches[0], nodeId });
    }
    return validateTreeRefs(dedupeTreeRefs(refs), books);
}

function buildRegionRoutingPrompt({ overview, chat, gate, retrievalPlan = null, pins, warm }) {
    const selectablePins = selectableHintRefs(pins, overview, { projectToTopRegion: true });
    const selectableWarm = selectableHintRefs(warm, overview, { projectToTopRegion: true });
    const hints = [
        treeHintLines(selectablePins, 'ACTIVE/PERSISTENT PIN HINTS (selectable regional refs only; continuity evidence, not forced selections):'),
        treeHintLines(selectableWarm, 'SMART CONTEXT WARM HINTS (selectable regional refs only; predictive only):'),
    ].filter(Boolean).join('\n\n');
    return `Nexus REGIONAL TREE ROUTING

The Tree is authoritative. This is PASS 1. Choose only the narrowest region/subregion(s) that are LOAD-BEARING for writing the IMMEDIATE roleplay beat. A region selection does NOT inject lore; it only opens that part of the Tree for PASS 2.

LOAD-BEARING TEST: ask "Could the next response be written accurately and in-character without opening this region?" If yes, do not select it. Recent discussion, thematic similarity, historical parallels, or a named topic are not sufficient by themselves. Prefer current characters, current/next location, immediate physical/status constraints, active relationships, direct questions, promised next actions, and facts the next beat actually depends on. A cold start means reevaluate from scratch; it does NOT mean gather every recently relevant subject. Pins and warm hints are evidence only and may be dropped when stale.

CHANGE GATE
${gate.mode}: ${gate.reason}

RETRIEVAL EXECUTION
${retrievalPlan?.mode || 'UNSPECIFIED'}: ${retrievalPlan?.reason || 'execution plan not supplied'}

${hints ? `${hints}

` : ''}IMMEDIATE SCENE
${chat}

REGION INDEX
${overview}

OUTPUT CONTRACT
Return ONLY one JSON object with keys "regions" and "reasoning". Every regions item MUST copy the exact book and nodeId pair from the supplied Tree. Do not emit schema placeholders, example values, invented books, or invented node IDs. The reasoning MUST be one non-empty JSON string. It must name the immediate scene need for each selected region; do not return a reasoning object/map and do not justify a region only by a previously discussed topic.`;
}
function buildNodeScanPrompt({ overview, chat, gate, retrievalPlan = null, pins, warm, regionalReasoning }) {
    const selectablePins = selectableHintRefs(pins, overview);
    const selectableWarm = selectableHintRefs(warm, overview);
    const hints = [
        treeHintLines(selectablePins, 'PIN HINTS (selectable refs in this regional view only):'),
        treeHintLines(selectableWarm, 'WARM HINTS (selectable refs in this regional view only):'),
    ].filter(Boolean).join('\n\n');
    return `Nexus REGIONAL NODE SCAN

The Tree is authoritative. This is PASS 2. The regional router already constrained the Tree view below. Select the minimum exact nodes/leaves whose DIRECT lore is necessary for the immediate beat. Prefer precise leaves. Selecting a branch makes only that branch's DIRECT entries eligible; it does not recursively dump descendants. Pins/warm hints are continuity evidence, not mandatory selections.

Apply the same LOAD-BEARING TEST: if the next response remains accurate without this node, leave it out. Do not keep a node merely because its subject dominated the prior conversation or provides an interesting historical parallel.

CHANGE GATE
${gate.mode}: ${gate.reason}

RETRIEVAL EXECUTION
${retrievalPlan?.mode || 'UNSPECIFIED'}: ${retrievalPlan?.reason || 'execution plan not supplied'}

REGIONAL ROUTING REASONING
${regionalReasoning || '(reused previous regions / none)'}

${hints ? `${hints}

` : ''}IMMEDIATE SCENE
${chat}

SELECTED REGION TREE
${overview}

OUTPUT CONTRACT
Return ONLY one JSON object with keys "nodes" and "reasoning". Every nodes item MUST copy the exact book and nodeId pair from SELECTED REGION TREE. The reasoning MUST be one non-empty JSON string; do not return a reasoning object/map. Do not emit schema placeholders, example values, invented books, or invented node IDs.`;
}
function buildInjectionReviewPrompt(candidates, { nodeReasoning = '', regionalReasoning = '', gate, retrievalPlan = null, previousRefs = [], pins = [], warm = [], sceneAnchors = [] } = {}) {
    const previous = new Set(previousRefs.map(r => candidateKey(r.book, r.uid)));
    const pinned = new Set(pins.map(r => candidateKey(r.book, r.uid)));
    const warmed = new Set(warm.map(r => candidateKey(r.book, r.uid)));
    const anchors = new Map(sceneAnchors.map(r => [candidateKey(r.book, r.uid), r]));
    const catalog = buildOpaqueInjectionRefCatalog(candidates);
    const rendered = catalog.map(({ refId, candidate: c }) => {
        const key = candidateKey(c.book, c.uid);
        const flags = [
            previous.has(key) ? 'PREVIOUSLY_INJECTED' : '',
            pinned.has(key) ? 'PINNED' : '',
            warmed.has(key) ? 'WARM' : '',
            anchors.has(key) ? `SCENE_ANCHOR:${anchors.get(key).anchorCharacter || 'active'}:${anchors.get(key).anchorKind || 'character'}` : '',
        ].filter(Boolean).join(', ');
        const physical = c._physicalFragment === true
            ? `\nPHYSICAL SLICE ${Number(c._physicalChunkIndex) + 1}/${Number(c._physicalChunkCount) || 1} OF THE SAME CANONICAL ENTRY`
            : '';
        return `REF_ID ${refId}\nTITLE ${c.title || 'Untitled'}\nTREE ${c.nodeLabel || c.nodeId || 'unknown'}${flags ? `\nFLAGS ${flags}` : ''}${physical}\nCONTENT\n${c.content}`;
    }).join('\n\n---\n\n');
    return `Nexus LORE INJECTION REVIEW\n\nThe Tree's regional scan/node scan plus any explicit Scene Anchor guard have constrained the candidate set. You may ONLY choose entries listed below. Select the minimum exact lore entries that should cross into the main RP context for continuity and accuracy. Keep previously useful entries when still relevant and drop stale ones. Do not choose lore merely because a name appears.\n\nSELECTION PROTOCOL: each candidate has one short opaque REF_ID. The REF_ID is the ONLY value you may copy into the output selection. Never copy candidate title, Tree label, flags, lore content, book name, UID, or candidate object into the output.\n\nCHARACTER-DRIVEN BEAT RULE: when SCENE_ANCHOR entries identify characters explicitly active in an interpersonal, emotional, or dialogue-led beat, do not reduce the injection to location/set dressing alone. Retain the smallest set that protects active character voice and their relevant dynamic—normally one personality/identity entry per anchor and the relevant relationship entry for a close dyad. Drop anchors only when the immediate scene genuinely does not depend on that character's characterization.\n\nCHANGE GATE\n${gate.mode}: ${gate.reason}\n\nRETRIEVAL EXECUTION\n${retrievalPlan?.mode || 'UNSPECIFIED'}: ${retrievalPlan?.reason || 'execution plan not supplied'}\n\nREGION REASONING\n${regionalReasoning || '(none)'}\n\nNODE REASONING\n${nodeReasoning || '(none)'}\n\nCANDIDATE LORE\n${rendered || '(none)'}\n\nOUTPUT CONTRACT\nReturn ONLY one JSON object with keys "refs" and "reasoning". "refs" MUST be an array containing only exact REF_ID strings from CANDIDATE LORE. Do not emit entry objects, book names, UIDs, titles, content, schema placeholders, example values, or invented REF_IDs.`;
}

function isSemanticSelectionFailure(error) {
    return error?.semantic === true || error?.name === 'NexusSemanticValidationError';
}

function injectionReviewDedupKey(candidates = [], gate = null, scope = null) {
    // Opaque REF_ID values are assigned by candidate position. Preserve the
    // exact ordered universe in dedup identity; set/sort semantics can make R1
    // mean a different entry while incorrectly sharing the same in-flight job.
    const signature = identitySignature((candidates || []).map(row => [String(row?.book||''),Number(row?.uid)]));
    const chatId = scope?.chatId ?? 'none';
    const epoch = Number(scope?.epoch) || 0;
    const revision = String(scope?.revision || 'none');
    return `lore-injection:chat:${chatId}:epoch:${epoch}:rev:${revision}:gate:${gate?.mode || 'unknown'}:refs:${signature}`;
}

async function runInjectionReview({ candidates, regionalReasoning, nodeReasoning, gate, retrievalPlan = null, previousRefs, pins, warm, sceneAnchors = [], settings, telemetry = {}, scope = null } = {}) {
    const model = effectiveSidecarModel(settings,'loreInjection');
    const buildPrompt = list => buildInjectionReviewPrompt(list, { regionalReasoning, nodeReasoning, gate, retrievalPlan, previousRefs, pins, warm, sceneAnchors });
    const reviewDedupKey = injectionReviewDedupKey(candidates, gate, scope);
    const fullPrompt = buildPrompt(candidates);
    const fullEstimatedInputTokens = estimateContentTokens(fullPrompt, model);
    const configuredThreshold = Math.max(1200, Number(settings?.retrieval?.batchLoreInjectionThresholdTokens) || 9000);
    const target = injectionBatchTargetInputTokens(settings);
    // The physical worker packing target is an authority boundary. A larger
    // UI activation threshold must never authorize an already-oversized call.
    const threshold = Math.min(configuredThreshold, target);
    // Hard lock does not disable packing; the Batch Bus will drain all slices
    // through the locked worker rather than using A+B concurrently.
    const allowed = settings?.retrieval?.batchFireEnabled !== false
        && settings?.retrieval?.batchLoreInjectionEnabled !== false;
    const batches = allowed && fullEstimatedInputTokens >= threshold
        ? buildInjectionCandidateBatches(candidates, buildPrompt, target, model)
        : [];

    logEvent('retrieval', 'injection-batch-plan', {
        candidateCount: candidates.length,
        fullEstimatedInputTokens,
        threshold,
        targetInputTokens: target,
        batchCount: batches.length > 1 ? batches.length : 1,
        decision: batches.length > 1 ? 'batch' : 'single',
        hardLock: settings?.routing?.locks?.loreInjection || null,
    }, batches.length > 1 ? 'info' : 'debug');

    if (batches.length <= 1) {
        const job = enqueueRetrievalWorkerJob(BUS_STAGE.LORE_INJECTION, {
            role: 'loreInjection',
            prompt: fullPrompt,
            systemPrompt: 'You are Nexus lore injection selection. The Tree has already constrained the candidate set. Return exact JSON only.',
            responseFormat: 'json_object',
            excludeReasoning: true,
            structuredValidator: injectionRefSelectionValidator(candidates),
            reasoningEffort: INJECTION_SELECTION_REASONING_EFFORT,
            maxTokens: SELECTION_MAX_TOKENS,
                priority: BUS_PRIORITY.LORE_INJECTION,
            foregroundAdjacent: true,
            preemptible: false,
            dedupKey: reviewDedupKey,
            nexusScope: scope,
            label: `Lore injection review · ${gate.mode}`,
            telemetry,
        });
        try {
            const response = await job.promise;
            const parsed = response?.structuredPayload ?? parseJson(response.text, 'Lore Injection Sidecar', injectionRefSelectionValidator(candidates));
            const refIds = Array.isArray(parsed.refs) ? parsed.refs : [];
            const selected = resolveOpaqueInjectionRefs(candidates, refIds);
            const requested = selected.map(({ book, uid }) => ({ book, uid }));
            return {
                job,
                response,
                requested,
                selected,
                reasoning: String(parsed.reasoning || ''),
                batch: false,
                batchCount: 1,
                fullEstimatedInputTokens,
                recoverableTreeCore: [],
                degraded: response?.tv2?.multi?.degraded === true,
            };
        } catch (error) {
            if (isIntentionalCancellation(error)) throw error;
            const failedReview = mergeInjectionSliceSelections({
                batches: [{ candidates }],
                successfulSelections: [],
                failures: [{ index: 0, error }],
            });
            const unresolvedSlices = (failedReview.unrecoverableFailures || []).map(row => ({
                batchNumber: 1,
                candidateCount: row.candidateCount,
                candidateRefs: row.candidateRefs,
            }));
            logEvent('retrieval', 'injection-review-unrecoverable-slice', {
                gate,
                batch: false,
                reason: isSemanticSelectionFailure(error) ? 'semantic-review-failure' : 'review-failure',
                error,
                candidateCount: candidates.length,
                candidateRefs: candidates.map(({ book, uid, title, sceneAnchor }) => ({ book, uid, title, sceneAnchor: sceneAnchor === true })),
            }, 'warn');
            return {
                job,
                response: null,
                requested: [],
                selected: [],
                reasoning: 'Lore injection review failed; the failed slice gained no entry authority and replacement coverage remains incomplete.',
                batch: false,
                batchCount: 1,
                fullEstimatedInputTokens,
                recoverableTreeCore: [],
                unrecoverableFailedSlices: unresolvedSlices,
                coverageIncomplete: failedReview.coverageIncomplete === true,
                degraded: true,
            };
        }
    }

    const parent = enqueueRetrievalWorkerBatch(BUS_STAGE.LORE_INJECTION, batches.map((batch, index) => ({
        prompt: batch.prompt,
        systemPrompt: 'You are Nexus lore injection slice selection. Select only exact REF_ID values supplied in this slice. Return exact JSON only.',
        responseFormat: 'json_object',
        excludeReasoning: true,
        structuredValidator: injectionRefSelectionValidator(batch.candidates),
        reasoningEffort: INJECTION_SELECTION_REASONING_EFFORT,
        maxTokens: SELECTION_MAX_TOKENS,
        label: `Lore injection review · ${gate.mode} · slice ${index + 1}/${batches.length}`,
        telemetry: { ...telemetry, injectionBatchIndex: index, injectionBatchNumber: index + 1, injectionBatchCount: batches.length },
    })), {
        role: 'loreInjection',
        reasoningEffort: INJECTION_SELECTION_REASONING_EFFORT,
        maxTokens: SELECTION_MAX_TOKENS,
        priority: BUS_PRIORITY.LORE_INJECTION,
        foregroundAdjacent: true,
        preemptible: false,
        dedupKey: reviewDedupKey,
        label: `Lore injection review · ${gate.mode} · batch fire`,
        telemetry,
        allowPartial: settings?.retrieval?.batchAllowPartial !== false,
        nexusScope: scope,
    });
    const result = await parent.promise;
    const reasons = [];
    const successfulSelections = [];
    for (const completed of result.batches || []) {
        const batch = batches[completed.index];
        const parsed = completed.response?.structuredPayload ?? parseJson(completed.response?.text, `Lore Injection batch ${completed.batchNumber}`, injectionRefSelectionValidator(batch.candidates));
        reasons.push(String(parsed.reasoning || ''));
        successfulSelections.push({
            index: completed.index,
            batchIndex: completed.index,
            batchNumber: completed.batchNumber,
            requested: resolveOpaqueInjectionRefs(batch.candidates, Array.isArray(parsed.refs) ? parsed.refs : [])
                .map(({ book, uid }) => ({ book, uid })),
        });
    }
    const mergedSelections = mergeInjectionSliceSelections({
        batches,
        successfulSelections,
        failures: result.failures || [],
    });
    const unrecoverableFailedSlices = (mergedSelections.unrecoverableFailures || []).map(row => ({
        batchNumber: Number(row.batchIndex) + 1,
        candidateCount: row.candidateCount,
        candidateRefs: row.candidateRefs,
    }));
    if (unrecoverableFailedSlices.length) {
        logEvent('retrieval', 'injection-review-unrecoverable-slice', {
            gate,
            batch: true,
            failedSliceCount: result.failures?.length || 0,
            unrecoverableSliceCount: unrecoverableFailedSlices.length,
            slices: unrecoverableFailedSlices,
        }, 'warn');
        reasons.push('At least one lore-review slice remained unresolved; failed slices gain no entry authority and replacement coverage is incomplete.');
    }
    let selected = mergedSelections.selected;
    let response = (result.batches || [])[0]?.response || null;
    let job = parent;
    let reasoning = reasons.filter(Boolean).join(' | ');
    logEvent('retrieval', 'injection-batch-gathered', {
        parentJobId: parent.id,
        batchCount: batches.length,
        completedCount: result.batches?.length || 0,
        failedCount: result.failures?.length || 0,
        gatheredCount: selected.length,
        slotsUsed: result?.tv2?.slotsUsed || [],
        selected: selected.map(({ book, uid, title }) => ({ book, uid, title })),
    }, result.failures?.length ? 'warn' : 'info');

    const injectionBatchDegraded = result?.tv2?.degraded === true || (result?.failures?.length || 0) > 0;
    let condenseDegraded = false;
    const condenseMin = batchCondenseMinCandidates(settings);
    if (shouldCondenseInjectionGather({ degraded: injectionBatchDegraded, selectedCount: selected.length, minCandidates: condenseMin })) {
        const condensePrompt = buildPrompt(selected);
        const condenseEstimatedInputTokens = estimateContentTokens(condensePrompt, model);
        const condenseSoftInputTarget = condensationSoftInputTarget(settings, { role:'loreInjection', stage:BUS_STAGE.LORE_INJECTION });
        if (condenseEstimatedInputTokens > condenseSoftInputTarget) {
            logEvent('retrieval', 'injection-batch-condense-soft-target-exceeded', {
                parentJobId:parent.id,
                gatheredCount:selected.length,
                condenseEstimatedInputTokens,
                softInputTargetTokens:condenseSoftInputTarget,
                batchPackingTargetTokens:target,
                authorityAction:'attempt-global-condense',
            }, 'warn');
        }
        const condense = enqueueRetrievalWorkerJob(BUS_STAGE.LORE_INJECTION, {
            role: 'loreInjection',
            prompt: condensePrompt,
            systemPrompt: 'You are Nexus global lore injection condensation. Select only exact REF_ID values supplied below. Return exact JSON only.',
            responseFormat: 'json_object',
            excludeReasoning: true,
            structuredValidator: injectionRefSelectionValidator(selected),
            reasoningEffort: INJECTION_SELECTION_REASONING_EFFORT,
            maxTokens: SELECTION_MAX_TOKENS,
                priority: BUS_PRIORITY.LORE_INJECTION,
            foregroundAdjacent: true,
            preemptible: false,
            dedupKey:`${reviewDedupKey}:global-condense:${identitySignature(selected.map(row=>[row.book,row.uid]))}`,
            nexusScope: scope,
            label: `Lore injection review · ${gate.mode} · global condense`,
            telemetry: { ...telemetry, injectionBatchCondense: true, gatheredCount: selected.length },
        });
        try {
            const condensedResponse = await condense.promise;
            const parsed = condensedResponse?.structuredPayload ?? parseJson(condensedResponse.text, 'Lore Injection Global Condense', injectionRefSelectionValidator(selected));
            selected = resolveOpaqueInjectionRefs(selected, Array.isArray(parsed.refs) ? parsed.refs : []);
            response = condensedResponse;
            job = condense;
            reasoning = String(parsed.reasoning || reasoning);
            logEvent('retrieval', 'injection-batch-condensed', {
                parentJobId: parent.id,
                condenseJobId: condense.id,
                selectedCount: selected.length,
                selected: selected.map(({ book, uid, title }) => ({ book, uid, title })),
            }, 'info');
        } catch (error) {
            if (isIntentionalCancellation(error)) throw error;
            logEvent('retrieval', 'injection-batch-condense-degraded-to-gather', {
                parentJobId: parent.id,
                condenseJobId: condense.id,
                gatheredCount: selected.length,
                error,
            }, 'warn');
            condenseDegraded = true;
            reasoning = `${reasoning}${reasoning ? ' | ' : ''}Global lore condensation failed; preserved validated gathered selections.`;
        }
    } else {
        logEvent('retrieval', 'injection-batch-condense-skipped', {
            parentJobId: parent.id,
            gatheredCount: selected.length,
            reason: injectionBatchDegraded
                ? 'degraded-successful-slice-retention'
                : 'small-deterministic-gather',
        }, injectionBatchDegraded ? 'warn' : 'info');
    }

    return {
        job,
        response,
        requested: selected.map(({ book, uid }) => ({ book, uid })),
        selected,
        reasoning,
        batch: true,
        batchCount: batches.length,
        fullEstimatedInputTokens,
        slotsUsed: result?.tv2?.slotsUsed || [],
        recoverableTreeCore: mergedSelections.recoverableTreeCore,
        unrecoverableFailedSlices,
        coverageIncomplete: mergedSelections.coverageIncomplete === true,
        degraded: injectionBatchDegraded || condenseDegraded || response?.tv2?.multi?.degraded === true,
    };
}


function renderInjection(candidates, optionalBudgetTokens, model = '', { requiredRefs = [], presentationScopeKey = '', presentationStrategy = 'canonical' } = {}) {
    const requiredKeys=new Set((requiredRefs||[]).map(ref=>candidateKey(ref?.book,ref?.uid)));
    const rows=candidates.map(candidate=>({candidate,chunk:`[${candidate.book} | UID ${candidate.uid} | ${candidate.title || 'Untitled'}]\n${candidate.content}`}));
    const chunkFor=candidate=>`[${candidate.book} | UID ${candidate.uid} | ${candidate.title || 'Untitled'}]\n${candidate.content}`;
    const present=(included)=>{
        const canonicalCandidates=canonicalLorePresentation(included),canonicalText=canonicalCandidates.map(chunkFor).join('\n\n');
        const plan=planLorePresentationCache({scopeKey:presentationScopeKey,currentCandidates:included,strategy:presentationStrategy});
        const plannedCandidates=plan.orderedCandidates||[];
        const membershipValid=sameLorePresentationMembership(included,plannedCandidates);
        const presentedCandidates=membershipValid?plannedCandidates:canonicalCandidates;
        return{
            text:presentedCandidates.map(chunkFor).join('\n\n'),
            canonicalText,
            presentedCandidates,
            presentationStrategy:membershipValid?plan.strategy:'canonical',
            presentationRequestedStrategy:plan.strategy,
            presentationFallbackReason:membershipValid?null:'membership-mismatch',
            presentationHasPrior:plan.hasPrior===true,
            presentationPreviousCount:Number(plan.previousCount)||0,
        };
    };
    const budget=Number(optionalBudgetTokens);
    if(!Number.isFinite(budget)||budget<=0){
        const includedCandidates=rows.map(r=>r.candidate),presentation=present(includedCandidates);
        return{...presentation,includedCandidates,budgetApplied:false,omitted:0,budgetExceededByRequired:false};
    }
    const selected=[];let estimated=0;let budgetExceededByRequired=false;
    for(const row of rows.filter(row=>requiredKeys.has(candidateKey(row.candidate.book,row.candidate.uid)))){
        const cost=estimateContentTokens(row.chunk,model);selected.push(row);estimated+=cost;if(estimated>budget)budgetExceededByRequired=true;
    }
    for(const row of rows){
        if(requiredKeys.has(candidateKey(row.candidate.book,row.candidate.uid)))continue;
        const cost=estimateContentTokens(row.chunk,model);if(estimated+cost>budget)continue;selected.push(row);estimated+=cost;
    }
    const includedCandidates=selected.map(r=>r.candidate),presentation=present(includedCandidates);
    return{...presentation,includedCandidates,budgetApplied:true,omitted:rows.length-selected.length,budgetExceededByRequired};
}


async function runTreeSelectionStage({
    kind,
    overview,
    buildPrompt,
    books,
    chat,
    gate,
    settings,
    systemPrompt,
    label,
    priority = BUS_PRIORITY.RETRIEVAL,
    dedupKey,
    telemetry = {},
    forceBatch = false,
    rerouteReason = null,
    scope = null,
} = {}) {
    const isNode = kind === 'nodes';
    const stage = isNode ? BUS_STAGE.NODE_SCAN : BUS_STAGE.REGION_SCAN;
    const capability = isNode ? 'nodeScan' : 'regionScan';
    const model = effectiveSidecarModel(settings,'retrieval');
    const scopedDedupKey=dedupKey?`${dedupKey}:universe:${identitySignature(overview)}`:null;
    const targetInputTokens = batchTargetInputTokens(settings, capability);
    const fullPrompt = buildPrompt(overview);
    const fullEstimatedInputTokens = estimateContentTokens(fullPrompt, model);
    const batchingAllowed = retrievalBatchingAllowed(settings);
    const activationThreshold = batchActivationThreshold(settings, targetInputTokens);
    const shouldPreBatch = batchingAllowed && (forceBatch || fullEstimatedInputTokens > targetInputTokens || fullEstimatedInputTokens >= activationThreshold);
    const packTarget = forceBatch
        ? Math.max(1200, Math.min(targetInputTokens, Math.floor(fullEstimatedInputTokens / 2.15) || targetInputTokens))
        : targetInputTokens;
    const batches = shouldPreBatch
        ? buildOverviewBatches({ overview, buildPrompt, targetInputTokens: packTarget, model })
        : [{ index: 0, treeText: overview, prompt: fullPrompt, estimatedInputTokens: fullEstimatedInputTokens, unitCount: 1 }];
    const summary = batchTokenSummary(batches);
    const fullValidator = treeSelectionValidator(kind, overview);

    logEvent('retrieval', `${isNode ? 'node' : 'region'}-batch-plan`, {
        gate,
        enabled: batchingAllowed,
        decision: batches.length > 1 ? (forceBatch ? 'failure-reroute' : 'preflight-batch') : 'single',
        rerouteReason,
        activationThreshold,
        targetInputTokens: packTarget,
        fullEstimatedInputTokens,
        batchCount: batches.length,
        batchEstimatedInputTokens: batches.map(batch => batch.estimatedInputTokens),
        totalBatchedEstimatedInputTokens: summary.totalEstimatedInputTokens,
        maxBatchEstimatedInputTokens: summary.maxEstimatedInputTokens,
        explicitMultiMode: String(settings?.routing?.modes?.retrieval || 'adaptive') !== 'adaptive',
        hardLock: settings?.routing?.locks?.retrieval || null,
    }, batches.length > 1 ? 'info' : 'debug');

    if (batches.length <= 1) {
        const job = enqueueRetrievalWorkerJob(stage, {
            prompt: fullPrompt,
            systemPrompt,
            responseFormat: 'json_object',
            excludeReasoning: true,
            structuredValidator: fullValidator,
            reasoningEffort: TREE_SELECTION_REASONING_EFFORT,
            maxTokens: SELECTION_MAX_TOKENS,
                priority,
            foregroundAdjacent: true,
            preemptible: false,
            dedupKey:scopedDedupKey,
            nexusScope: scope,
            label,
            telemetry,
        });
        try {
            const response = await job.promise;
            const parsed = response?.structuredPayload ?? parseJson(response.text, isNode ? 'Regional Node Sidecar' : 'Regional Retrieval Sidecar', fullValidator);
            const raw = isNode
                ? (parsed.nodes ?? parsed.nodeRefs ?? parsed.nodeIds ?? parsed.node_ids ?? [])
                : (parsed.regions ?? parsed.regionRefs ?? parsed.region_ids ?? []);
            const refs = normalizeResponseTreeRefs(raw, books);
            return {
                refs,
                reasoning: String(parsed.reasoning || ''),
                response,
                job,
                batch: false,
                batchCount: 1,
                slotsUsed: response?.tv2?.slot ? [response.tv2.slot] : [],
                degraded: response?.tv2?.multi?.degraded === true,
                fullEstimatedInputTokens,
                totalBatchedEstimatedInputTokens: fullEstimatedInputTokens,
            };
        } catch (error) {
            if (isIntentionalCancellation(error)) throw error;
            if (batchingAllowed && !forceBatch && shouldBatchReroute(error, settings)) {
                logEvent('retrieval', `${isNode ? 'node' : 'region'}-single-rerouted-to-batch`, {
                    gate,
                    jobId: job.id,
                    fullEstimatedInputTokens,
                    activationThreshold,
                    error,
                }, 'warn');
                return runTreeSelectionStage({
                    kind, overview, buildPrompt, books, chat, gate, settings, systemPrompt, label,
                    priority, dedupKey: null, telemetry, forceBatch: true,
                    rerouteReason: error?.message || error?.name || 'single-failure', scope,
                });
            }
            throw error;
        }
    }

    const parent = enqueueRetrievalWorkerBatch(stage, batches.map((batch, index) => ({
        // Preserve the source slice so timeout recovery can repack it smaller.
        // Without this, a degraded batch run had no splittable payload.
        ...batch,
        prompt: batch.prompt,
        systemPrompt,
        responseFormat: 'json_object',
        excludeReasoning: true,
        structuredValidator: treeSelectionValidator(kind, batch.treeText),
        reasoningEffort: TREE_SELECTION_REASONING_EFFORT,
        maxTokens: SELECTION_MAX_TOKENS,
        label: `${label} · slice ${index + 1}/${batches.length}`,
        telemetry: {
            ...telemetry,
            retrievalBatchIndex: index,
            retrievalBatchNumber: index + 1,
            retrievalBatchCount: batches.length,
            estimatedBatchInputTokens: batch.estimatedInputTokens,
        },
    })), {
        systemPrompt,
        reasoningEffort: TREE_SELECTION_REASONING_EFFORT,
        maxTokens: SELECTION_MAX_TOKENS,
        priority,
        foregroundAdjacent: true,
        preemptible: false,
        dedupKey,
        label: `${label} · batch fire`,
        telemetry,
        allowPartial: settings?.retrieval?.batchAllowPartial !== false,
    });
    let batchResult = await parent.promise;
    const timedOut = timeoutFailures(batchResult);
    let recovery = { recovered: [], unresolvedFailures: [], repeatedTimeouts: [] };
    if (timedOut.length) recovery = await retryTimedOutOverviewSlices({
        stage, failed: timedOut, buildPrompt, model, label, systemPrompt, priority, telemetry, kind,
        targetInputTokens: packTarget, parentJobId: parent.id, scope,
    });
    const nonTimeoutFailures = (batchResult?.failures || []).filter(row => row?.error?.name !== 'TV2SidecarTimeout');
    const unresolvedFailures = [...nonTimeoutFailures, ...recovery.unresolvedFailures];
    const completedSlices = [...(batchResult?.batches || []), ...recovery.recovered];
    if (!completedSlices.length) {
        const err = new Error(`${label} batch fire returned no successful Sidecar slices.`);
        err.batchFailures = unresolvedFailures.length ? unresolvedFailures : (batchResult?.failures || []);
        throw err;
    }

    const batchRows = [];
    for (const completed of completedSlices) {
        const batch = completed.batch || batches[completed.index];
        const response = completed.response;
        const sliceValidator = treeSelectionValidator(kind, batch?.treeText || '');
        const parsed = response?.structuredPayload ?? parseJson(response?.text, `${label} batch ${completed.batchNumber}`, sliceValidator);
        const raw = isNode
            ? (parsed.nodes ?? parsed.nodeRefs ?? parsed.nodeIds ?? parsed.node_ids ?? [])
            : (parsed.regions ?? parsed.regionRefs ?? parsed.region_ids ?? []);
        const refs = restrictRefsToOverview(normalizeResponseTreeRefs(raw, books), batch?.treeText || '');
        batchRows.push({
            batchIndex: completed.index,
            batchNumber: completed.batchNumber,
            slot: completed.slot,
            refs,
            reasoning: String(parsed.reasoning || ''),
            treeText: String(batch?.treeText || ''),
            response,
        });
    }
    const gathered = gatherBatchTreeRefs(batchRows);
    logEvent('retrieval', `${isNode ? 'node' : 'region'}-batch-gathered`, {
        gate,
        parentJobId: parent.id,
        batchCount: batches.length,
        completedCount: completedSlices.length,
        failedCount: unresolvedFailures.length,
        initialFailedCount: batchResult.failures?.length || 0,
        timeoutRecoveryCount: recovery.recovered.length,
        timeoutShutdownCount: recovery.repeatedTimeouts.length,
        gatheredCount: gathered.length,
        slotsUsed: batchResult?.tv2?.slotsUsed || [],
        dualIdleScatter: batchResult?.tv2?.dualIdleScatter === true,
        gathered: gathered.map(ref => ({ book: ref.book, nodeId: ref.nodeId, support: ref.support, occurrences:ref.occurrences, batches: ref.batches, slots: ref.slots })),
    }, unresolvedFailures.length || recovery.recovered.length ? 'warn' : 'info');


    let refs = gathered.map(({ support, occurrences, batches: sourceBatches, slots, reasons, ...ref }) => ref);
    let reasoning = batchRows.map(row => row.reasoning).filter(Boolean).join(' | ');
    let response = batchRows[0]?.response || null;
    let condenseJob = null;
    let stageDegraded = batchResult?.tv2?.degraded === true || unresolvedFailures.length > 0 || recovery.recovered.length > 0;
    const minCondense = batchCondenseMinCandidates(settings);
    if (!stageDegraded && settings?.retrieval?.batchCondense !== false && gathered.length >= minCondense) {
        const condensed = await condenseBatchTreeRefs({
            kind,
            gathered,
            batchRows,
            chat,
            gate,
            books,
            priority,
            parentLabel: label,
            settings,
            model,
            scope,
        });
        refs = condensed.refs;
        reasoning = condensed.reasoning || reasoning;
        response = condensed.response || response;
        condenseJob = condensed.job;
        stageDegraded = stageDegraded || condensed.degraded === true;
        logEvent('retrieval', `${isNode ? 'node' : 'region'}-batch-condensed`, {
            gate,
            parentJobId: parent.id,
            condenseJobId: condenseJob?.id || null,
            gatheredCount: gathered.length,
            selectedCount: refs.length,
            refs,
            reasoning,
        }, 'info');
    } else if (gathered.length > 1) {
        logEvent('retrieval', `${isNode ? 'node' : 'region'}-batch-condense-skipped`, {
            gate,
            parentJobId: parent.id,
            gatheredCount: gathered.length,
            minCandidates: minCondense,
            reason: 'small-deterministic-gather',
        }, 'info');
    }

    return {
        refs,
        reasoning,
        response,
        job: parent,
        condenseJob,
        batch: true,
        batchCount: batches.length,
        completedCount: completedSlices.length,
        failedCount: unresolvedFailures.length,
        slotsUsed: batchResult?.tv2?.slotsUsed || [],
        dualIdleScatter: batchResult?.tv2?.dualIdleScatter === true,
        degraded: stageDegraded,
        fullEstimatedInputTokens,
        totalBatchedEstimatedInputTokens: summary.totalEstimatedInputTokens,
        maxBatchEstimatedInputTokens: summary.maxEstimatedInputTokens,
    };
}

async function resolveExactPinnedEntries(refs = [], allowedBooks = []) {
    const allowed=new Set((allowedBooks||[]).map(String));
    const byBook=new Map();
    for(const ref of refs||[]){const book=String(ref?.book||'');if(!allowed.has(book)||!Number.isInteger(Number(ref?.uid)))continue;if(!byBook.has(book))byBook.set(book,[]);byBook.get(book).push(ref);}
    const out=[];
    for(const [book,bookRefs] of byBook){
        try{
            const data=await loadBook(book);
            for(const ref of bookRefs){
                const entry=findEntryByUid(data?.entries,Number(ref.uid));
                if(!entry||entry.disable===true||!String(entry.content||'').trim())continue;
                out.push({book,uid:Number(ref.uid),title:String(entry.comment||entry.title||''),content:String(entry.content||''),keys:Array.isArray(entry.key)?entry.key.map(String):[],nodeId:String(ref.nodeId||''),nodeLabel:String(ref.nodeLabel||''),path:Array.isArray(ref.path)?ref.path:[]});
            }
        }catch(error){logEvent('retrieval','exact-pin-book-load-failed',{book,error},'warn');}
    }
    return dedupeEntryRefs(out);
}

function clearUnavailableInjectionForNewContext({ gate, regionRefs = [], nodeRefs = [], reason = 'no-valid-nexus-replacement', scope = null } = {}) {
    if (scope && !isNexusWorkScopeFresh(scope, getContext())) {
        logEvent('retrieval', 'stale-authority-discarded', { gate, reason, scope }, 'warn');
        return false;
    }
    if(!clearPrompt({ generationId: scope?.generationId ?? null })){
        logEvent('retrieval','physical-prompt-clear-refused',{gate,reason,scope},'warn');
        return false;
    }
    pinActiveInjection([], reason);
    // Do not remember an empty shell as a successful retrieval. Clearing the
    // reusable Nexus state ensures the host transaction restores/retains native
    // World Info until a later cycle produces a validated replacement.
    clearRetrievalState();
    logEvent('retrieval', 'authoritative-replacement-unavailable', { gate, regionRefs, nodeRefs, reason }, 'warn');
    return true;
}
function staleRetrievalResult(scope, gate, phase = 'commit') {
    logEvent('retrieval', 'stale-authority-discarded', { scope, gate, phase }, 'warn');
    return { deferred: true, stale: true, reason: 'scope-invalidated', gate };
}
function stablePolicyJson(value) {
    if (Array.isArray(value)) return `[${value.map(stablePolicyJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stablePolicyJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value ?? null);
}

function retrievalExecutionPolicyKey(live = getSettings()) {
    const retrieval = { ...(live?.retrieval || {}) };
    // Main prompt capacity/model have their own final re-render authority. Every
    // other Retrieval control is an execution boundary and cannot change under
    // an in-flight Sidecar result.
    delete retrieval.maxInjectionTokens;
    return identitySignature(stablePolicyJson({
        enabled: live?.enabled === true,
        retrieval,
        routing: live?.routing || {},
        sidecars: {
            A: live?.sidecars?.A || {},
            B: live?.sidecars?.B || {},
        },
        vectorPaging: live?.vectorPaging || {},
    }));
}

function retrievalAuthorityFresh(scope, executionPolicyKey) {
    return (!scope || isNexusWorkScopeFresh(scope, getContext()))
        && (!executionPolicyKey || executionPolicyKey === retrievalExecutionPolicyKey());
}

function applyPromptForScope(text, scope, executionPolicyKey = '', metadata = {}) {
    // HOTFIX4's work-scope fence remains the first publication authority.
    if (scope && !isNexusWorkScopeFresh(scope, getContext())) return false;
    // Older repair policy fencing strengthens that authority without replacing it.
    if (!retrievalAuthorityFresh(scope, executionPolicyKey)) return false;
    applyRetrievalPrompt(text, scope?.generationId ?? null, metadata);
    // Re-entrant host callbacks/settings listeners may invalidate authority while
    // the prompt bridge publishes. Never leave that stale physical prompt live.
    if (!retrievalAuthorityFresh(scope, executionPolicyKey)) {
        if (!clearPrompt({ generationId: scope?.generationId ?? null })) {
            logEvent('retrieval', 'physical-prompt-clear-refused', {
                generationId: scope?.generationId ?? null,
                reason: 'publication-authority-revoked',
            }, 'warn');
        }
        return false;
    }
    return true;
}

function commitSuccessfulGate(state, gate, chatLength, noChangeStreak) {
    state.lastGate = gate ? { ...gate } : null;
    state.lastGateChatLength = Math.max(0, Number(chatLength) || 0);
    state.noChangeStreak = Math.max(0, Number(noChangeStreak) || 0);
}

function currentRetrievalPromptPolicy() {
    const live = getSettings(),context=getContext();
    const mainModel=resolveMainModelHint(context),mainProvider=resolveMainProviderHint(context);
    const promptLoaderAdapter=resolvePromptLoaderAdapter({model:mainModel,provider:mainProvider});
    return {
        enabled: live?.enabled === true && live?.retrieval?.enabled === true,
        budgetTokens: Math.max(0, Number(live?.retrieval?.maxInjectionTokens) || 0),
        mainModel,
        mainProvider,
        promptLoaderAdapter,
        loreOrderPolicy:resolvePromptLoaderLoreOrderPolicy(promptLoaderAdapter),
        settings: live,
    };
}

function cachedInjectionFitsPolicy(state, policy) {
    if (policy?.enabled !== true || !state?.lastInjectedText) return false;
    const current = Math.max(0, Number(policy?.budgetTokens) || 0);
    const priorRaw = state.lastInjectionBudgetTokens;
    const prior = priorRaw == null ? null : Math.max(0, Number(priorRaw) || 0);
    // Unlimited/no cap remains compatible. Introducing or lowering a cap must
    // re-render under the current Main prompt authority.
    if (current > 0 && (prior == null || prior <= 0 || current < prior)) return false;
    if (String(state.lastInjectionModel || '') !== String(policy?.mainModel || '')) return false;
    if (String(state.lastInjectionProvider || '') !== String(policy?.mainProvider || '')) return false;
    if (String(state.lastLoreOrderPolicy || 'canonical') !== String(policy?.loreOrderPolicy || 'canonical')) return false;
    return true;
}

export async function runRetrieval({ generationId = null, onProgress = null } = {}) {
    const context = getContext();
    const settings = getSettings();
    if (!settings.enabled || !settings.retrieval.enabled) {
        clearRetrieval({ clearState:true, generationId, force:true });
        pinActiveInjection([], 'retrieval-disabled');
        logEvent('retrieval', 'skipped', { reason: 'disabled' }, 'debug');
        return { skipped: true };
    }
    const loreCorpus = captureLoreCorpus({ purpose:'story', requireTree:true, access:'read', injection:'tv2', context });
    const books = [...loreCorpus.books];
    logEvent('retrieval','lore-corpus-captured',{source:loreCorpus.source,bookCount:books.length,books:[...books],fingerprint:loreCorpus.fingerprint},'debug');
    if (!books.length) {
        clearPrompt({ generationId });
        clearRetrievalState();
        logEvent('retrieval', 'skipped', { reason: 'no-tree-books' }, 'debug');
        return { skipped: true, reason: 'no-tree-books' };
    }
    const scope = captureNexusWorkScope(context, { includeGeneration: generationId != null, generationId, includeSourceRevision:true, sourceBooks:books });
    const reportRetrievalProgress = (milestone, completedUnits, totalUnits = 3, extra = {}) => {
        const total = Math.max(1, Number(totalUnits) || 3);
        const done = Math.max(0, Math.min(total, Number(completedUnits) || 0));
        const progressPct = done >= total ? 100 : Math.floor((done / total) * 100);
        const progress = { ownerSubsystem:'retrieval', milestone:String(milestone || 'UNKNOWN'), completedUnits:done, totalUnits:total, progressPct, ...extra };
        if (typeof onProgress === 'function') {
            try { onProgress(progress); } catch {}
            logEvent('retrieval','foreground-progress',{ generationId, ...progress },'debug');
        }
        return progress;
    };
    const completeReuseProgress = (reason, extra = {}) => reportRetrievalProgress('REUSE_COMPLETE', 3, 3, { reason:String(reason || 'reuse-complete'), terminal:true, reused:true, ...extra });
    const completeNoInjection = (reason, result = {}, extra = {}) => {
        reportRetrievalProgress('COMPLETE_NO_INJECTION', 3, 3, { reason, ...extra });
        return { ...result, noInjection:true, reason:result.reason || reason };
    };
    const executionPolicyKey = retrievalExecutionPolicyKey(settings);
    // One immutable scene snapshot owns Change Gate and all routing prompts for
    // this retrieval. Later host edits invalidate the work scope; they never
    // cause two Sidecar stages in the same run to reason over different turns.
    const sceneMessages=(Array.isArray(context?.chat)?context.chat:[]).map(row=>row&&typeof row==='object'?{...row}:row);
    const reusable=()=>hasReusableInjection({books});

    const state = getRetrievalState();
    const reusableInjectionAtStart = hasReusableInjection({ books });
    const changeGateDisabled = settings.retrieval.changeGateEnabled === false;

    const hasSceneContext = hasLocalSceneContext(10, sceneMessages);
    // Scene Scanner owns observation and its temporary accepted scene. Change
    // Gate consumes only the resulting old/new delta; Retrieval is a consumer
    // of both services and cannot manufacture scene topology from raw prose.
    let sceneScan;
    let gate;
    let semanticGate;
    try {
        const sceneAuthority = await ensureSceneAuthority({
            context,
            messages:sceneMessages,
            source:'foreground-retrieval',
            scope,
            enqueueSidecar:(stage,options)=>enqueueRetrievalWorkerJob(stage,{...options,nexusScope:scope}),
        });
        sceneScan = sceneAuthority.sceneScan;
        semanticGate = sceneAuthority.gate;
        // Change Gate owns the accepted semantic decision, but foreground
        // Retrieval consumes a MINOR/MAJOR transition once per scene revision.
        // Overlapping/retry retrievals receive semantic NO_CHANGE plus an
        // execution-recovery marker until one valid injection is published.
        gate = consumeSceneChangeGateForRetrieval(sceneAuthority.gate) || sceneAuthority.gate;
    } catch (error) {
        if (isIntentionalCancellation(error)) throw error;
        logEvent('scene-scanner','foreground-scan-failed',{error:error?.message||String(error)},'warn');
        // Scene Scanner normally degrades internally by preserving its previous
        // accepted scene. If authority orchestration itself throws, Retrieval
        // must not manufacture a semantic gate; defer this run instead.
        return staleRetrievalResult(scope, null, 'scene-authority');
    }
    if (!retrievalAuthorityFresh(scope, executionPolicyKey)) return staleRetrievalResult(scope, gate, 'scene-scan');
    // HOTFIX46.7: Scene Scanner acceptance is real owner-authoritative work, even
    // though Retrieval has not completed its first 33% semantic unit yet. Report
    // a zero-percent heartbeat so the foreground stall watchdog does not cancel
    // healthy region/memory work merely because REGION_READY has not landed yet.
    reportRetrievalProgress('SCENE_ACCEPTED', 0, 3, {
        sceneRevision: gate?.sceneRevision || null,
        degraded: sceneScan?.degraded === true,
    });
    // Hydration only establishes cold/resumed context. If no warm cache exists,
    // build the local warm surface from the already-accepted Scene Scanner state;
    // do not run a second scene classifier here.
    if (hasSceneContext && settings.smartContext?.enabled !== false && getWarmCandidates().length === 0 && typeof preWarmSmartContext === 'function') {
        try {
            await preWarmSmartContext({
                source: 'retrieval-hydration-fallback',
                force: true,
                localOnly: true,
                hydrationLimit: 10,
                sceneBaseline: sceneScan?.delta?.initialBaseline === true,
            });
        } catch (error) {
            logEvent('smart-context', 'local-hydration-fallback-failed', { error: error?.message || String(error || 'unknown') }, 'warn');
        }
        if (!retrievalAuthorityFresh(scope, executionPolicyKey)) return staleRetrievalResult(scope, gate, 'local-hydration');
    }

    const paging = await prepareLorePaging({
        books,
        gate,
        weakCoverage: !reusableInjectionAtStart,
        requestId: generationId,
    });
    if (!retrievalAuthorityFresh(scope, executionPolicyKey)) return staleRetrievalResult(scope, gate, 'paging-or-policy');

    const pagingRefresh = paging.warmedRegions.some(ref =>
        !state.lastRegionRefs.some(old => old.book === ref.book && String(old.nodeId) === String(ref.nodeId))
    );
    const pagingRequiresRefresh = paging.requiresRefresh === true;
    if (pagingRequiresRefresh) {
        logEvent('retrieval', 'paging-fallback-execution-refresh', {
            semanticGate: gate.mode,
            reason: paging.reason || paging.fallbackReason || 'degraded-paging-authority',
        }, 'debug');
    }

    const reusePolicy = currentRetrievalPromptPolicy();
    const policyRefresh = gate.mode === RETRIEVAL_CHANGE.NO_CHANGE
        && reusableInjectionAtStart
        && !cachedInjectionFitsPolicy(state, reusePolicy);
    if (policyRefresh) {
        logEvent('retrieval', 'no-change-budget-execution-refresh', {
            semanticGate: gate.mode,
            priorBudgetTokens: state.lastInjectionBudgetTokens,
            currentBudgetTokens: reusePolicy.budgetTokens,
            priorModel: state.lastInjectionModel,
            currentModel: reusePolicy.mainModel,
            reason: 'cached injection does not satisfy the current Main prompt budget/model authority',
        }, 'info');
    }

    const pendingWarmRefresh = getPendingWarmContextRefresh();
    const gateBeforeWarmDrift = gate;
    gate = applyContextDriftToRetrievalChange(gate, pendingWarmRefresh, {
        hasReusableInjection: reusableInjectionAtStart,
    });
    if (pendingWarmRefresh && gate.promotedFrom === RETRIEVAL_CHANGE.NO_CHANGE && gateBeforeWarmDrift.mode === RETRIEVAL_CHANGE.NO_CHANGE) {
        logEvent('retrieval', 'warm-drift-promoted-minor', {
            signature: pendingWarmRefresh.signature,
            desiredCount: pendingWarmRefresh.desiredRefs.length,
            missingCount: pendingWarmRefresh.missingRefs.length,
            missingRefs: pendingWarmRefresh.missingRefs,
            requestedAt: pendingWarmRefresh.requestedAt,
            requestedChatLength: pendingWarmRefresh.chatLength,
        }, 'info');
    } else if (pendingWarmRefresh && gate.mode !== RETRIEVAL_CHANGE.NO_CHANGE) {
        logEvent('retrieval', 'warm-drift-covered-by-existing-refresh', {
            gateMode: gate.mode,
            signature: pendingWarmRefresh.signature,
            missingCount: pendingWarmRefresh.missingRefs.length,
        }, 'debug');
    }

    // Keep reuse-cadence accounting provisional until successful publication.
    // A cold/no-injection INITIAL_FULL pass must not age a reuse streak.
    const cadenceShadow = {
        noChangeStreak: reusableInjectionAtStart ? Math.max(0, Number(state.noChangeStreak) || 0) : 0,
    };
    if (reusableInjectionAtStart) {
        gate = applyReuseFreshness(gate, cadenceShadow, settings.retrieval.refreshAfterNoChangeTurns ?? 3);
    }
    const successfulNoChangeStreak = cadenceShadow.noChangeStreak;
    const commitGate = () => {
        commitSuccessfulGate(state, gate, context?.chat?.length, successfulNoChangeStreak);
        acknowledgeSceneChangeGateRetrievalExecution(gate);
    };

    // A semantic transition may already have been consumed by an overlapping
    // foreground retrieval whose physical result has not published yet. The
    // retry is still NO_CHANGE semantically, but execution must rebuild rather
    // than reuse an injection from the previous scene. Cache absence remains
    // INITIAL_FULL inside the execution planner.
    const transitionExecutionRecovery = gate?.semanticReplaySuppressed === true
        && gate?.transitionExecutionPending === true;

    // HOTFIX46 separates semantic magnitude from recompute scope. Retrieval does
    // not infer authority from similarity or from generic pins: Smart Context
    // supplies the exact current-scene refs it owns as reusable. The existing
    // source-revision fence in hasReusableInjection() must also still be valid.
    const pins = getPinnedRefs();
    const warm = getWarmCandidates();
    const authorizedRefs = (!changeGateDisabled && reusableInjectionAtStart)
        ? getWarmReuseAuthorityRefs()
        : [];
    const reusePlan = buildRetrievalReusePlan({
        gate,
        previousRefs: state.lastInjectedRefs,
        authorizedRefs,
        sceneDelta: sceneScan?.delta || null,
    });

    const withChangeWorkPlan = plan => ({
        ...plan,
        changeWorkPlan: buildChangeWorkPlan({
            gate,
            hasValidatedContext: reusableInjectionAtStart,
            ownerPlans: { retrieval: reusePlan },
            executionPlan: plan,
        }),
    });
    let retrievalPlan = withChangeWorkPlan(planRetrievalExecution({
        gate,
        hasReusableInjection: reusableInjectionAtStart,
        hasReusableRegions: state.lastRegionRefs.length > 0,
        forceFullRouting: changeGateDisabled || pagingRefresh || pagingRequiresRefresh || transitionExecutionRecovery,
        forceTargetedRefresh: !changeGateDisabled && !pagingRefresh && !pagingRequiresRefresh && !transitionExecutionRecovery && policyRefresh,
        reusePlan,
        forceReason: changeGateDisabled
            ? 'Change Gate is disabled; perform full retrieval without manufacturing a semantic transition'
            : transitionExecutionRecovery
                ? `scene revision ${String(gate?.sceneRevision || 'unknown')} already emitted ${String(gate?.replayedFrom || 'a transition')}; recover retrieval execution without replaying narrative change`
                : pagingRefresh
                    ? 'vector-warmed region requires fresh routing coverage'
                    : pagingRequiresRefresh
                        ? `paging could not verify current residency (${paging.reason || 'degraded paging'}); perform fresh retrieval execution without changing narrative semantics`
                        : policyRefresh
                            ? 'cached injection does not satisfy the current Main prompt budget/model authority'
                            : '',
    }));

    logEvent('retrieval', 'change-gate', {
        ...gate,
        noChangeStreak: successfulNoChangeStreak,
        reusable: reusableInjectionAtStart,
        authorizedReuseRefCount: authorizedRefs.length,
        reusePlan,
        retrievalPlan,
        pendingWarmRefresh: pendingWarmRefresh
            ? { signature: pendingWarmRefresh.signature, missingCount: pendingWarmRefresh.missingRefs.length }
            : null,
    }, 'info');
    logEvent('retrieval', 'execution-plan', { gateMode: gate.mode, ...retrievalPlan }, 'debug');

    // Semantic NO_CHANGE is cheap only when operational execution also says REUSE.
    if (gate.mode === RETRIEVAL_CHANGE.NO_CHANGE
        && retrievalPlan.mode === RETRIEVAL_EXECUTION.REUSE
        && reusableInjectionAtStart
        && cachedInjectionFitsPolicy(state, currentRetrievalPromptPolicy())) {
        if (!applyPromptForScope(state.lastInjectedText, scope, executionPolicyKey, { refs: state.lastInjectedRefs })) return staleRetrievalResult(scope, gate, 'no-change-reuse');
        pinActiveInjection(state.lastInjectedRefs, 'no-change-reuse');
        commitGate();
        const estimatedInjectionTokens = estimateContentTokens(state.lastInjectedText, currentRetrievalPromptPolicy().mainModel);
        logEvent('retrieval', 'injection-reused', {
            gate,
            retrievalPlan,
            refs: state.lastInjectedRefs,
            nodeRefs: state.lastNodeRefs,
            regionRefs: state.lastRegionRefs,
            chars: state.lastInjectedText.length,
            estimatedInjectionTokens,
        }, 'info');
        recordWarmInjectionUtilization({
            warmRefs: getWarmCandidates(),
            injectedRefs: state.lastInjectedRefs,
            reused: true,
            generationId,
            sceneRevision: gate?.sceneRevision || null,
            gateMode: gate?.mode || null,
            source: 'injection-reused',
        });
        completeReuseProgress('no-change-reuse',{entryCount:state.lastInjectedRefs.length,estimatedInjectionTokens});
        return {
            reused: true,
            gate,
            retrievalPlan,
            nodeRefs: state.lastNodeRefs.map(r => ({ ...r })),
            regionRefs: state.lastRegionRefs.map(r => ({ ...r })),
            refs: state.lastInjectedRefs.map(r => ({ ...r })),
            chars: state.lastInjectedText.length,
            estimatedInjectionTokens,
        };
    }

    const pinnedNodeRefs = getPinnedNodeRefs();
    const warmNodeRefs = getWarmNodeRefs();
    const chat = immediateSceneChat(settings.retrieval.contextMessages || 10,sceneMessages) || recentChat(Math.min(4, settings.retrieval.contextMessages || 10),sceneMessages);
    // Once any survivor/recovery path reports degradation, preserve that truth
    // through every later early exit and the final retrieval result.
    let retrievalDegraded = false;
    const acknowledgeWarmReview = (reason) => {
        if (!isNexusWorkScopeFresh(scope, getContext())) return null;
        const acknowledged = acknowledgeWarmContextRefresh(reason,{satisfiedRefs:state.lastInjectedRefs});
        if (acknowledged) {
            logEvent('retrieval', 'warm-drift-review-acknowledged', {
                signature: acknowledged.signature,
                reason,
                desiredCount: acknowledged.desiredRefs?.length || 0,
                missingCount: acknowledged.missingRefs?.length || 0,
            }, 'debug');
        }
        return acknowledged;
    };

    // Cold start means "no reusable Nexus cache", not "generation must fail".
    // When ST has not hydrated any scene text, never spend A/B + recovery asking
    // a model to infer a scene from the Tree. Keep only deterministic manual pins
    // as a safe static Nexus prompt, mark the cycle degraded, and let Main proceed.
    // Dynamic/retrieved state is deliberately NOT remembered as successful here,
    // so the next hydrated generation automatically performs a fresh scan.
    if (!String(chat || '').trim()) {
        retrievalDegraded = true;
        clearRetrievalState();
        const manualPins = getManualPinnedRefs();
        const staticCandidates = manualPins.length ? await resolveExactPinnedEntries(manualPins, books) : [];
        if (staticCandidates.length) {
            const staticPolicy = currentRetrievalPromptPolicy();
            if (!staticPolicy.enabled) {
                clearRetrieval({ clearState:true, generationId:scope?.generationId ?? generationId, force:true });
                pinActiveInjection([], 'retrieval-disabled-cold-start');
                return { skipped:true, deferred:true, reason:'retrieval-disabled-cold-start', gate, regionRefs:[], nodeRefs:[], refs:[] };
            }
            const rendered = renderInjection(staticCandidates, staticPolicy.budgetTokens, staticPolicy.mainModel, { requiredRefs:manualPins });
            const refs = (rendered.includedCandidates || []).map(({ book, uid, title, nodeId, nodeLabel, path }) => ({ book, uid, title, nodeId, nodeLabel, path }));
            if (!applyPromptForScope(rendered.text, scope, executionPolicyKey, { refs })) return staleRetrievalResult(scope, gate, 'cold-start-static');
            logEvent('retrieval', 'no-chat-context-static-pins', {
                gate,
                chatMessages: getContext()?.chat?.length || 0,
                refs,
                chars: rendered.text.length,
                reason: 'no-chat-context',
            }, 'warn');
            return {
                skipped: true,
                deferred: true,
                degraded: true,
                reason: 'no-chat-context',
                staticPinsRetained: true,
                gate,
                regionRefs: [],
                nodeRefs: [],
                refs,
                chars: rendered.text.length,
                estimatedInjectionTokens: estimateContentTokens(rendered.text, staticPolicy.mainModel),
            };
        }
        clearPrompt({ generationId });
        logEvent('retrieval', 'no-chat-context-deferred', {
            gate,
            books,
            chatMessages: getContext()?.chat?.length || 0,
            reason: 'no-chat-context',
        }, 'warn');
        return {
            skipped: true,
            deferred: true,
            degraded: true,
            reason: 'no-chat-context',
            gate,
            regionRefs: [],
            nodeRefs: [],
            refs: [],
            noInjection: true,
        };
    }

    // PASS 1: Major changes route through a shallow regional index. Minor changes
    // deliberately reuse the prior region set and skip this expensive pass.
    let regionRefs = [];
    let regionalReasoning = '';
    let regionJob = null;
    let regionResponse = null;
    const requiredWarmRegions = [];
    for (const ref of pendingWarmRefresh?.missingRefs || []) {
        if (!books.includes(String(ref?.book||''))) continue;
        const resolved=resolveCurrentTreeRef(ref), tree=resolved?getTree(resolved.book):null;
        const region=resolved&&tree?topRegionRefForNode(resolved.book,tree,resolved.nodeId):null;
        if(region)requiredWarmRegions.push(region);
    }
    const priorRegionKeys = new Set(state.lastRegionRefs.map(ref=>treeKey(ref.book,ref.nodeId)));
    const warmRegionsCovered = requiredWarmRegions.every(ref=>priorRegionKeys.has(treeKey(ref.book,ref.nodeId)));
    if (!warmRegionsCovered && requiredWarmRegions.length) {
        retrievalPlan = withChangeWorkPlan(planRetrievalExecution({
            gate,
            hasReusableInjection: reusableInjectionAtStart,
            hasReusableRegions: state.lastRegionRefs.length > 0,
            forceFullRouting: true,
            reusePlan,
            forceReason: 'Smart Context drift requires a region outside prior routing; reroute operationally without changing Change Gate semantics',
        }));
        logEvent('retrieval', 'execution-plan-expanded-for-warm-coverage', {
            gateMode: gate.mode,
            retrievalPlan,
            requiredWarmRegions,
        }, 'info');
    }
    const canReuseRegions = retrievalPlan.mode === RETRIEVAL_EXECUTION.TARGETED_REFRESH
        && warmRegionsCovered
        && state.lastRegionRefs.length > 0;
    if (canReuseRegions) {
        regionRefs = validateTreeRefs(state.lastRegionRefs, books);
        regionalReasoning = 'Reused previous regional routing for targeted retrieval execution.';
        logEvent('retrieval', 'targeted-regions-reused', { gate, retrievalPlan, regionRefs }, 'info');
    } else {
        // HOTFIX4 authority: vector paging may narrow the first PASS-1 regional
        // universe. If the narrowed pass yields no legal region, run one bounded
        // broader fallback. Repair-era source/policy fences remain in force.
        const rootRefs=books.flatMap(book=>{const tree=getTree(book);return tree?.root?(tree.root.entryUids||[]).map(uid=>({book,nodeId:String(tree.root.id),uid:Number(uid)})):[];});
        const rootDirectEntries=rootRefs.length?await resolveExactPinnedEntries(rootRefs,books):[];

        let regionOverview = formatRegionOverview(books, {
            previewDepth: settings.retrieval.regionPreviewDepth ?? 2,
            warmNodeRefs,
            pinnedNodeRefs,
            eligibleRegions: paging.eligibleRegions,
            rootDirectEntries,
        });
        const buildRegionPrompt = partialOverview => buildRegionRoutingPrompt({ overview: partialOverview, chat, gate, retrievalPlan, pins, warm });
        const regionPrompt = buildRegionPrompt(regionOverview);
        logEvent('retrieval', 'region-scan-prepared', {
            gate,
            books,
            treeChars: regionOverview.length,
            chatChars: chat.length,
            promptChars: regionPrompt.length,
            pinnedCount: pins.length,
            warmCount: warm.length,
            hardLock: settings.routing?.locks?.retrieval || null,
            preferredSlot: settings.routing?.retrieval || null,
            mode: settings.routing?.modes?.retrieval || 'adaptive',
            batchFireEnabled: settings.retrieval?.batchFireEnabled !== false,
        }, 'debug');
        const regionDecisionCandidates = listRegionDecisionCandidates(books, { eligibleRegions: paging.eligibleRegions, warmNodeRefs, pinnedNodeRefs });
        const regionDecisionContext = {
            chatId: scope?.chatId ?? context?.chatId ?? null,
            scene: sceneScan,
            chatRevision: scope?.revision || null,
            needText: chat,
            candidates: regionDecisionCandidates,
            sourceRevision: currentNexusLoreSourceRevision(books),
        };
        const regionDecisionSource = buildTreeAdmissionFingerprint(regionDecisionContext, 'region');
        let regionAssist = null;
        try {
            regionAssist = await evaluateRetrievalTreeAdmissionAssist({
                kind: 'region',
                ...regionDecisionContext,
                sourceFingerprint: regionDecisionSource,
                mandatoryRefs: regionDecisionCandidates.filter(row => row.pinned || row.warm).map(({ book, nodeId }) => ({ book, nodeId })),
                readCurrentFreshnessContext: () => ({ ...regionDecisionContext, scene:getSceneScannerSnapshot({chatId:regionDecisionContext.chatId}), chatRevision:captureNexusWorkScope(getContext(),{includeRevision:true}).revision, sourceRevision:currentNexusLoreSourceRevision(books) }),
            });
        } catch (error) {
            logEvent('decision-core', 'retrieval-region-assist-error', { error: error?.message || String(error) }, 'warn');
        }
        let regionRun;
        if (regionAssist?.handled) {
            const refs = validateTreeRefs(regionAssist.refs || [], books);
            regionRun = {
                job: null,
                response: null,
                refs,
                reasoning: 'Decision Core Assist selected bounded Tree regions before worker execution.',
                degraded: false,
                assist: true,
                batch: false,
                batchCount: 0,
                completedCount: 0,
                failedCount: 0,
                slotsUsed: [],
                fullEstimatedInputTokens: 0,
                totalBatchedEstimatedInputTokens: 0,
                maxBatchEstimatedInputTokens: 0,
            };
            logEvent('decision-core', 'retrieval-region-assist-complete', { candidateCount: regionDecisionCandidates.length, selectedCount: refs.length, refs, provider: regionAssist.result?.provider || null, latencyMs: regionAssist.result?.latencyMs || 0 }, 'info');
        } else {
            regionRun = await runTreeSelectionStage({
                kind: 'regions',
                overview: regionOverview,
                buildPrompt: buildRegionPrompt,
                books,
                chat,
                gate,
                settings,
                systemPrompt: 'You are Nexus regional Tree routing. The Tree is authoritative. Return exact JSON only.',
                label: `Regional Tree scan · ${gate.mode} / ${retrievalPlan.mode}`,
                priority: BUS_PRIORITY.RETRIEVAL,
                dedupKey: `retrieval-region:${getContext()?.chat?.length || 0}:${gate.mode}:${retrievalPlan.mode}`,
                telemetry: { retrievalPhase: 'region-scan' },
                scope,
            });
            if (!retrievalAuthorityFresh(scope,executionPolicyKey)) return staleRetrievalResult(scope,gate,'region-policy');
            if (paging.eligibleRegions && !regionRun.refs.length && retrievalAuthorityFresh(scope, executionPolicyKey)) {
                regionOverview = formatRegionOverview(books, {
                    previewDepth: settings.retrieval.regionPreviewDepth ?? 2,
                    warmNodeRefs,
                    pinnedNodeRefs,
                    rootDirectEntries,
                });
                regionRun = await runTreeSelectionStage({
                    kind:'regions', overview:regionOverview, buildPrompt:buildRegionPrompt, books, chat, gate, settings,
                    systemPrompt:'You are Nexus regional Tree routing. The Tree is authoritative. Return exact JSON only.',
                    label:`Regional coverage fallback · ${gate.mode} / ${retrievalPlan.mode}`,
                    priority:BUS_PRIORITY.RETRIEVAL,
                    dedupKey:`retrieval-region-broader:${getContext()?.chat?.length||0}:${gate.mode}:${retrievalPlan.mode}`,
                    telemetry:{retrievalPhase:'paging-coverage-fallback'}, scope,
                });
                if (!retrievalAuthorityFresh(scope,executionPolicyKey)) return staleRetrievalResult(scope,gate,'region-fallback-policy');
            }
        }

        regionJob = regionRun.job;
        regionResponse = regionRun.response;
        regionRefs = regionRun.refs;
        regionalReasoning = regionRun.reasoning;
        retrievalDegraded = retrievalDegraded || regionRun.degraded === true;
        logEvent('retrieval', 'region-scan-complete', {
            gate,
            jobId: regionJob?.id || null,
            slot: regionResponse?.tv2?.slot || null,
            slotsUsed: regionRun.slotsUsed || [],
            regionRefs,
            reasoning: regionalReasoning,
            hardLocked: regionResponse?.tv2?.hardLocked === true || String(regionRun?.response?.tv2?.executionMode || '').includes('hard-lock'),
            executionMode: regionRun.batch ? 'batch-scatter' : (regionResponse?.tv2?.executionMode || null),
            batch: regionRun.batch,
            batchCount: regionRun.batchCount,
            completedBatchCount: regionRun.completedCount ?? regionRun.batchCount,
            failedBatchCount: regionRun.failedCount || 0,
            dualIdleScatter: regionRun.dualIdleScatter === true,
            fullEstimatedInputTokens: regionRun.fullEstimatedInputTokens,
            totalBatchedEstimatedInputTokens: regionRun.totalBatchedEstimatedInputTokens,
            maxBatchEstimatedInputTokens: regionRun.maxBatchEstimatedInputTokens || regionRun.fullEstimatedInputTokens,
        }, regionRun.degraded ? 'warn' : 'info');
        reportRetrievalProgress('REGION_READY', 1, 3, { regionCount:regionRefs.length, degraded:regionRun.degraded === true });
    }

    if (!regionRefs.length) {
        // On a MINOR refresh we distrust an empty result and preserve continuity.
        if (reusable() && gate.mode === RETRIEVAL_CHANGE.MINOR_CHANGE && cachedInjectionFitsPolicy(state, currentRetrievalPromptPolicy())) {
            if (!applyPromptForScope(state.lastInjectedText, scope, executionPolicyKey, { refs: state.lastInjectedRefs })) return staleRetrievalResult(scope, gate, 'preserve-reuse');
            pinActiveInjection(state.lastInjectedRefs, 'minor-empty-region-preserve');
            commitGate();
            logEvent('retrieval', 'minor-empty-regions-preserved', { gate, previousRegionRefs: state.lastRegionRefs }, 'warn');
            completeReuseProgress('minor-empty-region-preserve',{entryCount:state.lastInjectedRefs.length});
            return { reused: true, preservedAfterEmptyMinorRegion: true, degraded: retrievalDegraded, gate, regionRefs: state.lastRegionRefs.map(r => ({ ...r })), nodeRefs: state.lastNodeRefs.map(r => ({ ...r })), refs: state.lastInjectedRefs.map(r => ({ ...r })) };
        }
        clearUnavailableInjectionForNewContext({ gate, reason: 'full-routing-no-regions', scope });
        logEvent('retrieval', 'no-regions-selected', { gate, regionJobId: regionJob?.id || null, reasoning: regionalReasoning }, 'info');
        return completeNoInjection('no-regions-selected', { gate, degraded: retrievalDegraded, regionRefs: [], nodeRefs: [], refs: [], regionalReasoning }, { regionCount:0 });
    }

    // PASS 2: Full node scan only inside the selected/reused regions.
    const regionalOverview = formatSelectedRegionOverview(regionRefs, { warmNodeRefs, pinnedNodeRefs, includeSummaries: true });
    if (!regionalOverview.trim()) {
        if (gate.mode === RETRIEVAL_CHANGE.MINOR_CHANGE && reusable() && cachedInjectionFitsPolicy(state, currentRetrievalPromptPolicy())) {
            if (!applyPromptForScope(state.lastInjectedText, scope, executionPolicyKey, { refs: state.lastInjectedRefs })) return staleRetrievalResult(scope, gate, 'preserve-reuse');
            pinActiveInjection(state.lastInjectedRefs, 'minor-unresolved-region-preserve');
            commitGate();
            logEvent('retrieval', 'minor-region-resolution-empty-preserved', { gate, regionRefs }, 'warn');
            completeReuseProgress('minor-region-resolution-empty-preserve',{entryCount:state.lastInjectedRefs.length});
            return { reused: true, degraded: retrievalDegraded, gate, regionRefs: state.lastRegionRefs.map(r => ({ ...r })), nodeRefs: state.lastNodeRefs.map(r => ({ ...r })), refs: state.lastInjectedRefs.map(r => ({ ...r })) };
        }
        clearUnavailableInjectionForNewContext({ gate, regionRefs, reason: 'region-resolution-empty', scope });
        return completeNoInjection('region-resolution-empty', { gate, degraded: retrievalDegraded, regionRefs, nodeRefs: [], refs: [] }, { regionCount:regionRefs.length });
    }
    const buildNodePrompt = partialOverview => buildNodeScanPrompt({ overview: partialOverview, chat, gate, retrievalPlan, pins, warm, regionalReasoning });
    const nodePrompt = buildNodePrompt(regionalOverview);
    logEvent('retrieval', 'node-scan-prepared', {
        gate,
        regionRefs,
        treeChars: regionalOverview.length,
        promptChars: nodePrompt.length,
        pinnedNodeRefs,
        warmNodeRefs,
        batchFireEnabled: settings.retrieval?.batchFireEnabled !== false,
    }, 'debug');
    const nodeDecisionCandidates = listNodeDecisionCandidates(regionRefs, { warmNodeRefs, pinnedNodeRefs });
    const nodeDecisionContext = {
        chatId: scope?.chatId ?? context?.chatId ?? null,
        scene: sceneScan,
        chatRevision: scope?.revision || null,
        needText: chat,
        candidates: nodeDecisionCandidates,
        sourceRevision: currentNexusLoreSourceRevision(books),
    };
    const nodeDecisionSource = buildTreeAdmissionFingerprint(nodeDecisionContext, 'node');
    let nodeAssist = null;
    try {
        nodeAssist = await evaluateRetrievalTreeAdmissionAssist({
            kind: 'node',
            ...nodeDecisionContext,
            sourceFingerprint: nodeDecisionSource,
            mandatoryRefs: nodeDecisionCandidates.filter(row => row.pinned || row.warm).map(({ book, nodeId }) => ({ book, nodeId })),
            readCurrentFreshnessContext: () => ({ ...nodeDecisionContext, scene:getSceneScannerSnapshot({chatId:nodeDecisionContext.chatId}), chatRevision:captureNexusWorkScope(getContext(),{includeRevision:true}).revision, sourceRevision:currentNexusLoreSourceRevision(books) }),
        });
    } catch (error) {
        logEvent('decision-core', 'retrieval-node-assist-error', { error: error?.message || String(error) }, 'warn');
    }
    const nodeRun = nodeAssist?.handled
        ? {
            job: null,
            response: null,
            refs: validateTreeRefs(nodeAssist.refs || [], books),
            reasoning: 'Decision Core Assist selected bounded Tree nodes before worker execution.',
            degraded: false,
            assist: true,
            batch: false,
            batchCount: 0,
            completedCount: 0,
            failedCount: 0,
            slotsUsed: [],
            fullEstimatedInputTokens: 0,
            totalBatchedEstimatedInputTokens: 0,
            maxBatchEstimatedInputTokens: 0,
        }
        : await runTreeSelectionStage({
            kind: 'nodes',
            overview: regionalOverview,
            buildPrompt: buildNodePrompt,
            books,
            chat,
            gate,
            settings,
            systemPrompt: 'You are Nexus regional node retrieval. Select exact nodes only from the supplied regional Tree. Return exact JSON only.',
            label: `Regional node scan · ${gate.mode}`,
            priority: BUS_PRIORITY.RETRIEVAL,
            dedupKey: `retrieval-node:${getContext()?.chat?.length || 0}:${gate.mode}`,
            telemetry: { retrievalPhase: 'node-scan', regionRefs },
            scope,
        });
    if (nodeAssist?.handled) logEvent('decision-core', 'retrieval-node-assist-complete', { candidateCount: nodeDecisionCandidates.length, selectedCount: nodeRun.refs.length, refs: nodeRun.refs, provider: nodeAssist.result?.provider || null, latencyMs: nodeAssist.result?.latencyMs || 0 }, 'info');
    if (!retrievalAuthorityFresh(scope,executionPolicyKey)) return staleRetrievalResult(scope,gate,'node-policy');
    const nodeJob = nodeRun.job;
    const nodeResponse = nodeRun.response;
    const nodeRefs = nodeRun.refs;
    const nodeReasoning = nodeRun.reasoning;
    retrievalDegraded = retrievalDegraded || nodeRun.degraded === true;
    logEvent('retrieval', 'node-scan-complete', {
        gate,
        jobId: nodeJob?.id || null,
        slot: nodeResponse?.tv2?.slot || null,
        slotsUsed: nodeRun.slotsUsed || [],
        regionRefs,
        nodeRefs,
        reasoning: nodeReasoning,
        hardLocked: nodeResponse?.tv2?.hardLocked === true || String(nodeRun?.response?.tv2?.executionMode || '').includes('hard-lock'),
        executionMode: nodeRun.batch ? 'batch-scatter' : (nodeResponse?.tv2?.executionMode || null),
        batch: nodeRun.batch,
        batchCount: nodeRun.batchCount,
        completedBatchCount: nodeRun.completedCount ?? nodeRun.batchCount,
        failedBatchCount: nodeRun.failedCount || 0,
        dualIdleScatter: nodeRun.dualIdleScatter === true,
        fullEstimatedInputTokens: nodeRun.fullEstimatedInputTokens,
        totalBatchedEstimatedInputTokens: nodeRun.totalBatchedEstimatedInputTokens,
        maxBatchEstimatedInputTokens: nodeRun.maxBatchEstimatedInputTokens || nodeRun.fullEstimatedInputTokens,
    }, nodeRun.degraded ? 'warn' : 'info');
    reportRetrievalProgress('NODES_READY', 2, 3, { nodeCount:nodeRefs.length, degraded:nodeRun.degraded === true });

    if (!nodeRefs.length) {
        if (gate.mode === RETRIEVAL_CHANGE.MINOR_CHANGE && reusable() && cachedInjectionFitsPolicy(state, currentRetrievalPromptPolicy())) {
            if (!applyPromptForScope(state.lastInjectedText, scope, executionPolicyKey, { refs: state.lastInjectedRefs })) return staleRetrievalResult(scope, gate, 'preserve-reuse');
            pinActiveInjection(state.lastInjectedRefs, 'minor-empty-node-preserve');
            commitGate();
            logEvent('retrieval', 'minor-empty-nodes-preserved', { gate, regionRefs, previousNodeRefs: state.lastNodeRefs }, 'warn');
            completeReuseProgress('minor-empty-node-preserve',{entryCount:state.lastInjectedRefs.length});
            return { reused: true, preservedAfterEmptyMinorNode: true, degraded: retrievalDegraded, gate, regionRefs: state.lastRegionRefs.map(r => ({ ...r })), nodeRefs: state.lastNodeRefs.map(r => ({ ...r })), refs: state.lastInjectedRefs.map(r => ({ ...r })) };
        }
        clearUnavailableInjectionForNewContext({ gate, regionRefs, reason: 'major-no-nodes', scope });
        return completeNoInjection('major-no-nodes', { gate, degraded: retrievalDegraded, regionRefs, nodeRefs: [], refs: [], regionalReasoning, nodeReasoning }, { regionCount:regionRefs.length, nodeCount:0 });
    }

    // Tree-selected nodes are the primary candidate source. The Scene Anchor
    // guard may add exact, Tree-indexed voice/dynamic leaves for characters
    // explicitly active in the immediate beat; it still cannot inject anything
    // directly and must pass the same final Lore Injection Review.
    const nodeCandidates = await resolveNodeEntries({ books, nodeRefs });
    if (!retrievalAuthorityFresh(scope,executionPolicyKey)) return staleRetrievalResult(scope,gate,'node-entry-policy');
    const unlinkedCandidates = (await searchTree({ query:chat, books, includeContent:true, limit:24 }))
        .filter(row=>row?.unlinked===true);
    if (!retrievalAuthorityFresh(scope,executionPolicyKey)) return staleRetrievalResult(scope,gate,'unlinked-search-or-policy');
    const sceneAnchorRun = settings.smartContext?.sceneAnchorGuard === false
        ? { anchors:[], degraded:false }
        : await deriveSceneAnchorCandidates({ activeCharacters:sceneScan?.acceptedScene?.participants || [], relationshipFocus:sceneScan?.acceptedScene?.relationshipFocus === true, books, gate, scope });
    if (!retrievalAuthorityFresh(scope,executionPolicyKey)) return staleRetrievalResult(scope,gate,'scene-anchor-policy');
    const sceneAnchors = sceneAnchorRun.anchors || [];
    retrievalDegraded = retrievalDegraded || sceneAnchorRun.degraded === true;

    // Resolve the owner-authorized retained subset from live lore before using
    // it. These refs bypass only redundant semantic re-review; they still pass
    // exact Tree/source scope, final candidate validation, render budgeting, and
    // Generation Frame freshness gates.
    const preservedReuseCandidates = retrievalPlan.preserveAuthorizedRefs
        ? await resolveExactPinnedEntries(retrievalPlan.preservedRefs || [], books)
        : [];
    if (!retrievalAuthorityFresh(scope,executionPolicyKey)) return staleRetrievalResult(scope,gate,'reuse-ref-resolution-policy');
    const preservedReuseKeys = new Set(preservedReuseCandidates.map(ref => candidateKey(ref.book, ref.uid)));
    const candidates = dedupeEntryRefs([...preservedReuseCandidates, ...nodeCandidates, ...unlinkedCandidates, ...sceneAnchors]);
    let reviewCandidates = candidates.filter(ref => !preservedReuseKeys.has(candidateKey(ref.book, ref.uid)));
    let candidateAssistRun = null;
    const traversalKeys = new Set(nodeCandidates.map(ref => candidateKey(ref.book, ref.uid)));
    const lexicalKeys = new Set(unlinkedCandidates.map(ref => candidateKey(ref.book, ref.uid)));
    const sceneAnchorKeys = new Set(sceneAnchors.map(ref => candidateKey(ref.book, ref.uid)));
    const vectorKeys = new Set((paging.nominationDetails || []).map(ref => candidateKey(ref.book, ref.uid)));
    const pinnedKeys = new Set(pins.map(ref => candidateKey(ref.book, ref.uid)));
    const warmKeys = new Set(warm.map(ref => candidateKey(ref.book, ref.uid)));
    const diagnosticCandidates = candidates.map((candidate, index) => {
        const key = candidateKey(candidate.book, candidate.uid);
        const discoverySources = [];
        if (preservedReuseKeys.has(key)) discoverySources.push('reuse-authorized');
        if (traversalKeys.has(key)) discoverySources.push('traversal');
        if (lexicalKeys.has(key)) discoverySources.push('lexical');
        if (sceneAnchorKeys.has(key)) discoverySources.push('scene-anchor');
        if (vectorKeys.has(key)) discoverySources.push('vector-wake');
        return {
            book: candidate.book, uid: Number(candidate.uid), title: candidate.title || '', content: candidate.content || '',
            nodeId: candidate.nodeId || null, nodeLabel: candidate.nodeLabel || null, path: candidate.path || null,
            baselineRank: index + 1, discoverySources,
            warm: warmKeys.has(key), pinned: pinnedKeys.has(key), residency: loreEntryResidencyStatus(candidate.book, candidate.uid),
            selected: false, published: false,
        };
    });
    const candidateShadowSource = buildCandidateShadowFingerprint({
        chatId: scope?.chatId ?? context?.chatId ?? null,
        scene: sceneScan,
        chatRevision: scope?.revision || null,
        needText: chat,
        books,
        candidates: diagnosticCandidates,
    });
    recordRetrievalCandidateDiagnostics({
        chatId: scope?.chatId ?? context?.chatId ?? null,
        candidates: diagnosticCandidates.map(({ content, ...row }) => row),
        sceneRevision: sceneScan?.scanRevision || null,
        gateMode: semanticGate?.mode || gate?.mode || null,
        sourceFingerprint: candidateShadowSource,
    });
    const dirtyDiagnosticCandidates = diagnosticCandidates.filter(row => !preservedReuseKeys.has(candidateKey(row.book,row.uid)));
    if (dirtyDiagnosticCandidates.length) {
        try {
            candidateAssistRun = await evaluateRetrievalCandidateAdmissionAssist({
                chatId: scope?.chatId ?? context?.chatId ?? null,
                scene: sceneScan,
                chatRevision: scope?.revision || null,
                needText: chat,
                books,
                candidates: dirtyDiagnosticCandidates,
                sourceFingerprint: buildCandidateShadowFingerprint({ chatId: scope?.chatId ?? context?.chatId ?? null, scene: sceneScan, chatRevision: scope?.revision || null, needText: chat, books, candidates: dirtyDiagnosticCandidates }),
                readCurrentChatRevision: () => captureNexusWorkScope(getContext(), { includeRevision:true }).revision,
            });
            if (candidateAssistRun?.handled) {
                const selectedKeys = new Set((candidateAssistRun.selected||[]).map(row=>candidateKey(row.book,row.uid)));
                for (const ref of reviewCandidates) {
                    const key=candidateKey(ref.book,ref.uid);
                    if (pins.some(pin=>candidateKey(pin.book,pin.uid)===key) || sceneAnchors.some(anchor=>candidateKey(anchor.book,anchor.uid)===key)) selectedKeys.add(key);
                }
                reviewCandidates = reviewCandidates.filter(ref=>selectedKeys.has(candidateKey(ref.book,ref.uid)));
                logEvent('decision-core','retrieval-candidate-assist-complete',{
                    candidateCount:dirtyDiagnosticCandidates.length,
                    selectedCount:reviewCandidates.length,
                    jevSelectedCount:candidateAssistRun.jevSelected?.length||0,
                    unresolvedCount:candidateAssistRun.unresolved?.length||0,
                    prunedCount:candidateAssistRun.prunedCount||0,
                    decisionCalls:candidateAssistRun.decisionCalls||0,
                    chunkCount:candidateAssistRun.chunkCount||0,
                    validChunkCount:candidateAssistRun.validChunkCount||0,
                    unresolvedChunkCount:candidateAssistRun.unresolvedChunkCount||0,
                    selected:reviewCandidates.map(({book,uid,title})=>({book,uid,title}))
                },candidateAssistRun.unresolved?.length?'warn':'info');
            }
        } catch (error) {
            candidateAssistRun = null;
            logEvent('decision-core','retrieval-candidate-assist-error',{error:error?.message||String(error)},'warn');
        }
    }
    if (sceneAnchors.length) logEvent('retrieval', 'scene-anchor-candidates', {
        gate,
        count: sceneAnchors.length,
        anchors: sceneAnchors.map(({ book, uid, title, anchorCharacter, anchorKind, nodeId, nodeLabel }) => ({ book, uid, title, anchorCharacter, anchorKind, nodeId, nodeLabel })),
    }, 'info');
    logEvent('retrieval', 'injection-candidates-resolved', {
        gate,
        regionRefs,
        nodeRefs,
        candidateCount: candidates.length,
        preservedReuseCount: preservedReuseCandidates.length,
        dirtyReviewCandidateCount: reviewCandidates.length,
        requestedReuseCount: retrievalPlan.preservedRefs?.length || 0,
        reuseRatio: reusePlan.reuseRatio,
        pinnedCandidateCount: candidates.filter(c => pins.some(p => candidateKey(p.book,p.uid) === candidateKey(c.book,c.uid))).length,
        warmCandidateCount: candidates.filter(c => warm.some(w => candidateKey(w.book,w.uid) === candidateKey(c.book,c.uid))).length,
        sceneAnchorCount: sceneAnchors.length,
        unlinkedCandidateCount: unlinkedCandidates.length,
        candidates: candidates.map(({ book, uid, title, nodeId, nodeLabel }) => ({ book, uid, title, nodeId, nodeLabel })),
    }, 'info');

    if (!candidates.length) {
        if (gate.mode === RETRIEVAL_CHANGE.MINOR_CHANGE && reusable() && cachedInjectionFitsPolicy(state, currentRetrievalPromptPolicy())) {
            if (!applyPromptForScope(state.lastInjectedText, scope, executionPolicyKey, { refs: state.lastInjectedRefs })) return staleRetrievalResult(scope, gate, 'preserve-reuse');
            pinActiveInjection(state.lastInjectedRefs, 'minor-empty-candidates-preserve');
            commitGate();
            logEvent('retrieval', 'minor-empty-candidates-preserved', { gate, regionRefs, nodeRefs }, 'warn');
            completeReuseProgress('minor-empty-candidates-preserve',{entryCount:state.lastInjectedRefs.length});
            return { reused: true, degraded: retrievalDegraded, gate, regionRefs: state.lastRegionRefs.map(r => ({ ...r })), nodeRefs: state.lastNodeRefs.map(r => ({ ...r })), refs: state.lastInjectedRefs.map(r => ({ ...r })) };
        }
        clearUnavailableInjectionForNewContext({ gate, regionRefs, nodeRefs, reason: 'major-no-candidates', scope });
        return completeNoInjection('major-no-candidates', { gate, degraded: retrievalDegraded, regionRefs, nodeRefs, refs: [] }, { regionCount:regionRefs.length, nodeCount:nodeRefs.length });
    }

    // Final Sidecar stage: exact entry selection from Tree-constrained candidates.
    // Lore Injection gets first claim on the next free worker once its candidate
    // pool exists. Oversized reviews may use the same A+B scatter/gather primitive.
    // Decision Core is admission authority only. Jev may reduce the expensive
    // candidate pool, but final lore-selection authority remains with the
    // existing Lore Injection worker/validator pipeline.
    const injectionRun = reviewCandidates.length
        ? await runInjectionReview({
            candidates: reviewCandidates,
            regionalReasoning,
            nodeReasoning,
            gate,
            retrievalPlan,
            previousRefs: state.lastInjectedRefs,
            pins,
            warm,
            sceneAnchors,
            settings,
            telemetry: {
                retrievalPhase: 'lore-injection',
                regionRefs,
                nodeRefs,
                reuseRatio: reusePlan.reuseRatio,
                preservedReuseCount: preservedReuseCandidates.length,
                dirtyReviewCandidateCount: reviewCandidates.length,
            },
            scope,
        })
        : {
            job: { id:null },
            response: null,
            requested: [],
            selected: [],
            reasoning: 'All retained Retrieval refs have current owner authority; no dirty injection candidates require semantic re-review.',
            degraded: false,
            coverageIncomplete: false,
            batch: false,
            batchCount: 0,
            slotsUsed: [],
            fullEstimatedInputTokens: 0,
        };
    if (!retrievalAuthorityFresh(scope,executionPolicyKey)) return staleRetrievalResult(scope,gate,'injection-review-policy');
    const injectionJob = injectionRun.job || { id:null };
    const injectionResponse = injectionRun.response;
    const requested = injectionRun.requested || [];
    let selectedCandidates = dedupeEntryRefs([...preservedReuseCandidates, ...(injectionRun.selected || [])]);
    const injectionReasoning = String(injectionRun.reasoning || '');
    retrievalDegraded = retrievalDegraded || injectionRun.degraded === true;

    if (injectionRun.coverageIncomplete === true) {
        if (gate.mode === RETRIEVAL_CHANGE.MINOR_CHANGE && reusable() && cachedInjectionFitsPolicy(state, currentRetrievalPromptPolicy())) {
            if (!applyPromptForScope(state.lastInjectedText, scope, executionPolicyKey, { refs: state.lastInjectedRefs })) return staleRetrievalResult(scope, gate, 'preserve-reuse');
            pinActiveInjection(state.lastInjectedRefs, 'minor-incomplete-review-preserve');
            commitGate();
            logEvent('retrieval', 'incomplete-review-preserved-previous', {
                gate,
                failedSlices: injectionRun.unrecoverableFailedSlices || [],
                previousRefs: state.lastInjectedRefs,
            }, 'warn');
            completeReuseProgress('minor-incomplete-review-preserve',{entryCount:state.lastInjectedRefs.length,degraded:true});
            return {
                reused: true,
                preservedAfterIncompleteReview: true,
                degraded: true,
                gate,
                regionRefs: state.lastRegionRefs.map(r => ({ ...r })),
                nodeRefs: state.lastNodeRefs.map(r => ({ ...r })),
                refs: state.lastInjectedRefs.map(r => ({ ...r })),
            };
        }
        clearUnavailableInjectionForNewContext({ gate, regionRefs, nodeRefs, reason: 'degraded-review-coverage-incomplete', scope });
        logEvent('retrieval', 'degraded-replacement-coverage-rejected', {
            gate,
            failedSlices: injectionRun.unrecoverableFailedSlices || [],
            successfulSelectionCount: selectedCandidates.length,
            successfulRefs: selectedCandidates.map(({ book, uid, title }) => ({ book, uid, title })),
        }, 'warn');
        return completeNoInjection('degraded-review-coverage-incomplete', {
            gate,
            degraded: true,
            regionRefs,
            nodeRefs,
            refs: [],
            requested,
            regionalReasoning,
            nodeReasoning,
            injectionReasoning,
        }, { regionCount:regionRefs.length, nodeCount:nodeRefs.length });
    }

    // Successful Sidecar selections still must pass one final exact candidate-set
    // validation before they can become the authoritative Nexus prompt. Failed
    // slices never contribute entries merely because they were PASS-2 candidates.
    const authoritative = validateAuthoritativeSelection(candidates, selectedCandidates);
    if (!authoritative.valid) {
        const error = new Error('Final lore injection selection escaped the supplied candidate set.');
        error.name = 'NexusSemanticValidationError';
        error.semantic = true;
        error.validation = { invalid: authoritative.invalid };
        throw error;
    }
    const authoritativeVerdict = entrySelectionValidator(candidates)({
        entries: authoritative.selected.map(({ book, uid }) => ({ book, uid })),
        reasoning: injectionReasoning,
    });
    if (!authoritativeVerdict?.valid) {
        const error = new Error(`Final lore injection selection failed semantic validation: ${authoritativeVerdict?.reason || 'invalid selection'}`);
        error.name = 'NexusSemanticValidationError';
        error.semantic = true;
        error.validation = authoritativeVerdict;
        throw error;
    }
    selectedCandidates = authoritative.selected;

    if (!selectedCandidates.length && emptyReplacementDisposition({ gateMode: gate.mode, hasReusable: reusable() }) === 'reuse-previous' && cachedInjectionFitsPolicy(state, currentRetrievalPromptPolicy())) {
        if (!applyPromptForScope(state.lastInjectedText, scope, executionPolicyKey, { refs: state.lastInjectedRefs })) return staleRetrievalResult(scope, gate, 'preserve-reuse');
        pinActiveInjection(state.lastInjectedRefs, 'minor-empty-injection-preserve');
        commitGate();
        logEvent('retrieval', 'minor-injection-empty-preserved', {
            gate,
            injectionJobId: injectionJob?.id || null,
            previousRefs: state.lastInjectedRefs,
            reasoning: injectionReasoning,
        }, 'warn');
        completeReuseProgress('minor-injection-empty-preserve',{entryCount:state.lastInjectedRefs.length});
        return { reused: true, preservedAfterEmptyMinorInjection: true, degraded: retrievalDegraded, gate, regionRefs: state.lastRegionRefs.map(r => ({ ...r })), nodeRefs: state.lastNodeRefs.map(r => ({ ...r })), refs: state.lastInjectedRefs.map(r => ({ ...r })) };
    }

    if (!selectedCandidates.length) {
        clearUnavailableInjectionForNewContext({ gate, regionRefs, nodeRefs, reason: 'no-valid-nexus-replacement', scope });
        return completeNoInjection('no-valid-nexus-replacement', {
            gate,
            degraded: retrievalDegraded || injectionRun.degraded === true,
            regionRefs,
            nodeRefs,
            refs: [],
            requested,
            regionalReasoning,
            nodeReasoning,
            injectionReasoning,
        }, { regionCount:regionRefs.length, nodeCount:nodeRefs.length });
    }

    logEvent('retrieval', 'injection-review-complete', {
        gate,
        injectionJobId: injectionJob?.id || null,
        injectionSlot: injectionResponse?.tv2?.slot || null,
        requestedCount: requested.length,
        selectedCount: selectedCandidates.length,
        selected: selectedCandidates.map(({ book, uid, title, nodeId, nodeLabel }) => ({ book, uid, title, nodeId, nodeLabel })),
        reasoning: injectionReasoning,
        hardLocked: injectionResponse?.tv2?.hardLocked === true,
        batch: injectionRun.batch === true,
        batchCount: injectionRun.batchCount || 1,
        slotsUsed: injectionRun.slotsUsed || (injectionResponse?.tv2?.slot ? [injectionResponse.tv2.slot] : []),
        fullEstimatedInputTokens: injectionRun.fullEstimatedInputTokens,
    }, 'info');

    if (!retrievalAuthorityFresh(scope,executionPolicyKey)) return staleRetrievalResult(scope, gate, 'pre-final-validation');
    if (!await paging.validate() || !retrievalAuthorityFresh(scope,executionPolicyKey)) return staleRetrievalResult(scope,gate,'paging-source-or-policy-changed');
    if (!isNexusWorkScopeFresh(scope, getContext())) return staleRetrievalResult(scope, gate, 'final-injection');
    const finalPolicy = currentRetrievalPromptPolicy();
    if (!finalPolicy.enabled) {
        clearRetrieval({ clearState:true, generationId:scope?.generationId ?? generationId, force:true });
        pinActiveInjection([], 'retrieval-disabled-before-commit');
        logEvent('retrieval','commit-revoked-by-live-policy',{gate,phase:'final-injection',reason:'retrieval-disabled'},'warn');
        return { skipped:true, deferred:true, reason:'retrieval-disabled-before-commit', gate, regionRefs, nodeRefs, refs:[] };
    }
    const presentationScopeKey=`${String(scope?.chatId??context?.chatId??'')}|${String(scope?.epoch??'')}|${String(finalPolicy.mainProvider||'unknown-provider')}|${String(finalPolicy.mainModel||'unknown-model')}`;
    const rendered = renderInjection(selectedCandidates, finalPolicy.budgetTokens, finalPolicy.mainModel, {presentationScopeKey,presentationStrategy:finalPolicy.loreOrderPolicy});
    const injectedCandidates = rendered.includedCandidates || [];
    if(rendered.presentationFallbackReason)logEvent('retrieval','presentation-cache-fallback',{generationId:scope?.generationId??generationId,reason:rendered.presentationFallbackReason,requestedStrategy:rendered.presentationRequestedStrategy,appliedStrategy:rendered.presentationStrategy,selectedCount:selectedCandidates.length,includedCount:injectedCandidates.length},'warn');
    const requiredDegradedMajor = gate.mode === RETRIEVAL_CHANGE.MAJOR_CHANGE && retrievalDegraded === true
        ? selectedCandidates
        : [];
    const requiredDegradedSelection = injectionRun.degraded === true ? selectedCandidates : requiredDegradedMajor;
    const missingDegradedSelection = missingRequiredCandidates(injectedCandidates, requiredDegradedSelection);
    if (missingDegradedSelection.length) {

        clearUnavailableInjectionForNewContext({ gate, regionRefs, nodeRefs, reason: 'degraded-major-render-incomplete', scope });
        logEvent('retrieval', 'degraded-major-replacement-rejected', {
            gate,
            selectedCount: selectedCandidates.length,
            renderedCount: injectedCandidates.length,
            missingCount: missingDegradedSelection.length,
            missingRefs: missingDegradedSelection.map(({ book, uid, title }) => ({ book, uid, title })),
            optionalInjectionBudgetTokens: finalPolicy.budgetTokens > 0 ? finalPolicy.budgetTokens : null,
            mainModel: finalPolicy.mainModel || null,
        }, 'warn');
        return completeNoInjection('degraded-major-render-incomplete', {
            gate,
            degraded: true,
            regionRefs,
            nodeRefs,
            refs: [],
            requested,
            regionalReasoning,
            nodeReasoning,
            injectionReasoning,
        }, { regionCount:regionRefs.length, nodeCount:nodeRefs.length });
    }
    if (selectedCandidates.length && !injectedCandidates.length) {
        if (gate.mode === RETRIEVAL_CHANGE.MINOR_CHANGE && hasReusableInjection({books}) && cachedInjectionFitsPolicy(state, currentRetrievalPromptPolicy())) {
            if (!applyPromptForScope(state.lastInjectedText, scope, executionPolicyKey, { refs: state.lastInjectedRefs })) return staleRetrievalResult(scope, gate, 'preserve-reuse');
            pinActiveInjection(state.lastInjectedRefs, 'minor-injection-budget-preserve');
            commitGate();
            acknowledgeWarmReview('minor-injection-budget-preserved');
            completeReuseProgress('minor-injection-budget-preserve',{entryCount:state.lastInjectedRefs.length,degraded:true});
            return { reused:true, preservedAfterInjectionBudget:true, degraded:true, gate, regionRefs:state.lastRegionRefs.map(r=>({...r})), nodeRefs:state.lastNodeRefs.map(r=>({...r})), refs:state.lastInjectedRefs.map(r=>({...r})) };
        }
        clearUnavailableInjectionForNewContext({ gate, regionRefs, nodeRefs, reason:'injection-budget-insufficient', scope });
        acknowledgeWarmReview('injection-budget-insufficient');
        return completeNoInjection('injection-budget-insufficient', {gate,degraded:true,regionRefs,nodeRefs,refs:[],requested,regionalReasoning,nodeReasoning,injectionReasoning}, { regionCount:regionRefs.length, nodeCount:nodeRefs.length });
    }
    const refs = injectedCandidates.map(({ book, uid, title, nodeId, nodeLabel, path }) => ({ book, uid, title, nodeId, nodeLabel, path }));
    const text = rendered.text;
    if (!applyPromptForScope(text, scope, executionPolicyKey, { refs })) return staleRetrievalResult(scope, gate, 'final-injection');
    const estimatedInjectionTokens = estimateContentTokens(text, finalPolicy.mainModel);
    if (!retrievalAuthorityFresh(scope,executionPolicyKey)) {
        clearPrompt({ generationId: scope?.generationId ?? generationId });
        return staleRetrievalResult(scope, gate, 'state-commit');
    }
    const pendingBeforeCommit = getPendingWarmContextRefresh();
    if (!isNexusWorkScopeFresh(scope, getContext())) return staleRetrievalResult(scope, gate, 'state-commit');
    rememberSuccessfulRetrieval({ text, refs, nodeRefs, regionRefs, gate, budgetTokens:finalPolicy.budgetTokens, model:finalPolicy.mainModel, provider:finalPolicy.mainProvider, loreOrderPolicy:finalPolicy.loreOrderPolicy, books });
    // Diagnostics must never become a Retrieval execution dependency. Compare
    // only after this exact publication has passed freshness and semantic-state
    // commit so stale/rolled-back work cannot poison the next cache sample.
    const presentationCacheShadow=typeof observeLorePresentationCache==='function'
        ? observeLorePresentationCache({scopeKey:presentationScopeKey,currentCandidates:injectedCandidates,presentedCandidates:rendered.presentedCandidates,currentText:text,baselineText:rendered.canonicalText,model:finalPolicy.mainModel})
        : null;
    if(presentationCacheShadow)logEvent('retrieval','presentation-cache-analysis',{...presentationCacheShadow,gateMode:gate.mode,mainModel:finalPolicy.mainModel||null,mainProvider:finalPolicy.mainProvider||null,presentationStrategy:rendered.presentationStrategy,presentationMode:rendered.presentationStrategy==='stable-survivors-append'?'active':'shadow'},presentationCacheShadow.realizedGainTokens>0||presentationCacheShadow.potentialGainTokens>0?'info':'debug');
    commitGate();
    markLorePagingUsed(refs,{probeId:paging.probeId,stage:'final-injection',selectedRefs:selectedCandidates});
    if (pendingBeforeCommit && !getPendingWarmContextRefresh()) {

        logEvent('retrieval', 'warm-drift-review-acknowledged', {
            signature: pendingBeforeCommit.signature,
            reason: 'successful-retrieval',
            desiredCount: pendingBeforeCommit.desiredRefs.length,
            missingCount: pendingBeforeCommit.missingRefs.length,
        }, 'debug');
    }
    pinActiveInjection(refs, 'live-injection');

    recordRetrievalPublicationDiagnostics({
        chatId: scope?.chatId ?? context?.chatId ?? null,
        sceneRevision: sceneScan?.scanRevision || null,
        gateMode: semanticGate?.mode || gate?.mode || null,
        selectedRefs: selectedCandidates.map(({ book, uid, title, nodeId, nodeLabel, path }) => ({ book, uid, title, nodeId, nodeLabel, path })),
        publishedRefs: refs,
        estimatedInjectionTokens,
        budgetTokens: finalPolicy.budgetTokens > 0 ? finalPolicy.budgetTokens : null,
        degraded: retrievalDegraded || injectionRun.degraded === true,
        publicationAuthority: 'generation-frame',
        presentationStrategy:rendered.presentationStrategy,
        presentationHasPrior:rendered.presentationHasPrior===true,
    });

    logEvent('retrieval', 'injection-complete', {
        gate,
        regionJobId: regionJob?.id || null,
        nodeJobId: nodeJob?.id || null,
        injectionJobId: injectionJob?.id || null,
        regionSlot: regionResponse?.tv2?.slot || null,
        nodeSlot: nodeResponse?.tv2?.slot || null,
        injectionSlot: injectionResponse?.tv2?.slot || null,
        regionRefs,
        nodeRefs,
        refs,
        entryCount: refs.length,
        selectedCount: selectedCandidates.length,
        renderedEntryCount: refs.length,
        chars: text.length,
        estimatedInjectionTokens,
        optionalInjectionBudgetTokens: finalPolicy.budgetTokens > 0 ? finalPolicy.budgetTokens : null,
        mainModel: finalPolicy.mainModel || null,
        mainProvider: finalPolicy.mainProvider || null,
        presentationStrategy:rendered.presentationStrategy,
        presentationHasPrior:rendered.presentationHasPrior===true,
        budgetApplied: rendered.budgetApplied,
        budgetOmittedEntries: rendered.omitted,
        regionalReasoning,
        nodeReasoning,
        injectionReasoning,
    }, 'info');
    reportRetrievalProgress('INJECTION_READY', 3, 3, { entryCount:refs.length, estimatedInjectionTokens });
    recordWarmInjectionUtilization({
        warmRefs: warm,
        injectedRefs: refs,
        reused: false,
        generationId,
        sceneRevision: gate?.sceneRevision || null,
        gateMode: gate?.mode || null,
        source: 'injection-complete',
    });
    console.log(`[Nexus] ${gate.mode}: ${regionRefs.length} region(s) → ${nodeRefs.length} node(s) → ${refs.length} injected lore entr${refs.length === 1 ? 'y' : 'ies'}`);
    return {
        gate,
        degraded: retrievalDegraded,
        regionRefs,
        nodeRefs,
        refs,
        regionalReasoning,
        nodeReasoning,
        injectionReasoning,
        chars: text.length,
        estimatedInjectionTokens,
        regionJobId: regionJob?.id || null,
        nodeJobId: nodeJob?.id || null,
        injectionJobId: injectionJob?.id || null,
    };
}

export function clearRetrieval({ clearState = true, generationId = null, force = false } = {}) {
    if (!clearPrompt({ generationId, force })) return false;
    if (clearState) clearRetrievalState();
    logEvent('retrieval', 'injection-cleared', { clearState, generationId }, 'debug');
    return true;
}
