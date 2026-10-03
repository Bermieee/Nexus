const MAX_EVENTS=240;
const MEMORY=/memory|recall|bank|consolidat/i;
const PROPOSALS=/proposal|review|authoring|tool-gateway|operator-review|commit-gateway/i;

export function projectNexusActivityFeed({telemetry={},queue={},mainBridge={},settings={}}={}){
  const raw=Array.isArray(telemetry?.events)?telemetry.events:[];
  const events=milestones(raw.slice(-MAX_EVENTS));
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
    detailFields:activityMetadata(record.data??{}),
    relatedEvents:Object.freeze([]),
    rawCategory:category,
  });
}

function sourceFor(signature,data={}){
  if(/^lore loaded$/.test(signature))return source('lorebook','Lorebook','amber','▤');
  for(const [pattern,id,label,tone,icon] of [
    [/nexus\.truth|a52\.truth/,'truth','Truth','teal','◈'],
    [/nexus\.sensory|a52\.sensory/,'sensory','Sensory','violet','◎'],
    [/nexus\.walker|a52\.walker/,'graph-walker','Graph Walker','teal','⌘'],
    [/nexus\.hot|a52\.hot/,'hot-cognition','Hot Cognition','blue','◌'],
    [/nexus\.scatter|a52\.scatter/,'scatter','Scatter','blue','⇄'],
    [/nexus\.gather|a52\.gather/,'gather','Gather','teal','◇'],
  ])if(pattern.test(signature))return source(id,label,tone,icon);
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
    const declared=String(data?.slot??data?.resourceKey??signature.match(/sidecar-([ab])/i)?.[1]??'').toUpperCase();
    const slot=declared==='B'?'B':declared==='A'?'A':'';
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
  const name=String(record?.name??'').toLowerCase(),category=String(record?.category??'').toLowerCase();
  const n=value=>value!=null&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
  const count=n(data.entryCount??data.renderedEntryCount),tokens=n(data.estimatedInjectionTokens??data.estimatedTokens);
  const tokenText=tokens==null?'':' · ~'+tokens.toLocaleString('en-US')+' tokens';
  if(category==='lore'&&name==='loaded')return 'Source read · '+short(data.book,100)+(count==null?'':' · '+count+' entries');
  if(category==='retrieval'&&name==='injection-complete'&&count!=null)return count+' Lore '+(count===1?'entry':'entries')+' added to context'+tokenText;
  if(category==='memory-recall'&&name==='injection-complete'&&n(data.selectedCount)!=null)return data.selectedCount+' '+(Number(data.selectedCount)===1?'memory':'memories')+' added to context'+tokenText;
  if(source.id==='sensory'&&name==='candidate-envelope'&&n(data.candidateCount)!=null)return 'Considered '+data.candidateCount+' retrieval candidates';
  if(source.id==='truth'&&name==='assessment-complete'){
    const parts=[];
    if(n(data.candidateCount)!=null)parts.push('Reviewed '+data.candidateCount+' candidates');
    if(n(data.keptCount)!=null)parts.push(data.keptCount+' kept');
    if(n(data.droppedCount)!=null)parts.push(data.droppedCount+' dropped');
    if(n(data.unresolvedCount)>0)parts.push(data.unresolvedCount+' unresolved');
    if(parts.length)return parts.join(' · ');
  }
  if(source.id.startsWith('sidecar')&&['request-start','request-success','request-error'].includes(name)){
    const parts=[name==='request-start'?'Working':name==='request-success'?'Request completed':'Request failed'];
    const purpose=data.reason??data.stage??data.jobType??data.label;if(purpose)parts.push(short(purpose,100));
    if(data.model)parts.push('model '+short(data.model,100));
    if(name!=='request-start'&&n(data.latencyMs)!=null)parts.push((Number(data.latencyMs)/1000).toFixed(1)+' s');
    return parts.join(' · ');
  }
  if(source.id==='gather'&&name==='gather.summary'&&data.counts){
    const parts=Object.entries(data.counts).filter(([,value])=>n(value)!=null).map(([key,value])=>value+' '+String(key).toLowerCase());
    if(parts.length)return parts.join(' · ');
  }
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

// Keep operator milestones separate. Repeated implementation steps remain
// inspectable inside the matching function's action, never across story fences.
function milestones(records){
  const rows=records.map(projectNexusActivityEvent),visible=[],groups=new Map();
  let unscopedRun=0,priorSource=null;
  const keys=records.map((record,index)=>{
    const data=record.data??{},selection=data.selection??data,scope=data.nexusScope??{},chat=selection.chatId??scope.chatId,generation=selection.generationId??scope.generationId;
    // Budget receipts use jobId for the cost profile, not a physical job.
    const budget=/^budget[.-]plan$/.test(String(record.name??''));
    if(chat!=null&&generation!=null){unscopedRun++;priorSource=null;return JSON.stringify([chat,generation,budget?null:data.jobId??null,rows[index].sourceId]);}
    const job=budget?null:data.jobId??data.schedulerTaskId??data.correlationId??data.planId;
    if(job!=null){unscopedRun++;priorSource=null;return JSON.stringify([chat??null,'job:'+job,rows[index].sourceId]);}
    if(rows[index].sourceId!==priorSource||index===0||!isDetailStep(records[index-1]))unscopedRun++;
    priorSource=rows[index].sourceId;return JSON.stringify(['unscoped',unscopedRun,rows[index].sourceId]);
  });
  rows.forEach((row,index)=>{
    if(!isDetailStep(records[index])){visible.push({row,index});return;}
    const key=keys[index];if(!groups.has(key))groups.set(key,[]);groups.get(key).push({row,index});
  });
  for(const [key,steps] of groups){
    const anchors=visible.filter(item=>keys[item.index]===key);
    // Prefer a terminal account of the same function when it has arrived.
    const anchor=anchors.find(item=>/assessment-complete|candidate-envelope/.test(item.row.eventName))??anchors.at(-1);
    const relatedEvents=Object.freeze(steps.map(item=>item.row));
    if(anchor)anchor.row=Object.freeze({...anchor.row,relatedEvents});
    else{
      const first=steps[0],last=steps.at(-1),label=first.row.sourceId==='truth'?'Reviewing candidate evidence':first.row.sourceId==='sensory'?'Preparing retrieval budgets':'Processing details';
      visible.push({index:last.index,row:Object.freeze({...first.row,ts:last.row.ts,summary:label+' · '+steps.length+' steps',relatedEvents})});
    }
  }
  return visible.sort((a,b)=>a.index-b.index).map(item=>item.row);
}
function isDetailStep(record={}){
  if(['warn','error'].includes(String(record.level).toLowerCase()))return false;
  const name=String(record.name??'').toLowerCase();
  return /^(candidate-verdict|budget[.-]plan|foreground-progress|foreground-preflight-progress|dispatch-requested|dispatch-enqueued|dispatch-complete|drain-complete|hard-lock-enqueued|job-assigned|route-enqueued|adaptive-physical-worker-observed|resource-selected|plan|chat-state-persisted|lore[.-]read-parity|native-worldinfo-suppression-evaluated|native-worldinfo-suppression-committed|chat-completion-telemetry-flushed|adapter-verified|settings-ready|text-completion-ready|region-scan-prepared|node-scan-prepared|injection-batch-plan|presentation-cache-analysis|warm-injection-utilization|gather[.-]verdict)$/.test(name);
}

const DETAIL_FIELDS=new Set(`
  chatId generationId turnId correlationId jobId taskId schedulerTaskId schedulerPlanId planId receiptId candidateId
  channelId sceneId worldRevision sceneRevision sourceRevisionRefs status state reasonCode reason error code
  classification kept supportOnly usableForIntent intent kind slot model stage jobType label role bus phase
  latencyMs elapsedMs queueWaitMs count candidateCount entryCount selectedCount renderedEntryCount keptCount droppedCount
  unresolvedCount disputedCount completedUnits totalUnits remainingUnits inputCount outputCount inputNominationCount
  inputChannelCount nominationCount traversedNodeCount traversedEdgeCount staleRejectedCount hotRevision changedSegmentCount
  reusedSegmentCount invalidatedSegmentCount activeSegmentCount changedSegments invalidatedSegments estimatedInjectionTokens
  estimatedTokens budgetTokens admittedCount rejectedCount deferredCount book uid title refs selectedRefs publishedRefs
  candidateIds channelIds freshness unavailableChannels degradedChannels selection counts coverage fusionReceipt channelReceipts
  verdict ownerAccepted physicalAttempt returned source eventType cycleId stepCount completedAt location participants activity
  narrativeTime allowed examined total deferred complete continuation ceilingHit offset drivers remainingMs reservedMs
  msPerUnit promptTokens tokenShare worldSize multiplier siteId contractId decisionId choice confidence provider
  usage usageEstimated inputTokens outputTokens totalTokens cachedInputTokens cacheWriteTokens reasoningTokens
`.trim().split(/\s+/));
function activityMetadata(input={},depth=0){
  if(depth>4)return null;
  if(input==null||typeof input==='boolean'||typeof input==='number')return input;
  if(typeof input==='string')return short(input,240);
  if(Array.isArray(input))return Object.freeze(input.slice(0,96).map(value=>activityMetadata(value,depth+1)));
  if(typeof input!=='object')return null;
  const out={};for(const [key,value] of Object.entries(input))if(DETAIL_FIELDS.has(key)||['ADMITTED','ACCEPTED','REJECTED','INVALID','LATE','STALE','CURRENT','HISTORICAL','UNRESOLVED','COMPLETE','FAILED'].includes(key)){
    const safe=activityMetadata(value,depth+1);if(safe!=null)out[key]=safe;
  }
  return Object.freeze(out);
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
