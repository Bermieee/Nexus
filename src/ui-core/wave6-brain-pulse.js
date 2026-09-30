import { RenderCost } from './constants.js';
import { ResourceScope } from './lifecycle.js';
import { Wave6Health, deepFreeze, clone } from './wave6-contracts.js';

const ACTIVE=new Set(['ACTIVE','WORKING','RUNNING','YIELDING','RECOVERING']);
const PAUSED=new Set(['PARKED','YIELDING','DEFERRED']);
const FAILED=new Set(['BLOCKED','ERROR','FAILED','UNAVAILABLE']);
const bounded=(items,max)=>items.slice(0,Math.max(1,max));

export class BrainPulseModel{
  #pending=new Map();
  constructor({runtime=null,coprocessor=null,scheduler,onUpdate=()=>{},maxActivity=20}={}){
    if(!scheduler?.invalidate)throw new TypeError('BrainPulseModel requires RenderScheduler-compatible scheduler');
    this.runtime=runtime;this.coprocessor=coprocessor;this.scheduler=scheduler;this.onUpdate=onUpdate;this.maxActivity=Math.max(4,Number(maxActivity)||20);
    this.scope=new ResourceScope();this.activity=[];this.sequence=0;this.mounted=false;
  }
  mount(){
    if(this.mounted)return this;this.mounted=true;
    const runtimeRelease=this.runtime?.subscribe?.((event)=>this.ingestRuntime(event));if(typeof runtimeRelease==='function')this.scope.add(runtimeRelease);
    const coprocessorRelease=this.coprocessor?.subscribe?.((event)=>this.ingestCoprocessor(event));if(typeof coprocessorRelease==='function')this.scope.add(coprocessorRelease);
    return this;
  }
  destroy(){this.scope.cleanup();this.#pending.clear();this.mounted=false;}
  ingestRuntime(event={}){
    const type=event.runtimeType??event.type??'RUNTIME_ACTIVITY',p=event.payload??event;
    let item=null;
    if(/WORK_(STARTED|RESUMED)/.test(type)||p.state==='ACTIVE')item={key:`runtime:${p.taskId??p.workerId??'active'}`,status:'active',meaning:p.layer==='L0'||p.layer==='L1'?'Foreground cognition active':'Background cognition active',lane:p.layer==='L0'||p.layer==='L1'?'HOT':'DEEP',resultClass:p.foreground?'REQUIRED':null};
    else if(/WORK_(YIELDING|PARKED)/.test(type)||PAUSED.has(p.state))item={key:`runtime:${p.taskId??p.workerId??'paused'}`,status:'paused',meaning:'Background cognition yielded without losing its work.',lane:'DEEP'};
    else if(/WORK_(BLOCKED|RECOVERING)/.test(type)||FAILED.has(p.state))item={key:`runtime:${p.taskId??p.workerId??'degraded'}`,status:'warning',meaning:'Cognitive work is degraded; generation may continue with reduced assistance.',lane:p.layer==='L0'||p.layer==='L1'?'HOT':'DEEP',attention:true};
    else if(/WORK_COMPLETED/.test(type)||p.state==='COMPLETE')item={key:`runtime:${p.taskId??p.workerId??'complete'}`,status:'complete',meaning:'Cognitive work completed.',lane:p.layer==='L0'||p.layer==='L1'?'HOT':'DEEP'};
    else if(type==='BATCH_CHECKPOINT'||event.type==='BATCH_PROGRESS_CHANGED')item={key:`batch:${p.taskId??p.batchId??'background'}`,status:'active',meaning:`Background cognition ${progress(p)} complete.`,lane:'DEEP',progress:progressNumber(p)};
    else if(/LATE|STALE/.test(type))item={key:`runtime:${type}`,status:'contained',meaning:'A late or stale result was contained outside current generation context.',lane:'DEEP'};
    if(item)this.#queue(item);
    return item;
  }
  ingestCoprocessor(event={}){
    const type=event.type??'COPROCESSOR_ACTIVITY',p=event.payload??event;let item=null;
    if(/WARM_HIT|CACHE_HIT/.test(type))item={key:'coprocessor:warm',status:'complete',meaning:'Relevant cognition was already warm for this turn.',lane:'DEEP'};
    else if(/STALE_DROPPED/.test(type))item={key:'coprocessor:stale',status:'contained',meaning:'Stale cognitive assistance was dropped before context delivery.',lane:'DEEP'};
    else if(/FALLBACK/.test(type))item={key:'coprocessor:fallback',status:'warning',meaning:'Cognition used a safe fallback; generation can continue.',lane:'HOT',attention:true};
    else if(/RESULT_ROUTED/.test(type))item={key:`coprocessor:route:${p.taskId??p.destination??'result'}`,status:'complete',meaning:`Cognitive result routed to ${human(p.destination??'its destination')}.`,lane:p.resultClass==='REQUIRED'?'HOT':'DEEP',resultClass:p.resultClass??null,destination:p.destination??null};
    else if(/WORKER|TASK|START|COMPLETE|PRECISION|RETRIEVAL/.test(type))item={key:`coprocessor:${p.taskId??p.workerId??type}`,status:/COMPLETE/.test(type)?'complete':'active',meaning:'Cognitive specialist work updated.',lane:p.resultClass==='REQUIRED'?'HOT':'DEEP',resultClass:p.resultClass??null};
    if(item)this.#queue(item);return item;
  }
  #queue(item){
    const normalized=deepFreeze({...item,sequence:++this.sequence});
    this.#pending.set(normalized.key,normalized);
    this.scheduler.invalidate('wave6:brain-pulse',()=>this.#flush(),{cost:RenderCost.CHEAP});
  }
  #flush(){
    const updates=[...this.#pending.values()].sort((a,b)=>b.sequence-a.sequence);this.#pending.clear();
    const keys=new Set(updates.map(x=>x.key));this.activity=bounded([...updates,...this.activity.filter(x=>!keys.has(x.key))],this.maxActivity);this.onUpdate(this.getSnapshot());
  }
  getSnapshot(){
    const runtime=this.runtime?.read?.()??null,coprocessor=this.coprocessor?.read?.()??null;
    const r=runtime?.data??{},c=coprocessor?.data??{};
    const foreground=Number(r.hotActivity??0),background=Number(r.deepActivity??0);
    const attention=this.activity.filter(x=>x.attention||x.status==='warning');
    const overall=[runtime?.source?.health,coprocessor?.source?.health].includes(Wave6Health.BLOCKED)?Wave6Health.BLOCKED:
      [runtime?.source?.health,coprocessor?.source?.health].includes(Wave6Health.DEGRADED)?Wave6Health.DEGRADED:
      foreground+background>0?Wave6Health.WORKING:Wave6Health.READY;
    const focus=foreground>0?'Foreground generation support':background>0?'Background story cognition':c?.precision?.requests>0?'Knowledge precision':'Ready';
    return deepFreeze({
      kind:'BrainPulseSnapshot',overall,currentFocus:focus,
      foreground:{active:foreground>0,count:foreground,label:foreground>0?'Foreground cognition active':'Foreground idle'},
      background:{active:background>0,count:background,label:background>0?'Background cognition active':'Background idle'},
      hotCount:foreground,deepCount:background,
      capabilityCounts:clone(capabilityCounts(c)),
      warm:clone(c?.warm??{hit:0,miss:0}),fallbackCount:Number(c?.fallback??0),staleDropCount:Number(c?.staleDrop??0),
      resultDestinations:clone(c?.resultDestinations??{}),attention:clone(attention),activity:clone(this.activity),
      nextBackgroundWork:background>0?'Background cognition is continuing.':null,
    });
  }
  get pendingCount(){return this.#pending.size;}
}

function capabilityCounts(c){if(!c)return{};if(c.capabilityCounts)return c.capabilityCounts;const out={};for(const worker of c.workers??[]){for(const cap of worker.capabilities??[])out[cap]=(out[cap]??0)+1;}return out;}
function progress(p){const n=progressNumber(p);return n==null?'updated':`${n}%`;}
function progressNumber(p){if(Number.isFinite(Number(p.progress)))return Math.max(0,Math.min(100,Number(p.progress)));if(Number.isFinite(Number(p.completedUnits))&&Number.isFinite(Number(p.totalUnits))&&Number(p.totalUnits)>0)return Math.round(Number(p.completedUnits)/Number(p.totalUnits)*100);return null;}
function human(v){return String(v??'').replace(/_/g,' ').toLowerCase();}
