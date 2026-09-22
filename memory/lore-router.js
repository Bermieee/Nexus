import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { getActiveBooks } from '../lore/active-books.js';
import { loadBook, findEntryByUid } from '../lore/store.js';
import { searchTree, formatRegionOverview } from '../retrieval/search-engine.js';
import { getTree } from '../tree/store.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import { validateMutationEnvelope } from '../sidecar/semantic-validation.js';
import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { enqueueNexusSidecarJob, NEXUS_BATCH_DOMAIN, structuredSidecarOptions } from '../nexus/batch-layer.js';
import { proposeCreate, proposeUpdate, proposeDelete, proposeMerge, proposeSplit, proposeMoveEntry, proposeCreateCategory, proposeRenameCategory, proposeMoveCategory, proposeDeleteCategory, entryBaselineFromEntry } from '../proposals/bus.js';
import { getMemoryRecord, getActiveMemories, getMemoryStore, previewMemoryRouteState, memoryRecordVersion, deleteMemoryRecord } from './store.js';
import { settleDigestedSummaryAfterLoreChildren } from './lore-digest-settlement.js';
import { logEvent } from '../observability/telemetry.js';
import { routeOperation, rollbackDirectWrite, writeValveMode, getLoreWriteLedger, getLoreWriteReceipts, assertDirectWritesActive, confirmDirectWriteParentForwardSettlement } from '../lore/write-valve.js';
import { captureProposalStore, getProposalsFromStore, settleProposalForParentRollback } from '../proposals/store.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh } from '../nexus/work-scope.js';
import { buildLoreRoutingAssumptions, beginLoreRoutingTransaction, finalizeLoreRoutingTransaction, failNexusTransactionDurable as failNexusTransaction, abortNexusTransaction, enforceNexusTransactionFreshBeforeStage } from '../nexus/transaction-service.js';
import { commitCanonicalNexusMutation } from '../nexus/mutation-coordinator.js';
import { beginLoreRoutingSaga, updateLoreRoutingSaga, getLoreRoutingSagas, resolveLoreRoutingSaga, compactLoreRoutingSagaStore } from './lore-routing-saga.js';
import { compactOperatorReviewScope } from '../nexus/operator-review-store.js';
import { currentOperatorReviewScope, lorebookOperatorReviewScope } from '../nexus/review-scope.js';
import { resolveCanonicalHomePlan, verifyCanonicalHomeCandidateFresh } from '../lifecycle/canonical-home.js';

function parse(input,validator=null){if(input&&typeof input==='object'&&!Array.isArray(input)){if(typeof validator==='function'){const verdict=validator(input);if(verdict?.valid===false)throw new Error(verdict.reason||'Summary-to-Lore Router failed semantic validation.');return verdict?.value??input;}return input;}try{return parseStructuredJsonCandidate(String(input||''),{validator,label:'Summary-to-Lore Router'});}catch(err){throw new Error(`Lore Router returned invalid/semantic JSON: ${err.message}`);}}
function asUid(v){const n=Number(v);return Number.isFinite(n)?n:null;}
const ROUTER_SEARCH_LIMIT = 24;
const ROUTER_CANDIDATE_LIMIT = 12;
const ROUTER_CONTENT_CHARS = 1400;
function candidateText(rows=[]){return rows.slice(0,ROUTER_CANDIDATE_LIMIT).map(r=>`[${r.book} | UID ${r.uid} | node=${r.nodeId} | ${r.path?.join(' > ')||r.nodeLabel||''}]\nTITLE: ${r.title}\nKEYS: ${(r.keys||[]).join(', ')}\nCONTENT:\n${String(r.content||'').slice(0,ROUTER_CONTENT_CHARS)}${String(r.content||'').length>ROUTER_CONTENT_CHARS?'… [remainder omitted]':''}`).join('\n\n---\n\n');}
function adaptiveCandidates(rows=[]){if(!rows.length)return[];const best=Number(rows[0]?.score)||0;if(best<=0)return rows;const floor=Math.max(1,best*0.28);return rows.filter(r=>Number(r.score)>=floor);}
function modeInstruction(mode){
    if(mode==='conservative')return 'Prefer updating/merging existing canon. Create a new entry only when no existing entry can cleanly own the durable information.';
    if(mode==='expansive')return 'Create dedicated entries for substantial distinct events/threads when that improves retrieval, while still avoiding duplicates.';
    return 'Balanced: update existing canon when it naturally fits; create a distinct new entry when the memory establishes a substantial durable event, state, relationship development, system, location, or story thread that does not belong cleanly inside existing lore.';
}

function validateSummaryDurableClusters(value){
    const errors=[];
    if(!value||typeof value!=='object'||Array.isArray(value))return{valid:false,score:0,reason:'Summary durable-cluster payload must be an object.'};
    if(!Array.isArray(value.clusters))return{valid:false,score:0,reason:'Summary durable-cluster payload requires clusters array.'};
    if(value.clusters.length>16)errors.push('Summary durable-cluster payload exceeds 16 clusters.');
    const clusters=[];
    for(let index=0;index<value.clusters.length;index++){
        const row=value.clusters[index];
        const statement=String(row?.statement||'').trim();
        const kind=String(row?.kind||'fact').trim().toLowerCase();
        if(!statement){errors.push(`cluster ${index} has empty statement`);continue;}
        if(!['fact','character','arc','world','item','location','organization','rule','ability'].includes(kind))errors.push(`cluster ${index} has invalid kind`);
        clusters.push({id:String(row?.id||`cluster-${index+1}`),kind,statement});
    }
    return{valid:errors.length===0,score:errors.length?0:20+clusters.length,value:{...value,clusters,reasoning:String(value.reasoning||'')},reason:errors.length?errors.join('; '):null};
}

function focusedSummaryContract(writableBooks,candidate=null,{newEntry=false}={}){
    const book=String(candidate?.book||writableBooks?.[0]||'');
    const uidsByBook={},nodeIdsByBook={},replaceableUidsByBook={};
    if(book){uidsByBook[book]=new Set();nodeIdsByBook[book]=new Set();replaceableUidsByBook[book]=new Set();}
    if(candidate&&book){uidsByBook[book].add(Number(candidate.uid));if(candidate.nodeId)nodeIdsByBook[book].add(String(candidate.nodeId));}
    return{writableBooks:book?[book]:[],uidsByBook,nodeIdsByBook,replaceableUidsByBook,requireCandidateIds:true,allowedOperationTypes:newEntry?['remember']:['update']};
}

function buildFocusedSummaryDraftPrompt({memory,cluster,resolution,candidate=null,writableBooks=[]}){
    if(resolution?.disposition==='EXISTING_HOME'&&candidate){
        return `Nexus AUTOMATIC SUMMARY → LORE DRAFT\n\nLifecycle Intelligence already admitted this as durable lore and Jev already selected exactly ONE canonical home. Draft only for that home.\n\nSOURCE SUMMARY\n${memory.text}\n\nDURABLE EVIDENCE CLUSTER\n${cluster.statement}\n\nRESOLVED CANONICAL HOME\nBook: ${candidate.book}\nUID: ${candidate.uid}\nTitle: ${candidate.title}\nPath: ${(candidate.path||[]).join(' > ')}\nExisting content preview:\n${String(candidate.content||'').slice(0,1800)}\n\nAUTOMATIC AUTHORITY\n- Return either an empty operations array or exactly ONE update operation targeting this exact book/UID.\n- update mode MUST be append.\n- Do not create another entry, merge, split, delete, move, or alter categories.\n- If the existing entry already covers the cluster, return empty operations.\n\nReturn ONLY JSON: {"operations":[]|[{"type":"update","book":${JSON.stringify(candidate.book)},"uid":${Number(candidate.uid)},"mode":"append","content":"new durable material only"}],"reasoning":"short explanation"}.`;
    }
    const book=String(writableBooks?.[0]||'');
    return `Nexus AUTOMATIC SUMMARY → LORE DRAFT\n\nLifecycle Intelligence already admitted this as durable lore and Jev found no appropriate existing canonical home for exactly ONE evidence cluster. Draft at most one new entry.\n\nSOURCE SUMMARY\n${memory.text}\n\nDURABLE EVIDENCE CLUSTER\n${cluster.statement}\n\nWRITABLE BOOK\n${book}\n\nAUTOMATIC AUTHORITY\n- Return either an empty operations array or exactly ONE remember operation in this book.\n- node_id MUST be null; structural placement remains Housekeeper/Merge/manual authority.\n- Do not update another UID, merge, split, delete, move, or alter categories.\n\nReturn ONLY JSON: {"operations":[]|[{"type":"remember","book":${JSON.stringify(book)},"node_id":null,"title":"specific durable title","content":"durable canon","keys":["specific activation key"]}],"reasoning":"short explanation"}.`;
}

