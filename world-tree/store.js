import { NativeEntityIdentityRegistry } from './entity-identity-registry.js';
import { TemporalStateGraph } from './temporal-state-graph.js';

export const WorldTreeScopeType=Object.freeze({GLOBAL:'GLOBAL',CHAT:'CHAT'});
export const WorldTreeTemporalStatus=Object.freeze({
  CURRENT:'CURRENT',
  HISTORICAL:'HISTORICAL',
  SUPERSEDED:'SUPERSEDED',
  CONTRADICTED:'CONTRADICTED',
  UNCERTAIN:'UNCERTAIN',
  UNRESOLVED:'UNRESOLVED',
});
export const WorldTreeNodeKind=Object.freeze({
  WORLD:'WORLD',
  LORE_SOURCE:'LORE_SOURCE',
  LORE_GROUP:'LORE_GROUP',
  LORE_FACT:'LORE_FACT',
  CHARACTER:'CHARACTER',
  CHARACTER_STATE:'CHARACTER_STATE',
  MEMORY:'MEMORY',
  EVENT:'EVENT',
  CLAIM:'CLAIM',
  ENTITY:'ENTITY',
  LOCATION:'LOCATION',
  ITEM:'ITEM',
  RELATIONSHIP:'RELATIONSHIP',
  SCENE:'SCENE',
  SUMMARY:'SUMMARY',
  REFLECTION:'REFLECTION',
});
export const WorldTreeOverlayKind=Object.freeze({
  HOT_COGNITION:'HOT_COGNITION',
  GREEN_ROOM:'GREEN_ROOM',
  SPECULATIVE:'SPECULATIVE',
  RUNTIME:'RUNTIME',
});

const SCOPE_TYPES=new Set(Object.values(WorldTreeScopeType));
const TEMPORAL_STATUSES=new Set(Object.values(WorldTreeTemporalStatus));
const NODE_KINDS=new Set(Object.values(WorldTreeNodeKind));
const OVERLAY_KINDS=new Set(Object.values(WorldTreeOverlayKind));
const clone=value=>value==null?value:structuredClone(value);
const uniq=values=>[...new Set((values??[]).filter(v=>v!=null&&String(v).trim()).map(v=>String(v).trim()))].sort();
const required=(value,name)=>{const s=String(value??'').trim();if(!s)throw new TypeError(name+' is required');return s;};

function normalizeScope(scope){
  if(!scope||typeof scope!=='object')throw new TypeError('World Tree scope is required');
  const type=String(scope.type??'').toUpperCase();
  if(!SCOPE_TYPES.has(type))throw new TypeError('Unsupported World Tree scope: '+type);
  if(type===WorldTreeScopeType.GLOBAL)return Object.freeze({type,chatId:null});
  const chatId=required(scope.chatId,'CHAT scope chatId');
  return Object.freeze({type,chatId});
}

function normalizeMessageRef(input,scope){
  const row=input&&typeof input==='object'?input:{messageId:input};
  const messageId=required(row.messageId??row.id,'messageRef.messageId');
  const chatId=row.chatId==null?(scope.type===WorldTreeScopeType.CHAT?scope.chatId:null):String(row.chatId);
  if(!chatId)throw new TypeError('messageRef.chatId is required');
  if(scope.type!==WorldTreeScopeType.CHAT)throw new TypeError('Message-derived durable nodes must be CHAT scoped');
  if(String(chatId)!==String(scope.chatId))throw new Error('WORLD_TREE_MESSAGE_SCOPE_MISMATCH');
  return Object.freeze({
    chatId:String(chatId),
    messageId,
    messageRevision:row.messageRevision??row.revision??null,
    swipeId:row.swipeId??null,
    sourceIndex:Number.isFinite(Number(row.sourceIndex))?Number(row.sourceIndex):null,
  });
}

function normalizeProvenance(input,scope){
  if(!input||typeof input!=='object')throw new TypeError('World Tree provenance is required');
  const sourceType=required(input.sourceType,'provenance.sourceType').toUpperCase();
  const messageRefs=Object.freeze((input.messageRefs??[]).map(row=>normalizeMessageRef(row,scope)));
  const sourceIds=uniq(input.sourceIds);
  const sourceRevisionIds=uniq(input.sourceRevisionIds);
  const provenanceRefs=uniq(input.provenanceRefs);
  const importedFrom=input.importedFrom==null?null:String(input.importedFrom);
  if(!sourceIds.length&&!sourceRevisionIds.length&&!messageRefs.length&&!provenanceRefs.length&&!importedFrom){
    throw new TypeError('World Tree provenance must identify at least one source');
  }
  return Object.freeze({sourceType,sourceIds:Object.freeze(sourceIds),sourceRevisionIds:Object.freeze(sourceRevisionIds),messageRefs,provenanceRefs:Object.freeze(provenanceRefs),importedFrom});
}

