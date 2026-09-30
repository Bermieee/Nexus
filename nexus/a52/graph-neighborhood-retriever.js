import {AuthorityClass,KnowledgeStatus} from './contracts.js';
import {
  CandidateFreshness,CandidateTruthStatus,RetrievalChannelCapability,RetrievalChannelHealth,
  createChannelNomination,createRetrievalChannelDescriptor,
} from './candidate-bus-contracts.js';
import {
  KnowledgeAuthorityOrigin,KnowledgeSourceClass,KnowledgeTemporalStatus,createKnowledgeEvidence,normalizeKnowledgeAuthority,
} from './knowledge-evidence.js';
import {stableHash} from './browser-runtime-utils.js';

const clone=(value)=>value==null?value:structuredClone(value);
const uniq=(values)=>[...new Set((values??[]).filter(Boolean).map(String))].sort();
const now=()=>globalThis.performance?.now?.()??Date.now();
const clampInt=(value,fallback,min,max)=>Math.max(min,Math.min(max,Number.isInteger(Number(value))?Number(value):fallback));
const statusSet=new Set(Object.values(CandidateTruthStatus));
const currentish=new Set([KnowledgeStatus.CURRENT,KnowledgeStatus.UNRESOLVED,KnowledgeStatus.UNCERTAIN,KnowledgeStatus.CONTRADICTED]);
const historicalish=new Set([KnowledgeStatus.CURRENT,KnowledgeStatus.HISTORICAL,KnowledgeStatus.SUPERSEDED]);
const currentSupport=new Set([KnowledgeStatus.CURRENT,KnowledgeStatus.HISTORICAL,KnowledgeStatus.UNRESOLVED,KnowledgeStatus.UNCERTAIN,KnowledgeStatus.CONTRADICTED]);
const contradictionish=new Set([KnowledgeStatus.CONTRADICTED,KnowledgeStatus.UNRESOLVED,KnowledgeStatus.UNCERTAIN]);
function status(value){const x=String(value??KnowledgeStatus.UNRESOLVED).toUpperCase();return statusSet.has(x)?x:KnowledgeStatus.UNRESOLVED;}
function eligibleForIntent(edgeStatus,intentKind){
  const kind=String(intentKind??'CURRENT').toUpperCase(),value=status(edgeStatus);
  if(kind==='CURRENT')return currentSupport.has(value);
  if(kind==='HISTORICAL')return historicalish.has(value);
  if(kind==='CONTRADICTION')return contradictionish.has(value);
  return true;
}
function sourceClassFor(owner){
  const x=String(owner??'').toUpperCase();
  if(x.includes('LORE'))return KnowledgeSourceClass.DERIVED_REPRESENTATION;
  if(x.includes('MEMORY'))return KnowledgeSourceClass.EPISODIC_MEMORY;
  if(x.includes('SCENE'))return KnowledgeSourceClass.RETRIEVAL_CANDIDATE;
  if(x.includes('TEMPORAL'))return KnowledgeSourceClass.TEMPORAL_STATE;
  return KnowledgeSourceClass.RETRIEVAL_CANDIDATE;
}
function evidenceAuthority(edge){
  const authority=normalizeKnowledgeAuthority(edge.authorityClass);
  const sourceClass=sourceClassFor(edge.owner);
  if(sourceClass===KnowledgeSourceClass.DERIVED_REPRESENTATION&&[
    AuthorityClass.SOURCE_CANON,AuthorityClass.OBSERVED,AuthorityClass.SETTLED,AuthorityClass.OPERATOR,
  ].includes(authority))return AuthorityClass.INFERRED;
  return authority;
}
function authorityOrigin(edge,authority){
  if(edge.sourceKind==='LORE_GRAPH')return KnowledgeAuthorityOrigin.INFERENCE;
  if(authority===AuthorityClass.INFERRED||authority===AuthorityClass.UNRESOLVED)return KnowledgeAuthorityOrigin.INFERENCE;
  if(authority===AuthorityClass.SETTLED)return KnowledgeAuthorityOrigin.CARRIED;
  if(authority===AuthorityClass.OBSERVED||authority===AuthorityClass.SOURCE_CANON)return KnowledgeAuthorityOrigin.CARRIED;
  return KnowledgeAuthorityOrigin.INFERENCE;
}
function temporalStatus(value){
  const x=status(value);
  return Object.values(KnowledgeTemporalStatus).includes(x)?x:KnowledgeTemporalStatus.UNRESOLVED;
}
function edgeText(edge){
  if(edge.representationText)return String(edge.representationText).slice(0,1200);
  return [edge.fromEntityId,edge.edgeMeaning,edge.toEntityId,'['+status(edge.temporalStatus)+']'].filter(Boolean).join(' ');
}
function edgeIdentity(edge){return edge.evidenceIdentity??(edge.claimRefs?.length?('claim:'+edge.claimRefs[0]):('graph-edge:'+edge.providerId+':'+edge.edgeId));}
function artifactRef(edge){return clone(edge.artifactRef??{artifactId:edge.edgeId,artifactType:edge.artifactType??'GraphEdge',revision:edge.artifactRevision??1});}
function providerBalancedEdges(rows=[]){
  const groups=new Map();
  for(const edge of rows){
    const provider=String(edge?.providerId??'UNKNOWN');
    const list=groups.get(provider)??[];list.push(edge);groups.set(provider,list);
  }
  for(const list of groups.values())list.sort((a,b)=>String(a.edgeId).localeCompare(String(b.edgeId)));
  const providers=[...groups.keys()].sort(),out=[];
  let remaining=true;
  while(remaining){
    remaining=false;
    for(const provider of providers){
      const list=groups.get(provider);
      if(list?.length){out.push(list.shift());remaining=true;}
    }
  }
  return out;
}

