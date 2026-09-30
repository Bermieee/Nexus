export function projectVectoringCausalTrace({resources=[],memoryReceipts=[],selection={}}={}){
  const owners=new Map((Array.isArray(memoryReceipts)?memoryReceipts:[]).slice(-128)
    .filter(row=>row?.executionId&&['MemoryVectorQueryReceipt','MemoryVectorWorkReceipt'].includes(row.kind))
    .map(row=>[String(row.executionId),row]));
  const attempts=(Array.isArray(resources)?resources:[])
    .filter(row=>String(row?.kind??'').toUpperCase()==='VECTORING')
    .flatMap(row=>(row.executionHistory??[]).slice(-64).map(attempt=>({resourceId:row.id??row.resourceId??null,...attempt})))
    .sort((a,b)=>Number(a.at??0)-Number(b.at??0)).slice(-64);
  const project=attempt=>{
    const linked=owners.get(String(attempt.executionId))??null;
    const sameQuery=attempt.operation==='EMBED_QUERY'&&linked?.kind==='MemoryVectorQueryReceipt'&&
      linked.selection?.chatId===attempt.selection?.chatId&&linked.selection?.turnId===attempt.selection?.turnId&&
      linked.selection?.generationId===attempt.selection?.generationId;
    const sameWork=attempt.operation==='EMBED_ARTIFACT'&&linked?.kind==='MemoryVectorWorkReceipt'&&
      linked.workId===attempt.workId;
    const owner=sameQuery||sameWork?linked:null;
    return Object.freeze({
      executionId:attempt.executionId??null,resourceId:attempt.resourceId,operation:attempt.operation??'UNSPECIFIED',
      status:attempt.status??'UNKNOWN',at:attempt.at??null,latencyMs:attempt.latencyMs??null,
      vectorCount:attempt.status==='SUCCESS'?attempt.vectorCount??null:null,dimensions:attempt.status==='SUCCESS'?attempt.dimensions??null:null,
      failureCode:attempt.failureCode??null,chatId:attempt.selection?.chatId??null,
      turnId:attempt.operation==='EMBED_QUERY'?attempt.selection?.turnId??null:null,
      generationId:attempt.operation==='EMBED_QUERY'?attempt.selection?.generationId??null:null,
      workId:attempt.operation==='EMBED_ARTIFACT'?attempt.workId??null:null,
      memoryStatus:owner?.status??'NO_EVIDENCE',memoryDecision:owner?.ownerDecision??'NO_EVIDENCE',
      memoryDestination:owner?.ownerDestination??null,candidateCount:owner?.candidateCount??null,
      nomination:owner?.candidateCount>0?'DENSE_SCORED_HITS_ONLY':'NO_EVIDENCE',
      downstreamLineage:'NOT_PUBLISHED',
      truth:'NO_EVIDENCE',gather:'NO_EVIDENCE',contextSeal:'NO_EVIDENCE',hostObservation:'NO_EVIDENCE',
    });
  };
  const exact=attempt=>Boolean(selection?.chatId&&selection?.turnId&&selection?.generationId&&
    attempt?.selection?.chatId===selection.chatId&&attempt?.selection?.turnId===selection.turnId&&attempt?.selection?.generationId===selection.generationId);
  return Object.freeze({kind:'VectoringCausalTrace',contractVersion:1,
    selectedTurn:Object.freeze(attempts.filter(attempt=>attempt.operation==='EMBED_QUERY'&&exact(attempt)).map(project)),
    background:Object.freeze(attempts.filter(attempt=>attempt.operation==='EMBED_ARTIFACT').map(project)),
    retainedAttempts:attempts.length,ownerReceiptsAvailable:Boolean(memoryReceipts?.length),
    authority:'NONE',rawInputsRetained:false,rawVectorsRetained:false});
}

export function safeVectoringExecution(row){
  if(!row||typeof row!=='object')return null;
  const fields=['executionId','operation','executionPurpose','status','at','latencyMs','taskType','failureCode','vectorCount','dimensions','providerId','workerId','measurementClass','actualModelId','actualProvider','workId','artifactId','artifactRevision'];
  const safe=Object.fromEntries(fields.map(key=>[key,row[key]??null]));
  safe.selection={chatId:row.selection?.chatId??null,turnId:row.selection?.turnId??null,generationId:row.selection?.generationId??null,correlationId:row.selection?.correlationId??null};
  return Object.freeze(safe);
}
