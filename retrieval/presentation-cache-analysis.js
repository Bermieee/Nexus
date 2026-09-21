import { estimateContentTokens } from '../observability/token-estimator.js';

function clean(value){return String(value??'').trim();}
function key(row){const book=clean(row?.book),uid=Number(row?.uid);return book&&Number.isFinite(uid)?JSON.stringify([book,uid]):'';}
function canonical(rows=[]){return [...(Array.isArray(rows)?rows:[])].sort((a,b)=>clean(a?.book).localeCompare(clean(b?.book))||(Number(a?.uid)||0)-(Number(b?.uid)||0)||clean(a?.title).localeCompare(clean(b?.title)));}
function chunk(row){return `[${clean(row?.book)} | UID ${Number(row?.uid)} | ${clean(row?.title)||'Untitled'}]\n${String(row?.content||'')}`;}
function prefix(before='',after=''){const a=String(before??''),b=String(after??''),n=Math.min(a.length,b.length);let i=0;while(i<n&&a.charCodeAt(i)===b.charCodeAt(i))i+=1;return i;}

/**
 * Diagnostics-only presentation simulation. It never decides which lore is
 * relevant and never mutates Retrieval state. Current selected candidates are
 * held constant; only their serialization order is compared.
 */
export function analyzeLorePresentationCache({previousText='',previousRefs=[],currentCandidates=[],currentText='',model=''}={}){
    const priorText=String(previousText||''),rows=Array.isArray(currentCandidates)?currentCandidates:[];
    if(!priorText||!rows.length)return{hasPrior:false,currentCount:rows.length,previousCount:Array.isArray(previousRefs)?previousRefs.length:0,overlapCount:0,currentStablePrefixTokens:0,stableOrderPrefixTokens:0,potentialGainTokens:0,wouldChangePresentation:false};
    const byKey=new Map(rows.map(row=>[key(row),row]).filter(([id])=>id));
    const used=new Set(),stable=[];
    // Previous live text in the legacy renderer was canonical by book/UID/title.
    // Preserve that exact surviving order, then append newly selected refs
    // deterministically.  The observer below stores real presentation order for
    // later samples so the shadow remains truthful if rendering evolves.
    for(const ref of Array.isArray(previousRefs)?previousRefs:[]){
        const id=key(ref),row=byKey.get(id);if(!id||!row||used.has(id))continue;used.add(id);stable.push(row);
    }
    for(const row of canonical(rows)){const id=key(row);if(!id||used.has(id))continue;used.add(id);stable.push(row);}
    const stableText=stable.map(chunk).join('\n\n'),published=String(currentText||canonical(rows).map(chunk).join('\n\n'));
    const currentPrefix=prefix(priorText,published),stablePrefix=prefix(priorText,stableText);
    const currentStablePrefixTokens=estimateContentTokens(published.slice(0,currentPrefix),model),stableOrderPrefixTokens=estimateContentTokens(stableText.slice(0,stablePrefix),model);
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
        stableOrderPrefixTokens,
        potentialGainTokens:Math.max(0,stableOrderPrefixTokens-currentStablePrefixTokens),
        currentStablePrefixChars:currentPrefix,
        stableOrderPrefixChars:stablePrefix,
        wouldChangePresentation:stableText!==published,
    };
}

// Diagnostics state is deliberately separate from Retrieval's semantic reuse
// state.  Lore/source invalidation may correctly clear semantic reuse while the
// provider cache still has a previous published prompt worth comparing against.
const previousPresentationByScope=new Map();
const MAX_PRESENTATION_SCOPES=8;

export function resetLorePresentationCacheAnalysis(){previousPresentationByScope.clear();}

export function observeLorePresentationCache({scopeKey='',currentCandidates=[],currentText='',model=''}={}){
    const scope=String(scopeKey||'').trim()||'default';
    const previous=previousPresentationByScope.get(scope)||null;
    const result=analyzeLorePresentationCache({
        previousText:previous?.text||'',
        previousRefs:previous?.refs||[],
        currentCandidates,
        currentText,
        model,
    });
    const rows=Array.isArray(currentCandidates)?currentCandidates:[];
    // Published legacy text is canonical. Store that actual presentation order
    // rather than semantic selection order so the next shadow comparison is exact.
    const presented=canonical(rows).map(row=>({book:row?.book,uid:Number(row?.uid),title:row?.title||'',content:row?.content||''}));
    previousPresentationByScope.delete(scope);
    previousPresentationByScope.set(scope,{text:String(currentText||''),refs:presented,at:Date.now()});
    while(previousPresentationByScope.size>MAX_PRESENTATION_SCOPES)previousPresentationByScope.delete(previousPresentationByScope.keys().next().value);
    return result;
}
