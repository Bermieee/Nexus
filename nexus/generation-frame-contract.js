import { normalizePromptLoaderPresentation, promptLoaderPresentationKey, renderPromptLoaderLegend, renderPromptLoaderSection } from './prompt-loader-adapters.js';

/**
 * Nexus Generation Frame contract.
 *
 * This file is deliberately host-free.  It defines the typed, immutable
 * projection that every Nexus context-producing subsystem must pass through
 * before any information can reach Main.  Physical SillyTavern prompt writing
 * lives only in generation-frame.js.
 */

export const NEXUS_GENERATION_FRAME_VERSION = 1;

export const NEXUS_GENERATION_OUTLET = Object.freeze({
    STORY_SCOPE: 'story-scope',
    SUMMARY_BANK: 'summary-bank',
    LEDGER: 'ledger',
    SMART_CONTEXT: 'smart-context',
    CHARACTER_BANKS: 'character-banks',
    BOOTSTRAP_LORE: 'bootstrap-lore',
    RETRIEVAL_LORE: 'retrieval-lore',
    MEMORY_RECALL: 'memory-recall',
    NOTEBOOK: 'notebook',
    SCENE: 'scene',
    CHANGE_GATE: 'change-gate',
});

export const NEXUS_GENERATION_OUTLET_STATUS = Object.freeze({
    PENDING: 'pending',
    READY: 'ready',
    EMPTY: 'empty',
    DISABLED: 'disabled',
    SKIPPED: 'skipped',
    FAILED: 'failed',
});

const STATUS = new Set(Object.values(NEXUS_GENERATION_OUTLET_STATUS));

// Presentation-only compiled section cache. This cache is deliberately keyed
// by generation authority plus the owner-published outlet fingerprint/revision.
// It can reuse bytes that the current generation has freshly authorized; it can
// never resurrect an outlet that did not settle READY in the current frame.
const COMPILED_SECTION_CACHE_LIMIT = 256;
const compiledSectionCache = new Map();

function compiledSectionCacheKey(frame,row){
    return stableGenerationFrameStringify({
        contractVersion:NEXUS_GENERATION_FRAME_VERSION,
        chatId:frame?.chatId??null,
        chatEpoch:frame?.chatEpoch??null,
        name:row?.name??null,
        label:row?.label??null,
        status:row?.status??null,
        sourceRevision:row?.sourceRevision??null,
        fingerprint:row?.fingerprint??null,
        promptLoader:presentationCacheKey(frame?.promptLoader),
    });
}
function presentationCacheKey(promptLoader=null){try{return promptLoaderPresentationKey(promptLoader);}catch{return 'prompt-loader:generic';}}
function cacheCompiledSection(key,text){
    if(compiledSectionCache.has(key))compiledSectionCache.delete(key);
    compiledSectionCache.set(key,text);
    while(compiledSectionCache.size>COMPILED_SECTION_CACHE_LIMIT){
        const oldest=compiledSectionCache.keys().next().value;
        compiledSectionCache.delete(oldest);
    }
}
export function resetGenerationFrameCompiledSectionCache(){compiledSectionCache.clear();return true;}
export function getGenerationFrameCompiledSectionCacheStats(){return{size:compiledSectionCache.size,limit:COMPILED_SECTION_CACHE_LIMIT};}

/**
 * Fixed outlet order is part of the wire contract.  Do not order by relevance,
 * completion time, model score, or object insertion order.  Stable material is
 * intentionally before volatile scene/delta material for prefix-cache reuse.
 */
