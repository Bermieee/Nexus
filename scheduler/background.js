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
 fresh(entry){try{return this.isFresh(entry.scope)!==false;}catch{return false;}}
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
    const entry=this.queue[0];if(!entry)break;
    const remove=()=>{this.queue=this.queue.filter(e=>e!==entry);this.checkpoints.delete(this.key(entry));};
    try{
     if(entry.cancelled){await entry.iterator?.return?.();remove();continue;}
     if(!this.fresh(entry)){
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
     if(this.state!=='BACKGROUND'){entry.pending=step;break;}
     if(!this.fresh(entry)){entry.pending=step;continue;}
     if(step.done){
      const accepted=await entry.row.accept(step.value,{scope:entry.scope,deadline:null});
      if(entry.cancelled){remove();continue;}
      if(!this.fresh(entry)){entry.pending=step;continue;}
      if(accepted===false||accepted?.valid===false){const error=new Error('Invalid background result');error.name='NexusInvalidResult';throw error;}
      await entry.row.onResult(step.value,ctx);entry.resolve(step.value);remove();
     }
    }catch(error){entry.reject(error);remove();}
    await this.yieldHost();
   }
  }finally{this.running=false;if(this.state==='BACKGROUND'&&this.queue.length)this.kick();}
 }
}
