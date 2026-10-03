// Story-level Activity Feed model. The feed shows what changed in the story, what the player
// received, and what needs the player; engine internals stay in Diagnostics. This module is pure:
// it reads telemetry records and never rewrites them.
//
// Only the events named here can become feed items. Everything else (Scatter, Scheduler lanes,
// Jev records, retrieval channels, Walker, Truth, Sensory, budget plans, sidecar requests,
// World Tree "Processing details", growth "Wait", Gather counts when clean) produces no row and
// remains available in Diagnostics.

const n=value=>value!=null&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
const text=value=>String(value??'').replace(/\s+/g,' ').trim();
const lower=value=>text(value).toLowerCase();
const plural=(count,one,many)=>count===1?one:many;
const CONTRIBUTION_SOURCES_HIDDEN=new Set(['lore','owner']);
const MEMORY_SOURCES=new Set(['memory','character-memory']);

// Plain-words problems that affect the story: a failed write, skipped memory, or a fallback.
const PROBLEMS=Object.freeze({
  'retrieval|foreground-retrieval-failed':'Lore retrieval failed, so this reply used no new lore',
  'retrieval|foreground-retrieval-degraded':'Lore retrieval ran in a reduced mode',
  'memory-recall|rerank-failed':'Memory ranking failed; a simpler ranking was used',
  'worldtree.intake|rejected':'A World Tree update was rejected',
  'worldtree.intake|memory-contribution-deferred':'A memory update to the World Tree was postponed',
  'summary|create-failed':'A memory summary could not be saved',
  'summary|promotion-failed':'A memory promotion failed',
  'proposals|execution-failed':'A proposed change failed to apply',
  'world-tree|legacy-lore-sync-failed':'The Lorebook could not be synced to the World Tree',
  'world-tree|chat-state-hydrate-failed':'Saved World Tree state could not be loaded for this chat',
});
const GATHER_PROBLEM_KEYS=Object.freeze(['LATE','STALE','INVALID']);
const STORY_CATEGORY=/^(retrieval|memory|memory-recall|summary|world-tree|worldtree(\..+)?|proposals|lore|character-memory|nexus\.gather)$/;

export const STORY_EVENT_KINDS=Object.freeze({ADDED:'ADDED',LEARNED:'LEARNED',PROBLEM:'PROBLEM'});
const KIND_LABEL=Object.freeze({ADDED:'Added',LEARNED:'Learned',PROBLEM:'Problem'});

export function storyIdentity(record={}){
  const data=record?.data&&typeof record.data==='object'?record.data:{},selection=data.selection??data,scope=data.nexusScope??{};
  const chat=selection.chatId??scope.chatId,generation=selection.generationId??scope.generationId;
  return{chatId:chat==null?null:String(chat),generationId:generation==null?null:String(generation),turn:n(data.turn)};
}

