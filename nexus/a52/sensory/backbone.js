import { CandidateBus } from '../candidate-bus.js';
import { RetrievalChannelRegistry } from '../retrieval-channel-registry.js';
import { captureSensorySource, refreshSensoryNomination, sensoryNominationSourceKey, sensorySourceCurrent } from './source-continuation.js';
import {
  CandidateTruthStatus,
  RetrievalChannelCapability,
  createChannelNomination,
  createRetrievalChannelDescriptor,
  createRetrievalIntent,
} from '../candidate-bus-contracts.js';

const clone=(value)=>value==null?value:structuredClone(value);
const keyOf=(row)=>JSON.stringify([String(row?.book??''),Number(row?.uid)]);
const loreId=(row)=>'lore:'+String(row?.book??'')+':'+String(Number(row?.uid));
const rankFor=(index,count)=>Math.max(0,Math.min(1,1-(index/Math.max(1,count))));
const now=()=>globalThis.performance?.now?.()??Date.now();

export function createNexusCandidateChannel({
  channelId,
  candidates=[],
  sourceRevisionRefs=[],
  capability=RetrievalChannelCapability.SPARSE,
  discoverySource=channelId,
  maxCandidates=128,
  worldTree=null,
}={}){
  const rows=(candidates??[]).filter(row=>String(row?.book??'').trim()&&Number.isFinite(Number(row?.uid)));
  return {
    descriptor:createRetrievalChannelDescriptor({
      channelId,
      capabilities:[capability],
      supportedIntentKinds:['*'],
      maxCandidates,
      metadata:{source:'NEXUS_EXISTING_RETRIEVAL',discoverySource},
    }),
    retrieve(intent){
      const count=rows.length;
      return rows.map((row,index)=>createChannelNomination({
        nominationId:channelId+':'+loreId(row),
        channelId,
        candidateId:loreId(row),
        evidenceIdentity:loreId(row),
        artifactRef:{artifactId:loreId(row),artifactType:'NexusLoreEntry',book:String(row.book),uid:Number(row.uid)},
        artifactRevision:1,
        sourceRevisionRefs:[...sourceRevisionRefs],
        retrievalIntentIds:[intent.intentId],
        rankSignals:{baselineRank:index+1,source:discoverySource},
        normalizedRank:rankFor(index,count),
        authorityClass:'SOURCE_CANON',
        truthStatusHint:CandidateTruthStatus.UNKNOWN,
        representationRef:loreId(row),
        representationRevision:worldTree?.getNode(loreId(row))?.revision??1,
        representationText:String(row?.content??''),
        metadata:{
          book:String(row.book),uid:Number(row.uid),title:String(row?.title??''),
          nodeId:row?.nodeId??null,nodeLabel:row?.nodeLabel??null,path:Array.isArray(row?.path)?[...row.path]:[],
          discoverySource,legacyKey:keyOf(row),
          sourceValidation:captureSensorySource(worldTree,[loreId(row)]),
        },
      }));
    },
  };
}

