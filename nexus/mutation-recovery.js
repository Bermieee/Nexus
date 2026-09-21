import { loadBook, saveBook, clone, findEntryByUid } from '../lore/store.js';
import { getTree, setTreeDirect, deleteTreeDirect, setTreeBundleDirect } from '../tree/store.js';
import { currentNodeForUid, removeEntryEverywhere, assignEntry } from '../tree/ops.js';
import { findNode, semanticSnapshot } from '../tree/model.js';
import { flushSettingsPersistence } from '../core/settings.js';
import { flushChatMetadataPersistence } from './host-durability.js';
import { OP } from '../proposals/types.js';
import { assertNexusMutationAuthority, loreMutationResource, treeMutationResource, metadataMutationResource } from './mutation-lock.js';

const ENTRY_MUTATIONS = new Set([
    OP.ENTRY_CREATE, OP.ENTRY_UPDATE, OP.ENTRY_DELETE,
    OP.ENTRY_MERGE, OP.ENTRY_SPLIT, OP.ENTRY_MOVE,
]);
const STRUCTURAL_TREE_MUTATIONS = new Set([
    OP.TREE_NODE_CREATE, OP.TREE_NODE_RENAME, OP.TREE_NODE_MOVE,
    OP.TREE_NODE_DELETE, OP.TREE_REPLACE, OP.TREE_DELETE,
]);
const ASSIGNMENT_TREE_MUTATIONS = new Set([
    OP.TREE_ENTRY_ASSIGN, OP.TREE_ENTRY_UNASSIGN,
]);
const METADATA_MUTATIONS = new Set([OP.METADATA_SET]);
const RECOVERY_RESTORE_TYPE = 'nexus.recovery.restore';
const TREE_IMPORT_BUNDLE_TYPE = 'tree.import.bundle';

function same(a,b){return JSON.stringify(a??null)===JSON.stringify(b??null);}
function numericUid(value){const n=Number(value);return Number.isFinite(n)?n:null;}
function uniqueUids(values=[]){return [...new Set(values.map(numericUid).filter(Number.isFinite))].sort((a,b)=>a-b);}
function entryKeyForUid(entries,uid){for(const [key,entry] of Object.entries(entries||{}))if(Number(entry?.uid)===Number(uid))return key;return null;}
function allBookUids(data){return uniqueUids(Object.values(data?.entries||{}).map(entry=>entry?.uid));}
function knownEntryUids(op={}){
    switch(String(op.type||'')){
        case OP.ENTRY_UPDATE:
        case OP.ENTRY_DELETE:
        case OP.ENTRY_SPLIT:
        case OP.ENTRY_MOVE:return uniqueUids([op.uid]);
        case OP.ENTRY_MERGE:return uniqueUids([op.keepUid,op.removeUid]);
        case OP.TREE_ENTRY_ASSIGN:
        case OP.TREE_ENTRY_UNASSIGN:return uniqueUids([op.uid]);
        default:return [];
    }
}
function mayCreateEntry(op={}){return op.type===OP.ENTRY_CREATE||op.type===OP.ENTRY_SPLIT;}
function touchesTreeAssignments(op={}){
    if(ASSIGNMENT_TREE_MUTATIONS.has(op.type))return true;
    if(op.type===OP.ENTRY_UPDATE)return op.targetNodeId!==undefined;
    return [OP.ENTRY_CREATE,OP.ENTRY_DELETE,OP.ENTRY_MERGE,OP.ENTRY_SPLIT,OP.ENTRY_MOVE].includes(op.type);
}
function normalizedKeys(value){return Array.isArray(value)?value.map(String).map(s=>s.trim()).filter(Boolean):[];}
function creationExpectation(op={}){
    if(op.type===OP.ENTRY_CREATE)return {count:1,title:String(op.title||'').trim(),content:String(op.content||'').trim(),constant:op.constant===true,key:normalizedKeys(op.keys),disable:false,selective:false};
    if(op.type===OP.ENTRY_SPLIT)return {count:1,title:String(op.newTitle||'').trim(),content:String(op.newContent||'').trim(),constant:false,key:[],disable:false,selective:false};
    return null;
}

/**
 * HOTFIX46.30: 46.29 captured entry.create recovery expectations with key:[]
 * even when the canonical mutation created activation keys.  Upgrade only that
 * exact legacy shape from the immutable journal mutation so interrupted creates
 * can be proved without weakening generated-UID attribution.
 */
