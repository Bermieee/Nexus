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
  // Two is a correctness invariant (one job per sidecar), not a capacity cap.
  let pending=[...ordered];const completed=new Set();
  while(pending.length){
    const ready=pending.filter(({row})=>(row.dependencies??[]).every(id=>completed.has(id)));
    const frame=budget?.beginTurn({timeMs:Math.max(1000,budget.estimate('scheduler.layer',1)*2),worldSize:pending.length});
    const allowance=frame?.compute('scheduler.layer',{total:ready.length,defaultUnits:2,defaultWorldSize:2,msPerUnit:1})??{allowed:2};
    // A post-turn envelope has no hard deadline. An expired local work slice
    // yields and renews; pending rows remain in this queue, never discarded.
    if(ready.length&&allowance.allowed===0){await yieldHost();continue;}
    const layer=ready.slice(0,Math.min(2,allowance.allowed));
    if(!layer.length)throw new Error('Scheduler dependencies are missing or cyclic');
    const layerStart=Date.now();
    await Promise.all(layer.map(execute));
    budget?.observe('scheduler.layer',{units:layer.length,durationMs:Date.now()-layerStart});
    for(const {row} of layer)completed.add(row.id);
    pending=pending.filter(({row})=>!completed.has(row.id));
    if(pending.length)await yieldHost();
  }
  gather.close({at:Date.now(),reason:'POST_TURN_SETTLED'});
  checkpoints.clear();return results;
}