export class NexusSensoryBackbone{
  constructor({registry=new RetrievalChannelRegistry(),candidateBus=new CandidateBus()}={}){
    this.registry=registry;
    this.candidateBus=candidateBus;
  }
  register(provider){this.registry.register(provider);return this;}
  retrieveEnvelope({
    query='',
    intent='CURRENT',
    anchorEntityIds=[],
    channelIds=null,
    latencyBudgetMs=15,
    sourceRevisionSet=[],
    sceneRevision=0,
    worldRevision=0,
    candidateLimit=256,
    channelWeights={},
    graphTraversal=null,
    sourcePlan=null,
    continuation=null,
    channelCandidateLimits={},
    worldTree=null,
    chatId=null,
    generationId=null,
  }={}){
    const retrievalIntent=createRetrievalIntent({
      intentId:'nexus-turn',
      kind:intent,
      query,
      entityRefs:anchorEntityIds,
      metadata:{origin:'NEXUS_RUN_RETRIEVAL'},
    });
    const sameFrame=continuation&&continuation.generationId===generationId&&continuation.query===query&&continuation.worldRevision===worldRevision&&continuation.sceneRevision===sceneRevision&&JSON.stringify(continuation.sourceRevisionSet)===JSON.stringify(sourceRevisionSet);
    const sameBinding=continuation&&continuation.bindingKey===(worldTree?.readScopeKey??chatId);
    const resumeFresh=sameFrame||(sameBinding&&worldTree!=null);
    const validation={retained:0,invalidated:0,sourceLocal:!sameFrame&&Boolean(resumeFresh)};
    const pending=(resumeFresh?[...(continuation.nominations??[]),...(continuation.readyNominations??[])]:[]).map(row=>{
      const value=worldTree&&row.metadata?.sourceValidation?refreshSensoryNomination(row,{worldTree,query,sourceRevisionSet,worldRevision,sceneRevision}):sameFrame?row:null;
      if(value)validation.retained++;else validation.invalidated++;return value;
    }).filter(Boolean);
    const deliveredKeys=new Set(resumeFresh?continuation.deliveredSourceKeys??[]:[]);
    const gathered=this.registry.retrieveAllSync({
      intents:[retrievalIntent],
      context:{query,chatId,generationId,anchorEntityIds,latencyBudgetMs,sourceRevisionSet,sceneRevision,worldRevision,candidateLimit,channelCandidateLimits,continuation:resumeFresh?{...continuation.channels,completedChannels:sameFrame?continuation.channels?.completedChannels??[]:[]}:null,graphTraversal:graphTraversal??undefined},
      channelIds:(channelIds??this.registry.list().map(row=>row.descriptor.channelId)).filter(id=>!(sourcePlan?.walker==='skip'&&id==='ZZ_NATIVE_GRAPH_WALKER')&&!(sourcePlan?.vector==='skip'&&id==='paging')),
    });
    const nominationMap=new Map();
    for(const row of pending)if(!deliveredKeys.has(sensoryNominationSourceKey(row)))nominationMap.set(row.nominationId,row);
    // Delivery keys account for a saved page. A fresh foreground question must
    // still see evidence delivered in an earlier generation or query.
    for(const row of [...gathered.nominations,...gathered.deferredNominations])if(!sameFrame||!deliveredKeys.has(sensoryNominationSourceKey(row)))nominationMap.set(row.nominationId,row);
    const availableNominations=[...nominationMap.values()];
    const rawNominations=availableNominations;
    const weightedNominations=rawNominations.map(row=>{
      const weight=Math.max(0,Number(channelWeights?.[row.channelId]??1)||0);
      return weight===1?row:{...row,normalizedRank:Math.max(0,Math.min(1,Number(row.normalizedRank??0)*weight)),metadata:{...(row.metadata??{}),sourcePlanWeight:weight}};
    });
    const fusionStarted=now();
    const locallyValidatedSourceRefs=rawNominations.filter(row=>sensorySourceCurrent(row.metadata?.sourceValidation,worldTree)).flatMap(row=>row.sourceRevisionRefs??[]);
    const envelope=this.candidateBus.fuse({
      nominations:weightedNominations,
      retrievalIntents:[retrievalIntent],
      query,
      currentRevisionSet:{sourceRevisionSet:[...new Set([...sourceRevisionSet,...locallyValidatedSourceRefs])],sceneRevision,worldRevision},
      unavailableChannels:gathered.unavailableChannels,
      degradedChannels:gathered.degradedChannels,
      candidateLimit,
      dynamicLimits:{maxPerChannel:Math.max(1,candidateLimit),maxPerChannelIntent:Math.max(1,candidateLimit),maxPerIntent:Math.max(1,candidateLimit),maxTotalCandidates:Math.max(1,candidateLimit)},
      metadata:{channelReceipts:gathered.channelReceipts,budgetReceipt:gathered.budgetReceipt},
    });
    const fusionElapsedMs=Math.max(0,now()-fusionStarted);
    const selectedNominationIds=new Set(envelope.candidates.flatMap(row=>row.channelNominations.map(nomination=>nomination.nominationId)));
    const deferredNominations=rawNominations.filter(row=>!selectedNominationIds.has(row.nominationId));
    const providerDeferred=gathered.channelReceipts.reduce((sum,row)=>sum+(row.providerCoverages??[]).reduce((count,value)=>count+Math.max(0,Number(value.deferred??0)),0),0);
    for(const row of rawNominations)if(selectedNominationIds.has(row.nominationId))deliveredKeys.add(sensoryNominationSourceKey(row));
    const deferred=deferredNominations.length+providerDeferred;
    const complete=deferred===0&&!gathered.channelReceipts.some(row=>!['OK','PARTIAL_CANDIDATE_BUDGET'].includes(row.status));
    const next=!complete?{query,intent,chatId,generationId,anchorEntityIds:[...anchorEntityIds],graphTraversal,sourceRevisionSet:[...sourceRevisionSet],worldRevision,sceneRevision,bindingKey:worldTree?.readScopeKey??chatId,nominations:deferredNominations,deliveredSourceKeys:[...deliveredKeys],channels:gathered.continuation}:null;
    const candidates=[...envelope.candidates].sort((a,b)=>
      Number(b.fusionScore??0)-Number(a.fusionScore??0)||
      Math.min(...(a.channelNominations??[]).map(row=>Number(row?.rankSignals?.baselineRank??Number.MAX_SAFE_INTEGER)))-
        Math.min(...(b.channelNominations??[]).map(row=>Number(row?.rankSignals?.baselineRank??Number.MAX_SAFE_INTEGER)))||
      String(a.candidateId).localeCompare(String(b.candidateId))
    );
    const rankedEnvelope=Object.freeze({...envelope,candidates:Object.freeze(candidates),metadata:Object.freeze({...envelope.metadata,fusionElapsedMs,continuationValidation:validation,coverage:{complete,examined:weightedNominations.length,total:weightedNominations.length+providerDeferred,retained:candidates.length,deferred},continuation:next})});
    return Object.freeze({envelope:rankedEnvelope,candidates:rankedEnvelope.candidates,gathered:clone(gathered)});
  }
}