export function upgradeLegacyCreateRecoveryExpectation(snapshot, mutation={}){
    const out=clone(snapshot);
    if(out?.version!==2||out?.kind!=='mutation-delta'||out?.opType!==OP.ENTRY_CREATE)return out;
    if(String(mutation?.type||'')!==OP.ENTRY_CREATE||String(mutation?.book||'')!==String(out.book||''))return out;
    const expected=out.creationExpectation;
    if(!expected||!Array.isArray(expected.key)||expected.key.length!==0)return out;
    const canonicalKeys=normalizedKeys(mutation.keys);
    if(!canonicalKeys.length)return out;
    if(String(expected.title||'').trim()!==String(mutation.title||'').trim())return out;
    if(String(expected.content||'').trim()!==String(mutation.content||'').trim())return out;
    if((expected.constant===true)!==(mutation.constant===true))return out;
    expected.key=canonicalKeys;
    out.legacyCreateKeyExpectationUpgraded=true;
    out.serializedChars=descriptorChars(out);
    return out;
}
function entryComparableState(entry,uid=null){
    if(!entry)return null;
    return {uid:Number(entry.uid??uid),content:String(entry.content??''),comment:String(entry.comment??''),key:clone(entry.key||[]),constant:entry.constant===true,disable:entry.disable===true,selective:entry.selective===true};
}
function entryMatchesCreationExpectation(entry,expected){
    if(!entry||!expected)return false;
    return String(entry.comment||'').trim()===String(expected.title||'').trim()
        && String(entry.content||'').trim()===String(expected.content||'').trim()
        && (entry.constant===true)===(expected.constant===true)
        && same(entry.key||[],expected.key||[])
        && (entry.disable===true)===(expected.disable===true)
        && (entry.selective===true)===(expected.selective===true);
}
function generatedCompositeExpectation(op={},data=null,tree=null){
    if(!mayCreateEntry(op))return null;
    const treeInvariant=tree?clone(tree):null;
    if(op.type===OP.ENTRY_CREATE){
        const target=String(op.targetNodeId??'').trim();
        return {kind:'create',treeExistedPre:Boolean(tree),treeInvariant,generatedAssignment:tree?{mode:'node',nodeId:target||String(tree.root?.id||'')}:(target?{mode:'unprovable-created-tree-target',nodeId:target}:{mode:'fresh-created-root'})};
    }
    const source=findEntryByUid(data?.entries,op.uid);
    const expectedSource=entryComparableState(source,op.uid);
    if(expectedSource){
        expectedSource.content=String(op.keepContent??'').trim();
        if(op.keepTitle!==undefined&&String(op.keepTitle).trim())expectedSource.comment=String(op.keepTitle).trim();
    }
    const inherited=String(op.newTargetNodeId||op.expectedNodeId||'').trim();
    const assignment=tree?{mode:'node',nodeId:inherited||String(tree.root?.id||'')}:(inherited?{mode:'unprovable-created-tree-target',nodeId:inherited}:{mode:'none'});
    return {kind:'split',sourceUid:Number(op.uid),expectedSource,treeExistedPre:Boolean(tree),treeInvariant,generatedAssignment:assignment};
}
function freshCreatedTreeMatches(tree,book,createdUid){
    if(!tree?.root)return false;
    const root=tree.root;
    return String(tree.lorebookName||'')===String(book||'')
        && Number(tree.version)===2
        && String(root.label||'')==='Root'
        && String(root.summary||'')===`Top-level index for ${book}`
        && same(root.keywords||[],[])
        && same((root.entryUids||[]).map(Number).sort((a,b)=>a-b),[Number(createdUid)])
        && Array.isArray(root.children)&&root.children.length===0
        && root.collapsed===false;
}
function assertGeneratedCompositePost(snapshot,data,tree,createdUid){
    const expected=snapshot?.generatedCompositeExpectation;
    if(!expected)return true;
    if(expected.kind==='split'){
        const source=findEntryByUid(data?.entries,expected.sourceUid);
        if(!same(entryComparableState(source,expected.sourceUid),expected.expectedSource))throw attributionConflict('Split recovery finalization refused because the source UID rewrite was incomplete or diverged.',{sourceUid:expected.sourceUid});
    }
    const assignment=expected.generatedAssignment||{mode:'none'};
    const currentNode=tree?.root?(currentNodeForUid(tree,createdUid)?.id||null):null;
    if(assignment.mode==='node'&&String(currentNode||'')!==String(assignment.nodeId||''))throw attributionConflict('Create/split recovery finalization refused because the generated UID Tree assignment was incomplete or diverged.',{createdUid,currentNode,expectedNodeId:assignment.nodeId});
    if(assignment.mode==='fresh-created-root'){
        if(!freshCreatedTreeMatches(tree,snapshot.book,createdUid))throw attributionConflict('Create recovery finalization refused because the newly-created Tree did not match the complete canonical create effect.',{createdUid,currentNode});
    }
    if(assignment.mode==='none'&&(tree||currentNode))throw attributionConflict('Split recovery finalization refused because a Tree appeared even though the staged split could not canonically create or modify one.',{createdUid,currentNode});
    if(assignment.mode==='unprovable-created-tree-target')throw attributionConflict('Generated-UID recovery cannot prove ownership of a Tree target that did not exist at admission.',{createdUid,expectedNodeId:assignment.nodeId});
    if(expected.treeExistedPre&&!tree?.root)throw attributionConflict('Create/split recovery finalization refused because the pre-existing Tree disappeared.',{createdUid});
    // HOTFIX32: ownership stops at the generated UID assignment (and split source
    // rewrite above). Unrelated nodes/assignments are outside this mutation's
    // footprint and may change without making an otherwise exact POST unknowable.
    return true;
}
function checkpointedGeneratedPost(snapshot,data,tree){
    if(!Array.isArray(snapshot?.preUidSet)||snapshot?.postView)return null;
    const before=uniqueUids(snapshot.preUidSet),now=allBookUids(data),observedAdded=now.filter(uid=>!before.includes(uid));
    if(same(now,before))return null;
    const ownedAdded=uniqueUids(snapshot?.addedUids||[]),expectedCount=Number(snapshot?.creationExpectation?.count||1);
    // A changed UID set alone is not attribution. We only recognize interrupted
    // create/split POST when a durable lore checkpoint recorded the exact generated
    // UID and the current mutation-owned footprint still matches that checkpoint.
    if(observedAdded.length!==expectedCount||!same(observedAdded,ownedAdded)){
        return {compatible:false,state:'conflict',reason:'post-state-unknown-created-uids-changed',currentUidSet:now,preUidSet:before,checkpointAddedUids:ownedAdded};
    }
    const createdUid=observedAdded[0],created=findEntryByUid(data?.entries,createdUid);
    if(!entryMatchesCreationExpectation(created,snapshot?.creationExpectation)){
        return {compatible:false,state:'conflict',reason:'checkpointed-created-entry-diverged',createdUid,currentUidSet:now};
    }
    try{assertGeneratedCompositePost(snapshot,data,tree,createdUid);}
    catch(error){return {compatible:false,state:'conflict',reason:'checkpointed-generated-footprint-diverged',createdUid,error:String(error?.message||error)};}
    const checkpoint=snapshot?.checkpointPostView||null;
    if(!checkpoint||!Object.prototype.hasOwnProperty.call(checkpoint,'entries')){
        return {compatible:false,state:'conflict',reason:'generated-uid-checkpoint-incomplete',createdUid};
    }
    const assignmentMode=String(snapshot?.generatedCompositeExpectation?.generatedAssignment?.mode||'none');
    const assignmentCheckpointRequired=assignmentMode==='node'||assignmentMode==='fresh-created-root';
    if(assignmentCheckpointRequired&&!Object.prototype.hasOwnProperty.call(checkpoint,'assignments')){
        return {compatible:false,state:'conflict',reason:'generated-tree-checkpoint-incomplete',createdUid};
    }
    if(assignmentMode==='fresh-created-root'&&!Object.prototype.hasOwnProperty.call(checkpoint,'treePresent')){
        return {compatible:false,state:'conflict',reason:'generated-tree-presence-checkpoint-incomplete',createdUid};
    }
    const presenceOwned=snapshot.treeExistedPre===false&&[snapshot.preView,snapshot.postView,snapshot.checkpointPostView]
        .some(view=>view&&Object.prototype.hasOwnProperty.call(view,'treePresent'));
    const current=resourceView({data,tree,uids:snapshot.trackedUids||[],structuralTree:snapshot.structuralTree===true,treeExistedPre:snapshot.treeExistedPre!==false,includeTreePresence:presenceOwned});
    const partial=partialProjectionState(snapshot,current);
    if(!partial?.compatible){
        return {compatible:false,state:'conflict',reason:'checkpointed-generated-footprint-diverged',createdUid,current};
    }
    return {compatible:true,state:'post',reason:'checkpointed-generated-post-proven',createdUid,current};
}
function attributionConflict(message,details={}){const error=new Error(message);error.name='TV2RecoveryAttributionConflict';Object.assign(error,details);return error;}
function recoveryAuthorityResources(snapshot){
    if(snapshot?.kind==='recovery-inverse')return recoveryAuthorityResources(snapshot.sourceRecovery);
    if(snapshot?.kind==='metadata-mutation')return [metadataMutationResource(snapshot.chatId)];
    if(snapshot?.kind==='tree-import-bundle'){
        const resources=[];
        for(const row of snapshot?.preView?.trees||snapshot?.expectedPostView?.trees||[]){
            const book=String(row?.book||'').trim();
            if(!book)continue;
            resources.push(loreMutationResource(book),treeMutationResource(book));
        }
        if(!resources.length)throw new Error('Tree import bundle recovery descriptor is missing resource identity.');
        return [...new Set(resources)].sort();
    }
    const book=String(snapshot?.book||'').trim();
    if(!book)throw new Error('Recovery descriptor is missing its resource identity.');
    if(snapshot?.kind==='legacy-whole-book')return [loreMutationResource(book),treeMutationResource(book)];
    if(ENTRY_MUTATIONS.has(snapshot?.opType)){
        const touchesTree=snapshot?.structuralTree===true||snapshot?.tracksAssignments===true;
        return touchesTree?[loreMutationResource(book),treeMutationResource(book)]:[loreMutationResource(book)];
    }
    return [treeMutationResource(book)];
}
function snapshotEntry(data,uid){
    const key=entryKeyForUid(data?.entries,uid);
    const entry=key==null?null:findEntryByUid(data?.entries,uid);
    return {uid:Number(uid),key,entry:entry?clone(entry):null};
}
function snapshotAssignments(tree,uids=[]){
    return uniqueUids(uids).map(uid=>({uid,nodeId:tree?.root?(currentNodeForUid(tree,uid)?.id||null):null}));
}
function resourceView({data=null,tree=null,uids=[],structuralTree=false,treeExistedPre=true,includeTreePresence=!treeExistedPre}={}){
    const view={};
    if(data)view.entries=uniqueUids(uids).map(uid=>snapshotEntry(data,uid));
    if(structuralTree)view.tree=clone(tree??null);
    else if(uids.length)view.assignments=snapshotAssignments(tree,uids);
    if(includeTreePresence)view.treePresent=Boolean(tree);
    return view;
}
function descriptorChars(snapshot){try{return JSON.stringify(snapshot).length;}catch{return null;}}

