import { deepFreeze, clone } from './wave6-contracts.js';

const DEFAULT_MAX=64;
const SAFE_DETAIL_KEYS=new Set(['jobs','resources','results','admitted','pendingBefore','pendingAfter','coalesced','waveCount','deferred','concurrency','writes','entries','visibleRows']);

export class OperatorLoadTrace{
  constructor({maxSamples=DEFAULT_MAX,clock=null}={}){
    this.maxSamples=Math.max(8,Math.min(256,Number(maxSamples)||DEFAULT_MAX));
    this.clock=typeof clock==='function'?clock:()=>globalThis.performance?.now?.()??Date.now();
    this.samples=[];this.sequence=0;
  }
  now(){return Number(this.clock());}
  measure(category,fn,meta={}){
    const start=this.now();
    try{return fn();}
    finally{this.record(category,Math.max(0,this.now()-start),meta);}
  }
  record(category,durationMs=0,{selection=null,details=null}={}){
    const sample=deepFreeze({
      sequence:++this.sequence,category:String(category||'UI'),durationMs:finite(durationMs),
      selection:safeSelection(selection),details:safeDetails(details),
    });
    this.samples.push(sample);
    if(this.samples.length>this.maxSamples)this.samples.splice(0,this.samples.length-this.maxSamples);
    return sample;
  }
  snapshot(){
    const categories={};
    for(const row of this.samples){
      const stat=categories[row.category]??{count:0,totalMs:0,maxMs:0,lastMs:0};
      stat.count+=1;stat.totalMs+=row.durationMs;stat.maxMs=Math.max(stat.maxMs,row.durationMs);stat.lastMs=row.durationMs;categories[row.category]=stat;
    }
    for(const stat of Object.values(categories)){stat.totalMs=round(stat.totalMs);stat.maxMs=round(stat.maxMs);stat.lastMs=round(stat.lastMs);stat.avgMs=stat.count?round(stat.totalMs/stat.count):0;}
    return deepFreeze({kind:'OperatorUiLoadTrace',bounded:true,maxSamples:this.maxSamples,retainedSamples:this.samples.length,sequence:this.sequence,categories:clone(categories),recent:clone(this.samples.slice(-16)),rawPromptTelemetry:false});
  }
  clear(){this.samples.length=0;this.sequence=0;}
}

function safeSelection(value){
  if(!value||typeof value!=='object')return null;
  return deepFreeze({
    chatId:text(value.chatId),turnId:text(value.turnId),generationId:text(value.generationId),correlationId:text(value.correlationId),
    worldRevision:finiteOrNull(value.worldRevision),sceneRevision:finiteOrNull(value.sceneRevision),
    sourceRevisionRefCount:Array.isArray(value.sourceRevisionRefs)?Math.min(64,value.sourceRevisionRefs.length):0,
  });
}
function safeDetails(value){
  if(!value||typeof value!=='object')return null;
  const out={};
  for(const [key,row] of Object.entries(value)){
    if(!SAFE_DETAIL_KEYS.has(key))continue;
    if(typeof row==='boolean')out[key]=row;
    else if(typeof row==='number'&&Number.isFinite(row))out[key]=row;
    else if(typeof row==='string')out[key]=row.slice(0,80);
  }
  return deepFreeze(out);
}
function text(value){return value==null?null:String(value).slice(0,160);}
function finite(value){const n=Number(value);return Number.isFinite(n)?round(Math.max(0,n)):0;}
function finiteOrNull(value){if(value==null)return null;const n=Number(value);return Number.isFinite(n)?n:null;}
function round(value){return Math.round(Number(value)*1000)/1000;}
