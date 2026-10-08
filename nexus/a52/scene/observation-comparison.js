const clean=value=>String(value??'').replace(/\s+/g,' ').trim().toLocaleLowerCase();
function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
  return value;
}
function semanticValue(name,value){
  if(name==='location')return {location:clean(typeof value==='string'?value:value?.location??value?.name??value?.label),parentLocation:clean(value?.parentLocation??value?.containment?.parentLocation)};
  const ids={activeCast:['characterId','PRESENT'],immediateObjects:['objectId','PRESENT'],activeThreads:['threadId',null],activeObjectives:['objective',null]};
  if(ids[name]&&Array.isArray(value)){
    const [key,defaultState]=ids[name];
    return value.map(row=>({id:clean(typeof row==='string'?row:row?.[key]??row?.id??row?.name??row?.label),...(defaultState?{state:clean(row?.state??row?.presence??defaultState)}:{})})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return stable(value);
}

// Absence, confidence, key ordering and extra corroborating fields do not
// establish conflicting observations. Ask for arbitration only when both
// paths assert different supported values for the same observed field.
export function sceneObservationsConflict(left,right){
  for(const [name,row]of Object.entries(left?.fields??{})){
    const other=right?.fields?.[name];
    if(!other||[row,other].some(field=>['UNKNOWN','UNRESOLVED'].includes(String(field.observationClass).toUpperCase())))continue;
    const a=semanticValue(name,row.value),b=semanticValue(name,other.value);
    if(name==='location'&&(!a.parentLocation||!b.parentLocation)){delete a.parentLocation;delete b.parentLocation;}
    if(JSON.stringify(a)!==JSON.stringify(b))return true;
  }
  for(const [name,row]of Object.entries(left?.boundarySignals??{})){
    const other=right?.boundarySignals?.[name];if(other===undefined)continue;
    if((Number(row?.strength??row)>=.5)!==(Number(other?.strength??other)>=.5))return true;
  }
  return false;
}
