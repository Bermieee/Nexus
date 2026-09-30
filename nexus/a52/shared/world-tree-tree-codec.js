import { normalizeWorldTreeDocument, normalizeWorldTreeNode } from './world-tree-document.js';

const clone=value=>value==null?value:structuredClone(value);
const clean=value=>String(value??'').trim();
const STRUCTURE_KINDS=new Set(['tree-root','tree-topic']);
const STRUCTURE_EDGE_MEANINGS=new Set(['CONTAINS_TOPIC','CONTAINS_LORE']);

function bookKey(book){return encodeURIComponent(String(book??''));}
function topicNodeId(book,uiNodeId,root=false){return `${root?'tree-root':'tree-topic'}:${bookKey(book)}:${String(uiNodeId)}`;}
function loreNodeId(book,uid){return `lore:${String(book)}:${Number(uid)}`;}
function uniq(values=[]){return [...new Set((values??[]).filter(v=>v!=null&&String(v).trim()).map(v=>String(v).trim()))];}

function structuralNodeFromLegacy(book,node,{root=false,parentId=null,order=0,lastBuilt=0}={}){
  const id=topicNodeId(book,node.id,root);
  const edges=[];
  for(const [index,child] of (node.children??[]).entries()){
    edges.push({to:topicNodeId(book,child.id,false),meaning:'CONTAINS_TOPIC',sourceRefs:[],order:index,metadata:{}});
  }
  for(const [index,uid] of (node.entryUids??[]).entries()){
    if(!Number.isFinite(Number(uid)))continue;
    edges.push({to:loreNodeId(book,uid),meaning:'CONTAINS_LORE',sourceRefs:[`lore:${book}:${Number(uid)}`],order:index,metadata:{}});
  }
  return normalizeWorldTreeNode({
    id,
    kind:root?'tree-root':'tree-topic',
    scope:'global',
    revision:1,
    sourceRefs:[],
    temporalStatus:'CURRENT',
    aliases:uniq([node.label,...(node.keywords??[])]),
    edges,
    authorityClass:'DERIVED',
    metadata:{owner:'NEXUS_WORLD_TREE',structural:true},
    payload:{
      book:String(book),
      uiNodeId:String(node.id),
      parentId,
      label:String(node.label??'Unnamed'),
      summary:String(node.summary??''),
      keywords:uniq(node.keywords??[]),
      collapsed:node.collapsed===true,
      lastBuilt:root?Number(lastBuilt)||0:null,
    },
  });
}

export function replaceLoreTreeInWorldTreeDocument(document,book,tree){
  const name=clean(book);
  if(!name)throw new TypeError('World Tree lore projection requires a lorebook name');
  if(!tree?.root)throw new TypeError('World Tree lore projection requires a tree root');
  const doc=normalizeWorldTreeDocument(document);

  for(const [id,node] of Object.entries(doc.nodes)){
    if(STRUCTURE_KINDS.has(node.kind)&&String(node?.payload?.book??'')===name)delete doc.nodes[id];
  }

  const walk=(node,{root=false,parentId=null,order=0}={})=>{
    const structural=structuralNodeFromLegacy(name,node,{root,parentId,order,lastBuilt:tree.lastBuilt});
    doc.nodes[structural.id]=clone(structural);
    for(const [index,uidRaw] of (node.entryUids??[]).entries()){
      const uid=Number(uidRaw);if(!Number.isFinite(uid))continue;
      const id=loreNodeId(name,uid);
      const prior=doc.nodes[id];
      if(prior){
        doc.nodes[id]=clone(normalizeWorldTreeNode({
          ...prior,
          id,
          kind:'lore',
          scope:'global',
          sourceRefs:uniq([...(prior.sourceRefs??[]),`lore:${name}:${uid}`]),
          payload:{...(prior.payload??{}),book:name,uid},
        }));
      }else{
        doc.nodes[id]=clone(normalizeWorldTreeNode({
          id,kind:'lore',scope:'global',revision:1,
          sourceRefs:[`lore:${name}:${uid}`],
          temporalStatus:'UNRESOLVED',aliases:[],edges:[],
          authorityClass:'SOURCE_CANON',
          metadata:{owner:'NEXUS_WORLD_TREE'},
          payload:{book:name,uid},
        }));
      }
    }
    for(const [index,child] of (node.children??[]).entries())walk(child,{root:false,parentId:structural.id,order:index});
    return structural.id;
  };
  const rootId=walk(tree.root,{root:true,parentId:null,order:0});
  doc.roots.lore[name]=rootId;
  return doc;
}

export function deleteLoreTreeFromWorldTreeDocument(document,book){
  const name=clean(book),doc=normalizeWorldTreeDocument(document);
  for(const [id,node] of Object.entries(doc.nodes)){
    if(STRUCTURE_KINDS.has(node.kind)&&String(node?.payload?.book??'')===name)delete doc.nodes[id];
  }
  delete doc.roots.lore[name];
  return doc;
}

function sortedEdges(node,meaning){
  return (node?.edges??[])
    .filter(edge=>edge.meaning===meaning)
    .slice()
    .sort((a,b)=>(Number(a.order??Number.MAX_SAFE_INTEGER)-Number(b.order??Number.MAX_SAFE_INTEGER))||String(a.to).localeCompare(String(b.to)));
}

export function worldTreeDocumentToLegacyTree(document,book){
  const name=clean(book),doc=normalizeWorldTreeDocument(document);
  const rootId=doc.roots?.lore?.[name];
  if(!rootId)return null;
  const seen=new Set();
  const build=id=>{
    if(seen.has(id))throw new Error('World Tree structural cycle detected at '+id);
    seen.add(id);
    const node=doc.nodes[id];
    if(!node||!STRUCTURE_KINDS.has(node.kind))throw new Error('World Tree structural node missing: '+id);
    const payload=node.payload??{};
    const entryUids=sortedEdges(node,'CONTAINS_LORE')
      .map(edge=>doc.nodes[edge.to]?.payload?.uid??Number(String(edge.to).split(':').at(-1)))
      .map(Number).filter(Number.isFinite);
    const children=sortedEdges(node,'CONTAINS_TOPIC').map(edge=>build(edge.to));
    seen.delete(id);
    return{
      id:String(payload.uiNodeId??id),
      label:String(payload.label??'Unnamed'),
      summary:String(payload.summary??''),
      keywords:uniq(payload.keywords??[]),
      entryUids:[...new Set(entryUids)],
      children,
      collapsed:payload.collapsed===true,
    };
  };
  const root=build(rootId);
  const rootNode=doc.nodes[rootId];
  return{
    lorebookName:name,
    version:2,
    lastBuilt:Number(rootNode?.payload?.lastBuilt??doc.updatedAt??0)||0,
    root,
  };
}

export function loreTreeWorldNodeIds(document,book){
  const name=clean(book),doc=normalizeWorldTreeDocument(document);
  return Object.values(doc.nodes)
    .filter(node=>STRUCTURE_KINDS.has(node.kind)&&String(node?.payload?.book??'')===name)
    .map(node=>node.id)
    .sort();
}

export function loreTreeStructuralEdgeCount(document,book){
  const ids=new Set(loreTreeWorldNodeIds(document,book)),doc=normalizeWorldTreeDocument(document);
  let count=0;
  for(const id of ids)count+=(doc.nodes[id]?.edges??[]).filter(edge=>STRUCTURE_EDGE_MEANINGS.has(edge.meaning)).length;
  return count;
}