async function stageOperation(op,memory,reasoning,origin=null,parentTransactionId=null){
    const type=String(op?.type||'').toLowerCase();const book=String(op?.book||'').trim();if(!book)throw new Error(`${type||'operation'} requires book.`);
    const meta={source:'Summary Bank Lore Router',reason:reasoning||'',memoryId:memory.id,memoryLayer:memory.layer,memoryTurnRange:memory.turnRange,origin,execution:{kind:'tv2-summary-lore-route',parentTransactionId:parentTransactionId?String(parentTransactionId):null}};
    switch(type){
        case'remember':case'create':case'create_entry':return proposeCreate(book,{title:op.title||'',content:op.content||'',keys:Array.isArray(op.keys)?op.keys:[],constant:op.constant===true,targetNodeId:op.node_id||op.target_node_id||null},meta);
        case'update':{
            const uid=asUid(op.uid??op.target_uid);if(uid===null)throw new Error('update requires exact uid.');
            const patch={};for(const k of ['title','constant','disable'])if(op[k]!==undefined)patch[k]=op[k];
            if(op.content!==undefined){
                const updateMode=String(op.mode||'').toLowerCase();
                if(!['append','replace'].includes(updateMode))throw new Error('update mode must be append or replace.');
                if(updateMode==='append'){
                    const data=await loadBook(book);const existing=findEntryByUid(data.entries,uid);if(!existing)throw new Error(`UID ${uid} not found in ${book}.`);
                    meta.expectedEntry=entryBaselineFromEntry(uid,existing);
                    patch.content=`${String(existing.content||'').trim()}\n\n${String(op.content||'').trim()}`.trim();
                }else patch.content=String(op.content||'');
            }
            if(op.node_id!==undefined)patch.targetNodeId=op.node_id;
            const expectedEntry=meta.expectedEntry;delete meta.expectedEntry;return proposeUpdate(book,uid,patch,meta,expectedEntry?{expectedEntry}:{});
        }
        case'delete':{const uid=asUid(op.uid);if(uid===null)throw new Error('delete requires exact uid.');return proposeDelete(book,uid,{hardDelete:op.hard_delete===true,reason:op.reason||''},meta);}
        case'merge':{const keep=asUid(op.keep_uid),remove=asUid(op.remove_uid);if(keep===null||remove===null)throw new Error('merge requires keep_uid and remove_uid.');return proposeMerge(book,keep,remove,{title:op.title,content:op.content,hardDelete:op.hard_delete===true,treePolicy:op.tree_policy||'keep',targetNodeId:op.node_id||null},meta);}
        case'split':{const uid=asUid(op.uid);if(uid===null)throw new Error('split requires exact uid.');return proposeSplit(book,uid,{keepTitle:op.keep_title,keepContent:op.keep_content,newTitle:op.new_title,newContent:op.new_content,newTargetNodeId:op.new_node_id||null},meta);}
        case'move_entry':{const uid=asUid(op.uid);if(uid===null)throw new Error('move_entry requires exact uid.');return proposeMoveEntry(book,uid,op.node_id||op.target_node_id,meta);}
        case'create_category':return proposeCreateCategory(book,{label:op.label||op.name||'',summary:op.summary||'',parentNodeId:op.parent_node_id||op.parent_id||null},meta);
        case'rename_category':return proposeRenameCategory(book,op.node_id||op.target_id,{label:op.label||op.name,summary:op.summary},meta);
        case'move_category':return proposeMoveCategory(book,op.node_id||op.target_id,op.parent_node_id||op.parent_id,meta);
        case'delete_category':return proposeDeleteCategory(book,op.node_id||op.target_id,{mode:op.mode||'promote_children'},meta);
        default:return null;
    }
}

function hashText(text=''){
    let h=2166136261>>>0;const value=String(text||'');for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');
}
function enqueueLoreRouterSidecar(enqueueSidecar,stage,options){
    const handle=typeof enqueueSidecar==='function'?enqueueSidecar(stage,options):enqueueNexusSidecarJob(NEXUS_BATCH_DOMAIN.LOREBOOK,stage,options);
    if(!handle||!handle.promise||typeof handle.promise.then!=='function')throw new Error('Lore Router Sidecar dispatcher did not return a valid job handle.');
    return handle;
}
function candidateSnapshot(rows=[]){
    return (Array.isArray(rows)?rows:[]).map(row=>({book:String(row?.book||''),uid:Number(row?.uid),nodeId:row?.nodeId==null?null:String(row.nodeId),path:Array.isArray(row?.path)?row.path.map(String):[],title:String(row?.title||''),keys:Array.isArray(row?.keys)?row.keys.map(String):[],content:String(row?.content||'')}));
}
function allTreeNodeIds(book){
    const tree=getTree(book),out=[];
    const walk=node=>{if(!node)return;out.push(String(node.id));for(const child of node.children||[])walk(child);};
    walk(tree?.root);return out;
}
function routingSemanticContract(writableBooks,candidates){
    const uidsByBook={},nodeIdsByBook={},replaceableUidsByBook={};
    for(const book of writableBooks){uidsByBook[book]=new Set();nodeIdsByBook[book]=new Set(allTreeNodeIds(book));replaceableUidsByBook[book]=new Set();}
    for(const row of candidates||[]){
        const book=String(row?.book||'');
        if(!uidsByBook[book])continue;
        const id=Number(row.uid);uidsByBook[book].add(id);
        // Full replacement authority is granted only when the model received the
        // complete canonical content. Truncated previews may still support append.
        if(String(row?.content||'').length<=ROUTER_CONTENT_CHARS)replaceableUidsByBook[book].add(id);
    }
    return {writableBooks,uidsByBook,nodeIdsByBook,replaceableUidsByBook,requireCandidateIds:true};
}

export function inspectLoreRoutingEligibility(){
    const settings=getSettings();
    if(!settings.enabled||settings.memoryBank?.enabled===false||settings.memoryBank?.loreRouting?.enabled===false)return {due:false,reason:'disabled'};
    const writableBooks=getActiveBooks({requireTree:false,access:'write'});
    if(!writableBooks.length)return {due:false,reason:'no-writable-lorebooks',count:0};
    const unrouted=getActiveMemories().filter(record=>record.routeState==='unrouted'&&!record.promotedTo).sort((a,b)=>a.createdAt-b.createdAt);
    const maxPerCycle=Math.max(1,Number(settings.memoryBank?.loreRouting?.maxPerCycle)||1);
    return unrouted.length
        ? {due:true,reason:'unrouted-memory',count:unrouted.length,nextIds:unrouted.slice(0,maxPerCycle).map(record=>record.id),maxPerCycle,writableBooks}
        : {due:false,reason:'no-unrouted-memories',count:0,maxPerCycle,writableBooks};
}

async function buildRoutingContext(memory,context=getContext()){
    const settings=getSettings();
    const readableBooks=getActiveBooks({requireTree:true,access:'read'});
    const writableBooks=getActiveBooks({requireTree:false,access:'write'});
    const writableTreeBooks=writableBooks.filter(book=>!!getTree(book)?.root);
    const treelessWritableBooks=writableBooks.filter(book=>!getTree(book)?.root);
    const query=[memory.text,...memory.characters,...memory.locations,...memory.topics,...memory.threads].join(' ');
    const all=readableBooks.length?await searchTree({query,books:readableBooks,includeContent:true,limit:ROUTER_SEARCH_LIMIT}):[];
    const candidates=adaptiveCandidates(all).slice(0,ROUTER_CANDIDATE_LIMIT);
    const tree=readableBooks.length?formatRegionOverview(readableBooks,{previewDepth:2}):'(no readable Tree lorebooks; route only to listed writable targets)';
    const mode=String(settings.memoryBank?.loreRouting?.mode||'balanced');
    const writeModes=Object.fromEntries(writableBooks.map(book=>[book,writeValveMode(book)]));
    const assumptions=buildLoreRoutingAssumptions({
        chatId:context?.chatId||null,
        memory,
        readableBooks,
        writableBooks,
        writeModes,
        routeMode:mode,
        candidateSnapshot:candidateSnapshot(candidates),
        treeFingerprint:hashText(tree),
        routingConfig:{mode,maxPerCycle:Math.max(1,Number(settings.memoryBank?.loreRouting?.maxPerCycle)||1)},
        relevantState:{routerSchema:'summary-lore-router/v3-tree-optional',candidateLimit:ROUTER_CANDIDATE_LIMIT,contentCharsPerCandidate:ROUTER_CONTENT_CHARS,treelessWritableBooks:[...treelessWritableBooks]},
    });
    return {settings,readableBooks,writableBooks,writableTreeBooks,treelessWritableBooks,query,all,candidates,tree,mode,writeModes,assumptions};
}