/**
 * Capture compact durable inverse authority before a proposal/direct write.
 * Lore entry operations retain only touched entries plus UID identity; structural
 * Tree operations retain the Tree because their inverse is inherently structural.
 * No whole lorebook snapshot is retained for ordinary entry mutations.
 */
export async function captureMutationRecoveryState(op={}, { context = null } = {}){
    if(String(op?.type||'')===RECOVERY_RESTORE_TYPE){
        const source=clone(op?.recovery||null);
        if(!source)throw new Error('Recovery inverse capture requires the source recovery descriptor.');
        const inspection=await inspectMutationRecoveryState(source,{context});
        const allowPartial=inspection.compatible&&inspection.state==='partial'&&(source?.kind==='tree-import-bundle'||Array.isArray(source?.subwriteCheckpoints));
        if(!inspection.compatible||(inspection.state!=='post'&&!allowPartial)){
            const error=new Error('Recovery inverse capture requires canonical state to match the source mutation post-state, or a durably checkpointed known partial state.');
            error.name='TV2MutationStale';error.tv2PreMutationStale=true;error.recoveryState=inspection.state;throw error;
        }
        return {version:2,kind:'recovery-inverse',opType:RECOVERY_RESTORE_TYPE,book:source.book||null,chatId:source.chatId??null,capturedAt:Date.now(),sourceRecovery:source,preView:{sourceState:inspection.state},postView:null};
    }
    if(String(op?.type||'')===OP.METADATA_SET){
        if(!context?.chatMetadata)throw new Error('Captured chat metadata is required for mutation recovery capture.');
        const chatId=String(op.chatId??'').trim();
        if(!chatId)throw new Error('metadata.set recovery capture requires the operation\'s immutable chatId.');
        if(String(context.chatId??'')!==chatId)throw new Error(`metadata.set recovery capture belongs to chat ${chatId}, not ${context.chatId??'none'}.`);
        const key=String(op.key||'');
        const exists=Object.prototype.hasOwnProperty.call(context.chatMetadata,key);
        const expectedPostView=op.delete===true
            ? {exists:false,value:null}
            : {exists:true,value:clone(op.value)};
        return {version:2,kind:'metadata-mutation',opType:OP.METADATA_SET,chatId,key,capturedAt:Date.now(),preView:{exists,value:exists?clone(context.chatMetadata[key]):null},expectedPostView,postView:null};
    }
    if(String(op?.type||'')===TREE_IMPORT_BUNDLE_TYPE){
        const plans=Array.isArray(op?.plans)?op.plans:[];
        if(!plans.length)throw new Error('Tree import bundle recovery capture requires at least one plan.');
        const seen=new Set(),preTrees=[],expectedTrees=[];
        for(const plan of plans){
            const book=String(plan?.book||'').trim();
            if(!book)throw new Error('Tree import bundle recovery capture requires explicit lorebook identity.');
            if(seen.has(book))throw new Error(`Tree import bundle recovery capture received duplicate lorebook "${book}".`);
            seen.add(book);
            const pre=clone(getTree(book));
            const expected=clone(plan?.tree??null);
            preTrees.push({book,tree:pre,semantic:semanticSnapshot(pre)});
            expectedTrees.push({book,tree:expected,semantic:semanticSnapshot(expected)});
        }
        const snapshot={version:2,kind:'tree-import-bundle',opType:TREE_IMPORT_BUNDLE_TYPE,capturedAt:Date.now(),books:[...seen],preView:{trees:preTrees},expectedPostView:{trees:expectedTrees},postView:null};
        snapshot.serializedChars=descriptorChars(snapshot);
        return snapshot;
    }
    if(!op?.book)return null;
    const type=String(op.type||'');
    if(!ENTRY_MUTATIONS.has(type)&&!STRUCTURAL_TREE_MUTATIONS.has(type)&&!ASSIGNMENT_TREE_MUTATIONS.has(type))return null;
    const book=String(op.book);
    const data=ENTRY_MUTATIONS.has(type)?await loadBook(book):null;
    const tree=getTree(book);
    const known=knownEntryUids(op);
    const structuralTree=STRUCTURAL_TREE_MUTATIONS.has(type);
    const snapshot={
        version:2,
        kind:'mutation-delta',
        book,
        opType:type,
        capturedAt:Date.now(),
        structuralTree,
        tracksAssignments:touchesTreeAssignments(op),
        treeExistedPre:Boolean(tree),
        trackedUids:[...known],
        preUidSet:mayCreateEntry(op)?allBookUids(data):null,
        creationExpectation:mayCreateEntry(op)?creationExpectation(op):null,
        generatedCompositeExpectation:mayCreateEntry(op)?generatedCompositeExpectation(op,data,tree):null,
        preView:resourceView({data,tree,uids:known,structuralTree,treeExistedPre:Boolean(tree)}),
        postView:null,
        addedUids:[],
    };
    snapshot.serializedChars=descriptorChars(snapshot);
    return snapshot;
}

