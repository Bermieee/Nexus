import { estimateContentTokens } from '../observability/token-estimator.js';

function clipByTokens(text, maxTokens, { preserveTail = true } = {}) {
    const raw = String(text || '');
    const cap = Math.max(1, Math.floor(Number(maxTokens) || 1));
    if (estimateContentTokens(raw) <= cap) return raw;
    let low = 0, high = raw.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const sample = preserveTail ? raw.slice(raw.length - mid) : raw.slice(0, mid);
        if (estimateContentTokens(sample) <= cap) low = mid; else high = mid - 1;
    }
    if (preserveTail) return `… [older context compacted]\n${raw.slice(Math.max(0, raw.length - low))}`;
    return `${raw.slice(0, Math.max(0, low))}\n… [remainder compacted]`;
}

export function compactPostTurnContext(chat = '', targetTokens = 5200) {
    const raw = String(chat || '');
    if (estimateContentTokens(raw) <= targetTokens) return { text: raw, compacted: false };
    return { text: clipByTokens(raw, targetTokens, { preserveTail: true }), compacted: true };
}

function splitByLargestFitting(raw, fits) {
    const chars=[...String(raw ?? '')];
    const fragments=[];
    let offset=0;
    while(offset<chars.length){
        let low=1,high=chars.length-offset,best=0;
        while(low<=high){
            const mid=Math.floor((low+high)/2),fragment=chars.slice(offset,offset+mid).join('');
            if(fits(fragment)){best=mid;low=mid+1;}else high=mid-1;
        }
        if(best<=0){const error=new Error('Post-turn source unit cannot fit even one source codepoint inside the physical packing target.');error.name='NexusPhysicalPackingError';throw error;}
        fragments.push(chars.slice(offset,offset+best).join(''));offset+=best;
    }
    return fragments;
}

function sourceUnits(chat='') {
    const raw=String(chat||'');
    if(!raw)return [];
    const header=/(?=\[(?:User|Assistant|System)\s+@\s+\d+(?:\s*\|\s*id=[^\]]+)?\]:)/g;
    const starts=[]; let match;
    const matcher=/\[(?:User|Assistant|System)\s+@\s+\d+(?:\s*\|\s*id=[^\]]+)?\]:/g;
    while((match=matcher.exec(raw))) starts.push(match.index);
    if(!starts.length)return [{raw,header:'[Source @ unknown]:',role:'Source',index:null,messageId:null}];
    const units=[];
    if(starts[0]>0)units.push({raw:raw.slice(0,starts[0]),header:'[Source @ prelude]:',role:'Source',index:null,messageId:null});
    for(let i=0;i<starts.length;i++){
        const start=starts[i],end=i+1<starts.length?starts[i+1]:raw.length;
        const unitRaw=raw.slice(start,end);
        const head=/^\[(User|Assistant|System)\s+@\s+(\d+)(?:\s*\|\s*id=([^\]]+))?\]:/.exec(unitRaw);
        units.push({raw:unitRaw,header:head?.[0]||'[Source @ unknown]:',role:head?.[1]||'Source',index:head?Number(head[2]):null,messageId:head?.[3]?.trim()||null});
    }
    return units;
}