async function rollbackRoutingSideEffects({transactionId,directWriteIds=[],staged=[],proposalStoreRef=null,context=null,reason='Parent Summary-to-Lore transaction rolled back.'}={}){
    const rollbackFailures=[];
    const physicallySettledProposals=new Set();
    for(const writeId of [...directWriteIds].reverse()){
        try{const row=await rollbackDirectWrite(writeId,{context,actor:'system-recovery',expectedParentTransactionId:transactionId,idempotent:true,allowUnresolvedParent:true,source:'summary-lore-parent-rollback'});if(row?.proposalId)physicallySettledProposals.add(String(row.proposalId));}
        catch(error){rollbackFailures.push({kind:'direct-write',writeId,message:error?.message||String(error)});}
    }
    for(const proposalId of staged){
        try{
            const settlement=await settleProposalForParentRollback(proposalId,{parentTransactionId:transactionId,reason,ref:proposalStoreRef,physicalRollbackProven:physicallySettledProposals.has(String(proposalId))});
            if(settlement?.recoveryRequired)rollbackFailures.push({kind:'proposal-state',proposalId,message:settlement.reason||`Proposal ${proposalId} requires recovery.`,status:settlement.status||null});
        }catch(error){rollbackFailures.push({kind:'proposal-state',proposalId,message:error?.message||String(error),name:error?.name||'Error'});}
    }
    return rollbackFailures;
}

function proposalParent(row){return String(row?.execution?.parentTransactionId||'');}
function verifyCommittedRoutingChildren({saga,proposalRows=[],writeRows=[],writeReceipts=[]}={}){
    const parent=String(saga?.transactionId||''),proposals=new Map(proposalRows.map(row=>[String(row.id),row])),writes=new Map(writeRows.map(row=>[String(row.id),row])),receipts=new Map(writeReceipts.map(row=>[String(row.id),row]));
    const proposalIds=[...new Set([...(saga?.proposalIds||[]),...proposalRows.filter(row=>proposalParent(row)===parent).map(row=>String(row.id))])];
    const directWriteIds=[...new Set([...(saga?.directWriteIds||[]),...writeRows.filter(row=>String(row?.parentTransactionId||'')===parent).map(row=>String(row.id)),...writeReceipts.filter(row=>String(row?.parentTransactionId||'')===parent).map(row=>String(row.id))])];
    const problems=[];
    for(const id of proposalIds){const row=proposals.get(id);if(!row){problems.push({kind:'proposal',id,reason:'missing'});continue;}if(proposalParent(row)!==parent){problems.push({kind:'proposal',id,reason:'parent-ownership-mismatch',status:row.status});continue;}if(!['pending','approved'].includes(String(row.status||'')))problems.push({kind:'proposal',id,reason:'not-settled-for-committed-parent',status:row.status});}
    for(const id of directWriteIds){const row=writes.get(id),receipt=receipts.get(id);if(row){if(String(row.parentTransactionId||'')!==parent)problems.push({kind:'direct-write',id,reason:'parent-ownership-mismatch',state:row.state});else if(!['applied','applied-audit-degraded'].includes(String(row.state||'')))problems.push({kind:'direct-write',id,reason:'not-applied',state:row.state});}else if(receipt){if(String(receipt.parentTransactionId||'')!==parent||String(receipt.state||'')!=='archived-applied')problems.push({kind:'direct-write',id,reason:'invalid-receipt',state:receipt.state});}else problems.push({kind:'direct-write',id,reason:'missing'});}
    return {ok:problems.length===0,proposalIds,directWriteIds,problems};
}


function sameJson(a,b){try{return JSON.stringify(a)===JSON.stringify(b);}catch{return false;}}
function routeProjection(record){return record?{routeState:String(record.routeState||'unrouted'),routeProposalIds:[...(record.routeProposalIds||[])].map(String),routeReasoning:String(record.routeReasoning||'')}:null;}
function memorySourceIdentity(record){
    if(!record)return null;
    return {
        id:String(record.id||''),layer:Number(record.layer)||0,
        sourceFingerprint:record.sourceFingerprint==null?null:String(record.sourceFingerprint),
        text:String(record.text||''),turnRange:record.turnRange??null,assistantTurnRange:record.assistantTurnRange??null,
        sourceMessageIds:Array.isArray(record.sourceMessageIds)?record.sourceMessageIds.map(String):[],source:String(record.source||''),
    };
}
function sagaMemoryRecord(saga,kind){
    const memoryId=String(saga?.memoryId||'');
    const compact=saga?.[`${kind}MemoryRecord`];
    if(compact)return compact;
    return saga?.[`${kind}MemoryStore`]?.records?.[memoryId]||null;
}
function proveRouteOnlyIntendedPost(saga){
    const memoryId=String(saga?.memoryId||''),preRecord=sagaMemoryRecord(saga,'pre'),postRecord=sagaMemoryRecord(saga,'post');
    if(!preRecord||!postRecord)return {ok:false,reason:'route-post-record-missing'};
    if(!sameJson(memorySourceIdentity(preRecord),memorySourceIdentity(postRecord)))return {ok:false,reason:'route-source-changed-inside-parent'};
    const normalized=JSON.parse(JSON.stringify(postRecord));
    Object.assign(normalized,routeProjection(preRecord),{updatedAt:preRecord.updatedAt});
    if(!sameJson(normalized,preRecord))return {ok:false,reason:'parent-post-state-not-route-only'};
    return {ok:true,memoryId,preRecord,postRecord,preRoute:routeProjection(preRecord),postRoute:routeProjection(postRecord)};
}
function proveForwardRouteCompatibility(saga,currentStore){
    const intended=proveRouteOnlyIntendedPost(saga);if(!intended.ok)return intended;
    const currentRecord=currentStore?.records?.[intended.memoryId];if(!currentRecord)return {...intended,ok:false,reason:'current-memory-record-missing'};
    if(!sameJson(memorySourceIdentity(currentRecord),memorySourceIdentity(intended.preRecord)))return {...intended,ok:false,reason:'current-memory-source-diverged'};
    const currentRoute=routeProjection(currentRecord);
    if(sameJson(currentRoute,intended.postRoute))return {...intended,ok:true,currentRecord,currentRoute,alreadyPost:true};
    if(!sameJson(currentRoute,intended.preRoute))return {...intended,ok:false,reason:'current-route-state-diverged',currentRoute};
    return {...intended,ok:true,currentRecord,currentRoute,alreadyPost:false};
}
function forwardRecoveryAssumptions({saga,currentRecord,currentRoute}){
    return buildLoreRoutingAssumptions({
        chatId:saga?.chatId??null,memory:currentRecord,readableBooks:[],writableBooks:[],writeModes:{},routeMode:'recovery',candidateSnapshot:[],treeFingerprint:'',routingConfig:{mode:'forward-parent-recovery'},
        relevantState:{recoveryOf:String(saga?.transactionId||''),memoryId:String(saga?.memoryId||''),routeProjection:currentRoute},
    });
}
async function compactLoreRoutingRecoveryAuthority(context){
    const results=[];
    try{results.push({kind:'saga',result:await compactLoreRoutingSagaStore()});}catch(error){logEvent('memory','lore-route-saga-compaction-failed',{error:error?.message||String(error)},'warn');}
    const scopes=[];try{scopes.push(currentOperatorReviewScope());}catch{}
    try{for(const book of getActiveBooks({access:'read'}))scopes.push(lorebookOperatorReviewScope(book));}catch{}
    const seen=new Set();for(const scope of scopes){const identity=String(scope?.identity||'');if(!identity||seen.has(identity))continue;seen.add(identity);try{results.push({kind:'operator-review',identity,result:await compactOperatorReviewScope(scope)});}catch(error){logEvent('memory','lore-route-review-compaction-failed',{identity,error:error?.message||String(error)},'warn');}}
    return results;
}
async function forwardCompleteLoreRoutingSaga({saga,currentStore,proposalIds,directWriteIds,context}={}){
    const proof=proveForwardRouteCompatibility(saga,currentStore);if(!proof.ok)return {ok:false,reason:proof.reason,proof};
    await confirmDirectWriteParentForwardSettlement(directWriteIds,saga.transactionId,{context,note:'HOTFIX44 forward reconciliation: canonical Summary-to-Lore child commit proven after historical rollback descriptor loss.'});
    const proposalRows=getProposalsFromStore(captureProposalStore(true),'all'),writeRows=getLoreWriteLedger(),writeReceipts=getLoreWriteReceipts();
    const verification=verifyCommittedRoutingChildren({saga:{...saga,proposalIds,directWriteIds},proposalRows,writeRows,writeReceipts});
    if(!verification.ok)return {ok:false,reason:'child-settlement-incomplete',verification,proof};
    if(proof.alreadyPost){await resolveLoreRoutingSaga(saga.transactionId,'committed',{error:'Forward reconciliation confirmed the intended Memory route state was already durable.'});const cleanup=await settleDigestedSummaryAfterLoreChildren(saga.transactionId,{reason:'recovered-lore-digest'});return {ok:true,state:'committed-reconciled-forward-existing',proof,verification,recoveryTransactionId:null,cleanup};}
    const assumptions=forwardRecoveryAssumptions({saga,currentRecord:proof.currentRecord,currentRoute:proof.currentRoute});
    const tx=beginLoreRoutingTransaction({assumptions,metadata:{source:'summary-lore-router-recovery',recoveryOf:String(saga.transactionId),recoveryMode:'forward-complete'}});
    const staged=finalizeLoreRoutingTransaction(tx.id,{parsed:{operations:[],reasoning:'Forward-complete interrupted Summary-to-Lore parent route metadata after child settlement was proven.'},metadata:{recoveryOf:String(saga.transactionId),recoveryMode:'forward-complete'}});
    if(staged.state!=='staged')throw new Error(staged.error||'Summary-to-Lore forward recovery transaction did not stage.');
    const beforeStore=JSON.parse(JSON.stringify(currentStore));
    const preview=previewMemoryRouteState(proof.memoryId,{state:proof.postRoute.routeState,proposalIds:proof.postRoute.routeProposalIds,reasoning:proof.postRoute.routeReasoning},beforeStore);
    const committed=await commitCanonicalNexusMutation(tx.id,{type:'metadata.set',chatId:String(context?.chatId||''),key:'tv2_memory_bank',value:preview.store,expected:beforeStore},{context,currentAssumptions:()=>{
        const live=getMemoryStore(),record=live?.records?.[proof.memoryId]||null;
        return forwardRecoveryAssumptions({saga,currentRecord:record,currentRoute:routeProjection(record)});
    },preflight:()=>{
        const live=getMemoryStore(),freshProof=proveForwardRouteCompatibility(saga,live);
        if(!freshProof.ok||freshProof.alreadyPost){const error=new Error(freshProof.alreadyPost?'Summary-to-Lore forward recovery became redundant before commit.':`Summary-to-Lore forward recovery lost authority: ${freshProof.reason||'unknown'}.`);error.name='TV2MutationStale';error.tv2PreMutationStale=true;throw error;}
    },metadata:{surface:'summary-lore-route-recovery',operation:'forward-route-state',recoveryOf:String(saga.transactionId)},committed:()=>({memoryId:proof.memoryId,state:proof.postRoute.routeState,proposalIds:proof.postRoute.routeProposalIds,recoveryOf:String(saga.transactionId)})});
    if(committed.state!=='committed')throw Object.assign(new Error(committed.error||'Summary-to-Lore forward recovery metadata mutation did not commit.'),{tv2ParentState:committed.state});
    await resolveLoreRoutingSaga(saga.transactionId,'committed',{error:`Forward-completed by recovery transaction ${tx.id}.`});
    logEvent('memory','lore-route-saga-forward-completed',{transactionId:String(saga.transactionId),recoveryTransactionId:tx.id,memoryId:proof.memoryId,proposalIds:proof.postRoute.routeProposalIds,directWriteIds,childCount:proposalIds.length},'warn');
    const cleanup=await settleDigestedSummaryAfterLoreChildren(saga.transactionId,{reason:'recovered-lore-digest'});
    return {ok:true,state:'committed-reconciled-forward',proof,verification,recoveryTransactionId:tx.id,cleanup};
}