function normalizeTemporal(input={}){
  const status=String(input.status??WorldTreeTemporalStatus.CURRENT).toUpperCase();
  if(!TEMPORAL_STATUSES.has(status))throw new TypeError('Unsupported World Tree temporal status: '+status);
  return Object.freeze({
    status,
    validFrom:input.validFrom??null,
    validUntil:input.validUntil??null,
    supersedes:Object.freeze(uniq(input.supersedes)),
    supersededBy:Object.freeze(uniq(input.supersededBy)),
    contradictedBy:Object.freeze(uniq(input.contradictedBy)),
    reason:input.reason==null?null:String(input.reason),
  });
}

function visibleScope(scope,chatId){
  if(scope?.type===WorldTreeScopeType.GLOBAL)return true;
  return chatId!=null&&String(scope?.chatId)===String(chatId);
}

function labelForNode(node){
  return String(node?.data?.label??node?.data?.name??node?.data?.title??node?.id??'World Tree node');
}

export class NexusWorldTree{
  constructor({snapshot=null}={}){
    this.nodes=new Map();
    this.edges=new Map();
    this.overlays=new Map();
    this.revision=0;
    this.overlayRevision=0;
    this.sequence=0;
    this.listeners=new Set();
    this.identityRegistry=new NativeEntityIdentityRegistry();
    this.temporalStateGraph=new TemporalStateGraph();
    if(snapshot)this.restoreState(snapshot);
    else this.#ensureRoot();
  }

