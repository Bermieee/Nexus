export function projectNexusCandidateMetadata(rows=[]){
 const refs=value=>(Array.isArray(value)?value:[]).slice(0,24).map(x=>String(x).slice(0,512));
 return (Array.isArray(rows)?rows:[]).slice(0,96).map(row=>({
  candidateId:String(row.candidateId??row.id??'').slice(0,512),evidenceIdentity:row.evidenceIdentity==null?null:String(row.evidenceIdentity).slice(0,512),
  sourceRevisionRefs:refs(row.sourceRevisionRefs??row.sourceRevisionIds),evidenceRefs:refs(row.evidenceRefs),claimRefs:refs(row.claimRefs),
  channelNominations:(row.channelNominations??[]).slice(0,12).map(x=>({channelId:String(typeof x==='string'?x:x.channelId??'').slice(0,128)})),
  graphMetadata:(row.graphMetadata??[]).slice(0,24).map(x=>Object.fromEntries(['graphProvider','graphOwner','edgeId'].filter(k=>x[k]!=null).map(k=>[k,String(x[k]).slice(0,512)]))),
 }));
}

const MAX_HISTORY = 24;
const MAX_CANDIDATES = 80;
const stateByChat = new Map();
const graphTraversals = new Map();
const graphInspectionPlans = new Map();

// Retain bounded, exact-generation evidence independently of the live graph.
// Never retain the retrieval query, source bodies or provider payloads here.
export function recordGraphTraversalDiagnostics({chatId=null,generationId=null,receipt=null,inspection=null}={}){
    if(chatId==null||generationId==null||receipt?.kind!=='GraphTraversalReceipt')return null;
    const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!=null&&['string','number','boolean'].includes(typeof value[k])).map(k=>[k,typeof value[k]==='string'?value[k].slice(0,512):value[k]]));
    const refs=value=>(Array.isArray(value)?value:[]).slice(0,24).map(x=>String(x).slice(0,512));
    const edge=value=>({...pick(value,['providerId','owner','sourceKind','edgeId','fromEntityId','toEntityId','edgeMeaning','temporalStatus','authorityClass','artifactRevision','providerRevision']),sourceRevisionRefs:refs(value?.sourceRevisionRefs),provenanceRefs:refs(value?.provenanceRefs)});
    const result={...pick(receipt,['kind','contractVersion','intentId','providerCount','examinedEdgeCount','traversedEdgeCount','visitedNodeCount','nominationCount','staleRejectedCount','noWorkReason','budgetPolicy','elapsedMs','latencyBudgetExceeded']),
        chatId:String(chatId),generationId:String(generationId),turnId:String(generationId),
        providers:(receipt.providers??[]).slice(0,16).map(value=>pick(value,['providerId','status','edgeCount','rejectedStale','providerRevision'])),
        referenceSummary:(receipt.referenceSummary??[]).slice(0,32).map(edge),
        staleRejected:(receipt.staleRejected??[]).slice(0,32).map(edge),
        sourceRevisionRefs:refs(receipt.trustedSourceRevisionRefs),authority:{graphMutation:false,truth:false,settlement:false,contextSeal:false}};
    const id=JSON.stringify([result.chatId,result.generationId]);graphTraversals.delete(id);graphTraversals.set(id,clone(result));
    graphInspectionPlans.delete(id);
    if(inspection&&(inspection.books??[]).length<=24&&(inspection.sourceRevisionRefs??[]).every(ref=>String(ref).length<=512))graphInspectionPlans.set(id,{intentKind:String(inspection.intentKind??'CURRENT').slice(0,128),anchorEntityIds:refs(inspection.anchorEntityIds),anchorCount:(inspection.anchorEntityIds??[]).length,books:refs(inspection.books),sourceRevisionRefs:refs(inspection.sourceRevisionRefs),worldRevision:Number(inspection.worldRevision)});
    while(graphTraversals.size>32){const first=graphTraversals.keys().next().value;graphTraversals.delete(first);graphInspectionPlans.delete(first);}
    return clone(result);
}
export function readWorldGraphReferenceDiagnostics(selection={}, {readReferences,isCurrent}={}){
    const receipt=readGraphTraversalDiagnostics(selection);if(!receipt)return null;
    const plan=graphInspectionPlans.get(JSON.stringify([receipt.chatId,receipt.generationId]));
    if(!plan||typeof isCurrent!=='function'||typeof readReferences!=='function'||!isCurrent(clone(plan)))return null;
    const raw=readReferences(clone(plan));if(!raw||!isCurrent(clone(plan)))return null;
    // The inspector receives metadata only, even if an owner adds body fields.
    const edge=row=>({...Object.fromEntries(['providerId','owner','sourceKind','edgeId','fromEntityId','toEntityId','edgeMeaning','temporalStatus','authorityClass','artifactRevision','providerRevision'].filter(k=>row?.[k]!=null&&['string','number','boolean'].includes(typeof row[k])).map(k=>[k,typeof row[k]==='string'?row[k].slice(0,512):row[k]])),...Object.fromEntries(['sourceRevisionRefs','identityRevisionRefs','dependencyRevisionRefs','provenanceRefs','evidenceRefs'].map(k=>[k,(row?.[k]??[]).slice(0,24).map(x=>String(x).slice(0,512))]))});
    return {...selection,chatId:receipt.chatId,generationId:receipt.generationId,turnId:receipt.turnId,observationClass:'ON_DEMAND_REVISION_FENCED_REFERENCE_READ',referenceSet:{kind:'WorldGraphReferenceSet',intentKind:plan.intentKind,edges:(raw.edges??[]).slice(0,32).map(edge),revisionFence:{worldRevision:plan.worldRevision,sourceRevisionSet:clone(plan.sourceRevisionRefs)},limits:clone(raw.limits??{}),boundedOut:{...clone(raw.boundedOut??{}),anchors:Math.max(0,plan.anchorCount-plan.anchorEntityIds.length),displayEdges:Math.max(0,(raw.edges??[]).length-32)},readOnly:true,rawSourceContentIncluded:false,authority:{graphMutation:false,truth:false,settlement:false,contextSeal:false}}};
}
export function readGraphTraversalDiagnostics({chatId=null,generationId=null,turnId=null}={}){
    if(chatId==null||generationId==null||(turnId!=null&&String(turnId)!==String(generationId)))return null;
    return clone(graphTraversals.get(JSON.stringify([String(chatId),String(generationId)]))??null);
}

