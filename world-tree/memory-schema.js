import { WorldTreeTemporalStatus } from './store.js';

const clone=value=>value==null?value:structuredClone(value);
const uniq=values=>[...new Set((values??[]).map(value=>String(value??'').trim()).filter(Boolean))];
const TEMPORAL_STATUSES=new Set(Object.values(WorldTreeTemporalStatus));
const safeId=value=>encodeURIComponent(String(value??''));

function explicitMemoryTemporalStatus(record={}){
  const value=record?.temporalStatus??record?.metadata?.temporalStatus??record?.status??null;
  if(value==null)return null;
  const status=String(value).trim().toUpperCase().replaceAll('-','_');
  return TEMPORAL_STATUSES.has(status)?status:null;
}
export function memoryOwnerRecord(record={}){
  const source=clone(record);delete source.worldTreeValidity;return source;
}
export function memoryTemporalStatus(record={}){
  if(record?.worldTreeValidity?.valid===false)return WorldTreeTemporalStatus.SUPERSEDED;
  if(record.promotedTo)return WorldTreeTemporalStatus.SUPERSEDED;
  if(record.routeState==='superseded')return WorldTreeTemporalStatus.SUPERSEDED;
  return explicitMemoryTemporalStatus(record)??WorldTreeTemporalStatus.HISTORICAL;
}
export function memoryWorldNodeId(chatId,memoryId){return 'memory:'+safeId(chatId)+':'+safeId(memoryId);}
export function memoryControlWorldNodeId(chatId){return 'memory-control:'+safeId(chatId);}
export function normalizeMemoryControl(control={}){
  return {
    version:Number(control?.version)||4,
    activeLayers:(control?.activeLayers??[]).map(ids=>[...new Set((ids??[]).map(String))]),
    permanentIds:[...new Set((control?.permanentIds??[]).map(String))],
    compressedIndices:[...new Set((control?.compressedIndices??[]).map(Number).filter(Number.isFinite))],
    coverageReceipts:(control?.coverageReceipts??[]).map(row=>({
      id:String(row?.id??''),turnRange:Array.isArray(row?.turnRange)?row.turnRange.map(Number):null,
      sourceMessageIds:(row?.sourceMessageIds??[]).map(String),sourceFingerprint:String(row?.sourceFingerprint??''),
      sourceMemoryId:row?.sourceMemoryId==null?null:String(row.sourceMemoryId),source:String(row?.source??'summary-coverage'),createdAt:Number(row?.createdAt)||0,
    })).filter(row=>row.id&&row.turnRange),
    summarizedUpTo:Number.isFinite(Number(control?.summarizedUpTo))?Number(control.summarizedUpTo):-1,
    effectiveSummarizedUpTo:Number.isFinite(Number(control?.effectiveSummarizedUpTo))?Number(control.effectiveSummarizedUpTo):-1,
    sequence:Math.max(0,Number(control?.sequence)||0),evidenceRevision:Math.max(1,Number(control?.evidenceRevision)||1),
    lastCycleId:control?.lastCycleId==null?null:String(control.lastCycleId),lastUpdatedAt:Math.max(0,Number(control?.lastUpdatedAt)||0),
  };
}
export function memoryRecordFields(record,{canonicalOwner=null,compatibilityMirror=undefined,importedFrom=null,importFingerprint=null,sourcePresent=true}={}){
  const fields={
    sourceRecord:memoryOwnerRecord(record),sourcePresent:sourcePresent!==false,
    label:String(record?.text||'Memory').trim().slice(0,120)||String(record?.id??'Memory'),text:String(record?.text||''),layer:Number(record?.layer)||0,
    turnRange:Array.isArray(record?.turnRange)?record.turnRange.map(Number):null,assistantTurnRange:Array.isArray(record?.assistantTurnRange)?record.assistantTurnRange.map(Number):null,
    characters:uniq(record?.characters),locations:uniq(record?.locations),dates:uniq(record?.dates),topics:uniq(record?.topics),threads:uniq(record?.threads),
    permanent:record?.permanent===true,locked:record?.locked===true,source:String(record?.source||'summary'),sourceValidity:clone(record?.worldTreeValidity??null),
  };
  if(canonicalOwner)fields.canonicalOwner=String(canonicalOwner);
  if(compatibilityMirror!==undefined)fields.compatibilityMirror=compatibilityMirror;
  if(importedFrom)fields.importedFrom=String(importedFrom);
  if(importFingerprint)fields.importFingerprint=String(importFingerprint);
  return fields;
}
export function memoryPromotionEdgeId(chatId,memoryId,parentId){return 'memory-edge:'+safeId(chatId)+':'+safeId(memoryId)+'->'+safeId(parentId);}
