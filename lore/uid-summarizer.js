import { getSettings, updateSettings } from '../core/settings.js';
import { loadBook, findEntryByUid } from './store.js';
import { assertReadableBook } from './policy.js';
import { estimateContentTokens, formatTokenCount } from '../observability/token-estimator.js';
import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { entryBaselineFromEntry } from '../proposals/bus.js';
import { makeDraggableWindow } from '../windowing.js';
import { logEvent } from '../observability/telemetry.js';
import { bindSidecarStatus } from '../observability/sidecar-status.js';
import { NEXUS_BATCH_DOMAIN, runNexusModelWorkerBatch, structuredSidecarOptions } from '../nexus/batch-layer.js';
import { dispatchNexusModelWorkerUnits } from '../nexus/model-worker-bus.js';
import { validateUidContributionPayload, validateUidSummaryPayload } from '../sidecar/semantic-validation.js';
import { validateUidContributionLocalPayload, validateUidSummaryLocalPayload } from './uid-summary-contract.js';
import { LOGICAL_SOFT_PACKING_TARGET, assertPhysicalPromptBounded, hashLogicalSource, packValidatedItems, resolvePhysicalPackingBudget, sliceSemanticText } from '../nexus/large-input-reshape.js';
import { abortNexusTransaction, abortNexusReviewTransactionDurably, approveNexusTransaction, beginUidSummaryTransaction, buildSummaryAssumptions, enforceNexusTransactionFreshBeforeStage, getNexusLedger, markNexusTransactionAggregating, recordNexusTransactionSlice, stageUidSummarySelectionTransaction, updateNexusTransactionExecution, validateUidSummaryTransactionResult, persistNexusReviewTransaction, failNexusTransactionDurable as failNexusTransaction } from '../nexus/transaction-service.js';
import { commitCanonicalNexusMutation } from '../nexus/mutation-coordinator.js';
import { upgradeLaneDButtons, createLaneDItemRow } from '../tree/ui-core-adapter.js';
import { UID_SUMMARY_DRAFT_REVIEW_SITE_ID } from './uid-decision-site.js';
import { startDecisionSiteThroughDirector } from '../decision/work-director-bridge.js';