function clone(value) {
    if (value == null) return value;
    try { return structuredClone(value); } catch {}
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}
function key(chatId) { return chatId == null ? 'none' : String(chatId); }
function row(chatId) {
    const id = key(chatId);
    let state = stateByChat.get(id);
    if (!state) {
        state = { chatId: chatId ?? null, candidates: [], candidateSourceFingerprint: null, gateSourceFingerprint: null, gateShadow: null, publication: null, history: [], updatedAt: 0 };
        stateByChat.set(id, state);
    }
    return state;
}
function pushHistory(state, event) {
    state.history.push({ at: Date.now(), ...clone(event) });
    if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
}

export function recordRetrievalCandidateDiagnostics({ chatId = null, candidates = [], sceneRevision = null, gateMode = null, sourceFingerprint = null } = {}) {
    const state = row(chatId);
    state.candidates = (Array.isArray(candidates) ? candidates : []).slice(0, MAX_CANDIDATES).map(candidate => clone(candidate));
    state.candidateSourceFingerprint = sourceFingerprint || null;
    state.updatedAt = Date.now();
    pushHistory(state, { type: 'candidate-baseline', sceneRevision, gateMode, sourceFingerprint, count: state.candidates.length });
    return getRetrievalDiagnosticsSnapshot({ chatId });
}