export async function reconcileLoreRoutingSagasOnStartup(context=getContext()){
    const chatId=context?.chatId==null?null:String(context.chatId),results=[];
    if(!chatId)return results;
    await compactLoreRoutingRecoveryAuthority(context);
    let sagas;
    try{sagas=getLoreRoutingSagas({unresolvedOnly:true,chatId});}catch(error){logEvent('memory','lore-route-saga-read-failed',{error},'error');return [{state:'store-error',error:error?.message||String(error)}];}
    if(!sagas.length)return results;
    let proposalStoreRef,allProposals,writes,writeReceipts;
    try{proposalStoreRef=captureProposalStore(true);allProposals=getProposalsFromStore(proposalStoreRef,'all');}
    catch(error){for(const saga of sagas){try{await resolveLoreRoutingSaga(saga.transactionId,'recovery-required',{error:`Proposal audit unavailable during recovery: ${error?.message||error}`});}catch{}}return sagas.map(saga=>({transactionId:saga.transactionId,state:'recovery-required',reason:'proposal-audit-unavailable'}));}
    try{writes=getLoreWriteLedger();writeReceipts=getLoreWriteReceipts();}
    catch(error){for(const saga of sagas){try{await resolveLoreRoutingSaga(saga.transactionId,'recovery-required',{error:`Direct Write audit unavailable during recovery: ${error?.message||error}`});}catch{}}return sagas.map(saga=>({transactionId:saga.transactionId,state:'recovery-required',reason:'direct-write-audit-unavailable'}));}
    for(const saga of sagas){
        const parent=String(saga.transactionId);
        const proposalIds=[...new Set([...(saga.proposalIds||[]),...allProposals.filter(p=>proposalParent(p)===parent).map(p=>String(p.id))])];
        const directWriteIds=[...new Set([...(saga.directWriteIds||[]),...writes.filter(w=>String(w?.parentTransactionId||'')===parent).map(w=>String(w.id)),...writeReceipts.filter(w=>String(w?.parentTransactionId||'')===parent).map(w=>String(w.id))])];
        try{await updateLoreRoutingSaga(parent,{proposalIds,directWriteIds});}catch(error){results.push({transactionId:parent,state:'recovery-required',reason:'child-discovery-persistence-failed',error:error?.message||String(error)});continue;}
        const currentStore=JSON.parse(JSON.stringify(getMemoryStore()));
        // HOTFIX44 historical repair: prefer forward completion when the exact
        // target Memory record still has the parent's PRE route projection and
        // all child effects can be proven settled. This preserves unrelated
        // Memory Bank progress and repairs pre-HOTFIX44 parents whose children
        // committed but whose final route-state metadata CAS failed.
        let forwardFailure=null;
        if(saga.postMemoryRecord||saga.postMemoryStore){
            const compatibility=proveForwardRouteCompatibility(saga,currentStore);
            if(compatibility.ok){
                try{
                    const forward=await forwardCompleteLoreRoutingSaga({saga:{...saga,proposalIds,directWriteIds},currentStore,proposalIds,directWriteIds,context});
                    if(forward?.ok){results.push({transactionId:parent,state:forward.state,recoveryTransactionId:forward.recoveryTransactionId||null,forward:true});continue;}
                    forwardFailure={reason:forward?.reason||'forward-unproven',verification:forward?.verification||null};
                }catch(error){forwardFailure={reason:'forward-recovery-failed',error:error?.message||String(error),name:error?.name||'Error'};}
            }
        }
        if(saga.postMemoryStore&&sameJson(currentStore,saga.postMemoryStore)){
            const verification=verifyCommittedRoutingChildren({saga:{...saga,proposalIds,directWriteIds},proposalRows:allProposals,writeRows:writes,writeReceipts});
            if(!verification.ok){await resolveLoreRoutingSaga(parent,'recovery-required',{error:`Committed parent child settlement is incomplete: ${JSON.stringify(verification.problems)}`});results.push({transactionId:parent,state:'recovery-required',reason:'child-settlement-incomplete',problems:verification.problems});continue;}
            try{await resolveLoreRoutingSaga(parent,'committed');results.push({transactionId:parent,state:'committed-reconciled'});}catch(error){results.push({transactionId:parent,state:'committed-audit-degraded',error:error?.message||String(error)});}continue;
        }
        if(saga.preMemoryStore&&sameJson(currentStore,saga.preMemoryStore)){
            const rollbackFailures=await rollbackRoutingSideEffects({transactionId:parent,directWriteIds,staged:proposalIds,proposalStoreRef,context,reason:'Recovered interrupted Summary-to-Lore parent saga before final route-state commit.'});
            try{await resolveLoreRoutingSaga(parent,rollbackFailures.length?'recovery-required':'rolled-back',{error:rollbackFailures.length?JSON.stringify(rollbackFailures):''});}catch(error){rollbackFailures.push({kind:'saga-settlement',message:error?.message||String(error)});}
            results.push({transactionId:parent,state:rollbackFailures.length?'recovery-required':'rolled-back',rollbackFailures});continue;
        }
        await resolveLoreRoutingSaga(parent,'recovery-required',{error:`Memory Bank state matches neither the parent saga pre-state nor intended post-state${forwardFailure?`; forward recovery was unavailable (${forwardFailure.reason})`:''}.`});
        results.push({transactionId:parent,state:'recovery-required',reason:'memory-state-diverged',forwardFailure});
    }
    if(results.length){
        const unresolved=results.filter(r=>r?.state==='recovery-required');
        const reconciled=results.filter(r=>r?.state!=='recovery-required');
        if(reconciled.length)logEvent('memory','lore-route-saga-reconciled',{count:reconciled.length,results:reconciled},'warn');
        if(unresolved.length)logEvent('memory','lore-route-recovery-required',{count:unresolved.length,results:unresolved},'error');
    }
    return results;
}