export const NEXUS_GENERATION_OUTLET_SPEC = Object.freeze({
    [NEXUS_GENERATION_OUTLET.STORY_SCOPE]: Object.freeze({ order:10, visibility:'audit', owner:'Story Scope' }),
    [NEXUS_GENERATION_OUTLET.SUMMARY_BANK]: Object.freeze({ order:20, visibility:'audit', owner:'Summary Bank' }),
    [NEXUS_GENERATION_OUTLET.LEDGER]: Object.freeze({ order:30, visibility:'audit', owner:'Transaction Ledger' }),
    [NEXUS_GENERATION_OUTLET.SMART_CONTEXT]: Object.freeze({ order:40, visibility:'audit', owner:'Smart Context' }),
    [NEXUS_GENERATION_OUTLET.CHARACTER_BANKS]: Object.freeze({ order:50, visibility:'main', owner:'Character Banks', label:'CAST' }),
    [NEXUS_GENERATION_OUTLET.BOOTSTRAP_LORE]: Object.freeze({ order:60, visibility:'main', owner:'Bootstrap Admission', label:'LORE:BOOTSTRAP' }),
    [NEXUS_GENERATION_OUTLET.RETRIEVAL_LORE]: Object.freeze({ order:70, visibility:'main', owner:'Retrieval', label:'LORE:SELECTED' }),
    [NEXUS_GENERATION_OUTLET.MEMORY_RECALL]: Object.freeze({ order:80, visibility:'main', owner:'Memory Recall', label:'MEMORY' }),
    [NEXUS_GENERATION_OUTLET.NOTEBOOK]: Object.freeze({ order:90, visibility:'main', owner:'Notebook', label:'NOTEBOOK' }),
    [NEXUS_GENERATION_OUTLET.SCENE]: Object.freeze({ order:100, visibility:'main', owner:'Scene Scanner', label:'SCENE' }),
    [NEXUS_GENERATION_OUTLET.CHANGE_GATE]: Object.freeze({ order:110, visibility:'main', owner:'Change Gate', label:'DELTA' }),
});

export const NEXUS_GENERATION_OUTLET_NAMES = Object.freeze(
    Object.keys(NEXUS_GENERATION_OUTLET_SPEC).sort((a,b)=>NEXUS_GENERATION_OUTLET_SPEC[a].order-NEXUS_GENERATION_OUTLET_SPEC[b].order),
);

export const NEXUS_PROMPT_LEGEND = Object.freeze([
    '[NEXUS:CONTEXT:v1]',
    'LEGEND',
    'CAST = active/warm character routing state; canonical character facts remain in LORE.',
    'LORE = canonical story-scoped World Info selected by Nexus for this generation.',
    'MEMORY = historical Summary Bank recall; current scene and canonical lore outrank it.',
    'NOTEBOOK = current collaborative world-state/continuity working state; it is not canonical lore.',
    'SCENE = current accepted scene observation.',
    'DELTA = accepted scene/change transition for this generation.',
    'Only information inside this sealed Nexus frame is Nexus-authorized Main context for this generation.',
].join('\n'));

function clean(value){ return String(value ?? '').replace(/\r\n/g,'\n').trim(); }
function clone(value){
    if(value===undefined)return undefined;
    try{return typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value));}
    catch{return null;}
}
function stableObject(value){
    if(Array.isArray(value))return value.map(stableObject);
    if(value&&typeof value==='object'){
        const out={};
        for(const key of Object.keys(value).sort())out[key]=stableObject(value[key]);
        return out;
    }
    return value;
}
export function stableGenerationFrameStringify(value){ return JSON.stringify(stableObject(value)); }
export function hashGenerationFrameText(value=''){
    const text=String(value ?? '');
    let hash=0x811c9dc5;
    for(let i=0;i<text.length;i+=1){hash^=text.charCodeAt(i);hash=Math.imul(hash,0x01000193)>>>0;}
    return `${text.length}:${hash.toString(16).padStart(8,'0')}`;
}
function outletFingerprint(row){
    return hashGenerationFrameText(stableGenerationFrameStringify({
        name:row.name,status:row.status,content:row.content||'',data:row.data??null,refs:row.refs||[],sourceRevision:row.sourceRevision||null,
    }));
}
function normalizeRefs(refs=[]){
    const seen=new Set(),out=[];
    for(const raw of Array.isArray(refs)?refs:[]){
        if(!raw||typeof raw!=='object')continue;
        const book=clean(raw.book),uid=Number(raw.uid),id=clean(raw.id),nodeId=clean(raw.nodeId),title=clean(raw.title);
        const row={};
        if(book)row.book=book;if(Number.isFinite(uid))row.uid=uid;if(id)row.id=id;if(nodeId)row.nodeId=nodeId;if(title)row.title=title;
        if(!Object.keys(row).length)continue;
        const key=stableGenerationFrameStringify(row);if(seen.has(key))continue;seen.add(key);out.push(row);
    }
    out.sort((a,b)=>clean(a.book).localeCompare(clean(b.book))||(Number(a.uid)||0)-(Number(b.uid)||0)||clean(a.id).localeCompare(clean(b.id))||clean(a.nodeId).localeCompare(clean(b.nodeId))||clean(a.title).localeCompare(clean(b.title)));
    return out;
}
function pendingOutlet(name){
    const spec=NEXUS_GENERATION_OUTLET_SPEC[name];
    return {name,owner:spec.owner,visibility:spec.visibility,label:spec.label||null,status:NEXUS_GENERATION_OUTLET_STATUS.PENDING,content:'',data:null,refs:[],sourceRevision:null,reportedAt:null,error:null,fingerprint:null};
}