/**
 * Persistable partial-post evidence recorded immediately after each durable
 * physical subwrite. This is deliberately compact: touched lore rows, Tree
 * projection/assignments, generated UID identity, and the subwrite sequence.
 */
export async function checkpointMutationRecoveryState(snapshot, { checkpoint = null, context = null } = {}) {
    if (!snapshot || snapshot.version !== 2 || !checkpoint) return snapshot ? clone(snapshot) : null;
    const out = clone(snapshot);
    const cp = clone(checkpoint);
    cp.at = Number(cp.at) || Date.now();
    const list = Array.isArray(out.subwriteCheckpoints) ? out.subwriteCheckpoints : [];
    cp.sequence = list.length + 1;
    list.push(cp);
    out.subwriteCheckpoints = list;
    if (out.kind === 'metadata-mutation') {
        if (cp.domain === 'metadata') out.checkpointPostView = clone(out.expectedPostView);
        out.serializedChars = descriptorChars(out); return out;
    }
    if (out.kind === 'tree-import-bundle') {
        const rows = Array.isArray(out.checkpointPostView?.trees) ? out.checkpointPostView.trees.map(clone) : [];
        const byBook = new Map(rows.map(row => [String(row.book), row]));
        if (cp.domain === 'tree' && cp.book) {
            const tree = cp.postTree !== undefined ? clone(cp.postTree) : clone(getTree(cp.book));
            byBook.set(String(cp.book), { book: String(cp.book), tree, semantic: semanticSnapshot(tree) });
        }
        out.checkpointPostView = { trees: [...byBook.values()] };
        out.serializedChars = descriptorChars(out); return out;
    }
    if (out.kind !== 'mutation-delta') { out.serializedChars = descriptorChars(out); return out; }
    const partial = clone(out.checkpointPostView || {});
    if (cp.domain === 'lore') {
        const touched = uniqueUids([...(out.trackedUids || []), ...(cp.touchedUids || []), cp.createdUid]);
        out.trackedUids = touched;
        if (Number.isFinite(Number(cp.createdUid))) {
            const createdUid = Number(cp.createdUid);
            out.addedUids = uniqueUids([...(out.addedUids || []), createdUid]);
            const preEntries = new Map((out.preView?.entries || []).map(row => [Number(row.uid), row]));
            if (!preEntries.has(createdUid)) preEntries.set(createdUid, { uid: createdUid, key: null, entry: null });
            out.preView.entries = [...preEntries.values()].sort((a,b)=>a.uid-b.uid);
        }
        const data = cp.postBook ? clone(cp.postBook) : await loadBook(out.book);
        partial.entries = touched.map(uid => snapshotEntry(data, uid));
        if (Array.isArray(out.preUidSet)) partial.uidSet = allBookUids(data);
    }
    if (cp.domain === 'tree') {
        const tree = cp.postTree !== undefined ? clone(cp.postTree) : clone(getTree(out.book));
        if (out.structuralTree) partial.tree = tree;
        else if (out.tracksAssignments) {
            partial.assignments = snapshotAssignments(tree, out.trackedUids || []);
            if (out.treeExistedPre === false) { partial.treePresent = Boolean(tree); out.checkpointCreatedTree = tree; }
        }
    }
    out.checkpointPostView = partial;
    out.serializedChars = descriptorChars(out);
    return out;
}

function partialProjectionState(snapshot, current) {
    const pre = snapshot?.preView || {};
    const partial = snapshot?.checkpointPostView || null;
    if (!partial) return null;
    let usedPost = false;
    for (const key of ['entries','tree','assignments','treePresent']) {
        if (!Object.prototype.hasOwnProperty.call(current || {}, key)) continue;
        const c = current?.[key];
        const p = pre?.[key];
        if (Object.prototype.hasOwnProperty.call(partial, key)) {
            const q = partial[key];
            if (same(c, q)) { if (!same(c, p)) usedPost = true; continue; }
        }
        if (same(c, p)) continue;
        return { compatible: false, state: 'conflict' };
    }
    return { compatible: true, state: usedPost ? 'partial' : 'pre' };
}