const DETAIL = Object.freeze({ brief: 'Brief', balanced: 'Balanced', detailed: 'Detailed' });
const PROFILES = Object.freeze({
    lean: { label: 'Lean', detail: 'brief', ratio: 0.34, min: 80, max: 420 },
    balanced: { label: 'Balanced', detail: 'balanced', ratio: 0.55, min: 140, max: 900 },
    heavy: { label: 'Heavy', detail: 'detailed', ratio: 0.78, min: 220, max: 1600 },
});
const DEFAULTS = Object.freeze({ includeKeywords: true });
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function parseJson(text){
    const raw=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
    try{return JSON.parse(raw);}catch{}
    // Qwen can expose a reasoning preamble containing JSON examples before its
    // real final. Keep the last complete object that is actually a UID result.
    let result=null;
    for(let start=raw.indexOf('{');start>=0;start=raw.indexOf('{',start+1)){
        let depth=0,inString=false,escaped=false;
        for(let i=start;i<raw.length;i++){
            const ch=raw[i];
            if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue;}
            if(ch==='"'){inString=true;continue;}
            if(ch==='{')depth++;
            if(ch==='}'&&--depth===0){try{const parsed=JSON.parse(raw.slice(start,i+1));if(Array.isArray(parsed?.options)||typeof parsed?.summary==='string')result=parsed;}catch{}break;}
        }
    }
    if(result)return result;
    throw new Error('UID Summarizer returned no usable JSON result.');
}
function optionState(){const saved=getSettings().uidSummarizer||{};return {...DEFAULTS,...saved};}
function persistOptions(next){updateSettings(s=>{s.uidSummarizer={...DEFAULTS,...(s.uidSummarizer||{}),...next};});}
function entryTitle(entry,uid){return String(entry?.comment||entry?.key?.[0]||`UID ${uid}`);}
function profileCap(profile,sourceTokens){const cfg=PROFILES[profile]||PROFILES.balanced;return Math.max(48,Math.min(4000,Math.max(cfg.min,Math.min(cfg.max,Math.round(Math.max(1,Number(sourceTokens)||1)*cfg.ratio)))));}
function profileTolerance(profile){return profile==='lean'?1.40:profile==='balanced'?1.30:1.20;}
function profileSafetyCap(profile,targetTokens){const cfg=PROFILES[profile]||PROFILES.balanced,target=Math.max(48,Number(targetTokens)||48);return Math.max(target,Math.min(cfg.max,Math.ceil(target*profileTolerance(profile))));}
function profilePlans(sourceTokens,profiles=['lean','balanced','heavy']){return profiles.map(id=>{const cfg=PROFILES[id]||PROFILES.balanced,targetTokens=profileCap(id,sourceTokens);return {id,label:cfg.label,detail:cfg.detail,targetTokens,safetyCapTokens:profileSafetyCap(id,targetTokens)};});}
function profileWritingTarget(plan,{recoveryAttempt=0}={}){const target=Math.max(48,Number(plan?.targetTokens)||48),ratio=recoveryAttempt<=0?.92:recoveryAttempt===1?.84:.76;return Math.max(36,Math.min(target,Math.floor(target*ratio)));}
function usableOption(option,cap){const summary=String(option?.summary||'').trim(),estimatedTokens=estimateContentTokens(summary),keywords=[...new Set((Array.isArray(option?.keywords)?option.keywords:[]).map(v=>String(v).trim()).filter(Boolean))].slice(0,8);if(!summary||estimatedTokens>cap||/^(?:\.\.\.|compressed lore content)$/i.test(summary))return null;return {summary,keywords,notes:String(option?.notes||''),sourceContributionRefs:[...new Set((option?.sourceContributionRefs||[]).map(String).filter(Boolean))],estimatedTokens};}
function uidSourceIdentity(entry,uid){
    const sourceHash=hashLogicalSource(JSON.stringify({uid:Number(uid),title:entryTitle(entry,uid),keys:[...(entry?.key||[])],content:String(entry?.content||''),disable:entry?.disable===true}));
    const sourceRevision=String(entry?.revision??entry?._rev??entry?.updatedAt??sourceHash);
    return {uid:Number(uid),sourceHash,sourceRevision,title:entryTitle(entry,uid),sourceKeys:[...(entry?.key||[])].map(String)};
}
function uidContributionPrompt(identity,sliceId,content,includeKeywords){return `NEXUS UID SOURCE CONTRIBUTION EXTRACTION

SOURCE CONTEXT
TITLE: ${identity.title}
KEYS: ${JSON.stringify(identity.sourceKeys)}
SEGMENT: ${sliceId}

SOURCE SLICE
${content}

TASK
Extract a bounded semantic representation of this source slice without writing the final summary. Preserve distinct canon, names, relationships, chronology, hard constraints, active emotional truths, and functional behavioral/sensory texture. ${includeKeywords?'Collect specific low-collision keyword candidates grounded in this slice.':'Return no keyword candidates.'} Nexus owns and binds UID, source hash/revision, title/keys identity, and segment identity locally; do not return them.
Return ONLY JSON:
{"contributions":["grounded contribution"],"keywordCandidates":[]}`;}
function uidContributionReductionPrompt(identity,sliceId,items,includeKeywords){return `NEXUS UID CONTRIBUTION CONSOLIDATION

SOURCE CONTEXT
TITLE: ${identity.title}
KEYS: ${JSON.stringify(identity.sourceKeys)}
AGGREGATE SEGMENT: ${sliceId}

VALIDATED CONTRIBUTIONS
${JSON.stringify(items)}

TASK
Consolidate only redundant/overlapping contributions while preserving every distinct load-bearing canon detail. This remains an intermediate semantic representation, not final lore prose. ${includeKeywords?'Preserve useful grounded keyword candidates.':'Return no keyword candidates.'} Nexus owns and binds persistent source identity locally; do not return UIDs, hashes, revisions, source keys, or segment IDs.
Return ONLY JSON:
{"contributions":["grounded consolidated contribution"],"keywordCandidates":[]}`;}
function uidContributionRefs(contributions=[]){
    return (contributions||[]).flatMap(item=>(item.contributions||[]).map((content,index)=>({ref:`${item.sliceId}#${index}`,content:String(content)})));
}
function uidFinalPrompt(identity,plan,contributions,detail,includeKeywords){const refs=uidContributionRefs(contributions),writingTarget=profileWritingTarget(plan);return `NEXUS UID SUMMARIZER — FINAL DRAFT

SOURCE CONTEXT
TITLE: ${identity.title}
KEYS: ${JSON.stringify(identity.sourceKeys)}

VALIDATED SOURCE CONTRIBUTIONS WITH REF IDS
${JSON.stringify(refs)}

TASK
Produce the ${plan.label} complete lore draft at detail level ${detail}. TARGET: about ${plan.targetTokens} estimated tokens. Prefer ${writingTarget} or fewer when that preserves the source cleanly. A draft may exceed the target when needed for faithful compression, but must stay at or below the absolute safety ceiling of ${plan.safetyCapTokens??plan.targetTokens} estimated tokens. Stop once the necessary continuity is preserved and never pad toward the cap. Preserve load-bearing canon, chronology, relationships, constraints, active emotional truths, and functional behavioral texture. Do not invent facts. ${includeKeywords?'Suggest 3–8 specific low-collision activation keywords grounded in the source.':'Return an empty keywords array.'} Nexus owns and binds UID, source hash/revision, title, and source-key identity locally; do not return them. Every option must cite every exact sourceContributionRef from the validated list above exactly once; those refs prove the complete validated source set was considered.
Return ONLY JSON:
{"options":[{"label":${JSON.stringify(plan.label)},"summary":"complete bounded lore draft","keywords":[],"notes":"","sourceContributionRefs":["full-source#0"]}]}`;}

function runUidModelWorkerBatch(options={}){return runNexusModelWorkerBatch({...options,dispatchUnits:input=>dispatchNexusModelWorkerUnits(input)});}

