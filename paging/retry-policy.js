const clampInt=(value,min,max)=>Math.max(min,Math.min(max,Math.floor(Number(value)||0)));

function httpStatus(reason=''){
    const match=String(reason||'').match(/\b(?:http\s*)?\(?([45]\d\d)\)?\b/i);
    return match?Number(match[1]):null;
}

function permanentProviderFailure(reason=''){
    const text=String(reason||'').toLowerCase(),status=httpStatus(text);
    if(status!=null&&status>=400&&status<500&&!new Set([408,425,429]).has(status))return true;
    return /\b(?:unauthori[sz]ed|forbidden|authentication failed|invalid api key|invalid credential|credentials rejected)\b/i.test(text);
}

/**
 * Background lore indexing must make forward progress without turning a
 * persistent provider/configuration failure into a lorebook poll loop.
 * Non-retryable provider failures (especially 401/403 auth failures) become a
 * terminal Provider Error until the operator changes setup or explicitly
 * retries. The caller owns the timer; this helper is deliberately side-effect
 * free.
 */
export function nextLorePagingDelay({pendingCount=0,reason='',retryStreak=0}={}){
    const pending=Math.max(0,Number(pendingCount)||0),text=String(reason||'').toLowerCase();
    if(!pending)return {delayMs:null,retryStreak:0,state:'ready'};
    if(text.includes('configure-embedding-service'))return {delayMs:null,retryStreak:0,state:'paused'};
    if(permanentProviderFailure(text))return {delayMs:null,retryStreak:0,state:'provider-error'};
    if(text==='indexing'||text.includes('ready-cache-unavailable'))return {delayMs:2000,retryStreak:0,state:'indexing'};
    if(text.includes('source-changed')||text.includes('indexing-paused'))return {delayMs:5000,retryStreak:0,state:'paused'};
    const streak=clampInt(retryStreak+1,1,16);
    const delay=Math.min(300000,15000*(2**Math.min(4,streak-1)));
    return {delayMs:delay,retryStreak:streak,state:'retrying'};
}
