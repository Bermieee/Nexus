function isNarrativeMessage(message){return !!message&&!message.is_system&&String(message.mes||'').trim().length>0;}

export function listAssistantTurns(chat=[]){
    const out=[];
    for(let index=0;index<chat.length;index++){
        const message=chat[index];
        if(isNarrativeMessage(message)&&!message.is_user)out.push({index,ordinal:out.length+1,message});
    }
    return out;
}


export function planAutomaticSummaryWindow({turns=[],summarizedUpTo=-1,verbatimTurns=10,turnsPerSummary=3,catchUpAssistantTurns=24,catchUpThresholdAssistantTurns=12,allowPartial=false}={}){
    const pointer=Number.isFinite(Number(summarizedUpTo))?Number(summarizedUpTo):-1;
    const verbatim=Math.max(0,Number(verbatimTurns??10));
    if(!Array.isArray(turns)||!turns.length)return {due:false,reason:'no-assistant-turns',assistantTurns:0};
    const protectedStart=Math.max(0,turns.length-verbatim);
    const summarizable=turns.slice(0,protectedStart).filter(turn=>Number(turn?.index)>pointer);
    if(!summarizable.length)return {due:false,reason:'within-verbatim-window',assistantTurns:turns.length,summarizedUpTo:pointer,verbatimTurns:verbatim};
    const normalBatchCount=Math.max(1,Number(turnsPerSummary)||3);
    const catchUpTarget=Math.max(normalBatchCount,Number(catchUpAssistantTurns)||24);
    const catchUpThreshold=Math.max(normalBatchCount*3,Number(catchUpThresholdAssistantTurns)||12);
    const catchUp=summarizable.length>catchUpThreshold;
    if(!allowPartial&&!catchUp&&summarizable.length<normalBatchCount)return {due:false,reason:'awaiting-full-batch',assistantTurns:turns.length,summarizedUpTo:pointer,verbatimTurns:verbatim,availableAssistantTurns:summarizable.length,requiredAssistantTurns:normalBatchCount,remainingUntilBatch:normalBatchCount-summarizable.length,protectedAssistantTurns:Math.min(verbatim,turns.length)};
    const batchCount=Math.min(catchUp?catchUpTarget:normalBatchCount,summarizable.length);
    const batch=summarizable.slice(0,batchCount);
    const start=pointer<0?0:pointer+1;
    const end=batch[batch.length-1].index;
    return {due:true,reason:catchUp?'backlog-catch-up':'batch-due',assistantTurns:turns.length,summarizedUpTo:pointer,verbatimTurns:verbatim,batchAssistantTurns:batch.length,start,end,assistantTurnRange:[batch[0].ordinal,batch[batch.length-1].ordinal],remainingSummarizable:summarizable.length,remainingAfterBatch:Math.max(0,summarizable.length-batch.length),catchUp,catchUpTarget,protectedAssistantTurns:Math.min(verbatim,turns.length)};
}


export function planManualNextSummaryWindow({turns=[],summarizedUpTo=-1,turnsPerSummary=3,catchUpAssistantTurns=24,catchUpThresholdAssistantTurns=12}={}){
    const plan=planAutomaticSummaryWindow({turns,summarizedUpTo,verbatimTurns:0,turnsPerSummary,catchUpAssistantTurns,catchUpThresholdAssistantTurns,allowPartial:true});
    if(!plan.due)return {...plan,reason:'nothing-unsummarized'};
    return {...plan,reason:plan.catchUp?'manual-backlog-catch-up':'manual-force'};
}

export function planManualAssistantRange({chat=[],summarizedUpTo=-1,fromTurn=null,toTurn=null,turnCount=null}={}){
    const turns=listAssistantTurns(chat);const pointer=Number.isFinite(Number(summarizedUpTo))?Number(summarizedUpTo):-1;
    const nextIndex=turns.findIndex(turn=>turn.index>pointer);
    if(nextIndex<0)return {due:false,reason:'nothing-unsummarized',assistantTurns:turns.length,nextAssistantTurn:turns.length+1,summarizedUpTo:pointer};
    const nextTurn=turns[nextIndex].ordinal;
    const from=fromTurn==null?nextTurn:Number(fromTurn);
    if(!Number.isInteger(from)||from<1)throw new Error('Starting assistant turn must be a whole number of 1 or greater.');
    if(from<nextTurn)throw new Error(`Assistant turn ${from} overlaps existing memory. The next unsummarized assistant turn is ${nextTurn}.`);
    if(from>nextTurn)throw new Error(`Assistant turn ${from} would leave a chronology gap. Start at assistant turn ${nextTurn}.`);
    const to=toTurn!=null?Number(toTurn):from+Math.max(1,Number(turnCount)||1)-1;
    if(!Number.isInteger(to)||to<from)throw new Error('Ending assistant turn must be a whole number at or after the starting turn.');
    if(to>turns.length)throw new Error(`This chat currently has ${turns.length} assistant turns; turn ${to} does not exist yet.`);
    const selected=turns.slice(from-1,to);const start=pointer<0?0:pointer+1;const end=selected[selected.length-1].index;
    return {due:true,reason:'manual-assistant-range',assistantTurns:turns.length,nextAssistantTurn:nextTurn,summarizedUpTo:pointer,start,end,assistantTurnRange:[from,to],batchAssistantTurns:selected.length,remainingUnsummarized:turns.length-to};
}

export function planManualMessageRange({chat=[],fromMessage=null,toMessage=null,summarizedUpTo=-1}={}){
    const total=Array.isArray(chat)?chat.length:0;
    const from=Number(fromMessage),to=Number(toMessage);
    if(!Number.isInteger(from)||from<1)throw new Error('Starting chat message must be a whole number of 1 or greater.');
    if(!Number.isInteger(to)||to<from)throw new Error('Ending chat message must be a whole number at or after the starting message.');
    if(to>total)throw new Error(`This chat currently has ${total} messages; message ${to} does not exist yet.`);
    const start=from-1,end=to-1;
    const selectedAssistant=listAssistantTurns(chat).filter(turn=>turn.index>=start&&turn.index<=end);
    if(!selectedAssistant.length)throw new Error('The selected chat-message range does not contain an assistant turn to summarize.');
    const pointer=Number.isFinite(Number(summarizedUpTo))?Number(summarizedUpTo):-1;
    return {due:true,reason:'manual-message-range',assistantTurns:listAssistantTurns(chat).length,summarizedUpTo:pointer,start,end,messageRange:[from,to],assistantTurnRange:null,batchAssistantTurns:selectedAssistant.length,remainingUnsummarized:Math.max(0,listAssistantTurns(chat).filter(turn=>turn.index>end).length)};
}
