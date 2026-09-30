const MAX_PROFILES=32;
let detailedEnabled=false;
const profiles=new Map();
const order=[];

function now(){return Date.now();}
function finite(value){return Number.isFinite(Number(value))?Number(value):null;}
function clone(value){try{return typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value));}catch{return null;}}

function heapSample(){
  try{
    const memory=globalThis.performance?.memory;
    return memory&&Number.isFinite(Number(memory.usedJSHeapSize))?Number(memory.usedJSHeapSize):null;
  }catch{return null;}
}
function uiSample(at=now()){
  return Object.freeze({
    at,
    heapBytes:heapSample(),
    longTaskCount:null,
    longTaskTotalMs:null,
    longTaskMaxMs:null,
    diagnosticsUiRefreshCount:0,
    diagnosticsUiRefreshTotalMs:0,
    diagnosticsUiRefreshMaxMs:0,
    diagnosticsUiRefreshLastMs:0,
  });
}
function trim(){
  while(order.length>MAX_PROFILES){
    const id=order.shift();
    profiles.delete(id);
  }
}
function stage(stage,wallMs,outcome='COMPLETE'){
  return Object.freeze({stage,wallMs:Math.max(0,Number(wallMs)||0),queueWaitMs:null,inputCount:null,outputCount:null,inputBytes:null,outputBytes:null,retainedObjectCount:null,retainedBytes:null,outcome});
}
function buildStages(row){
  const start=row.startedAt;
  const pre=row.preGenerationCompleteAt;
  const prompt=row.promptBoundaryAt;
  const end=row.endedAt??row.stoppedAt;
  const out=[];
  if(start!=null&&pre!=null)out.push(stage('NEXUS_PREGENERATION',pre-start));
  if(pre!=null&&prompt!=null)out.push(stage('HOST_PROMPT_BOUNDARY',prompt-pre));
  if(prompt!=null&&end!=null)out.push(stage('PROVIDER_RESPONSE',end-prompt,row.stoppedAt?'STOPPED':'COMPLETE'));
  if(start!=null&&end!=null)out.push(stage('GENERATION_TOTAL',end-start,row.stoppedAt?'STOPPED':'COMPLETE'));
  return out;
}
function materialize(row){
  if(!row)return null;
  const end=row.endedAt??row.stoppedAt??null;
  const after=row.promptBoundarySample??(row.promptBoundaryAt?uiSample(row.promptBoundaryAt):null);
  const endSample=row.endSample??(end?uiSample(end):null);
  return Object.freeze({
    kind:'NexusGenerationPerformanceProfile',
    chatId:row.chatId??null,
    turnId:row.turnId??null,
    generationId:row.generationId,
    correlationId:row.correlationId??row.generationId,
    providerLatencyMs:row.promptBoundaryAt!=null&&end!=null?Math.max(0,end-row.promptBoundaryAt):null,
    start:clone(row.startSample),
    afterInsertion:clone(after),
    end:clone(endSample),
    checkpointPersistence:null,
    longTasks:[],
    deltas:{
      heapBytes:row.startSample?.heapBytes!=null&&endSample?.heapBytes!=null?endSample.heapBytes-row.startSample.heapBytes:null,
      longTaskCount:null,
      longTaskTotalMs:null,
      diagnosticsUiRefreshCount:0,
      diagnosticsUiRefreshTotalMs:0,
    },
    stages:buildStages(row),
    retrievalChannels:[],
    detailedCaptured:Boolean(row.detailed),
    status:row.stoppedAt?'STOPPED':row.endedAt?'AVAILABLE':'CAPTURING',
  });
}
function find(selection={}){
  const generationId=selection?.generationId==null?null:String(selection.generationId);
  if(generationId&&profiles.has(generationId))return profiles.get(generationId);
  const chatId=selection?.chatId==null?null:String(selection.chatId);
  for(let i=order.length-1;i>=0;i--){
    const row=profiles.get(order[i]);
    if(!row)continue;
    if(chatId&&String(row.chatId??'')!==chatId)continue;
    return row;
  }
  return null;
}

