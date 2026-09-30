import { GatherCoordinator, ResultClass, yieldScatterHost } from '../nexus/a52/scatter-gather.js';

// Physical execution stays with existing bus/leases inside the row executors.
// This layer never creates an alternate provider or canonical state writer.
export async function runJobTable(rows,{scope,isFresh=()=>true,yieldHost=yieldScatterHost,emit=()=>{},budget=null}={}){
  const checkpoints=new Map();
  const fresh=()=>{try{return isFresh()!==false;}catch{return false;}};
  const queue=rows.map((row,index)=>({row,index,input:row.inputs(scope)}));
  const ordered=[...queue].sort((a,b)=>b.row.priority-a.row.priority||a.index-b.index);
  const results=new Array(queue.length);
  const report=(name,data)=>{try{emit(name.startsWith('gather.')?'nexus.gather':'nexus.scatter',name,{chatId:scope?.chatId??null,...data},'debug');}catch{}};
  const byId=new Map(rows.map(row=>[row.id,row]));
  const envelope={scope,deadline:null};
  const gather=new GatherCoordinator({turnEvent:envelope,plan:{tasks:rows.map(row=>({taskId:row.id,resultClass:ResultClass.REQUIRED}))},
    validateResult:raw=>byId.get(raw.taskId).accept(raw.payload,envelope)});
  report('scheduler.plan',{taskCount:ordered.length,jobIds:ordered.map(({row})=>row.id),reasonCodes:ordered.map(({row})=>row.planningReason??'EXISTING_LIFECYCLE_DUE'),lane:'postTurn',reasonCode:'EXISTING_LIFECYCLE_DUE'});
  async function execute({row,index,input}){
    if(!fresh()){results[index]={id:row.id,status:'fulfilled',value:{deferred:true,stale:true,reason:'scope-invalidated'}};return;}
    const startedAt=Date.now();
    const ctx={scope,checkpoint:state=>{checkpoints.set(row.id,state);return {jobId:row.id,state};},savedState:checkpoints.get(row.id)??null};
    try{
      const iterator=row.steps(input,ctx);
      let step=await iterator.next();
      while(!step.done){
        if(!fresh()){await iterator.return?.();results[index]={id:row.id,status:'fulfilled',value:{deferred:true,stale:true,reason:'scope-invalidated'}};return;}
        step=await iterator.next();
      }
      if(!fresh()){results[index]={id:row.id,status:'fulfilled',value:{deferred:true,stale:true,reason:'scope-invalidated'}};return;}
      const verdict=await gather.accept({taskId:row.id,resultId:row.id,payload:step.value,completedAt:Date.now()});
      report('gather.verdict',{jobId:row.id,verdict:verdict.accepted?'READY':'REJECTED_INVALID'});
      if(!verdict.accepted){results[index]={id:row.id,status:'fulfilled',value:{skipped:true,reason:'invalid-result'}};return;}
      await row.onResult(step.value,ctx);
      results[index]={id:row.id,status:'fulfilled',value:step.value};
    }catch(reason){results[index]={id:row.id,status:'rejected',reason};}
    finally{checkpoints.delete(row.id);budget?.observe(row.id,{units:1,durationMs:Date.now()-startedAt});}
  }
  // Two is a correctness invariant (one job per sidecar), not a capacity cap.
  let pending=[...ordered];const completed=new Set();
  while(pending.length){
    const layer=pending.filter(({row})=>(row.dependencies??[]).every(id=>completed.has(id))).slice(0,2);
    if(!layer.length)throw new Error('Scheduler dependencies are missing or cyclic');
    await Promise.all(layer.map(execute));
    for(const {row} of layer)completed.add(row.id);
    pending=pending.filter(({row})=>!completed.has(row.id));
    if(pending.length)await yieldHost();
  }
  gather.close({at:Date.now(),reason:'POST_TURN_SETTLED'});
  checkpoints.clear();return results;
}
