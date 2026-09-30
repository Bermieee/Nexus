import { CandidateBus } from '../candidate-bus.js';
import { RetrievalChannelRegistry } from '../retrieval-channel-registry.js';
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

export function createNexusCandidateChannel({
  channelId,
  candidates=[],
  sourceRevisionRefs=[],
  capability=RetrievalChannelCapability.SPARSE,
  discoverySource=channelId,
  maxCandidates=128,
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
        representationRevision:1,
        representationText:String(row?.content??''),
        metadata:{
          book:String(row.book),uid:Number(row.uid),title:String(row?.title??''),
          nodeId:row?.nodeId??null,nodeLabel:row?.nodeLabel??null,path:Array.isArray(row?.path)?[...row.path]:[],
          discoverySource,legacyKey:keyOf(row),
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
  }={}){
    const retrievalIntent=createRetrievalIntent({
      intentId:'nexus-turn',
      kind:intent,
      query,
      entityRefs:anchorEntityIds,
      metadata:{origin:'NEXUS_RUN_RETRIEVAL'},
    });
    const gathered=this.registry.retrieveAllSync({
      intents:[retrievalIntent],
      context:{query,anchorEntityIds,latencyBudgetMs,sourceRevisionSet,sceneRevision,worldRevision},
      channelIds,
    });
    const envelope=this.candidateBus.fuse({
      nominations:gathered.nominations,
      retrievalIntents:[retrievalIntent],
      query,
      currentRevisionSet:{sourceRevisionSet,sceneRevision,worldRevision},
      unavailableChannels:gathered.unavailableChannels,
      degradedChannels:gathered.degradedChannels,
      candidateLimit,
      metadata:{channelReceipts:gathered.channelReceipts,budgetReceipt:gathered.budgetReceipt},
    });
    const candidates=[...envelope.candidates].sort((a,b)=>
      Number(b.fusionScore??0)-Number(a.fusionScore??0)||
      Math.min(...(a.channelNominations??[]).map(row=>Number(row?.rankSignals?.baselineRank??Number.MAX_SAFE_INTEGER)))-
        Math.min(...(b.channelNominations??[]).map(row=>Number(row?.rankSignals?.baselineRank??Number.MAX_SAFE_INTEGER)))||
      String(a.candidateId).localeCompare(String(b.candidateId))
    );
    const rankedEnvelope=Object.freeze({...envelope,candidates:Object.freeze(candidates)});
    return Object.freeze({envelope:rankedEnvelope,candidates:rankedEnvelope.candidates,gathered:clone(gathered)});
  }
}