// One telemetry record -> zero or more story items. Never throws on malformed data.
export function storyItemsFromEvent(record={}){
  const category=lower(record?.category),name=lower(record?.name),data=record?.data&&typeof record.data==='object'?record.data:{};
  const key=category+'|'+name;
  if(category==='retrieval'&&name==='injection-complete'){
    const count=n(data.entryCount??data.renderedEntryCount)??0;if(!count)return[];
    const titles=(Array.isArray(data.refs)?data.refs:[]).map(ref=>text(ref?.title)).filter(Boolean);
    return[{kind:'ADDED',facet:'lore',count,tokens:n(data.estimatedInjectionTokens??data.estimatedTokens),titles}];
  }
  if(category==='memory-recall'&&name==='injection-complete'){
    const count=(n(data.selectedCount)??0)+(n(data.characterMemoryCount)??0);if(!count)return[];
    return[{kind:'ADDED',facet:'memory',count,tokens:n(data.estimatedTokens??data.estimatedInjectionTokens)}];
  }
  if(category==='nexus.scene'&&name==='scanner-observed'&&data.boundaryConfirmed===true){
    return[{kind:'ADDED',facet:'scene',count:1,place:text(data.location)||null}];
  }
  if(category==='worldtree.intake'&&(name==='applied'||name==='applied-deterministic')){
    const source=lower(data.source);if(CONTRIBUTION_SOURCES_HIDDEN.has(source)||data.noOp===true)return[];
    const facet=MEMORY_SOURCES.has(source)?'memory':'world-tree';
    const nodes=name==='applied'?n(data.createdNodes)??0:n(data.nodeCount)??0;
    const links=name==='applied'?n(data.createdEdges)??0:n(data.edgeCount)??0;
    const replaced=name==='applied'?n(data.supersededNodes)??0:0;
    const items=[];
    if(nodes>0)items.push({kind:'LEARNED',facet,count:1,text:name==='applied'?`${nodes} new World Tree ${plural(nodes,'entry','entries')}`:`${nodes} World Tree ${plural(nodes,'entry','entries')} updated`});
    if(links>0)items.push({kind:'LEARNED',facet,count:1,text:`${links} ${name==='applied'?'new ':''}${plural(links,'link','links')}`});
    if(replaced>0)items.push({kind:'LEARNED',facet,count:1,text:`${replaced} ${plural(replaced,'entry','entries')} replaced by newer facts`});
    return items;
  }
  if(category==='summary'&&(name==='created'||name==='promoted')){
    return[{kind:'LEARNED',facet:'memory',count:1,text:name==='created'?'a new memory summary':'a memory promoted to a broader summary'}];
  }
  if(category==='worldtree.growth'&&name==='expired'){
    return[{kind:'LEARNED',facet:'world-tree',count:1,text:'a World Tree growth candidate expired'}];
  }
  if(PROBLEMS[key])return[{kind:'PROBLEM',facet:category.startsWith('memory')||category==='summary'?'memory':'world-tree',count:1,text:PROBLEMS[key]}];
  if(category==='nexus.gather'&&name==='gather.summary'&&data.counts&&typeof data.counts==='object'){
    const bad=GATHER_PROBLEM_KEYS.map(label=>[label,Object.entries(data.counts).find(([k])=>String(k).toUpperCase()===label)?.[1]]).filter(([,value])=>n(value)>0);
    if(!bad.length)return[];
    return[{kind:'PROBLEM',facet:'gather',count:1,text:'Some results arrived '+bad.map(([label,value])=>`${value} ${label.toLowerCase()}`).join(', ')+' and may be missing from this reply'}];
  }
  if(lower(record?.level)==='error'&&STORY_CATEGORY.test(category)){
    return[{kind:'PROBLEM',facet:'world-tree',count:1,text:'Something went wrong in '+humanize(category)+': '+humanize(name)}];
  }
  return[];
}

