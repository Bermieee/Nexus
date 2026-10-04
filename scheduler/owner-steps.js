const invalid=()=>Object.assign(new Error('Scheduler owner step rejected'),{name:'NexusSchedulerStepRejected',deferred:true});
export const isOwnerStep=value=>value?.schedulerOwnerStep===true;
// An identity shared only by immutable slices of one explicit worker batch.
// Ordinary concurrent owner calls retain their sequential checkpoint contract.
export const INDEPENDENT_OWNER_BATCH=Symbol('nexus.scheduler.independentOwnerBatch');
// Keeps the existing async owner and its lease alive, but does not let it cross
// a completed model call or a prepared publication until the scheduler advances.
export async function* ownerSteps(execute,{enqueue=null,input=null,savedState=null}={}){
 let waiting=null,wake=null,closed=false,position=Number(savedState?.position)||0;const queue=[],active=new Map();let group=null;
 const notify=()=>{const fn=wake;wake=null;fn?.();};
 const boundary=(kind,result,validate=()=>true,commit=null)=>new Promise((resolve,reject)=>{
  if(closed){reject(invalid());return;}
  const step={schedulerOwnerStep:true,kind,position:++position,accept:()=>validate(result),
   publish:async()=>{if(closed)throw invalid();try{const value=commit?await commit():result;resolve(value);return value;}catch(error){reject(error);throw error;}},
   reject};queue.push(step);notify();
 });
 const dispatch=(stage,options)=>{
  let physical=null,cancelled=false,resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  if(closed){reject(invalid());return {promise};}
  const request={request:true,group:options?.[INDEPENDENT_OWNER_BATCH],reject,cancel:()=>physical?.cancel?.('owner closed'),run:async()=>{
   let result,error;
   try{if(cancelled||closed)throw invalid();physical=enqueue(stage,options);result=await (physical?.promise??physical);}catch(caught){error=caught;}
   return {schedulerOwnerStep:true,kind:'MODEL_CALL',position:++position,
    accept:()=>error!=null||result!==undefined,
    publish:async()=>{if(closed){reject(invalid());return;}if(error)reject(error);else resolve(result);},reject};
  }};
  queue.push(request);notify();
  return new Proxy({promise,cancel:reason=>{cancelled=true;physical?.cancel?.(reason);reject(invalid());}},{get(target,key){return key in target?target[key]:physical?.[key];}});
 };
 dispatch.checkpoint=state=>boundary('MODEL_CALL',state);
 dispatch.publish=(candidate,validate,commit)=>boundary('PUBLICATION',candidate,validate,commit);
 const driver=Promise.resolve().then(()=>execute({enqueue:dispatch,input,savedState})).then(value=>{queue.push({done:true,value});notify();},error=>{queue.push({done:true,error});notify();});
 try{
  while(true){
   if(!queue.length&&!active.size)await new Promise(resolve=>{wake=resolve;});
   let step;
   if(active.size||queue[0]?.group){
    group??=queue[0].group;
    while(queue[0]?.request&&queue[0].group===group){
     const request=queue.shift();active.set(request,request.run().then(step=>({request,step})));
    }
    const completed=await Promise.race([...active.values(),new Promise(resolve=>{wake=()=>resolve({notified:true});})]);
    wake=null;
    if(completed.notified)continue;
    active.delete(completed.request);step=completed.step;
    if(!active.size)group=null;
   }else{
    step=queue.shift();if(step.request)step=await step.run();
   }
   if(step.done){if(step.error)throw step.error;return step.value;}
   waiting=step;yield step;
   if(step.kind==='MODEL_CALL')await step.publish();
   waiting=null;
  }
 }finally{closed=true;waiting?.reject(invalid());for(const request of active.keys()){request.cancel();request.reject(invalid());}for(const step of queue)step.reject?.(invalid());await driver;}
}
export function publishOwnerResult(enqueue,candidate,validate,commit){
 if(typeof enqueue?.publish==='function')return enqueue.publish(candidate,validate,commit);
 if(validate(candidate)===false)throw invalid();return commit();
}
