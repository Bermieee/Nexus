import { estimateContentTokens, resolveMainModelHint } from './token-estimator.js';

const previousPromptByScope=new Map();
const MAX_SCOPE_HISTORY=8;

function text(value){return String(value??'');}
function role(value){const out=String(value??'unknown').trim().toLowerCase();return out||'unknown';}
function fnv1a(value=''){
    const input=String(value??'');let hash=0x811c9dc5;
    for(let i=0;i<input.length;i+=1){hash^=input.charCodeAt(i);hash=Math.imul(hash,0x01000193)>>>0;}
    return `${input.length}:${hash.toString(16).padStart(8,'0')}`;
}
function contentText(content){
    if(typeof content==='string')return content;
    if(Array.isArray(content))return content.map(item=>{
        if(typeof item==='string')return item;
        if(!item||typeof item!=='object')return '';
        if(typeof item.text==='string')return item.text;
        if(typeof item.content==='string')return item.content;
        return '';
    }).filter(Boolean).join('\n');
    if(content&&typeof content==='object'){
        if(typeof content.text==='string')return content.text;
        if(typeof content.content==='string')return content.content;
    }
    return content==null?'':String(content);
}
function containsNexusFrameText(value=''){
    const input=String(value??'');
    return input.includes('[NEXUS:')||/<nexus_(?:context_legend|section)\b/i.test(input);
}
function canonicalChat(chat=[]){
    return (Array.isArray(chat)?chat:[]).map((message,index)=>{
        const messageRole=role(message?.role),name=text(message?.name).trim(),content=contentText(message?.content);
        return `#${index}\u0000${messageRole}\u0000${name}\u0000${content}`;
    }).join('\n\u0001\n');
}
function exactPrefix(before='',after=''){
    const left=String(before??''),right=String(after??''),limit=Math.min(left.length,right.length);let shared=0;
    while(shared<limit&&left.charCodeAt(shared)===right.charCodeAt(shared))shared+=1;
    return {shared,total:right.length,identical:left===right,changedChars:Math.max(0,right.length-shared)};
}
function scopeKey(surface,{chatId=null,chatEpoch=null}={}){return `${surface}:${String(chatId??'')}:${String(chatEpoch??'')}`;}
function compareMessagePrefix(priorRows=[],rows=[]){
    const before=Array.isArray(priorRows)?priorRows:[],after=Array.isArray(rows)?rows:[];
    if(!before.length)return{hasPrior:false,stableMessageCount:0,stableMessageTokens:0,firstChangedMessageIndex:null,firstChangedRole:null,firstChangedContainsNexus:false,firstNexusMessageIndex:after.findIndex(row=>row.containsNexus===true),breakScope:'first-sample'};
    const count=Math.min(before.length,after.length);let shared=0,stableMessageTokens=0;
    while(shared<count&&String(before[shared]?.signature||'')===String(after[shared]?.signature||'')){stableMessageTokens+=Number(after[shared]?.tokens)||0;shared+=1;}
    const identical=before.length===after.length&&shared===count,firstNexusMessageIndex=after.findIndex(row=>row.containsNexus===true);
    const changed=identical?null:(after[shared]||before[shared]||null),changedIndex=identical?null:shared;
    let breakScope='none';
    if(changedIndex!=null){
        if(firstNexusMessageIndex<0)breakScope='no-nexus-frame';
        else if(changedIndex<firstNexusMessageIndex)breakScope='before-nexus-frame';
        else if(changedIndex===firstNexusMessageIndex)breakScope='nexus-frame';
        else breakScope='after-nexus-frame';
    }
    return{hasPrior:true,stableMessageCount:shared,stableMessageTokens,firstChangedMessageIndex:changedIndex,firstChangedRole:changed?.role||null,firstChangedContainsNexus:changed?.containsNexus===true,firstNexusMessageIndex,breakScope};
}
function compareAndRemember(surface,serialized,meta,dryRun=false,model='',messageRows=[]){
    const key=scopeKey(surface,meta),prior=previousPromptByScope.get(key)||null,cmp=exactPrefix(prior?.serialized||'',serialized);
    const stablePrefixTokens=estimateContentTokens(serialized.slice(0,cmp.shared),model),messagePrefix=compareMessagePrefix(prior?.messageRows||[],messageRows);
    const result={
        hasPriorComparison:!!prior,
        previousPromptHash:prior?.hash||null,
        stablePrefixChars:prior?cmp.shared:0,
        stablePrefixTokens:prior?stablePrefixTokens:0,
        stablePrefixRatioPct:prior&&serialized.length?Number(((cmp.shared/serialized.length)*100).toFixed(1)):null,
        changedChars:prior?cmp.changedChars:serialized.length,
        identicalToPrevious:prior?cmp.identical:false,
        messagePrefix,
    };
    if(!dryRun){
        previousPromptByScope.delete(key);previousPromptByScope.set(key,{serialized,hash:fnv1a(serialized),at:Date.now(),messageRows:(Array.isArray(messageRows)?messageRows:[]).map(row=>({signature:row.signature,tokens:row.tokens,role:row.role,containsNexus:row.containsNexus===true}))});
        while(previousPromptByScope.size>MAX_SCOPE_HISTORY)previousPromptByScope.delete(previousPromptByScope.keys().next().value);
    }
    return result;
}