export function setDetailedGenerationProfiling(enabled=false){
  detailedEnabled=Boolean(enabled);
  return detailedEnabled;
}
export function detailedGenerationProfilingEnabled(){return detailedEnabled;}

export function beginNexusGenerationProfile({generationId,chatId=null,turnId=null,correlationId=null}={}){
  const id=String(generationId??'').trim();
  if(!id)return null;
  const existing=profiles.get(id);
  if(existing)return materialize(existing);
  const at=now();
  const row={
    generationId:id,chatId:chatId==null?null:String(chatId),turnId:turnId==null?null:String(turnId),
    correlationId:correlationId==null?id:String(correlationId),
    startedAt:at,preGenerationCompleteAt:null,promptBoundaryAt:null,endedAt:null,stoppedAt:null,
    detailed:detailedEnabled,startSample:detailedEnabled?uiSample(at):null,promptBoundarySample:null,endSample:null,
  };
  profiles.set(id,row);order.push(id);trim();
  return materialize(row);
}

export function markNexusGenerationPreflightComplete(generationId,{turnId=null}={}){
  const row=profiles.get(String(generationId??''));if(!row)return null;
  if(row.preGenerationCompleteAt==null)row.preGenerationCompleteAt=now();
  if(turnId!=null)row.turnId=String(turnId);
  return materialize(row);
}

export function markNexusGenerationPromptBoundary(generationId){
  const row=profiles.get(String(generationId??''));if(!row)return null;
  if(row.preGenerationCompleteAt==null)row.preGenerationCompleteAt=now();
  if(row.promptBoundaryAt==null){
    row.promptBoundaryAt=now();
    if(row.detailed)row.promptBoundarySample=uiSample(row.promptBoundaryAt);
  }
  return materialize(row);
}

export function completeNexusGenerationProfile(generationId,{turnId=null,stopped=false}={}){
  const row=profiles.get(String(generationId??''));if(!row)return null;
  const at=now();
  if(row.preGenerationCompleteAt==null)row.preGenerationCompleteAt=at;
  if(row.promptBoundaryAt==null)row.promptBoundaryAt=at;
  if(turnId!=null)row.turnId=String(turnId);
  if(stopped)row.stoppedAt=at;else row.endedAt=at;
  if(row.detailed)row.endSample=uiSample(at);
  return materialize(row);
}

export function readNativeGenerationPerformance(selection={}){
  const row=find(selection);
  return row?.detailed?materialize(row):null;
}

export function readSelectedGenerationPerformanceReceipt(selection={}){
  const row=find(selection);
  if(!row)return null;
  const profile=materialize(row);
  return Object.freeze({
    kind:'NexusSelectedGenerationPerformanceReceipt',
    chatId:row.chatId??null,turnId:row.turnId??null,generationId:row.generationId,correlationId:row.correlationId??row.generationId,
    performance:Object.freeze({stages:profile.stages,retrievalChannels:profile.retrievalChannels}),
  });
}

export function loadGenerationProfilerDiagnostics(){
  const rows=order.map(id=>profiles.get(id)).filter(Boolean);
  return Object.freeze({
    kind:'NexusGenerationProfilerDiagnostics',
    generationProfiling:Object.freeze({
      detailedEnabled,
      retainedProfiles:rows.filter(row=>row.detailed).length,
      captureStates:Object.freeze(rows.slice(-MAX_PROFILES).map(row=>Object.freeze({
        chatId:row.chatId??null,turnId:row.turnId??null,generationId:row.generationId,correlationId:row.correlationId??row.generationId,
        status:!row.detailed?'NOT_ARMED':row.endedAt||row.stoppedAt?'AVAILABLE':'ARMED',
      }))),
    }),
    retained:Object.freeze({nativePerformance:rows.length}),
    bounds:Object.freeze({nativePerformance:MAX_PROFILES}),
    heap:Object.freeze({supported:heapSample()!=null}),
    longTasks:Object.freeze({supported:false}),
  });
}

export function clearNexusGenerationProfiles(){
  profiles.clear();order.length=0;
}
