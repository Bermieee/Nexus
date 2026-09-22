import { estimateContentTokens } from '../observability/token-estimator.js';

function clean(value){return String(value??'').trim();}
function key(row){const book=clean(row?.book),uid=Number(row?.uid);return book&&Number.isFinite(uid)?JSON.stringify([book,uid]):'';}
export function canonicalLorePresentation(rows=[]){return [...(Array.isArray(rows)?rows:[])].sort((a,b)=>clean(a?.book).localeCompare(clean(b?.book))||(Number(a?.uid)||0)-(Number(b?.uid)||0)||clean(a?.title).localeCompare(clean(b?.title)));}
function chunk(row){return `[${clean(row?.book)} | UID ${Number(row?.uid)} | ${clean(row?.title)||'Untitled'}]\n${String(row?.content||'')}`;}
function prefix(before='',after=''){const a=String(before??''),b=String(after??''),n=Math.min(a.length,b.length);let i=0;while(i<n&&a.charCodeAt(i)===b.charCodeAt(i))i+=1;return i;}

export function sameLorePresentationMembership(left=[],right=[]){
    const signature=rows=>[...(Array.isArray(rows)?rows:[])].map(row=>key(row)||`invalid:${clean(row?.book)}:${String(row?.uid??'')}`).sort();
    const a=signature(left),b=signature(right);
    return a.length===b.length&&a.every((value,index)=>value===b[index]);
}

export function stableLorePresentation(currentCandidates=[],previousRefs=[]){
    const rows=Array.isArray(currentCandidates)?currentCandidates:[];
    const queues=new Map();
    for(const row of rows){
        const id=key(row);if(!id)continue;
        if(!queues.has(id))queues.set(id,[]);
        queues.get(id).push(row);
    }
    const used=new Set(),ordered=[];
    for(const ref of Array.isArray(previousRefs)?previousRefs:[]){
        const id=key(ref),queue=queues.get(id);if(!id||!queue?.length)continue;
        const row=queue.find(candidate=>!used.has(candidate));if(!row)continue;
        used.add(row);ordered.push(row);
    }
    for(const row of canonicalLorePresentation(rows)){
        if(used.has(row))continue;
        used.add(row);ordered.push(row);
    }
    return ordered;
}

export function planLorePresentationCache({scopeKey='',currentCandidates=[],strategy='canonical'}={}){
    const scope=String(scopeKey||'').trim()||'default';
    const previous=previousPresentationByScope.get(scope)||null;
    const requested=String(strategy||'canonical').trim().toLowerCase();
    const ordered=requested==='stable-survivors-append'&&previous
        ?stableLorePresentation(currentCandidates,previous.refs||[])
        :canonicalLorePresentation(currentCandidates);
    return{
        strategy:requested==='stable-survivors-append'?'stable-survivors-append':'canonical',
        hasPrior:!!previous,
        previousCount:Array.isArray(previous?.refs)?previous.refs.length:0,
        orderedCandidates:ordered,
    };
}

/**
 * Presentation-only cache analysis. It never decides which lore is relevant,
 * never changes budget admission, and never mutates Retrieval's semantic
 * selection. The active planner may reorder only the already-admitted set.
 */
