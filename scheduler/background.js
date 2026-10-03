import { isOwnerStep } from './owner-steps.js';
import { SchedulerGather } from './gather.js';
import { TASK8_POSTTURN_SITE_IDS, runTask8ChoiceDecision } from '../decision/task8-postturn-sites.js';
// One cooperative background lane. A yield is a completed owner step, never a
// cancelled provider call. Durable owner ledgers remain outside this scheduler.
export class BackgroundScheduler {
 constructor({captureScope=()=>null,isFresh=()=>true,emit=()=>{},yieldHost=()=>new Promise(r=>setTimeout(r,0))}={}){
  this.captureScope=captureScope;this.isFresh=isFresh;this.emit=emit;this.yieldHost=yieldHost;
  this.state='BACKGROUND';this.generationId=null;this.queue=[];this.checkpoints=new Map();this.running=false;this.sequence=0;
 }
 report(name,data){try{this.emit(name,data);}catch{}}
 transition(state){if(this.state===state)return;const previous=this.state;this.state=state;this.report('scheduler.lane',{previous,state,generationId:this.generationId});}
 key(entry){return JSON.stringify([entry.row.id,entry.scope]);}
 fresh(entry){try{return (typeof entry.row.isFresh==='function'?entry.row.isFresh(entry.scope):this.isFresh(entry.scope))!==false;}catch{return false;}}
 enqueue(row,{scope=this.captureScope()}={}){
  let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const entry={row,scope,input:row.inputs(scope),resolve,reject,iterator:null,pending:null,cancelled:false,index:++this.sequence};
  promise.cancel=()=>this.cancel(entry,'cancelled');
  this.queue.push(entry);this.kick();return promise;
 }
 cancel(entry,reason){
  if(entry.cancelled)return false;entry.cancelled=true;this.checkpoints.delete(this.key(entry));
  const error=new Error(`Background work invalidated: ${reason}`);error.name='TV2ScopeInvalidated';entry.reject(error);
  this.report('scheduler.checkpoint',{jobId:entry.row.id,action:'discard',reason});this.kick();return true;
 }
 loan(generationId){this.generationId=generationId;this.transition('LOANED');}
 resume(generationId=this.generationId){
  if(this.generationId!==null&&generationId!==this.generationId)return false;
  this.generationId=null;this.transition('RESUMING');this.transition('BACKGROUND');this.kick();return true;
 }
 clear(reason='chat-changed'){
  for(const entry of this.queue)this.cancel(entry,reason);
  this.checkpoints.clear();this.generationId=null;this.transition('BACKGROUND');this.kick();
 }
 snapshot(){return {state:this.state,generationId:this.generationId,queued:this.queue.filter(e=>!e.cancelled).length,checkpoints:this.checkpoints.size,running:this.running};}
 kick(){if(this.running||this.state!=='BACKGROUND')return;this.running=true;queueMicrotask(()=>this.drain());}
 async drain(){
  try{
   while(this.state==='BACKGROUND'){
    this.queue.sort((a,b)=>b.row.priority-a.row.priority||a.index-b.index);
    let entry=this.queue[0];if(!entry)break;
    const tied=this.queue.filter(candidate=>!candidate.cancelled&&candidate.row.priority===entry.row.priority);
    if(tied.length>1){
      const fallback=entry.row.id;
      const decision=await runTask8ChoiceDecision(TASK8_POSTTURN_SITE_IDS.BACKGROUND_ORDER,{
        state:{candidates:tied.slice(0,12).map(candidate=>({id:candidate.row.id,priority:candidate.row.priority}))},
      },fallback,{reasonCode:'STATIC_PRIORITY_TIE'});
      entry=tied.find(candidate=>candidate.row.id===decision.choice)??entry;
    }
    const remove=()=>{this.queue=this.queue.filter(e=>e!==entry);this.checkpoints.delete(this.key(entry));};
    try{
     if(entry.cancelled){await entry.iterator?.return?.();remove();continue;}
     // A committed terminal publication may advance its own source revision.
     // Permit only reading its completion receipt; any further work still needs freshness.
     const terminalAdvance=entry.publicationCommitted===true;entry.publicationCommitted=false;
     if(!this.fresh(entry)&&!terminalAdvance){
      if(entry.row.restartOnStale===false){this.cancel(entry,'stale-captured-inputs');await entry.iterator?.return?.();remove();continue;}
      await entry.iterator?.return?.();this.checkpoints.delete(this.key(entry));
      this.report('scheduler.checkpoint',{jobId:entry.row.id,action:'discard',reason:'stale-scope'});
      entry.scope=this.captureScope();entry.input=entry.row.inputs(entry.scope);entry.iterator=null;entry.pending=null;
      if(!this.fresh(entry)){this.cancel(entry,'fresh-scope-unavailable');remove();continue;}
     }
     const key=this.key(entry),savedState=this.checkpoints.get(key)??null;
     const ctx={scope:entry.scope,savedState,isFresh:()=>!entry.cancelled&&this.fresh(entry),checkpoint:state=>{
      if(!entry.cancelled){this.checkpoints.set(key,structuredClone(state));this.report('scheduler.checkpoint',{jobId:entry.row.id,action:'save'});}return state;
     }};
     if(!entry.iterator)entry.iterator=entry.row.steps(entry.input,ctx);
     else this.report('scheduler.checkpoint',{jobId:entry.row.id,action:'resume'});
     const step=entry.pending??await entry.iterator.next();entry.pending=null;
     if(entry.cancelled){await entry.iterator.return?.();remove();continue;}
     // The call may finish after admission loaned B. Hold its boundary/result;
     // it cannot start another step or publish until the turn has settled.
     if(isOwnerStep(step.value))ctx.checkpoint({position:step.value.position,kind:step.value.kind});
     if(this.state!=='BACKGROUND'){entry.pending=step;entry.publicationCommitted=terminalAdvance;break;}
     if(!this.fresh(entry)&&!(terminalAdvance&&step.done)){entry.pending=step;continue;}
     if(!step.done&&isOwnerStep(step.value)){
      const gather=new SchedulerGather([entry.row],{scope:entry.scope,isFresh:()=>this.fresh(entry)&&!entry.cancelled,emit:(name,data)=>this.report(name,data)});
      const admission=await gather.accept(entry.row.id,step.value);
      if(!admission.accepted)throw new Error('Background owner step rejected');
      if(this.state!=='BACKGROUND'){entry.pending=step;break;}
      if(!this.fresh(entry)){entry.pending=step;continue;}
      await entry.row.onResult(step.value,ctx);
      if(step.value.kind==='PUBLICATION')entry.publicationCommitted=true;
     }
     if(step.done){
      const accepted=await entry.row.accept(step.value,{scope:entry.scope,deadline:null});
      if(entry.cancelled){remove();continue;}
      if(!this.fresh(entry)&&!terminalAdvance){entry.pending=step;continue;}
      if(accepted===false||accepted?.valid===false){const error=new Error('Invalid background result');error.name='NexusInvalidResult';throw error;}
      await entry.row.onResult(step.value,ctx);entry.resolve(step.value);remove();
     }
    }catch(error){await entry.iterator?.return?.();entry.reject(error);remove();}
    await this.yieldHost();
   }
  }finally{this.running=false;if(this.state==='BACKGROUND'&&this.queue.length)this.kick();}
 }
}
