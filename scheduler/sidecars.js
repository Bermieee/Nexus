import { BackgroundScheduler } from './background.js';
const retryable=error=>['TV2SidecarWorkerUnavailable','TV2MultiWorkerUnavailable','TV2ExecutionProfileRetired','TV2SidecarTransportError','TV2SidecarTimeout'].includes(error?.name);
const stale=()=>Object.assign(new Error('Scheduler request scope changed'),{name:'TV2ScopeInvalidated'});
export class SidecarScheduler {
 constructor({captureScope=()=>null,isFresh=()=>true,emit=()=>{}}={}){
  this.captureScope=captureScope;this.isFresh=isFresh;this.emit=emit;this.lateResults=new Map();this.busy=new Map();this.waiters=[];this.sequence=0;
  this.background=new BackgroundScheduler({captureScope:()=>this.captureScope(),isFresh:scope=>this.isFresh(scope),emit:(name,data)=>this.report(name,data)});
 }
 report(name,data){try{this.emit(name,data);}catch{}}
 loan(id){this.background.loan(id);this.pump();}
 resume(id){const resumed=this.background.resume(id);this.pump();return resumed;}
 clear(reason='chat-changed'){
  this.background.clear(reason);this.lateResults.clear();
  for(const entry of [...this.waiters])entry.fail(stale());
 }
 snapshot(){return {...this.background.snapshot(),slots:[...this.busy.keys()],waiting:this.waiters.length};}
 pump(){
  this.waiters.sort((a,b)=>(b.request.lane==='foreground')-(a.request.lane==='foreground')||b.request.priority-a.request.priority||a.index-b.index);
  for(const entry of [...this.waiters]){
   const request=entry.request;
   if(!this.isFresh(request.scope)){entry.fail(stale());continue;}
   if(request.deadline!=null&&Date.now()>=request.deadline){entry.fail(Object.assign(new Error('Scheduler foreground deadline elapsed'),{name:'NexusSchedulerDeadline',deferred:true}));continue;}
   const slots=request.lane==='background'?(this.background.state==='BACKGROUND'?['B']:[]):['A','B'];
   const slot=slots.find(value=>!this.busy.has(value));if(!slot)continue;
   this.busy.set(slot,request);entry.finish(slot);
  }
 }
 acquire(request){return new Promise((resolve,reject)=>{
  const entry={request,index:++this.sequence,timer:null};
  const remove=()=>{this.waiters=this.waiters.filter(e=>e!==entry);clearTimeout(entry.timer);request.signal?.removeEventListener('abort',abort);};
  entry.fail=error=>{remove();reject(error);};entry.finish=slot=>{remove();resolve(slot);};
  const abort=()=>entry.fail(request.signal.reason??stale());
  if(request.signal?.aborted){reject(request.signal.reason??stale());return;}
  request.signal?.addEventListener('abort',abort,{once:true});
  if(request.deadline!=null)entry.timer=setTimeout(()=>entry.fail(Object.assign(new Error('Scheduler foreground deadline elapsed'),{name:'NexusSchedulerDeadline',deferred:true})),Math.max(0,request.deadline-Date.now()));
  this.waiters.push(entry);this.pump();
 });}
 async physical(request){
  let slot=await this.acquire(request);
  try{
   try{return await request.run(slot);}
   catch(error){
    const other=slot==='A'?'B':'A';
    // One failover, only to an immediately free eligible slot. A running
    // higher-priority turn is never queued behind by a background retry.
    const allowed=request.lane!=='background'||this.background.state==='BACKGROUND';
    if(!retryable(error)||!allowed||this.busy.has(other)||request.signal?.aborted||!this.isFresh(request.scope)||(request.deadline!=null&&Date.now()>=request.deadline))throw error;
    this.busy.delete(slot);this.busy.set(other,request);
    this.report('scheduler.failover',{jobId:request.id,lane:request.lane,from:slot,to:other});slot=other;
    return await request.run(slot);
   }
  }finally{this.busy.delete(slot);this.pump();}
 }
 execute(options){
  const request={id:`physical-${++this.sequence}`,priority:0,scope:this.captureScope(),...options};
  if(request.lane!=='background')return this.physical(request).then(result=>{if(!this.isFresh(request.scope))throw stale();return result;});
  const scheduler=this;
  const work=this.background.enqueue({id:request.id,lane:'background',priority:request.priority,restartOnStale:false,
   inputs:()=>request,async *steps(input,ctx){const result=await scheduler.physical(input);yield ctx.checkpoint({complete:true});return result;},
   accept:()=>this.isFresh(request.scope),onResult:()=>{},
  },{scope:request.scope});
  const abort=()=>work.cancel();request.signal?.addEventListener('abort',abort,{once:true});if(request.signal?.aborted)abort();
  const result=work.finally(()=>request.signal?.removeEventListener('abort',abort));result.cancel=work.cancel;return result;
 }
}
export const sidecarScheduler=new SidecarScheduler();
export function configureSidecarScheduler({captureScope,isFresh,emit}){
 if(captureScope)sidecarScheduler.captureScope=captureScope;if(isFresh)sidecarScheduler.isFresh=isFresh;if(emit)sidecarScheduler.emit=emit;
}
