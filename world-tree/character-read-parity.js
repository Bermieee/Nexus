import { characterStateWorldNodeId, legacyCharacterControlWorldNodeId, legacyCharacterOwnerRecord } from './import-character-banks.js';

const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));

export function compareCharacterBankParity(tree,{chatId,banks=[],control={enabled:true}}={}){
  const story=String(chatId??'').trim();if(!story)throw new TypeError('Character parity requires chatId');
  const expected=new Map((banks??[]).filter(bank=>bank&&String(bank.id??'').trim()).map((bank,index)=>[String(bank.id),{bank:legacyCharacterOwnerRecord(bank),order:index}]));
  const actual=new Map();
  for(const node of tree.iterateNodes({chatId:story,kind:'CHARACTER_STATE'})){
    if(node.scope?.chatId!==story||(node.data?.importedFrom!=='legacy-character-bank'&&node.data?.canonicalOwner!=='WORLD_TREE')||node.data?.sourcePresent===false)continue;
    const id=String(node.data?.sourceBank?.id??node.provenance?.sourceIds?.[0]??'');if(id)actual.set(id,node);
  }
  const counts={examined:0,total:expected.size,missing:0,extra:0,different:0,temporal:0,identityMissing:0,payloadMissing:0,order:0};
  const ids=new Set(),fields=new Set();
  for(const [id,expectedRow] of expected){
    const bank=expectedRow.bank;
    counts.examined++;const node=actual.get(id);
    if(!node){counts.missing++;ids.add(id);continue;}
    const imported=node.data?.sourceBank;
    if(!imported){counts.payloadMissing++;ids.add(id);}
    if(!same(bank,imported)){
      counts.different++;ids.add(id);
      for(const field of new Set([...Object.keys(bank),...Object.keys(imported??{})]))if(!same(bank[field],imported?.[field])&&/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(field))fields.add(field);
    }
    if(Number(node.data?.sourceOrder)!==Number(expectedRow.order)){counts.order++;ids.add(id);}
    const expectedTemporal=bank.enabled===false?'HISTORICAL':'CURRENT';
    if(node.temporal?.status!==expectedTemporal){counts.temporal++;ids.add(id);}
    const identityId=node.data?.characterNodeId;
    if(!identityId||!tree.getNode(identityId,{chatId:story})){counts.identityMissing++;ids.add(id);}
  }
  for(const id of actual.keys())if(!expected.has(id)){counts.extra++;ids.add(id);}
  const controlNode=tree.getNode(legacyCharacterControlWorldNodeId(story),{chatId:story});
  const controlMetadata=controlNode?.data?.enabled===(control?.enabled!==false)?'PASS':'MISMATCH';
  const mismatch=counts.missing+counts.extra+counts.different+counts.temporal+counts.identityMissing+counts.payloadMissing+counts.order+(controlMetadata==='MISMATCH'?1:0);
  return Object.freeze({
    kind:'NexusCharacterBankParity',chatId:story,status:mismatch?'MISMATCH':'PASS',
    counts:Object.freeze(counts),sampleIds:Object.freeze([...ids].slice(0,16)),fields:Object.freeze([...fields].slice(0,16)),
    sampleDeferred:Math.max(0,ids.size-16),controlMetadata,readersSwitched:false,
  });
}
