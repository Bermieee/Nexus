import { getContext } from '../../../../st-context.js';
import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { enqueueNexusModelWorkerJob } from '../nexus/model-worker-bus.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import { logEvent } from '../observability/telemetry.js';
import { isNarrativeSceneMessage } from '../retrieval/handoff-policy.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh } from '../nexus/work-scope.js';
import { isIntentionalCancellation } from '../core/cancellation.js';

const MAX_SCENE_MESSAGES = 10;
const MAX_REFERENCE_ROWS = 8;
const REFERENCE_KINDS = ['characters','locations','organizations','concepts','items'];
let activeState = null;

function clean(value){ return String(value ?? '').replace(/\s+/g,' ').trim(); }
function clone(value){ return value == null ? value : JSON.parse(JSON.stringify(value)); }
function hashText(value=''){
    let hash=0x811c9dc5;
    const text=String(value||'');
    for(let i=0;i<text.length;i+=1){ hash^=text.charCodeAt(i); hash=Math.imul(hash,0x01000193)>>>0; }
    return hash.toString(16).padStart(8,'0');
}
function narrativeRows(messages=[]){
    return (Array.isArray(messages)?messages:[]).filter(message=>isNarrativeSceneMessage(message)&&clean(message?.mes));
}
function sceneRevision(rows=[]){
    const material=rows.slice(-MAX_SCENE_MESSAGES).map((row,index)=>`${index}:${row?.is_user===true?'u':'a'}:${String(row?.mes||'')}`).join('\n');
    return `${rows.length}:${material.length}:${hashText(material)}`;
}
function stableNames(values=[]){
    const seen=new Set(),out=[];
    for(const raw of Array.isArray(values)?values:[]){
        const value=clean(raw); if(!value)continue;
        const key=value.toLocaleLowerCase(); if(seen.has(key))continue;
        seen.add(key); out.push(value);
    }
    return out;
}
function normalizedValue(value=''){
    return clean(value).toLocaleLowerCase().replace(/^(?:the|a|an)\s+/,'').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
}
function tokenSet(value=''){ return new Set(normalizedValue(value).split(' ').filter(token=>token.length>1)); }
function semanticallySame(left='',right=''){
    const a=normalizedValue(left),b=normalizedValue(right);
    if(!a&&!b)return true;
    if(!a||!b)return false;
    if(a===b)return true;
    if(a.length>=5&&b.length>=5&&(a.includes(b)||b.includes(a)))return true;
    const aa=tokenSet(a),bb=tokenSet(b); if(!aa.size||!bb.size)return false;
    let shared=0; for(const token of aa)if(bb.has(token))shared+=1;
    return shared/Math.max(aa.size,bb.size)>=0.72;
}
function stabilizeField(previous,current){
    const prev=clean(previous),next=clean(current);
    // Blank model output is not evidence that an established scene field ceased
    // to exist. Explicit transitions must be represented by a new value.
    if(prev&&!next)return prev;
    if(prev&&next&&semanticallySame(prev,next))return prev;
    return next;
}
function normalizeReferenceRows(rows=[],kind='concepts'){
    const out=[],seen=new Set();
    for(const raw of Array.isArray(rows)?rows:[]){
        const name=clean(typeof raw==='string'?raw:raw?.name);
        if(!name)continue;
        const relation=clean(typeof raw==='string'?'mentioned':raw?.relation).toLocaleLowerCase()||'mentioned';
        const key=`${kind}:${name.toLocaleLowerCase()}:${relation}`; if(seen.has(key))continue;
        seen.add(key); out.push({name,relation});
        if(out.length>=MAX_REFERENCE_ROWS)break;
    }
    return out;
}
function normalizeReferences(raw={}){
    return Object.fromEntries(REFERENCE_KINDS.map(kind=>[kind,normalizeReferenceRows(raw?.[kind],kind)]));
}
function normalizeScene(raw={},previous=null){
    const prior=previous||{};
    const scene={
        participants: stableNames(raw?.participants),
        location: stabilizeField(prior.location,raw?.location),
        activity: stabilizeField(prior.activity,raw?.activity),
        objective: stabilizeField(prior.objective,raw?.objective),
        focus: stabilizeField(prior.focus,raw?.focus),
        timeContext: stabilizeField(prior.timeContext,raw?.timeContext),
        relationshipFocus: raw?.relationshipFocus===true,
    };
    return scene;
}
function participantDelta(previous=[],current=[]){
    const prior=new Map(stableNames(previous).map(name=>[name.toLocaleLowerCase(),name]));
    const next=new Map(stableNames(current).map(name=>[name.toLocaleLowerCase(),name]));
    return {
        changed:[...prior.keys()].some(key=>!next.has(key))||[...next.keys()].some(key=>!prior.has(key)),
        added:[...next.entries()].filter(([key])=>!prior.has(key)).map(([,name])=>name),
        removed:[...prior.entries()].filter(([key])=>!next.has(key)).map(([,name])=>name),
        previous:[...prior.values()], current:[...next.values()],
    };
}
function valueDelta(previous='',current=''){
    const prior=clean(previous),next=clean(current);
    return {changed:!semanticallySame(prior,next),previous:prior,current:next};
}
function referenceSignature(refs={}){
    return REFERENCE_KINDS.flatMap(kind=>(refs?.[kind]||[]).map(row=>`${kind}:${clean(row?.name).toLocaleLowerCase()}:${clean(row?.relation).toLocaleLowerCase()}`)).sort();
}
function buildSceneDelta(previous,current,references,priorReferences,initialBaseline=false,degraded=false){
    return {
        initialBaseline:initialBaseline===true,
        degraded:degraded===true,
        participants:participantDelta(previous?.participants,current?.participants),
        location:valueDelta(previous?.location,current?.location),
        activity:valueDelta(previous?.activity,current?.activity),
        objective:valueDelta(previous?.objective,current?.objective),
        focus:valueDelta(previous?.focus,current?.focus),
        timeContext:valueDelta(previous?.timeContext,current?.timeContext),
        references:{
            changed:JSON.stringify(referenceSignature(references))!==JSON.stringify(referenceSignature(priorReferences)),
            previous:clone(priorReferences||normalizeReferences()),
            current:clone(references||normalizeReferences()),
        },
    };
}
function promptRows(rows=[]){
    const slice=rows.slice(-MAX_SCENE_MESSAGES);
    return slice.map((row,index)=>`[${row?.is_user===true?'User':'Assistant'}${index===slice.length-1?' · CURRENT':''}]\n${String(row?.mes||'').trim()}`).join('\n\n');
}
export function normalizeSceneScanPayload(value){
    if(!value||typeof value!=='object'||Array.isArray(value))return value;
    const references=value.references&&typeof value.references==='object'&&!Array.isArray(value.references)?{...value.references}:value.references;
    const nestedReasoning=references&&typeof references.reasoning==='string'?clean(references.reasoning):'';
    const topLevelReasoning=typeof value.reasoning==='string'?clean(value.reasoning):'';
    if(references&&Object.prototype.hasOwnProperty.call(references,'reasoning'))delete references.reasoning;
    if(!nestedReasoning||topLevelReasoning)return references===value.references?value:{...value,references};
    return {...value,references,reasoning:nestedReasoning};
}
function sceneScanValidator(input){
    const value=normalizeSceneScanPayload(input);
    const errors=[]; let score=0;
    if(!value||typeof value!=='object'||Array.isArray(value))return {valid:false,score,reason:'Scene scan must be a top-level object.'};
    if(!value.scene||typeof value.scene!=='object'||Array.isArray(value.scene))errors.push('scene must be an object'); else {
        score+=10;
        if(!Array.isArray(value.scene.participants)||value.scene.participants.some(row=>typeof row!=='string'))errors.push('scene.participants must be a string array'); else score+=8;
        for(const key of ['location','activity','objective','focus','timeContext']){
            if(typeof value.scene[key]!=='string')errors.push(`scene.${key} must be text`); else score+=2;
        }
        if(typeof value.scene.relationshipFocus!=='boolean')errors.push('scene.relationshipFocus must be boolean'); else score+=2;
    }
    if(!value.references||typeof value.references!=='object'||Array.isArray(value.references))errors.push('references must be an object'); else {
        score+=8;
        for(const kind of REFERENCE_KINDS){
            const rows=value.references[kind];
            if(!Array.isArray(rows)){errors.push(`references.${kind} must be an array`);continue;}
            const invalid=rows.some(row=>{
                if(typeof row==='string')return !clean(row);
                return !row||typeof row!=='object'||Array.isArray(row)||typeof row.name!=='string'||!clean(row.name)||(row.relation!==undefined&&typeof row.relation!=='string');
            });
            if(invalid)errors.push(`references.${kind} rows require non-empty text or {name, relation} objects`); else score+=2;
        }
        // Physical scene participants and off-screen/discussed character refs
        // are separate semantic channels. Reject ambiguous overlap instead of
        // allowing consumers to guess which interpretation has authority.
        if(Array.isArray(value.scene?.participants)&&Array.isArray(value.references.characters)){
            const present=new Set(value.scene.participants.map(name=>clean(name).toLocaleLowerCase()).filter(Boolean));
            const overlap=value.references.characters.map(row=>clean(typeof row==='string'?row:row?.name)).filter(name=>name&&present.has(name.toLocaleLowerCase()));
            if(overlap.length)errors.push(`references.characters overlaps scene.participants: ${[...new Set(overlap)].join(', ')}`);
            else score+=4;
        }
    }
    if(typeof value.reasoning!=='string'||!clean(value.reasoning))errors.push('reasoning must be non-empty text'); else score+=5;
    return {valid:errors.length===0,score,reason:errors.join('; ')||null,value};
}
function scenePrompt({previous=null,rows=[]}={}){
    return `Nexus SCENE SCANNER\n\nYou own scene observation only. You DO NOT decide NO_CHANGE, MINOR_CHANGE, or MAJOR_CHANGE. Change Gate owns that policy.\n\nCompare the RECENT SCENE EVIDENCE to PREVIOUS ACCEPTED SCENE and report what the scene currently is. If a previous field is still true and there is no explicit evidence it changed, COPY THE PREVIOUS VALUE EXACTLY. Do not rewrite or embellish stable fields.\n\nSCENE TOPOLOGY RULES\n- participants = only characters physically present, speaking, directly acted upon, or carrying the immediate interpersonal beat.\n- A character merely discussed, remembered, assigned elsewhere, planned for later, or named in dialogue is NOT a participant. Put that character in references.characters instead.\n- location = the actual current scene location. Local movement inside that location (walking through woods, crossing a room, moving toward a river, sitting at a desk) does NOT change location.\n- activity = short stable label for what the scene is doing now (conversation, hunting, training, combat, travel, meeting, etc.).\n- objective = the immediate scene objective. If unchanged, copy the prior value exactly.\n- focus = the current beat focus within the same scene. This may change without topology changing.\n- timeContext = only a meaningful temporal boundary/state. Do not invent clocks.\n- relationshipFocus = true only when the immediate beat is an intimate/relationship-driven dyad where relationship lore is load-bearing.\n\nREFERENCE RULES\nCapture references that are actively relevant to the CURRENT beat or the next one or two replies, even when they are not physically present/current. Do not recap every name from the history window.\n- EVERY references bucket uses the same row shape: {"name":"...","relation":"..."}. Do not emit bare strings.\n- references.characters: discussed/off-screen/planned characters. relations: discussed, planned-participant, historical, mentioned.\n- references.locations: discussed/currently relevant future or past places. relations: discussed, planned-destination, historical, mentioned.\n- references.organizations: organizations materially discussed or involved. relations: discussed, historical, mentioned.\n- references.concepts: materially discussed systems/topics. relations: discussed, historical, mentioned.\n- references.items: materially discussed equipment/artifacts/items. relations: discussed, historical, mentioned.\nReferences are relevance signals for lore warming. They MUST NOT be promoted into participants/current location unless the scene evidence actually makes them present/current.\n\nPREVIOUS ACCEPTED SCENE\n${previous?JSON.stringify(previous,null,2):'(none — establish the current scene as the first accepted baseline)'}\n\nRECENT SCENE EVIDENCE\n${promptRows(rows)||'(none)'}\n\nOUTPUT CONTRACT\nReturn ONLY one JSON object:\n{"scene":{"participants":["Name"],"location":"","activity":"","objective":"","focus":"","timeContext":"","relationshipFocus":false},"references":{"characters":[{"name":"Off-screen character","relation":"discussed"}],"locations":[{"name":"Future place","relation":"planned-destination"}],"organizations":[{"name":"Organization","relation":"mentioned"}],"concepts":[{"name":"Relevant concept","relation":"discussed"}],"items":[{"name":"Relevant item","relation":"mentioned"}]},"reasoning":"short explanation of what is present vs merely referenced"}`;
}
function defaultScene(){ return {participants:[],location:'',activity:'',objective:'',focus:'',timeContext:'',relationshipFocus:false}; }
function degradedObservation(previous=null){ return previous?clone(previous):defaultScene(); }

