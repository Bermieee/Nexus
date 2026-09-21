import { clone, createTree, findNode, findParent, findNodeContainingUid, semanticSnapshot, validateCanonicalTreeIdentity } from '../tree/model.js';
import { createTreeDelta } from '../builder/contracts.js';
import { builder2Fingerprint } from './contracts.js';

function clean(v){return String(v??'').trim();}
function uniqNums(v=[]){return [...new Set((v||[]).map(Number).filter(Number.isFinite))];}
function allNodes(root,parentId=null,out=new Map()){
    if(!root)return out;
    out.set(String(root.id),{node:root,parentId});
    for(const child of root.children||[])allNodes(child,String(root.id),out);
    return out;
}
function removeUidEverywhere(node,uid){
    if(!node)return;
    node.entryUids=(node.entryUids||[]).filter(x=>Number(x)!==Number(uid));
    for(const child of node.children||[])removeUidEverywhere(child,uid);
}
function detachNode(root,nodeId){
    const parent=findParent(root,nodeId);
    if(!parent)return null;
    const index=(parent.children||[]).findIndex(n=>String(n.id)===String(nodeId));
    if(index<0)return null;
    return parent.children.splice(index,1)[0]||null;
}
function ensureChild(parent,spec){
    parent.children=Array.isArray(parent.children)?parent.children:[];
    if(parent.children.some(n=>String(n.id)===String(spec.nodeId)))throw new Error(`Builder 2 materializer duplicate node ID ${spec.nodeId}.`);
    const node={id:String(spec.nodeId),label:clean(spec.label)||'Unnamed',summary:'',keywords:[],entryUids:[],children:[],collapsed:false};
    parent.children.push(node);
    return node;
}
function titleFor(source){return clean(source?.title)||`UID ${Number(source?.uid)}`;}

/**
 * Apply a reviewed Builder 2 structural handoff to an in-memory canonical Nexus
 * Tree.  This is deterministic local work only: it performs no model/network
 * calls and never persists the Tree itself.
 */
