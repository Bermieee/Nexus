import { isOwnerStep } from './owner-steps.js';
import { SchedulerGather } from './gather.js';
import { yieldScatterHost } from '../nexus/a52/scatter-gather.js';
import { recordDecisionRecord } from '../decision/records.js';

// Physical execution stays with existing bus/leases inside the row executors.
// This layer never creates an alternate provider or canonical state writer.
export async function runJobTable(rows,{scope,generationId=null,isFresh=()=>true,yieldHost=yieldScatterHost,emit=()=>{},budget=null,enqueue=null}={}){
  const checkpoints=new Map();
  const fresh=()=>{try{return isFresh()!==false;}catch{return false;}};
  const queue=rows.map((row,index)=>({row,index,input:row.inputs(scope)}));
  const ordered=[...queue].sort((a,b)=>b.row.priority-a.row.priority||a.index-b.index);
  const results=new Array(queue.length);
  const report=(name,data)=>{try{emit(name.startsWith('gather.')?'nexus.gather':'nexus.scatter',name,{chatId:scope?.chatId??null,generationId,...data},'debug');}catch{}};
  const envelope={scope,deadline:null};
  const gather=new SchedulerGather(rows,{scope,isFresh:fresh,emit:(name,data)=>report(name,data)});
  report('scheduler.plan',{taskCount:ordered.length,jobIds:ordered.map(({row})=>row.id),reasonCodes:ordered.map(({row})=>row.planningReason??'EXISTING_LIFECYCLE_DUE'),lane:'postTurn',reasonCode:'EXISTING_LIFECYCLE_DUE'});
  recordDecisionRecord({site:'scheduler.plan',subsystem:'scheduler',selection:{chatId:scope?.chatId??null,generationId},subject:{type:'job',id:generationId??scope?.chatId??'scheduler.plan'},options:['RUN_DUE','SKIP_STALE'],chosen:ordered.length?'RUN:'+ordered.map(({row})=>row.id).join(','):'NO_DUE_WORK',source:'fallback',reasonCode:'RULE_FALLBACK',budget:{granted:ordered.length,used:0,deferred:0}});
  async function execute({row,index,input}){
    if(!fresh()){results[index]={id:row.id,status:'fulfilled',value:{deferred:true,stale:true,reason:'scope-invalidated'}};return;}
    const startedAt=Date.now();
    const ctx={scope,enqueue,checkpoint:state=>{checkpoints.set(row.id,state);return {jobId:row.id,state};},savedState:checkpoints.get(row.id)??null};
    let iterator,publicationCommitted=false;
    try{
      iterator=row.steps(input,ctx);
      let step=await iterator.next();
      while(!step.done){
        if(!fresh()){await iterator.return?.();results[index]={id:row.id,status:'fulfilled',value:{deferred:true,stale:true,reason:'scope-invalidated'}};return;}
        if(isOwnerStep(step.value)){
          const boundary=step.value;
          ctx.checkpoint({position:boundary.position,kind:boundary.kind});
          const admission=new SchedulerGather([row],{scope,isFresh:fresh,emit:(name,data)=>report(name,{...data,position:boundary.position})});
          const verdict=await admission.accept(row.id,boundary);
          if(!verdict.accepted){await iterator.return?.();results[index]={id:row.id,status:'fulfilled',value:{skipped:true,reason:'invalid-result'}};return;}
          if(!fresh()){await iterator.return?.();results[index]={id:row.id,status:'fulfilled',value:{deferred:true,stale:true,reason:'scope-invalidated'}};return;}
          await row.onResult(boundary,ctx);
          publicationCommitted=boundary.kind==='PUBLICATION';
          await yieldHost();
        }
        // A host yield can switch chats or edit the source. Recheck before
        // advancing the owner, which may enqueue its next physical slice.
        // An already admitted publication still gets its terminal receipt.
        if(!publicationCommitted&&!fresh()){
          await iterator.return?.();results[index]={id:row.id,status:'fulfilled',value:{deferred:true,stale:true,reason:'scope-invalidated'}};return;
        }
        step=await iterator.next();
      }
      if(!fresh()){
        if(publicationCommitted){
          const valid=await row.accept(step.value,envelope);
          results[index]=valid===false||valid?.valid===false?{id:row.id,status:'fulfilled',value:{skipped:true,reason:'invalid-result'}}:{id:row.id,status:'fulfilled',value:step.value};
          report('scheduler.completed',{jobId:row.id,reason:'OWNER_PUBLICATION_ALREADY_ADMITTED'});return;
        }
        results[index]={id:row.id,status:'fulfilled',value:{deferred:true,stale:true,reason:'scope-invalidated'}};return;
      }
      const verdict=await gather.accept(row.id,step.value);
      if(!fresh()){results[index]={id:row.id,status:'fulfilled',value:{deferred:true,stale:true,reason:'scope-invalidated'}};return;}
      if(!verdict.accepted){results[index]={id:row.id,status:'fulfilled',value:{skipped:true,reason:'invalid-result'}};return;}
      await row.onResult(step.value,ctx);
      results[index]={id:row.id,status:'fulfilled',value:step.value};
    }catch(reason){await iterator?.return?.();results[index]={id:row.id,status:'rejected',reason};}
    finally{checkpoints.delete(row.id);budget?.observe(row.id,{units:1,durationMs:Date.now()-startedAt});}
  }
  // Two is a correctness invariant (one job per sidecar), not a capacity cap. Rows start in priority order as
  // soon as their dependencies are done and fewer than two are running, so a sidecar that frees up is refilled
  // immediately instead of waiting for the slower row of a pair. A row that finishes instantly (nothing due)
  // gives its place straight back.
  let pending=[...ordered];const completed=new Set(),running=new Set();
  while(pending.length||running.size){
    const ready=pending.filter(({row})=>!running.has(row.id)&&(row.dependencies??[]).every(id=>completed.has(id)));
    if(!ready.length&&!running.size)throw new Error('Scheduler dependencies are missing or cyclic');
    // A post-turn envelope has no hard deadline. An expired local work slice
    // yields and renews; pending rows remain in this queue, never discarded.
    const frame=ready.length?budget?.beginTurn({timeMs:Math.max(1000,budget.estimate('scheduler.layer',1)*2),worldSize:pending.length}):null;
    const allowance=ready.length?(frame?.compute('scheduler.layer',{total:ready.length,defaultUnits:2,defaultWorldSize:2,msPerUnit:1})??{allowed:2}):{allowed:0};
    if(ready.length&&allowance.allowed===0&&!running.size){await yieldHost();continue;}
    const room=Math.max(0,Math.min(2,allowance.allowed)-running.size);
    for(const item of ready.slice(0,room)){
      const startedAt=Date.now();
      const work=execute(item).then(()=>{
        running.delete(work);completed.add(item.row.id);
        budget?.observe('scheduler.layer',{units:1,durationMs:Date.now()-startedAt});
      });
      running.add(work);pending=pending.filter(entry=>entry!==item);
    }
    if(running.size){await Promise.race(running);if(pending.length||running.size)await yieldHost();}
  }
  gather.close({at:Date.now(),reason:'POST_TURN_SETTLED'});
  checkpoints.clear();return results;
}
