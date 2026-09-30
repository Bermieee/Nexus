import { createKeyValue, element, makeBadge } from './primitives.js';

export const SELECTED_TURN_GRAPH_VISIBILITY_VERSION='1.0.0';
const MAX_EDGES=32,MAX_STALE=32,MAX_CANDIDATES=24,MAX_OWNERS=16,MAX_REFS=24;
const clone=(value)=>value==null?value:structuredClone(value);
const arr=(value)=>Array.isArray(value)?value:[];
const uniq=(values,limit=MAX_REFS)=>[...new Set((values??[]).filter(Boolean).map(String))].slice(0,limit);
const text=(value,limit=180)=>value==null?null:String(value).slice(0,limit);
const freeze=(value)=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const row of Object.values(value))freeze(row);Object.freeze(value);}return value;};

export class SelectedTurnGraphVisibilityAdapter{
  constructor({bindings={},selectionProvider=()=>({}),decisionVisibility=null}={}){
    this.bindings=bindings??{};
    this.selectionProvider=typeof selectionProvider==='function'?selectionProvider:()=>({});
    this.decisionVisibility=decisionVisibility??null;
    this.readSelected=reader(bindings,['readSelectedTurnReceipt']);
    this.readTraversal=reader(bindings,['readGraphTraversal']);
    this.readWorldReferences=reader(bindings,['readWorldGraphReferences']);
    this.readCandidates=reader(bindings,['readCandidateBusEnvelope','readSensoryTrace']);
  }

  capabilities(){
    return freeze({selectedTurn:Boolean(this.readSelected),graphTraversal:Boolean(this.readTraversal),worldGraphReferences:Boolean(this.readWorldReferences),candidateBus:Boolean(this.readCandidates),mutation:false,truth:false,settlement:false,contextSeal:false});
  }

