function clone(value){try{return structuredClone(value);}catch{return JSON.parse(JSON.stringify(value));}}
function clean(value){return String(value??'').trim();}
function clampInt(value,min,max,fallback){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.floor(n))):fallback;}
function uniqueIds(values=[]){return [...new Set((Array.isArray(values)?values:[]).map(clean).filter(Boolean))];}
function leaseId(workId,unitId,attempt,now){return `${clean(workId)}:${clean(unitId)}:${Math.max(1,Number(attempt)||1)}:${Number(now)||Date.now()}`;}
const TERMINAL=new Set(['complete','stale','cancelled','superseded']);
const UNIT_TERMINAL=new Set(['complete','stale']);

function normalizeUnitState(value={}){
  const row=value&&typeof value==='object'&&!Array.isArray(value)?clone(value):{};
  row.state=clean(row.state)||'pending';
  row.attempts=Math.max(0,Number(row.attempts)||0);
  row.leaseId=clean(row.leaseId)||null;
  row.startedAt=Math.max(0,Number(row.startedAt)||0);
  row.completedAt=Math.max(0,Number(row.completedAt)||0);
  row.lastError=row.lastError==null?null:String(row.lastError);
  if(row.state==='running'||row.state==='executing'||row.state==='leased'){
    // A persisted executing intent with no live process is indeterminate after
    // reload. Never silently replay it: the owner must reconcile the effect.
    row.state='recovery-required';
    row.recoveryReason='reload-after-execution-intent';
    row.leaseId=null;
  }
  if(!['pending','running','complete','stale','recovery-required'].includes(row.state))row.state='pending';
  return row;
}

function ensureUnitStates(record,{hydrate=false}={}){
  if(!record.unitStates||typeof record.unitStates!=='object'||Array.isArray(record.unitStates))record.unitStates={};
  const allowed=new Set(record.unitIds||[]);
  for(const id of record.unitIds||[]){
    if(hydrate)record.unitStates[id]=normalizeUnitState(record.unitStates[id]);
    else if(!record.unitStates[id]||typeof record.unitStates[id]!=='object'||Array.isArray(record.unitStates[id]))record.unitStates[id]=normalizeUnitState({state:'pending'});
  }
  for(const id of Object.keys(record.unitStates))if(!allowed.has(id))delete record.unitStates[id];
  return record.unitStates;
}

function applyProgress(record){
  ensureUnitStates(record);
  record.completedUnitIds=(record.unitIds||[]).filter(id=>record.unitStates[id]?.state==='complete');
  record.recoveryRequiredUnitIds=(record.unitIds||[]).filter(id=>record.unitStates[id]?.state==='recovery-required');
  record.runningUnitIds=(record.unitIds||[]).filter(id=>record.unitStates[id]?.state==='running');
  record.remainingUnitIds=(record.unitIds||[]).filter(id=>!UNIT_TERMINAL.has(record.unitStates[id]?.state)&&record.unitStates[id]?.state!=='recovery-required');
  const total=record.unitIds?.length||0,done=record.completedUnitIds.length;
  record.progressPct=total?Math.max(0,Math.min(100,Math.floor((done/total)*100))):100;
  record.completedUnits=done;
  record.totalUnits=total;
  record.remainingUnits=record.remainingUnitIds.length;
  record.recoveryRequiredUnits=record.recoveryRequiredUnitIds.length;
  record.physicalState=record.runningUnitIds.length?'running':record.recoveryRequiredUnitIds.length?'indeterminate':'idle';
  return record;
}

function normalizeRecord(value,now=Date.now()){
  const record=value&&typeof value==='object'&&!Array.isArray(value)?clone(value):{};
  record.version=2;
  record.workId=clean(record.workId);
  record.ownerSubsystem=clean(record.ownerSubsystem);
  record.freshnessPolicy=clean(record.freshnessPolicy)||'OWNER_DECIDES';
  record.priority=Number(record.priority)||0;
  record.unitIds=uniqueIds(record.unitIds||[]);
  record.sourceProof=clone(record.sourceProof??null);
  record.metadata=clone(record.metadata||{});
  record.results=record.results&&typeof record.results==='object'&&!Array.isArray(record.results)?clone(record.results):{};
  record.state=clean(record.state)||(record.unitIds.length?'pending':'complete');
  record.publishState=clean(record.publishState)||'unpublished';
  record.createdAt=Math.max(0,Number(record.createdAt)||Number(now)||Date.now());
  record.updatedAt=Math.max(0,Number(record.updatedAt)||record.createdAt);
  record.lastError=record.lastError==null?null:String(record.lastError);
  ensureUnitStates(record,{hydrate:true});
  applyProgress(record);
  if(record.recoveryRequiredUnitIds.length&&!TERMINAL.has(record.state))record.state='recovery-required';
  else if(record.state==='running'&&!record.runningUnitIds.length)record.state=record.remainingUnitIds.length?'pending':'complete';
  return record;
}