function automaticNoopAssumptions(memory,context,classification,decision){
    return buildLoreRoutingAssumptions({
        chatId:context?.chatId||null,
        memory,
        readableBooks:[],
        writableBooks:[],
        writeModes:{},
        routeMode:'automatic-lifecycle-noop',
        candidateSnapshot:[],
        treeFingerprint:'',
        routingConfig:{mode:'automatic-lifecycle-noop'},
        relevantState:{classification,decisionScores:decision?.scores||null,destinations:decision?.destinations||[],authority:'lifecycle-intelligence'},
    });
}

/**
 * Settle an already-evaluated Summary as a durable no-lore routing result.
 * This is routing bookkeeping owned by the Summary/Lore subsystem: it uses the
 * existing Lore-routing transaction + canonical metadata mutation path and does
 * not execute the Lore Router worker or mutate canonical lore.
 */
export async function settleAutomaticLoreRoutingNoop(memoryId,{context=getContext(),classification='NARRATIVE_MEMORY',decision=null,expectedMemoryVersion=null,expectedChatId=null}={}){
    if(expectedChatId!=null&&String(context?.chatId??'')!==String(expectedChatId))return {deferred:true,stale:true,reason:'queued-story-changed',memoryId};
    const memory=getMemoryRecord(memoryId);
    if(!memory)return {failed:true,error:`Memory ${memoryId} was not found.`};
    const sourceVersion=String(expectedMemoryVersion??memoryRecordVersion(memory));
    if(expectedMemoryVersion!=null&&memoryRecordVersion(memory)!==sourceVersion)return {deferred:true,stale:true,reason:'source-memory-revised',memoryId};
    const scope=captureNexusWorkScope(context);
    const sourceBound=expectedMemoryVersion!=null||expectedChatId!=null;
    const fresh=()=>{
        const liveContext=getContext();
        if(!isNexusWorkScopeFresh(scope,liveContext,{checkRevision:!sourceBound}))return false;
        if(expectedChatId!=null&&String(liveContext?.chatId??'')!==String(expectedChatId))return false;
        const live=getMemoryRecord(memoryId);
        return !!live&&memoryRecordVersion(live)===sourceVersion;
    };
    const assumptions=automaticNoopAssumptions(memory,context,classification,decision);
    const tx=beginLoreRoutingTransaction({assumptions,metadata:{source:'summary-lifecycle-intelligence',automaticNoop:true,classification}});
    try{
        const staged=finalizeLoreRoutingTransaction(tx.id,{parsed:{operations:[],reasoning:`Lifecycle Intelligence classified Summary as ${classification}; no durable generic lore worker was launched.`},metadata:{automaticNoop:true,classification}});
        if(staged.state!=='staged')throw new Error(staged.error||'Automatic Summary no-lore transaction did not stage.');
        const beforeStore=JSON.parse(JSON.stringify(getMemoryStore()));
        const current=beforeStore?.records?.[String(memory.id)]||null;
        if(!current||memoryRecordVersion(current)!==memoryRecordVersion(memory)){const error=new Error('Summary changed before no-lore disposition could commit.');error.name='TV2MutationStale';throw error;}
        const reasoning=`Lifecycle Intelligence: ${classification}. Summary remains Narrative Memory; no durable generic lore mutation was warranted.`;
        const preview=previewMemoryRouteState(memory.id,{state:'routed-noop',proposalIds:[],reasoning},beforeStore);
        const committed=await commitCanonicalNexusMutation(tx.id,{type:'metadata.set',chatId:String(context?.chatId||''),key:'tv2_memory_bank',value:preview.store,expected:beforeStore},{
            context,
            currentAssumptions:()=>{
                const live=getMemoryRecord(memory.id);
                return automaticNoopAssumptions(live,getContext(),classification,decision);
            },
            preflight:()=>{
                if(!fresh()){const error=new Error('Summary no-lore disposition became stale before commit.');error.name='TV2MutationStale';error.tv2PreMutationStale=true;throw error;}
                const live=getMemoryRecord(memory.id);
                if(!live||memoryRecordVersion(live)!==memoryRecordVersion(memory)){const error=new Error('Summary changed before no-lore disposition commit.');error.name='TV2MutationStale';error.tv2PreMutationStale=true;throw error;}
            },
            metadata:{surface:'summary-lore-route',operation:'automatic-routed-noop',classification},
            committed:()=>({memoryId:memory.id,state:'routed-noop',classification,proposalIds:[]}),
        });
        if(committed?.state!=='committed')throw new Error(committed?.error||'Summary no-lore disposition did not commit.');
        logEvent('memory','lore-route-preflight-noop',{memoryId:memory.id,classification,destinations:decision?.destinations||[],scores:decision?.scores||null,transactionId:tx.id,workerSkipped:true},'info');
        return {routed:true,noOp:true,memoryId:memory.id,operations:[],proposalIds:[],classification,destinations:decision?.destinations||[],transactionId:tx.id,reasoning};
    }catch(error){
        try{await failNexusTransaction(tx.id,error,{stage:'summary-lifecycle-noop',recoveryRequired:false});}catch{}
        return {deferred:true,stale:error?.name==='TV2MutationStale',reason:error?.name==='TV2MutationStale'?'source-memory-revised':'automatic-noop-commit-failed',memoryId:memory.id,error:error?.message||String(error),transactionId:tx.id};
    }
}