/** Capture the exact compact post-state before clearing durable recovery. */
export async function finalizeMutationRecoveryState(snapshot, { context = null, executionResult = null } = {}){
    if(snapshot?.version===2&&snapshot?.kind==='recovery-inverse'){
        const out=clone(snapshot),inspection=await inspectMutationRecoveryState(out.sourceRecovery,{context});
        if(!inspection.compatible||inspection.state!=='pre')throw attributionConflict('Recovery inverse finalization refused because the source mutation was not fully restored to its known pre-state.',{recoveryState:inspection.state});
        out.postView={sourceState:'pre'};out.finalizedAt=Date.now();out.serializedChars=descriptorChars(out);return out;
    }
    if(snapshot?.version===2&&snapshot?.kind==='tree-import-bundle'){
        const out=clone(snapshot),expected=new Map((out.expectedPostView?.trees||[]).map(row=>[String(row.book),row]));
        const rows=[];
        for(const book of out.books||[]){
            const current=clone(getTree(book)),target=expected.get(String(book));
            if(!target||!same(semanticSnapshot(current),target.semantic))throw attributionConflict('Tree import bundle recovery finalization refused because a target Tree diverged before post evidence was bound.',{book});
            rows.push({book:String(book),tree:current,semantic:semanticSnapshot(current)});
        }
        out.postView={trees:rows};out.finalizedAt=Date.now();out.serializedChars=descriptorChars(out);return out;
    }
    if(snapshot?.version===2&&snapshot?.kind==='legacy-whole-book')return clone(snapshot);
    if(snapshot?.version===2&&snapshot?.kind==='metadata-mutation'){
        if(!context?.chatMetadata)throw new Error('No active chat metadata for mutation recovery finalization.');
        const out=clone(snapshot);
        if(String(context.chatId??'')!==String(out.chatId??'')){
            throw attributionConflict('Metadata recovery finalization refused because the captured chat identity changed before post evidence was bound.',{expectedChatId:out.chatId,currentChatId:context.chatId??null,key:out.key});
        }
        const exists=Object.prototype.hasOwnProperty.call(context.chatMetadata,out.key);
        const current={exists,value:exists?clone(context.chatMetadata[out.key]):null};
        if(out.expectedPostView&&!same(current,out.expectedPostView)){
            throw attributionConflict('Metadata recovery finalization refused because the metadata value diverged from the canonical operation before post evidence was bound.',{chatId:out.chatId,key:out.key,current});
        }
        out.postView=current;out.finalizedAt=Date.now();return out;
    }
    if(!snapshot?.book||snapshot?.version!==2)return snapshot?clone(snapshot):null;
    const out=clone(snapshot);
    const needsBook=ENTRY_MUTATIONS.has(out.opType);
    const data=needsBook?await loadBook(out.book):null;
    const tree=getTree(out.book);
    if(Array.isArray(out.preUidSet)){
        const before=new Set(out.preUidSet.map(Number));
        const observedAdded=allBookUids(data).filter(uid=>!before.has(uid));
        const createdUid=Number(executionResult?.createdUid);
        const expected=out.creationExpectation||null;
        if(!Number.isFinite(createdUid))throw attributionConflict('Create/split recovery finalization requires the canonical engine\'s generated UID.',{observedAdded});
        if(observedAdded.length!==Number(expected?.count||1)||observedAdded[0]!==createdUid){
            throw attributionConflict('Create/split recovery finalization refused because added UID ownership was ambiguous.',{createdUid,observedAdded});
        }
        const created=findEntryByUid(data?.entries,createdUid);
        if(!entryMatchesCreationExpectation(created,expected)){
            throw attributionConflict('Create/split recovery finalization refused because the generated entry did not match the operation-specific payload.',{createdUid});
        }
        assertGeneratedCompositePost(out,data,tree,createdUid);
        out.addedUids=[createdUid];
        out.trackedUids=uniqueUids([...(out.trackedUids||[]),createdUid]);
        // Extend the pre-view with explicit absence only for the UID proven to
        // belong to this canonical operation. Unmatched additions never become
        // inverse authority.
        const preEntries=new Map((out.preView?.entries||[]).map(row=>[Number(row.uid),row]));
        if(!preEntries.has(createdUid))preEntries.set(createdUid,{uid:createdUid,key:null,entry:null});
        if(needsBook)out.preView.entries=[...preEntries.values()].sort((a,b)=>a.uid-b.uid);
        const preAssign=new Map((out.preView?.assignments||[]).map(row=>[Number(row.uid),row]));
        if(!preAssign.has(createdUid))preAssign.set(createdUid,{uid:createdUid,nodeId:null});
        if(out.tracksAssignments&&!out.structuralTree)out.preView.assignments=[...preAssign.values()].sort((a,b)=>a.uid-b.uid);
    }
    out.postView=resourceView({data,tree,uids:out.trackedUids||[],structuralTree:out.structuralTree,treeExistedPre:out.treeExistedPre!==false});
    // If the mutation created the first Tree, keep the exact immediate image only
    // as rollback authority. POST detection itself uses treePresent + tracked UID
    // assignment, so later unrelated Tree growth cannot strand recovery.
    if(out.tracksAssignments&&!out.structuralTree&&out.treeExistedPre===false&&tree)out.createdTreePost=clone(tree);
    out.finalizedAt=Date.now();
    out.serializedChars=descriptorChars(out);
    return out;
}

export async function inspectMutationRecoveryState(snapshot, { context = null } = {}){
    if(snapshot?.version===2&&snapshot?.kind==='recovery-inverse'){
        const source=await inspectMutationRecoveryState(snapshot.sourceRecovery,{context});
        if(source.compatible&&source.state==='post')return {compatible:true,state:'pre',current:source.current,sourceState:'post'};
        if(source.compatible&&source.state==='pre')return {compatible:true,state:'post',current:source.current,sourceState:'pre'};
        return {compatible:false,state:'conflict',reason:'recovery-inverse-source-diverged',current:source.current,sourceState:source.state};
    }
    if(snapshot?.version===2&&snapshot?.kind==='tree-import-bundle'){
        const pre=new Map((snapshot.preView?.trees||[]).map(row=>[String(row.book),row]));
        const postRows=snapshot.postView?.trees||snapshot.expectedPostView?.trees||[];
        const post=new Map(postRows.map(row=>[String(row.book),row]));
        const currentRows=[];let hasPreOnly=false,hasPostOnly=false;
        for(const book of snapshot.books||[]){
            const currentTree=clone(getTree(book)),currentSemantic=semanticSnapshot(currentTree),before=pre.get(String(book)),after=post.get(String(book));
            if(!before||!after)return {compatible:false,state:'conflict',reason:'tree-import-bundle-descriptor-incomplete',current:{trees:currentRows}};
            const isPre=same(currentSemantic,before.semantic),isPost=same(currentSemantic,after.semantic);
            const state=isPre&&isPost?'neutral':isPre?'pre':isPost?'post':'conflict';
            currentRows.push({book:String(book),tree:currentTree,semantic:currentSemantic,state});
            if(state==='conflict')return {compatible:false,state:'conflict',reason:'tree-import-bundle-current-state-diverged',current:{trees:currentRows}};
            if(state==='pre')hasPreOnly=true;
            if(state==='post')hasPostOnly=true;
        }
        const state=hasPreOnly&&hasPostOnly?'partial':hasPostOnly?'post':'pre';
        return {compatible:true,state,current:{trees:currentRows}};
    }
    if(snapshot?.version===2&&snapshot?.kind==='legacy-whole-book'){
        const data=clone(await loadBook(snapshot.book)),tree=clone(getTree(snapshot.book));
        const current={book:data,tree};
        if(same(current,snapshot.preView))return {compatible:true,state:'pre',current};
        if(snapshot.postView&&same(current,snapshot.postView))return {compatible:true,state:'post',current};
        return {compatible:false,state:'conflict',reason:'legacy-current-state-diverged-from-known-pre-post',current};
    }
    if(snapshot?.version===2&&snapshot?.kind==='metadata-mutation'){
        if(!context?.chatMetadata)return {compatible:false,state:'conflict',reason:'metadata-context-unavailable'};
        if(snapshot.chatId!=null&&String(context.chatId??'')!==String(snapshot.chatId))return {compatible:false,state:'conflict',reason:'metadata-chat-changed'};
        const exists=Object.prototype.hasOwnProperty.call(context.chatMetadata,snapshot.key),current={exists,value:exists?clone(context.chatMetadata[snapshot.key]):null};
        if(same(current,snapshot.preView))return {compatible:true,state:'pre',current};
        const knownPost=snapshot.postView||snapshot.expectedPostView||snapshot.checkpointPostView||null;
        if(knownPost&&same(current,knownPost))return {compatible:true,state:'post',current};
        return {compatible:false,state:'conflict',reason:knownPost?'current-state-diverged-from-known-pre-post':'post-state-unknown',current};
    }
    if(!snapshot?.book||snapshot?.version!==2)return {compatible:false,reason:'unsupported-recovery-state'};
    const needsBook=ENTRY_MUTATIONS.has(snapshot.opType);
    const data=needsBook?await loadBook(snapshot.book):null;
    const tree=getTree(snapshot.book);
    // A create/split recovery image captured before execution has no generated UID yet.
    // If the book UID set changed before post-state finalization, physical mutation may
    // already have happened and we must never misclassify that state as the pre-image.
    if(Array.isArray(snapshot.preUidSet)&&!snapshot.postView){
        const checkpointed=checkpointedGeneratedPost(snapshot,data,tree);
        if(checkpointed)return checkpointed;
        const before=uniqueUids(snapshot.preUidSet);
        const now=allBookUids(data);
        if(!same(now,before))return {compatible:false,state:'conflict',reason:'post-state-unknown-created-uids-changed',currentUidSet:now,preUidSet:before};
    }
    // HOTFIX32 writes explicit Tree-presence authority for newly captured descriptors,
    // but older durable v2 descriptors did not carry treePresent. Preserve backward
    // compatibility with those pre-HOTFIX32 recovery rows by comparing only fields
    // that their descriptor actually owned.
    const presenceOwned=snapshot.treeExistedPre===false&&[snapshot.preView,snapshot.postView,snapshot.checkpointPostView]
        .some(view=>view&&Object.prototype.hasOwnProperty.call(view,'treePresent'));
    const current=resourceView({data,tree,uids:snapshot.trackedUids||[],structuralTree:snapshot.structuralTree===true,treeExistedPre:snapshot.treeExistedPre!==false,includeTreePresence:presenceOwned});
    if(same(current,snapshot.preView))return {compatible:true,state:'pre',current};
    if(snapshot.postView&&same(current,snapshot.postView))return {compatible:true,state:'post',current};
    const partial=partialProjectionState(snapshot,current);
    if(partial?.compatible)return {...partial,current};
    return {compatible:false,state:'conflict',reason:(snapshot.postView||snapshot.checkpointPostView)?'current-state-diverged-from-known-pre-post':'post-state-unknown',current};
}