export function createGenerationFrameRecord({generationId,chatId=null,chatEpoch=null,createdAt=Date.now()}={}){
    const id=clean(generationId);if(!id)throw new Error('Generation Frame requires a generationId.');
    const outlets={};for(const name of NEXUS_GENERATION_OUTLET_NAMES)outlets[name]=pendingOutlet(name);
    return {version:NEXUS_GENERATION_FRAME_VERSION,generationId:id,chatId:chatId==null?null:String(chatId),chatEpoch:chatEpoch==null?null:Number(chatEpoch),state:'open',createdAt:Number(createdAt)||Date.now(),sealedAt:null,appliedAt:null,outlets,publicationRejections:[],promptLoader:null,manifest:null,serializedPrompt:'',promptHash:null};
}

export function updateGenerationFrameOutlet(frame,name,{status=NEXUS_GENERATION_OUTLET_STATUS.READY,content='',data=null,refs=[],sourceRevision=null,error=null,reportedAt=Date.now()}={}){
    if(!frame||frame.state!=='open')throw new Error('Generation Frame outlets may only be updated while the frame is OPEN.');
    if(!NEXUS_GENERATION_OUTLET_SPEC[name])throw new Error(`Unknown Generation Frame outlet: ${String(name)}`);
    const normalizedStatus=clean(status).toLowerCase();if(!STATUS.has(normalizedStatus)||normalizedStatus===NEXUS_GENERATION_OUTLET_STATUS.PENDING)throw new Error(`Invalid settled Generation Frame outlet status: ${String(status)}`);
    const spec=NEXUS_GENERATION_OUTLET_SPEC[name];
    const normalizedContent=clean(content);
    if(spec.visibility==='audit'&&normalizedContent)throw new Error(`Audit-only Generation Frame outlet ${name} may not emit Main prompt content.`);
    if(normalizedStatus===NEXUS_GENERATION_OUTLET_STATUS.READY&&spec.visibility==='main'&&!normalizedContent)throw new Error(`Main-visible Generation Frame outlet ${name} cannot be READY with empty content.`);
    const row={name,owner:spec.owner,visibility:spec.visibility,label:spec.label||null,status:normalizedStatus,content:normalizedContent,data:clone(data),refs:normalizeRefs(refs),sourceRevision:sourceRevision==null?null:String(sourceRevision),reportedAt:Number(reportedAt)||Date.now(),error:error==null?null:clean(error),fingerprint:null};
    row.fingerprint=outletFingerprint(row);
    frame.outlets[name]=row;
    return clone(row);
}

export function settleMissingGenerationFrameOutlets(frame,{reason='not-reported-before-seal',at=Date.now()}={}){
    if(!frame||frame.state!=='open')throw new Error('Generation Frame must be OPEN before settling missing outlets.');
    for(const name of NEXUS_GENERATION_OUTLET_NAMES){
        if(frame.outlets[name]?.status!==NEXUS_GENERATION_OUTLET_STATUS.PENDING)continue;
        updateGenerationFrameOutlet(frame,name,{status:NEXUS_GENERATION_OUTLET_STATUS.FAILED,error:reason,data:{reason},reportedAt:at});
    }
    return frame;
}

