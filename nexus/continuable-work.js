function clone(value){try{return structuredClone(value);}catch{return JSON.parse(JSON.stringify(value));}}
function clean(value){return String(value??'').trim();}
function clampInt(value,min,max,fallback){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.floor(n))):fallback;}
function applyProgress(record){const total=record.unitIds?.length||0,done=record.completedUnitIds?.length||0;record.progressPct=total?Math.max(0,Math.min(100,Math.floor((done/total)*100))):100;record.completedUnits=done;record.totalUnits=total;record.remainingUnits=record.remainingUnitIds?.length||0;return record;}

export function selectContinuableUnits(items=[],maxUnits=1){
  const source=Array.isArray(items)?items:[];
  return source.slice(0,clampInt(maxUnits,1,10000,1));
}

export class ContinuableWorkStore{
  constructor({onCheckpoint=null,now=()=>Date.now()}={}){this.records=new Map();this.onCheckpoint=onCheckpoint;this.now=now;}
  #checkpoint(record){applyProgress(record);record.updatedAt=this.now();try{this.onCheckpoint?.(clone(record));}catch{}return clone(record);}
  create({workId,ownerSubsystem,sourceProof=null,units=[],freshnessPolicy='OWNER_DECIDES',priority=0,metadata={}}={}){
    const id=clean(workId),owner=clean(ownerSubsystem);
    if(!id)throw new Error('Continuable work requires a stable workId.');
    if(!owner)throw new Error('Continuable work requires an ownerSubsystem.');
    if(this.records.has(id))return this.get(id);
    const unitIds=[...new Set((Array.isArray(units)?units:[]).map(clean).filter(Boolean))];
    const record={workId:id,ownerSubsystem:owner,sourceProof:clone(sourceProof),freshnessPolicy:clean(freshnessPolicy)||'OWNER_DECIDES',priority:Number(priority)||0,
      unitIds,completedUnitIds:[],remainingUnitIds:[...unitIds],results:{},state:unitIds.length?'pending':'complete',publishState:'unpublished',createdAt:this.now(),updatedAt:this.now(),metadata:clone(metadata||{}),lastError:null};
    this.records.set(id,record);return this.#checkpoint(record);
  }
  get(workId){const record=this.records.get(clean(workId));return record?clone(record):null;}
  list(){return [...this.records.values()].map(clone);}
  cancel(workId,reason='cancelled'){const record=this.records.get(clean(workId));if(!record||['complete','stale','cancelled','superseded'].includes(record.state))return this.get(workId);record.state='cancelled';record.lastError=String(reason||'cancelled');return this.#checkpoint(record);}
  supersede(workId,replacementWorkId){const record=this.records.get(clean(workId));if(!record||record.state==='complete')return this.get(workId);record.state='superseded';record.supersededBy=clean(replacementWorkId)||null;return this.#checkpoint(record);}
  async advance(workId,{maxUnits=1,isFresh=()=>true,foregroundPending=()=>false,executeUnit,validateComplete=()=>true,publish=null}={}){
    const record=this.records.get(clean(workId));
    if(!record)throw new Error(`Unknown continuable work ${String(workId)}.`);
    if(['complete','stale','cancelled','superseded'].includes(record.state))return this.get(workId);
    if(typeof executeUnit!=='function')throw new Error('Continuable work requires executeUnit().');
    const fresh=()=>{try{return isFresh(record.sourceProof,clone(record))!==false;}catch{return false;}};
    if(!fresh()){record.state='stale';record.lastError='source authority changed before continuation';return this.#checkpoint(record);}
    record.state='running';this.#checkpoint(record);
    const units=selectContinuableUnits(record.remainingUnitIds,maxUnits);
    for(const unitId of units){
      if(foregroundPending()){record.state='pending';return this.#checkpoint(record);}
      if(!fresh()){record.state='stale';record.lastError='source authority changed during continuation';return this.#checkpoint(record);}
      try{
        const value=await executeUnit(unitId,clone(record));
        if(!fresh()){record.state='stale';record.lastError='source authority changed after unit execution';return this.#checkpoint(record);}
        record.results[unitId]=clone(value);
        if(!record.completedUnitIds.includes(unitId))record.completedUnitIds.push(unitId);
        record.remainingUnitIds=record.unitIds.filter(id=>!record.completedUnitIds.includes(id));
        this.#checkpoint(record);
      }catch(error){
        record.state='pending';record.lastError=String(error?.message||error);this.#checkpoint(record);throw error;
      }
    }
    if(record.remainingUnitIds.length){record.state='pending';return this.#checkpoint(record);}
    const verdict=await validateComplete(clone(record));
    const valid=verdict===true||(verdict&&typeof verdict==='object'&&(verdict.valid===true||verdict.passed===true));
    if(!valid){record.state='failed';record.lastError=typeof verdict==='string'?verdict:String(verdict?.reason||'owner completion validation failed');return this.#checkpoint(record);}
    if(!fresh()){record.state='stale';record.lastError='source authority changed before publication';return this.#checkpoint(record);}
    if(typeof publish==='function'){
      record.publishState='publishing';this.#checkpoint(record);
      await publish(clone(record));
      if(!fresh()){record.state='stale';record.publishState='revoked';record.lastError='source authority changed during publication';return this.#checkpoint(record);}
    }
    record.publishState='published';record.state='complete';record.lastError=null;return this.#checkpoint(record);
  }
}