export function materializeBuilder2NexusTree({
    book,
    baselineTree=null,
    corpusSources=[],
    handoff,
    quality=null,
    now=Date.now(),
}={}){
    const name=clean(book||handoff?.book);
    if(!name)throw new Error('Builder 2 Nexus materializer requires book.');
    if(!handoff||handoff.contract!=='nexus-lorebook-builder/v2-structural-handoff')throw new Error('Builder 2 Nexus materializer requires a structural handoff.');
    if(clean(handoff.book)!==name)throw new Error(`Builder 2 handoff book mismatch: ${handoff.book} vs ${name}.`);

    const tree=baselineTree?.root?clone(baselineTree):createTree(name);
    tree.lorebookName=name;tree.version=2;
    validateCanonicalTreeIdentity(tree,{label:'Builder 2 baseline Tree'});

    // Structural operations are already parent-first, but re-index after each
    // structural mutation so moves/creates never rely on stale label routing.
    for(const op of handoff.structuralOperations||[]){
        const nodeId=clean(op.nodeId);if(!nodeId)throw new Error(`Builder 2 structural op ${op.op} is missing nodeId.`);
        if(op.op==='create-node'){
            if(findNode(tree.root,nodeId))throw new Error(`Builder 2 create-node collides with existing ID ${nodeId}.`);
            const parentId=clean(op.parentNodeId)||String(tree.root.id);
            const parent=findNode(tree.root,parentId);if(!parent)throw new Error(`Builder 2 create-node ${nodeId} has missing parent ${parentId}.`);
            ensureChild(parent,op);
        }else if(op.op==='rename-node'){
            const node=findNode(tree.root,nodeId);if(!node)throw new Error(`Builder 2 rename-node target ${nodeId} does not exist.`);
            if(clean(op.expectedLabel)&&clean(node.label)!==clean(op.expectedLabel))throw new Error(`Builder 2 rename-node ${nodeId} expected label ${op.expectedLabel} but found ${node.label}.`);
            node.label=clean(op.label)||node.label;
        }else if(op.op==='move-node'){
            if(String(tree.root.id)===nodeId)throw new Error('Builder 2 may not move the canonical Tree root.');
            const node=findNode(tree.root,nodeId);if(!node)throw new Error(`Builder 2 move-node target ${nodeId} does not exist.`);
            const currentParent=findParent(tree.root,nodeId);
            const expected=clean(op.expectedParentNodeId)||null;
            if(expected&&(String(currentParent?.id||'')!==expected))throw new Error(`Builder 2 move-node ${nodeId} expected parent ${expected} but found ${currentParent?.id||'none'}.`);
            const targetId=clean(op.parentNodeId)||String(tree.root.id);
            const target=findNode(tree.root,targetId);if(!target)throw new Error(`Builder 2 move-node ${nodeId} has missing parent ${targetId}.`);
            // Reject moving beneath itself/descendant.
            if(findNode(node,targetId))throw new Error(`Builder 2 move-node ${nodeId} would create a structural cycle.`);
            const moved=detachNode(tree.root,nodeId);if(!moved)throw new Error(`Builder 2 move-node ${nodeId} could not detach from current parent.`);
            target.children=Array.isArray(target.children)?target.children:[];target.children.push(moved);
        }else{
            throw new Error(`Unknown Builder 2 structural operation ${String(op.op)}.`);
        }
    }

    const sourceByKey=new Map(corpusSources.map(s=>[String(s.sourceKey),s]));
    const corpusUids=new Set(corpusSources.filter(s=>!s.removed).map(s=>Number(s.uid)).filter(Number.isFinite));
    const removedUids=new Set((handoff.sourceRemovals||[]).map(r=>Number(r.uid)).filter(Number.isFinite));
    const excludedUids=new Set((handoff.sourceExclusions||[]).map(r=>Number(r.uid)).filter(Number.isFinite));
    const deferredUids=new Set((handoff.sourceDeferrals||[]).map(r=>Number(r.uid)).filter(Number.isFinite));

    // Explicit negative authority removes stale/orphaned UID homes.
    for(const r of handoff.sourceRemovals||[]){
        const uid=Number(r.uid);if(!Number.isFinite(uid))throw new Error('Builder 2 source removal has non-numeric UID.');
        if(corpusUids.has(uid))throw new Error(`Builder 2 refuses removal of UID ${uid}; it exists in the authoritative corpus.`);
        removeUidEverywhere(tree.root,uid);
    }

    // Deferral is explicit no-op authority for this materialization. Validate
    // the source identity, but never move or detach it. Existing Tree homes are
    // preserved by the prospective population; new deferred lore stays unplaced.
    for(const r of handoff.sourceDeferrals||[]){
        const uid=Number(r.uid);if(!Number.isFinite(uid))throw new Error('Builder 2 source deferral has non-numeric UID.');
        const source=sourceByKey.get(String(r.sourceKey));if(!source||source.removed)throw new Error(`Builder 2 source deferral ${r.sourceKey} is not present in the authoritative corpus.`);
        if(clean(source.fingerprint)!==clean(r.sourceFingerprint))throw new Error(`Builder 2 source deferral fingerprint changed for ${r.sourceKey}.`);
    }

    // Explicit non-semantic authority detaches an existing Tree home without
    // deleting or disabling the authoritative lore source.
    for(const r of handoff.sourceExclusions||[]){
        const uid=Number(r.uid);if(!Number.isFinite(uid))throw new Error('Builder 2 source exclusion has non-numeric UID.');
        const source=sourceByKey.get(String(r.sourceKey));if(!source||source.removed)throw new Error(`Builder 2 source exclusion ${r.sourceKey} is not present in the authoritative corpus.`);
        if(clean(source.fingerprint)!==clean(r.sourceFingerprint))throw new Error(`Builder 2 source exclusion fingerprint changed for ${r.sourceKey}.`);
        removeUidEverywhere(tree.root,uid);
    }

    const added=[];
    for(const placement of handoff.uidPlacements||[]){
        const uid=Number(placement.uid);if(!Number.isFinite(uid))throw new Error('Builder 2 UID placement has non-numeric UID.');
        const source=sourceByKey.get(String(placement.sourceKey));
        if(!source||source.removed)throw new Error(`Builder 2 placement ${placement.sourceKey} is not present in the authoritative corpus.`);
        if(source.disabled)continue; // existing disabled placement is preserved by prospective population; never newly attach disabled lore.
        if(clean(source.fingerprint)!==clean(placement.sourceFingerprint))throw new Error(`Builder 2 placement source fingerprint changed for ${placement.sourceKey}.`);
        const target=findNode(tree.root,clean(placement.nodeId));if(!target)throw new Error(`Builder 2 placement target ${placement.nodeId} does not exist.`);
        const prior=findNodeContainingUid(tree.root,uid);
        const priorNodeId=prior?.id||null;
        removeUidEverywhere(tree.root,uid);
        target.entryUids=uniqNums([...(target.entryUids||[]),uid]);
        added.push({uid,title:titleFor(source),nodeId:target.id,nodeLabel:target.label,priorNodeId});
    }

    // If Builder 2 had a complete membership inventory, reconcile the exact
    // prospective population.  This is the protection that retains unchanged
    // and disabled-but-existing homes while repairing duplicate/changed UIDs.
    if(handoff.prospectivePopulation?.complete===true){
        const expected=new Map((handoff.prospectivePopulation.uidHomes||[]).map(r=>[Number(r.uid),(r.nodeIds||[]).map(String)]));
        for(const [uid,nodeIds] of expected){
            if(removedUids.has(uid)||excludedUids.has(uid))continue;
            if(nodeIds.length!==1)throw new Error(`Builder 2 prospective population for UID ${uid} is not single-home.`);
            const target=findNode(tree.root,nodeIds[0]);if(!target)throw new Error(`Builder 2 prospective population target ${nodeIds[0]} for UID ${uid} does not exist.`);
            removeUidEverywhere(tree.root,uid);target.entryUids=uniqNums([...(target.entryUids||[]),uid]);
        }
    }

    validateCanonicalTreeIdentity(tree,{label:'Builder 2 materialized Tree'});
    const nodeMap=allNodes(tree.root);
    const manifestEntries={};
    for(const source of corpusSources){
        if(source.removed)continue;
        const node=findNodeContainingUid(tree.root,Number(source.uid));
        if(!node)continue;
        manifestEntries[String(source.uid)]={uid:Number(source.uid),title:titleFor(source),fingerprint:source.fingerprint,nodeId:node.id,nodeLabel:node.label,disabled:source.disabled===true,deferred:deferredUids.has(Number(source.uid))};
    }
    tree.builderManifest={
        schema:'nexus-lorebook-builder-manifest/v2',engine:'builder2',book:name,
        corpusRevision:handoff.corpusRevision||null,sourceRevision:handoff.sourceRevision||null,treeRevision:handoff.treeRevision||null,
        taxonomyRevision:handoff.taxonomyRevision||null,handoffFingerprint:handoff.handoffFingerprint,
        reconciledAt:Number(now)||Date.now(),entries:manifestEntries,deferredSources:(handoff.sourceDeferrals||[]).map(row=>({sourceKey:row.sourceKey,uid:Number(row.uid),fingerprint:row.sourceFingerprint,reason:row.reason||'operator-deferred'})),
    };
    tree.lastBuilt=Number(now)||Date.now();

    // Every attached UID must still exist in authoritative lore; disabled lore
    // may remain attached, but removed/orphaned UIDs may not.
    const attached=[];for(const {node} of nodeMap.values())attached.push(...(node.entryUids||[]));
    for(const uid of attached)if(!corpusUids.has(Number(uid)))throw new Error(`Builder 2 materialized Tree contains dangling UID ${uid}.`);

    const newNodes=(handoff.structuralOperations||[]).filter(o=>o.op==='create-node').map(o=>({
        nodeId:o.nodeId,label:o.label,parentNodeId:o.parentNodeId||tree.root.id,parentLabel:findNode(tree.root,o.parentNodeId||tree.root.id)?.label||'Root',
    }));
    const unchangedCount=Math.max(0,Object.keys(manifestEntries).length-added.length);
    const qualityView=quality?{passed:quality.passed!==false,blockers:clone(quality.blockers||[]),signals:clone(quality.signals||[]),reportFingerprint:quality.reportFingerprint||null}:null;
    const delta=createTreeDelta({book:name,mode:handoff.mode,unchangedCount,added,newNodes,updatedSummaries:[],conflicts:clone(quality?.blockers||[]),quality:qualityView,nextTree:tree});
    delta.builder2={
        runId:handoff.runId,planRevision:handoff.planRevision,handoffFingerprint:handoff.handoffFingerprint,
        sourceRevision:handoff.sourceRevision,corpusRevision:handoff.corpusRevision,treeRevision:handoff.treeRevision,
        taxonomyRevision:handoff.taxonomyRevision,materializedFingerprint:`nexus-tree:${builder2Fingerprint(semanticSnapshot(tree))}`,
        deferredCount:(handoff.sourceDeferrals||[]).length,
        deferredSources:(handoff.sourceDeferrals||[]).map(row=>({sourceKey:row.sourceKey,uid:row.uid,reason:row.reason||'operator-deferred'})),
    };
    return {tree,delta};
}

export function validateBuilder2NexusMaterialization({tree,corpusSources=[]}={}){
    const errors=[];
    try{validateCanonicalTreeIdentity(tree,{label:'Builder 2 Nexus Tree'});}catch(e){errors.push(e.message);}
    const known=new Set(corpusSources.filter(s=>!s.removed).map(s=>Number(s.uid)));
    const homes=new Map();
    const walk=node=>{for(const uid of node?.entryUids||[]){const n=Number(uid);if(!known.has(n))errors.push(`Dangling UID ${n}.`);if(homes.has(n))errors.push(`Duplicate UID home ${n}.`);homes.set(n,node.id);}for(const c of node?.children||[])walk(c);};
    if(tree?.root)walk(tree.root);
    return {passed:errors.length===0,errors:[...new Set(errors)],uidCount:homes.size};
}