  #ensureRoot(){
    if(this.nodes.has('world:nexus'))return;
    this.upsertNode({
      id:'world:nexus',
      kind:WorldTreeNodeKind.WORLD,
      scope:{type:WorldTreeScopeType.GLOBAL},
      provenance:{sourceType:'SYSTEM',sourceIds:['nexus-world-tree']},
      temporal:{status:WorldTreeTemporalStatus.CURRENT},
      data:{label:'Nexus World Tree'},
    });
  }

  #emit(type,payload){
    const event=Object.freeze({kind:'NexusWorldTreeEvent',type,worldRevision:this.revision,overlayRevision:this.overlayRevision,sequence:++this.sequence,payload:clone(payload)});
    for(const listener of [...this.listeners]){try{listener(event);}catch{}}
    return event;
  }

  subscribe(listener){if(typeof listener!=='function')throw new TypeError('World Tree listener must be a function');this.listeners.add(listener);return()=>this.listeners.delete(listener);}

  upsertNode(input={}){
    if(input.ephemeral===true)throw new Error('WORLD_TREE_EPHEMERAL_DURABLE_WRITE_FORBIDDEN');
    const id=required(input.id,'World Tree node id');
    const kind=String(input.kind??'').toUpperCase();
    if(!NODE_KINDS.has(kind))throw new TypeError('Unsupported World Tree node kind: '+kind);
    const scope=normalizeScope(input.scope);
    const provenance=normalizeProvenance(input.provenance,scope);
    const temporal=normalizeTemporal(input.temporal);
    const existing=this.nodes.get(id);
    if(existing&&existing.kind!==kind)throw new Error('WORLD_TREE_NODE_KIND_CONFLICT:'+id);
    const row=Object.freeze({
      kind,
      contractVersion:'1.0.0',
      id,
      parentId:input.parentId==null?null:String(input.parentId),
      scope,
      provenance,
      temporal,
      revision:Math.max(1,Number(existing?.revision??0)+1),
      createdRevision:existing?.createdRevision??(this.revision+1),
      updatedRevision:this.revision+1,
      data:clone(input.data??{}),
    });
    this.nodes.set(id,row);
    this.revision+=1;
    this.#emit(existing?'NODE_UPDATED':'NODE_CREATED',{nodeId:id});
    if(!existing)this.#emit('node-added',{nodeId:id,kind,scope});
    else if(existing.temporal.status!==WorldTreeTemporalStatus.SUPERSEDED&&temporal.status===WorldTreeTemporalStatus.SUPERSEDED)this.#emit('node-superseded',{nodeId:id,kind,scope});
    return clone(row);
  }

  removeNode(nodeId,{reason='removed'}={}){
    const id=String(nodeId),existing=this.nodes.get(id);
    if(!existing||id==='world:nexus')return false;
    this.nodes.delete(id);
    for(const [edgeId,edge] of [...this.edges])if(edge.from===id||edge.to===id)this.edges.delete(edgeId);
    for(const [overlayId,overlay] of [...this.overlays])if(overlay.nodeIds.includes(id))this.overlays.delete(overlayId);
    this.revision+=1;
    this.#emit('NODE_REMOVED',{nodeId:id,reason});
    return true;
  }

  removeEdge(edgeId,{reason='removed'}={}){
    const id=String(edgeId),existing=this.edges.get(id);
    if(!existing)return false;
    this.edges.delete(id);
    this.revision+=1;
    this.#emit('EDGE_REMOVED',{edgeId:id,reason});
    return true;
  }

  linkEdge(input={}){
    const id=required(input.id,'World Tree edge id');
    const from=required(input.from,'World Tree edge from'),to=required(input.to,'World Tree edge to');
    const source=this.nodes.get(from),target=this.nodes.get(to);
    if(!source||!target)throw new Error('WORLD_TREE_EDGE_NODE_MISSING:'+id);
    const scope=normalizeScope(input.scope);
    if(scope.type===WorldTreeScopeType.GLOBAL&&(source.scope.type!==WorldTreeScopeType.GLOBAL||target.scope.type!==WorldTreeScopeType.GLOBAL))throw new Error('WORLD_TREE_GLOBAL_EDGE_SCOPE_LEAK');
    if(scope.type===WorldTreeScopeType.CHAT){
      for(const node of [source,target])if(node.scope.type===WorldTreeScopeType.CHAT&&node.scope.chatId!==scope.chatId)throw new Error('WORLD_TREE_EDGE_CHAT_SCOPE_MISMATCH');
    }
    const relation=required(input.relation,'World Tree edge relation').toUpperCase();
    const provenance=normalizeProvenance(input.provenance,scope);
    const temporal=normalizeTemporal(input.temporal);
    const existing=this.edges.get(id);
    const row=Object.freeze({
      kind:'WORLD_TREE_EDGE',
      contractVersion:'1.0.0',
      id,from,to,relation,scope,provenance,temporal,
      revision:Math.max(1,Number(existing?.revision??0)+1),
      createdRevision:existing?.createdRevision??(this.revision+1),
      updatedRevision:this.revision+1,
      data:clone(input.data??{}),
    });
    this.edges.set(id,row);
    this.revision+=1;
    this.#emit(existing?'EDGE_UPDATED':'EDGE_CREATED',{edgeId:id});
    if(!existing)this.#emit('edge-added',{edgeId:id,kind:'WORLD_TREE_EDGE',scope});
    return clone(row);
  }

  addEphemeralOverlay(input={}){
    const id=required(input.id,'World Tree overlay id');
    const kind=String(input.kind??'').toUpperCase();
    if(!OVERLAY_KINDS.has(kind))throw new TypeError('Unsupported World Tree overlay kind: '+kind);
    const chatId=required(input.chatId,'World Tree overlay chatId');
    const nodeIds=uniq(input.nodeIds);
    for(const nodeId of nodeIds){
      const node=this.nodes.get(nodeId);
      if(!node)throw new Error('WORLD_TREE_OVERLAY_NODE_MISSING:'+nodeId);
      if(!visibleScope(node.scope,chatId))throw new Error('WORLD_TREE_OVERLAY_SCOPE_MISMATCH:'+nodeId);
    }
    const row=Object.freeze({
      kind,contractVersion:'1.0.0',id,chatId,
      turnId:input.turnId==null?null:String(input.turnId),
      generationId:input.generationId==null?null:String(input.generationId),
      nodeIds:Object.freeze(nodeIds),
      expiresAtTurn:Number.isFinite(Number(input.expiresAtTurn))?Number(input.expiresAtTurn):null,
      createdOverlayRevision:this.overlayRevision+1,
      data:clone(input.data??{}),
    });
    this.overlays.set(id,row);this.overlayRevision+=1;this.#emit('OVERLAY_UPSERTED',{overlayId:id});
    return clone(row);
  }

  expireEphemeral({chatId=null,currentTurn=null,clearGenerationId=null}={}){
    const removed=[];
    for(const [id,row] of [...this.overlays]){
      if(chatId!=null&&String(row.chatId)!==String(chatId))continue;
      const turnExpired=currentTurn!=null&&row.expiresAtTurn!=null&&Number(row.expiresAtTurn)<=Number(currentTurn);
      const generationExpired=clearGenerationId!=null&&String(row.generationId??'')===String(clearGenerationId);
      if(turnExpired||generationExpired){this.overlays.delete(id);removed.push(id);}
    }
    if(removed.length){this.overlayRevision+=1;this.#emit('OVERLAYS_EXPIRED',{overlayIds:removed});}
    return removed;
  }

  invalidateMessageSource({chatId,messageId,messageRevision=null,reason='source-message-invalidated'}={}){
    const chat=required(chatId,'chatId'),message=required(messageId,'messageId'),affected=[];
    for(const [id,node] of [...this.nodes]){
      if(node.scope.type!==WorldTreeScopeType.CHAT||node.scope.chatId!==chat)continue;
      const matches=node.provenance.messageRefs.some(ref=>ref.chatId===chat&&ref.messageId===message&&(messageRevision==null||String(ref.messageRevision??'')===String(messageRevision)));
      if(!matches)continue;
      const next=this.upsertNode({
        ...node,
        scope:node.scope,
        provenance:node.provenance,
        temporal:{...node.temporal,status:WorldTreeTemporalStatus.SUPERSEDED,reason},
        data:node.data,
      });
      affected.push(next.id);
    }
    if(affected.length)this.#emit('MESSAGE_SOURCE_INVALIDATED',{chatId:chat,messageId:message,messageRevision,affectedNodeIds:affected,reason});
    return affected;
  }

  registerIdentity({nodeId,canonicalLabel=null,entityType='UNKNOWN',aliases=[],providerId='WORLD_TREE',sourceEntityId=null,authorityOrigin='OWNER_EXPLICIT'}={}){
    const node=this.nodes.get(required(nodeId,'nodeId'));
    if(!node)throw new Error('WORLD_TREE_IDENTITY_NODE_MISSING:'+nodeId);
    return this.identityRegistry.registerIdentity({
      entityId:node.id,
      canonicalLabel:canonicalLabel??labelForNode(node),
      entityType,
      worldId:'world:nexus',
      providerId,
      sourceEntityId:sourceEntityId??node.id,
      aliases,
      sourceRevisionRefs:node.provenance.sourceRevisionIds,
      provenanceRefs:node.provenance.provenanceRefs,
      authorityOrigin,
      storyScopeId:node.scope.type===WorldTreeScopeType.CHAT?node.scope.chatId:null,
      metadata:{worldTreeNodeKind:node.kind,ownerAuthority:'WORLD_TREE'},
    });
  }

  getNode(nodeId,{chatId=null}={}){
    const node=this.nodes.get(String(nodeId));
    return node&&visibleScope(node.scope,chatId)?clone(node):null;
  }

  getEdge(edgeId,{chatId=null}={}){
    const edge=this.edges.get(String(edgeId));
    return edge&&visibleScope(edge.scope,chatId)?clone(edge):null;
  }

  // Lazy complete owner read for import/parity/continuation consumers. UI
  // projections keep their separate bounded read contract.
  *iterateNodes({chatId=null,kind=null}={}){
    for(const node of this.nodes.values())if(visibleScope(node.scope,chatId)&&(!kind||node.kind===String(kind).toUpperCase()))yield clone(node);
  }

  readLoreMetadata({chatId=null,limit=1000}={}){
    const max=Math.max(1,Math.min(5000,Number(limit)||1000));
    const visible=[...this.nodes.values()].filter(node=>node.kind==='LORE_FACT'&&visibleScope(node.scope,chatId));
    return {worldRevision:this.revision,chatId,nodes:visible.slice(0,max).map(node=>({id:node.id,kind:node.kind,revision:node.revision,
      temporal:clone(node.temporal),provenance:clone(node.provenance),data:{book:node.data?.book,uid:node.data?.uid,disabled:node.data?.disabled}})),
      coverage:{total:visible.length,returned:Math.min(max,visible.length),complete:visible.length<=max}};
  }

  read({chatId=null,includeOverlays=true,limit=1000}={}){
    const max=Math.max(1,Math.min(5000,Number(limit)||1000));
    const nodes=[...this.nodes.values()].filter(node=>visibleScope(node.scope,chatId)).slice(0,max);
    const visibleIds=new Set(nodes.map(node=>node.id));
    const edges=[...this.edges.values()].filter(edge=>visibleScope(edge.scope,chatId)&&visibleIds.has(edge.from)&&visibleIds.has(edge.to)).slice(0,max*2);
    const overlays=includeOverlays&&chatId!=null?[...this.overlays.values()].filter(row=>String(row.chatId)===String(chatId)).slice(0,max):[];
    return Object.freeze({
      kind:'NexusWorldTreeSnapshot',contractVersion:'1.0.0',
      worldRevision:this.revision,overlayRevision:this.overlayRevision,chatId:chatId==null?null:String(chatId),
      nodes:Object.freeze(nodes.map(clone)),edges:Object.freeze(edges.map(clone)),overlays:Object.freeze(overlays.map(clone)),
      counts:Object.freeze({
        nodes:nodes.length,edges:edges.length,overlays:overlays.length,
        current:nodes.filter(row=>row.temporal.status===WorldTreeTemporalStatus.CURRENT).length,
        historical:nodes.filter(row=>row.temporal.status===WorldTreeTemporalStatus.HISTORICAL).length,
        superseded:nodes.filter(row=>row.temporal.status===WorldTreeTemporalStatus.SUPERSEDED).length,
        unresolved:nodes.filter(row=>[WorldTreeTemporalStatus.CONTRADICTED,WorldTreeTemporalStatus.UNCERTAIN,WorldTreeTemporalStatus.UNRESOLVED].includes(row.temporal.status)).length,
      }),
      scopeEnforced:true,messageProvenanceEnforced:true,ephemeralStoredSeparately:true,
    });
  }

  readUiModel({chatId=null,limit=600}={}){
    const snapshot=this.read({chatId,includeOverlays:true,limit});
    return Object.freeze({
      kind:'NexusWorldTreeUiModel',contractVersion:'1.0.0',
      worldRevision:snapshot.worldRevision,overlayRevision:snapshot.overlayRevision,chatId:snapshot.chatId,
      title:'Nexus World Tree',status:'READY',counts:snapshot.counts,
      nodes:snapshot.nodes.map(node=>Object.freeze({
        id:node.id,kind:node.kind,label:labelForNode(node),parentId:node.parentId,scope:node.scope,
        temporal:node.temporal,revision:node.revision,createdRevision:node.createdRevision,updatedRevision:node.updatedRevision,
        sourceType:node.provenance.sourceType,messageSourceCount:node.provenance.messageRefs.length,
      })),
      edges:snapshot.edges.map(edge=>Object.freeze({id:edge.id,from:edge.from,to:edge.to,relation:edge.relation,scope:edge.scope,temporal:edge.temporal,revision:edge.revision,createdRevision:edge.createdRevision,updatedRevision:edge.updatedRevision,data:Object.freeze({primaryPlacement:edge.data?.primaryPlacement===true})})),
      overlays:snapshot.overlays.map(row=>Object.freeze({id:row.id,kind:row.kind,nodeIds:row.nodeIds,turnId:row.turnId,generationId:row.generationId,expiresAtTurn:row.expiresAtTurn})),
      owner:'WORLD_TREE',mutationAuthority:false,rawSourceBodiesIncluded:false,
    });
  }

  exportState(){
    return clone({
      kind:'NexusWorldTreeState',contractVersion:'1.0.0',worldRevision:this.revision,overlayRevision:this.overlayRevision,
      nodes:[...this.nodes.entries()],edges:[...this.edges.entries()],
      identityRegistry:this.identityRegistry.exportState(),
      temporalStateGraph:this.temporalStateGraph.exportState(),
      // Ephemeral overlays are intentionally omitted from durable export.
    });
  }

  restoreState(snapshot){
    if(!snapshot||snapshot.kind!=='NexusWorldTreeState')throw new TypeError('NexusWorldTreeState is required');
    this.nodes=new Map(clone(snapshot.nodes??[]));this.edges=new Map(clone(snapshot.edges??[]));this.overlays=new Map();
    this.revision=Math.max(0,Number(snapshot.worldRevision)||0);this.overlayRevision=0;
    if(snapshot.identityRegistry)this.identityRegistry.restoreState(snapshot.identityRegistry);
    if(snapshot.temporalStateGraph)this.temporalStateGraph.restoreState(snapshot.temporalStateGraph);
    this.#ensureRoot();
    return this.exportState();
  }
}
