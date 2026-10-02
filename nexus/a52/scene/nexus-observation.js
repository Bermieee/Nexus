// Nexus-facing observation helpers for the Area-52 scene core.
// Nexus's existing NO/MINOR/MAJOR change gate remains the trigger and authority.
const asString=(value)=>value==null?null:String(value).trim()||null;
const unique=(values)=>[...new Set((values??[]).map(v=>asString(v)).filter(Boolean))];

export function buildHeadTailNarrativeWindow(messages=[],{
  maxMessages=4,
  assistantHeadChars=900,
  assistantTailChars=3400,
  userTailChars=3200,
}={}){
  const rows=(Array.isArray(messages)?messages:[])
    .filter(m=>m && m.is_system!==true && m.isSystem!==true && m.rejected!==true && m.failed!==true && String(m.mes??'').trim())
    .slice(-Math.max(1,Number(maxMessages)||4));
  return rows.map((message,index)=>{
    const role=message.is_user?'User':'Assistant';
    const chars=Array.from(String(message.mes??''));
    let body;
    if(message.is_user) body=chars.length>userTailChars?'…'+chars.slice(-userTailChars).join(''):chars.join('');
    else if(chars.length<=assistantHeadChars+assistantTailChars+32) body=chars.join('');
    else body=chars.slice(0,assistantHeadChars).join('')+'\n… [middle omitted] …\n'+chars.slice(-assistantTailChars).join('');
    return `[${role} · ${index===rows.length-1?'CURRENT':'PRIOR'}]: ${body}`;
  }).join('\n\n');
}

function normalizePresence(item){
  if(typeof item==='string') return {id:item,presence:'PRESENT',authorityClass:'OBSERVED',evidenceRefs:[]};
  if(!item||typeof item!=='object') return null;
  const id=asString(item.id??item.characterRef??item.characterId??item.objectRef??item.name);
  return id?{id,canonicalEntityId:item.canonicalEntityId==null?null:asString(item.canonicalEntityId),sourceEntityId:item.sourceEntityId==null?null:asString(item.sourceEntityId),
    providerId:item.providerId==null?null:asString(item.providerId),label:item.label??item.name??null,presence:item.presence??'PRESENT',authorityClass:item.authorityClass??'OBSERVED',evidenceRefs:unique(item.evidenceRefs)}:null;
}

export function normalizeNexusSceneObservation(raw={},{
  chatId=null,
  sceneId=null,
  sceneRevision=null,
  sourceRevisionRefs=[],
}={}){
  const accepted=raw.acceptedScene??raw.scene??raw;
  const participants=accepted.participants??accepted.activeCast??accepted.cast??[];
  const location=accepted.location??accepted.place??accepted.currentLocation??null;
  const objects=accepted.objects??accepted.immediateObjects??[];
  const threads=accepted.activeThreads??accepted.threads??[];
  const revision=Math.max(1,Number(sceneRevision??accepted.sceneRevision??raw.scanRevision??1)||1);
  return Object.freeze({
    kind:'NexusA52SceneSignal',
    chatNamespace:asString(chatId),
    sceneId:asString(sceneId??accepted.sceneId??raw.sceneId??`nexus-scene:${chatId??'chat'}`),
    sceneRevision:revision,
    location:location==null?null:{value:typeof location==='object'?(location.value??location.name??location.label??location):location,authorityClass:'OBSERVED',evidenceRefs:unique(location?.evidenceRefs)},
    activeCast:(Array.isArray(participants)?participants:[]).map(normalizePresence).filter(Boolean),
    objects:(Array.isArray(objects)?objects:[]).map(normalizePresence).filter(Boolean),
    activeThreads:(Array.isArray(threads)?threads:[]).map(item=>typeof item==='string'?{id:item,summary:item,evidenceRefs:[],sourceRevisionRefs:[]}:{
      id:asString(item?.id??item?.threadId??item?.name??item?.summary),
      summary:String(item?.summary??item?.text??item?.name??'').slice(0,600),
      evidenceRefs:unique(item?.evidenceRefs),
      sourceRevisionRefs:unique(item?.sourceRevisionRefs),
    }).filter(item=>item.id),
    narrativeTime:accepted.narrativeTime??accepted.time??null,
    boundaryState:accepted.boundaryState??null,
    sceneRelationship:accepted.sceneRelationship??null,
    transitionType:accepted.transitionType??null,
    atmosphere:accepted.atmosphere??null,
    uncertainFields:unique(accepted.uncertainFields),
    conflictSignals:unique(accepted.conflictSignals),
    sourceRevisionRefs:unique(sourceRevisionRefs),
    provenance:['nexus-scene-observation'],
    health:{status:'ready',reasons:[]},
  });
}
