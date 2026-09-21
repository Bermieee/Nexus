export const DEFAULT_VECTOR_PAGING = Object.freeze({
    mode: 'off', // off | shadow | enabled | memory-pilot (legacy)
    preset: 'balanced', // economy | balanced | quality
    memoryActivation: 'automatic',
    loreCacheMiB: 256,
    endpoint: '', model: '',
    minTurns: 100, minRecords: 80, pressureRecords: 250,
    residentLimit: 60, residentChars: 90000, wakeLimit: 8,
    warmTtlMs: 300000, activationHoldMs: 600000, minAgeTurns: 30,
    indexLimit: 4000, batchSize: 8, maxTextChars: 12000,
    foregroundBudgetMs: 150, allowForegroundEmbedding: false,
    similarityThreshold: 0.55,
});
const clamp=(v,d,min,max)=>Number.isFinite(Number(v))?Math.min(max,Math.max(min,Number(v))):d;
export function pagingConfig(raw={}) {
    const d=DEFAULT_VECTOR_PAGING, c={...d,...raw};
    c.mode=['off','shadow','enabled','memory-pilot'].includes(raw.mode)?raw.mode:'off';
    c.preset=['economy','balanced','quality'].includes(raw.preset)?raw.preset:'balanced';
    c.memoryActivation=raw.memoryActivation==='always'?'always':'automatic';
    c.loreCacheMiB=Math.floor(clamp(c.loreCacheMiB,d.loreCacheMiB,8,2048));
    for(const [key,min,max] of [['minTurns',0,10000],['minRecords',10,10000],['pressureRecords',10,20000],['residentLimit',1,2000],['residentChars',1000,2000000],['wakeLimit',1,32],['warmTtlMs',10000,3600000],['activationHoldMs',10000,3600000],['minAgeTurns',1,1000],['indexLimit',50,10000],['batchSize',1,32],['maxTextChars',256,32000],['foregroundBudgetMs',10,1000]]) c[key]=Math.floor(clamp(c[key],d[key],min,max));
    c.similarityThreshold=clamp(c.similarityThreshold,d.similarityThreshold,-1,1);
    c.residentLimit=Math.floor(clamp(c.residentLimit,d.residentLimit,1,2000));
    c.endpoint=String(c.endpoint||'').trim(); c.model=String(c.model||'').trim();
    c.allowForegroundEmbedding=c.allowForegroundEmbedding===true;
    return c;
}
export function activationDecision({turns,records,wasActive=false,activatedAt=0,now=Date.now()},c) {
    if(c.mode==='off')return {active:false,reason:'disabled'};
    if(c.memoryActivation==='always'&&records>0)return {active:true,reason:'manual-activation'};
    const enter=records>=c.pressureRecords || (turns>=c.minTurns&&records>=c.minRecords);
    const keep=wasActive&&(now-activatedAt<c.activationHoldMs||records>=Math.floor(c.minRecords*0.75));
    return {active:enter||keep,reason:enter?'history-threshold':keep?'activation-hysteresis':'small-history'};
}
export function terms(text){return [...new Set((String(text).toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]{2,}/gu)||[]))];}
export function shouldProbe(query,previous='',weak=false){
    if(!previous||weak)return true;
    if(/\b(remember|back then|years? ago|promis|earlier|used to)\b/i.test(query))return true;
    const a=terms(query),b=new Set(terms(previous));
    return a.length>0&&a.filter(x=>!b.has(x)).length/a.length>0.15;
}
