function clone(value){try{return structuredClone(value);}catch{return JSON.parse(JSON.stringify(value));}}
function clean(value){return String(value??'').trim();}

/**
 * Tracks physical lifecycle execution independently from logical cycle authority.
 * Releasing/invalidation of a logical cycle never removes a live physical lease;
 * the lease disappears only when its executor promise settles.
 */
export class LifecycleExecutionLeaseRegistry{
  constructor({now=()=>Date.now(),onChange=null,onRelease=null}={}){
    this.now=now;this.onChange=onChange;this.onRelease=onRelease;this.leases=new Map();this.byWorkUnit=new Map();
  }
  snapshot(){return [...this.leases.values()].map(lease=>({
    leaseId:lease.leaseId,workUnitId:lease.workUnitId,conflictKey:lease.conflictKey,cycleId:lease.cycleId,task:lease.task,
    startedAt:lease.startedAt,logicalInvalidated:lease.logicalInvalidated===true,invalidatedAt:lease.invalidatedAt||0,invalidatedReason:lease.invalidatedReason||null,
  }));}
  #emit(type,lease,extra={}){try{this.onChange?.(type,clone({...lease,promise:undefined}),clone(extra));}catch{}}
  invalidateCycle(cycleId,reason='logical-cycle-invalidated'){
    const id=clean(cycleId);let count=0;
    for(const lease of this.leases.values()){
      if(clean(lease.cycleId)!==id)continue;
      lease.logicalInvalidated=true;lease.invalidatedAt=this.now();lease.invalidatedReason=String(reason||'logical-cycle-invalidated');count+=1;
      this.#emit('logical-invalidated',lease,{reason:lease.invalidatedReason});
    }
    return count;
  }
  activeForConflict(conflictKey){const lease=this.leases.get(clean(conflictKey));return lease?clone({...lease,promise:undefined}):null;}
  activeForWorkUnit(workUnitId){const lease=this.byWorkUnit.get(clean(workUnitId));return lease?clone({...lease,promise:undefined}):null;}
  async run({workUnitId,conflictKey,cycleId=null,task='lifecycle-task',waitForConflict=false,execute}={}){
    const unit=clean(workUnitId),conflict=clean(conflictKey)||unit;
    if(!unit)throw new Error('Lifecycle execution lease requires workUnitId.');
    if(!conflict)throw new Error('Lifecycle execution lease requires conflictKey.');
    if(typeof execute!=='function')throw new Error('Lifecycle execution lease requires execute().');
    const identical=this.byWorkUnit.get(unit);
    if(identical){
      this.#emit('joined',identical,{cycleId,task});
      const value=await identical.promise;
      return {joined:true,leaseId:identical.leaseId,ownerCycleId:identical.cycleId,value};
    }
    const occupied=this.leases.get(conflict);
    if(occupied){
      if(!waitForConflict)return {deferred:true,reason:'physical-owner-active',workUnitId:unit,conflictKey:conflict,ownerWorkUnitId:occupied.workUnitId,ownerCycleId:occupied.cycleId,leaseId:occupied.leaseId};
      try{await occupied.promise;}catch{}
      return await this.run({workUnitId:unit,conflictKey:conflict,cycleId,task,waitForConflict:false,execute});
    }
    const lease={leaseId:`tv2_lifecycle_lease_${this.now()}_${Math.random().toString(36).slice(2,8)}`,workUnitId:unit,conflictKey:conflict,cycleId:clean(cycleId)||null,task:clean(task)||'lifecycle-task',startedAt:this.now(),logicalInvalidated:false,promise:null};
    const promise=Promise.resolve().then(()=>execute({leaseId:lease.leaseId,workUnitId:unit,conflictKey:conflict}));
    lease.promise=promise;this.leases.set(conflict,lease);this.byWorkUnit.set(unit,lease);this.#emit('acquired',lease);
    try{return {joined:false,leaseId:lease.leaseId,ownerCycleId:lease.cycleId,value:await promise};}
    finally{
      if(this.leases.get(conflict)===lease)this.leases.delete(conflict);
      if(this.byWorkUnit.get(unit)===lease)this.byWorkUnit.delete(unit);
      const endedAt=this.now();this.#emit('released',lease,{endedAt,durationMs:Math.max(0,endedAt-lease.startedAt)});
      try{this.onRelease?.(clone({...lease,promise:undefined}),{endedAt});}catch{}
    }
  }
}
