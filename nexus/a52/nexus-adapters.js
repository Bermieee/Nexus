import { CandidateBus } from './candidate-bus.js';
import { createChannelNomination, CandidateTruthStatus } from './candidate-bus-contracts.js';
import { TruthGate } from './truth-gate.js';
import { KnowledgeStatus } from './contracts.js';

const TRUTH_VALUES=new Set(Object.values(CandidateTruthStatus));
const KNOWLEDGE_VALUES=new Set(Object.values(KnowledgeStatus));

function text(value){return value==null?'':String(value);}
function key(entry){return JSON.stringify([text(entry?.book),Number(entry?.uid)]);}
function candidateId(entry){return 'lore:'+text(entry?.book)+':'+String(Number(entry?.uid));}

export function temporalStatusFromLoreEntry(entry={}){
  const metadata=entry.metadata??entry.meta??entry.extensions??{};
  const raw=entry.temporalStatus??entry.status??metadata.temporalStatus??metadata.status??metadata.truthStatus??null;
  const normalized=text(raw).trim().toUpperCase().replaceAll('-','_');
  if(KNOWLEDGE_VALUES.has(normalized)) return normalized;
  if(metadata.supersededBy!=null||metadata['superseded-by']!=null||entry.supersededBy!=null) return KnowledgeStatus.SUPERSEDED;
  if(metadata.historical===true||entry.historical===true) return KnowledgeStatus.HISTORICAL;
  // Fail-open compatibility: unlabeled Nexus lore retains today's behavior.
  return KnowledgeStatus.CURRENT;
}

export function nexusEntryToNomination(entry,{
  channelId='nexus',
  retrievalIntentIds=['current-turn'],
  baselineRank=1,
  candidateCount=1,
  sourceRevisionRefs=[],
  sceneRevision=null,
  discoverySource=null,
}={}){
  const rank=Math.max(0,Math.min(1,1-((Math.max(1,Number(baselineRank))-1)/Math.max(1,Number(candidateCount)))));
  const status=temporalStatusFromLoreEntry(entry);
  const truthStatusHint=TRUTH_VALUES.has(status)?status:CandidateTruthStatus.UNKNOWN;
  const id=candidateId(entry);
  return createChannelNomination({
    nominationId:channelId+':'+id,
    channelId,
    candidateId:id,
    evidenceIdentity:id,
    artifactRef:{artifactId:id,book:text(entry.book),uid:Number(entry.uid)},
    sourceRevisionRefs:[...new Set((sourceRevisionRefs??[]).map(String))],
    retrievalIntentIds,
    rankSignals:{baselineRank:Number(baselineRank),source:discoverySource??channelId},
    normalizedRank:rank,
    authorityClass:'SOURCE_CANON',
    truthStatusHint,
    representationRef:id,
    representationText:text(entry.content),
    metadata:{
      book:text(entry.book),
      uid:Number(entry.uid),
      title:text(entry.title),
      nodeId:entry.nodeId??null,
      nodeLabel:entry.nodeLabel??null,
      path:entry.path??null,
      discoverySource:discoverySource??channelId,
      temporalStatus:status,
    },
    sceneRevision,
  });
}

export function fuseNexusCandidateChannels(channels,{
  query='',
  retrievalIntentIds=['current-turn'],
  sourceRevisionSet=[],
  sceneRevision=0,
  candidateLimit=null,
}={}){
  const nominations=[];
  let total=0;
  for(const row of channels??[]) total+=Array.isArray(row?.candidates)?row.candidates.length:0;
  let ordinal=0;
  for(const channel of channels??[]){
    const channelId=text(channel?.channelId||'nexus');
    const rows=Array.isArray(channel?.candidates)?channel.candidates:[];
    for(const entry of rows){
      ordinal+=1;
      nominations.push(nexusEntryToNomination(entry,{
        channelId,
        retrievalIntentIds,
        baselineRank:Number(entry?.baselineRank??ordinal),
        candidateCount:Math.max(1,total),
        sourceRevisionRefs:sourceRevisionSet,
        sceneRevision,
        discoverySource:channel?.discoverySource??channelId,
      }));
    }
  }
  const bus=new CandidateBus();
  const envelope=bus.fuse({
    nominations,
    retrievalIntents:retrievalIntentIds,
    query,
    currentRevisionSet:{sourceRevisionSet,sceneRevision},
    candidateLimit,
    metadata:{adapter:'nexus-a52'},
  });
  const rankedCandidates=[...envelope.candidates].sort((a,b)=>
    Number(b.fusionScore??0)-Number(a.fusionScore??0)||
    Number(a.metadata?.baselineRank??Number.MAX_SAFE_INTEGER)-Number(b.metadata?.baselineRank??Number.MAX_SAFE_INTEGER)||
    String(a.candidateId).localeCompare(String(b.candidateId))
  );
  return Object.freeze({envelope,rankedCandidates});
}

export function classifyNexusLoreCandidates(entries,{intent='CURRENT',sourceRevisionRefs=[]}={}){
  const byId=new Map();
  const candidates=(entries??[]).map(entry=>{
    const id=candidateId(entry);
    byId.set(id,entry);
    return {
      candidateId:id,
      claimIds:[],
      sourceRevisionRefs:[...sourceRevisionRefs],
      evidenceRefs:[id],
      temporalStatus:temporalStatusFromLoreEntry(entry),
      authorityClass:'SOURCE_CANON',
    };
  });
  const gate=new TruthGate({
    graph:null,
    externalEvidenceResolver(candidate){
      const entry=byId.get(candidate.candidateId);
      if(!entry) return null;
      return {
        evidenceId:candidate.candidateId,
        artifactRef:candidate.candidateId,
        temporalStatus:temporalStatusFromLoreEntry(entry),
        authorityClass:'SOURCE_CANON',
        sourceClass:'NEXUS_LORE',
        sourceRevisionRefs:[...sourceRevisionRefs],
      };
    },
  });
  return gate.classifyAll(candidates,{intent}).map((verdict,index)=>Object.freeze({
    entry:entries[index],
    key:key(entries[index]),
    verdict,
  }));
}
