const MAX_EVENTS=240;
const MEMORY=/memory|recall|bank|consolidat/i;
const PROPOSALS=/proposal|review|authoring|tool-gateway|operator-review|commit-gateway/i;

export function projectNexusActivityFeed({telemetry={},queue={},mainBridge={},settings={}}={}){
  const raw=Array.isArray(telemetry?.events)?telemetry.events:[];
  const events=raw.slice(-MAX_EVENTS).map(projectNexusActivityEvent).filter(Boolean);
  const counts={ALL:events.length,MEMORY:0,PROPOSALS:0,SYSTEM:0};
  for(const row of events)counts[row.tab]=(counts[row.tab]??0)+1;
  const lanes=queue?.lanes??{};
  const sidecars=settings?.sidecars??{};
  const status=Object.freeze({
    main:Object.freeze({label:'Main',state:mainState(mainBridge),active:mainBridge?.active===true}),
    A:Object.freeze({label:'A',state:sidecarState(lanes?.A,sidecars?.A),active:Array.isArray(lanes?.A?.running)&&lanes.A.running.length>0}),
    B:Object.freeze({label:'B',state:sidecarState(lanes?.B,sidecars?.B),active:Array.isArray(lanes?.B?.running)&&lanes.B.running.length>0}),
    running:Array.isArray(queue?.running)?queue.running.length:0,
    queued:Array.isArray(queue?.queued)?queue.queued.length:0,
  });
  return Object.freeze({
    kind:'NexusActivityFeed',
    contractVersion:'1.0.0',
    events:Object.freeze(events),
    counts:Object.freeze(counts),
    status,
    latestEventId:events.at(-1)?.id??null,
    latestEventTs:events.at(-1)?.ts??null,
    totalRetained:raw.length,
    metadataOnly:true,
  });
}

export function projectNexusActivityEvent(record={}){
  const category=clean(record?.category)||'system';
  const name=clean(record?.name)||'event';
  const signature=(category+' '+name).toLowerCase();
  const source=sourceFor(signature,record?.data);
  const tab=tabFor(signature,source.id);
  const level=['debug','info','warn','error'].includes(String(record?.level))?String(record.level):'info';
  return Object.freeze({
    kind:'NexusActivityFeedEvent',
    id:clean(record?.id)||('activity:'+String(record?.ts??Date.now())+':'+category+':'+name),
    ts:Number(record?.ts)||0,
    level,
    tab,
    sourceId:source.id,
    source:source.label,
    tone:source.tone,
    icon:source.icon,
    title:source.label,
    eventName:name,
    eventLabel:human(name),
    summary:describe(record,source),
    detail:detail(record),
    rawCategory:category,
  });
}