function restoreEntryRows(data,rows=[]){
    for(const row of rows){
        const uid=Number(row.uid);
        const currentKey=entryKeyForUid(data.entries,uid);
        if(row.entry==null){if(currentKey!=null)delete data.entries[currentKey];continue;}
        if(currentKey!=null&&currentKey!==row.key)delete data.entries[currentKey];
        const key=row.key!=null?String(row.key):String(uid);
        data.entries[key]=clone(row.entry);
    }
}
async function persistTree(book,tree,onPhysicalPersistenceBegin=null){
    if(typeof onPhysicalPersistenceBegin==='function')await onPhysicalPersistenceBegin({resource:treeMutationResource(book),operation:tree==null?'tree.recovery-delete':'tree.recovery-write'});
    if(tree==null){
        deleteTreeDirect(book);
        await flushSettingsPersistence(`Tree "${book}" recovery`,{expected:[{path:['trees',String(book)],exists:false,value:null}]});
    }else{
        const written=setTreeDirect(book,clone(tree));
        await flushSettingsPersistence(`Tree "${book}" recovery`,{expected:[{path:['trees',String(book)],exists:true,value:written}]});
    }
}
async function persistTreeBundle(rows,onPhysicalPersistenceBegin=null,label='Tree import bundle recovery'){
    const input=(rows||[]).map(row=>({book:String(row.book),tree:clone(row.tree??null)}));
    if(typeof onPhysicalPersistenceBegin==='function')await onPhysicalPersistenceBegin({operation:'tree.import.bundle.recovery',resources:input.map(row=>treeMutationResource(row.book))});
    const written=setTreeBundleDirect(input,{mutationKind:'semantic'});
    await flushSettingsPersistence(label,{expected:written.map(row=>({path:['trees',row.book],exists:row.tree!=null,value:row.tree}))});
    return written;
}
function restoreAssignmentsInPlace(tree,rows=[]){
    if(!tree?.root)return tree;
    for(const row of rows)removeEntryEverywhere(tree.root,row.uid);
    for(const row of rows){
        if(!row.nodeId)continue;
        if(!findNode(tree.root,row.nodeId))throw new Error(`Recovery target Tree node ${row.nodeId} no longer exists.`);
        assignEntry(tree,row.uid,row.nodeId);
    }
    return tree;
}

function recoveryConflict(message, details={}){
    const error=new Error(message);
    error.name='TV2RecoveryConflict';
    Object.assign(error,details||{});
    return error;
}
function assertMetadataView(context,snapshot,target,label='Metadata recovery'){
    if(!context?.chatMetadata)throw new Error('No active chat metadata for recovery restore.');
    if(snapshot?.chatId!=null&&String(context.chatId??'')!==String(snapshot.chatId))throw recoveryConflict(`${label} refused because the active chat changed.`,{expectedChatId:snapshot.chatId,currentChatId:context.chatId??null});
    const exists=Object.prototype.hasOwnProperty.call(context.chatMetadata,snapshot.key);
    const current={exists,value:exists?clone(context.chatMetadata[snapshot.key]):null};
    if(!same(current,target))throw recoveryConflict(`${label} refused because the metadata value changed after recovery inspection.`,{key:snapshot.key,current});
    return current;
}
function assertEntryRowsView(data,snapshot,targetRows,label='Lore recovery'){
    const current=resourceView({data,uids:snapshot?.trackedUids||[]}).entries||[];
    if(!same(current,targetRows||[]))throw recoveryConflict(`${label} refused because a touched lore entry changed after recovery inspection.`,{book:snapshot?.book,current});
    return current;
}
function assertTreeView(snapshot,targetTree,label='Tree recovery'){
    const current=clone(getTree(snapshot.book));
    if(!same(current,targetTree??null))throw recoveryConflict(`${label} refused because the Tree changed after recovery inspection.`,{book:snapshot.book,current});
    return current;
}
function assertAssignmentView(snapshot,currentTree,targetRows,label='Tree assignment recovery'){
    if(snapshot.treeExistedPre===false&&!currentTree)throw recoveryConflict(`${label} refused because the mutation-created Tree is no longer present.`,{book:snapshot.book});
    const current=snapshotAssignments(currentTree,snapshot.trackedUids||[]);
    if(!same(current,targetRows||[]))throw recoveryConflict(`${label} refused because a tracked Tree assignment changed after recovery inspection.`,{book:snapshot.book,current});
    return currentTree;
}
function assertTreeBundleKnownNow(snapshot,label='Tree import bundle recovery'){
    const pre=new Map((snapshot.preView?.trees||[]).map(row=>[String(row.book),row]));
    const post=new Map((snapshot.postView?.trees||snapshot.expectedPostView?.trees||[]).map(row=>[String(row.book),row]));
    for(const book of snapshot.books||[]){
        const current=semanticSnapshot(getTree(book)),before=pre.get(String(book)),after=post.get(String(book));
        if(!before||!after||(!same(current,before.semantic)&&!same(current,after.semantic))){
            throw recoveryConflict(`${label} refused because a Tree changed after recovery inspection.`,{book:String(book)});
        }
    }
}

