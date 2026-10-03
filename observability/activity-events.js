// Product activity is a bounded metadata view of telemetry, never a source of story facts.
// Keep transport bodies and engine bookkeeping out of this independent history.
const clean=value=>typeof value==='string'&&!/^\[depth-(?:clipped|limit)\]$/.test(value)?value.replace(/\s+/g,' ').trim().slice(0,240):'';
const count=value=>['number','string'].includes(typeof value)&&Number.isFinite(Number(value))?Math.max(0,Number(value)):0;
function workPurpose(value){
  const purpose=clean(value);
  if(/summar/i.test(purpose))return 'Summarize chat';
  if(/notebook/i.test(purpose))return 'Update working notes';
  if(/scene/i.test(purpose))return 'Read the scene';
  if(/builder|world.?tree/i.test(purpose))return 'Organize the World Tree';
  if(/retriev|lore/i.test(purpose))return 'Find relevant lore';
  if(/memory|recall/i.test(purpose))return 'Recall memories';
  if(/maintenan|housekeep/i.test(purpose))return 'Check story data';
  if(/truth|jev|decision|sensory|cognitive|scatter|gather|budget|probe/i.test(purpose))return '';
  return purpose;
}
const fields=new Set(`chatId generationId turn jobId requestId transactionId slot reason stage jobType label model latencyMs
  entryCount renderedEntryCount estimatedTokens estimatedInjectionTokens selectedCount characterMemoryCount chars
  source noOp createdNodes createdEdges supersededNodes supersededEdges nodeCount edgeCount learnedNodes learnedConnections
  id title kind from to relation refs selected textPreview memoryId turnRange start end layer sourceLayer targetLayer location participants
  boundaryConfirmed counts ADMITTED LATE STALE INVALID REJECTED status failedStepCount deferredStepCount failedSteps
  code message name error book nexusScope selection updatedBy revisions manual sections failedOutlets tokens reused findings suggestions memoryIssues findingCount suggestionCount`.split(/\s+/));

export function activityMetadataOnly(value,depth=0){
  if(depth>4)return undefined;
  if(value==null||typeof value==='boolean'||typeof value==='number')return value;
  if(typeof value==='string')return clean(value);
  if(Array.isArray(value))return value.slice(0,24).map(item=>activityMetadataOnly(item,depth+1));
  if(typeof value!=='object')return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key])=>fields.has(key)||fields.has(key.toUpperCase())).map(([key,item])=>[key,activityMetadataOnly(item,depth+1)]).filter(([,item])=>item!==undefined));
}