export function primeSceneScannerContext({chatId=null,messages=[],cold=false,source='chat-hydration'}={}){
    const rows=narrativeRows(messages);
    activeState={
        version:1,chatId:chatId==null?null:String(chatId),primed:true,cold:cold===true,baselinePending:true,
        primedRevision:sceneRevision(rows),acceptedScene:null,previousScene:null,delta:null,references:normalizeReferences(),
        scanRevision:'',degraded:false,source:String(source||'chat-hydration'),reasoning:'',updatedAt:Date.now(),
    };
    logEvent('scene-scanner','context-primed',{source:activeState.source,chatId:activeState.chatId,cold:activeState.cold,usableMessages:rows.length},rows.length?'debug':'info');
    return clone(activeState);
}
export function clearSceneScannerState(reason='cleared'){
    const prior=activeState; activeState=null;
    if(prior)logEvent('scene-scanner','state-cleared',{reason,chatId:prior.chatId},'debug');
    return clone(prior);
}
export function getSceneScannerSnapshot({chatId=null}={}){
    if(!activeState)return null;
    if(chatId!=null&&String(chatId)!==String(activeState.chatId??''))return null;
    return clone(activeState);
}


export function reuseSceneObservation({context=getContext(),messages=null,source='decision-preflight-reuse',reason='Decision Core preflight authorized reuse'}={}){
    const chat=Array.isArray(messages)?messages:(Array.isArray(context?.chat)?context.chat:[]);
    const rows=narrativeRows(chat);
    const chatId=context?.chatId??context?.chat_id??null;
    if(!activeState||String(activeState.chatId??'')!==String(chatId??'')||!activeState?.acceptedScene)return null;
    const revision=sceneRevision(rows);
    const previous=clone(activeState.acceptedScene),references=clone(activeState.references||normalizeReferences());
    const delta=buildSceneDelta(previous,previous,references,references,false,false);
    activeState={...activeState,baselinePending:false,previousScene:clone(previous),acceptedScene:clone(previous),delta:clone(delta),references,scanRevision:revision,degraded:false,source:String(source||'decision-preflight-reuse'),reasoning:String(reason||''),slot:null,updatedAt:Date.now()};
    logEvent('scene-scanner','scan-reused',{source:activeState.source,chatId:activeState.chatId,sceneRevision:revision,reason,participants:previous.participants||[],location:previous.location||null},'info');
    return getSceneScannerSnapshot({chatId});
}