function rowsByUid(rows=[]){return new Map((rows||[]).map(row=>[Number(row?.uid),row]));}
function knownEitherRows(currentRows=[],preRows=[],postRows=[]){
    const current=rowsByUid(currentRows),pre=rowsByUid(preRows),post=rowsByUid(postRows),uids=new Set([...current.keys(),...pre.keys(),...post.keys()]);
    for(const uid of uids){const c=current.get(uid)||null,p=pre.get(uid)||null,q=post.get(uid)||null;if(!same(c,p)&&!same(c,q))return false;}
    return true;
}
function inversePartialStateIsKnown(source,current){
    const pre=source?.preView||{},post=source?.postView||{};
    if(source?.kind==='metadata-mutation')return same(current,pre)||same(current,post);
    if(source?.kind==='tree-import-bundle')return Array.isArray(current?.trees)&&current.trees.every(row=>['pre','post','neutral'].includes(String(row?.state||'')));
    if(source?.kind==='legacy-whole-book'){
        return (same(current?.book,pre?.book)||same(current?.book,post?.book))&&(same(current?.tree,pre?.tree)||same(current?.tree,post?.tree));
    }
    if(!knownEitherRows(current?.entries||[],pre?.entries||[],post?.entries||[]))return false;
    if(source?.structuralTree&&!(same(current?.tree,pre?.tree)||same(current?.tree,post?.tree)))return false;
    if(source?.tracksAssignments&&!source?.structuralTree&&!(knownEitherRows(current?.assignments||[],pre?.assignments||[],post?.assignments||[])))return false;
    if(Object.prototype.hasOwnProperty.call(pre,'treePresent')||Object.prototype.hasOwnProperty.call(post,'treePresent')){
        if(current?.treePresent!==pre?.treePresent&&current?.treePresent!==post?.treePresent)return false;
    }
    return true;
}
async function restoreKnownPostState(source,{context=null,onPhysicalPersistenceBegin=null}={}){
    const sourceInspection=await inspectMutationRecoveryState(source,{context});
    if(sourceInspection.compatible&&sourceInspection.state==='post')return {ok:true,restored:false,alreadyPost:true};
    if(!inversePartialStateIsKnown(source,sourceInspection.current)){
        const error=new Error('Recovery-of-recovery refused because canonical state contains changes outside the source mutation known pre/post states.');error.name='TV2RecoveryConflict';throw error;
    }
    if(source.kind==='tree-import-bundle'){
        const targets=source.postView?.trees||source.expectedPostView?.trees||[];
        if(!targets.length)throw new Error('Recovery-of-recovery is missing Tree import bundle post-state.');
        await persistTreeBundle(targets,onPhysicalPersistenceBegin,'Nexus Tree import bundle recovery-of-recovery');
        return {ok:true,restored:true,books:targets.map(row=>String(row.book))};
    }
    if(source.kind==='metadata-mutation'){
        if(!context?.chatMetadata)throw new Error('No active chat metadata for recovery-of-recovery restore.');
        const target=source.postView||source.expectedPostView;
        if(!target)throw new Error('Recovery-of-recovery is missing the source mutation post-state.');
        if(typeof onPhysicalPersistenceBegin==='function')await onPhysicalPersistenceBegin({resource:metadataMutationResource(source.chatId),operation:'metadata.recovery-forward'});
        if(target.exists)context.chatMetadata[source.key]=clone(target.value);else delete context.chatMetadata[source.key];
        await flushChatMetadataPersistence(context,`Nexus recovery-of-recovery ${source.key}`,{expected:{[source.key]:{exists:target.exists===true,value:target.value}}});
        return {ok:true,restored:true,chatId:source.chatId,key:source.key};
    }
    if(source.kind==='legacy-whole-book'){
        if(typeof onPhysicalPersistenceBegin==='function')await onPhysicalPersistenceBegin({resource:loreMutationResource(source.book),operation:'lore.recovery-forward'});
        await saveBook(source.book,clone(source.postView?.book));
        await persistTree(source.book,source.postView?.tree??null,onPhysicalPersistenceBegin);
        return {ok:true,restored:true,book:source.book};
    }
    if(ENTRY_MUTATIONS.has(source.opType)){
        const data=await loadBook(source.book);restoreEntryRows(data,source.postView?.entries||[]);
        if(typeof onPhysicalPersistenceBegin==='function')await onPhysicalPersistenceBegin({resource:loreMutationResource(source.book),operation:'lore.recovery-forward'});
        await saveBook(source.book,data);
    }
    if(source.structuralTree)await persistTree(source.book,source.postView?.tree??null,onPhysicalPersistenceBegin);
    else if(source.tracksAssignments){
        if(source.treeExistedPre===false&&(source.createdTreePost||source.checkpointCreatedTree))await persistTree(source.book,source.createdTreePost||source.checkpointCreatedTree,onPhysicalPersistenceBegin);
        else{
            const currentTree=getTree(source.book);
            if(currentTree){const next=clone(currentTree);restoreAssignmentsInPlace(next,source.postView?.assignments||[]);await persistTree(source.book,next,onPhysicalPersistenceBegin);}
        }
    }
    return {ok:true,restored:true,book:source.book};
}

/**
 * Conflict-safe inverse. It only writes when current canonical state is the
 * known post-state. If current state has diverged, automatic restore refuses.
 */