function checkpointError(error,{workId=null,unitId=null,phase='checkpoint',effectMayHaveCommitted=false}={}){
  const wrapped=new Error(`Continuable work checkpoint failed during ${phase}: ${error?.message||String(error)}`);
  wrapped.name='TV2ContinuableCheckpointUnavailable';
  wrapped.cause=error;
  wrapped.workId=workId;
  wrapped.unitId=unitId;
  wrapped.phase=phase;
  wrapped.effectMayHaveCommitted=effectMayHaveCommitted===true;
  wrapped.recoveryRequired=effectMayHaveCommitted===true;
  return wrapped;
}

export function selectContinuableUnits(items=[],maxUnits=1){
  const source=Array.isArray(items)?items:[];
  return source.slice(0,clampInt(maxUnits,1,10000,1));
}

/**
 * Durable execution checkpoints only. This store deliberately does NOT own
 * semantic/narrative coverage (Summary/Digest coverage receipts remain under
 * Memory Bank authority). A completed execution unit can prevent a duplicate
 * physical effect; it cannot prove that narrative coverage is still durable.
 */
export class ContinuableWorkStore{
  constructor({onCheckpoint=null,initialRecords=[],now=()=>Date.now()}={}){
    this.records=new Map();
    this.onCheckpoint=onCheckpoint;
    this.now=now;
    this.hydrate(initialRecords);
  }
  hydrate(records=[]){
    const source=records instanceof Map?[...records.values()]:Array.isArray(records)?records:Object.values(records||{});
    for(const value of source){
      const record=normalizeRecord(value,this.now());
      if(record.workId&&record.ownerSubsystem)this.records.set(record.workId,record);
    }
    return this.list();
  }
  snapshot(){return this.list();}
  async #checkpoint(record,{phase='checkpoint',unitId=null,effectMayHaveCommitted=false}={}){
    applyProgress(record);record.updatedAt=this.now();
    const recordCopy=clone(record),snapshot=this.snapshot().map(row=>row.workId===record.workId?recordCopy:row);
    if(typeof this.onCheckpoint==='function'){
      try{await this.onCheckpoint(recordCopy,snapshot,{phase,unitId,effectMayHaveCommitted});}
      catch(error){throw checkpointError(error,{workId:record.workId,unitId,phase,effectMayHaveCommitted});}
    }
    return clone(record);
  }
  create({workId,ownerSubsystem,sourceProof=null,units=[],freshnessPolicy='OWNER_DECIDES',priority=0,metadata={}}={}){
    const id=clean(workId),owner=clean(ownerSubsystem);
    if(!id)throw new Error('Continuable work requires a stable workId.');
    if(!owner)throw new Error('Continuable work requires an ownerSubsystem.');
    if(this.records.has(id))return this.get(id);
    const unitIds=uniqueIds(units);
    const unitStates=Object.fromEntries(unitIds.map(unitId=>[unitId,normalizeUnitState({state:'pending'})]));
    const record=normalizeRecord({version:2,workId:id,ownerSubsystem:owner,sourceProof:clone(sourceProof),freshnessPolicy:clean(freshnessPolicy)||'OWNER_DECIDES',priority:Number(priority)||0,
      unitIds,unitStates,results:{},state:unitIds.length?'pending':'complete',publishState:'unpublished',createdAt:this.now(),updatedAt:this.now(),metadata:clone(metadata||{}),lastError:null},this.now());
    this.records.set(id,record);
    // Creation has no external effect. It may remain memory-only until the first
    // awaited execution-intent checkpoint; reload simply causes safe replanning.
    return clone(record);
  }
  get(workId){const record=this.records.get(clean(workId));return record?clone(record):null;}
  list(){return [...this.records.values()].map(record=>clone(applyProgress(record)));}
  async checkpoint(workId,phase='manual-checkpoint'){
    const record=this.records.get(clean(workId));if(!record)return null;
    return await this.#checkpoint(record,{phase});
  }
  async cancel(workId,reason='cancelled'){
    const record=this.records.get(clean(workId));if(!record||TERMINAL.has(record.state))return this.get(workId);
    record.state='cancelled';record.lastError=String(reason||'cancelled');
    // Running physical leases are retained until their executor settles. Logical
    // cancellation revokes authority; it is not a claim that transport stopped.
    return await this.#checkpoint(record,{phase:'logical-cancel'});
  }
  async supersede(workId,replacementWorkId){
    const record=this.records.get(clean(workId));if(!record||record.state==='complete')return this.get(workId);
    record.state='superseded';record.supersededBy=clean(replacementWorkId)||null;
    return await this.#checkpoint(record,{phase:'logical-supersede'});
  }
  async markStale(workId,reason='source authority changed'){
    const record=this.records.get(clean(workId));if(!record||record.state==='complete')return this.get(workId);
    record.state='stale';record.lastError=String(reason||'source authority changed');
    for(const unitId of record.unitIds){const unit=record.unitStates[unitId];if(unit?.state==='pending')unit.state='stale';}
    return await this.#checkpoint(record,{phase:'logical-stale'});
  }
  async resolveRecovery(workId,unitId,{outcome,result=null,receipt=null,reason=null}={}){
    const record=this.records.get(clean(workId));const id=clean(unitId);
    if(!record||!record.unitStates?.[id])throw new Error(`Unknown continuable work unit ${String(workId)} / ${String(unitId)}.`);
    const unit=record.unitStates[id];
    if(unit.state!=='recovery-required')return this.get(workId);
    if(outcome==='complete'){
      unit.state='complete';unit.completedAt=this.now();unit.lastError=null;unit.recoveryReason=null;unit.receipt=clone(receipt);record.results[id]=clone(result);
    }else if(outcome==='retry'){
      unit.state='pending';unit.lastError=reason?String(reason):null;unit.recoveryReason=null;unit.receipt=null;delete record.results[id];
    }else if(outcome==='stale'){
      unit.state='stale';unit.completedAt=this.now();unit.lastError=String(reason||'recovery proved source stale');
    }else throw new Error('Recovery outcome must be complete, retry, or stale.');
    applyProgress(record);
    if(record.recoveryRequiredUnitIds.length)record.state='recovery-required';
    else if(record.remainingUnitIds.length)record.state='pending';
    else if(record.unitIds.every(id=>UNIT_TERMINAL.has(record.unitStates[id]?.state)))record.state=record.unitIds.every(id=>record.unitStates[id]?.state==='complete')?'pending':'stale';
    return await this.#checkpoint(record,{phase:'recovery-resolution',unitId:id,effectMayHaveCommitted:outcome==='complete'});
  }
  async advance(workId,{maxUnits=1,isFresh=()=>true,foregroundPending=()=>false,executeUnit,validateUnit=()=>true,validateComplete=()=>true,publish=null,isRetrySafeError=()=>false}={}){
    const record=this.records.get(clean(workId));
    if(!record)throw new Error(`Unknown continuable work ${String(workId)}.`);
    if(TERMINAL.has(record.state))return this.get(workId);
    if(record.recoveryRequiredUnitIds?.length||record.state==='recovery-required')return {...this.get(workId),deferred:true,recoveryRequired:true,reason:'checkpoint-recovery-required'};
    if(typeof executeUnit!=='function')throw new Error('Continuable work requires executeUnit().');
    const fresh=()=>{try{return isFresh(clone(record.sourceProof),clone(record))!==false;}catch{return false;}};
    if(!fresh()){record.state='stale';record.lastError='source authority changed before continuation';return await this.#checkpoint(record,{phase:'stale-before-continuation'});}
    const units=selectContinuableUnits(record.remainingUnitIds,maxUnits);
    for(const unitId of units){
      if(foregroundPending()){record.state='pending';return await this.#checkpoint(record,{phase:'foreground-yield'});}
      if(!fresh()){record.state='stale';record.lastError='source authority changed during continuation';return await this.#checkpoint(record,{phase:'stale-before-unit',unitId});}
      const unit=record.unitStates[unitId];
      if(!unit||unit.state!=='pending')continue;
      unit.state='running';unit.attempts+=1;unit.startedAt=this.now();unit.completedAt=0;unit.lastError=null;unit.leaseId=leaseId(record.workId,unitId,unit.attempts,unit.startedAt);
      record.state='running';record.lastError=null;
      try{
        // Execution intent is durable BEFORE any physical effect. If this write
        // fails, executeUnit is never called.
        await this.#checkpoint(record,{phase:'unit-execution-intent',unitId,effectMayHaveCommitted:false});
      }catch(error){
        unit.state='pending';unit.leaseId=null;record.state='pending';record.lastError=error?.message||String(error);throw error;
      }
      let value;
      try{
        value=await executeUnit(unitId,clone(record),{leaseId:unit.leaseId,attempt:unit.attempts});
      }catch(error){
        let retrySafe=false;
        try{retrySafe=isRetrySafeError(error,unitId,clone(record))===true;}catch{}
        unit.leaseId=null;unit.lastError=String(error?.message||error);record.lastError=unit.lastError;
        if(retrySafe){
          unit.state='pending';record.state='pending';
          try{await this.#checkpoint(record,{phase:'unit-execution-failed-retry-safe',unitId,effectMayHaveCommitted:false});}catch(checkpointFailure){throw checkpointFailure;}
        }else{
          unit.state='recovery-required';unit.recoveryReason='unit-execution-indeterminate';record.state='recovery-required';
          try{await this.#checkpoint(record,{phase:'unit-execution-indeterminate',unitId,effectMayHaveCommitted:true});}catch(checkpointFailure){throw checkpointFailure;}
        }
        throw error;
      }
      if(!fresh()){
        unit.state='stale';unit.completedAt=this.now();unit.leaseId=null;unit.lastError='source authority changed after unit execution';record.state='stale';record.lastError=unit.lastError;
        return await this.#checkpoint(record,{phase:'stale-after-unit',unitId,effectMayHaveCommitted:true});
      }
      const verdict=await validateUnit(value,unitId,clone(record));
      const valid=verdict===true||(verdict&&typeof verdict==='object'&&(verdict.valid===true||verdict.passed===true));
      if(!valid){
        unit.state='recovery-required';unit.leaseId=null;unit.recoveryReason='unit-validation-failed-after-execution';unit.lastError=typeof verdict==='string'?verdict:String(verdict?.reason||'owner unit validation failed');record.state='recovery-required';record.lastError=unit.lastError;
        delete record.results[unitId];await this.#checkpoint(record,{phase:'unit-validation-failed',unitId,effectMayHaveCommitted:true});
        return this.get(workId);
      }
      record.results[unitId]=clone(value);unit.state='complete';unit.completedAt=this.now();unit.lastError=null;unit.leaseId=null;
      applyProgress(record);record.state=record.remainingUnitIds.length?'pending':'running';
      try{
        await this.#checkpoint(record,{phase:'unit-complete',unitId,effectMayHaveCommitted:true});
      }catch(error){
        // The pre-execution intent was already durable. Keep this unit
        // indeterminate and block replay until its owner proves whether the
        // effect committed. Reload normalization reaches the same state.
        unit.state='recovery-required';unit.recoveryReason='completion-checkpoint-failed';unit.lastError=error?.message||String(error);delete record.results[unitId];record.state='recovery-required';record.lastError=unit.lastError;applyProgress(record);
        throw error;
      }
    }
    applyProgress(record);
    if(record.remainingUnitIds.length){record.state='pending';return await this.#checkpoint(record,{phase:'continuation-yield'});}
    if(record.recoveryRequiredUnitIds.length){record.state='recovery-required';return clone(record);}
    const verdict=await validateComplete(clone(record));
    const valid=verdict===true||(verdict&&typeof verdict==='object'&&(verdict.valid===true||verdict.passed===true));
    if(!valid){record.state='failed';record.lastError=typeof verdict==='string'?verdict:String(verdict?.reason||'owner completion validation failed');return await this.#checkpoint(record,{phase:'completion-validation-failed'});}
    if(!fresh()){record.state='stale';record.lastError='source authority changed before publication';return await this.#checkpoint(record,{phase:'stale-before-publication'});}
    if(typeof publish==='function'){
      record.publishState='publishing';await this.#checkpoint(record,{phase:'publication-intent'});
      await publish(clone(record));
      if(!fresh()){record.state='stale';record.publishState='revoked';record.lastError='source authority changed during publication';return await this.#checkpoint(record,{phase:'stale-during-publication',effectMayHaveCommitted:true});}
    }
    record.publishState='published';record.state='complete';record.lastError=null;return await this.#checkpoint(record,{phase:'work-complete',effectMayHaveCommitted:typeof publish==='function'});
  }
}