function sourceFor(signature,data={}){
  if(/decision core|decision-core|\bdecision\b|\bjev\b/.test(signature))return source('jev','Jev','orange','◉');
  if(/scene-intelligence|scene scanner|scene-scanner|\bscene\b/.test(signature))return source('scene-intelligence','Scene Intelligence','blue','⌾');
  if(/vector-paging|vectoring|embedding|embed/.test(signature))return source('vectoring','Vectoring','violet','⌘');
  if(/smart-context|smart context|warmer/.test(signature))return source('smart-context','Smart Context','teal','⚑');
  if(/summary|summar/.test(signature))return source('summary','Summary','violet','✣');
  if(/maintenance|housekeep/.test(signature))return source('maintenance','Maintenance','orange','!');
  if(/memory-recall|memory recall/.test(signature))return source('memory-recall','Memory Recall','teal','↶');
  if(MEMORY.test(signature))return source('memory','Memory','violet','▰');
  if(/retrieval/.test(signature))return source('retrieval','Retrieval','violet','⌁');
  if(/search/.test(signature))return source('search','Search','teal','⌕');
  if(/character/.test(signature))return source('character','Character','blue','▣');
  if(/scheduler/.test(signature))return source('scheduler','Scheduler','blue','◫');
  if(/queue-dispatcher|queue guardian|queue-guardian/.test(signature))return source('queue','Queue Dispatcher','blue','◌');
  if(/model-worker|model worker/.test(signature))return source('model-worker','Model Worker','blue','◉');
  if(/sidecar/.test(signature)){
    const slot=String(data?.slot??data?.resourceKey??'').toUpperCase().includes('B')?'B':String(data?.slot??data?.resourceKey??'').toUpperCase().includes('A')?'A':'';
    return source(slot?'sidecar-'+slot.toLowerCase():'sidecar',slot?'SC-'+slot:'Sidecar','teal','⚙');
  }
  if(/batch/.test(signature))return source('batch','Batch','amber','▰');
  if(/lifecycle/.test(signature))return source('lifecycle','Lifecycle','blue','✓');
  if(/world-tree|lore/.test(signature))return source('world-tree','World Tree','amber','▤');
  if(/prompt-loader|context|delivery/.test(signature))return source('context','Context Delivery','blue','▥');
  if(/proposal|review|authoring/.test(signature))return source('proposals','Proposals','violet','◇');
  return source('system',human(categoryFrom(signature))||'System','blue','◌');
}
function source(id,label,tone,icon){return{id,label,tone,icon};}
function tabFor(signature,sourceId){
  if(MEMORY.test(signature)||sourceId==='memory'||sourceId==='memory-recall')return'MEMORY';
  if(PROPOSALS.test(signature)||sourceId==='proposals')return'PROPOSALS';
  return'SYSTEM';
}
function mainState(main={}){
  const mode=String(main?.mode??'').toLowerCase();
  if(mode==='active')return'working';
  if(mode==='ready')return'idle';
  if(mode==='partial')return'partial';
  if(mode==='disconnected')return'disconnected';
  return'disabled';
}
function sidecarState(lane={},settings={}){
  const running=Array.isArray(lane?.running)?lane.running.length:0;
  const queued=Array.isArray(lane?.queued)?lane.queued.length:0;
  if(running)return'working';
  if(queued)return'queued';
  return settings?.enabled===true?'idle':'disabled';
}
function describe(record,source){
  const data=record?.data??{};
  const direct=[data.message,data.summary,data.detail].map(short).find(Boolean);
  if(direct)return direct;
  const label=human(record?.name??'event');
  const parts=[];
  for(const [key,title] of [
    ['status',''],['state',''],['reasonCode',''],['reason',''],
    ['count','count'],['candidateCount','candidates'],['completedUnits','complete'],['remainingUnits','remaining'],
    ['findings','findings'],['suggestions','suggestions'],['model','model'],['book','book'],
  ]){
    const value=data?.[key];
    if(value==null||value===''||typeof value==='object')continue;
    const text=short(value,70);if(!text)continue;
    parts.push(title?title+' '+text:text);
    if(parts.length>=3)break;
  }
  return parts.length?label+' · '+parts.join(' · '):label;
}
function detail(record){
  const data=record?.data;
  if(!data||typeof data!=='object'||Array.isArray(data))return null;
  const out=[];
  for(const [key,value] of Object.entries(data)){
    if(value==null||value===''||typeof value==='object')continue;
    if(/prompt|response|reasoning|content|body|api.?key|authorization|secret|password|token/i.test(key))continue;
    const text=short(value,120);if(text)out.push(human(key)+': '+text);
    if(out.length>=6)break;
  }
  return out.length?out.join(' · '):null;
}
function categoryFrom(signature){return signature.split(' ')[0]||'system';}
function human(value){
  return String(value??'').replace(/[_-]+/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/\s+/g,' ').trim().replace(/\b\w/g,m=>m.toUpperCase());
}
function short(value,limit=180){
  const text=String(value??'').replace(/\s+/g,' ').trim();
  if(!text)return'';
  return text.length>limit?text.slice(0,limit-1)+'…':text;
}
function clean(value){const text=String(value??'').trim();return text||null;}
