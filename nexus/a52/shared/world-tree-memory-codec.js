import { normalizeWorldTreeDocument, normalizeWorldTreeNode } from './world-tree-document.js';

const clone=value=>value==null?value:structuredClone(value);
const uniq=(values=[])=>[...new Set((values??[]).filter(v=>v!=null&&String(v).trim()).map(v=>String(v).trim()))];
const metaNodeId=chatId=>`memory-store-meta:${String(chatId)}`;
const memoryNodeId=id=>`memory:${String(id)}`;

function memoryEdges(record){
  const edges=[];
  for(const [index,id] of (record?.childIds??[]).entries())edges.push({
    to:memoryNodeId(id),meaning:'SUMMARIZES_MEMORY',sourceRefs:uniq(record?.sourceMessageIds??[]),order:index,metadata:{},
  });
  if(record?.promotedTo)edges.push({
    to:memoryNodeId(record.promotedTo),meaning:'PROMOTED_TO',sourceRefs:uniq(record?.sourceMessageIds??[]),order:null,metadata:{},
  });
  return edges;
}

function memoryNode(record,chatId){
  return normalizeWorldTreeNode({
    id:memoryNodeId(record.id),
    kind:'memory',
    scope:String(chatId),
    revision:Math.max(1,Number(record?.updatedAt??record?.createdAt??1)||1),
    sourceRefs:uniq(record?.sourceMessageIds??[]),
    temporalStatus:'HISTORICAL',
    supersededBy:null,
    aliases:uniq([...(record?.characters??[]),...(record?.locations??[]),...(record?.topics??[]),...(record?.threads??[])]),
    edges:memoryEdges(record),
    authorityClass:'OBSERVED',
    metadata:{owner:'NEXUS_WORLD_TREE',memoryLayer:Number(record?.layer??0)},
    payload:clone(record),
  });
}

function memoryMetaNode(store,chatId){
  const payload=clone(store??{});
  delete payload.records;
  return normalizeWorldTreeNode({
    id:metaNodeId(chatId),
    kind:'memory-store-meta',
    scope:String(chatId),
    revision:Math.max(1,Number(store?.evidenceRevision)||1),
    sourceRefs:[],
    temporalStatus:'CURRENT',
    aliases:[],
    edges:[],
    authorityClass:'DERIVED',
    metadata:{owner:'NEXUS_WORLD_TREE'},
    payload,
  });
}

export function replaceMemoryStoreInWorldTreeDocument(document,store,{chatId}={}){
  const scope=String(chatId??'').trim();
  if(!scope)throw new TypeError('Memory World Tree projection requires chatId');
  const doc=normalizeWorldTreeDocument(document);
  for(const [id,node] of Object.entries(doc.nodes)){
    if(String(node.scope)!==scope)continue;
    if(node.kind==='memory'||node.kind==='memory-store-meta')delete doc.nodes[id];
  }
  const meta=memoryMetaNode(store,scope);
  doc.nodes[meta.id]=clone(meta);
  for(const record of Object.values(store?.records??{})){
    if(!record?.id)continue;
    const node=memoryNode(record,scope);
    doc.nodes[node.id]=clone(node);
  }
  return doc;
}

export function worldTreeDocumentToMemoryStore(document,{chatId}={}){
  const scope=String(chatId??'').trim();
  if(!scope)return null;
  const doc=normalizeWorldTreeDocument(document);
  const meta=doc.nodes[metaNodeId(scope)];
  const rows=Object.values(doc.nodes).filter(node=>node.kind==='memory'&&String(node.scope)===scope);
  if(!meta&&!rows.length)return null;
  const store=clone(meta?.payload??{});
  store.records={};
  for(const node of rows){
    const record=clone(node.payload??{});
    const id=String(record.id??String(node.id).slice('memory:'.length));
    if(!id)continue;
    record.id=id;
    store.records[id]=record;
  }
  return store;
}

export function memoryWorldTreeNodeIds(document,{chatId}={}){
  const scope=String(chatId??'').trim();
  const doc=normalizeWorldTreeDocument(document);
  return Object.values(doc.nodes)
    .filter(node=>node.kind==='memory'&&String(node.scope)===scope)
    .map(node=>node.id)
    .sort();
}

export function memoryWorldTreeMetaNodeId(chatId){return metaNodeId(chatId);}