async function reduceUidContributionsToFit({identity,contributions,plan,detail,includeKeywords,packing,transactionId,signal=null}){
    let current=contributions;
    for(let round=0;round<12;round++){
        const finalPrompt=uidFinalPrompt(identity,plan,current,detail,includeKeywords),beforeTokens=estimateContentTokens(finalPrompt);if(beforeTokens<=packing.promptTargetTokens)return current;
        const groups=packValidatedItems({items:current,buildPrompt:items=>uidContributionReductionPrompt(identity,'aggregate-probe',items,includeKeywords),targetTokens:packing.promptTargetTokens,label:'UID validated contributions'}),reduced=[];
        for(const group of groups){const sliceId=`uid-aggregate-r${round+1}-g${group.index}`,contract={...identity,sliceId},prompt=uidContributionReductionPrompt(identity,sliceId,group.items,includeKeywords);assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,'UID contribution consolidation');const batch=await runUidModelWorkerBatch({scopeKind:'independent',signal,domain:NEXUS_BATCH_DOMAIN.UID_SUMMARIZER,stage:BUS_STAGE.MAINTENANCE,items:[{contract}],requestedBatch:false,buildRequest:item=>structuredSidecarOptions({prompt,systemPrompt:'Consolidate validated Nexus UID source contributions. Return exact JSON only.',maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:value=>validateUidContributionLocalPayload(value,item.contract),telemetry:{uidSummarizer:true,phase:'contribution-consolidation',round,group:group.index}}),validate:(value,item)=>validateUidContributionPayload(value,item.contract),buildRecovery:item=>structuredSidecarOptions({prompt:`${prompt}\n\nRECOVERY: Return one corrected contribution JSON object only.`,systemPrompt:'Return corrected UID contribution JSON only.',maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:value=>validateUidContributionLocalPayload(value,item.contract),telemetry:{uidSummarizer:true,phase:'contribution-consolidation-recovery',round,group:group.index}})});const outcome=batch.completed[0];if(!outcome)throw new Error(batch.failed[0]?.error?.message||'UID contribution consolidation failed after bounded recovery.');reduced.push(outcome.value);}
        current=reduced;const afterTokens=estimateContentTokens(uidFinalPrompt(identity,plan,current,detail,includeKeywords)),noProgress=afterTokens>=beforeTokens;updateNexusTransactionExecution(transactionId,{aggregation:{phase:'uid-contribution-consolidation',round:round+1,groupCount:groups.length,remainingPayloads:current.length,beforeTokens,afterTokens,noProgress,softTargetUnresolved:afterTokens>packing.promptTargetTokens}},'aggregation-consolidated');if(noProgress)return current;
    }
    updateNexusTransactionExecution(transactionId,{aggregation:{phase:'uid-contribution-consolidation',softTargetUnresolved:true,reason:'soft-compaction-round-limit'}},'aggregation-soft-target-unresolved');
    return current;
}

