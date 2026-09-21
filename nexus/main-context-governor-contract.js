function text(value){return String(value??'').trim();}
export function isGovernorSystemMessage(message){return message?.is_system===true;}
export function isGovernorNarrativeMessage(message){return !!message&&!isGovernorSystemMessage(message)&&text(message?.mes).length>0;}
export function isGovernorAssistantMessage(message){return isGovernorNarrativeMessage(message)&&message?.is_user!==true;}
export function isGovernorUserMessage(message){return isGovernorNarrativeMessage(message)&&message?.is_user===true;}
export function hasGovernorAttachment(message){
    const extra=message?.extra;
    return !!(message?.image||message?.file||message?.files?.length||extra?.image||extra?.file||extra?.files?.length||extra?.media||extra?.attachments?.length);
}
function clampInt(value,min,max,fallback){const n=Math.floor(Number(value));return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;}
export function governorAssistantIndices(chat=[]){const out=[];for(let i=0;i<chat.length;i++)if(isGovernorAssistantMessage(chat[i]))out.push(i);return out;}
export function governorAssistantCountFrom(chat,start){let n=0;for(let i=Math.max(0,start);i<chat.length;i++)if(isGovernorAssistantMessage(chat[i]))n++;return n;}
export function governorPairedTailStart(chat=[],assistantKeep=10){
    const turns=governorAssistantIndices(chat);if(!turns.length)return 0;
    const keep=Math.max(1,Math.floor(Number(assistantKeep)||10));
    const firstAssistant=turns[Math.max(0,turns.length-keep)];
    let start=firstAssistant;
    for(let i=firstAssistant-1;i>=0;i--){
        if(isGovernorAssistantMessage(chat[i]))break;
        if(isGovernorUserMessage(chat[i]))start=i;
    }
    return Math.max(0,start);
}
export function governorPreservedOldIndices(chat,start){
    const out=[];
    for(let i=0;i<Math.max(0,start);i++)if(isGovernorSystemMessage(chat[i])||hasGovernorAttachment(chat[i]))out.push(i);
    return out;
}

export function planMainContextWindow({chat=[],summarizedUpTo=-1,previous=null,verbatimTurns=10,maxRawAssistantTurns=18}={}){
    const rows=Array.isArray(chat)?chat:[];
    const pointer=Number.isFinite(Number(summarizedUpTo))?Math.floor(Number(summarizedUpTo)):-1;
    const verbatim=clampInt(verbatimTurns,1,100,10);
    const highWater=Math.max(verbatim+2,clampInt(maxRawAssistantTurns,verbatim+2,200,18));
    const assistants=governorAssistantIndices(rows);
    if(!assistants.length)return {active:false,reason:'no-assistant-turns',startIndex:0,assistantTurns:0,verbatimTurns:verbatim,maxRawAssistantTurns:highWater};
    if(pointer<0)return {active:false,reason:'no-summary-coverage',startIndex:0,assistantTurns:assistants.length,verbatimTurns:verbatim,maxRawAssistantTurns:highWater};

    const tailStart=governorPairedTailStart(rows,verbatim);
    const safeStart=Math.max(0,Math.min(tailStart,pointer+1,rows.length));
    if(safeStart<=0)return {active:false,reason:'summary-coverage-not-far-enough',startIndex:0,assistantTurns:assistants.length,verbatimTurns:verbatim,maxRawAssistantTurns:highWater,tailStart,summarizedUpTo:pointer};

    let start=Number(previous?.startIndex);
    let rolled=false,restored=false,initialized=false;
    if(!Number.isInteger(start)||start<0||start>rows.length){start=safeStart;initialized=true;}
    if(start>pointer+1){start=0;restored=true;}
    if(start===0&&restored){
        return {active:false,reason:'summary-coverage-regressed',startIndex:0,assistantTurns:assistants.length,verbatimTurns:verbatim,maxRawAssistantTurns:highWater,tailStart,safeStart,summarizedUpTo:pointer,restored};
    }
    if(initialized)start=safeStart;

    let rawAssistantTurns=governorAssistantCountFrom(rows,start);
    const rawAssistantTurnsBeforeRoll=rawAssistantTurns;
    if(!initialized&&rawAssistantTurns>highWater&&safeStart>start){
        start=safeStart;rawAssistantTurns=governorAssistantCountFrom(rows,start);rolled=true;
    }
    const oldPreserved=governorPreservedOldIndices(rows,start);
    return {
        active:start>0,
        reason:initialized?'epoch-initialized':rolled?'epoch-rolled':'epoch-reused',
        startIndex:start,
        assistantTurns:assistants.length,
        rawAssistantTurns,
        rawAssistantTurnsBeforeRoll,
        verbatimTurns:verbatim,
        maxRawAssistantTurns:highWater,
        summarizedUpTo:pointer,
        tailStart,
        safeStart,
        rolled,
        initialized,
        restored,
        preservedOldIndices:oldPreserved,
        removedNarrative:Math.max(0,start-oldPreserved.length),
    };
}