function catalogIdentity(raw='', inheritedBook='') {
    const text=String(raw||'');
    const book=/^Lorebook:\s*([^\n]+)/m.exec(text)?.[1]?.trim()||inheritedBook||'';
    const uid=/(?:\[ENTRY\s+UID|\[UID|(?:^|\n)\s*-?\s*UID)\s+(\d+)/i.exec(text)?.[1];
    const node=/(?:NODE(?:_ID)?[=: ]+|\[NODE\s+)([^\]\n|]+)/i.exec(text)?.[1]?.trim()||null;
    return {book,uid:uid==null?null:Number(uid),nodeId:node};
}

function catalogUnits(catalog = '') {
    const raw=String(catalog||'');
    if(!raw)return [];
    // Canonical Nexus catalogs delimit complete entry records explicitly. Keep
    // each record addressable; generic/legacy catalog text falls back to book
    // blocks while preserving exact bytes.
    const entryRe=/\[ENTRY\s+UID\s+\d+[^\]]*\][\s\S]*?\[END ENTRY\s+UID\s+\d+\](?:\n|$)/gi;
    const matches=[...raw.matchAll(entryRe)];
    if(matches.length){
        const units=[];let cursor=0,currentBook='';
        for(const m of matches){
            if(m.index>cursor){const prefix=raw.slice(cursor,m.index);const bm=[...prefix.matchAll(/Lorebook:\s*([^\n]+)/g)].at(-1);if(bm)currentBook=bm[1].trim();if(prefix)units.push({raw:prefix,identity:{book:currentBook,uid:null,nodeId:null},complete:true});}
            const identity=catalogIdentity(m[0],currentBook);if(identity.book)currentBook=identity.book;
            units.push({raw:m[0],identity,complete:true});cursor=m.index+m[0].length;
        }
        if(cursor<raw.length)units.push({raw:raw.slice(cursor),identity:{book:currentBook,uid:null,nodeId:null},complete:true});
        return units;
    }
    const books=raw.split(/(?=^Lorebook:\s)/gm).filter(Boolean);
    return books.map(block=>({raw:block,identity:catalogIdentity(block),complete:true}));
}

function sourceFragments({ chat='', buildPrompt, target, model='' }) {
    const output=[];
    for(const unit of sourceUnits(chat)){
        const makePrompt=fragment=>{
            const continuation=!fragment.startsWith(unit.header);
            const promptChat=continuation?`${unit.header}\n${fragment}`:fragment;
            return {promptChat,estimated:estimateContentTokens(buildPrompt('',promptChat),model)};
        };
        if(makePrompt(unit.raw).estimated<=target){
            const p=makePrompt(unit.raw);output.push({raw:unit.raw,promptText:p.promptChat,identity:unit,complete:true,estimated:p.estimated});continue;
        }
        const fragments=splitByLargestFitting(unit.raw,fragment=>makePrompt(fragment).estimated<=target);
        fragments.forEach((fragment,index)=>{const p=makePrompt(fragment);output.push({raw:fragment,promptText:p.promptChat,identity:{...unit,fragmentIndex:index,fragmentCount:fragments.length},complete:false,estimated:p.estimated});});
    }
    return output;
}

function packSourceFragments({ chat='', buildPrompt, fragmentTarget, physicalTarget, model='' }) {
    const atomic=sourceFragments({chat,buildPrompt,target:fragmentTarget,model});
    const rows=[];let current=[];
    const materialize=parts=>{
        const promptText=parts.map(part=>part.promptText).join('\n\n');
        const raw=parts.map(part=>part.raw).join('');
        const estimated=estimateContentTokens(buildPrompt('',promptText),model);
        return {
            raw,promptText,estimated,parts,
            sourceIdentities:parts.map(part=>({
                role:part.identity.role,index:part.identity.index,messageId:part.identity.messageId,
                fragmentIndex:part.identity.fragmentIndex??0,fragmentCount:part.identity.fragmentCount??1,
                complete:part.complete===true,
            })),
        };
    };
    const flush=()=>{if(!current.length)return;rows.push(materialize(current));current=[];};
    for(const part of atomic){
        const trial=[...current,part];
        const projected=materialize(trial);
        if(current.length&&projected.estimated>physicalTarget){flush();current=[part];}
        else current=trial;
    }
    flush();
    return rows;
}

function splitCatalogUnit({ unit, buildPrompt, target, model='' }) {
    const raw=String(unit.raw||'');
    const identity=unit.identity||catalogIdentity(raw);
    const identityHeader=[identity.book?`Lorebook: ${identity.book}`:'',identity.uid!=null?`[UID ${identity.uid}${identity.nodeId?` NODE ${identity.nodeId}`:''}]`:''].filter(Boolean).join('\n');
    const makePrompt=fragment=>{
        const alreadyAddressed=(!identity.book||fragment.includes(`Lorebook: ${identity.book}`))&& (identity.uid==null||new RegExp(`(?:ENTRY\\s+UID|\\[UID|UID\\s+)\\s*${identity.uid}\\b`,'i').test(fragment));
        const promptCatalog=alreadyAddressed||!identityHeader?fragment:`${identityHeader}\n${fragment}`;
        return {promptCatalog,estimated:estimateContentTokens(buildPrompt(promptCatalog,''),model)};
    };
    if(makePrompt(raw).estimated<=target){const p=makePrompt(raw);return [{raw,promptText:p.promptCatalog,identity,complete:unit.complete!==false,estimated:p.estimated}];}
    const fragments=splitByLargestFitting(raw,fragment=>makePrompt(fragment).estimated<=target);
    return fragments.map((fragment,index)=>{const p=makePrompt(fragment);return {raw:fragment,promptText:p.promptCatalog,identity:{...identity,fragmentIndex:index,fragmentCount:fragments.length},complete:false,estimated:p.estimated};});
}

function catalogFragments({ catalog='', buildPrompt, target, model='' }) {
    const units=catalogUnits(catalog);
    const atomic=units.flatMap(unit=>splitCatalogUnit({unit,buildPrompt,target,model}));
    const rows=[];let current=[];
    const flush=()=>{if(!current.length)return;const raw=current.map(x=>x.raw).join('');const promptText=current.map(x=>x.promptText).join('');const estimated=estimateContentTokens(buildPrompt(promptText,''),model);rows.push({raw,promptText,estimated,parts:current});current=[];};
    for(const part of atomic){
        const trial=[...current,part];const promptText=trial.map(x=>x.promptText).join('');
        if(current.length&&estimateContentTokens(buildPrompt(promptText,''),model)>target){flush();current=[part];} else current=trial;
    }
    flush();return rows;
}

export function packPostTurnCatalogSlices({ catalog = '', chat = '', buildPrompt, buildSourcePrompt = null, buildCatalogPrompt = null, softTargetTokens = 16000, sourceMapTargetTokens = null, model = '' } = {}) {
    if (typeof buildPrompt !== 'function') throw new Error('Post-turn packing requires a prompt builder.');
    const target=Math.max(2000,Math.floor(Number(softTargetTokens)||16000));
    const sourceBuilder=typeof buildSourcePrompt==='function'?buildSourcePrompt:buildPrompt;
    const catalogBuilder=typeof buildCatalogPrompt==='function'?buildCatalogPrompt:buildPrompt;
    const fullPrompt=buildPrompt(catalog,chat);
    const fullEstimatedInputTokens=estimateContentTokens(fullPrompt,model);
    if(fullEstimatedInputTokens<=target){
        return {mode:'single',compacted:false,sourcePreserved:true,softTargetTokens:target,fullEstimatedInputTokens,chat,chatSliceCount:1,catalogSliceCount:1,slices:[{index:0,phase:'mutation',chatSliceIndex:0,catalogSliceIndex:0,chat,catalog,promptChat:chat,promptCatalog:catalog,prompt:fullPrompt,sourceIdentities:sourceUnits(chat).map(x=>({role:x.role,index:x.index,messageId:x.messageId})),catalogRefs:catalogUnits(catalog).map(x=>({...x.identity,complete:x.complete!==false})),estimatedInputTokens:fullEstimatedInputTokens}]};
    }

    // Hierarchical reshape: source is mapped once, catalog is planned once.
    // Request count is O(N + M), never the prior O(N × M) Cartesian product.
    // Reserve 25% of the catalog request for the bounded source-evidence map
    // that pipeline.js injects after source mapping.
    const catalogTarget=Math.max(1200,Math.floor(target*0.75));
    // Source mapping used to preserve every chat message as its own physical
    // request. That kept provenance exact but turned a ~15k-token logical pass
    // into 10-20 provider calls. Keep the exact per-message identities while
    // packing adjacent source units into meaningful physical requests.
    const sourcePhysicalTarget=Math.max(1200,Math.min(target,Math.floor(Number(sourceMapTargetTokens)||target*0.35)));
    const source=packSourceFragments({chat,buildPrompt:sourceBuilder,fragmentTarget:sourcePhysicalTarget,physicalTarget:sourcePhysicalTarget,model});
    const catalogRows=catalogFragments({catalog,buildPrompt:catalogBuilder,target:catalogTarget,model});
    const slices=[];
    source.forEach((part,i)=>slices.push({index:slices.length,phase:'source-map',chatSliceIndex:i,catalogSliceIndex:null,chat:part.raw,catalog:'',promptChat:part.promptText,promptCatalog:'',prompt:sourceBuilder('',part.promptText),sourceIdentities:part.sourceIdentities,catalogRefs:[],estimatedInputTokens:part.estimated}));
    catalogRows.forEach((row,i)=>slices.push({index:slices.length,phase:'catalog-plan',chatSliceIndex:source.length+i,catalogSliceIndex:i,chat:'',catalog:row.raw,promptChat:'',promptCatalog:row.promptText,prompt:catalogBuilder(row.promptText,''),sourceIdentities:[],catalogRefs:row.parts.map(part=>({...part.identity,complete:part.complete===true})),estimatedInputTokens:row.estimated}));
    return {mode:'batch',strategy:'hierarchical',compacted:false,sourcePreserved:true,softTargetTokens:target,sourceMapTargetTokens:sourcePhysicalTarget,fullEstimatedInputTokens,chat,chatSliceCount:source.length,catalogSliceCount:catalogRows.length,requestUpperBound:source.length+catalogRows.length,slices,sourceSlices:slices.filter(s=>s.phase==='source-map'),catalogSlices:slices.filter(s=>s.phase==='catalog-plan')};
}

// Lane F C10-044 — bounded relational recovery for canonical entries that are
// physically separated by catalog packing. This is deliberately a nomination
// layer only: it never authorizes mutation. The pipeline must re-materialize
// both complete canonical entries in one focused request before a merge can be
// semantically validated or staged.
const RELATION_STOP_WORDS = new Set([
    'the','and','that','with','this','from','into','their','there','then','than','they','them','his','her','hers','him','she','was','were','been','being','have','has','had','for','not','but','you','your','our','are','is','of','to','in','on','at','as','a','an','or','by','it','its','be','if','when','while','after','before','during','about','over','under','through','only','entry','lorebook','content','true','false','constant','disabled',
]);

function relationTerms(entry={}){
    const raw=`${entry?.title||''}\n${entry?.content||''}`.normalize('NFKC').toLowerCase();
    const words=raw.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]{2,}/gu)||[];
    const counts=new Map();
    for(const word of words){
        const token=word.replace(/^['_-]+|['_-]+$/g,'');
        if(token.length<3||RELATION_STOP_WORDS.has(token))continue;
        counts.set(token,(counts.get(token)||0)+1);
    }
    return [...counts.entries()].sort((a,b)=>b[1]-a[1]||b[0].length-a[0].length||a[0].localeCompare(b[0])).slice(0,96).map(([token])=>token);
}

