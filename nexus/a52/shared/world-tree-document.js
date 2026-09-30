const clone=value=>value==null?value:structuredClone(value);
const uniq=(values=[])=>[...new Set((values??[]).filter(v=>v!=null&&String(v).trim()).map(v=>String(v).trim()))];
const STATUS=new Set(['CURRENT','HISTORICAL','SUPERSEDED','CONTRADICTED','UNCERTAIN','UNRESOLVED']);

export const NEXUS_WORLD_TREE_DOCUMENT_VERSION=1;

export function normalizeWorldTreeEdge(raw={}){
  const to=String(raw?.to??'').trim();
  if(!to)throw new TypeError('World Tree edge requires a target node id');
  return Object.freeze({
    to,
    meaning:String(raw?.meaning??'RELATED_TO').trim()||'RELATED_TO',
    sourceRefs:Object.freeze(uniq(raw?.sourceRefs??[])),
    order:Number.isFinite(Number(raw?.order))?Number(raw.order):null,
    metadata:Object.freeze(clone(raw?.metadata??{})),
  });
}

export function normalizeWorldTreeNode(raw={}){
  const id=String(raw?.id??'').trim();
  const kind=String(raw?.kind??'').trim();
  if(!id)throw new TypeError('World Tree node id is required');
  if(!kind)throw new TypeError('World Tree node kind is required');
  const temporal=String(raw?.temporalStatus??'UNRESOLVED').trim().toUpperCase().replaceAll('-','_');
  return Object.freeze({
    id,
    kind,
    scope:String(raw?.scope??'global').trim()||'global',
    revision:Math.max(1,Math.floor(Number(raw?.revision)||1)),
    sourceRefs:Object.freeze(uniq(raw?.sourceRefs??[])),
    temporalStatus:STATUS.has(temporal)?temporal:'UNRESOLVED',
    supersededBy:raw?.supersededBy==null?null:String(raw.supersededBy),
    aliases:Object.freeze(uniq(raw?.aliases??[])),
    edges:Object.freeze((raw?.edges??[]).map(normalizeWorldTreeEdge)),
    authorityClass:raw?.authorityClass==null?null:String(raw.authorityClass),
    metadata:Object.freeze(clone(raw?.metadata??{})),
    payload:Object.freeze(clone(raw?.payload??{})),
  });
}

export function createWorldTreeDocument(){
  return {
    kind:'NexusWorldTreeDocument',
    version:NEXUS_WORLD_TREE_DOCUMENT_VERSION,
    revision:0,
    nodes:{},
    roots:{lore:{}},
    updatedAt:0,
  };
}

export function normalizeWorldTreeDocument(raw=null){
  const source=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:createWorldTreeDocument();
  const nodes={};
  for(const [key,value] of Object.entries(source.nodes??{})){
    try{
      const node=normalizeWorldTreeNode({...value,id:value?.id??key});
      nodes[node.id]=clone(node);
    }catch{}
  }
  const loreRoots={};
  for(const [book,id] of Object.entries(source.roots?.lore??{})){
    const rootId=String(id??'').trim();
    if(rootId&&nodes[rootId])loreRoots[String(book)]=rootId;
  }
  return {
    kind:'NexusWorldTreeDocument',
    version:NEXUS_WORLD_TREE_DOCUMENT_VERSION,
    revision:Math.max(0,Math.floor(Number(source.revision)||0)),
    nodes,
    roots:{lore:loreRoots},
    updatedAt:Math.max(0,Number(source.updatedAt)||0),
  };
}

export function worldTreeDocumentNode(document,id){
  const doc=normalizeWorldTreeDocument(document);
  const node=doc.nodes[String(id)];
  return node?clone(node):null;
}

export function listWorldTreeDocumentNodes(document,{kind=null,scope=null,predicate=null}={}){
  const doc=normalizeWorldTreeDocument(document);
  return Object.values(doc.nodes)
    .filter(node=>kind==null||String(node.kind)===String(kind))
    .filter(node=>scope==null||String(node.scope)===String(scope))
    .filter(node=>typeof predicate!=='function'||predicate(node))
    .map(clone);
}

export function upsertWorldTreeDocumentNode(document,node){
  const doc=normalizeWorldTreeDocument(document);
  const normalized=normalizeWorldTreeNode(node);
  doc.nodes[normalized.id]=clone(normalized);
  return doc;
}

export function deleteWorldTreeDocumentNode(document,id,{pruneInbound=true}={}){
  const doc=normalizeWorldTreeDocument(document);
  const key=String(id);
  delete doc.nodes[key];
  if(pruneInbound){
    for(const node of Object.values(doc.nodes)){
      node.edges=(node.edges??[]).filter(edge=>String(edge.to)!==key);
    }
  }
  for(const roots of Object.values(doc.roots??{})){
    if(!roots||typeof roots!=='object')continue;
    for(const [name,rootId] of Object.entries(roots))if(String(rootId)===key)delete roots[name];
  }
  return doc;
}

export function worldTreeDocumentStats(document){
  const doc=normalizeWorldTreeDocument(document);
  const byKind={};
  const byScope={};
  let edgeCount=0;
  for(const node of Object.values(doc.nodes)){
    byKind[node.kind]=(byKind[node.kind]||0)+1;
    byScope[node.scope]=(byScope[node.scope]||0)+1;
    edgeCount+=(node.edges??[]).length;
  }
  return Object.freeze({
    revision:doc.revision,
    nodeCount:Object.keys(doc.nodes).length,
    edgeCount,
    byKind:Object.freeze(byKind),
    byScope:Object.freeze(byScope),
    loreRoots:Object.keys(doc.roots?.lore??{}).length,
    updatedAt:doc.updatedAt,
  });
}