  read(selection=null){
    const expected=normalizeSelection(selection??this.selectionProvider?.()??{});
    if(!expected.chatId||!expected.turnId||!expected.generationId)return emptyModel(expected,'WAITING_FOR_SELECTED_TURN','Select an exact chat / turn / generation before graph evidence can be inspected.',this.capabilities());
    if(!this.readSelected)return emptyModel(expected,'UNAVAILABLE','Native Brain selected-turn receipt reader is not exported by the host assembly.',this.capabilities());

    const errors=[];
    const selected=safeRead(this.readSelected,expected,'SelectedTurn',errors,{requireIdentity:true});
    if(!selected)return emptyModel(expected,'NO_EVIDENCE','No exact Native Brain selected-turn receipt exists for this selection.',this.capabilities(),errors);
    const anchor=normalizeSelection(selected);
    const traversal=safeRead(this.readTraversal,anchor,'GraphTraversal',errors,{allowMissingIdentity:true});
    const worldRead=safeRead(this.readWorldReferences,anchor,'WorldGraphReferences',errors,{allowMissingIdentity:false});
    const references=worldRead?.referenceSet??worldRead??null;
    const candidateEnvelope=safeRead(this.readCandidates,anchor,'CandidateBus',errors,{allowMissingIdentity:true});
    const decision=safeDecision(this.decisionVisibility,anchor,errors);

    const receiptEdges=arr(traversal?.referenceSummary).slice(0,MAX_EDGES).map((row,index)=>edgeRow(row,'GENERATION_GRAPH_TRAVERSAL',index));
    const referenceEdges=arr(references?.edges).slice(0,MAX_EDGES).map((row,index)=>edgeRow(row,'ON_DEMAND_WORLD_GRAPH_REFERENCE',index));
    const owners=ownerRows(receiptEdges.length?receiptEdges:referenceEdges);
    const stale=[
      ...staleRows(traversal?.staleRejected,'GENERATION_GRAPH_TRAVERSAL'),
      ...staleRows(references?.staleRejected,'ON_DEMAND_WORLD_GRAPH_REFERENCE'),
    ].slice(0,MAX_STALE);
    const candidates=graphCandidateRows(candidateEnvelope,decision);
    const traversedCount=Number(traversal?.traversedEdgeCount??receiptEdges.length??0);
    const nominationCount=Number(traversal?.nominationCount??0);
    const providers=arr(traversal?.providers).slice(0,MAX_OWNERS).map(row=>({
      providerId:text(row?.providerId),status:text(row?.status),edgeCount:Number(row?.edgeCount??0),rejectedStale:Number(row?.rejectedStale??0),providerRevision:text(row?.providerRevision,240),
    }));
    const degraded=providers.some(row=>['DEGRADED','ERROR'].includes(String(row.status??'').toUpperCase()))||errors.length>0;
    const anyGraphEvidence=Boolean(traversal||references);
    const zeroWork=Boolean(traversal&&traversedCount===0&&nominationCount===0&&Number(traversal?.staleRejectedCount??0)===0);
    const state=!anyGraphEvidence
      ?(this.readTraversal||this.readWorldReferences?'NO_EVIDENCE':'UNAVAILABLE')
      :zeroWork?'ZERO_WORK'
      :degraded?'DEGRADED':'READY';
    const reason=state==='ZERO_WORK'
      ?(traversal?.noWorkReason==='NO_ENTITY_ANCHORS'?'The selected retrieval intent supplied no entity anchors; no graph neighborhood could be traversed.':'Graph traversal executed for this exact selected turn but published no traversed edge, nomination, or stale rejection.')
      :state==='UNAVAILABLE'
        ?'The host assembly does not export GraphTraversalReceipt or selected-turn worldGraphReferences readers.'
        :state==='NO_EVIDENCE'
          ?'Graph readers are exported, but no GraphTraversalReceipt or selected-turn world graph reference read was published.'
          :state==='DEGRADED'
            ?'Selected-turn graph evidence is partially available; at least one provider/read reported degraded or failed state.'
            :'Generation-time traversal and/or bounded selected-turn world graph references are available.';

    return freeze({
      kind:'SelectedTurnGraphVisibilityReadModel',contractVersion:SELECTED_TURN_GRAPH_VISIBILITY_VERSION,
      selection:anchor,state,reason,capabilities:this.capabilities(),
      generationTraversal:traversal?{
        kind:text(traversal.kind),contractVersion:text(traversal.contractVersion),intentId:text(traversal.intentId),traversedEdgeCount:traversedCount,
        visitedNodeCount:Number(traversal.visitedNodeCount??0),examinedEdgeCount:Number(traversal.examinedEdgeCount??0),nominationCount,
        noWorkReason:text(traversal.noWorkReason),budgetPolicy:text(traversal.budgetPolicy),elapsedMs:Number(traversal.elapsedMs??0),latencyBudgetExceeded:Boolean(traversal.latencyBudgetExceeded),
        staleRejectedCount:Number(traversal.staleRejectedCount??0),providers,limits:clone(traversal.limits??null),boundedOut:clone(traversal.boundedOut??null),
        authority:clone(traversal.authority??null),evidenceClass:'GENERATION_TIME_RECEIPT',
      }:null,
      worldReferenceRead:references?{
        kind:text(references.kind),contractVersion:text(references.contractVersion),intentKind:text(references.intentKind),
        edgeCount:referenceEdges.length,identityReferenceCount:arr(references.identityReferences).length,temporalReferenceCount:arr(references.temporalReferences).length,
        revisionFence:boundedFence(references.revisionFence),limits:clone(references.limits??null),boundedOut:clone(references.boundedOut??null),
        authority:clone(references.authority??null),readOnly:references.readOnly!==false,rawSourceContentIncluded:Boolean(references.rawSourceContentIncluded),
        evidenceClass:worldRead?.observationClass??'ON_DEMAND_SELECTED_TURN_REFERENCE_READ',generationTimeReceipt:false,
      }:null,
      owners,relationships:receiptEdges,referenceEdges,staleRejected:stale,candidates,
      summary:{
        ownerCount:owners.length,traversedEdgeCount:traversedCount,relationshipRows:receiptEdges.length,referenceEdgeCount:referenceEdges.length,
        nominatedGraphCandidates:nominationCount,candidateBusGraphCandidates:candidates.length,staleRejected:stale.length,
        truthProven:candidates.filter(row=>row.truth==='PROVEN').length,gatherProven:candidates.filter(row=>row.gather==='PROVEN').length,sealProven:candidates.filter(row=>row.contextSeal==='PROVEN').length,
      },
      errors:errors.slice(0,12),
      safety:{metadataOnly:true,rawPrompt:false,rawLoreBodies:false,rawMemoryBodies:false,hiddenReasoning:false,mutationAuthority:false,truthAuthority:false,settlementAuthority:false,contextSealAuthority:false},
    });
  }
}

