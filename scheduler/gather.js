import { GatherCoordinator, ResultClass } from '../nexus/a52/scatter-gather.js';
// Admission uses the existing Gather owner; only ephemeral next-frame carry is
// added here. Deadline closure never grants a late result mutation authority.
export class SchedulerGather {
 constructor(rows,{scope=null,deadline=null,now=Date.now,isFresh=()=>true,late=new Map(),emit=()=>{},tasks=null,envelope={},coordinatorClass=GatherCoordinator}={}){
  this.rows=new Map(rows.map(row=>[row.id,row]));this.scope=scope;this.deadline=deadline;this.now=now;this.isFresh=isFresh;this.late=late;this.emit=emit;this.sequence=0;
  this.counts={READY:0,STALE:0,LATE:0,INVALID:0};
  this.owner=new coordinatorClass({turnEvent:{...envelope,scope,deadline},plan:{tasks:tasks??rows.map(row=>({taskId:row.id,resultClass:ResultClass.REQUIRED}))}});
 }
 fresh(){try{return this.isFresh()!==false;}catch{return false;}}
 key(id,scope=this.scope){return JSON.stringify([id,scope]);}
 has(id){return this.owner.accepted.has(id);}
 async accept(id,payload){
  const row=this.rows.get(id);let verdict;
  try{
   const validation=row?await row.accept(payload,{scope:this.scope,deadline:this.deadline}):false;
   if(!this.fresh())verdict='STALE';
   else if(validation===false||validation?.valid===false)verdict='INVALID';
   else{
    if(this.deadline!=null&&this.now()>=this.deadline)this.close({at:this.now(),reason:'HARD_DEADLINE'});
    if(this.owner.closed){this.late.set(this.key(id,payload?.sourceScope??this.scope),{scope:payload?.sourceScope??this.scope,payload:structuredClone(payload)});verdict='LATE';}
    else{
     const admission=await this.owner.accept({taskId:id,resultId:`${id}:${++this.sequence}`,payload,completedAt:this.now()});
     verdict=admission.accepted?'READY':'INVALID';
    }
   }
  }catch{verdict='INVALID';}
  this.counts[verdict]++;try{this.emit('gather.verdict',{jobId:id,verdict});}catch{}
  return {accepted:verdict==='READY',verdict};
 }
 peekLate(id){const held=this.late.get(this.key(id));return held&&this.fresh()?structuredClone(held.payload):null;}
 takeLate(id){const key=this.key(id),held=this.late.get(key);this.late.delete(key);return held&&this.fresh()?structuredClone(held.payload):null;}
 addFallback(...args){return this.owner.addFallback(...args);}
 close(options={}){const bundle=this.owner.close(options);try{this.emit('gather.summary',{counts:{...this.counts}});}catch{}return bundle;}
 bundle(){return this.owner.bundle();}
}