async function runAutomaticSummaryCanonicalPlanning({memory,writableBooks,settings,enqueueSidecar,cycleId,directorMeta,fresh,context}){
    const sourceVersion=memoryRecordVersion(memory);
    const clusterPrompt=`Nexus AUTOMATIC SUMMARY DURABLE-EVIDENCE CLUSTERING\n\nLifecycle Intelligence has already determined that this exact Summary contains genuinely durable lore-worthy canon. This step does NOT choose mutations or canonical homes. Extract only distinct durable canonical evidence clusters from the Summary.\n\nSOURCE SUMMARY\nID: ${memory.id}\nLayer: ${memory.layer}\nTurns: ${memory.turnRange?`${memory.turnRange[0]}-${memory.turnRange[1]}`:'unknown'}\nCharacters: ${(memory.characters||[]).join(', ')||'(none tagged)'}\nLocations: ${(memory.locations||[]).join(', ')||'(none tagged)'}\nTopics: ${(memory.topics||[]).join(', ')||'(none tagged)'}\nThreads: ${(memory.threads||[]).join(', ')||'(none tagged)'}\n\n${memory.text}\n\nCLUSTERING RULES\n- Extract persistent canon only; ordinary scene texture, jokes, meals, temporary emotions, and transient logistics are not durable clusters.\n- One real-world/story fact or tightly coupled event/state should normally be ONE cluster. Do not split the same fact into several differently worded clusters.\n- Do not decide where the cluster belongs. Canonical-home resolution happens after this step.\n- Do not draft lore prose and do not propose operations.\n- If Lifecycle Intelligence admitted the Summary but no precise durable cluster can be supported from the Summary text, return an empty clusters array rather than inventing one.\n\nReturn ONLY JSON: {"clusters":[{"id":"C1","kind":"fact|character|arc|world|item|location|organization|rule|ability","statement":"concise durable evidence"}],"reasoning":"short explanation"}.`;
    const clusterValidator=value=>validateSummaryDurableClusters(value);
    const clusterJob=enqueueLoreRouterSidecar(enqueueSidecar,BUS_STAGE.SUMMARY_LORE_ROUTE,structuredSidecarOptions({
        prompt:clusterPrompt,
        systemPrompt:'You are Nexus automatic Summary durable-evidence clustering. Extract durable evidence only; never choose mutations or canonical homes. Return exact JSON only.',
        reasoningEffort:settings.memoryBank?.loreRouting?.reasoningEffort||'high',maxTokens:2048,
        timeoutMs:Number(settings.memoryBank?.loreRouting?.timeoutMs)||240000,priority:BUS_PRIORITY.SUMMARY_LORE_ROUTE,maxAttempts:1,
        dedupKey:`summary-lore-route:${memory.id}:durable-clusters`,label:`Summary durable clusters · L${memory.layer}`,
        structuredValidator:clusterValidator,synthesisCandidateParser:text=>parse(text,clusterValidator),
        telemetry:{memoryId:memory.id,memoryLayer:memory.layer,cycleId,manual:false,automaticCanonicalHome:true,phase:'durable-cluster-extraction',...(directorMeta||{})},
    }));
    const clusterResponse=await clusterJob.promise;
    if(!fresh())throw Object.assign(new Error('Automatic Summary source changed during durable-cluster extraction.'),{name:'TV2ScopeInvalidated'});
    const clusterPayload=parse(clusterResponse.structuredPayload??clusterResponse.text,clusterValidator);
    const clusters=Array.isArray(clusterPayload.clusters)?clusterPayload.clusters:[];
    if(!clusters.length)return{parsed:{operations:[],reasoning:clusterPayload.reasoning||'No precise durable canonical clusters were supported by the Summary.'},job:clusterJob,response:clusterResponse,clusterCount:0,resolutions:[]};

    const homePlan=await resolveCanonicalHomePlan({
        clusters,books:writableBooks,chatId:String(context?.chatId||''),sourceKind:'summary',sourceRange:Array.isArray(memory.turnRange)?[...memory.turnRange]:null,sourceVersion,
        policy:{allowedOperationTypes:['remember','update'],structuralMaintenanceForbidden:true},
        readCurrentSourceFingerprint:()=>fresh(),
    });
    if(!homePlan?.handled){const error=new Error(`Automatic Summary canonical-home resolution unavailable: ${homePlan?.reason||'unknown'}.`);error.name='NexusCanonicalHomeDecisionError';throw error;}
    if(!fresh())throw Object.assign(new Error('Automatic Summary source changed after canonical-home resolution.'),{name:'TV2ScopeInvalidated'});
    logEvent('memory','lore-route-canonical-home-resolved',{memoryId:memory.id,clusterCount:clusters.length,resolutions:homePlan.resolutions.map(row=>({clusterId:row.clusterId,disposition:row.disposition,book:row.candidate?.book||null,uid:row.candidate?.uid??null,confidence:row.confidence??null}))},'info');

    const groups=new Map();
    for(const resolution of homePlan.resolutions){
        if(resolution.disposition==='NO_MUTATION')continue;
        const key=resolution.disposition==='EXISTING_HOME'?`existing:${resolution.candidate?.book}:${resolution.candidate?.uid}`:`new:${resolution.clusterId}`;
        if(!groups.has(key))groups.set(key,[]);
        groups.get(key).push(resolution);
    }
    if(!groups.size)return{parsed:{operations:[],reasoning:'Canonical-home resolution found no Summary lore mutation warranted.'},job:clusterJob,response:clusterResponse,clusterCount:clusters.length,resolutions:homePlan.resolutions};

    const draftHandles=[];
    const draftMeta=[];
    for(const [key,resolutions] of groups){
        const first=resolutions[0];
        let candidate=null,newEntry=false;
        if(first.disposition==='EXISTING_HOME')candidate=first.candidate;
        else if(first.disposition==='NEW_ENTRY'){
            if(writableBooks.length!==1){const error=new Error('Automatic Summary new-entry canonical home is ambiguous because more than one writable lorebook is active.');error.name='NexusCanonicalHomeMaterializationError';throw error;}
            newEntry=true;
        }else continue;
        const mergedCluster={
            id:resolutions.map(row=>row.clusterId).join('+'),
            kind:resolutions[0]?.cluster?.kind||'fact',
            statement:resolutions.map(row=>row.cluster?.statement).filter(Boolean).join('\n- '),
        };
        const contract=focusedSummaryContract(writableBooks,candidate,{newEntry});
        const validator=value=>validateMutationEnvelope(value,contract);
        const prompt=buildFocusedSummaryDraftPrompt({memory,cluster:mergedCluster,resolution:first,candidate,writableBooks});
        const handle=enqueueLoreRouterSidecar(enqueueSidecar,BUS_STAGE.SUMMARY_LORE_ROUTE,structuredSidecarOptions({
            prompt,systemPrompt:'You are Nexus Automatic Summary-to-Lore drafting. The canonical home is already resolved. Draft only the permitted remember/update operation for that one home; never perform structural maintenance. Return exact JSON only.',
            reasoningEffort:settings.memoryBank?.loreRouting?.reasoningEffort||'high',maxTokens:3072,
            timeoutMs:Number(settings.memoryBank?.loreRouting?.timeoutMs)||240000,priority:BUS_PRIORITY.SUMMARY_LORE_ROUTE,maxAttempts:1,
            dedupKey:`summary-lore-route:${memory.id}:canonical:${key}`,label:`Summary automatic canonical draft · ${newEntry?'new entry':`${candidate.book} UID ${candidate.uid}`}`,
            structuredValidator:validator,synthesisCandidateParser:text=>parse(text,validator),
            telemetry:{memoryId:memory.id,memoryLayer:memory.layer,cycleId,manual:false,automaticCanonicalHome:true,phase:'canonical-draft',clusterIds:resolutions.map(row=>row.clusterId),book:candidate?.book||writableBooks[0]||null,uid:candidate?.uid??null,...(directorMeta||{})},
        }));
        draftHandles.push(handle);draftMeta.push({validator,newEntry,candidate,resolutions});
    }
    const draftResponses=await Promise.all(draftHandles.map(handle=>handle.promise));
    if(!fresh())throw Object.assign(new Error('Automatic Summary source changed during canonical drafting.'),{name:'TV2ScopeInvalidated'});
    for(const resolution of homePlan.resolutions){
        if(resolution.disposition!=='EXISTING_HOME')continue;
        const freshness=await verifyCanonicalHomeCandidateFresh(resolution.candidate);
        if(!freshness.fresh){const error=new Error(`Automatic Summary canonical home changed during drafting: ${resolution.candidate?.book||''} UID ${resolution.candidate?.uid??''}.`);error.name='NexusCanonicalHomeCandidateStale';throw error;}
    }
    const operations=[],reasons=[];
    draftResponses.forEach((row,index)=>{
        const meta=draftMeta[index];
        const payload=parse(row.structuredPayload??row.text,meta.validator);
        const ops=Array.isArray(payload.operations)?payload.operations:[];
        if(ops.length>1)throw new Error('Automatic Summary canonical draft returned more than one operation for one resolved canonical home.');
        if(ops.length){
            const op=ops[0];
            if(meta.newEntry){if(String(op?.type||'').toLowerCase()!=='remember')throw new Error('Automatic Summary new canonical home may only produce remember.');if(op.node_id!=null&&String(op.node_id)!=='')throw new Error('Automatic Summary remember must leave node_id null for structural placement authority.');}
            else{if(String(op?.type||'').toLowerCase()!=='update')throw new Error('Automatic Summary existing canonical home may only produce update.');if(String(op?.mode||'').toLowerCase()!=='append')throw new Error('Automatic Summary existing canonical home update must use append mode.');}
            operations.push(op);
        }
        if(payload.reasoning)reasons.push(String(payload.reasoning));
    });
    return{parsed:{operations,reasoning:reasons.join(' | ')||clusterPayload.reasoning||''},job:{id:`summary-lore-auto-${memory.id}-${Date.now()}`,jobId:null},response:draftResponses.at(-1)||clusterResponse,clusterCount:clusters.length,resolutions:homePlan.resolutions};
}

