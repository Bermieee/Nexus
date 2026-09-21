import { loreEntryId } from './lore-paging.js';

const UNRESOLVED=new Set(['pending','committing','recovery-required']);
function finiteUid(value){const n=Number(value);return Number.isFinite(n)?n:null;}
function findNode(root,id){
    if(!root)return null;
    if(String(root.id)===String(id))return root;
    for(const child of root.children||[]){const found=findNode(child,id);if(found)return found;}
    return null;
}
function collectNodeUids(node,out=new Set()){
    if(!node)return out;
    for(const uid of node.entryUids||[]){const n=finiteUid(uid);if(n!=null)out.add(n);}
    for(const child of node.children||[])collectNodeUids(child,out);
    return out;
}
function protectUid(out,book,value){const uid=finiteUid(value);if(uid!=null)out.add(loreEntryId(book,uid));}
function protectTreeNode(out,book,nodeId,getTree){
    const tree=getTree?.(book),node=findNode(tree?.root,nodeId);
    if(!node){out.add(String(book));return;}
    for(const uid of collectNodeUids(node))protectUid(out,book,uid);
}
function protectOperation(out,op,getTree){
    const book=String(op?.book||'').trim(),type=String(op?.type||'');
    if(!book)return;
    switch(type){
        case 'entry.update':case 'entry.delete':case 'entry.move':case 'entry.split':protectUid(out,book,op.uid);break;
        case 'entry.merge':protectUid(out,book,op.keepUid);protectUid(out,book,op.removeUid);break;
        case 'entry.create':if(op.uid!=null)protectUid(out,book,op.uid);break;
        case 'tree.entry.assign':case 'tree.entry.unassign':protectUid(out,book,op.uid);break;
        case 'tree.node.rename':case 'tree.node.move':case 'tree.node.delete':protectTreeNode(out,book,op.nodeId,getTree);break;
        case 'tree.node.create':break; // no existing lore entry is changed by an uncommitted empty category
        case 'tree.replace':case 'tree.delete':out.add(book);break;
        case 'metadata.set':case 'scene.archive':break;
        default:out.add(book);break; // unknown unresolved mutation stays conservative
    }
}

// Pending changes protect only the lore they can actually mutate whenever that
// scope is knowable. Full Tree replacement/deletion remains book-wide.
export function unresolvedLoreProposalProtections(proposals=[],getTree=()=>null){
    const out=new Set();
    for(const proposal of Array.isArray(proposals)?proposals:[]){
        if(!UNRESOLVED.has(String(proposal?.status||'')))continue;
        const ops=proposal?.ops||proposal?.operations||(proposal?.op?[proposal.op]:[]);
        if(Array.isArray(ops)&&ops.length){for(const op of ops)protectOperation(out,op,getTree);}
        else if(proposal?.book)out.add(String(proposal.book));
    }
    return out;
}