// Group story items into turns. A turn is the player's message count (stable), else the generation.
// Events that name neither attach to the nearest turn of the same chat by time.
export function projectStoryTurns(records=[]){
  const rows=[];
  records.forEach((record,index)=>{
    const items=storyItemsFromEvent(record);if(!items.length)return;
    rows.push({record,index,ts:Number(record?.ts)||0,eventId:text(record?.id)||('event:'+index),identity:storyIdentity(record),items});
  });
  const generationTurn=new Map();
  for(const row of rows){const{chatId,generationId,turn}=row.identity;if(generationId!=null&&turn!=null)generationTurn.set((chatId??'')+'|'+generationId,turn);}
  const groups=new Map();
  const groupFor=(chatId,key,seed)=>{
    const id=(chatId??'')+'|'+key;
    if(!groups.has(id))groups.set(id,{key:id,chatId,turn:seed.turn??null,generationIds:new Set(),firstTs:seed.ts,lastTs:seed.ts,rows:[]});
    return groups.get(id);
  };
  const pending=[];
  for(const row of rows){
    const{chatId,generationId,turn}=row.identity;
    const mapped=generationId!=null?generationTurn.get((chatId??'')+'|'+generationId):null;
    const effective=mapped??turn;
    if(effective!=null)groupFor(chatId,'turn:'+effective,{turn:effective,ts:row.ts}).rows.push(row);
    else if(generationId!=null)groupFor(chatId,'gen:'+generationId,{turn:null,ts:row.ts}).rows.push(row);
    else pending.push(row);
  }
  for(const row of pending){
    const sameChat=[...groups.values()].filter(group=>row.identity.chatId==null||group.chatId==null||group.chatId===row.identity.chatId);
    const before=sameChat.filter(group=>group.firstTs<=row.ts).sort((a,b)=>b.firstTs-a.firstTs)[0];
    const after=sameChat.filter(group=>group.firstTs>row.ts).sort((a,b)=>a.firstTs-b.firstTs)[0];
    (before??after??groupFor(row.identity.chatId,'unscoped',{turn:null,ts:row.ts})).rows.push(row);
  }
  const ordered=[...groups.values()].map(group=>{
    for(const row of group.rows){group.firstTs=Math.min(group.firstTs,row.ts);group.lastTs=Math.max(group.lastTs,row.ts);if(row.identity.generationId!=null)group.generationIds.add(row.identity.generationId);}
    return group;
  }).sort((a,b)=>a.firstTs-b.firstTs||String(a.key).localeCompare(String(b.key)));
  return ordered.map((group,ordinal)=>buildTurn(group,ordinal));
}