function frameMetrics(frame=null,totalChars=0){
    if(!frame||typeof frame!=='object')return null;
    const chars=Number(frame.promptChars)||0,tokens=Number(frame.promptTokens)||0;
    return{
        promptHash:frame.promptHash||null,
        promptChars:chars,
        promptTokens:tokens,
        shareOfFinalCharsPct:totalChars>0?Number(((chars/totalChars)*100).toFixed(1)):0,
        stablePrefixRatioPct:Number.isFinite(Number(frame.stablePrefixRatio))?Number((Number(frame.stablePrefixRatio)*100).toFixed(1)):null,
        stablePrefixTokens:Number(frame.stablePrefixTokens)||0,
        changedSuffixTokens:Math.max(0,tokens-(Number(frame.stablePrefixTokens)||0)),
        cacheImpact:frame.cacheImpact&&typeof frame.cacheImpact==='object'?{...frame.cacheImpact}:null,
        firstChangedSection:frame.firstChangedSection??null,
        promptLoaderAdapter:frame.promptLoaderAdapter&&typeof frame.promptLoaderAdapter==='object'?{...frame.promptLoaderAdapter}:null,
        sections:(Array.isArray(frame.sections)?frame.sections:[]).map(section=>({
            id:String(section?.id||''),chars:Number(section?.chars)||0,tokens:Number(section?.tokens)||0,reused:section?.reused===true,
        })),
    };
}

export function resetPromptLoaderTelemetryState(){previousPromptByScope.clear();}

export function analyzeChatCompletionPromptReady(eventData={},meta={}){
    const chat=Array.isArray(eventData?.chat)?eventData.chat:[],model=String(meta?.model||resolveMainModelHint()||''),serialized=canonicalChat(chat);
    const rows=chat.map((message,index)=>{
        const content=contentText(message?.content),messageRole=role(message?.role),tokens=estimateContentTokens(content,model);
        const name=String(message?.name||'').trim(),containsNexus=containsNexusFrameText(content);
        return{index,role:messageRole,namePresent:!!name,chars:content.length,tokens,containsNexus,hash:fnv1a(content),signature:fnv1a(`${messageRole}\u0000${name}\u0000${content}`)};
    });
    const roleCounts={},roleTokens={},roleChars={};
    for(const row of rows){roleCounts[row.role]=(roleCounts[row.role]||0)+1;roleTokens[row.role]=(roleTokens[row.role]||0)+row.tokens;roleChars[row.role]=(roleChars[row.role]||0)+row.chars;}
    const totalContentChars=rows.reduce((sum,row)=>sum+row.chars,0),estimatedContentTokens=estimateContentTokens(serialized,model);
    const nexusRows=rows.filter(row=>row.containsNexus),nexusContainingMessageChars=nexusRows.reduce((sum,row)=>sum+row.chars,0),nexusContainingMessageTokens=nexusRows.reduce((sum,row)=>sum+row.tokens,0);
    const nexusFrame=frameMetrics(meta?.nexusFrame,serialized.length),nexusFrameTokens=Number(nexusFrame?.promptTokens)||0;
    const nexusFrameChars=Number(nexusFrame?.promptChars)||0;
    const hostEnvelope={
        containingMessageCount:nexusRows.length,
        containingMessageChars:nexusContainingMessageChars,
        containingMessageTokens:nexusContainingMessageTokens,
        frameChars:nexusFrameChars,
        frameTokens:nexusFrameTokens,
        coLocatedChars:Math.max(0,nexusContainingMessageChars-nexusFrameChars),
        coLocatedTokens:Math.max(0,nexusContainingMessageTokens-nexusFrameTokens),
        frameIsolated:nexusRows.length===1&&nexusFrameChars>0&&nexusContainingMessageChars===nexusFrameChars,
    };
    const estimatedOutsideNexusFrameTokens=Math.max(0,estimatedContentTokens-nexusFrameTokens);
    const dialogueTokens=(roleTokens.user||0)+(roleTokens.assistant||0)+(roleTokens.tool||0);
    const systemTokens=roleTokens.system||0,nonNexusSystemTokens=Math.max(0,systemTokens-nexusContainingMessageTokens);
    return{
        surface:'chat-completion',generationId:meta?.generationId??null,chatId:meta?.chatId??null,chatEpoch:meta?.chatEpoch??null,dryRun:eventData?.dryRun===true,model:model||null,
        messageCount:rows.length,roleCounts,roleTokens,roleChars,totalChars:serialized.length,totalContentChars,estimatedContentTokens,promptHash:fnv1a(serialized),
        dialogueTokens,systemTokens,nonNexusSystemTokens,
        nexusContainingMessageChars,nexusContainingMessageTokens,hostEnvelope,
        nexusFrame,nexusFrameTokens,estimatedOutsideNexusFrameTokens,
        nexusFrameSharePct:estimatedContentTokens>0?Number(((nexusFrameTokens/estimatedContentTokens)*100).toFixed(1)):0,
        largestMessages:[...rows].sort((a,b)=>b.tokens-a.tokens||b.chars-a.chars||a.index-b.index).slice(0,8),
        stability:compareAndRemember('chat-completion',serialized,meta,eventData?.dryRun===true,model,rows),
    };
}

export function analyzeTextCompletionPromptReady(eventData={},meta={}){
    const prompt=String(eventData?.prompt??''),model=String(meta?.model||resolveMainModelHint()||'');
    return{
        surface:'text-completion',generationId:meta?.generationId??null,chatId:meta?.chatId??null,chatEpoch:meta?.chatEpoch??null,dryRun:eventData?.dryRun===true,model:model||null,
        totalChars:prompt.length,estimatedContentTokens:estimateContentTokens(prompt,model),promptHash:fnv1a(prompt),
        nexusFrame:frameMetrics(meta?.nexusFrame,prompt.length),
        stability:compareAndRemember('text-completion',prompt,meta,eventData?.dryRun===true,model),
    };
}