export async function summarizeUid({book,uid,profiles=null,profile=null,detail=null,targetTokens=null,draftCount=null,includeKeywords=true,signal=null}={}){
    assertReadableBook(book);
    const data=await loadBook(book),entry=findEntryByUid(data?.entries,uid);if(!entry)throw new Error(`UID ${uid} was not found in "${book}".`);
    const sourceTokens=estimateContentTokens(entry.content||''),legacyTuning=profile!==null||detail!==null||targetTokens!==null||draftCount!==null;
    let plans;
    if(Array.isArray(profiles)&&profiles.length){plans=profilePlans(sourceTokens,profiles.filter(id=>Object.hasOwn(PROFILES,id)));}
    else if(legacyTuning){const profileId=Object.hasOwn(PROFILES,profile)?profile:'balanced',cfg=PROFILES[profileId],cap=Number.isFinite(Number(targetTokens))&&Number(targetTokens)>0?Math.max(48,Math.min(4000,Math.floor(Number(targetTokens)))):profileCap(profileId,sourceTokens);plans=[{id:profileId,label:cfg.label,detail:Object.hasOwn(DETAIL,detail)?detail:cfg.detail,targetTokens:cap,safetyCapTokens:profileSafetyCap(profileId,cap)}];}
    else plans=profilePlans(sourceTokens);
    if(!plans.length)plans=profilePlans(sourceTokens);
    const cap=Math.max(...plans.map(plan=>plan.targetTokens)),identity=uidSourceIdentity(entry,uid);
    const originalEntry={uid:Number(entry.uid),content:String(entry.content||''),comment:String(entry.comment||''),key:[...(entry.key||[])],disable:entry.disable===true,revision:entry?.revision??entry?._rev??entry?.updatedAt??null};
    let tx=beginUidSummaryTransaction({book,uid:Number(uid),originalContent:String(entry.content||''),originalEntry,cap,metadata:{profiles:plans.map(plan=>plan.id),draftCount:plans.length,includeKeywords},execution:{logicalJobId:`uid-summary:${book}:${uid}:${identity.sourceHash}`,sourceFingerprints:{source:identity.sourceHash,revision:identity.sourceRevision},identity:{book,...identity},settings:{profiles:plans.map(plan=>plan.id),draftCount:plans.length,includeKeywords,softPackingTarget:LOGICAL_SOFT_PACKING_TARGET},outputCap:cap,sliceManifest:[]}}),transactionId=tx.id;
    const systemPrompt='You are a precise Nexus lore editor. Nexus binds persistent source identity locally. Return only the requested semantic JSON; never expose analysis.';
    const packing=resolvePhysicalPackingBudget({role:'maintenance',stage:BUS_STAGE.MAINTENANCE,domain:NEXUS_BATCH_DOMAIN.UID_SUMMARIZER,phase:'uid-summary-reshape',requestedMaxTokens:Math.min(4096,Math.max(384,cap+256)),systemPrompt,settings:getSettings(),sliceInstructions:'UID contribution extraction and bounded final drafts'});
    updateNexusTransactionExecution(transactionId,{settings:{...(tx.execution?.settings||{}),physicalPromptTarget:packing.promptTargetTokens}},'physical-budget-resolved');
    try{
        const sourceText=String(entry.content||''),directSource=[{...identity,sliceId:'full-source',contributions:[sourceText],keywordCandidates:[]}],directProbe=uidFinalPrompt(identity,plans[plans.length-1],directSource,plans[plans.length-1].detail,includeKeywords);
        let contributions=[],reshapeUsed=estimateContentTokens(directProbe)>packing.promptTargetTokens;
        if(reshapeUsed){
            const slices=sliceSemanticText({text:sourceText,buildPrompt:fragment=>uidContributionPrompt(identity,'uid-slice-probe',fragment,includeKeywords),targetTokens:packing.promptTargetTokens,label:'UID source entry'}).map(slice=>({...slice,sliceId:`uid-slice-${slice.index}`}));
            updateNexusTransactionExecution(transactionId,{sliceManifest:slices.map(slice=>({id:slice.sliceId,order:slice.index,kind:'source-contribution',estimatedInputTokens:slice.estimatedInputTokens}))},'slice-manifest-planned');
            const batch=await runUidModelWorkerBatch({scopeKind:'independent',signal,domain:NEXUS_BATCH_DOMAIN.UID_SUMMARIZER,stage:BUS_STAGE.MAINTENANCE,items:slices,requestedBatch:slices.length>1,label:`UID source contributions · ${book} · #${uid}`,priority:BUS_PRIORITY.MAINTENANCE,dedupKey:`uid-contrib:${book}:${uid}:${identity.sourceHash}`,telemetry:{uidSummarizer:true,book,uid:Number(uid),reshape:true},buildRequest:slice=>{const contract={...identity,sliceId:slice.sliceId},prompt=uidContributionPrompt(identity,slice.sliceId,slice.content,includeKeywords);assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,'UID contribution slice');return structuredSidecarOptions({prompt,systemPrompt,maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:value=>validateUidContributionLocalPayload(value,contract),telemetry:{uidSummarizer:true,phase:'slice',sliceId:slice.sliceId}});},validate:(value,slice)=>validateUidContributionPayload(value,{...identity,sliceId:slice.sliceId}),buildRecovery:slice=>{const contract={...identity,sliceId:slice.sliceId},prompt=`${uidContributionPrompt(identity,slice.sliceId,slice.content,includeKeywords)}\n\nRECOVERY: Recompute only this source segment and return corrected contributions/keywordCandidates JSON. Do not return persistent source identity.`;return structuredSidecarOptions({prompt,systemPrompt:'Return corrected UID contribution JSON only.',maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:value=>validateUidContributionLocalPayload(value,contract),telemetry:{uidSummarizer:true,phase:'slice-recovery',sliceId:slice.sliceId}});}});
            for(const outcome of batch.completed)recordNexusTransactionSlice(transactionId,{sliceId:outcome.unit.item.sliceId,recovered:outcome.recovered===true,details:{jobId:outcome.jobId||null}});if(batch.failed.length){for(const outcome of batch.failed)recordNexusTransactionSlice(transactionId,{sliceId:outcome.unit.item.sliceId,failed:true});abortNexusTransaction(transactionId,'UID source slice failed after bounded recovery; no draft was staged.');throw new Error(batch.failed[0]?.error?.message||'UID source slice failed after bounded recovery.');}contributions=batch.completed.map(outcome=>outcome.value).sort((a,b)=>Number(a.sliceId.split('-').at(-1))-Number(b.sliceId.split('-').at(-1)));
        }else{
            contributions=[{...identity,sliceId:'full-source',contributions:[sourceText],keywordCandidates:[]}];updateNexusTransactionExecution(transactionId,{sliceManifest:[{id:'full-source',order:0,kind:'direct-source'}]},'slice-manifest-planned');recordNexusTransactionSlice(transactionId,{sliceId:'full-source'});
        }
        markNexusTransactionAggregating(transactionId,{phase:'uid-final-drafts',inputSliceCount:contributions.length});
        let normalizedContributions=contributions;const maxPlan=plans[plans.length-1];normalizedContributions=await reduceUidContributionsToFit({identity,contributions:normalizedContributions,plan:maxPlan,detail:maxPlan.detail,includeKeywords,packing,transactionId});const allowedContributionRefs=uidContributionRefs(normalizedContributions).map(row=>row.ref);
        const batch=await runUidModelWorkerBatch({scopeKind:'independent',signal,domain:NEXUS_BATCH_DOMAIN.UID_SUMMARIZER,stage:BUS_STAGE.MAINTENANCE,items:plans,requestedBatch:plans.length>1,recoveryAttempts:3,label:`UID Summarizer · ${book} · #${uid}`,priority:BUS_PRIORITY.MAINTENANCE,dedupKey:`uid-summary-final:${book}:${uid}:${identity.sourceHash}:${cap}`,telemetry:{uidSummarizer:true,book,uid:Number(uid),profiles:plans.map(plan=>plan.id),reshapeUsed},buildRequest:plan=>{const prompt=uidFinalPrompt(identity,plan,normalizedContributions,plan.detail,includeKeywords);assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,'UID final draft');const contract={...identity,optionCount:1,allowedContributionRefs};return structuredSidecarOptions({prompt,systemPrompt,maxTokens:Math.min(4096,Math.max(384,plan.targetTokens+256),packing.resourcePolicy.outputCeilingTokens||4096),priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:value=>validateUidSummaryLocalPayload(value,contract),telemetry:{uidSummarizer:true,phase:'final-draft',draft:plan.id,targetTokens:plan.targetTokens}});},validate:(value,plan)=>{const verdict=validateUidSummaryPayload(value,{...identity,optionCount:1,allowedContributionRefs});if(!verdict.valid)return verdict.reason;const raw=verdict.value.options[0],estimatedTokens=estimateContentTokens(String(raw?.summary||'')),safetyCap=plan.safetyCapTokens??plan.targetTokens,usable=usableOption(raw,safetyCap);return usable?true:(estimatedTokens>safetyCap?`The ${plan.label} draft is ${estimatedTokens} estimated tokens; safety ceiling is ${safetyCap} (target ${plan.targetTokens}).`:`The ${plan.label} draft is unusable.`);},buildRecovery:(plan,_outcome,context)=>{const attempt=Math.max(1,Number(context?.attempt)||1),writingTarget=profileWritingTarget(plan,{recoveryAttempt:attempt}),safetyCap=plan.safetyCapTokens??plan.targetTokens,prompt=`${uidFinalPrompt(identity,plan,normalizedContributions,plan.detail,includeKeywords)}\n\nRECOVERY ATTEMPT ${attempt}: Rewrite the summary from scratch. The preferred target is ${plan.targetTokens} estimated tokens and the absolute safety ceiling is ${safetyCap}; aim for ${writingTarget} or fewer. Prefer concise clauses and preserve only load-bearing canon needed for continuity. Do not pad. Keep every required sourceContributionRef exactly once. Return corrected JSON only and do not return persistent source identity.`;return structuredSidecarOptions({prompt,systemPrompt,maxTokens:Math.min(4096,Math.max(320,plan.targetTokens+220),packing.resourcePolicy.outputCeilingTokens||4096),priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:value=>validateUidSummaryLocalPayload(value,{...identity,optionCount:1,allowedContributionRefs}),telemetry:{uidSummarizer:true,phase:'final-draft-recovery',draft:plan.id,targetTokens:plan.targetTokens,safetyCapTokens:safetyCap,writingTarget,recoveryAttempt:attempt}});}});
        const failedDrafts=batch.failed.map(outcome=>({label:outcome.unit.item.label,targetTokens:outcome.unit.item.targetTokens,error:outcome.error?.message||String(outcome.error)}));const options=batch.completed.map(outcome=>{const plan=outcome.unit.item,raw=outcome.value.options[0],usable=usableOption(raw,plan.safetyCapTokens??plan.targetTokens);return usable?{id:`option-${plan.id}`,profileId:plan.id,label:plan.label,targetTokens:plan.targetTokens,safetyCapTokens:plan.safetyCapTokens??plan.targetTokens,...usable,slot:outcome.response?.tv2?.slot||null,recovered:outcome.recovered===true}:null;}).filter(Boolean);const completedProfileIds=new Set(options.map(option=>option.profileId)),missingPlans=plans.filter(plan=>!completedProfileIds.has(plan.id));if(missingPlans.length){const failureByLabel=new Map(failedDrafts.map(row=>[row.label,row.error])),missing=missingPlans.map(plan=>plan.label),details=missingPlans.map(plan=>failureByLabel.get(plan.label)?`${plan.label}: ${failureByLabel.get(plan.label)}`:plan.label).join(' | ');logEvent('lore','uid-summary-final-incomplete',{book,uid:Number(uid),transactionId,expectedDrafts:plans.map(plan=>plan.label),completedDrafts:options.map(option=>option.label),missingDrafts:missing,failedDrafts},'warn');abortNexusTransaction(transactionId,`UID final draft set incomplete after bounded recovery: ${missing.join(', ')}.`);throw new Error(`UID Summarizer could not produce all requested drafts after bounded recovery. Missing: ${missing.join(', ')}${details?` · ${details}`:''}`);}const finalResult={...identity,options:options.map(option=>({label:option.label,summary:option.summary,keywords:option.keywords,notes:option.notes,sourceContributionRefs:option.sourceContributionRefs}))},finalVerdict=validateUidSummaryPayload(finalResult,{...identity,optionCount:plans.length,allowedContributionRefs});if(!finalVerdict.valid)throw new Error(finalVerdict.reason||'UID final result failed semantic validation.');
        const current=await loadBook(book),currentEntry=findEntryByUid(current?.entries,uid),currentAssumptions=buildSummaryAssumptions({book,uid:Number(uid),cap,optionId:null,sourceEntry:currentEntry,originalContent:'',relevantState:null}),fresh=enforceNexusTransactionFreshBeforeStage(transactionId,currentAssumptions);if(fresh.state==='stale')return {stale:true,reason:'source-changed-before-review',transactionId};tx=validateUidSummaryTransactionResult(transactionId,{result:finalVerdict.value,validation:{passed:true,checks:{identity:true,optionCount:options.length,caps:true}}});if(tx.state!=='validated')throw new Error(tx.error||'UID summary draft could not be validated. Regenerate it.');
        try{const handle=startDecisionSiteThroughDirector(UID_SUMMARY_DRAFT_REVIEW_SITE_ID,{sourceIdentity:identity,sourceDigest:String(entry.content||''),drafts:options,sourceFingerprint:`${identity.sourceHash}:${identity.sourceRevision}`,getCurrentFingerprint:async()=>{const live=await loadBook(book),liveEntry=findEntryByUid(live?.entries,Number(uid));if(!liveEntry)return'missing';const liveIdentity=uidSourceIdentity(liveEntry,Number(uid));return `${liveIdentity.sourceHash}:${liveIdentity.sourceRevision}`; }},{source:'uid-summary-draft-review-shadow',mode:'shadow'});handle?.promise?.catch?.(()=>{});}catch{}
        const first=options[0],result={book,uid:Number(uid),title:identity.title,profiles:plans.map(plan=>plan.id),targetTokens:cap,requestedDraftCount:plans.length,failedDrafts,options,summary:first.summary,keywords:first.keywords,notes:first.notes,originalContent:String(entry.content||''),originalEntry,originalTokens:estimateContentTokens(entry.content||''),estimatedTokens:first.estimatedTokens,slot:first.slot||null,transactionId,sourceHash:identity.sourceHash,sourceRevision:identity.sourceRevision,sourceKeys:identity.sourceKeys,reshapeUsed};logEvent('lore','uid-summary-ready',{book,uid:Number(uid),transactionId,reshapeUsed,sourceHash:identity.sourceHash,options:options.map(option=>({label:option.label,targetTokens:option.targetTokens,safetyCapTokens:option.safetyCapTokens,estimatedTokens:option.estimatedTokens,recovered:option.recovered===true})),failedDrafts},failedDrafts.length?'warn':'info');return result;
    }catch(error){try{await failNexusTransaction(transactionId,error,{stage:'uid-summary-generation'});}catch{}throw error;}
}