export async function scanScene({context=getContext(),messages=null,source='scene-scan',scope=null,enqueueSidecar=null,force=false}={}){
    const chat=Array.isArray(messages)?messages:(Array.isArray(context?.chat)?context.chat:[]);
    const rows=narrativeRows(chat);
    const chatId=context?.chatId??context?.chat_id??null;
    if(!activeState||String(activeState.chatId??'')!==String(chatId??''))primeSceneScannerContext({chatId,messages:chat,cold:rows.length===0,source:'implicit-prime'});
    const revision=sceneRevision(rows);
    if(!force&&activeState?.scanRevision===revision&&activeState?.acceptedScene)return getSceneScannerSnapshot({chatId});

    const workScope=scope||captureNexusWorkScope(context,{includeRevision:true});
    const previous=activeState?.acceptedScene?clone(activeState.acceptedScene):null;
    const previousReferences=clone(activeState?.references||normalizeReferences());
    let current=null,references=null,reasoning='',degraded=false,slot=null;

    if(!rows.length){
        current=defaultScene(); references=normalizeReferences(); reasoning='No narrative scene messages are available.';
    }else{
        try{
            const dispatch=typeof enqueueSidecar==='function'
                ? enqueueSidecar
                : (stage,options)=>enqueueNexusModelWorkerJob('reasoning',stage,{...options,role:'retrieval',mainPreferred:false,mainEligible:true});
            const job=dispatch(BUS_STAGE.SCENE_SCAN,{
                prompt:scenePrompt({previous,rows}),
                systemPrompt:'You are Nexus Scene Scanner. Observe scene state and references only. Return exact JSON only.',
                responseFormat:'json_object',excludeReasoning:true,structuredValidator:sceneScanValidator,reasoningEffort:'low',
                priority:BUS_PRIORITY.SCENE_SCAN??BUS_PRIORITY.RETRIEVAL,foregroundAdjacent:true,preemptible:false,maxAttempts:1,
                dedupKey:`scene-scan:${String(chatId??'none')}:${revision}`,nexusScope:workScope,label:'Scene Scanner',
                telemetry:{sceneScanner:true,sceneRevision:revision,baselinePending:previous==null},
            });
            const response=await job.promise;
            if(workScope&&!isNexusWorkScopeFresh(workScope,getContext())){
                const error=new Error('Scene Scanner result became stale before acceptance.');error.name='TV2ScopeInvalidated';throw error;
            }
            const parsed=response?.structuredPayload??parseStructuredJsonCandidate(response?.text||'',{validator:sceneScanValidator,label:'Scene Scanner'});
            current=normalizeScene(parsed.scene,previous);
            references=normalizeReferences(parsed.references);
            reasoning=clean(parsed.reasoning);
            slot=response?.tv2?.slot||null;
        }catch(error){
            if(isIntentionalCancellation(error))throw error;
            degraded=true; current=degradedObservation(previous); references=previousReferences;
            reasoning=`Scene Scanner degraded fallback preserved the previously accepted scene: ${error?.message||String(error)}`;
            logEvent('scene-scanner','scan-degraded',{source,chatId,revision,error:error?.message||String(error),preservedPrevious:Boolean(previous)},'warn');
        }
    }

    const initialBaseline=!previous;
    const delta=buildSceneDelta(previous||defaultScene(),current,references,previousReferences,initialBaseline,degraded);
    activeState={
        version:1,chatId:chatId==null?null:String(chatId),primed:true,cold:rows.length===0,baselinePending:false,
        primedRevision:activeState?.primedRevision||'',acceptedScene:clone(current),previousScene:previous?clone(previous):null,
        delta:clone(delta),references:clone(references),scanRevision:revision,degraded,source:String(source||'scene-scan'),reasoning,slot,
        updatedAt:Date.now(),
    };
    logEvent('scene-scanner','scan-accepted',{
        source:activeState.source,chatId:activeState.chatId,sceneRevision:revision,initialBaseline,degraded,slot,
        participants:current.participants,location:current.location||null,activity:current.activity||null,objective:current.objective||null,focus:current.focus||null,timeContext:current.timeContext||null,
        delta:{participants:delta.participants,location:delta.location,activity:delta.activity,objective:delta.objective,focus:delta.focus,timeContext:delta.timeContext,referencesChanged:delta.references.changed},
        references:Object.fromEntries(REFERENCE_KINDS.map(kind=>[kind,references[kind].map(row=>({name:row.name,relation:row.relation}))])),
    },degraded?'warn':'info');
    return getSceneScannerSnapshot({chatId});
}