export class NativeGraphNeighborhoodRetriever{
  constructor({temporalGraph,entityRegistry,sceneSnapshot=null,isSourceRevisionCurrent=null,sourceStoryOf=null,evidenceSink=null,limits={}}={}){
    if(!temporalGraph)throw new TypeError('NativeGraphNeighborhoodRetriever requires temporalGraph');
    this.temporalGraph=temporalGraph;this.entityRegistry=entityRegistry??null;this.sceneSnapshot=typeof sceneSnapshot==='function'?sceneSnapshot:()=>null;
    this.isSourceRevisionCurrent=typeof isSourceRevisionCurrent==='function'?isSourceRevisionCurrent:()=>true;
    this.evidenceSink=typeof evidenceSink==='function'?evidenceSink:()=>{};
    // Story isolation: resolves a source revision to the story (chat) that produced it, or null when unknown/global.
    this.sourceStoryOf=typeof sourceStoryOf==='function'?sourceStoryOf:()=>null;
    this.requestStoryId=null;
    this.limits={
      maxDepth:clampInt(limits.maxDepth,3,1,6),maxNodes:clampInt(limits.maxNodes,96,1,1024),
      maxEdges:clampInt(limits.maxEdges,192,1,4096),maxCandidates:clampInt(limits.maxCandidates,64,1,512),
      latencyBudgetMs:Math.max(0,Number(limits.latencyBudgetMs??15)||0),maxProviders:clampInt(limits.maxProviders,12,1,64),
    };
    this.providers=new Map();this.lastReceipt=null;this.receipts=[];
    this.descriptor=createRetrievalChannelDescriptor({
      channelId:'ZZ_NATIVE_GRAPH_WALKER',
      capabilities:[RetrievalChannelCapability.GRAPH,RetrievalChannelCapability.WORLD_STATE],
      supportedIntentKinds:['*'],maxCandidates:this.limits.maxCandidates,health:RetrievalChannelHealth.HEALTHY,available:true,
      metadata:{source:'CORE_GRAPH_WALKER',providerNeutral:true,graphMutationAuthority:false,truthAuthority:false,ownerRevisionFence:false,validatedExternalRevisionProvider:true},
    });
  }

  registerProvider({providerId,owner,query,isRevisionCurrent=null,semanticsVersion='1.0.0',metadata={}}={}){
    const id=String(providerId??'').trim();if(!id)throw new TypeError('graph providerId is required');
    if(typeof query!=='function')throw new TypeError('graph provider requires query(request)');
    if(this.providers.has(id))throw new Error('GRAPH_PROVIDER_ALREADY_REGISTERED:'+id);
    this.providers.set(id,{providerId:id,owner:String(owner??id),query,isRevisionCurrent:typeof isRevisionCurrent==='function'?isRevisionCurrent:null,semanticsVersion:String(semanticsVersion),metadata:clone(metadata)});
    return this.providerContract(id);
  }

  unregisterProvider(providerId){const id=String(providerId),row=this.providers.get(id);if(!row)return null;this.providers.delete(id);return{providerId:id,unregistered:true};}
  providerContract(providerId){const row=this.providers.get(String(providerId));return row?{kind:'CoreGraphProviderContract',contractVersion:'1.0.0',providerId:row.providerId,owner:row.owner,semanticsVersion:row.semanticsVersion,requiresBoundedQuery:true,requiresRevisionValidation:true,graphMutationAuthority:false,truthAuthority:false,settlementAuthority:false,contextSealAuthority:false}:null;}
  listProviders(){return [...this.providers.keys()].sort().map(id=>this.providerContract(id));}

  ownerInterfaceContract(){
    return clone({
      kind:'CoreGraphProviderInterfaceContract',contractVersion:'1.0.0',channelId:'ZZ_NATIVE_GRAPH_WALKER',
      registration:{required:['providerId','owner','query'],optional:['isRevisionCurrent','semanticsVersion','metadata'],queryExecution:'SYNC_FOREGROUND_BOUNDED'},
      request:{
        kind:'CoreGraphQueryRequest',
        fields:['query','intentKind','anchorEntityIds','allowedEdgeMeanings','maxDepth','maxNodes','maxEdges','maxCandidates','latencyBudgetMs','worldRevision','sceneRevision','sourceRevisionSet','perspective'],
        bounded:true,graphMutationAuthority:false,truthAuthority:false,settlementAuthority:false,
      },
      response:{
        shapes:['GraphEdge[]','{providerRevision?,edges:GraphEdge[]}'],
        edgeRequired:['from/fromEntityId','to/toEntityId','edgeMeaning/predicate','sourceRevisionRefs'],
        edgePreserved:['edgeId','sourceKind','temporalStatus','temporal','authorityClass','identityRevisionRefs','dependencyRevisionRefs','provenanceRefs','evidenceRefs','claimRefs','eventRefs','relationshipRefs','artifactRef','artifactRevision','worldRevision','sceneRevision','providerRevision','representationRef','drillbackRefs','perspective','hardRule'],
        revisionRules:{sourceRevisionRefsRequired:true,identityRevisionRefsValidatedWhenPresent:true,dependenciesMustBeCurrent:true,worldFenceCheckedWhenPresent:true,sceneFenceCheckedWhenPresent:true,staleRejectedBeforeCandidateBus:true},
        provenanceRules:{sourceRevisionRefsAreAlwaysCarriedAsProvenance:true,traversalPathAddedByCore:true,providerAndOwnerIdentityPreserved:true},
      },
      authority:{providerOwnsSourceSemantics:true,coreOwnsTraversal:true,graphMutation:false,truth:false,settlement:false,contextSeal:false,identitySettlement:false},
      lifecycle:{providerFunctionsPersistedByCore:false,reattachProviderAfterBrainRestore:true,optionalCoprocessorMayWrapSameContract:true,nativeForegroundPathRequiresNoCoprocessor:true},
    });
  }

