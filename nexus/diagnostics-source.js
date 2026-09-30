/**
 * Staged producer for the Nexus UI Diagnostics telemetry input.
 *
 * Output intentionally matches the UI branch's observability event shape:
 *   { id, ts, level, category, name, data }
 *
 * This module is metadata-only by construction. It does not accept or retain
 * prompts, story/lore bodies, provider bodies, credentials, or reasoning text.
 * The UI sanitiser remains a second defensive boundary after merge.
 */
export const NEXUS_DIAGNOSTICS_CONTRACT_VERSION='1.0.0';

export const NexusDiagnosticChannel=Object.freeze({
  TRUTH:'truth',
  SENSORY:'sensory',
  GRAPH_WALKER:'graph-walker',
  HOT_COGNITION:'hot-cognition',
  SCENE_INTELLIGENCE:'scene-intelligence',
  GREEN_ROOM:'green-room',
  SCATTER:'scatter',
  GATHER:'gather',
  RESOURCE_PROBE:'resource-probe',
});

export const NexusDiagnosticCategory=Object.freeze({
  HOST:'HOST',
  EDGE:'EDGE',
  COGNITION:'COGNITION',
  RUNTIME:'RUNTIME',
  RESOURCE:'RESOURCE',
  RESULT:'RESULT',
  GATHER:'GATHER',
  CONTEXT:'CONTEXT',
  DELIVERY:'DELIVERY',
  LEARNING:'LEARNING',
  ERROR:'ERROR',
});

const CHANNELS=new Set(Object.values(NexusDiagnosticChannel));
const LEVELS=new Set(['debug','info','warn','error']);
const SAFE_REASON=/^[A-Z0-9_.:-]{1,160}$/;
const SAFE_ID=/^[\p{L}\p{N}_.:@/#+=-]{1,240}$/u;

const CATEGORY_BY_CHANNEL=Object.freeze({
  [NexusDiagnosticChannel.TRUTH]:NexusDiagnosticCategory.CONTEXT,
  [NexusDiagnosticChannel.SENSORY]:NexusDiagnosticCategory.CONTEXT,
  [NexusDiagnosticChannel.GRAPH_WALKER]:NexusDiagnosticCategory.COGNITION,
  [NexusDiagnosticChannel.HOT_COGNITION]:NexusDiagnosticCategory.COGNITION,
  [NexusDiagnosticChannel.SCENE_INTELLIGENCE]:NexusDiagnosticCategory.COGNITION,
  [NexusDiagnosticChannel.GREEN_ROOM]:NexusDiagnosticCategory.COGNITION,
  [NexusDiagnosticChannel.SCATTER]:NexusDiagnosticCategory.RUNTIME,
  [NexusDiagnosticChannel.GATHER]:NexusDiagnosticCategory.GATHER,
  [NexusDiagnosticChannel.RESOURCE_PROBE]:NexusDiagnosticCategory.RESOURCE,
});

function level(value){
  const normalized=String(value??'info').toLowerCase();
  return LEVELS.has(normalized)?normalized:'info';
}
function number(value,{min=0,max=Number.MAX_SAFE_INTEGER}={}){
  const n=Number(value);
  return Number.isFinite(n)?Math.max(min,Math.min(max,n)):null;
}
function integer(value,{min=0,max=Number.MAX_SAFE_INTEGER}={}){
  const n=number(value,{min,max});
  return n==null?null:Math.floor(n);
}
function boolean(value){return value==null?null:Boolean(value);}
function id(value){
  if(value==null)return null;
  const text=String(value).trim();
  return SAFE_ID.test(text)?text:null;
}
function label(value){
  if(value==null)return null;
  const text=String(value).replace(/[\u0000-\u001F\u007F]/g,' ').replace(/\s+/g,' ').trim().slice(0,120);
  return text||null;
}
function reasonCode(value){
  if(value==null)return null;
  const text=String(value).trim().toUpperCase().replace(/[^A-Z0-9_.:-]+/g,'_').slice(0,160);
  return SAFE_REASON.test(text)?text:null;
}
function status(value){
  if(value==null)return null;
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9_.:-]+/g,'_').slice(0,80)||null;
}
function boundedIds(values,max=32){
  return [...new Set((Array.isArray(values)?values:[]).map(id).filter(Boolean))].slice(0,max);
}
function boundedStatuses(values,max=24){
  return [...new Set((Array.isArray(values)?values:[]).map(status).filter(Boolean))].slice(0,max);
}
function countMap(input={},maxKeys=24){
  if(!input||typeof input!=='object'||Array.isArray(input))return Object.freeze({});
  const out={};
  for(const [key,value] of Object.entries(input).slice(0,maxKeys)){
    const safeKey=reasonCode(key);
    const safeValue=integer(value,{max:1_000_000});
    if(safeKey&&safeValue!=null)out[safeKey]=safeValue;
  }
  return Object.freeze(out);
}