export function sceneReferenceTerms(snapshot=getSceneScannerSnapshot()||{}){
    const scene=snapshot?.acceptedScene||{}; const refs=snapshot?.references||{}; const out=[];
    for(const name of stableNames(scene.participants))out.push({kind:'character',name,relation:'present',priority:100});
    if(clean(scene.location))out.push({kind:'location',name:clean(scene.location),relation:'current-location',priority:95});
    if(clean(scene.activity))out.push({kind:'concept',name:clean(scene.activity),relation:'current-activity',priority:55});
    const weights={
        characters:{kind:'character',base:78},locations:{kind:'location',base:76},organizations:{kind:'organization',base:68},concepts:{kind:'concept',base:56},items:{kind:'item',base:62},
    };
    for(const [bucket,meta] of Object.entries(weights))for(const row of refs?.[bucket]||[]){
        const relation=clean(row?.relation).toLocaleLowerCase()||'mentioned';
        const bump=/(planned|current|involved)/.test(relation)?8:/discussed/.test(relation)?5:/historical/.test(relation)?-8:0;
        out.push({kind:meta.kind,name:clean(row?.name),relation,priority:meta.base+bump});
    }
    const seen=new Set();
    return out.filter(row=>{const key=`${row.kind}:${row.name.toLocaleLowerCase()}`;if(!row.name||seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>b.priority-a.priority).slice(0,12);
}