export function analyzeLorePresentationCache({previousText='',previousRefs=[],currentCandidates=[],currentText='',baselineText='',model=''}={}){
    const priorText=String(previousText||''),rows=Array.isArray(currentCandidates)?currentCandidates:[];
    if(!priorText||!rows.length)return{hasPrior:false,currentCount:rows.length,previousCount:Array.isArray(previousRefs)?previousRefs.length:0,overlapCount:0,currentStablePrefixTokens:0,baselineStablePrefixTokens:0,stableOrderPrefixTokens:0,potentialGainTokens:0,realizedGainTokens:0,remainingPotentialGainTokens:0,wouldChangePresentation:false,actualMatchesStable:false};
    // Preserve the exact order of surviving previously-published entries, then
    // append newly selected entries deterministically. Selection membership is
    // never changed by this presentation policy.
    const canonical=canonicalLorePresentation(rows),stable=stableLorePresentation(rows,previousRefs);
    const canonicalText=canonical.map(chunk).join('\n\n');
    const stableText=stable.map(chunk).join('\n\n');
    const published=String(currentText||canonicalText),baseline=String(baselineText||canonicalText);
    const currentPrefix=prefix(priorText,published),baselinePrefix=prefix(priorText,baseline),stablePrefix=prefix(priorText,stableText);
    const currentStablePrefixTokens=estimateContentTokens(published.slice(0,currentPrefix),model);
    const baselineStablePrefixTokens=estimateContentTokens(baseline.slice(0,baselinePrefix),model);
    const stableOrderPrefixTokens=estimateContentTokens(stableText.slice(0,stablePrefix),model);
    const previousKeys=new Set((Array.isArray(previousRefs)?previousRefs:[]).map(key).filter(Boolean)),currentKeys=new Set(rows.map(key).filter(Boolean));
    let overlapCount=0;for(const id of currentKeys)if(previousKeys.has(id))overlapCount+=1;
    return{
        hasPrior:true,
        currentCount:currentKeys.size,
        previousCount:previousKeys.size,
        overlapCount,
        addedCount:[...currentKeys].filter(id=>!previousKeys.has(id)).length,
        removedCount:[...previousKeys].filter(id=>!currentKeys.has(id)).length,
        currentStablePrefixTokens,
        baselineStablePrefixTokens,
        stableOrderPrefixTokens,
        potentialGainTokens:Math.max(0,stableOrderPrefixTokens-baselineStablePrefixTokens),
        realizedGainTokens:Math.max(0,currentStablePrefixTokens-baselineStablePrefixTokens),
        remainingPotentialGainTokens:Math.max(0,stableOrderPrefixTokens-currentStablePrefixTokens),
        currentStablePrefixChars:currentPrefix,
        baselineStablePrefixChars:baselinePrefix,
        stableOrderPrefixChars:stablePrefix,
        wouldChangePresentation:stableText!==baseline,
        activePresentationChangedFromBaseline:published!==baseline,
        actualMatchesStable:published===stableText,
    };
}

// Presentation history is deliberately separate from Retrieval's semantic
// reuse state. Lore/source invalidation may correctly clear semantic reuse while
// this layer retains only the last actually-published ordering for prefix-cache
// planning. Chat lifecycle boundaries explicitly clear this history.
const previousPresentationByScope=new Map();
const MAX_PRESENTATION_SCOPES=8;

export function resetLorePresentationCacheAnalysis(){previousPresentationByScope.clear();}

export function observeLorePresentationCache({scopeKey='',currentCandidates=[],presentedCandidates=null,currentText='',baselineText='',model=''}={}){
    const scope=String(scopeKey||'').trim()||'default';
    const previous=previousPresentationByScope.get(scope)||null;
    const result=analyzeLorePresentationCache({
        previousText:previous?.text||'',
        previousRefs:previous?.refs||[],
        currentCandidates,
        currentText,
        baselineText,
        model,
    });
    const rows=Array.isArray(currentCandidates)?currentCandidates:[];
    // Store the actual presentation order, not semantic selection order, so the
    // next planner/shadow comparison is exact even after stable ordering is live.
    const actual=Array.isArray(presentedCandidates)?presentedCandidates:canonicalLorePresentation(rows);
    const presented=actual.map(row=>({book:row?.book,uid:Number(row?.uid),title:row?.title||'',content:row?.content||''}));
    previousPresentationByScope.delete(scope);
    previousPresentationByScope.set(scope,{text:String(currentText||''),refs:presented,at:Date.now()});
    while(previousPresentationByScope.size>MAX_PRESENTATION_SCOPES)previousPresentationByScope.delete(previousPresentationByScope.keys().next().value);
    return result;
}