function compileOutletSection(frame,row,cacheStats,presentation){
    if(!row||row.visibility!=='main'||row.status!==NEXUS_GENERATION_OUTLET_STATUS.READY||!row.content)return '';
    const key=compiledSectionCacheKey(frame,row);
    if(compiledSectionCache.has(key)){
        const text=compiledSectionCache.get(key);
        compiledSectionCache.delete(key);compiledSectionCache.set(key,text);
        cacheStats.hits+=1;cacheStats.reusedSectionIds.push(row.name);
        return text;
    }
    const text=renderPromptLoaderSection({name:row.name,label:row.label,content:row.content},presentation);
    cacheCompiledSection(key,text);cacheStats.misses+=1;cacheStats.compiledSectionIds.push(row.name);
    return text;
}

export function composeGenerationFrame(frame,{promptLoader=null}={}){
    if(!frame)throw new Error('Generation Frame is required.');
    const presentation=normalizePromptLoaderPresentation(promptLoader||frame.promptLoader||null);
    const cache={hits:0,misses:0,reusedSectionIds:[],compiledSectionIds:[],sizeBefore:compiledSectionCache.size,sizeAfter:compiledSectionCache.size};
    const legend=renderPromptLoaderLegend(NEXUS_PROMPT_LEGEND,presentation);
    const sections=[{id:'legend',label:'LEGEND',text:legend,hash:hashGenerationFrameText(legend),reused:true}];
    for(const name of NEXUS_GENERATION_OUTLET_NAMES){
        const row=frame.outlets?.[name];const text=compileOutletSection(frame,row,cache,presentation);if(!text)continue;
        sections.push({id:name,label:row.label,text,hash:hashGenerationFrameText(text),reused:cache.reusedSectionIds.includes(name)});
    }
    cache.sizeAfter=compiledSectionCache.size;
    const separator=typeof presentation.sectionSeparator==='string'?presentation.sectionSeparator:'\n\n';
    const serializedPrompt=sections.map(section=>section.text).join(separator);
    return {serializedPrompt,promptHash:hashGenerationFrameText(serializedPrompt),sections,cache,promptLoader:presentation};
}

export function sealGenerationFrameRecord(frame,{sealedAt=Date.now(),promptLoader=null}={}){
    if(!frame||frame.state!=='open')throw new Error('Only an OPEN Generation Frame can be sealed.');
    settleMissingGenerationFrameOutlets(frame);
    frame.promptLoader=normalizePromptLoaderPresentation(promptLoader||frame.promptLoader||null);
    const composed=composeGenerationFrame(frame,{promptLoader:frame.promptLoader});
    frame.state='sealed';frame.sealedAt=Number(sealedAt)||Date.now();frame.serializedPrompt=composed.serializedPrompt;frame.promptHash=composed.promptHash;
    frame.manifest={
        version:frame.version,generationId:frame.generationId,chatId:frame.chatId,chatEpoch:frame.chatEpoch,promptLoader:clone(frame.promptLoader),
        outletStatuses:Object.fromEntries(NEXUS_GENERATION_OUTLET_NAMES.map(name=>[name,frame.outlets[name]?.status||'missing'])),
        outlets:NEXUS_GENERATION_OUTLET_NAMES.map(name=>{const row=frame.outlets[name];return{name,owner:row.owner,visibility:row.visibility,status:row.status,fingerprint:row.fingerprint,sourceRevision:row.sourceRevision,refCount:row.refs?.length||0,chars:row.content?.length||0,error:row.error||null};}),
        sections:composed.sections.map(section=>({id:section.id,label:section.label,hash:section.hash,chars:section.text.length,reused:section.reused===true})),
        compileCache:{hits:composed.cache?.hits||0,misses:composed.cache?.misses||0,reusedSectionIds:[...(composed.cache?.reusedSectionIds||[])],compiledSectionIds:[...(composed.cache?.compiledSectionIds||[])],sizeBefore:composed.cache?.sizeBefore||0,sizeAfter:composed.cache?.sizeAfter||0},
        promptHash:composed.promptHash,promptChars:composed.serializedPrompt.length,
        publicationRejections:(frame.publicationRejections||[]).map(row=>({...row})),
    };
    return clone(frame);
}