export function normalizeNexusDiagnosticSelection(value={}){
  return Object.freeze({
    chatId:id(value?.chatId),
    turnId:id(value?.turnId),
    generationId:id(value?.generationId),
    correlationId:id(value?.correlationId),
    worldRevision:number(value?.worldRevision),
    sceneRevision:number(value?.sceneRevision),
    sourceRevisionRefs:Object.freeze(boundedIds(value?.sourceRevisionRefs,32)),
  });
}

function commonMetrics(input={}){
  return {
    status:status(input.status??input.state),
    reasonCode:reasonCode(input.reasonCode??input.code),
    receiptId:id(input.receiptId),
    elapsedMs:number(input.elapsedMs,{max:3_600_000}),
    queueWaitMs:number(input.queueWaitMs,{max:3_600_000}),
    inputCount:integer(input.inputCount,{max:1_000_000}),
    outputCount:integer(input.outputCount,{max:1_000_000}),
  };
}

function summarizeTruth(input={}){
  return {
    ...commonMetrics(input),
    intent:status(input.intent),
    kind:status(input.kind)?.toLowerCase()??null,
    candidateId:id(input.candidateId),
    classification:status(input.classification),
    usableForIntent:boolean(input.usableForIntent),
    kept:boolean(input.kept),
    supportOnly:boolean(input.supportOnly),
    reasons:Object.freeze(boundedStatuses(input.reasons,16)),
    candidateCount:integer(input.candidateCount,{max:100_000}),
    keptCount:integer(input.keptCount,{max:100_000}),
    droppedCount:integer(input.droppedCount,{max:100_000}),
    unresolvedCount:integer(input.unresolvedCount,{max:100_000}),
    disputedCount:integer(input.disputedCount,{max:100_000}),
    classifications:countMap(input.classifications),
  };
}
function summarizeSensory(input={}){
  return {
    ...commonMetrics(input),
    candidateCount:integer(input.candidateCount,{max:100_000}),
    inputChannelCount:integer(input.inputChannelCount??input.channelCount,{max:128}),
    unavailableChannelCount:integer(input.unavailableChannelCount,{max:128}),
    degradedChannelCount:integer(input.degradedChannelCount,{max:128}),
    addedCount:integer(input.addedCount,{max:100_000}),
    droppedCount:integer(input.droppedCount,{max:100_000}),
    rerankedCount:integer(input.rerankedCount,{max:100_000}),
    channelIds:Object.freeze(boundedIds(input.channelIds,32)),
    inputNominationCount:integer(input.inputNominationCount,{max:100000}),
    freshness:status(input.freshness),
    perChannelCounts:countMap(input.perChannelCounts),
    unavailableChannels:Object.freeze(boundedIds(input.unavailableChannels,32)),
    degradedChannels:Object.freeze(boundedIds(input.degradedChannels,32)),
  };
}
function summarizeWalker(input={}){
  return {
    ...commonMetrics(input),
    anchorCount:integer(input.anchorCount,{max:10_000}),
    traversedNodeCount:integer(input.traversedNodeCount,{max:100_000}),
    traversedEdgeCount:integer(input.traversedEdgeCount,{max:100_000}),
    staleRejectedCount:integer(input.staleRejectedCount,{max:100_000}),
    providerCount:integer(input.providerCount,{max:128}),
    maxDepth:integer(input.maxDepth,{max:64}),
  };
}
function summarizeHot(input={}){
  return {
    ...commonMetrics(input),
    hotRevision:number(input.hotRevision),
    sceneRevision:number(input.sceneRevision),
    changedSegmentCount:integer(input.changedSegmentCount,{max:64}),
    reusedSegmentCount:integer(input.reusedSegmentCount,{max:64}),
    invalidatedSegmentCount:integer(input.invalidatedSegmentCount,{max:64}),
    activeSegmentCount:integer(input.activeSegmentCount,{max:64}),
    changedSegments:Object.freeze(boundedStatuses(input.changedSegments,16)),
    invalidatedSegments:Object.freeze(boundedStatuses(input.invalidatedSegments,16)),
  };
}
function summarizeScene(input={}){
  const coverage=input.coverage&&typeof input.coverage==='object'?input.coverage:{};
  return {
    ...commonMetrics(input),
    sceneId:id(input.sceneId),
    revision:number(input.revision),
    path:status(input.path),
    boundaryConfirmed:boolean(input.boundaryConfirmed),
    fieldCount:integer(input.fieldCount,{max:128}),
    affectedFieldCount:integer(input.affectedFieldCount,{max:128}),
    fieldNames:Object.freeze(boundedStatuses(input.fieldNames,32)),
    coverage:Object.freeze({
      complete:boolean(coverage.complete),
      window:status(coverage.window),
      sourceCharacters:integer(coverage.sourceCharacters,{max:10_000_000}),
      observedCharacters:integer(coverage.observedCharacters,{max:10_000_000}),
    }),
  };
}
function summarizeGreenRoom(input={}){
  return {
    ...commonMetrics(input),
    sceneId:id(input.sceneId),
    sceneRevision:number(input.sceneRevision),
    requestedCharacterCount:integer(input.requestedCharacterCount,{max:256}),
    acceptedCount:integer(input.acceptedCount,{max:256}),
    activeCount:integer(input.activeCount,{max:256}),
    sourceRevisionCount:integer(input.sourceRevisionCount,{max:10_000}),
    integrityViolationCount:integer(input.integrityViolationCount,{max:256}),
    authority:status(input.authority),
    fallback:status(input.fallback),
  };
}
function summarizeScatter(input={}){
  return {
    ...commonMetrics(input),
    jobIds:Object.freeze(boundedIds(input.jobIds,32)),
    reasonCodes:Object.freeze(boundedStatuses(input.reasonCodes,32)),
    lane:status(input.lane),
    jobId:id(input.jobId),state:status(input.state),previous:status(input.previous),action:status(input.action),from:status(input.from),to:status(input.to),
    planId:id(input.planId),
    taskCount:integer(input.taskCount,{max:10_000}),
    admittedCount:integer(input.admittedCount,{max:10_000}),
    deferredCount:integer(input.deferredCount,{max:10_000}),
    rejectedCount:integer(input.rejectedCount,{max:10_000}),
    completedUnits:integer(input.completedUnits,{max:10_000}),
    totalUnits:integer(input.totalUnits,{max:10_000}),
    layers:countMap(input.layers),
  };
}
function summarizeGather(input={}){
  return {
    ...commonMetrics(input),
    jobId:id(input.jobId),
    verdict:status(input.verdict),
    counts:countMap(input.counts),
    phase:status(input.phase),
    controlMetadata:status(input.controlMetadata),
    readersSwitched:boolean(input.readersSwitched),
    planId:id(input.planId),
    quorumSatisfied:boolean(input.quorumSatisfied??input.satisfied),
    completedCount:integer(input.completedCount,{max:10_000}),
    fallbackCount:integer(input.fallbackCount,{max:10_000}),
    missingRequiredCount:integer(input.missingRequiredCount,{max:10_000}),
    lateResultCount:integer(input.lateResultCount,{max:10_000}),
    acceptedResultCount:integer(input.acceptedResultCount,{max:10_000}),
  };
}
function summarizeProbe(input={}){
  return {
    ...commonMetrics(input),
    resourceId:id(input.resourceId),
    displayName:label(input.displayName),
    health:status(input.health),
    callable:boolean(input.callable),
    latencyMs:number(input.latencyMs??input.lastHealthLatencyMs,{max:3_600_000}),
    capabilityCount:integer(input.capabilityCount,{max:128}),
  };
}

