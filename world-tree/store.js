import { NativeEntityIdentityRegistry } from './entity-identity-registry.js';
import { TemporalStateGraph } from './temporal-state-graph.js';
import { canonicalWorldTreeEdgeMeaning, inspectWorldTreeEdgeMeaning } from './intake/edge-vocabulary.js';
import { WORLD_TREE_DECISION_REASON_TEXT } from './decision-records.js';

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
  CHARACTER_MEMORY:'CHARACTER_MEMORY',
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
  SENSORY_CONTINUATION:'SENSORY_CONTINUATION',
  RETRIEVAL_SOURCE_PLAN:'RETRIEVAL_SOURCE_PLAN',
  TASK8_POSTTURN_ADVICE:'TASK8_POSTTURN_ADVICE',
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
    this.contributionLedger=new Map();
    this.contributionLineage=new Map();
    this.decisionRecords=new Map();
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

  recordDecision(input={}){
    const id=required(input.id,'DecisionRecord id'),site=required(input.site,'DecisionRecord site'),chosen=required(input.chosen,'DecisionRecord chosen'),decidedBy=required(input.decidedBy,'DecisionRecord decidedBy');
    const row=Object.freeze({...clone(input),kind:'DecisionRecord',id,site,chosen,decidedBy,ts:Number(input.ts)||Date.now()});this.decisionRecords.set(id,row);this.#emit('DECISION_RECORDED',{decisionId:id,site,chosen,decidedBy});return clone(row);
  }
  getDecisionRecord(id){const row=this.decisionRecords.get(String(id));return row?clone(row):null;}
  listDecisionRecords({chatId=null,generationId=null,site=null,limit=500}={}){
    return [...this.decisionRecords.values()].filter(row=>(chatId==null||String(row.chatId??'')===String(chatId))&&(generationId==null||String(row.generationId??'')===String(generationId))&&(site==null||String(row.site)===String(site))).slice(-Math.max(1,Math.min(5000,Number(limit)||500))).map(clone);
  }

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
    const relationInput=required(input.relation,'World Tree edge relation'),meaning=inspectWorldTreeEdgeMeaning(relationInput);
    if(!meaning.standard||meaning.translated)throw new Error('WORLD_TREE_EDGE_RELATION_NONCANONICAL:'+relationInput);
    const relation=meaning.meaning;
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

  contributionRecord(ledgerKey){
    const row=this.contributionLedger.get(String(ledgerKey??''));
    return row?clone(row):null;
  }

  latestContributionRecord(lineageKey){
    const key=this.contributionLineage.get(String(lineageKey??''));
    return key?this.contributionRecord(key):null;
  }

  applyContributionRevision({ledgerKey,lineageKey,fingerprint,source=null,scope=null,nodes=[],edges=[],supplementalEdges=[],decisionRecordIds=[],allowReplay=false}={}){
    const key=required(ledgerKey,'contribution ledgerKey'),lineage=required(lineageKey,'contribution lineageKey'),hash=required(fingerprint,'contribution fingerprint');
    const exact=this.contributionLedger.get(key),lineageHead=this.contributionLineage.get(lineage);
    if(!allowReplay&&exact?.fingerprint===hash&&lineageHead===key)return Object.freeze({kind:'NexusWorldTreeContributionCommit',noOp:true,worldRevision:this.revision,record:clone(exact),createdNodeIds:Object.freeze([]),updatedNodeIds:Object.freeze([]),createdEdgeIds:Object.freeze([]),updatedEdgeIds:Object.freeze([]),supersededNodeIds:Object.freeze([]),supersededEdgeIds:Object.freeze([])});
    const nextRevision=this.revision+1,nextNodes=new Map(this.nodes),nextEdges=new Map(this.edges),decisionIds=uniq(decisionRecordIds);
    const stagedNodes=[],stagedEdges=[];
    const withDecisionRefs=(data,existing)=>({...clone(data??{}),decisionRecordIds:Object.freeze(uniq([...(existing?.data?.decisionRecordIds??[]),...(data?.decisionRecordIds??[]),...decisionIds]))});
    const inputNodes=Array.isArray(nodes)?nodes:[],inputEdges=Array.isArray(edges)?edges:[];
    const nodeIds=inputNodes.map(row=>required(row?.id,'contribution node id')),edgeIds=inputEdges.map(row=>required(row?.id,'contribution edge id'));
    if(new Set(nodeIds).size!==nodeIds.length)throw new Error('WORLD_TREE_CONTRIBUTION_DUPLICATE_NODE_ID');
    if(new Set(edgeIds).size!==edgeIds.length)throw new Error('WORLD_TREE_CONTRIBUTION_DUPLICATE_EDGE_ID');

    const prepareNode=(input,existing)=>{
      if(input.ephemeral===true)throw new Error('WORLD_TREE_EPHEMERAL_DURABLE_WRITE_FORBIDDEN');
      const id=required(input.id,'World Tree node id'),kind=String(input.kind??'').toUpperCase();
      if(!NODE_KINDS.has(kind))throw new TypeError('Unsupported World Tree node kind: '+kind);
      const rowScope=normalizeScope(input.scope),provenance=normalizeProvenance(input.provenance,rowScope),temporal=normalizeTemporal(input.temporal);
      if(existing&&existing.kind!==kind)throw new Error('WORLD_TREE_NODE_KIND_CONFLICT:'+id);
      return Object.freeze({kind,contractVersion:'1.0.0',id,parentId:input.parentId==null?null:String(input.parentId),scope:rowScope,provenance,temporal,
        revision:Math.max(1,Number(existing?.revision??0)+1),createdRevision:existing?.createdRevision??nextRevision,updatedRevision:nextRevision,data:withDecisionRefs(input.data??{},existing)});
    };
    const prepareEdge=(input,existing)=>{
      const id=required(input.id,'World Tree edge id'),from=required(input.from,'World Tree edge from'),to=required(input.to,'World Tree edge to');
      const sourceNode=nextNodes.get(from),targetNode=nextNodes.get(to);
      if(!sourceNode||!targetNode)throw new Error('WORLD_TREE_EDGE_NODE_MISSING:'+id);
      const rowScope=normalizeScope(input.scope);
      if(rowScope.type===WorldTreeScopeType.GLOBAL&&(sourceNode.scope.type!==WorldTreeScopeType.GLOBAL||targetNode.scope.type!==WorldTreeScopeType.GLOBAL))throw new Error('WORLD_TREE_GLOBAL_EDGE_SCOPE_LEAK');
      if(rowScope.type===WorldTreeScopeType.CHAT){
        for(const node of [sourceNode,targetNode])if(node.scope.type===WorldTreeScopeType.CHAT&&node.scope.chatId!==rowScope.chatId)throw new Error('WORLD_TREE_EDGE_CHAT_SCOPE_MISMATCH');
      }
      const meaning=inspectWorldTreeEdgeMeaning(required(input.relation,'World Tree edge relation'));
      if((!meaning.standard||meaning.translated)&&!(existing&&input.temporal?.status===WorldTreeTemporalStatus.SUPERSEDED&&input.relation===existing.relation))throw new Error('WORLD_TREE_EDGE_RELATION_NONCANONICAL:'+input.relation);
      const relation=meaning.meaning,provenance=normalizeProvenance(input.provenance,rowScope),temporal=normalizeTemporal(input.temporal);
      return Object.freeze({kind:'WORLD_TREE_EDGE',contractVersion:'1.0.0',id,from,to,relation,scope:rowScope,provenance,temporal,
        revision:Math.max(1,Number(existing?.revision??0)+1),createdRevision:existing?.createdRevision??nextRevision,updatedRevision:nextRevision,data:withDecisionRefs(input.data??{},existing)});
    };
    const stageNode=input=>{const before=nextNodes.get(String(input.id));const after=prepareNode(input,before);nextNodes.set(after.id,after);stagedNodes.push({before,after});};
    const stageEdge=input=>{const before=nextEdges.get(String(input.id));const after=prepareEdge(input,before);nextEdges.set(after.id,after);stagedEdges.push({before,after});};

    const priorKey=this.contributionLineage.get(lineage),prior=priorKey?this.contributionLedger.get(priorKey):null;
    const nextNodeSet=new Set(nodeIds),nextEdgeSet=new Set(edgeIds);
    for(const id of prior?.ownedNodeIds??[]){
      if(nextNodeSet.has(id))continue;
      const existing=nextNodes.get(id);if(!existing||existing.temporal?.status===WorldTreeTemporalStatus.SUPERSEDED)continue;
      stageNode({...existing,temporal:{...existing.temporal,status:WorldTreeTemporalStatus.SUPERSEDED,reason:'contribution-revised'},data:existing.data});
    }
    for(const input of inputNodes)stageNode(input);
    for(const id of prior?.edgeIds??[]){
      if(nextEdgeSet.has(id))continue;
      const existing=nextEdges.get(id);if(!existing||existing.temporal?.status===WorldTreeTemporalStatus.SUPERSEDED)continue;
      stageEdge({...existing,temporal:{...existing.temporal,status:WorldTreeTemporalStatus.SUPERSEDED,reason:'contribution-revised'},data:existing.data});
    }
    for(const input of inputEdges)stageEdge(input);
    const supplementalRecords=new Map();
    for(const item of supplementalEdges){
      const origin=this.contributionLedger.get(String(item.ledgerKey));
      if(!origin||this.contributionLineage.get(origin.lineageKey)!==origin.ledgerKey)continue;
      stageEdge(item.edge);
      const record=supplementalRecords.get(origin.ledgerKey)??origin;
      supplementalRecords.set(origin.ledgerKey,Object.freeze({...record,edgeIds:Object.freeze(uniq([...record.edgeIds,item.edge.id]))}));
    }

    const changed=stagedNodes.length>0||stagedEdges.length>0;
    if(changed){this.nodes=nextNodes;this.edges=nextEdges;this.revision=nextRevision;}
    const record=Object.freeze({kind:'NexusWorldTreeContributionRecord',ledgerKey:key,lineageKey:lineage,fingerprint:hash,source:source==null?null:String(source),scope:clone(scope),
      worldRevision:this.revision,ownedNodeIds:Object.freeze([...nodeIds]),edgeIds:Object.freeze([...edgeIds]),decisionRecordIds:Object.freeze(decisionIds),appliedAt:Date.now()});
    this.contributionLedger.set(key,record);this.contributionLineage.set(lineage,key);
    for(const [originKey,originRecord] of supplementalRecords)this.contributionLedger.set(originKey,originRecord);

    if(changed){
      for(const {before,after} of stagedNodes){
        this.#emit(before?'NODE_UPDATED':'NODE_CREATED',{nodeId:after.id});
        if(!before)this.#emit('node-added',{nodeId:after.id,kind:after.kind,scope:after.scope});
        else if(before.temporal.status!==WorldTreeTemporalStatus.SUPERSEDED&&after.temporal.status===WorldTreeTemporalStatus.SUPERSEDED)this.#emit('node-superseded',{nodeId:after.id,kind:after.kind,scope:after.scope});
      }
      for(const {before,after} of stagedEdges){
        this.#emit(before?'EDGE_UPDATED':'EDGE_CREATED',{edgeId:after.id});
        if(!before)this.#emit('edge-added',{edgeId:after.id,kind:'WORLD_TREE_EDGE',scope:after.scope});
      }
    }
    const createdNodeIds=stagedNodes.filter(row=>!row.before).map(row=>row.after.id),updatedNodeIds=stagedNodes.filter(row=>row.before).map(row=>row.after.id);
    const createdEdgeIds=stagedEdges.filter(row=>!row.before).map(row=>row.after.id),updatedEdgeIds=stagedEdges.filter(row=>row.before).map(row=>row.after.id);
    return Object.freeze({kind:'NexusWorldTreeContributionCommit',noOp:!changed,worldRevision:this.revision,record:clone(record),
      createdNodeIds:Object.freeze(createdNodeIds),updatedNodeIds:Object.freeze(updatedNodeIds),createdEdgeIds:Object.freeze(createdEdgeIds),updatedEdgeIds:Object.freeze(updatedEdgeIds),
      supersededNodeIds:Object.freeze(stagedNodes.filter(row=>row.after.temporal.status===WorldTreeTemporalStatus.SUPERSEDED).map(row=>row.after.id)),
      supersededEdgeIds:Object.freeze(stagedEdges.filter(row=>row.after.temporal.status===WorldTreeTemporalStatus.SUPERSEDED).map(row=>row.after.id))});
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

  *iterateEdges({chatId=null,relation=null}={}){
    for(const edge of this.edges.values())if(visibleScope(edge.scope,chatId)&&(!relation||canonicalWorldTreeEdgeMeaning(edge.relation)===canonicalWorldTreeEdgeMeaning(relation)))yield clone(edge);
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
        trackedCharacter:node.data?.trackedCharacter===true,tracking:node.data?.tracking??(node.data?.trackedCharacter===true?'active':null),
        decisionRecordIds:Object.freeze([...(node.data?.decisionRecordIds??[])]),
        why:Object.freeze((node.data?.decisionRecordIds??[]).slice(-8).map(id=>this.decisionRecords.get(String(id))).filter(Boolean).map(row=>Object.freeze({
          id:row.id,site:row.site,chosen:row.chosen,decidedBy:row.decidedBy,
          reasonCodes:Object.freeze([...(row.reasonCodes??[])]),
          reasons:Object.freeze((row.reasonCodes??[]).map(code=>WORLD_TREE_DECISION_REASON_TEXT[code]).filter(Boolean)),
        }))),
      })),
      edges:snapshot.edges.map(edge=>Object.freeze({
        id:edge.id,from:edge.from,to:edge.to,relation:canonicalWorldTreeEdgeMeaning(edge.relation),scope:edge.scope,temporal:edge.temporal,
        revision:edge.revision,createdRevision:edge.createdRevision,updatedRevision:edge.updatedRevision,
        data:Object.freeze({primaryPlacement:edge.data?.primaryPlacement===true,decisionRecordIds:Object.freeze([...(edge.data?.decisionRecordIds??[])])}),
        why:Object.freeze((edge.data?.decisionRecordIds??[]).slice(-8).map(id=>this.decisionRecords.get(String(id))).filter(Boolean).map(row=>Object.freeze({
          id:row.id,site:row.site,chosen:row.chosen,decidedBy:row.decidedBy,
          reasonCodes:Object.freeze([...(row.reasonCodes??[])]),
          reasons:Object.freeze((row.reasonCodes??[]).map(code=>WORLD_TREE_DECISION_REASON_TEXT[code]).filter(Boolean)),
        }))),
      })),
      overlays:snapshot.overlays.map(row=>Object.freeze({id:row.id,kind:row.kind,nodeIds:row.nodeIds,turnId:row.turnId,generationId:row.generationId,expiresAtTurn:row.expiresAtTurn})),
      owner:'WORLD_TREE',mutationAuthority:false,rawSourceBodiesIncluded:false,
    });
  }

  exportChatState({chatId}={}){
    const chat=required(chatId,'chatId');
    const nodes=[...this.nodes.entries()].filter(([,node])=>node.scope?.type===WorldTreeScopeType.CHAT&&String(node.scope.chatId)===chat);
    const edges=[...this.edges.entries()].filter(([,edge])=>edge.scope?.type===WorldTreeScopeType.CHAT&&String(edge.scope.chatId)===chat);
    const decisions=[...this.decisionRecords.entries()].filter(([,row])=>String(row.chatId??'')===chat);
    const ledger=[...this.contributionLedger.entries()].filter(([,row])=>row.scope?.type===WorldTreeScopeType.CHAT&&String(row.scope.chatId)===chat);
    const ledgerKeys=new Set(ledger.map(([key])=>String(key)));
    const lineage=[...this.contributionLineage.entries()].filter(([,ledgerKey])=>ledgerKeys.has(String(ledgerKey)));
    return clone({kind:'NexusWorldTreeChatState',contractVersion:'1.0.0',chatId:chat,worldRevision:this.revision,nodes,edges,decisionRecords:decisions,contributionLedger:ledger,contributionLineage:lineage});
  }

  importChatState(snapshot,{replace=true}={}){
    if(!snapshot||snapshot.kind!=='NexusWorldTreeChatState')throw new TypeError('NexusWorldTreeChatState is required');
    const chat=required(snapshot.chatId,'snapshot.chatId');
    if(replace){
      for(const [id,node] of [...this.nodes])if(node.scope?.type===WorldTreeScopeType.CHAT&&String(node.scope.chatId)===chat)this.nodes.delete(id);
      for(const [id,edge] of [...this.edges])if(edge.scope?.type===WorldTreeScopeType.CHAT&&String(edge.scope.chatId)===chat)this.edges.delete(id);
      for(const [id,row] of [...this.decisionRecords])if(String(row.chatId??'')===chat)this.decisionRecords.delete(id);
      const removedLedger=new Set();
      for(const [key,row] of [...this.contributionLedger])if(row.scope?.type===WorldTreeScopeType.CHAT&&String(row.scope.chatId)===chat){this.contributionLedger.delete(key);removedLedger.add(String(key));}
      for(const [lineage,key] of [...this.contributionLineage])if(removedLedger.has(String(key)))this.contributionLineage.delete(lineage);
    }
    for(const [id,node] of clone(snapshot.nodes??[]))this.nodes.set(String(id),node);
    for(const [id,edge] of clone(snapshot.edges??[]))this.edges.set(String(id),edge);
    for(const [id,row] of clone(snapshot.decisionRecords??[]))this.decisionRecords.set(String(id),row);
    for(const [key,row] of clone(snapshot.contributionLedger??[]))this.contributionLedger.set(String(key),row);
    for(const [key,value] of clone(snapshot.contributionLineage??[]))this.contributionLineage.set(String(key),String(value));
    this.revision=Math.max(this.revision,Number(snapshot.worldRevision)||0);
    this.#emit('CHAT_STATE_IMPORTED',{chatId:chat,nodeCount:(snapshot.nodes??[]).length,edgeCount:(snapshot.edges??[]).length});
    return this.exportChatState({chatId:chat});
  }

  exportState(){
    return clone({
      kind:'NexusWorldTreeState',contractVersion:'1.0.0',worldRevision:this.revision,overlayRevision:this.overlayRevision,
      nodes:[...this.nodes.entries()],edges:[...this.edges.entries()],
      contributionLedger:[...this.contributionLedger.entries()],contributionLineage:[...this.contributionLineage.entries()],decisionRecords:[...this.decisionRecords.entries()],
      identityRegistry:this.identityRegistry.exportState(),
      temporalStateGraph:this.temporalStateGraph.exportState(),
      // Ephemeral overlays are intentionally omitted from durable export.
    });
  }

  restoreState(snapshot){
    if(!snapshot||snapshot.kind!=='NexusWorldTreeState')throw new TypeError('NexusWorldTreeState is required');
    this.nodes=new Map(clone(snapshot.nodes??[]));this.edges=new Map(clone(snapshot.edges??[]));this.overlays=new Map();
    this.contributionLedger=new Map(clone(snapshot.contributionLedger??[]));this.contributionLineage=new Map(clone(snapshot.contributionLineage??[]));this.decisionRecords=new Map(clone(snapshot.decisionRecords??[]));
    this.revision=Math.max(0,Number(snapshot.worldRevision)||0);this.overlayRevision=0;
    if(snapshot.identityRegistry)this.identityRegistry.restoreState(snapshot.identityRegistry);
    if(snapshot.temporalStateGraph)this.temporalStateGraph.restoreState(snapshot.temporalStateGraph);
    this.#ensureRoot();
    return this.exportState();
  }
}