export function analyzeGenerationFrameSectionCacheImpact(previous,current,{tokensById={}}={}){
    const before=Array.isArray(previous?.sections)?previous.sections:[],after=Array.isArray(current?.sections)?current.sections:[];
    if(!before.length||!after.length)return{hasPrior:false,firstChangedSection:after?.[0]?.id||null,changedSectionTokens:after.reduce((sum,row)=>sum+(Number(tokensById?.[row?.id])||0),0),strandedStableTokens:0,strandedStableChars:0,strandedStableSectionIds:[],unchangedSectionIds:[],changedSectionIds:after.map(row=>String(row?.id||'')).filter(Boolean)};
    const beforeById=new Map(before.map(row=>[String(row?.id||''),row]));
    let breakIndex=-1;
    const count=Math.min(before.length,after.length);
    for(let i=0;i<count;i+=1){if(String(before[i]?.id||'')!==String(after[i]?.id||'')||String(before[i]?.hash||'')!==String(after[i]?.hash||'')){breakIndex=i;break;}}
    if(breakIndex<0&&before.length!==after.length)breakIndex=count;
    const unchangedSectionIds=[],changedSectionIds=[],strandedStableSectionIds=[],afterIds=new Set(after.map(row=>String(row?.id||''))),removedSectionIds=before.map(row=>String(row?.id||'')).filter(id=>id&&!afterIds.has(id));
    let changedSectionTokens=0,strandedStableTokens=0,strandedStableChars=0;
    for(let i=0;i<after.length;i+=1){
        const row=after[i],id=String(row?.id||''),prior=beforeById.get(id)||null;
        const unchanged=!!prior&&String(prior?.hash||'')===String(row?.hash||'');
        const tokens=Number(tokensById?.[id])||0;
        if(unchanged)unchangedSectionIds.push(id);else{changedSectionIds.push(id);changedSectionTokens+=tokens;}
        if(breakIndex>=0&&i>=breakIndex&&unchanged){strandedStableSectionIds.push(id);strandedStableTokens+=tokens;strandedStableChars+=Number(row?.chars)||0;}
    }
    return{
        hasPrior:true,
        firstChangedSection:breakIndex>=0?String(after?.[breakIndex]?.id||before?.[breakIndex]?.id||'section-count'):null,
        breakIndex,
        changedSectionTokens,
        strandedStableTokens,
        strandedStableChars,
        strandedStableSectionIds,
        unchangedSectionIds,
        changedSectionIds,
        removedSectionIds,
    };
}

export function compareGenerationFrameManifests(previous,current){
    const before=previous?.sections||[],after=current?.sections||[];
    let shared=0,firstChangedSection=null;
    const count=Math.min(before.length,after.length);
    for(let i=0;i<count;i+=1){
        if(before[i].id!==after[i].id||before[i].hash!==after[i].hash){firstChangedSection=after[i]?.id||before[i]?.id||null;break;}
        shared+=Number(after[i].chars)||0;
    }
    if(firstChangedSection==null&&before.length!==after.length)firstChangedSection=after[count]?.id||before[count]?.id||'section-count';
    const total=Number(current?.promptChars)||0;
    return {firstChangedSection,stablePrefixChars:shared,totalChars:total,stablePrefixRatio:total>0?shared/total:1,identical:previous?.promptHash!=null&&previous.promptHash===current?.promptHash};
}

function utf8Length(value=''){
    const text=String(value??'');
    if(typeof TextEncoder==='function')return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
}

/**
 * Exact serialized-prefix comparison. Unlike the section-manifest comparison,
 * this counts the actual separators and every character that reaches Main.
 * It is diagnostics-only and never influences semantic selection.
 */
export function compareGenerationFramePrompts(previousPrompt='',currentPrompt=''){
    const before=String(previousPrompt??''),after=String(currentPrompt??'');
    const limit=Math.min(before.length,after.length);let shared=0;
    while(shared<limit&&before.charCodeAt(shared)===after.charCodeAt(shared))shared+=1;
    const prefix=after.slice(0,shared),totalUtf8Bytes=utf8Length(after),stablePrefixUtf8Bytes=utf8Length(prefix);
    return{
        firstChangedChar:shared<after.length||before.length!==after.length?shared:null,
        stablePrefixChars:shared,
        stablePrefixUtf8Bytes,
        totalChars:after.length,
        totalUtf8Bytes,
        stablePrefixRatio:after.length>0?shared/after.length:1,
        stablePrefixByteRatio:totalUtf8Bytes>0?stablePrefixUtf8Bytes/totalUtf8Bytes:1,
        identical:before===after,
    };
}

