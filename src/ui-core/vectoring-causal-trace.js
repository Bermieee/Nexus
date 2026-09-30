function telemetryAttempts(events=[]){
  const rows=[];
  for(const event of Array.isArray(events)?events:[]){
    if(String(event?.category??'')!=='vector-paging')continue;
    const data=event?.data??{};
    if(event?.name==='memory-wake-probe'){
      const attempted=data?.queryVector?.attempted===true||String(data?.probe??'')==='executed';
      const available=data?.queryVector?.availability==='available';
      rows.push({
        executionId:data.probeId??event.id??null,
        operation:'EMBED_QUERY',
        executionPurpose:'MEMORY_WAKE_QUERY',
        status:available?'SUCCESS':attempted?'FAILED':'SKIPPED',
        at:event.ts??null,
        latencyMs:data.latencyMs??null,
        failureCode:available?null:(data.probeReason??data.fallbackReason??null),
        vectorCount:available?1:0,
        dimensions:null,
        selection:{
          chatId:data.chatId??null,
          turnId:data.turnId??data.turn??null,
          generationId:data.generationId??data.requestId??null,
          correlationId:data.correlationId??data.requestId??null,
        },
        memoryStatus:data.exclusionEnforced?'VECTOR_RESIDENCY':data.ordinaryRetrieval?'ORDINARY_RETRIEVAL':String(data.probe??'UNKNOWN').toUpperCase(),
        memoryDecision:data.probeReason??data.fallbackReason??null,
        candidateCount:Array.isArray(data.nominations)?data.nominations.length:(data.newlyAwakenedCount??null),
      });
    }else if(event?.name==='memory-index-slice-complete'){
      rows.push({
        executionId:event.id??('vector-index:'+String(event.ts??rows.length)),
        operation:'EMBED_ARTIFACT',
        executionPurpose:'MEMORY_INDEX',
        status:'SUCCESS',
        at:event.ts??null,
        latencyMs:data.elapsedMs??null,
        failureCode:null,
        vectorCount:data.completedUnits??null,
        dimensions:null,
        workId:'memory-index:'+String(data.sourceRevision??event.ts??rows.length),
        selection:{chatId:null,turnId:null,generationId:null,correlationId:null},
        memoryStatus:'INDEXED',
        memoryDecision:'BACKGROUND_INDEX',
        candidateCount:data.completedUnits??null,
      });
    }
  }
  return rows;
}

export function projectVectoringCausalTrace({resources=[],memoryReceipts=[],telemetryEvents=[],selection={}}={}){
  const owners=new Map((Array.isArray(memoryReceipts)?memoryReceipts:[]).slice(-128)
    .filter(row=>row?.executionId&&['MemoryVectorQueryReceipt','MemoryVectorWorkReceipt'].includes(row.kind))
    .map(row=>[String(row.executionId),row]));
  const ownerAttempts=(Array.isArray(resources)?resources:[])
    .filter(row=>String(row?.kind??'').toUpperCase()==='VECTORING')
    .flatMap(row=>(row.executionHistory??[]).slice(-64).map(attempt=>({resourceId:row.id??row.resourceId??null,...attempt})));
  const attempts=[...ownerAttempts,...telemetryAttempts(telemetryEvents)]
    .sort((a,b)=>Number(a.at??0)-Number(b.at??0)).slice(-96);
  const project=attempt=>{
    const linked=owners.get(String(attempt.executionId))??null;
    const sameQuery=attempt.operation==='EMBED_QUERY'&&linked?.kind==='MemoryVectorQueryReceipt'&&
      (linked.selection?.chatId==null||attempt.selection?.chatId==null||linked.selection?.chatId===attempt.selection?.chatId)&&
      (linked.selection?.turnId==null||attempt.selection?.turnId==null||linked.selection?.turnId===attempt.selection?.turnId)&&
      (linked.selection?.generationId==null||attempt.selection?.generationId==null||linked.selection?.generationId===attempt.selection?.generationId);
    const sameWork=attempt.operation==='EMBED_ARTIFACT'&&linked?.kind==='MemoryVectorWorkReceipt'&&linked.workId===attempt.workId;
    const owner=sameQuery||sameWork?linked:null;
    return Object.freeze({
      executionId:attempt.executionId??null,resourceId:attempt.resourceId??'nexus-vectoring',operation:attempt.operation??'UNSPECIFIED',
      status:attempt.status??'UNKNOWN',at:attempt.at??null,latencyMs:attempt.latencyMs??null,
      vectorCount:attempt.status==='SUCCESS'?attempt.vectorCount??null:null,dimensions:attempt.status==='SUCCESS'?attempt.dimensions??null:null,
      failureCode:attempt.failureCode??null,chatId:attempt.selection?.chatId??null,
      turnId:attempt.operation==='EMBED_QUERY'?attempt.selection?.turnId??null:null,
      generationId:attempt.operation==='EMBED_QUERY'?attempt.selection?.generationId??null:null,
      workId:attempt.operation==='EMBED_ARTIFACT'?attempt.workId??null:null,
      memoryStatus:attempt.memoryStatus??owner?.status??'NO_EVIDENCE',
      memoryDecision:attempt.memoryDecision??owner?.ownerDecision??'NO_EVIDENCE',
      memoryDestination:owner?.ownerDestination??null,candidateCount:attempt.candidateCount??owner?.candidateCount??null,
      nomination:(attempt.candidateCount??owner?.candidateCount??0)>0?'DENSE_SCORED_HITS_ONLY':'NO_EVIDENCE',
      downstreamLineage:'NOT_PUBLISHED',
      truth:'NO_EVIDENCE',gather:'NO_EVIDENCE',contextSeal:'NO_EVIDENCE',hostObservation:'NO_EVIDENCE',
    });
  };
  const exact=attempt=>{
    if(!selection?.generationId)return false;
    if(attempt?.selection?.generationId!=null&&String(attempt.selection.generationId)!==String(selection.generationId))return false;
    if(attempt?.selection?.chatId!=null&&selection?.chatId!=null&&String(attempt.selection.chatId)!==String(selection.chatId))return false;
    return attempt?.operation==='EMBED_QUERY'&&attempt?.selection?.generationId!=null;
  };
  return Object.freeze({kind:'VectoringActivityTrace',contractVersion:2,
    selectedTurn:Object.freeze(attempts.filter(exact).map(project)),
    background:Object.freeze(attempts.filter(attempt=>attempt.operation==='EMBED_ARTIFACT').map(project)),
    retainedAttempts:attempts.length,
    ownerReceiptsAvailable:Boolean(memoryReceipts?.length),
    telemetrySourceAvailable:Boolean((telemetryEvents??[]).some(event=>String(event?.category??'')==='vector-paging')),
    authority:'OBSERVABILITY_ONLY',rawInputsRetained:false,rawVectorsRetained:false});
}

export function safeVectoringExecution(row){
  if(!row||typeof row!=='object')return null;
  const fields=['executionId','operation','executionPurpose','status','at','latencyMs','taskType','failureCode','vectorCount','dimensions','providerId','workerId','measurementClass','actualModelId','actualProvider','workId','artifactId','artifactRevision'];
  const safe=Object.fromEntries(fields.map(key=>[key,row[key]??null]));
  safe.selection={chatId:row.selection?.chatId??null,turnId:row.selection?.turnId??null,generationId:row.selection?.generationId??null,correlationId:row.selection?.correlationId??null};
  return Object.freeze(safe);
}
