import { loreBookWorldNodeId, loreGroupWorldNodeId, legacyLoreTemporal } from './import-lore.js';

const clone=value=>value==null?value:structuredClone(value);
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
const bookMetadata=data=>{const copy=clone(data??{});if(copy&&typeof copy==='object')delete copy.entries;return copy??{};};
function expectedGroups(root,book,parentWorldId=loreBookWorldNodeId(book),rows=[]){
  if(!root)return rows;
  const worldId=loreGroupWorldNodeId(book,root.id||root.label||rows.length);
  rows.push({
    id:worldId,parentId:parentWorldId,
    projection:{
      label:String(root.label||'Lore group'),
      summary:String(root.summary||''),
      keywords:[...new Set((root.keywords??[]).map(v=>String(v??'').trim()).filter(Boolean))].sort(),
      entryUids:(root.entryUids??[]).map(Number).filter(Number.isFinite),
    },
  });
  for(const child of root.children??[])expectedGroups(child,book,worldId,rows);
  return rows;
}

export function reconstructLoreBookFromWorldTree(tree,book){
  const name=String(book??'').trim();if(!name)return null;
  const source=tree.getNode(loreBookWorldNodeId(name),{chatId:null});
  if(!source||source.data?.importedFrom!=='legacy-lorebook'||source.data?.sourcePresent===false)return null;
  const data=clone(source.data?.sourceBookMetadata??{});
  data.entries={};
  for(const node of tree.iterateNodes({chatId:null,kind:'LORE_FACT'})){
    if(String(node.data?.book??'')!==name||node.data?.importedFrom!=='legacy-lorebook'||node.data?.sourcePresent===false)continue;
    const entry=clone(node.data?.sourceEntry??null);if(!entry)continue;
    const key=String(node.data?.sourceEntryKey??entry.uid);
    data.entries[key]=entry;
  }
  return data;
}

export function reconstructLoreTreeFromWorldTree(tree,book){
  const name=String(book??'').trim();if(!name)return null;
  const source=tree.getNode(loreBookWorldNodeId(name),{chatId:null});
  if(!source||source.data?.importedFrom!=='legacy-lorebook'||source.data?.sourcePresent===false)return null;
  return clone(source.data?.sourceTree??null);
}

export function compareLoreReadParity(tree,{book,data=null,legacyTree=null}={}){
  const name=String(book??'').trim();if(!name)throw new TypeError('Lore parity requires book');
  const expectedEntries=new Map(Object.entries(data?.entries??{}).filter(([,entry])=>Number.isFinite(Number(entry?.uid))).map(([key,entry])=>[Number(entry.uid),{key:String(key),entry}]));
  const actual=new Map();
  for(const node of tree.iterateNodes({chatId:null,kind:'LORE_FACT'})){
    if(String(node.data?.book??'')!==name||node.data?.importedFrom!=='legacy-lorebook'||node.data?.sourcePresent===false)continue;
    if(Number.isFinite(Number(node.data?.uid)))actual.set(Number(node.data.uid),node);
  }
  const counts={examined:0,total:expectedEntries.size,missing:0,extra:0,different:0,temporal:0,payloadMissing:0,groupMissing:0,groupExtra:0,groupDifferent:0};
  const uids=new Set(),fields=new Set();
  for(const [uid,row] of expectedEntries){
    counts.examined++;const node=actual.get(uid);
    if(!node){counts.missing++;uids.add(uid);continue;}
    const imported=node.data?.sourceEntry;
    if(!imported){counts.payloadMissing++;uids.add(uid);}
    if(String(node.data?.sourceEntryKey??'')!==row.key){counts.different++;uids.add(uid);fields.add('sourceEntryKey');}
    if(!same(row.entry,imported)){
      counts.different++;uids.add(uid);
      for(const field of new Set([...Object.keys(row.entry??{}),...Object.keys(imported??{})]))if(!same(row.entry?.[field],imported?.[field])&&/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(field))fields.add(field);
    }
    const expectedTemporal=legacyLoreTemporal(row.entry);
    if(!same(expectedTemporal,node.temporal)){counts.temporal++;uids.add(uid);}
  }
  for(const uid of actual.keys())if(!expectedEntries.has(uid)){counts.extra++;uids.add(uid);}
  const expectedGroupRows=expectedGroups(legacyTree?.root??null,name),expectedGroupIds=new Set(expectedGroupRows.map(row=>row.id));
  const actualGroupIds=new Set();
  for(const row of expectedGroupRows){
    const node=tree.getNode(row.id,{chatId:null});
    if(!node||node.data?.importedFrom!=='legacy-lorebook'||node.data?.sourcePresent===false){counts.groupMissing++;continue;}
    actualGroupIds.add(node.id);
    const actualProjection={
      label:String(node.data?.label??''),summary:String(node.data?.summary??''),
      keywords:[...(node.data?.keywords??[])],entryUids:[...(node.data?.entryUids??[])],
    };
    if(node.parentId!==row.parentId||!same(row.projection,actualProjection))counts.groupDifferent++;
  }
  for(const node of tree.iterateNodes({chatId:null,kind:'LORE_GROUP'})){
    if(String(node.data?.book??'')!==name||node.data?.importedFrom!=='legacy-lorebook'||node.data?.sourcePresent===false)continue;
    if(!expectedGroupIds.has(node.id))counts.groupExtra++;
  }
  const source=tree.getNode(loreBookWorldNodeId(name),{chatId:null});
  const metadataMatches=!!source&&source.data?.sourcePresent!==false&&same(bookMetadata(data),source.data?.sourceBookMetadata??{});
  const treeMatches=!!source&&source.data?.sourcePresent!==false&&same(legacyTree??null,source.data?.sourceTree??null);
  const controlMismatches=[];if(!metadataMatches)controlMismatches.push('bookMetadata');if(!treeMatches)controlMismatches.push('tree');if(counts.groupMissing||counts.groupExtra||counts.groupDifferent)controlMismatches.push('groups');
  const controlMetadata=controlMismatches.length?'MISMATCH':'PASS';
  const mismatch=counts.missing+counts.extra+counts.different+counts.temporal+counts.payloadMissing+counts.groupMissing+counts.groupExtra+counts.groupDifferent+(controlMetadata==='MISMATCH'?1:0);
  return Object.freeze({
    kind:'NexusLoreReadParity',book:name,status:mismatch?'MISMATCH':'PASS',counts:Object.freeze(counts),
    sampleUids:Object.freeze([...uids].slice(0,16)),fields:Object.freeze([...fields].slice(0,16)),sampleDeferred:Math.max(0,uids.size-16),
    controlMetadata,controlMismatches:Object.freeze(controlMismatches),readersSwitched:false,
  });
}
