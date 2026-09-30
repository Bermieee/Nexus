export const PromptIntegrityCode=Object.freeze({
  INFERRED_IN_CURRENT:'INFERRED_IN_CURRENT_FACTS',
  HISTORICAL_IN_CURRENT:'HISTORICAL_IN_CURRENT_FACTS',
  HISTORICAL_LABEL_MISSING:'HISTORICAL_FACT_PAST_LABEL_MISSING',
  GREEN_ROOM_AUTHORITY:'GREEN_ROOM_AUTHORITY_ESCALATION',
});

const HISTORICAL=new Set(['HISTORICAL','SUPERSEDED']);
const inferred=(row)=>String(row?.authorityClass??row?.authority??'').toUpperCase()==='INFERRED';
const temporal=(row)=>String(row?.temporalStatus??row?.status??'').toUpperCase();

export function validatePromptIntegrity({currentFacts=[],historicalFacts=[],greenRoom=[]}={}){
  const violations=[];
  for(const [index,row] of (currentFacts??[]).entries()){
    if(inferred(row)) violations.push({code:PromptIntegrityCode.INFERRED_IN_CURRENT,index});
    if(HISTORICAL.has(temporal(row))) violations.push({code:PromptIntegrityCode.HISTORICAL_IN_CURRENT,index,temporalStatus:temporal(row)});
  }
  for(const [index,row] of (historicalFacts??[]).entries()){
    if(!HISTORICAL.has(temporal(row))) continue;
    const label=String(row?.temporalLabel??row?.label??'').trim().toUpperCase();
    if(label!=='PAST'&&!label.includes('HISTOR')) violations.push({code:PromptIntegrityCode.HISTORICAL_LABEL_MISSING,index,temporalStatus:temporal(row)});
  }
  for(const [index,row] of (greenRoom??[]).entries()){
    const authority=String(row?.authorityClass??row?.authority??'INFERRED').toUpperCase();
    if(authority!=='INFERRED'||row?.canonical===true||row?.durableMutation===true||row?.settlementAuthority===true){
      violations.push({code:PromptIntegrityCode.GREEN_ROOM_AUTHORITY,index,authority});
    }
  }
  return Object.freeze({
    kind:'NexusA52PromptIntegrityResult',
    ok:violations.length===0,
    violations:Object.freeze(violations.map(Object.freeze)),
    checkOnly:true,
    mutationAuthority:false,
  });
}