export async function routeMemoryToLore(memoryId,{cycleId=null,manual=false,enqueueSidecar=null,directorMeta=null,expectedMemoryVersion=null,expectedChatId=null,automaticAuthority=null,deleteAfterDigest=true}={}){
    if(manual!==true&&!(automaticAuthority?.canonicalHomeResolution===true&&expectedMemoryVersion!=null&&expectedChatId!=null)){
        return {deferred:true,reason:'automatic-intelligence-authority-required',memoryId};
    }
    const context=getContext();
    if(expectedChatId!=null&&String(context?.chatId??'')!==String(expectedChatId))return {deferred:true,stale:true,reason:'queued-story-changed',memoryId};
    const settings=getSettings();if(!settings.enabled||settings.memoryBank?.loreRouting?.enabled===false)return {skipped:true,reason:'disabled'};
    const memory=getMemoryRecord(memoryId);if(!memory)return {failed:true,error:`Memory ${memoryId} was not found.`};
    if(expectedMemoryVersion!=null&&memoryRecordVersion(memory)!==String(expectedMemoryVersion))return {deferred:true,stale:true,reason:'source-memory-revised',memoryId};
    const scope=captureNexusWorkScope(context);
    const automaticCanonical=manual!==true&&automaticAuthority?.canonicalHomeResolution===true;
    const admittedMemoryVersion=String(expectedMemoryVersion??memoryRecordVersion(memory));
    const fresh=automaticCanonical
        ? ()=>{const liveContext=getContext(),liveMemory=getMemoryRecord(memory.id);return String(liveContext?.chatId??'')===String(context?.chatId??'')&&!!liveMemory&&memoryRecordVersion(liveMemory)===admittedMemoryVersion;}
        : ()=>isNexusWorkScopeFresh(scope,getContext());
    const origin={chatId:scope.chatId,messageId:String(memoryId),sourceRevision:scope.revision};
    const proposalStoreRef=captureProposalStore(true);
    const routing=await buildRoutingContext(memory,context);
    if(!fresh())return {deferred:true,stale:true,reason:'scope-invalidated',memoryId};
    if(!routing.writableBooks.length)return {skipped:true,reason:'no-writable-lorebooks'};
    const {readableBooks,writableBooks,writableTreeBooks,treelessWritableBooks,all,candidates,tree,mode,assumptions}=routing;
    const prompt=`Nexus SUMMARY → LORE ROUTER\n\nSOURCE MEMORY\nID: ${memory.id}\nLayer: ${memory.layer}\nTurns: ${memory.turnRange?`${memory.turnRange[0]}-${memory.turnRange[1]}`:'unknown'}\nCharacters: ${memory.characters.join(', ')||'(none tagged)'}\nLocations: ${memory.locations.join(', ')||'(none tagged)'}\nTopics: ${memory.topics.join(', ')||'(none tagged)'}\nThreads: ${memory.threads.join(', ')||'(none tagged)'}\n\n${memory.text}\n\nTREE INDEX\n${tree}\n\nRELEVANT EXISTING LORE CANDIDATES\n${candidateText(candidates)||'(none found)'}\n\nWRITABLE LOREBOOK TARGETS\n${writableBooks.map(b=>`- ${b}`).join('\n')}\nOnly these lorebooks may be targeted by operations. Read-only books may appear above as reference material but MUST NOT be modified.\n\nTREE-OPTIONAL ROUTING\n${treelessWritableBooks.length?`These writable lorebooks do not have a Nexus Tree yet: ${treelessWritableBooks.join(', ')}. They are still valid lore targets. For a Tree-less book, create durable lore as a new remember operation with node_id:null. Do NOT invent Tree nodes or category IDs for that book.`:'All writable targets currently have Nexus Trees.'}\n\nROUTING POLICY\n${modeInstruction(mode)}\nThe Summary Bank is chronological memory; lorebooks are canonical world/story memory. Only route durable canon worth maintaining. Narrative-only texture can remain in the Summary Bank. Before creating a new entry, check the supplied candidates for a natural existing home. New lore entries ARE allowed and should be proposed when the summary establishes distinct durable canon. Tree categories may also be proposed when structurally useful in books that already have a Tree. For NEW entries only, generate a short, specific activation-key list that helps retrieval. For existing entries, preserve existing keywords exactly and do not modify them. Never mutate lore directly. Never invent UIDs or node IDs.\n\nSTRICT OUTPUT\nReturn ONLY JSON: {"operations":[...],"reasoning":"short explanation"}.\nAllowed operations and exact targets:\n- {"type":"remember","book":"...","node_id":"existing node id or null","title":"...","content":"...","keys":["activation keyword"]}\n- {"type":"update","book":"...","uid":123,"mode":"append|replace","content":"..."}\n- {"type":"merge","book":"...","keep_uid":123,"remove_uid":456}\n- {"type":"split","book":"...","uid":123,...}\n- {"type":"move_entry","book":"...","uid":123,"node_id":"existing node id"}\n- {"type":"create_category","book":"...","parent_node_id":"existing node id","label":"...","summary":"..."}\n- rename_category/move_category/delete_category with exact existing node_id.\nAn empty operations array is valid. Do not create temporary IDs linking one proposal to another.`;
    const semanticContract=routingSemanticContract(writableBooks,candidates);
    // A lorebook without a Tree remains a valid durable UID target.  When every
    // writable target is Tree-less, keep the model on the only structurally safe
    // operation: create a new UID with no node placement.  In mixed-book setups,
    // apply the same restriction per Tree-less target so a model cannot
    // accidentally bootstrap structure as a side effect of Summary Digest.
    if(!writableTreeBooks.length)semanticContract.allowedOperationTypes=['remember','create','create_entry'];
    const treelessTargets=new Set(treelessWritableBooks.map(String));
    const structuredValidator=value=>{
        const verdict=validateMutationEnvelope(value,semanticContract);
        if(verdict?.valid===false||!treelessTargets.size)return verdict;
        const invalid=(Array.isArray(value?.operations)?value.operations:[]).find(op=>{
            const book=String(op?.book||'').trim(),type=String(op?.type||'').toLowerCase();
            return treelessTargets.has(book)&&!['remember','create','create_entry'].includes(type);
        });
        if(!invalid)return verdict;
        return {valid:false,score:0,value,reason:`Tree-less lorebook ${String(invalid.book||'')} accepts only new UID proposals until a Tree exists.`};
    };
    const tx=beginLoreRoutingTransaction({assumptions,metadata:{cycleId,manual,automaticCanonicalHome:automaticCanonical,...(directorMeta||{})}});
    let transactionId=tx.id;
    let job=null,response=null,parsed=null;
    try{
        if(automaticCanonical){
            const planned=await runAutomaticSummaryCanonicalPlanning({memory,writableBooks,settings,enqueueSidecar,cycleId,directorMeta,fresh,context});
            job=planned.job;response=planned.response;parsed=planned.parsed;
        }else{
            job=enqueueLoreRouterSidecar(enqueueSidecar,BUS_STAGE.SUMMARY_LORE_ROUTE,structuredSidecarOptions({prompt,systemPrompt:'You are the Nexus Summary-to-Lore Router. Compare narrative memory against canonical Tree/lore and propose only durable canon changes. New lore entries are allowed. Return exact JSON only.',reasoningEffort:settings.memoryBank?.loreRouting?.reasoningEffort||'high',maxTokens:4096,timeoutMs:Number(settings.memoryBank?.loreRouting?.timeoutMs)||240000,priority:BUS_PRIORITY.SUMMARY_LORE_ROUTE,maxAttempts:1,dedupKey:`summary-lore-route:${memory.id}`,label:`Route memory L${memory.layer} to Lore`,structuredValidator,synthesisCandidateParser:text=>parse(text,structuredValidator),telemetry:{memoryId:memory.id,memoryLayer:memory.layer,cycleId,manual,candidateCount:candidates.length,searchCandidateCount:all.length,candidateLimit:ROUTER_CANDIDATE_LIMIT,contentCharsPerCandidate:ROUTER_CONTENT_CHARS,...(directorMeta||{})}}));
            response=await job.promise;
            if(!fresh())throw Object.assign(new Error('Summary-to-Lore scope invalidated after model execution.'),{name:'TV2ScopeInvalidated'});
            parsed=parse(response.structuredPayload??response.text,structuredValidator);
        }
        const ops=Array.isArray(parsed.operations)?parsed.operations:[];const staged=[],failures=[];
        const stagedTx=finalizeLoreRoutingTransaction(transactionId,{parsed,metadata:{cycleId,manual,workerJobId:job?.id||job?.jobId||null,...(directorMeta||{})}});
        if(stagedTx.state!=='staged')throw new Error(stagedTx.error||stagedTx.validation?.reason||'Summary-to-Lore transaction failed validation.');
        const currentMemory=getMemoryRecord(memory.id);
        if(!currentMemory){await failNexusTransaction(transactionId,new Error('Source memory disappeared before routing commit.'),{stage:'summary-lore-route-prechildren',recoveryRequired:false});return {failed:true,stale:true,memoryId:memory.id,transactionId,error:'Source memory disappeared before routing commit.'};}
        const currentRouting=await buildRoutingContext(currentMemory,context);
        if(!fresh()){
            try{abortNexusTransaction(transactionId,'Summary-to-Lore scope invalidated after staging and before child admission.');}catch{}
            return {deferred:true,stale:true,reason:'scope-invalidated',memoryId,transactionId};
        }
        // HOTFIX44: all semantic/candidate freshness is finalized before any
        // child lore write.  Children are allowed to mutate the very lore
        // surfaces represented by these assumptions, so the parent metadata
        // commit must not later invalidate itself by rebuilding them.
        const routingFreshness=enforceNexusTransactionFreshBeforeStage(transactionId,currentRouting.assumptions);
        if(routingFreshness?.state==='stale')return {deferred:true,stale:true,reason:'transaction-stale',memoryId,transactionId,freshness:routingFreshness?.freshness||null};
        const parentFreshnessBaseline=currentRouting.assumptions;
        const preMemoryStore=JSON.parse(JSON.stringify(getMemoryStore()));
        await beginLoreRoutingSaga({transactionId,chatId:context?.chatId??null,memoryId:memory.id,sourceRevision:scope.revision,preMemoryStore,reasoning:parsed.reasoning||'',deleteAfterDigest});
        logEvent('memory','lore-route-analysis',{memoryId:memory.id,cycleId,manual,jobId:job?.id||job?.jobId||null,transactionId,slot:response?.tv2?.slot||null,mode,candidateCount:candidates.length,operationCount:ops.length,reasoning:parsed.reasoning||''},'info');
        const directWriteIds=[];
        for(const op of ops){
            if(!fresh()){const e=new Error('Summary-to-Lore scope invalidated during commit.');e.name='TV2ScopeInvalidated';failures.push({type:op?.type||'unknown',message:e.message});break;}
            try{
                const requestedBook=String(op?.book||op?.lorebook||'').trim();
                if(requestedBook&&writeValveMode(requestedBook)==='disabled'){logEvent('memory','lore-route-write-valve-disabled',{memoryId:memory.id,transactionId,book:requestedBook,type:op?.type||'unknown',mutationSuppressed:true},'info');continue;}
                const p=await stageOperation(op,memory,parsed.reasoning||'',origin,transactionId);
                if(p&&!p.resolvedDuplicate&&!staged.includes(p.id)){staged.push(p.id);await updateLoreRoutingSaga(transactionId,{proposalIds:staged,directWriteIds});}
                if(!fresh()){const e=new Error('Summary-to-Lore scope invalidated after proposal staging.');e.name='TV2ScopeInvalidated';throw e;}
                if(p){const routed=await routeOperation(p,{book:p.op.book,source:'summary-lore-router',parentTransactionId:transactionId});if(routed.mode==='direct'&&routed.write?.id){directWriteIds.push(routed.write.id);await updateLoreRoutingSaga(transactionId,{proposalIds:staged,directWriteIds});}if(!fresh()){const e=new Error('Summary-to-Lore scope invalidated after write routing.');e.name='TV2ScopeInvalidated';throw e;}}
            }catch(error){failures.push({type:op?.type||'unknown',message:error?.message||String(error)});logEvent('memory','lore-route-stage-detail',{memoryId:memory.id,operation:op,error},'debug');break;}
        }
        if(failures.length){
            const reason='Parent Summary-to-Lore transaction rolled back after a sibling operation failed.';
            const rollbackFailures=await rollbackRoutingSideEffects({transactionId,directWriteIds,staged,proposalStoreRef,context,reason});
            const error=new Error(`Summary-to-Lore atomic commit failed: ${failures[0]?.message||'operation failed'}`);
            await resolveLoreRoutingSaga(transactionId,rollbackFailures.length?'recovery-required':'rolled-back',{error:error.message});
            await failNexusTransaction(transactionId,error,{stage:'summary-lore-route-atomic',failures,rollbackFailures,recoveryRequired:rollbackFailures.length>0});
            logEvent('memory','lore-route-rolled-back',{memoryId:memory.id,transactionId,failedCount:failures.length,rollbackFailures,proposalCount:staged.length},rollbackFailures.length?'error':'warn');
            return {failed:true,retryable:true,rolledBack:rollbackFailures.length===0,memoryId:memory.id,transactionId,failures,rollbackFailures,proposalIds:[]};
        }
        const directWrites=directWriteIds.length;
        const state=staged.length?(directWrites?'direct-written':'proposed'):'routed-noop';
        const durabilityContext=context;
        const beforeStore=JSON.parse(JSON.stringify(getMemoryStore()));
        const preview=previewMemoryRouteState(memory.id,{state,proposalIds:staged,reasoning:parsed.reasoning||''},beforeStore);
        try{await updateLoreRoutingSaga(transactionId,{proposalIds:staged,directWriteIds,postMemoryStore:preview.store});}
        catch(sagaPersistenceError){
            const reason='Parent Summary-to-Lore transaction rolled back because its recovery saga could not persist intended post-state before parent commit.';
            const rollbackFailures=await rollbackRoutingSideEffects({transactionId,directWriteIds,staged,proposalStoreRef,context,reason});
            const failures=[{type:'parent-saga-persistence',message:sagaPersistenceError?.message||String(sagaPersistenceError)}];
            const error=new Error(`Summary-to-Lore atomic commit failed: ${failures[0].message}`);error.cause=sagaPersistenceError;
            try{await resolveLoreRoutingSaga(transactionId,rollbackFailures.length?'recovery-required':'rolled-back',{error:error.message});}catch(settlementError){rollbackFailures.push({kind:'saga-settlement',message:settlementError?.message||String(settlementError)});}
            try{await failNexusTransaction(transactionId,error,{stage:'summary-lore-route-saga-precommit',failures,rollbackFailures,recoveryRequired:rollbackFailures.length>0});}catch{}
            return {failed:true,retryable:true,rolledBack:rollbackFailures.length===0,memoryId:memory.id,transactionId,failures,rollbackFailures,proposalIds:[]};
        }
        let committedParent;
        try{
            assertDirectWritesActive(directWriteIds,transactionId);
            committedParent=await commitCanonicalNexusMutation(transactionId,{type:'metadata.set',chatId:String(durabilityContext?.chatId||''),key:'tv2_memory_bank',value:preview.store,expected:beforeStore},{context:durabilityContext,currentAssumptions:()=>parentFreshnessBaseline,preflight:()=>{if(!fresh()){const error=new Error('Summary-to-Lore scope invalidated before final route-state persistence.');error.name='TV2MutationStale';error.tv2PreMutationStale=true;throw error;}},committed:()=>({memoryId:memory.id,state,proposalIds:staged,directWrites,failedCount:0})});
            if(committedParent.state!=='committed')throw Object.assign(new Error(committedParent.error||'Summary-to-Lore parent route-state mutation did not commit.'),{tv2ParentState:committedParent.state});
        }catch(routeStateError){
            const reason='Parent Summary-to-Lore transaction rolled back because routed-state durability could not be established.';
            const rollbackFailures=await rollbackRoutingSideEffects({transactionId,directWriteIds,staged,proposalStoreRef,context,reason});
            const failures=[{type:'route-state-persistence',message:routeStateError?.message||String(routeStateError)}];
            const error=new Error(`Summary-to-Lore atomic commit failed: ${failures[0].message}`);error.cause=routeStateError;
            try{await resolveLoreRoutingSaga(transactionId,rollbackFailures.length?'recovery-required':'rolled-back',{error:error.message});}catch(settlementError){rollbackFailures.push({kind:'saga-settlement',message:settlementError?.message||String(settlementError)});}
            try{await failNexusTransaction(transactionId,error,{stage:'summary-lore-route-atomic',failures,rollbackFailures,recoveryRequired:rollbackFailures.length>0||routeStateError?.tv2RollbackRestored!==true});}catch{}
            logEvent('memory','lore-route-rolled-back',{memoryId:memory.id,transactionId,failedCount:1,rollbackFailures,proposalCount:staged.length,routeStateDurabilityFailed:true},rollbackFailures.length?'error':'warn');
            return {failed:true,retryable:true,rolledBack:rollbackFailures.length===0&&routeStateError?.tv2RollbackRestored===true,memoryId:memory.id,transactionId,failures,rollbackFailures,proposalIds:[]};
        }
        let sagaSettlementDegraded=false,sagaSettlementError='';
        try{await resolveLoreRoutingSaga(transactionId,'committed');}
        catch(settlementError){sagaSettlementDegraded=true;sagaSettlementError=settlementError?.message||String(settlementError);logEvent('memory','lore-route-parent-committed-saga-settlement-degraded',{memoryId:memory.id,transactionId,error:settlementError},'error');}
        const cleanup=!sagaSettlementDegraded?await settleDigestedSummaryAfterLoreChildren(transactionId,{reason:'digested-to-lore'}):{deleted:false,reason:'saga-settlement-degraded'};
        logEvent('memory','lore-route-complete',{memoryId:memory.id,cycleId,manual,jobId:job?.id||job?.jobId||null,transactionId,slot:response?.tv2?.slot||null,operationCount:ops.length,stagedCount:staged.length,directWrites,failedCount:0,proposalIds:staged,summaryDeleted:cleanup.deleted===true,deleteAfterDigest:deleteAfterDigest===true},directWrites?'warn':'info');
        return {routed:true,memoryId:memory.id,operations:ops,proposalIds:staged,failures:[],reasoning:parsed.reasoning||'',slot:response?.tv2?.slot||null,jobId:job?.id||job?.jobId||null,transactionId,sagaSettlementDegraded,sagaSettlementError,summaryDeleted:cleanup.deleted===true,deleteAfterDigest:deleteAfterDigest===true,cleanup};
    }catch(error){if(transactionId){try{await failNexusTransaction(transactionId,error,{stage:'summary-lore-route',recoveryRequired:error?.tv2RollbackRestored!==true});}catch{}try{await resolveLoreRoutingSaga(transactionId,'recovery-required',{error:error?.message||String(error)});}catch{}}logEvent('memory','lore-route-failed',{memoryId:memory.id,cycleId,manual,jobId:job?.id||job?.jobId||null,transactionId,error,retryable:true},'error');return {failed:true,retryable:true,memoryId:memory.id,error:error?.message||String(error),jobId:job?.id||job?.jobId||null,transactionId};}
}

export async function routeUnroutedMemories({cycleId=null,manual=false,ids=null,maxPerCycle=null,enqueueSidecar=null,directorMeta=null}={}){
    let memories=(ids?.length?ids.map(getMemoryRecord):getActiveMemories().filter(r=>r.routeState==='unrouted'&&!r.promotedTo)).filter(Boolean).sort((a,b)=>a.createdAt-b.createdAt);
    const configured=Number(maxPerCycle??getSettings().memoryBank?.loreRouting?.maxPerCycle);if(Number.isFinite(configured)&&configured>0)memories=memories.slice(0,configured);
    const results=[];for(const memory of memories){const r=await routeMemoryToLore(memory.id,{cycleId,manual,enqueueSidecar,directorMeta});results.push(r);if((r.failed||r.deferred)&&!manual)break;}
    return {count:results.length,results,failed:results.some(r=>r?.failed),deferred:results.some(r=>r?.deferred)};
}