export function renderSelectedTurnGraphVisibility(doc,model,{compact=false,title='Selected-turn graph trace'}={}){
  const root=element(doc,'section',{className:'nexus-card nexus-selected-turn-graph',attrs:{'aria-label':title}});
  const state=model?.state??'UNAVAILABLE';
  root.append(element(doc,'div',{className:'nexus-inline-status'},element(doc,'strong',{text:title}),makeBadge(doc,state,stateToken(state))));
  root.append(element(doc,'p',{className:'nexus-muted',text:model?.reason??'No graph read model is connected.'}));
  if(!model||['WAITING_FOR_SELECTED_TURN','UNAVAILABLE','NO_EVIDENCE'].includes(state))return root;
  const s=model.summary??{};
  root.append(createKeyValue(doc,[
    {key:'Owners / traversed relationships',value:String(s.ownerCount??0)+' / '+String(s.traversedEdgeCount??0)},
    {key:'Graph nominations / Candidate Bus',value:String(s.nominatedGraphCandidates??0)+' / '+String(s.candidateBusGraphCandidates??0)},
    {key:'Truth / Gather / Context Seal',value:String(s.truthProven??0)+' / '+String(s.gatherProven??0)+' / '+String(s.sealProven??0)},
    {key:'Stale rejected',value:String(s.staleRejected??0)},
    {key:'World reference edges',value:String(s.referenceEdgeCount??0)+' · '+(model.worldReferenceRead?.evidenceClass??'UNAVAILABLE')},
  ]));

  const ownerBlock=element(doc,'div',{className:'nexus-brain-decision-block'});
  ownerBlock.append(element(doc,'h3',{text:'Edge owners'}));
  if(model.owners?.length){
    const list=element(doc,'div',{className:'nexus-brain-decision-list'});
    for(const row of model.owners.slice(0,compact?8:MAX_OWNERS)){
      const line=element(doc,'div',{className:'nexus-wave13-flow-row'});
      line.append(element(doc,'strong',{text:row.owner??row.providerId??'Unknown owner'}),element(doc,'span',{className:'nexus-muted',text:(row.providerId??'provider not published')+' · '+row.edgeCount+' edge'+(row.edgeCount===1?'':'s')}),makeBadge(doc,row.temporalStatuses.join('/')||'UNKNOWN','observed'));
      list.append(line);
    }
    ownerBlock.append(list);
  }else ownerBlock.append(zero(doc,'No owner supplied a traversed graph edge for this selected turn.'));
  root.append(ownerBlock);

  const rel=element(doc,'div',{className:'nexus-brain-decision-block'});
  rel.append(element(doc,'h3',{text:'Traversed relationships'}));
  if(model.relationships?.length){
    const list=element(doc,'div',{className:'nexus-brain-decision-list'});
    for(const row of model.relationships.slice(0,compact?10:MAX_EDGES)){
      const line=element(doc,'div',{className:'nexus-wave13-flow-row'});
      line.append(element(doc,'strong',{text:row.edgeMeaning??'RELATED'}),element(doc,'code',{text:(row.fromEntityId??'?')+' → '+(row.toEntityId??'?')}),makeBadge(doc,row.temporalStatus??'UNKNOWN',row.temporalStatus==='CURRENT'?'ready':'historical'));
      list.append(line);
    }
    rel.append(list);
  }else rel.append(zero(doc,state==='ZERO_WORK'?'Zero graph relationships were traversed.':'No generation-time relationship rows were published.'));
  root.append(rel);

  const rejected=element(doc,'div',{className:'nexus-brain-decision-block'});
  rejected.append(element(doc,'h3',{text:'Stale / rejected graph evidence'}));
  if(model.staleRejected?.length){
    const list=element(doc,'div',{className:'nexus-brain-decision-list'});
    for(const row of model.staleRejected.slice(0,compact?8:MAX_STALE)){
      const line=element(doc,'div',{className:'nexus-wave13-flow-row'});
      line.append(makeBadge(doc,'REJECTED','warning'),element(doc,'strong',{text:row.edgeId??row.providerId??'graph edge'}),element(doc,'span',{className:'nexus-muted',text:row.reason??'STALE_REVISION'}));
      list.append(line);
    }
    rejected.append(list);
  }else rejected.append(zero(doc,'No stale graph edge rejection was published for this selected turn.'));
  root.append(rejected);

  const candidates=element(doc,'div',{className:'nexus-brain-decision-block'});
  candidates.append(element(doc,'h3',{text:'Graph candidate path'}));
  if(model.candidates?.length){
    const list=element(doc,'div',{className:'nexus-brain-candidate-flow'});
    for(const row of model.candidates.slice(0,compact?10:MAX_CANDIDATES)){
      const line=element(doc,'div',{className:'nexus-brain-candidate-flow__row'});
      line.append(element(doc,'strong',{text:row.candidateId??'graph candidate'}));
      for(const [label,value] of [['Candidate Bus',row.candidateBus],['Truth',row.truth],['Gather',row.gather],['Context Seal',row.contextSeal]])line.append(makeBadge(doc,label+': '+value,progressToken(value)));
      list.append(line);
    }
    candidates.append(list);
  }else candidates.append(zero(doc,(model.generationTraversal?.nominationCount??0)>0?'Graph nominations were reported, but no fused Candidate Bus graph candidate identity is retained in the exact selected-turn envelope.':'No graph candidate nomination reached the retained Candidate Bus envelope.'));
  root.append(candidates);
  root.append(element(doc,'p',{className:'nexus-muted',text:'Generation traversal is the actual GraphTraversalReceipt. World references are an on-demand, exact-selection, read-only query using the selected turn\'s stored intent, anchors and revision fence; they are not generation-time mutation evidence.'}));
  return root;
}

