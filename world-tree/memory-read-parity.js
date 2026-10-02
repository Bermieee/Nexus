import { legacyMemoryOwnerRecord, legacyMemoryTemporalStatus, legacyMemoryControlWorldNodeId } from './import-memory-bank.js';
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
export function compareMemoryRecordParity(tree,{chatId,records=[],control=null}={}){
 const story=String(chatId??'').trim();if(!story)throw new TypeError('Memory parity requires chatId');
 const expected=new Map(records.map(record=>[String(record.id),record])),actual=new Map();
 for(const node of tree.iterateNodes({chatId:story,kind:'MEMORY'})){
  if(node.scope?.chatId!==story||node.data?.sourcePresent===false)continue;
  const key=String(node.data?.sourceRecord?.id??node.provenance?.sourceIds?.[0]??node.id);actual.set(key,node);
 }
 const counts={examined:0,total:expected.size,missing:0,extra:0,different:0,temporal:0,payloadMissing:0};const ids=new Set(),fields=new Set();
 for(const [id,record] of expected){
  counts.examined++;const node=actual.get(id);if(!node){counts.missing++;ids.add(id);continue;}
  const source=legacyMemoryOwnerRecord(record),imported=node.data?.sourceRecord;
  if(!imported){counts.payloadMissing++;ids.add(id);}
  if(!same(source,imported)){
   counts.different++;ids.add(id);
   for(const field of new Set([...Object.keys(source),...Object.keys(imported??{})]))if(!same(source[field],imported?.[field])&&/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(field))fields.add(field);
  }
  if(node.temporal?.status!==legacyMemoryTemporalStatus(record)){counts.temporal++;ids.add(id);}
 }
 for(const id of actual.keys())if(!expected.has(id)){counts.extra++;ids.add(id);}
 const mismatch=counts.missing+counts.extra+counts.different+counts.temporal+counts.payloadMissing;
 let controlMetadata='NOT_PROVIDED',controlMismatches=[];
 if(control){
  const node=tree.getNode(legacyMemoryControlWorldNodeId(story),{chatId:story});
  const expected={
   activeLayers:(control?.activeLayers??[]).map(ids=>[...new Set((ids??[]).map(String))]),
   permanentIds:[...new Set((control?.permanentIds??[]).map(String))],
   coverageReceipts:(control?.coverageReceipts??[]).map(row=>({
    id:String(row?.id??''),turnRange:Array.isArray(row?.turnRange)?row.turnRange.map(Number):null,
    sourceMessageIds:(row?.sourceMessageIds??[]).map(String),sourceFingerprint:String(row?.sourceFingerprint??''),
    sourceMemoryId:row?.sourceMemoryId==null?null:String(row.sourceMemoryId),source:String(row?.source??'summary-coverage'),createdAt:Number(row?.createdAt)||0,
   })).filter(row=>row.id&&row.turnRange),
   summarizedUpTo:Number.isFinite(Number(control?.summarizedUpTo))?Number(control.summarizedUpTo):-1,
   effectiveSummarizedUpTo:Number.isFinite(Number(control?.effectiveSummarizedUpTo))?Number(control.effectiveSummarizedUpTo):-1,
  };
  const actual=node?.data??null;
  for(const key of Object.keys(expected))if(!same(expected[key],actual?.[key]))controlMismatches.push(key);
  controlMetadata=controlMismatches.length?'MISMATCH':'PASS';
 }
 const totalMismatch=mismatch+(controlMetadata==='MISMATCH'?1:0);
 return Object.freeze({
  kind:'NexusMemoryRecordParity',chatId:story,status:totalMismatch?'MISMATCH':'PASS',counts:Object.freeze(counts),
  sampleIds:Object.freeze([...ids].slice(0,16)),fields:Object.freeze([...fields].slice(0,16)),sampleDeferred:Math.max(0,ids.size-16),
  controlMetadata,controlMismatches:Object.freeze(controlMismatches.slice(0,16)),readersSwitched:false,
 });
}