function buildTurn(group,ordinal){
  const items=[];
  for(const row of group.rows)for(const item of row.items)items.push({...item,eventId:row.eventId,ts:row.ts,record:row.record});
  const byKind=kind=>items.filter(item=>item.kind===kind);
  const added=byKind('ADDED'),learned=byKind('LEARNED'),problems=byKind('PROBLEM');
  const turnNumber=group.turn??(ordinal+1);
  const id='turn:'+group.key;
  const generationId=[...group.generationIds].at(-1)??null;
  const trace=(subset)=>Object.freeze({chatId:group.chatId,generationId,turn:turnNumber,eventIds:Object.freeze([...new Set(subset.map(item=>item.eventId))]),facets:Object.freeze([...new Set(subset.map(item=>item.facet))])});
  const children=[];
  const child=(kind,subset,summary)=>{if(subset.length)children.push(Object.freeze({kind:'NexusActivityTurnChild',id:id+':'+kind.toLowerCase(),turnId:id,type:kind,label:KIND_LABEL[kind],summary,ts:Math.max(...subset.map(item=>item.ts)),facets:Object.freeze([...new Set(subset.map(item=>item.facet))]),trace:trace(subset)}));};
  const lore=added.filter(item=>item.facet==='lore'),memory=added.filter(item=>item.facet==='memory'),scene=added.filter(item=>item.facet==='scene');
  const loreCount=lore.reduce((sum,item)=>sum+item.count,0),memoryCount=memory.reduce((sum,item)=>sum+item.count,0);
  const tokens=[...lore,...memory].reduce((sum,item)=>sum+(item.tokens??0),0);
  const titles=[...new Set(lore.flatMap(item=>item.titles??[]))];
  const addedParts=[];
  if(scene.length)addedParts.push(scene.find(item=>item.place)?.place?`${scene.find(item=>item.place).place} scene`:'New scene');
  if(loreCount)addedParts.push('lore: '+(titles.length?titles.slice(0,3).join(', ')+(titles.length>3||loreCount>titles.length?` +${Math.max(1,loreCount-Math.min(3,titles.length))} more`:''):`${loreCount} ${plural(loreCount,'entry','entries')}`));
  if(memoryCount)addedParts.push(`${memoryCount} ${plural(memoryCount,'memory','memories')} recalled`);
  child('ADDED',added,addedParts.join('; ')+(tokens?` · ${formatTokens(tokens)} tokens`:''));
  child('LEARNED',learned,summarizeList(learned.map(item=>item.text),4));
  const problemCounts=new Map();for(const item of problems)problemCounts.set(item.text,(problemCounts.get(item.text)??0)+1);
  child('PROBLEM',problems,[...problemCounts].map(([label,count])=>count>1?`${label} (×${count})`:label).join('; '));
  const collapsed=[];
  const headline=[scene.length?'Scene':null,loreCount?`${loreCount} lore added`:null].filter(Boolean);
  if(headline.length)collapsed.push(scene.length&&!loreCount?'Scene changed':headline.join(' + '));
  if(memoryCount)collapsed.push(`${memoryCount} ${plural(memoryCount,'memory','memories')} recalled`);
  if(learned.length)collapsed.push(`${learned.length} learned`);
  if(problems.length)collapsed.push(`${problems.length} ${plural(problems.length,'problem','problems')}`);
  return Object.freeze({
    kind:'NexusActivityTurn',id,key:group.key,chatId:group.chatId,generationId,turn:turnNumber,label:'Turn '+turnNumber,
    summary:collapsed.join(' · '),ts:group.lastTs,firstTs:group.firstTs,latestEventId:items.reduce((best,item)=>item.ts>=best.ts?item:best,items[0]).eventId,
    problemCount:problems.length,children:Object.freeze(children),
    memoryRows:Object.freeze(memoryRowsFor(id,turnNumber,group.chatId,generationId,items)),
    problemRows:Object.freeze(problems.map((item,index)=>Object.freeze({kind:'NexusActivityProblemRow',id:id+':problem:'+index,turnId:id,turnLabel:'Turn '+turnNumber,label:'Problem',summary:item.text,ts:item.ts,
      trace:Object.freeze({chatId:group.chatId,generationId,turn:turnNumber,eventIds:Object.freeze([item.eventId]),facets:Object.freeze([item.facet])})}))),
  });
}
function memoryRowsFor(turnId,turnNumber,chatId,generationId,items){
  const memory=items.filter(item=>item.facet==='memory'&&item.kind!=='PROBLEM');if(!memory.length)return[];
  const rows=[];
  const recalled=memory.filter(item=>item.kind==='ADDED'),saved=memory.filter(item=>item.kind==='LEARNED');
  const trace=subset=>Object.freeze({chatId,generationId,turn:turnNumber,eventIds:Object.freeze([...new Set(subset.map(item=>item.eventId))]),facets:Object.freeze(['memory'])});
  if(recalled.length){const count=recalled.reduce((sum,item)=>sum+item.count,0),tokens=recalled.reduce((sum,item)=>sum+(item.tokens??0),0);
    rows.push(Object.freeze({kind:'NexusActivityMemoryRow',id:turnId+':memory:recalled',turnId,turnLabel:'Turn '+turnNumber,label:'Recalled',summary:`${count} ${plural(count,'memory','memories')} added to context`+(tokens?` · ${formatTokens(tokens)} tokens`:''),ts:Math.max(...recalled.map(item=>item.ts)),trace:trace(recalled)}));}
  if(saved.length)rows.push(Object.freeze({kind:'NexusActivityMemoryRow',id:turnId+':memory:saved',turnId,turnLabel:'Turn '+turnNumber,label:'Saved',summary:summarizeList(saved.map(item=>item.text),4),ts:Math.max(...saved.map(item=>item.ts)),trace:trace(saved)}));
  return rows;
}
function summarizeList(parts,limit){
  const unique=[...new Set(parts.filter(Boolean))];
  return unique.slice(0,limit).join('; ')+(unique.length>limit?` +${unique.length-limit} more`:'');
}
function formatTokens(value){
  const count=Math.max(0,Math.round(value));
  return count>=1000?(Math.round(count/100)/10).toString().replace(/\.0$/,'')+'k':String(count);
}
function humanize(value){return String(value??'').replace(/[_.-]+/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/\s+/g,' ').trim();}