function relationEntryKey(book,uid){return `${String(book||'').trim()}\u0000${Number(uid)}`;}

function relationPairPlausible(a,b){
    if(!a||!b)return false;
    const normalizeTitle=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
    const ta=normalizeTitle(a.title),tb=normalizeTitle(b.title);
    if(ta&&tb&&ta===tb)return true;
    const titleA=new Set(ta.split(/\s+/).filter(x=>x.length>2)),titleB=new Set(tb.split(/\s+/).filter(x=>x.length>2));
    const titleShared=[...titleA].filter(x=>titleB.has(x)).length;
    const titleUnion=new Set([...titleA,...titleB]).size||1;
    if(titleShared>=2&&titleShared/titleUnion>=0.65)return true;
    const termsA=new Set(a.terms||[]),termsB=new Set(b.terms||[]);
    const shared=[...termsA].filter(x=>termsB.has(x)).length;
    const smaller=Math.max(1,Math.min(termsA.size,termsB.size));
    // Cross-slice merge recovery is deliberately conservative. Ordinary related
    // lore (same organization, location, magic system, etc.) is not a duplicate.
    // Only near-duplicate semantic surfaces regain co-visibility here; broader
    // maintenance/merge tooling remains responsible for exploratory similarity.
    return shared/smaller>=0.58;
}