export async function applyMutationRecoveryPreStateUnsafe(snapshot, { context = null, authority = null, onPhysicalPersistenceBegin = null } = {}){
    assertNexusMutationAuthority(authority,recoveryAuthorityResources(snapshot));
    if(snapshot?.kind==='recovery-inverse')return restoreKnownPostState(snapshot.sourceRecovery,{context,onPhysicalPersistenceBegin});
    const inspection=await inspectMutationRecoveryState(snapshot,{context});
    if(inspection.state==='pre')return {ok:true,restored:false,alreadyPre:true,book:snapshot.book,books:snapshot.books||null};
    if(snapshot?.kind==='tree-import-bundle'){
        if(!inspection.compatible||!['post','partial'].includes(String(inspection.state||''))){
            const error=new Error('Tree import bundle recovery refused because canonical Trees diverged from the known pre/post bundle states.');
            error.name='TV2RecoveryConflict';error.recoveryState=inspection.state;throw error;
        }
        const preRows=snapshot.preView?.trees||[];
        // Re-check synchronously at the write boundary. This narrows the check-to-write
        // window; a truly atomic guarantee still requires host conditional persistence.
        assertTreeBundleKnownNow(snapshot,'Tree import bundle rollback recovery');
        await persistTreeBundle(preRows,onPhysicalPersistenceBegin,'Nexus Tree import bundle rollback recovery');
        const verified=await inspectMutationRecoveryState(snapshot,{context});
        if(!verified.compatible||verified.state!=='pre')throw Object.assign(new Error('Tree import bundle recovery could not prove the complete PRE state after rollback.'),{name:'TV2RollbackIndeterminate',recoveryState:verified.state});
        return {ok:true,restored:true,books:preRows.map(row=>String(row.book))};
    }
    const checkpointedPartial=inspection.compatible&&inspection.state==='partial'&&snapshot?.kind==='mutation-delta'&&Array.isArray(snapshot?.subwriteCheckpoints);
    if(!inspection.compatible||(inspection.state!=='post'&&!checkpointedPartial)){
        const error=new Error('Recovery restore refused: current lore/Tree state diverged from the mutation\'s known pre/post/checkpointed states.');
        error.name='TV2RecoveryConflict';error.recoveryState=inspection.state;throw error;
    }
    if(snapshot?.kind==='legacy-whole-book'){
        // Repeat the full resource comparison at the physical write boundary.
        const currentBook=clone(await loadBook(snapshot.book)),currentTree=clone(getTree(snapshot.book));
        if(!same({book:currentBook,tree:currentTree},snapshot.postView))throw recoveryConflict('Legacy recovery restore refused because lore/Tree changed after recovery inspection.',{book:snapshot.book});
        if(typeof onPhysicalPersistenceBegin==='function')await onPhysicalPersistenceBegin({resource:loreMutationResource(snapshot.book),operation:'lore.recovery-write'});
        await saveBook(snapshot.book,clone(snapshot.preView?.book));
        // Do not reuse the earlier Tree check after an await. Re-check the Tree immediately
        // before the Tree inverse and refuse if an independent writer changed it.
        assertTreeView(snapshot,snapshot.postView?.tree,'Legacy Tree recovery');
        await persistTree(snapshot.book,snapshot.preView?.tree??null,onPhysicalPersistenceBegin);
        const verified=await inspectMutationRecoveryState(snapshot,{context});
        if(!verified.compatible||verified.state!=='pre')throw Object.assign(new Error('Legacy lore/Tree recovery could not prove the complete PRE state after rollback.'),{name:'TV2RollbackIndeterminate',recoveryState:verified.state});
        return {ok:true,restored:true,book:snapshot.book,legacyConverted:true};
    }
    if(snapshot?.kind==='metadata-mutation'){
        assertMetadataView(context,snapshot,snapshot.postView||snapshot.expectedPostView||snapshot.checkpointPostView,'Metadata recovery');
        if(typeof onPhysicalPersistenceBegin==='function')await onPhysicalPersistenceBegin({resource:metadataMutationResource(snapshot.chatId),operation:'metadata.recovery-write'});
        if(snapshot.preView?.exists===true)context.chatMetadata[snapshot.key]=clone(snapshot.preView.value);else delete context.chatMetadata[snapshot.key];
        await flushChatMetadataPersistence(context,`Nexus metadata recovery ${snapshot.key}`,{expected:{[snapshot.key]:{exists:snapshot.preView?.exists===true,value:snapshot.preView?.value}}});
        const verified=await inspectMutationRecoveryState(snapshot,{context});
        if(!verified.compatible||verified.state!=='pre')throw Object.assign(new Error('Metadata recovery could not prove PRE after persistence.'),{name:'TV2RollbackIndeterminate',recoveryState:verified.state});
        return {ok:true,restored:true,chatId:snapshot.chatId,key:snapshot.key};
    }
    const checkpointDomains=new Set((snapshot.subwriteCheckpoints||[]).map(row=>String(row?.domain||'')));
    const knownPost=snapshot.postView||snapshot.checkpointPostView||{};
    const shouldRestoreLore=ENTRY_MUTATIONS.has(snapshot.opType)&&(snapshot.postView||checkpointDomains.has('lore'));
    if(shouldRestoreLore){
        const data=await loadBook(snapshot.book);
        // Use this same freshly loaded image for both the second known-post check and
        // the inverse edit so unrelated lore is preserved and stale touched rows fail closed.
        assertEntryRowsView(data,snapshot,knownPost?.entries,'Lore recovery');
        restoreEntryRows(data,snapshot.preView?.entries||[]);
        if(typeof onPhysicalPersistenceBegin==='function')await onPhysicalPersistenceBegin({resource:loreMutationResource(snapshot.book),operation:'lore.recovery-write'});
        await saveBook(snapshot.book,data);
    }
    if(snapshot.structuralTree&&(snapshot.postView||checkpointDomains.has('tree'))){
        assertTreeView(snapshot,knownPost?.tree,'Structural Tree recovery');
        await persistTree(snapshot.book,snapshot.preView?.tree??null,onPhysicalPersistenceBegin);
    }else if(snapshot.tracksAssignments&&(snapshot.postView||checkpointDomains.has('tree'))){
        const currentTree=getTree(snapshot.book);
        assertAssignmentView({...snapshot,postView:knownPost},currentTree,knownPost?.assignments||[],'Tree assignment recovery');
        if(snapshot.treeExistedPre===false){
            const ownedTree=snapshot.createdTreePost||snapshot.checkpointCreatedTree||null;
            if(ownedTree&&same(currentTree,ownedTree))await persistTree(snapshot.book,null,onPhysicalPersistenceBegin);
            else if(currentTree)throw Object.assign(new Error('Recovery restore refused: the mutation-created Tree contains later changes outside this rollback footprint.'),{name:'TV2RecoveryConflict'});
        }else if(currentTree){
            const next=clone(currentTree);
            restoreAssignmentsInPlace(next,snapshot.preView?.assignments||[]);
            await persistTree(snapshot.book,next,onPhysicalPersistenceBegin);
        }
    }
    const verified=await inspectMutationRecoveryState(snapshot,{context});
    if(!verified.compatible||verified.state!=='pre')throw Object.assign(new Error('Lore/Tree recovery could not prove the complete PRE projection after persistence.'),{name:'TV2RollbackIndeterminate',recoveryState:verified.state});
    return {ok:true,restored:true,book:snapshot.book,verifiedState:'pre'};
}


export function buildRecoveryInverseOperation(snapshot){
    if(!snapshot||snapshot.version!==2)throw new Error('Recovery inverse requires a version-2 Nexus recovery descriptor.');
    return {type:'nexus.recovery.restore',recovery:clone(snapshot),book:snapshot.book||null,chatId:snapshot.chatId??null};
}