export function openUidSummarizer({book='',uid=null}={}){
    const prior=document.querySelector('.tv2-uid-summarizer-overlay');
    if(prior){if(typeof prior.__tv2Close==='function')prior.__tv2Close();else prior.remove();}
    const initial=optionState(),overlay=document.createElement('div');
    overlay.className='tv2-overlay nexus-ui tv2-uid-summarizer-overlay';
    overlay.innerHTML=`<div class="tv2-uid-summarizer-panel">
      <div class="tv2-panel-head"><div><h3>UID Summarizer</h3></div><div class="tv2-shared-sidecar-status" aria-label="Main and Sidecar runtime status"></div><button class="menu_button tv2-window-close" data-action="close" type="button">Close</button></div>
      <div class="tv2-uid-summarizer-controls">
        <div class="tv2-uid-primary-row">
          <label>Lorebook<input class="text_pole tv2-uid-book" value="${esc(book)}" placeholder="Lorebook name"></label>
          <label class="tv2-uid-keywords"><input class="tv2-uid-keyword-toggle" type="checkbox" ${initial.includeKeywords?'checked':''}> Suggest safer keywords</label>
          <div class="tv2-uid-action-stack"><button class="menu_button" data-action="scan" data-nx-size="md" data-nx-fill="true" type="button">Reload UIDs</button><button class="menu_button" data-action="generate" data-nx-size="md" data-nx-fill="true" type="button">Summarize selected UID</button></div>
        </div>
        <div class="tv2-uid-filter-row">
          <label>Find UID or title<input class="text_pole tv2-uid-search" value="${uid??''}" placeholder="Find UID or title"></label>
          <div class="tv2-uid-sortbar" role="toolbar" aria-label="Sort UID entries"><button class="menu_button selected" data-sort="uid" type="button">UID</button><button class="menu_button" data-sort="title" type="button">Name</button><button class="menu_button" data-sort="tokens" type="button">Tokens</button></div>
        </div>
      </div>
      <div class="tv2-uid-workspace">
        <div class="tv2-uid-summary-list"><div class="tv2-uid-rows"><div class="tv2-empty">Choose a lorebook to load its entries.</div></div></div>
        <div class="tv2-uid-summary-preview"><div class="tv2-empty">Select a UID to review or summarize it.</div></div>
      </div>
    </div>`;
    document.body.appendChild(overlay);upgradeLaneDButtons(overlay);
    const panel=overlay.querySelector('.tv2-uid-summarizer-panel');
    makeDraggableWindow(panel,{handle:panel.querySelector('.tv2-panel-head'),storageKey:'uid-summarizer',resizable:true,minWidth:760,minHeight:520});
    bindSidecarStatus(panel?.querySelector('.tv2-shared-sidecar-status'),{includeQueue:false,includeMain:true});
    const list=panel.querySelector('.tv2-uid-summary-list'),rows=panel.querySelector('.tv2-uid-rows'),preview=panel.querySelector('.tv2-uid-summary-preview');
    let selectedUid=uid===null||uid===undefined?NaN:Number(uid);
    const values=()=>({book:panel.querySelector('.tv2-uid-book').value.trim(),uid:selectedUid,profiles:['lean','balanced','heavy'],includeKeywords:panel.querySelector('.tv2-uid-keyword-toggle').checked});
    let activeSummaryTransaction=null;
    let activeSummaryAbort=null;
    let scanRequestId=0;
    const close=async()=>{scanRequestId++;try{if(activeSummaryAbort&&!activeSummaryAbort.signal.aborted)activeSummaryAbort.abort(Object.assign(new Error('UID Summarizer window closed.'),{name:'TV2BatchCancelled'}));activeSummaryAbort=null;if(activeSummaryTransaction?.id){const live=getNexusLedger().read(activeSummaryTransaction.id);if(live&&['validated','staged'].includes(live.state))await abortNexusReviewTransactionDurably(live.id,'UID summary review closed without approval.');else if(live&&['created','executing','aggregating','parsed'].includes(live.state))abortNexusTransaction(live.id,'UID summary generation closed before review.');}activeSummaryTransaction=null;overlay.remove();}catch(error){globalThis.toastr?.error(error?.message||String(error),'UID Summarizer');}};overlay.__tv2Close=close;
    const setPreview=(html)=>{preview.innerHTML=html;};
    const search=panel.querySelector('.tv2-uid-search'),bookField=panel.querySelector('.tv2-uid-book'),reloadButton=panel.querySelector('[data-action="scan"]');
    bookField?.addEventListener('change',async()=>{selectedUid=NaN;loadedEntries=[];renderRows();try{await scan();}catch(error){globalThis.toastr?.error(error?.message||String(error),'UID Summarizer');}});

    function renderSelectedEntryDetails({message='Current committed lore entry'}={}){
        const entry=loadedEntries.find(item=>Number(item.uid)===selectedUid);
        if(!entry)return;
        const keys=[...(entry.key||[])];
        setPreview(`<div class="tv2-uid-help-card good"><b>${esc(message)}</b><span>UID #${selectedUid} · ${esc(entryTitle(entry,selectedUid))} · ${formatTokenCount(estimateContentTokens(entry.content||''))} tokens</span></div>${keys.length?`<div class="tv2-uid-keywords-line"><b>Keywords</b> · ${keys.map(esc).join(' · ')}</div>`:''}<textarea class="text_pole tv2-uid-review-text" rows="14" readonly>${esc(entry.content||'')}</textarea>`);
    }
    function selectRow(row){
        selectedUid=Number(row.dataset.uid);
        const entry=loadedEntries.find(item=>Number(item.uid)===selectedUid);
        rows.querySelectorAll('.tv2-uid-row').forEach(x=>{const active=x===row;x.classList.toggle('selected',active);x.classList.toggle('is-selected',active);x.setAttribute('aria-pressed',active?'true':'false');});
        if(entry)renderSelectedEntryDetails();
    }

    let loadedEntries=[],sortBy='uid',sortDirection=1;
    function renderRows(){
        const query=search.value.trim().toLowerCase(),entries=loadedEntries.filter(entry=>!query||`${entry.uid} ${entryTitle(entry,entry.uid)} ${(entry.key||[]).join(' ')} ${entry.content||''}`.toLowerCase().includes(query)).sort((a,b)=>{const value=entry=>sortBy==='uid'?Number(entry.uid):sortBy==='tokens'?estimateContentTokens(entry.content||''):entryTitle(entry,entry.uid).toLowerCase();const av=value(a),bv=value(b);return typeof av==='string'?sortDirection*av.localeCompare(bv):sortDirection*(av-bv);});
        rows.replaceChildren();
        if(!entries.length){const empty=document.createElement('div');empty.className='tv2-empty';empty.textContent=loadedEntries.length?'No loaded UID matches that search.':'No enabled lore entries in this book.';rows.append(empty);return;}
        for(const entry of entries){const uidValue=Number(entry.uid),tokens=estimateContentTokens(entry.content||''),meta=[document.createTextNode(`UID ${uidValue} · ${formatTokenCount(tokens)} tok`)];const row=createLaneDItemRow({title:entryTitle(entry,entry.uid),leading:meta,interactive:true,selected:uidValue===selectedUid,onClick:event=>selectRow(event.currentTarget),className:'tv2-uid-row',dataset:{uid:uidValue},document});rows.append(row);}
    }
    async function scan(){const {book:bookName}=values();if(!bookName)throw new Error('Enter or select a lorebook name.');assertReadableBook(bookName);const requestId=++scanRequestId;const priorLabel=reloadButton?.textContent||'Reload UIDs';if(reloadButton){reloadButton.disabled=true;reloadButton.textContent='Loading…';}try{const loaded=await loadBook(bookName);if(requestId!==scanRequestId||values().book!==bookName)return false;loadedEntries=Object.values(loaded?.entries||{}).filter(entry=>!entry?.disable).sort((a,b)=>Number(a.uid)-Number(b.uid));if(!loadedEntries.some(entry=>Number(entry.uid)===selectedUid))selectedUid=NaN;renderRows();if(reloadButton)reloadButton.textContent=`Reload UIDs · ${loadedEntries.length}`;globalThis.toastr?.success(`${loadedEntries.length} UID${loadedEntries.length===1?'':'s'} loaded.`, 'UID Summarizer',{timeOut:1400});return true;}finally{if(reloadButton){reloadButton.disabled=false;if(reloadButton.textContent==='Loading…')reloadButton.textContent=priorLabel;}}}
    search.addEventListener('input',()=>{selectedUid=NaN;renderRows();});
    panel.querySelectorAll('[data-sort]').forEach(button=>button.addEventListener('click',()=>{const next=button.dataset.sort;if(next===sortBy)sortDirection*=-1;else{sortBy=next;sortDirection=1;}panel.querySelectorAll('[data-sort]').forEach(item=>item.classList.toggle('selected',item===button));renderRows();}));

    function showOptionReview(out){
        const row=rows.querySelector(`.tv2-uid-row[data-uid="${CSS.escape(String(out.uid))}"]`);if(row)selectRow(row);
        const options=out.options||[];
        const optionChoice=(option,index)=>`<label class="tv2-uid-option-choice"><input type="radio" name="tv2-uid-option" value="${esc(option.id)}" ${index===0?'checked':''}><span><b>${esc(option.label)}</b><small>${formatTokenCount(option.estimatedTokens)} tok</small></span></label>`;
        const initialOption=options[0],picker=options.length>1?`<div class="tv2-uid-option-picker">${options.map(optionChoice).join('')}</div>`:`<input type="radio" name="tv2-uid-option" value="${esc(initialOption?.id||'')}" checked hidden>`;
        setPreview(`<div class="tv2-uid-option-review">${picker}<div class="tv2-uid-help-card good tv2-uid-draft-header"><b>UID #${out.uid} · <span class="tv2-uid-selected-token-count">${formatTokenCount(initialOption?.estimatedTokens||0)} tok</span></b><span>Lean, Balanced, and Heavy drafts are generated together. Review a choice, edit if needed, then explicitly apply it.</span></div><textarea class="text_pole tv2-uid-review-text" rows="14" readonly>${esc(initialOption?.summary||'')}</textarea>${(initialOption?.keywords||[]).length?`<div class="tv2-uid-keywords-line"><b>Suggested keywords</b> · ${(initialOption.keywords||[]).map(esc).join(' · ')}</div>`:''}<div class="tv2-uid-selected-readout"><b>${esc(initialOption?.label||'Draft')}</b> · ${formatTokenCount(initialOption?.estimatedTokens||0)} tokens</div><div class="tv2-uid-review-actions"><button class="menu_button tv2-uid-review-approve" type="button">Approve & Apply</button><button class="menu_button tv2-uid-review-edit" type="button">Edit</button><button class="menu_button tv2-uid-review-reject" type="button">Reject</button></div></div>`);
        upgradeLaneDButtons(preview);
        const optionById=new Map(options.map(option=>[option.id,option]));const text=preview.querySelector('.tv2-uid-review-text'),keys=preview.querySelector('.tv2-uid-keywords-line');activeSummaryTransaction=out.transactionId?{id:out.transactionId,state:'validated'}:null;
        const selected=()=>optionById.get(preview.querySelector('input[name="tv2-uid-option"]:checked')?.value)||options[0];
        const selectedTokenCount=preview.querySelector('.tv2-uid-selected-token-count'),selectedReadout=preview.querySelector('.tv2-uid-selected-readout');
        const refreshSelectedDisplay=()=>{const option=selected();const actual=estimateContentTokens(text.value);if(selectedTokenCount)selectedTokenCount.textContent=`${formatTokenCount(actual)} tok`;if(selectedReadout)selectedReadout.innerHTML=`Selected: <b>${esc(option.label)}</b> · ${formatTokenCount(actual)} tokens`;};
        const stageSelected=async()=>{const option=selected(),content=text.value.trim(),estimated=estimateContentTokens(content);if(!activeSummaryTransaction?.id)throw new Error('This draft is no longer available. Regenerate it.');activeSummaryTransaction=stageUidSummarySelectionTransaction(activeSummaryTransaction.id,{draft:{content,keywords:option.keywords||[],notes:option.notes||''},cap:option.targetTokens,estimatedTokens:estimated,optionId:option.id,metadata:{surface:'uid-summarizer'}});await persistNexusReviewTransaction(activeSummaryTransaction.id);return activeSummaryTransaction;};
        preview.querySelectorAll('input[name="tv2-uid-option"]').forEach(input=>input.addEventListener('change',()=>{if(activeSummaryTransaction?.state==='staged')throw new Error('A UID summary option is already staged; close and regenerate to change options.');const option=selected();text.value=option.summary;if(keys)keys.innerHTML=`<b>Suggested keywords</b> · ${(option.keywords||[]).map(esc).join(' · ')}`;text.readOnly=true;preview.querySelector('.tv2-uid-review-edit').textContent='Edit';refreshSelectedDisplay();}));
        text.addEventListener('input',refreshSelectedDisplay);
        preview.querySelector('.tv2-uid-review-edit').addEventListener('click',event=>{text.readOnly=!text.readOnly;event.currentTarget.textContent=text.readOnly?'Edit':'Finish Editing';if(!text.readOnly)text.focus();refreshSelectedDisplay();});
        preview.querySelector('.tv2-uid-review-reject').addEventListener('click',async()=>{if(activeSummaryTransaction?.id&&['validated','staged'].includes(activeSummaryTransaction.state))await abortNexusReviewTransactionDurably(activeSummaryTransaction.id,'Operator rejected summary draft.');activeSummaryTransaction=null;setPreview(`<div class="tv2-uid-help-card"><b>Draft rejected</b><span>UID #${out.uid} was not changed. Choose another draft or try again.</span></div>`);});
        preview.querySelector('.tv2-uid-review-approve').addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{const option=selected(),content=text.value.trim();if(!content)throw new Error('The reviewed summary is empty.');const estimated=estimateContentTokens(content);if(estimated>option.targetTokens)throw new Error(`Edited ${option.label} draft is too large for that draft profile.`);if(!activeSummaryTransaction||activeSummaryTransaction.staged?.content!==content)activeSummaryTransaction=await stageSelected();if(activeSummaryTransaction.state!=='staged')throw new Error(activeSummaryTransaction.error||'Summary draft could not be validated. Regenerate it.');const data=await loadBook(out.book),entry=findEntryByUid(data.entries,out.uid);const currentAssumptions=async()=>{const liveData=await loadBook(out.book),liveEntry=findEntryByUid(liveData.entries,out.uid);return buildSummaryAssumptions({book:out.book,uid:out.uid,cap:out.targetTokens,optionId:null,sourceEntry:liveEntry,originalContent:'',relevantState:null});};activeSummaryTransaction=approveNexusTransaction(activeSummaryTransaction.id,{by:'operator',metadata:{surface:'uid-summarizer',optionId:option.id}});const mergedKeys=option.keywords.length?[...new Set([...(entry?.key||[]),...option.keywords])]:entry?.key||[];const mutation={type:'entry.update',book:out.book,uid:Number(out.uid),patch:{content,keys:mergedKeys},expected:entryBaselineFromEntry(out.uid,entry)};activeSummaryTransaction=await commitCanonicalNexusMutation(activeSummaryTransaction.id,mutation,{currentAssumptions,metadata:{surface:'uid-summarizer',optionId:option.id},committed:result=>({uid:out.uid,optionId:option.id,result})});await persistNexusReviewTransaction(activeSummaryTransaction.id);if(activeSummaryTransaction.state==='stale')throw new Error('This UID changed after the summary was staged. Regenerate or restage from the current entry.');logEvent('lore','uid-summary-applied',{book:out.book,uid:out.uid,transactionId:activeSummaryTransaction.id,option:option.label},'info');globalThis.toastr?.success(`UID ${out.uid} summary applied.`,'Nexus');await scan();renderSelectedEntryDetails({message:`UID #${out.uid} updated — committed entry reloaded`});try{globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-lore-source-updated',{detail:{book:out.book,uid:Number(out.uid),source:'uid-summarizer'}}));}catch{}}catch(error){globalThis.toastr?.error(error?.message||String(error),'UID Summarizer');button.disabled=false;refreshSelectedDisplay();}});
        refreshSelectedDisplay();
    }


    async function generate(){
        const opts=values();if(!opts.book||!Number.isFinite(opts.uid))throw new Error('Choose a lorebook and UID first.');
        persistOptions({includeKeywords:opts.includeKeywords});
        setPreview('<div class="tv2-empty">Summarizing selected UID…</div>');
        if(activeSummaryAbort&&!activeSummaryAbort.signal.aborted)activeSummaryAbort.abort(Object.assign(new Error('UID summary generation superseded.'),{name:'TV2BatchCancelled'}));
        const controller=new AbortController();activeSummaryAbort=controller;
        try{const out=await summarizeUid({...opts,signal:controller.signal});if(!controller.signal.aborted)showOptionReview(out);}finally{if(activeSummaryAbort===controller)activeSummaryAbort=null;}
    }

    panel.addEventListener('click',async event=>{const button=event.target.closest('[data-action]'),action=button?.dataset.action;if(!action)return;try{if(action==='close')return close();button.disabled=true;if(action==='scan')await scan();if(action==='generate')await generate();button.disabled=false;}catch(error){globalThis.toastr?.error(error?.message||String(error),'UID Summarizer');if(button)button.disabled=false;}});
    overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
    if(book)scan().catch(error=>{rows.innerHTML=`<div class="tv2-empty">${esc(error?.message||String(error))}</div>`;});
}