const SUMMARIZER=Object.freeze({
  [NexusDiagnosticChannel.TRUTH]:summarizeTruth,
  [NexusDiagnosticChannel.SENSORY]:summarizeSensory,
  [NexusDiagnosticChannel.GRAPH_WALKER]:summarizeWalker,
  [NexusDiagnosticChannel.HOT_COGNITION]:summarizeHot,
  [NexusDiagnosticChannel.SCENE_INTELLIGENCE]:summarizeScene,
  [NexusDiagnosticChannel.GREEN_ROOM]:summarizeGreenRoom,
  [NexusDiagnosticChannel.SCATTER]:summarizeScatter,
  [NexusDiagnosticChannel.GATHER]:summarizeGather,
  [NexusDiagnosticChannel.RESOURCE_PROBE]:summarizeProbe,
});

export function createNexusDiagnosticEvent({
  id:eventId=null,
  ts=Date.now(),
  level:eventLevel='info',
  channelId,
  name,
  selection={},
  metrics={},
}={}){
  const channel=String(channelId??'');
  if(!CHANNELS.has(channel))throw new TypeError('Unknown Nexus diagnostics channel: '+channel);
  const safeName=reasonCode(name)?.toLowerCase().replaceAll('_','-');
  if(!safeName)throw new TypeError('Nexus diagnostic event name is required');
  const summarize=SUMMARIZER[channel];
  const data=Object.freeze({
    channelId:channel,
    selection:normalizeNexusDiagnosticSelection(selection),
    ...summarize(metrics),
  });
  return Object.freeze({
    id:id(eventId),
    ts:number(ts,{min:0})??0,
    level:level(eventLevel),
    category:CATEGORY_BY_CHANNEL[channel],
    name:safeName,
    data,
  });
}