export function nominatePostTurnRelationalPairs({authority={},catalogSlices=[],writableBooks=[],maxPairs=4,maxPosting=20,minScore=1.25}={}){
    const writable=new Set((writableBooks||[]).map(String));
    const completeSlices=new Map();
    for(const [sliceIndex,slice] of (catalogSlices||[]).entries()){
        for(const ref of slice?.catalogRefs||[]){
            const book=String(ref?.book||'').trim(),uid=Number(ref?.uid);
            if(!book||!Number.isFinite(uid)||ref?.complete!==true)continue;
            const key=relationEntryKey(book,uid), rows=completeSlices.get(key)||new Set();rows.add(sliceIndex);completeSlices.set(key,rows);
        }
    }
    const entries=[];
    for(const [book,value] of Object.entries(authority?.books||{})){
        if(writable.size&&!writable.has(book))continue;
        for(const entry of value?.entries||[]){
            const uid=Number(entry?.uid),key=relationEntryKey(book,uid),slices=completeSlices.get(key);
            if(!Number.isFinite(uid)||!slices?.size)continue; // no complete physical authority -> cannot focus safely
            entries.push({book,uid,title:String(entry?.title||''),content:String(entry?.content||''),nodeIds:[...(entry?.nodeIds||[])].map(String),terms:relationTerms(entry),slices});
        }
    }
    const byKey=new Map(entries.map(row=>[relationEntryKey(row.book,row.uid),row]));
    const postings=new Map();
    for(const row of entries)for(const token of new Set(row.terms)){const rows=postings.get(token)||[];rows.push(row);postings.set(token,rows);}
    const scored=new Map();
    const add=(a,b,weight,reason)=>{
        if(a.book!==b.book||a.uid===b.uid)return;
        // C10-044 is specifically the cross-slice authority hole. Pairs already
        // co-visible in at least one physical slice need no recovery request.
        if([...a.slices].some(index=>b.slices.has(index)))return;
        const lo=a.uid<b.uid?a:b,hi=a.uid<b.uid?b:a,key=`${lo.book}\u0000${lo.uid}\u0000${hi.uid}`;
        const row=scored.get(key)||{book:lo.book,leftUid:lo.uid,rightUid:hi.uid,score:0,reasons:new Set()};
        row.score+=weight;if(reason)row.reasons.add(reason);scored.set(key,row);
    };
    for(const [token,rows] of postings){
        if(rows.length<2||rows.length>Math.max(2,Number(maxPosting)||20))continue;
        const weight=Math.max(0.2,2/rows.length)*(1+Math.min(1,token.length/12));
        for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)add(rows[i],rows[j],weight,`shared:${token}`);
    }
    // Exact/near title identity is a strong duplicate signal even when the
    // underlying prose uses different wording.
    const normalizedTitle=row=>row.title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
    for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
        const a=entries[i],b=entries[j];if(a.book!==b.book)continue;
        const ta=normalizedTitle(a),tb=normalizedTitle(b);if(!ta||!tb)continue;
        if(ta===tb)add(a,b,8,'same-title');
        else {const aa=new Set(ta.split(/\s+/).filter(x=>x.length>2)),bb=new Set(tb.split(/\s+/).filter(x=>x.length>2));const shared=[...aa].filter(x=>bb.has(x));if(shared.length>=2)add(a,b,2+shared.length*0.5,'title-overlap');}
    }
    return [...scored.values()]
        .filter(row=>row.score>=Number(minScore||1.25))
        .map(row=>({...row,left:byKey.get(relationEntryKey(row.book,row.leftUid)),right:byKey.get(relationEntryKey(row.book,row.rightUid))}))
        .filter(row=>relationPairPlausible(row.left,row.right))
        .sort((a,b)=>b.score-a.score||a.book.localeCompare(b.book)||a.leftUid-b.leftUid||a.rightUid-b.rightUid)
        .slice(0,Math.max(0,Math.floor(Number(maxPairs)||4)))
        .map(row=>({...row,reasons:[...row.reasons].slice(0,8)}));
}

export function renderPostTurnRelationalPair(pair={}){
    const rows=[pair?.left,pair?.right].filter(Boolean);
    if(rows.length!==2||rows[0].book!==rows[1].book)throw new Error('Post-turn relational pair requires two canonical entries from the same lorebook.');
    const book=rows[0].book;
    const blocks=[`Lorebook: ${book}`,'CANONICAL ENTRIES — FOCUSED RELATIONAL REVIEW'];
    const refs=[];
    for(const row of rows){
        const nodeText=row.nodeIds?.length?row.nodeIds.join(','):'UNLINKED';
        blocks.push(`[ENTRY UID ${row.uid} NODE ${nodeText}]`,`TITLE: ${row.title}`,'CONTENT:',row.content,`[END ENTRY UID ${row.uid}]`);
        refs.push({book,uid:row.uid,nodeId:nodeText==='UNLINKED'?null:nodeText,complete:true});
    }
    return {book,catalog:blocks.join('\n'),catalogRefs:refs};
}