export function recordRetrievalCandidateShadow({ chatId = null, sourceFingerprint = null, rows = [], status = 'complete', error = null } = {}) {
    const state = row(chatId);
    if (state.candidateSourceFingerprint && sourceFingerprint && String(state.candidateSourceFingerprint) !== String(sourceFingerprint)) {
        pushHistory(state, { type: 'candidate-shadow-discarded', sourceFingerprint, status, reason: 'newer-candidate-baseline-active' });
        return getRetrievalDiagnosticsSnapshot({ chatId });
    }
    const shadowByKey = new Map((Array.isArray(rows) ? rows : []).map(item => [`${item.book}\u0000${Number(item.uid)}`, item]));
    state.candidates = state.candidates.map(candidate => {
        const shadow = shadowByKey.get(`${candidate.book}\u0000${Number(candidate.uid)}`);
        return shadow ? { ...candidate, shadow: clone(shadow) } : candidate;
    });
    state.updatedAt = Date.now();
    pushHistory(state, { type: 'candidate-shadow', sourceFingerprint, status, count: rows?.length || 0, error: error ? String(error) : null });
    return getRetrievalDiagnosticsSnapshot({ chatId });
}

export function recordChangeGateShadowDiagnostics({ chatId = null, current = null, shadow = null, agreement = null, sourceFingerprint = null, status = 'complete', error = null } = {}) {
    const state = row(chatId);
    if (status !== 'pending' && state.gateSourceFingerprint && sourceFingerprint && String(state.gateSourceFingerprint) !== String(sourceFingerprint)) {
        pushHistory(state, { type: 'change-gate-shadow-discarded', sourceFingerprint, status, reason: 'newer-gate-baseline-active' });
        return getRetrievalDiagnosticsSnapshot({ chatId });
    }
    state.gateSourceFingerprint = sourceFingerprint || state.gateSourceFingerprint || null;
    state.gateShadow = { current, shadow: clone(shadow), agreement, sourceFingerprint, status, error: error ? String(error) : null, updatedAt: Date.now() };
    state.updatedAt = Date.now();
    pushHistory(state, { type: 'change-gate-shadow', current, shadow: shadow?.classification || null, agreement, sourceFingerprint, status });
    return getRetrievalDiagnosticsSnapshot({ chatId });
}

export function recordRetrievalPublicationDiagnostics({ chatId = null, sceneRevision = null, gateMode = null, selectedRefs = [], publishedRefs = [], estimatedInjectionTokens = 0, budgetTokens = null, degraded = false, publicationAuthority = 'generation-frame' } = {}) {
    const state = row(chatId);
    const published = new Set((publishedRefs || []).map(ref => `${ref.book}\u0000${Number(ref.uid)}`));
    const selected = new Set((selectedRefs || []).map(ref => `${ref.book}\u0000${Number(ref.uid)}`));
    state.candidates = state.candidates.map(candidate => {
        const candidateId = `${candidate.book}\u0000${Number(candidate.uid)}`;
        return { ...candidate, selected: selected.has(candidateId), published: published.has(candidateId) };
    });
    state.publication = {
        sceneRevision, gateMode,
        selectedCount: selected.size,
        publishedCount: published.size,
        selectedRefs: clone(selectedRefs || []),
        publishedRefs: clone(publishedRefs || []),
        estimatedInjectionTokens: Math.max(0, Number(estimatedInjectionTokens) || 0),
        budgetTokens: budgetTokens == null ? null : Math.max(0, Number(budgetTokens) || 0),
        degraded: degraded === true,
        publicationAuthority,
        updatedAt: Date.now(),
    };
    state.updatedAt = Date.now();
    pushHistory(state, { type: 'publication', ...state.publication });
    return getRetrievalDiagnosticsSnapshot({ chatId });
}

export function getRetrievalDiagnosticsSnapshot({ chatId = null } = {}) {
    if (chatId != null) return clone(stateByChat.get(key(chatId)) || { chatId, candidates: [], candidateSourceFingerprint: null, gateSourceFingerprint: null, gateShadow: null, publication: null, history: [], updatedAt: 0 });
    const latest = [...stateByChat.values()].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
    return clone(latest || { chatId: null, candidates: [], candidateSourceFingerprint: null, gateSourceFingerprint: null, gateShadow: null, publication: null, history: [], updatedAt: 0 });
}

export function clearRetrievalDiagnostics({ chatId = null } = {}) {
    for(const [id,receipt] of graphTraversals)if(chatId==null||String(receipt.chatId)===String(chatId)){graphTraversals.delete(id);graphInspectionPlans.delete(id);}
    if (chatId == null) stateByChat.clear();
    else stateByChat.delete(key(chatId));
}