export function isNexusDiagnosticProbe(event={}){
  return event?.data?.channelId===NexusDiagnosticChannel.RESOURCE_PROBE;
}

export function isNexusDiagnosticStaleSignal(event={}){
  const data=event?.data??{};
  return String(data.status??'')==='STALE'
    || Number(data.staleRejectedCount||0)>0
    || String(data.reasonCode??'').includes('STALE');
}

export function createEmptyNexusDiagnosticTelemetry(){
  return {
    events:[],
    channels:Object.fromEntries(Object.values(NexusDiagnosticChannel).map(channel=>[channel,null])),
    counts:{events:0,warnings:0,errors:0,probes:0,stale:0},
    safety:{
      metadataOnly:true,
      rawPrompts:false,
      storyLoreBodies:false,
      providerBodies:false,
      credentials:false,
      hiddenReasoning:false,
    },
  };
}

export function reduceNexusDiagnosticTelemetry(events=[],{
  maxEvents=256,
}={}){
  const out=createEmptyNexusDiagnosticTelemetry();
  const limit=Math.max(16,Math.min(256,Math.floor(Number(maxEvents)||256)));
  for(const raw of Array.isArray(events)?events:[]){
    if(!raw||typeof raw!=='object')continue;
    const channel=raw?.data?.channelId;
    if(!CHANNELS.has(channel))continue;
    const event=createNexusDiagnosticEvent({
      id:raw.id,ts:raw.ts,level:raw.level,channelId:channel,name:raw.name,
      selection:raw.data?.selection,metrics:raw.data,
    });
    out.events.push(event);
    if(out.events.length>limit)out.events.splice(0,out.events.length-limit);
    out.channels[channel]=event;
    out.counts.events+=1;
    if(event.level==='warn')out.counts.warnings+=1;
    if(event.level==='error')out.counts.errors+=1;
    if(isNexusDiagnosticProbe(event))out.counts.probes+=1;
    if(isNexusDiagnosticStaleSignal(event))out.counts.stale+=1;
  }
  return Object.freeze({
    events:Object.freeze([...out.events]),
    channels:Object.freeze({...out.channels}),
    counts:Object.freeze({...out.counts}),
    safety:Object.freeze({...out.safety}),
  });
}

export class NexusDiagnosticTelemetryAccumulator{
  constructor({maxEvents=256}={}){
    this.maxEvents=Math.max(16,Math.min(256,Math.floor(Number(maxEvents)||256)));
    this.events=[];
  }
  ingest(input){
    const event=input?.data?.channelId
      ? createNexusDiagnosticEvent({
          id:input.id,ts:input.ts,level:input.level,channelId:input.data.channelId,
          name:input.name,selection:input.data.selection,metrics:input.data,
        })
      : createNexusDiagnosticEvent(input);
    this.events.push(event);
    if(this.events.length>this.maxEvents)this.events.splice(0,this.events.length-this.maxEvents);
    return event;
  }
  clear(){this.events.length=0;}
  snapshot(){return reduceNexusDiagnosticTelemetry(this.events,{maxEvents:this.maxEvents});}
}


