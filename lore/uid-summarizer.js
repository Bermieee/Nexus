import { getSettings, updateSettings } from '../core/settings.js';
import { loadBook, findEntryByUid } from './store.js';
import { assertReadableBook } from './policy.js';
import { estimateContentTokens, formatTokenCount } from '../observability/token-estimator.js';
import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { entryBaselineFromEntry } from '../proposals/bus.js';
import { logEvent } from '../observability/telemetry.js';
import { NEXUS_BATCH_DOMAIN, runNexusModelWorkerBatch, structuredSidecarOptions } from '../nexus/batch-layer.js';
import { dispatchNexusModelWorkerUnits } from '../nexus/model-worker-bus.js';
import { validateUidContributionPayload, validateUidSummaryPayload } from '../sidecar/semantic-validation.js';
import { validateUidContributionLocalPayload, validateUidSummaryLocalPayload } from './uid-summary-contract.js';
import { LOGICAL_SOFT_PACKING_TARGET, assertPhysicalPromptBounded, hashLogicalSource, packValidatedItems, resolvePhysicalPackingBudget, sliceSemanticText } from '../nexus/large-input-reshape.js';
import { abortNexusTransaction, abortNexusReviewTransactionDurably, approveNexusTransaction, beginUidSummaryTransaction, buildSummaryAssumptions, enforceNexusTransactionFreshBeforeStage, getNexusLedger, markNexusTransactionAggregating, recordNexusTransactionSlice, stageUidSummarySelectionTransaction, updateNexusTransactionExecution, validateUidSummaryTransactionResult, persistNexusReviewTransaction, failNexusTransactionDurable as failNexusTransaction } from '../nexus/transaction-service.js';
import { commitCanonicalNexusMutation } from '../nexus/mutation-coordinator.js';
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
function profileSafetyCap(profile,targetTokens){const target=Math.max(48,Number(targetTokens)||48);return Math.max(target,Math.min(4000,Math.ceil(target*profileTolerance(profile))));}
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