export function activityOutcome(record={}){
  if(!record||typeof record!=='object')return null;
  const category=String(record.category??'').toLowerCase(),name=String(record.name??'').toLowerCase();
  const d=record.data??{},key=category+'|'+name;
  const result=(source,summary,facet='story',problem=false)=>({source,summary,facet,problem});
  if(category==='retrieval'&&['injection-complete','injection-reused'].includes(name)){
    const total=count(d.entryCount??d.renderedEntryCount);if(!total)return null;
    const titles=(Array.isArray(d.refs)?d.refs:[]).map(ref=>clean(ref?.title)).filter(Boolean);
    return result('Retrieval',`${name==='injection-reused'?'Reused':'Added'} ${total} lore ${total===1?'entry':'entries'}${titles.length?' · '+titles.slice(0,3).join(', '):''}`);
  }
  if(category==='memory-recall'&&name==='injection-complete'){
    const total=count(d.selectedCount)+count(d.characterMemoryCount);if(!total)return null;
    const preview=(Array.isArray(d.selected)?d.selected:[]).map(row=>clean(row?.textPreview)).find(Boolean);
    return result('Memory Recall',`${total} ${total===1?'memory':'memories'} added to context${preview?' · '+preview.slice(0,100):''}`,'memory');
  }
  if(category==='nexus.scene'&&name==='scanner-observed'&&clean(d.location))return result('Scene',`${d.boundaryConfirmed?'Scene changed':'Scene continues'} · ${clean(d.location)}`);
  if(category==='worldtree.intake'&&['applied','applied-deterministic'].includes(name)){
    if(d.noOp||['lore','owner'].includes(d.source))return null;
    const nodes=count(d.createdNodes??d.nodeCount),links=count(d.createdEdges??d.edgeCount),replaced=count(d.supersededNodes);
    if(!nodes&&!links&&!replaced)return null;
    const labels=(Array.isArray(d.learnedNodes)?d.learnedNodes:[]).map(node=>clean(node?.label)).filter(Boolean);
    const parts=[];
    if(nodes)parts.push(`${nodes} ${name==='applied'?'new':'updated'} ${nodes===1?'entry':'entries'}${labels.length?' · '+labels.slice(0,3).join(', '):''}`);
    if(links)parts.push(`${links} ${name==='applied'?'new ':''}${links===1?'connection':'connections'}`);
    if(replaced)parts.push(`${replaced} ${replaced===1?'entry':'entries'} superseded`);
    return result('World Tree',parts.join(' · '),['memory','character-memory'].includes(d.source)?'memory':'story');
  }
  if(category==='summary'&&['created','promoted'].includes(name)){
    const range=d.turnRange,where=range&&range.start!=null?` · messages ${range.start}–${range.end??range.start}`:'';
    return result('Summary',(name==='created'?'Saved a chat summary':'Condensed older memories')+where+(clean(d.textPreview)?' · '+clean(d.textPreview).slice(0,100):''),'memory');
  }
  if(category==='notebook'&&['updated','updated-manual','sidecar-refresh-complete','rolled-back','summary-digested'].includes(name)){
    const action=name==='rolled-back'?'Restored the previous notes':name==='summary-digested'?'Added a summary to working notes':'Updated working notes';
    return result('Notebook',action+(clean(d.reason)?' · '+clean(d.reason):''),'memory');
  }
  if(category==='learning'&&name==='post-turn-receipt'){
    const failed=['FAILED','PARTIAL'].includes(d.status)||count(d.failedStepCount)>0;
    if(failed)return result('Learning','Some post-reply learning could not finish','story',true);
    // Facts and connections are reported by their committed owners, not this step counter.
    if(d.status==='COMPLETE')return result('Learning','Finished checking this reply for story updates');
  }
  if(category==='nexus.gather'&&name==='gather.summary'){
    const c=Object.fromEntries(Object.entries(d.counts??{}).map(([key,value])=>[key.toUpperCase(),value])),missing=count(c.LATE)+count(c.STALE)+count(c.INVALID)+count(c.REJECTED);
    if(!missing)return null;
    return result('Context',`${missing} ${missing===1?'result was':'results were'} unavailable or out of date for this reply`,'story',true);
  }
  if(category==='generation-frame'&&name==='applied'){
    const sections=(Array.isArray(d.sections)?d.sections:[]).filter(section=>count(section?.chars)>0);
    const missing=Array.isArray(d.failedOutlets)?d.failedOutlets.length:0;
    if(!sections.length)return missing?result('Context','Could not prepare Nexus context for this reply','story',true):null;
    const labels=sections.map(section=>clean(section.label)||String(section.id??'').replace(/[_-]/g,' ').toLowerCase()).filter(Boolean);
    return result('Context',`Prepared for this reply · ${labels.slice(0,4).join(', ')}${labels.length>4?' +'+(labels.length-4)+' more':''}${missing?' · some context unavailable':''}`,'story',missing>0);
  }
  if(/^sidecar-[ab]$/.test(category)&&['request-start','request-success','request-error','request-failure','request-cancelled','request-semantic-repair-needed'].includes(name)){
    const failed=['request-error','request-failure','request-semantic-repair-needed'].includes(name);
    const purpose=workPurpose(d.reason??d.label??d.jobType??d.stage);if(!purpose&&!failed&&name!=='request-cancelled')return null;
    const action={'request-start':'Working on','request-success':'Response ready','request-cancelled':'Stopped','request-semantic-repair-needed':'Needs another attempt'}[name]??'Could not complete';
    return result('Side '+category.slice(-1).toUpperCase(),`${action} · ${purpose||'background work'}`,'story',failed);
  }
  const problems={
    'worldtree.intake|rejected':['World Tree','A World Tree update was rejected'],
    'worldtree.intake|memory-contribution-deferred':['World Tree','A memory update to the World Tree was postponed'],
    'retrieval|foreground-retrieval-failed':['Retrieval','Could not retrieve new lore for this reply'],
    'retrieval|foreground-retrieval-degraded':['Retrieval','Lore retrieval used a reduced mode'],
    'memory-recall|rerank-failed':['Memory Recall','Used simpler memory ranking after a failure'],
    'memory-recall|foreground-recall-failed':['Memory Recall','Could not recall memories for this reply'],
    'summary|create-failed':['Summary','Could not save a chat summary'],
    'summary|promotion-failed':['Summary','Could not condense older memories'],
    'notebook|sidecar-refresh-rejected':['Notebook','Could not update working notes'],
    'world-tree|legacy-lore-sync-failed':['World Tree','Could not refresh the Lorebook source'],
    'world-tree|chat-state-hydrate-failed':['World Tree','Could not restore this story’s saved tree'],
    'proposals|execution-failed':['Proposal','Could not apply the approved change'],
  };
  if(problems[key])return result(...problems[key],/memory|summary|notebook/.test(category)?'memory':'story',true);
  if(record.level==='error'&&/^(retrieval|memory(-recall)?|summary|notebook|world-tree|worldtree\.intake|learning|maintenance)$/.test(category))
    return result(category==='world-tree'||category.startsWith('worldtree')?'World Tree':category.replace(/-/g,' '),'Could not complete '+name.replace(/[-_.]/g,' '),'story',true);
  return null;
}

export function retainActivityEvent(record){
  if(!activityOutcome(record))return null;
  return {id:record.id,ts:record.ts,category:record.category,name:record.name,level:record.level,data:activityMetadataOnly(record.data)};
}