const CHANNEL_BY_TELEMETRY_CATEGORY=Object.freeze({
  'nexus.truth':NexusDiagnosticChannel.TRUTH,
  'nexus.sensory':NexusDiagnosticChannel.SENSORY,
  'nexus.walker':NexusDiagnosticChannel.GRAPH_WALKER,
  'nexus.hot':NexusDiagnosticChannel.HOT_COGNITION,
  'nexus.scene':NexusDiagnosticChannel.SCENE_INTELLIGENCE,
  'nexus.greenroom':NexusDiagnosticChannel.GREEN_ROOM,
  'nexus.scatter':NexusDiagnosticChannel.SCATTER,
  'nexus.gather':NexusDiagnosticChannel.GATHER,
  'nexus.resource-probe':NexusDiagnosticChannel.RESOURCE_PROBE,
  'resource-probe':NexusDiagnosticChannel.RESOURCE_PROBE,
});

function telemetryChannel(category){
  const raw=String(category??'').trim().toLowerCase();
  if(CHANNEL_BY_TELEMETRY_CATEGORY[raw])return CHANNEL_BY_TELEMETRY_CATEGORY[raw];
  const legacyNormalized=raw.replace(/^a(?:rea)?[-_ ]?52[.]/,'nexus.');
  return CHANNEL_BY_TELEMETRY_CATEGORY[legacyNormalized]??null;
}
function arrayCount(value){return Array.isArray(value)?value.length:null;}
function firstNumber(...values){
  for(const value of values){
    const n=Number(value);
    if(Number.isFinite(n))return n;
  }
  return null;
}
function telemetrySelection(record={}){
  const data=record?.data??{};
  return {
    chatId:data.chatId??data.chatNamespace??null,
    turnId:data.turnId??data.turnSequence??null,
    generationId:data.generationId??null,
    correlationId:data.correlationId??data.planId??null,
    worldRevision:data.worldRevision??null,
    sceneRevision:data.sceneRevision??data.revision??null,
    sourceRevisionRefs:data.sourceRevisionRefs??data.sourceRevisionSet??[],
  };
}
function telemetryMetrics(channel,record={}){
  const data=record?.data??{},receipt=data.receipt??{},fusion=data.fusionReceipt??{},provider=data.provider??{};
  if(channel===NexusDiagnosticChannel.TRUTH)return{
    status:data.status,
    intent:data.intent,
    kind:data.kind, candidateId:data.candidateId,classification:data.classification,
    usableForIntent:data.usableForIntent,kept:data.kept,supportOnly:data.supportOnly,reasons:data.reasons,
    candidateCount:data.candidateCount,
    keptCount:data.keptCount,
    droppedCount:data.droppedCount,
    unresolvedCount:data.unresolvedCount,
    disputedCount:data.disputedCount,
    classifications:data.classifications,
  };
  if(channel===NexusDiagnosticChannel.SENSORY)return{
    status:data.status,
    candidateCount:data.candidateCount,
    inputChannelCount:fusion.inputChannelCount??data.inputChannelCount,
    unavailableChannelCount:arrayCount(fusion.unavailableChannels??data.unavailableChannels),
    degradedChannelCount:arrayCount(fusion.degradedChannels??data.degradedChannels),
    addedCount:arrayCount(data.added),
    droppedCount:arrayCount(data.dropped),
    rerankedCount:arrayCount(data.reranked),
    channelIds:(data.channelReceipts??[]).slice(0,32).map(row=>row?.channelId).filter(Boolean),
    inputNominationCount:fusion.inputNominationCount,
    freshness:fusion.freshness,perChannelCounts:fusion.perChannelCounts,
    unavailableChannels:fusion.unavailableChannels,degradedChannels:fusion.degradedChannels,
  };
  if(channel===NexusDiagnosticChannel.GRAPH_WALKER)return{
    status:data.status,
    elapsedMs:receipt.elapsedMs,
    anchorCount:arrayCount(data.anchors),
    traversedNodeCount:firstNumber(receipt.traversedNodeCount,receipt.visitedNodeCount,receipt.nodeCount,provider.nodeCount),
    traversedEdgeCount:firstNumber(receipt.traversedEdgeCount,receipt.visitedEdgeCount,receipt.edgeCount,provider.edgeCount),
    staleRejectedCount:receipt.staleRejectedCount,
    providerCount:firstNumber(receipt.providerCount,provider?1:0),
    maxDepth:receipt.maxDepth,
  };
  if(channel===NexusDiagnosticChannel.HOT_COGNITION)return{
    status:data.status,
    hotRevision:data.hotRevision,
    sceneRevision:data.sceneRevision,
    changedSegmentCount:arrayCount(data.changedSegments),
    reusedSegmentCount:arrayCount(data.reusedSegments),
    invalidatedSegmentCount:arrayCount(data.invalidatedSegments),
    activeSegmentCount:data.activeSegmentCount,
    changedSegments:data.changedSegments,
    invalidatedSegments:data.invalidatedSegments,
  };
  if(channel===NexusDiagnosticChannel.SCENE_INTELLIGENCE)return{
    status:data.status,
    sceneId:data.sceneId,
    revision:data.revision,
    path:data.path,
    boundaryConfirmed:data.boundaryConfirmed,
    fieldCount:arrayCount(data.fieldNames),
    affectedFieldCount:firstNumber(data.affectedFields,arrayCount(data.affectedFieldNames)),
    fieldNames:data.fieldNames,
    coverage:data.coverage,
  };
  if(channel===NexusDiagnosticChannel.GREEN_ROOM)return{
    status:data.status,
    sceneId:data.sceneId,
    sceneRevision:data.sceneRevision,
    requestedCharacterCount:firstNumber(data.requestedCharacterCount,arrayCount(data.requestedCharacters)),
    acceptedCount:firstNumber(data.acceptedCount,data.accepted),
    activeCount:data.activeCount,
    sourceRevisionCount:data.sourceRevisionCount,
    integrityViolationCount:firstNumber(data.integrityViolationCount,arrayCount(data.violations)),
    authority:data.authority,
    fallback:data.fallback,
  };
  if(channel===NexusDiagnosticChannel.SCATTER)return{
    status:data.status??data.state,
    jobIds:data.jobIds,reasonCodes:data.reasonCodes,lane:data.lane,reasonCode:data.reasonCode,
    jobId:data.jobId,state:data.state,previous:data.previous,action:data.action,from:data.from,to:data.to,
    planId:data.planId,
    taskCount:firstNumber(data.taskCount,arrayCount(data.admissions)),
    admittedCount:firstNumber(data.admittedCount,(data.admissions??[]).filter(row=>row?.decision==='ADMIT').length),
    deferredCount:firstNumber(data.deferredCount,(data.admissions??[]).filter(row=>row?.decision==='DEFER').length),
    rejectedCount:firstNumber(data.rejectedCount,(data.admissions??[]).filter(row=>row?.decision==='REJECT').length),
    completedUnits:data.completedUnits,
    totalUnits:data.totalUnits,
    layers:data.layers,
  };
  if(channel===NexusDiagnosticChannel.GATHER)return{
    status:data.status,
    jobId:data.jobId,verdict:data.verdict,counts:data.counts,
    phase:data.phase,controlMetadata:data.controlMetadata,readersSwitched:data.readersSwitched,
    elapsedMs:data.elapsedMs,
    planId:data.planId,
    quorumSatisfied:data.quorumSatisfied??data.quorum?.satisfied,
    completedCount:firstNumber(data.completedCount,data.coordinator?.succeeded),
    fallbackCount:firstNumber(data.fallbackCount,arrayCount(data.gather?.fallbacksUsed)),
    missingRequiredCount:firstNumber(data.missingRequiredCount,arrayCount(data.gather?.missingRequired)),
    lateResultCount:firstNumber(data.lateResultCount,arrayCount(data.gather?.lateResults)),
    acceptedResultCount:firstNumber(data.acceptedResultCount,arrayCount(data.gather?.acceptedResultIds)),
  };
  if(channel===NexusDiagnosticChannel.RESOURCE_PROBE)return{
    status:data.status,
    reasonCode:data.reasonCode??data.code,
    resourceId:data.resourceId??data.id,
    displayName:data.displayName??data.name,
    health:data.health,
    callable:data.callable,
    latencyMs:data.latencyMs??data.lastHealthLatencyMs,
    capabilityCount:firstNumber(data.capabilityCount,arrayCount(data.capabilities)),
  };
  return{};
}

export function projectNexusDiagnosticTelemetryFromObservability(telemetry={},{
  maxEvents=256,
}={}){
  const projected=[];
  for(const record of Array.isArray(telemetry?.events)?telemetry.events:[]){
    const channel=telemetryChannel(record?.category);
    if(!channel)continue;
    try{
      projected.push(createNexusDiagnosticEvent({
        id:record.id,
        ts:record.ts,
        level:record.level,
        channelId:channel,
        name:record.name,
        selection:record.data?.channelId?record.data.selection:telemetrySelection(record),
        metrics:record.data?.channelId?record.data:telemetryMetrics(channel,record),
      }));
    }catch{}
  }
  return reduceNexusDiagnosticTelemetry(projected,{maxEvents});
}
