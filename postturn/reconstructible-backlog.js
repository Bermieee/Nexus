/* Nexus Post-turn reconstructible backlog authority. */
export const POSTTURN_BACKLOG_VERSION = 3;
export const DEFAULT_RECENT_PROCESSED_LIMIT = 256;
export const POSTTURN_FINGERPRINT_CHUNK_SIZE = 64;

function clone(value){return value==null?value:JSON.parse(JSON.stringify(value));}
function intOrNull(value){if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isInteger(n)&&n>=0?n:null;}
function fnv1a32(text){let hash=0x811c9dc5;for(let i=0;i<text.length;i+=1){hash^=text.charCodeAt(i);hash=Math.imul(hash,0x01000193)>>>0;}return hash.toString(16).padStart(8,'0');}
const SHA256_K=Object.freeze([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
function rotr32(value,bits){return (value>>>bits)|(value<<(32-bits));}
function utf8Bytes(text){if(typeof TextEncoder!=='undefined')return new TextEncoder().encode(String(text));const encoded=unescape(encodeURIComponent(String(text)));const out=new Uint8Array(encoded.length);for(let i=0;i<encoded.length;i+=1)out[i]=encoded.charCodeAt(i);return out;}
function sha256Hex(text){
    const input=utf8Bytes(text),bitLength=BigInt(input.length)*8n,totalLength=Math.ceil((input.length+9)/64)*64,data=new Uint8Array(totalLength);
    data.set(input);data[input.length]=0x80;for(let i=0;i<8;i+=1)data[totalLength-1-i]=Number((bitLength>>BigInt(i*8))&0xffn);
    const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],w=new Uint32Array(64);
    for(let offset=0;offset<data.length;offset+=64){
        for(let i=0;i<16;i+=1){const j=offset+i*4;w[i]=((data[j]<<24)|(data[j+1]<<16)|(data[j+2]<<8)|data[j+3])>>>0;}
        for(let i=16;i<64;i+=1){const a=w[i-15],b=w[i-2],s0=(rotr32(a,7)^rotr32(a,18)^(a>>>3))>>>0,s1=(rotr32(b,17)^rotr32(b,19)^(b>>>10))>>>0;w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}
        let [a,b,c,d,e,f,g,hh]=h;
        for(let i=0;i<64;i+=1){const s1=(rotr32(e,6)^rotr32(e,11)^rotr32(e,25))>>>0,ch=((e&f)^(~e&g))>>>0,t1=(hh+s1+ch+SHA256_K[i]+w[i])>>>0,s0=(rotr32(a,2)^rotr32(a,13)^rotr32(a,22))>>>0,maj=((a&b)^(a&c)^(b&c))>>>0,t2=(s0+maj)>>>0;hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
        h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+hh)>>>0;
    }
    return h.map(value=>value.toString(16).padStart(8,'0')).join('');
}
function eligibilityDescriptor(message){const extra=message?.extra&&typeof message.extra==='object'?message.extra:{};return `${extra.tv2_postturn_skip===true?'S':'-'}${extra.tv2_generation_incomplete===true?'I':'-'}${extra.tv2_generation_failed===true?'F':'-'}`;}
export function isPostTurnEligibleMessage(message){if(!message||typeof message!=='object'||message.is_user===true||message.is_system===true||!String(message.mes||'').trim())return false;const extra=message.extra&&typeof message.extra==='object'?message.extra:{};return !(extra.tv2_postturn_skip===true||extra.tv2_generation_incomplete===true||extra.tv2_generation_failed===true);}
function messageSource(chatId,index,message){const role=message?.is_user===true?'user':'assistant',system=message?.is_system===true?'system':'normal',text=String(message?.mes||''),stableId=String(message?.extra?.tv2_message_id||'');return `${String(chatId||'')}\u241f${Number(index)}\u241f${stableId}\u241f${role}\u241f${system}\u241f${eligibilityDescriptor(message)}\u241f${text}`;}
function legacyMessageSource(chatId,index,message){const role=message?.is_user===true?'user':'assistant',system=message?.is_system===true?'system':'normal',text=String(message?.mes||'');return `${String(chatId||'')}\u241f${Number(index)}\u241f${role}\u241f${system}\u241f${text}`;}
export function postTurnMessageKey(chatId,index,message){const source=messageSource(chatId,index,message);return `pt3:${sha256Hex(source)}:${source.length}`;}
function legacyPostTurnMessageKey(chatId,index,message){const source=legacyMessageSource(chatId,index,message);return `pt2:${fnv1a32(source)}:${source.length}`;}
function keyMatchesPersisted(rowKey,chatId,index,message){const key=String(rowKey||'');return key.startsWith('pt2:')?key===legacyPostTurnMessageKey(chatId,index,message):key===postTurnMessageKey(chatId,index,message);}
export function postTurnMessageKeyMatches(rowKey,chatId,index,message){return keyMatchesPersisted(rowKey,chatId,index,message);}
function latestEligibleIndex(chat){for(let i=chat.length-1;i>=0;i-=1)if(isPostTurnEligibleMessage(chat[i]))return i;return-1;}
function cleanRecent(rows,{limit}){const byIndex=new Map();for(const row of Array.isArray(rows)?rows:[]){const index=intOrNull(row?.index),key=String(row?.key||'');if(index===null||!key)continue;byIndex.set(index,{index,key});}return [...byIndex.values()].sort((a,b)=>a.index-b.index).slice(-limit);}
function chunkKey(chatId,chat,start,end){const parts=[];for(let i=start;i<=end;i+=1){const m=chat[i];parts.push(m?postTurnMessageKey(chatId,i,m):`missing:${i}`);}const source=parts.join('\u241e');return `ptc3:${sha256Hex(source)}:${parts.length}`;}
function buildProcessedChunks(chat,chatId,processedThrough){const end=Math.min(Number(processedThrough)||-1,chat.length-1);if(end<0)return[];const out=[];for(let start=0;start<=end;start+=POSTTURN_FINGERPRINT_CHUNK_SIZE){const chunkEnd=Math.min(end,start+POSTTURN_FINGERPRINT_CHUNK_SIZE-1);out.push({start,end:chunkEnd,key:chunkKey(chatId,chat,start,chunkEnd)});}return out;}
function cleanChunks(rows){const out=[];for(const row of Array.isArray(rows)?rows:[]){const start=intOrNull(row?.start),end=intOrNull(row?.end),key=String(row?.key||'');if(start===null||end===null||end<start||!key)continue;out.push({start,end,key});}return out.sort((a,b)=>a.start-b.start);}

export function normalizePostTurnBacklog(raw,{chat=[],chatId='',recentLimit=DEFAULT_RECENT_PROCESSED_LIMIT}={}){
    const source=raw&&typeof raw==='object'?clone(raw):{},limit=Math.max(16,Number(recentLimit)||DEFAULT_RECENT_PROCESSED_LIMIT),pendingStart=intOrNull(source.pendingStart),pendingEnd=intOrNull(source.pendingEnd),hasFence=source.processedThrough!==undefined;
    let processedThrough,normalizedPendingStart=pendingStart,normalizedPendingEnd=pendingEnd;
    if(!hasFence){if(pendingStart!==null)processedThrough=Math.max(-1,pendingStart-1);else{const latest=latestEligibleIndex(chat);processedThrough=Math.max(-1,latest-1);if(latest>=0)normalizedPendingStart=normalizedPendingEnd=latest;}}
    else{const parsed=Number(source.processedThrough);processedThrough=Number.isInteger(parsed)?Math.max(-1,parsed):-1;}
    if(normalizedPendingStart!==null&&normalizedPendingEnd!==null&&normalizedPendingStart>normalizedPendingEnd)[normalizedPendingStart,normalizedPendingEnd]=[normalizedPendingEnd,normalizedPendingStart];
    const recentProcessed=cleanRecent(source.recentProcessed,{limit});
    const pendingMessageIds=[...new Set((Array.isArray(source.pendingMessageIds)?source.pendingMessageIds:[]).map(v=>String(v||'').trim()).filter(Boolean))];
    let processedChunks=cleanChunks(source.processedChunks);
    // Same-chat shrink/reset can make an old numeric fence point beyond the
    // current canonical topology. Rebase to the last fully provable chunk
    // boundary (or to -1 for legacy authority) so replacement turns below the
    // old fence become visible. This normalization remains read-only until a
    // caller performs a canonical metadata commit, preserving partial-hydration
    // evidence rather than deleting it on inspection.
    if(chat.length&&processedThrough>=chat.length){
        const partial=processedChunks.find(row=>row.start<chat.length&&row.end>=chat.length);
        processedThrough=partial?Math.min(processedThrough,partial.start-1):-1;
    }
    if(!processedChunks.length&&processedThrough>=0&&chat.length>processedThrough)processedChunks=buildProcessedChunks(chat,chatId,processedThrough);
    return {version:POSTTURN_BACKLOG_VERSION,pendingMessageIds,pendingStart:normalizedPendingStart,pendingEnd:normalizedPendingEnd,deferredCount:Math.max(0,Number(source.deferredCount)||0),processedThrough,recentProcessed,processedChunks};
}
function addPendingIndex(state,index){if(!Number.isInteger(index)||index<0)return;if(state.pendingStart===null||index<state.pendingStart)state.pendingStart=index;if(state.pendingEnd===null||index>state.pendingEnd)state.pendingEnd=index;}

export function planPostTurnCatchupWindow({pendingIndices=[],chat=[],softTargetTokens=16000,contextMessages=10,estimateTokens=null}={}){
    const indices=[...new Set((pendingIndices||[]).map(Number).filter(Number.isInteger).filter(index=>index>=0&&index<chat.length))].sort((a,b)=>a-b);
    if(!indices.length)return {sourceStart:null,targetIndex:null,contextStart:null,consumedPendingIndices:[],remainingPendingIndices:[],estimatedSourceTokens:0,softTargetTokens:Math.max(1,Number(softTargetTokens)||16000),budgetLimited:false};
    const sourceStart=indices[0],target=Math.max(1,Number(softTargetTokens)||16000),contextCount=Math.max(1,Number(contextMessages)||10);
    const contextStart=Math.max(0,sourceStart-contextCount+1);
    const estimate=typeof estimateTokens==='function'?estimateTokens:(text=>Math.max(1,Math.ceil(String(text||'').length/4)));
    const rowTokens=index=>{
        const message=chat[index]||{},role=message?.is_system?'System':message?.is_user?'User':'Assistant',messageId=String(message?.extra?.tv2_message_id||'');
        return Math.max(1,Number(estimate(`[${role} @ ${index}${messageId?` | id=${messageId}`:''}]: ${String(message?.mes||'')}`))||0);
    };
    let running=0,lastScanned=contextStart-1,targetIndex=indices[0];const consumed=[];
    for(const pendingIndex of indices){
        let added=0;
        for(let index=lastScanned+1;index<=pendingIndex;index+=1)added+=rowTokens(index);
        if(consumed.length&&running+added>target)break;
        running+=added;lastScanned=pendingIndex;targetIndex=pendingIndex;consumed.push(pendingIndex);
    }
    const consumedSet=new Set(consumed),remaining=indices.filter(index=>!consumedSet.has(index));
    return {sourceStart,targetIndex,contextStart,consumedPendingIndices:consumed,remainingPendingIndices:remaining,estimatedSourceTokens:running,softTargetTokens:target,budgetLimited:remaining.length>0};
}

export function markPostTurnPendingHint(raw,messageIndex,options={}){const state=normalizePostTurnBacklog(raw,options),fallback=Math.max(0,(options.chat?.length||1)-1),index=Number.isInteger(messageIndex)?messageIndex:fallback;addPendingIndex(state,index);const messageId=String(options.messageId||'').trim();if(messageId&&!state.pendingMessageIds.includes(messageId))state.pendingMessageIds.push(messageId);return state;}
export function reconstructPostTurnPending(raw,{chat=[],chatId='',recentLimit=DEFAULT_RECENT_PROCESSED_LIMIT}={}){
    const state=normalizePostTurnBacklog(raw,{chat,chatId,recentLimit}),recovered=new Set();
    for(let index=Math.max(0,state.processedThrough+1);index<chat.length;index+=1)if(isPostTurnEligibleMessage(chat[index])){addPendingIndex(state,index);recovered.add(index);}
    for(const row of state.recentProcessed){const message=chat[row.index];if(!message)continue;if(!keyMatchesPersisted(row.key,chatId,row.index,message)){if(isPostTurnEligibleMessage(message)){addPendingIndex(state,row.index);recovered.add(row.index);}}}
    // Chunk fingerprints extend edit detection beyond the bounded recent row
    // window. A changed chunk reopens its eligible assistant turns; this is a
    // deliberate safe over-approximation rather than silently trusting a stale
    // completion fence.
    for(const chunk of state.processedChunks){if(chunk.end>=chat.length)continue;const current=chunkKey(chatId,chat,chunk.start,chunk.end);if(current===chunk.key)continue;for(let index=chunk.start;index<=chunk.end;index+=1)if(isPostTurnEligibleMessage(chat[index])){addPendingIndex(state,index);recovered.add(index);}}
    return {state,recoveredIndices:[...recovered].sort((a,b)=>a-b),reconstructed:recovered.size>0};
}
export function materializeRecoveredPendingMessageIds(raw,{chat=[],chatId='',ensureMessageId=null,recentLimit=DEFAULT_RECENT_PROCESSED_LIMIT}={}){const reconstructed=reconstructPostTurnPending(raw,{chat,chatId,recentLimit}),state=reconstructed.state;if(typeof ensureMessageId!=='function')return reconstructed;const ids=new Set(state.pendingMessageIds);for(const index of reconstructed.recoveredIndices){const m=chat[index];if(!isPostTurnEligibleMessage(m))continue;const id=String(ensureMessageId(m,index)||'').trim();if(id)ids.add(id);}if(state.pendingStart!==null&&state.pendingEnd!==null){for(let index=state.pendingStart;index<=Math.min(state.pendingEnd,chat.length-1);index+=1){const m=chat[index];if(!isPostTurnEligibleMessage(m))continue;const id=String(ensureMessageId(m,index)||'').trim();if(id)ids.add(id);}}state.pendingMessageIds=[...ids];return reconstructed;}
export function consumePostTurnRange(raw,{chat=[],chatId='',sourceStart,targetIndex,recentLimit=DEFAULT_RECENT_PROCESSED_LIMIT}={}){const state=normalizePostTurnBacklog(raw,{chat,chatId,recentLimit}),start=Math.max(0,Number(sourceStart)||0),end=Math.max(start,Math.min(Number(targetIndex)||0,Math.max(0,chat.length-1))),rows=new Map(state.recentProcessed.map(row=>[row.index,row]));for(let index=start;index<=end;index+=1){const message=chat[index];if(!message)continue;rows.set(index,{index,key:postTurnMessageKey(chatId,index,message)});}state.recentProcessed=[...rows.values()].sort((a,b)=>a.index-b.index).slice(-Math.max(16,Number(recentLimit)||DEFAULT_RECENT_PROCESSED_LIMIT));state.processedThrough=Math.max(state.processedThrough,end);state.processedChunks=buildProcessedChunks(chat,chatId,state.processedThrough);if(state.pendingEnd!==null&&state.pendingEnd>end)state.pendingStart=Math.max(end+1,state.pendingStart??(end+1));else{state.pendingStart=null;state.pendingEnd=null;state.deferredCount=0;}return state;}