function graphCandidateRows(envelope,decision){
  const progress=new Map(arr(decision?.candidateFlow).map(row=>[String(row.candidateId),row]));
  const rows=[];
  for(const candidate of arr(envelope?.candidates??envelope?.envelope?.candidates)){
    const meta=arr(candidate?.graphMetadata),channels=arr(candidate?.channelNominations).map(row=>typeof row==='string'?row:row?.channelId);
    if(!meta.length&&!channels.includes('ZZ_NATIVE_GRAPH_WALKER'))continue;
    const candidateId=String(candidate?.candidateId??candidate?.id??'graph-candidate:'+rows.length),flow=progress.get(candidateId)??{};
    rows.push({
      candidateId,providers:uniq(meta.map(row=>row?.graphProvider),12),owners:uniq(meta.map(row=>row?.graphOwner),12),edgeIds:uniq(meta.map(row=>row?.edgeId),MAX_REFS),
      sourceRevisionRefs:uniq(candidate?.sourceRevisionRefs??candidate?.sourceRevisionIds),evidenceRefs:uniq(candidate?.evidenceRefs),
      candidateBus:'PROVEN',truth:flow.truth??(decision?'NO_EVIDENCE':'UNAVAILABLE'),gather:flow.gather??(decision?'NO_EVIDENCE':'UNAVAILABLE'),contextSeal:flow.seal??(decision?'NO_EVIDENCE':'UNAVAILABLE'),
    });
    if(rows.length>=MAX_CANDIDATES)break;
  }
  return rows;
}
function edgeRow(row,evidenceClass,index){return{
  id:text(row?.edgeId??('edge:'+index)),edgeId:text(row?.edgeId),providerId:text(row?.providerId),owner:text(row?.owner),sourceKind:text(row?.sourceKind),edgeMeaning:text(row?.edgeMeaning),
  fromEntityId:text(row?.fromEntityId,240),toEntityId:text(row?.toEntityId,240),temporalStatus:text(row?.temporalStatus),authorityClass:text(row?.authorityClass),
  sourceRevisionRefs:uniq(row?.sourceRevisionRefs),identityRevisionRefs:uniq(row?.identityRevisionRefs),dependencyRevisionRefs:uniq(row?.dependencyRevisionRefs),
  evidenceRefs:uniq(row?.evidenceRefs),claimRefs:uniq(row?.claimRefs),eventRefs:uniq(row?.eventRefs),relationshipRefs:uniq(row?.relationshipRefs),
  artifactRef:row?.artifactRef?{artifactId:text(row.artifactRef.artifactId,240),artifactType:text(row.artifactRef.artifactType),revision:row.artifactRef.revision??null}:null,
  distance:Number(row?.distance??0),traversalPath:arr(row?.traversalPath).slice(0,8).map(step=>({providerId:text(step?.providerId),owner:text(step?.owner),edgeId:text(step?.edgeId),edgeMeaning:text(step?.edgeMeaning),fromEntityId:text(step?.fromEntityId,240),toEntityId:text(step?.toEntityId,240),temporalStatus:text(step?.temporalStatus)})),
  drillbackRefs:arr(row?.drillbackRefs).slice(0,16).map(safeDrillback),evidenceClass,readOnly:true,
};}
function ownerRows(edges){
  const map=new Map();
  for(const edge of edges){
    const key=(edge.owner??'UNKNOWN')+'|'+(edge.providerId??'UNKNOWN'),prior=map.get(key)??{owner:edge.owner??'UNKNOWN',providerId:edge.providerId??'UNKNOWN',edgeCount:0,edgeMeanings:[],temporalStatuses:[],sourceKinds:[]};
    prior.edgeCount++;prior.edgeMeanings=uniq([...prior.edgeMeanings,edge.edgeMeaning],16);prior.temporalStatuses=uniq([...prior.temporalStatuses,edge.temporalStatus],8);prior.sourceKinds=uniq([...prior.sourceKinds,edge.sourceKind],8);map.set(key,prior);
  }
  return [...map.values()].slice(0,MAX_OWNERS);
}
function staleRows(rows,evidenceClass){return arr(rows).slice(0,MAX_STALE).map(row=>({providerId:text(row?.providerId),edgeId:text(row?.edgeId),reason:text(row?.reason??row?.staleReason,180),sourceRevisionRefs:uniq(row?.sourceRevisionRefs),identityRevisionRefs:uniq(row?.identityRevisionRefs),evidenceClass}));}
function safeDrillback(row){return{kind:text(row?.kind),sourceId:text(row?.sourceId,240),sourceRevisionId:text(row?.sourceRevisionId,240),lorebookId:text(row?.lorebookId,240),uid:text(row?.uid,240),sceneId:text(row?.sceneId,240),representationRef:text(row?.representationRef,240),sourceRevisionRefs:uniq(row?.sourceRevisionRefs),artifactRef:row?.artifactRef?{artifactId:text(row.artifactRef.artifactId,240),artifactType:text(row.artifactRef.artifactType),revision:row.artifactRef.revision??null}:null};}
function boundedFence(fence){return fence?{worldRevision:fence.worldRevision??null,sceneRevision:fence.sceneRevision??null,sourceRevisionSet:uniq(fence.sourceRevisionSet)}:null;}
function reader(bindings,names){for(const name of names)if(typeof bindings?.[name]==='function')return bindings[name].bind(bindings);return null;}
function normalizeSelection(value={}){return{chatId:value?.chatId??null,turnId:value?.turnId??null,generationId:value?.generationId??null,correlationId:value?.correlationId??null,worldRevision:value?.worldRevision??null,sceneRevision:value?.sceneRevision??null,sourceRevisionRefs:uniq(value?.sourceRevisionRefs,64)};}
function safeRead(fn,selection,label,errors,{requireIdentity=false,allowMissingIdentity=false}={}){
  if(!fn)return null;
  try{
    const value=fn(selection);if(value==null)return null;
    for(const key of ['chatId','turnId','generationId','correlationId']){
      const expected=selection?.[key],actual=value?.[key]??value?.selection?.[key];
      if(expected==null)continue;
      if(actual==null){if(requireIdentity&&!allowMissingIdentity){const e=new Error(label+' did not publish '+key+' identity');e.code='GRAPH_UI_IDENTITY_MISSING';throw e;}continue;}
      if(String(actual)!==String(expected)){const e=new Error(label+' belongs to '+key+' '+actual+', not selected '+expected);e.code='GRAPH_UI_IDENTITY_MISMATCH';throw e;}
    }
    return clone(value);
  }catch(error){errors.push({stage:label,code:error?.code??'GRAPH_UI_READ_FAILED',message:text(error?.message??error,320)});return null;}
}
function safeDecision(adapter,selection,errors){if(!adapter?.read)return null;try{return clone(adapter.read(selection));}catch(error){errors.push({stage:'BrainDecisionVisibility',code:error?.code??'GRAPH_UI_DECISION_READ_FAILED',message:text(error?.message??error,320)});return null;}}
function emptyModel(selection,state,reason,capabilities,errors=[]){return freeze({kind:'SelectedTurnGraphVisibilityReadModel',contractVersion:SELECTED_TURN_GRAPH_VISIBILITY_VERSION,selection,state,reason,capabilities,generationTraversal:null,worldReferenceRead:null,owners:[],relationships:[],referenceEdges:[],staleRejected:[],candidates:[],summary:{ownerCount:0,traversedEdgeCount:0,relationshipRows:0,referenceEdgeCount:0,nominatedGraphCandidates:0,candidateBusGraphCandidates:0,staleRejected:0,truthProven:0,gatherProven:0,sealProven:0},errors:clone(errors),safety:{metadataOnly:true,rawPrompt:false,rawLoreBodies:false,rawMemoryBodies:false,hiddenReasoning:false,mutationAuthority:false,truthAuthority:false,settlementAuthority:false,contextSealAuthority:false}});}
function zero(doc,message){return element(doc,'p',{className:'nexus-muted',text:message});}
function stateToken(state){if(state==='READY')return'ready';if(state==='DEGRADED')return'warning';if(state==='ZERO_WORK')return'observed';return'historical';}
function progressToken(value){return value==='PROVEN'?'ready':value==='NO_EVIDENCE'?'historical':'warning';}