  referenceSet(intent,context={}){
    const started=now(),request=this.#request(intent,context),edges=[],providerDiagnostics=[],staleEdges=[];
    if(request.anchorEntityIds.length)edges.push(...this.#temporalEdges(request),...this.#sceneEdges(request));
    for(const provider of [...this.providers.values()].sort((a,b)=>a.providerId.localeCompare(b.providerId)).slice(0,this.limits.maxProviders)){
      if(!request.anchorEntityIds.length){providerDiagnostics.push({providerId:provider.providerId,status:'SKIPPED_NO_ENTITY_ANCHORS',edgeCount:0});continue;}
      // Every registered synchronous owner query is count-bounded. Elapsed time
      // is diagnostic: an earlier owner must not erase later owners' consideration.
      if(request.latencyBudgetMs===0){providerDiagnostics.push({providerId:provider.providerId,status:'SKIPPED_LATENCY_BUDGET',edgeCount:0});continue;}
      try{
        const value=provider.query(clone({...request,kind:'CoreGraphQueryRequest',contractVersion:'1.0.0',graphMutationAuthority:false,truthAuthority:false,settlementAuthority:false}));
        if(value&&typeof value.then==='function')throw new Error('GRAPH_PROVIDER_ASYNC_UNSUPPORTED_IN_SYNC_FOREGROUND');
        const rows=Array.isArray(value)?value:(value?.edges??[]);
        let admitted=0,rejected=0;
        for(const raw of rows.slice(0,request.maxEdges)){
          const normalized=this.#externalEdge({...raw,providerRevision:raw?.providerRevision??value?.providerRevision??null},provider,request);
          if(normalized.stale){staleEdges.push({providerId:provider.providerId,edgeId:normalized.edgeId,sourceRevisionRefs:normalized.sourceRevisionRefs,identityRevisionRefs:normalized.identityRevisionRefs,reason:normalized.staleReason});rejected++;continue;}
          edges.push(normalized);admitted++;
        }
        providerDiagnostics.push({providerId:provider.providerId,status:'OK',edgeCount:admitted,rejectedStale:rejected,providerRevision:value?.providerRevision??null});
      }catch(error){providerDiagnostics.push({providerId:provider.providerId,status:'DEGRADED',edgeCount:0,error:String(error?.message??error)});}
    }
    const traversed=this.#walk(edges,request,started);
    const entityIds=uniq(traversed.rows.flatMap(row=>[row.edge.fromEntityId,row.edge.toEntityId]));
    const identityReferences=this.entityRegistry?.readReferences?.(entityIds,{limit:Math.min(128,request.maxNodes)})?.references??[];
    const temporalReferences=this.temporalGraph?.readReferences?.({entityIds,limit:Math.min(128,request.maxEdges)})?.references??[];
    return clone({
      kind:'StructuredWorldStateReferenceSet',contractVersion:'1.0.0',
      intentId:intent?.intentId??null,query:request.query,intentKind:request.intentKind,anchorEntityIds:[...request.anchorEntityIds],
      revisionFence:{worldRevision:request.worldRevision,sceneRevision:request.sceneRevision,sourceRevisionSet:[...request.sourceRevisionSet]},
      edges:traversed.rows.slice(0,request.maxCandidates).map(row=>this.#referenceEdge(row)),
      identityReferences,temporalReferences,
      providers:providerDiagnostics,staleRejected:staleEdges.slice(0,32),
      boundedOut:{edges:traversed.boundedEdges,nodes:traversed.boundedNodes,candidates:traversed.boundedCandidates},
      limits:{maxDepth:request.maxDepth,maxNodes:request.maxNodes,maxEdges:request.maxEdges,maxCandidates:request.maxCandidates,latencyBudgetMs:request.latencyBudgetMs},
      authority:{graphMutation:false,truth:false,settlement:false,contextSeal:false,identitySettlement:false},
      readOnly:true,rawSourceContentIncluded:false,
    });
  }

  retrieve(intent,context={}){
    const started=now(),request=this.#request(intent,context),edges=[],providerDiagnostics=[],staleEdges=[],trustedSourceRevisionRefs=[];
    if(request.anchorEntityIds.length)edges.push(...this.#temporalEdges(request),...this.#sceneEdges(request));
    for(const provider of [...this.providers.values()].sort((a,b)=>a.providerId.localeCompare(b.providerId)).slice(0,this.limits.maxProviders)){
      if(!request.anchorEntityIds.length){providerDiagnostics.push({providerId:provider.providerId,status:'SKIPPED_NO_ENTITY_ANCHORS',edgeCount:0});continue;}
      // Every registered synchronous owner query is count-bounded. Elapsed time
      // is diagnostic: an earlier owner must not erase later owners' consideration.
      if(request.latencyBudgetMs===0){providerDiagnostics.push({providerId:provider.providerId,status:'SKIPPED_LATENCY_BUDGET',edgeCount:0});continue;}
      try{
        const value=provider.query(clone({...request,kind:'CoreGraphQueryRequest',contractVersion:'1.0.0',graphMutationAuthority:false,truthAuthority:false,settlementAuthority:false}));
        if(value&&typeof value.then==='function')throw new Error('GRAPH_PROVIDER_ASYNC_UNSUPPORTED_IN_SYNC_FOREGROUND');
        const rows=Array.isArray(value)?value:(value?.edges??[]);
        let admitted=0,rejected=0;
        for(const raw of rows.slice(0,request.maxEdges)){
          const normalized=this.#externalEdge({...raw,providerRevision:raw?.providerRevision??value?.providerRevision??null},provider,request);
          if(normalized.stale){staleEdges.push({providerId:provider.providerId,edgeId:normalized.edgeId,sourceRevisionRefs:normalized.sourceRevisionRefs,reason:normalized.staleReason});rejected++;continue;}
          edges.push(normalized);admitted++;
        }
        providerDiagnostics.push({providerId:provider.providerId,status:'OK',edgeCount:admitted,rejectedStale:rejected,providerRevision:value?.providerRevision??null});
      }catch(error){providerDiagnostics.push({providerId:provider.providerId,status:'DEGRADED',edgeCount:0,error:String(error?.message??error)});}
    }

    const traversed=this.#walk(edges,request,started);
    const nominations=[];
    for(const row of traversed.rows){
      const edge=row.edge,authority=evidenceAuthority(edge),temporal=status(edge.temporalStatus),identity=edgeIdentity(edge);
      let knowledgeEvidenceId=null;
      if(!(edge.claimRefs??[]).length){
        knowledgeEvidenceId='graph-evidence:'+stableHash({providerId:edge.providerId,edgeId:edge.edgeId,sourceRevisionRefs:edge.sourceRevisionRefs,temporal},{length:24});
        const origin=authorityOrigin(edge,authority),sourceClass=sourceClassFor(edge.owner);
        const evidence=createKnowledgeEvidence({
          evidenceId:knowledgeEvidenceId,evidenceIdentity:identity,artifactRef:artifactRef(edge),sourceClass,
          authorityClass:authority,authorityOrigin:origin,sourceAuthorityClass:origin===KnowledgeAuthorityOrigin.CARRIED?authority:null,
          temporalStatus:temporalStatus(temporal),sourceRevisionRefs:edge.sourceRevisionRefs,dependencyRevisionRefs:uniq([...(edge.dependencyRevisionRefs??[]),...(edge.identityRevisionRefs??[])]),
          provenanceRefs:uniq([...edge.provenanceRefs,...edge.sourceRevisionRefs]),claimIds:edge.claimRefs,
          semantic:{subjectId:edge.fromEntityId,predicate:edge.edgeMeaning,value:edge.toEntityId,status:temporal},
          hardRule:Boolean(edge.hardRule),
          extensions:{representationText:edgeText(edge),graphProvider:edge.providerId,graphOwner:edge.owner,edgeMeaning:edge.edgeMeaning,traversalPath:clone(row.path),sourceKind:edge.sourceKind,identityResolution:clone(edge.identityResolution),identityRevisionRefs:[...(edge.identityRevisionRefs??[])],drillbackRefs:clone(edge.drillbackRefs??[]),ownerSourceAuthorityClass:normalizeKnowledgeAuthority(edge.authorityClass)},
        });
        this.evidenceSink(evidence);
      }
      nominations.push(createChannelNomination({
        nominationId:'ZZ_NATIVE_GRAPH_WALKER:'+intent.intentId+':'+edge.providerId+':'+edge.edgeId,
        channelId:'ZZ_NATIVE_GRAPH_WALKER',candidateId:'candidate:graph:'+stableHash(identity,{length:24,alreadyString:true}),evidenceIdentity:identity,
        artifactRef:artifactRef(edge),artifactRevision:edge.artifactRevision??1,sourceRevisionRefs:edge.sourceRevisionRefs,identityRevisionRefs:edge.identityRevisionRefs??[],
        claimRefs:edge.claimRefs,eventRefs:edge.eventRefs,entityRefs:uniq([edge.fromEntityId,edge.toEntityId]),relationshipRefs:edge.relationshipRefs,
        retrievalIntentIds:[intent.intentId],rankSignals:{graphDistance:1/Math.max(1,row.distance),graphProviderWeight:Number(edge.providerWeight??1)},
        normalizedRank:Math.max(0,Math.min(1,1/(1+Math.max(0,row.distance-1)))),
        graphMetadata:{
          graphProvider:edge.providerId,graphOwner:edge.owner,sourceKind:edge.sourceKind,edgeMeaning:edge.edgeMeaning,
          edgeId:edge.edgeId,fromEntityId:edge.fromEntityId,toEntityId:edge.toEntityId,distance:row.distance,traversalPath:clone(row.path),temporalStatus:temporal,
          revisionFence:{sourceRevisionRefs:[...edge.sourceRevisionRefs],identityRevisionRefs:[...(edge.identityRevisionRefs??[])],dependencyRevisionRefs:[...edge.dependencyRevisionRefs],worldRevision:edge.worldRevision,sceneRevision:edge.sceneRevision,providerRevision:edge.providerRevision??null},
          identityResolution:clone(edge.identityResolution),semanticsVersion:edge.semanticsVersion??'1.0.0',drillbackRefs:clone(edge.drillbackRefs??[]),ownerSourceAuthorityClass:normalizeKnowledgeAuthority(edge.authorityClass),
        },
        temporalHints:[{status:temporal,temporal:clone(edge.temporal??null),perspective:clone(edge.perspective??null)}],
        authorityClass:authority,truthStatusHint:temporal,provenance:uniq(edge.provenanceRefs).map(ref=>({ref})),
        evidenceRefs:uniq([...(edge.evidenceRefs??[]),knowledgeEvidenceId]),dependencyRevisions:edge.dependencyRevisionRefs,
        freshness:CandidateFreshness.FRESH,representationRef:edge.representationRef??edge.edgeId,representationRevision:edge.representationRevision??edge.artifactRevision??1,
        representationText:edgeText(edge),metadata:{knowledgeEvidenceId,graphProvider:edge.providerId,graphOwner:edge.owner,sourceKind:edge.sourceKind,edgeMeaning:edge.edgeMeaning,identityResolution:clone(edge.identityResolution),legacyRetrievalIntent:'graph'},
        worldRevision:null,sceneRevision:null,
      }));
    }
    trustedSourceRevisionRefs.push(...traversed.rows.filter(row=>!['CORE_TEMPORAL_STATE','SCENE_OWNER'].includes(row.edge.providerId)).flatMap(row=>row.edge.sourceRevisionRefs));
    const hotNeighborhood=traversed.rows.slice(0,request.maxCandidates).map(row=>({
      ref:String(row.edge.providerId)+'|'+String(row.edge.edgeId),
      providerId:String(row.edge.providerId),owner:String(row.edge.owner),edgeId:String(row.edge.edgeId),
      sourceKind:String(row.edge.sourceKind),temporalStatus:status(row.edge.temporalStatus),
      sourceRevisionRefs:uniq(row.edge.sourceRevisionRefs??[]),identityRevisionRefs:uniq(row.edge.identityRevisionRefs??[]),
      dependencyRevisionRefs:uniq(row.edge.dependencyRevisionRefs??[]),
    }));
    const elapsedMs=Math.max(0,now()-started);
    this.lastReceipt={
      kind:'GraphTraversalReceipt',contractVersion:'1.0.0',intentId:intent.intentId,query:request.query,anchorEntityIds:[...request.anchorEntityIds],
      providers:providerDiagnostics,providerCount:providerDiagnostics.length+2,examinedEdgeCount:traversed.examinedEdgeCount,
      traversedEdgeCount:traversed.rows.length,visitedNodeCount:traversed.visitedNodeCount,nominationCount:nominations.length,
      staleRejectedCount:staleEdges.length,staleRejected:staleEdges.slice(0,32),trustedSourceRevisionRefs:uniq(trustedSourceRevisionRefs),
      hotNeighborhoodRefs:hotNeighborhood.map(row=>row.ref),
      hotNeighborhoodSourceRevisionRefs:uniq(hotNeighborhood.flatMap(row=>row.sourceRevisionRefs)),
      hotNeighborhoodIdentityRevisionRefs:uniq(hotNeighborhood.flatMap(row=>row.identityRevisionRefs)),
      hotNeighborhoodDependencyRevisionRefs:uniq(hotNeighborhood.flatMap(row=>row.dependencyRevisionRefs)),
      hotNeighborhoodSummary:hotNeighborhood,
      referenceSummary:traversed.rows.slice(0,32).map(row=>this.#referenceEdge(row)),
      boundedOut:{edges:traversed.boundedEdges,nodes:traversed.boundedNodes,candidates:traversed.boundedCandidates},
      limits:{maxDepth:request.maxDepth,maxNodes:request.maxNodes,maxEdges:request.maxEdges,maxCandidates:request.maxCandidates,latencyBudgetMs:request.latencyBudgetMs},
      noWorkReason:!request.anchorEntityIds.length?'NO_ENTITY_ANCHORS':nominations.length?null:'NO_MATCHING_EDGES',
      budgetPolicy:'COUNT_BOUNDED_OWNER_FAIR',
      elapsedMs,latencyBudgetExceeded:elapsedMs>=request.latencyBudgetMs&&request.latencyBudgetMs>=0,
      authority:{graphMutation:false,truth:false,settlement:false,contextSeal:false},
    };
    this.receipts.push(clone(this.lastReceipt));while(this.receipts.length>128)this.receipts.shift();
    return nominations;
  }

  diagnostics(){return{kind:'NativeGraphNeighborhoodDiagnostics',providers:this.listProviders(),limits:clone(this.limits),lastReceipt:clone(this.lastReceipt),recentReceipts:clone(this.receipts),graphMutationAuthority:false};}

  #request(intent,context){
    const opts={...(context.graphTraversal??{}),...(intent?.metadata?.graphTraversal??{})};
    const maxDepth=clampInt(opts.maxDepth,this.limits.maxDepth,1,this.limits.maxDepth),maxNodes=clampInt(opts.maxNodes,this.limits.maxNodes,1,this.limits.maxNodes),maxEdges=clampInt(opts.maxEdges,this.limits.maxEdges,1,this.limits.maxEdges),maxCandidates=clampInt(opts.maxCandidates,this.limits.maxCandidates,1,this.limits.maxCandidates);
    this.requestStoryId=String(context.chatId??this.sceneSnapshot()?.chatNamespace??'')||null;
    const latencyBudgetMs=Math.max(0,Math.min(this.limits.latencyBudgetMs,Number(opts.latencyBudgetMs??context.latencyBudgetMs??this.limits.latencyBudgetMs)));
    return{
      chatId:String(context.chatId??this.sceneSnapshot()?.chatNamespace??'')||null,
      query:String(intent?.query??context.query??''),intentKind:String(intent?.intentKind??intent?.kind??'CURRENT').toUpperCase(),
      anchorEntityIds:uniq((intent?.entityRefs??context.anchorEntityIds??[]).map(ref=>{const n=this.#normalizeRef(ref,{providerId:'GRAPH_ANCHOR'});return n?.resolved?n.entityId:ref;})),allowedEdgeMeanings:uniq(opts.allowedEdgeMeanings??intent?.relationshipRefs??[]),
      maxDepth,maxNodes,maxEdges,maxCandidates,latencyBudgetMs,
      worldRevision:Number(context.worldRevision??0),sceneRevision:Number(context.sceneRevision??0),
      sourceRevisionSet:uniq(context.sourceRevisionSet??[]),perspective:clone(intent?.perspective??null),
    };
  }

  // A claim learned from another story's source revisions is never evidence here. Unknown provenance stays
  // visible (older/global claims); a revision that resolves to a different story hides the whole claim.
  #claimInStory(claim){
    const story=this.requestStoryId;if(!story)return true;
    for(const ref of claim.provenance?.sourceRevisionIds??[]){
      let owner=null;try{owner=this.sourceStoryOf(ref);}catch{owner=null;}
      if(owner&&String(owner)!==story)return false;
    }
    return true;
  }

  #temporalEdges(request){
    return this.temporalGraph.allClaims().filter(claim=>this.#claimInStory(claim)).map(claim=>{
      const from=this.#normalizeRef(claim.subjectId,{providerId:'CORE_TEMPORAL_STATE'});
      const rawTo=typeof claim.value==='string'?claim.value:null;
      const to=this.#normalizeRef(rawTo??{providerId:'CORE_TEMPORAL_STATE',sourceEntityId:'value:'+stableHash(claim.value,{length:12}),label:JSON.stringify(claim.value)},{providerId:'CORE_TEMPORAL_STATE'});
      // Temporal State Graph subject/value IDs are already Core-owned semantic identities.
      // The registry may canonicalize them when an explicit mapping exists, but an
      // unresolved registry lookup must not rewrite a native Core ID into a provider-local
      // namespace or it becomes unreachable from the original query anchor.
      const fromEntityId=from.resolved?from.entityId:String(claim.subjectId);
      const toEntityId=to.resolved?to.entityId:(rawTo!=null?String(rawTo):to.entityId);
      return{
        edgeId:'temporal:'+claim.id,providerId:'CORE_TEMPORAL_STATE',owner:'TEMPORAL_STATE_GRAPH',sourceKind:'TEMPORAL_STATE',
        fromEntityId,toEntityId,edgeMeaning:claim.predicate,temporalStatus:claim.status??KnowledgeStatus.UNRESOLVED,
        temporal:clone(claim.temporal),authorityClass:claim.authorityClass,sourceRevisionRefs:uniq(claim.provenance?.sourceRevisionIds??[]),identityRevisionRefs:uniq(claim.identityRevisionRefs??[]),
        dependencyRevisionRefs:uniq(claim.provenance?.invalidators??[]),provenanceRefs:uniq([claim.provenance?.id,...(claim.provenance?.sourceRevisionIds??[])]),
        evidenceRefs:uniq([claim.id,...(claim.provenance?.evidenceIds??[])]),claimRefs:[claim.id],eventRefs:[],relationshipRefs:[],
        artifactRef:{artifactId:claim.id,artifactType:'Claim',revision:1},artifactRevision:1,worldRevision:request.worldRevision,sceneRevision:request.sceneRevision,
        representationText:claim.subjectId+' '+claim.predicate+' '+JSON.stringify(claim.value),evidenceIdentity:'claim:'+claim.id,
        identityResolution:{from:from.state,to:to.state},semanticsVersion:'TEMPORAL_STATE_GRAPH_V1',
      };
    });
  }

  #sceneEdges(request){
    const snapshot=this.sceneSnapshot?.();if(!snapshot?.sceneId)return[];
    const rows=[],sceneId='scene:'+snapshot.sceneId,sourceRevisionRefs=uniq(snapshot.sourceRevisionRefs??[]);
    const identityRefs=(ids)=>uniq((ids??[]).map(id=>this.entityRegistry?.identityReference?.(id)?.revisionRef).filter(Boolean));
    const push=(edgeId,from,to,meaning,authority='OBSERVED',temporal='CURRENT',extra={})=>rows.push({
      edgeId,providerId:'SCENE_OWNER',owner:'SCENE_INTELLIGENCE',sourceKind:'SCENE_OBSERVATION',fromEntityId:from,toEntityId:to,edgeMeaning:meaning,
      temporalStatus:temporal,authorityClass:authority,sourceRevisionRefs,identityRevisionRefs:identityRefs([from,to]),dependencyRevisionRefs:sourceRevisionRefs,provenanceRefs:uniq(snapshot.provenanceRefs??[]),
      evidenceRefs:uniq(snapshot.provenanceRefs??[]),claimRefs:[],eventRefs:[],relationshipRefs:[],artifactRef:{artifactId:snapshot.snapshotId??sceneId,artifactType:'SceneUiReadModel',revision:snapshot.sceneRevision??1},
      artifactRevision:snapshot.sceneRevision??1,worldRevision:snapshot.worldRevision??request.worldRevision,sceneRevision:snapshot.sceneRevision??request.sceneRevision,
      identityResolution:{from:'SCENE_OWNER',to:'SCENE_OWNER'},semanticsVersion:'SCENE_OWNER_V1',...extra,
    });
    const loc=snapshot.segments?.LOCATION?.value??snapshot.location;
    if(loc!=null){const val=typeof loc==='object'?(loc.location??loc.name??loc.id??JSON.stringify(loc)):loc;push('scene-location:'+snapshot.sceneId+':'+snapshot.sceneRevision,sceneId,String(val),'SCENE_LOCATION',snapshot.segments?.LOCATION?.authorityClass??'OBSERVED');}
    for(const row of snapshot.segments?.ACTIVE_CAST?.value??[]){const ref=this.#normalizeRef(row,{providerId:'SCENE'});push('scene-cast:'+snapshot.sceneId+':'+ref.entityId,ref.entityId,sceneId,'PRESENT_IN_SCENE',row.authorityClass??'OBSERVED','CURRENT',{identityResolution:{from:ref.state,to:'SCENE_OWNER'}});}
    for(const row of snapshot.segments?.ACTIVE_ENTITIES?.value??[]){const ref=this.#normalizeRef(row,{providerId:'SCENE'});push('scene-object:'+snapshot.sceneId+':'+ref.entityId,sceneId,ref.entityId,'OBJECT_PRESENT',row.authorityClass??'OBSERVED','CURRENT',{identityResolution:{from:'SCENE_OWNER',to:ref.state}});}
    return rows;
  }

  #externalEdge(raw,provider,request){
    const from=this.#normalizeRef(raw?.from??raw?.subject??raw?.sourceEntity??raw?.fromEntityId,{providerId:provider.providerId,worldId:raw?.worldId,entityType:raw?.fromType});
    const to=this.#normalizeRef(raw?.to??raw?.object??raw?.targetEntity??raw?.toEntityId,{providerId:provider.providerId,worldId:raw?.worldId,entityType:raw?.toType});
    const refs=uniq(raw?.sourceRevisionRefs??raw?.revisionFence?.sourceRevisionRefs??[]),identityRefs=uniq(raw?.identityRevisionRefs??raw?.revisionFence?.identityRevisionRefs??[]),deps=uniq(raw?.dependencyRevisionRefs??raw?.revisionFence?.dependencyRevisionRefs??[]);
    let stale=false,staleReason=null;
    if(!refs.length){stale=true;staleReason='OWNER_GRAPH_SOURCE_REVISION_REQUIRED';}
    else for(const ref of [...refs,...deps]){
      let current=false;
      try{current=provider.isRevisionCurrent?provider.isRevisionCurrent(ref)===true:this.isSourceRevisionCurrent(ref)===true;}catch{}
      if(!current){stale=true;staleReason=refs.includes(ref)?'OWNER_GRAPH_SOURCE_REVISION_STALE':'OWNER_GRAPH_DEPENDENCY_REVISION_STALE';break;}
    }
    if(!stale&&identityRefs.some(ref=>this.entityRegistry?.isCurrentRevisionRef?.(ref)===false)){stale=true;staleReason='OWNER_GRAPH_IDENTITY_REVISION_STALE';}
    if(!stale&&raw?.worldRevision!=null&&Number(raw.worldRevision)!==Number(request.worldRevision)){stale=true;staleReason='OWNER_GRAPH_WORLD_REVISION_STALE';}
    if(!stale&&raw?.sceneRevision!=null&&Number(raw.sceneRevision)!==Number(request.sceneRevision)){stale=true;staleReason='OWNER_GRAPH_SCENE_REVISION_STALE';}
    return{
      edgeId:String(raw?.edgeId??raw?.id??stableHash({provider:provider.providerId,from:from.entityId,to:to.entityId,meaning:raw?.edgeMeaning??raw?.predicate,refs},{length:20})),
      providerId:provider.providerId,owner:provider.owner,sourceKind:String(raw?.sourceKind??provider.metadata?.sourceKind??'OWNER_GRAPH'),
      fromEntityId:from.entityId,toEntityId:to.entityId,edgeMeaning:String(raw?.edgeMeaning??raw?.predicate??raw?.relationshipType??'RELATED_TO'),
      temporalStatus:status(raw?.temporalStatus??raw?.status),temporal:clone(raw?.temporal??null),authorityClass:raw?.authorityClass??AuthorityClass.UNRESOLVED,
      sourceRevisionRefs:refs,identityRevisionRefs:identityRefs,dependencyRevisionRefs:deps,provenanceRefs:uniq([...(raw?.provenanceRefs??raw?.provenance?.map?.(x=>typeof x==='string'?x:x?.ref??x?.id)??[]),...refs]),
      evidenceRefs:uniq(raw?.evidenceRefs??[]),claimRefs:uniq(raw?.claimRefs??[]),eventRefs:uniq(raw?.eventRefs??[]),relationshipRefs:uniq(raw?.relationshipRefs??[]),
      artifactRef:artifactRef(raw),artifactRevision:raw?.artifactRevision??raw?.artifactRef?.revision??1,worldRevision:raw?.worldRevision??request.worldRevision,sceneRevision:raw?.sceneRevision??request.sceneRevision,
      providerRevision:raw?.providerRevision??null,representationText:raw?.representationText??null,representationRef:raw?.representationRef??null,representationRevision:raw?.representationRevision??null,
      evidenceIdentity:raw?.evidenceIdentity??null,perspective:clone(raw?.perspective??null),drillbackRefs:clone(raw?.drillbackRefs??[]).slice(0,32),hardRule:Boolean(raw?.hardRule),providerWeight:Number(raw?.providerWeight??1),
      identityResolution:{from:from.state,to:to.state,fromCandidateEntityIds:from.candidateEntityIds??[],toCandidateEntityIds:to.candidateEntityIds??[]},
      semanticsVersion:provider.semanticsVersion,stale,staleReason,
    };
  }

  #normalizeRef(ref,options){return this.entityRegistry?.normalizeRef?.(ref,{...options,storyId:options?.storyId??this.requestStoryId})??{entityId:typeof ref==='string'?ref:String(ref?.entityId??ref?.id??ref?.ref??''),resolved:false,state:'IDENTITY_REGISTRY_UNAVAILABLE'};}

  #referenceEdge(row){
    const edge=row.edge;
    return {
      providerId:edge.providerId,owner:edge.owner,sourceKind:edge.sourceKind,edgeId:edge.edgeId,
      fromEntityId:edge.fromEntityId,toEntityId:edge.toEntityId,edgeMeaning:edge.edgeMeaning,
      temporalStatus:status(edge.temporalStatus),temporal:clone(edge.temporal??null),authorityClass:edge.authorityClass,
      sourceRevisionRefs:uniq(edge.sourceRevisionRefs??[]),identityRevisionRefs:uniq(edge.identityRevisionRefs??[]),dependencyRevisionRefs:uniq(edge.dependencyRevisionRefs??[]),
      provenanceRefs:uniq(edge.provenanceRefs??[]),evidenceRefs:uniq(edge.evidenceRefs??[]),claimRefs:uniq(edge.claimRefs??[]),eventRefs:uniq(edge.eventRefs??[]),relationshipRefs:uniq(edge.relationshipRefs??[]),
      artifactRef:artifactRef(edge),artifactRevision:edge.artifactRevision??1,providerRevision:edge.providerRevision??null,
      representationRef:edge.representationRef??null,drillbackRefs:clone(edge.drillbackRefs??[]).slice(0,32),
      distance:row.distance,traversalPath:clone(row.path),identityResolution:clone(edge.identityResolution),
      semanticsVersion:edge.semanticsVersion??'1.0.0',readOnly:true,
    };
  }

  #walk(edges,request,started){
    // Preserve owner temporal semantics at the graph-admission boundary. CURRENT
    // retrieval may carry HISTORICAL evidence as support for Truth/Compiler, but a
    // SUPERSEDED edge must not be surfaced as current topology. Historical support
    // also does not widen CURRENT traversal through the mayExpand rule below.
    const allowed=new Set(request.allowedEdgeMeanings),edgeRows=edges.filter(edge=>(!allowed.size||allowed.has(edge.edgeMeaning))&&eligibleForIntent(edge.temporalStatus,request.intentKind));
    const adjacency=new Map();
    for(const edge of edgeRows){
      for(const id of [edge.fromEntityId,edge.toEntityId]){const rows=adjacency.get(id)??[];rows.push(edge);adjacency.set(id,rows);}
    }
    const admittedAnchors=request.anchorEntityIds.slice(0,request.maxNodes);
    const queue=admittedAnchors.map(id=>({entityId:id,depth:0,path:[]})),visited=new Set(admittedAnchors),selected=[],seenEdges=new Set();
    let examinedEdgeCount=0,boundedEdges=0,boundedNodes=Math.max(0,request.anchorEntityIds.length-admittedAnchors.length),boundedCandidates=0;
    while(queue.length){
      // Once edges have been admitted, traversal is bounded deterministically by
      // maxDepth/maxNodes/maxEdges/maxCandidates. Do not discard already-admitted
      // native evidence because wall-clock time was consumed by optional providers
      // or runner scheduling before the walk began.
      const node=queue.shift();if(node.depth>=request.maxDepth)continue;
      for(const edge of providerBalancedEdges(adjacency.get(node.entityId)??[])){
        if(examinedEdgeCount>=request.maxEdges){boundedEdges++;queue.length=0;break;}
        examinedEdgeCount++;
        if(seenEdges.has(edge.providerId+'|'+edge.edgeId))continue;seenEdges.add(edge.providerId+'|'+edge.edgeId);
        const next=edge.fromEntityId===node.entityId?edge.toEntityId:edge.fromEntityId;
        const step={providerId:edge.providerId,owner:edge.owner,edgeId:edge.edgeId,edgeMeaning:edge.edgeMeaning,fromEntityId:node.entityId,toEntityId:next,temporalStatus:status(edge.temporalStatus)};
        const path=[...node.path,step],distance=node.depth+1;
        if(selected.length<request.maxCandidates)selected.push({edge,distance,path});else boundedCandidates++;
        const edgeStatus=status(edge.temporalStatus);
        const mayExpand=request.intentKind==='HISTORICAL'||request.intentKind==='TEMPORAL'||currentish.has(edgeStatus);
        if(mayExpand&&distance<request.maxDepth&&!visited.has(next)){
          if(visited.size>=request.maxNodes){boundedNodes++;continue;}
          visited.add(next);queue.push({entityId:next,depth:distance,path});
        }
      }
    }
    return{rows:selected,visitedNodeCount:visited.size,examinedEdgeCount,boundedEdges,boundedNodes,boundedCandidates};
  }
}
