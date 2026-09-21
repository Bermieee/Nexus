import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { NEXUS_BATCH_DOMAIN, runNexusModelWorkerBatch, structuredSidecarOptions } from './batch-layer.js';
import { dispatchNexusModelWorkerUnits } from './model-worker-bus.js';
import { validateMergeContributionPayload, validateMergeFinalPayload } from '../sidecar/semantic-validation.js';
import { estimateContentTokens } from '../observability/token-estimator.js';
import { LOGICAL_SOFT_PACKING_TARGET, assertPhysicalPromptBounded, packValidatedItems, resolvePhysicalPackingBudget, sliceSemanticText } from './large-input-reshape.js';
import { markNexusTransactionAggregating, recordNexusTransactionSlice, updateNexusTransactionExecution } from './transaction-service.js';
import { mergeSourceIdentity, validateMergeDraft, mergeDraftProfile } from './merge-worker.js';
import { createMergeProvenanceRefContract, validateMergeFinalRefPayload, validateMergeContributionRefPayload } from './merge-provenance-contract.js';

const MERGE_FINAL_PHYSICAL_RESPONSE_MAX = 131072; // physical Main safety allowance; draft profiles are never hard output caps

function runMergeModelWorkerBatch(options={}){return runNexusModelWorkerBatch({...options,dispatchUnits:input=>dispatchNexusModelWorkerUnits(input)});}

function contributionPrompt(identity,sliceId,content){
    return `Nexus MERGE SOURCE CONTRIBUTION EXTRACTION\n\nSOURCE: ${identity.sourceTag}\nSLICE: ${sliceId}\n\nSOURCE SLICE\n${content}\n\nTASK\nExtract distinct canon contributions from this source slice only. Preserve chronology, relationships, constraints, and functional emotional/behavioral texture. Do not merge with the other source and do not write final lore prose. Nexus binds source identity locally; do not return UIDs, hashes, source tags, or slice IDs.\nReturn ONLY JSON:\n{"contributions":["grounded source contribution"]}`;
}
function contributionReductionPrompt(identity,sliceId,items){
    return `Nexus MERGE ${identity.sourceTag} CONTRIBUTION CONSOLIDATION\n\nAGGREGATE SLICE: ${sliceId}\n\nVALIDATED CONTRIBUTIONS\n${JSON.stringify(items)}\n\nTASK\nConsolidate only redundant contributions while preserving every distinct canon contribution from this source. This remains an intermediate provenance representation, not final merged prose. Nexus binds source identity locally; do not return UIDs, hashes, source tags, or slice IDs.\nReturn ONLY JSON:\n{"contributions":["grounded consolidated source contribution"]}`;
}
function flattenMergeContributionStrings(rows=[]){return (rows||[]).flatMap(row=>Array.isArray(row?.contributions)?row.contributions:[row]).map(value=>String(value||'').trim()).filter(Boolean);}
function deterministicSourceContributions(content=''){const source=String(content||'').trim();if(!source)return [];const paragraphs=source.split(/\n\s*\n/).map(v=>v.trim()).filter(Boolean),result=[];for(const paragraph of paragraphs){const sentences=paragraph.match(/[^.!?\n]+(?:[.!?]+|$)/g)?.map(v=>v.trim()).filter(Boolean)||[];result.push(...(sentences.length?sentences:[paragraph]));}return result;}

function finalMergeContext({identityA,identityB,titleA,titleB,contributionsA,contributionsB,profile='balanced'}){
    const sourceAContributions=flattenMergeContributionStrings(contributionsA),sourceBContributions=flattenMergeContributionStrings(contributionsB);
    const provenanceContract=createMergeProvenanceRefContract({sourceAContributions,sourceBContributions});
    const draftProfile=mergeDraftProfile(profile);
    const prompt=`Nexus MERGE FINAL SYNTHESIS\n\nSOURCE A TITLE: ${titleA}\nVALIDATED A CONTRIBUTIONS\n${JSON.stringify(provenanceContract.sourceA)}\n\nSOURCE B TITLE: ${titleB}\nVALIDATED B CONTRIBUTIONS\n${JSON.stringify(provenanceContract.sourceB)}\n\nDRAFT PROFILE\n${draftProfile.label} (${draftProfile.detail})\n${draftProfile.instruction}\n\nTASK\nConstruct one coherent de-duplicated lore entry from the validated A/B contributions. Preserve all distinct canon, relationships, chronology, constraints, and functional emotional/behavioral texture. Return every supplied short A#/B# provenance ref exactly once for its source; do not copy or paraphrase contribution text into provenance fields. Nexus owns and binds source UIDs, hashes, source tags, and persistent identity locally; do not return them. The profile is style/density guidance, not a token ceiling: never omit grounded canon merely to make the result shorter.\nReturn ONLY JSON:\n{"title":"merged title","content":"complete merged lore","mergeContext":"short rationale","sourceARefs":["A1"],"sourceBRefs":["B1"]}`;
    return {prompt,provenanceContract,sourceAContributions,sourceBContributions,draftProfile};
}
function finalMergePrompt(args){return finalMergeContext(args).prompt;}

async function reduceMergeContributions({identity,contributions,peerContributions,identityA,identityB,titleA,titleB,profile,packing,transactionId,signal=null}){
    let current=contributions;
    for(let round=0;round<12;round+=1){
        const a=identity.sourceTag==='A'?current:peerContributions,b=identity.sourceTag==='B'?current:peerContributions;
        const beforeTokens=estimateContentTokens(finalMergePrompt({identityA,identityB,titleA,titleB,contributionsA:a,contributionsB:b,profile}));
        if(beforeTokens<=packing.promptTargetTokens)return current;
        const groups=packValidatedItems({items:current,buildPrompt:items=>contributionReductionPrompt(identity,'aggregate-probe',items),targetTokens:packing.promptTargetTokens,label:`Merge source ${identity.sourceTag} contributions`});
        const reduced=[];
        for(const group of groups){
            const sliceId=`${identity.sourceTag}-aggregate-r${round+1}-g${group.index}`,contract={...identity,sliceId},prompt=contributionReductionPrompt(identity,sliceId,group.items);
            assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,`Merge ${identity.sourceTag} contribution consolidation`);
            const batch=await runMergeModelWorkerBatch({
                scopeKind:'independent',signal,domain:NEXUS_BATCH_DOMAIN.MERGE,stage:BUS_STAGE.MAINTENANCE,items:[{contract}],requestedBatch:false,
                buildRequest:item=>structuredSidecarOptions({prompt,systemPrompt:'Consolidate validated Nexus merge provenance contributions. Return exact JSON only.',maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:value=>validateMergeContributionRefPayload(value,item.contract),telemetry:{nexusMerge:true,phase:'contribution-consolidation',sourceTag:identity.sourceTag,round,group:group.index}}),
                validate:(value,item)=>validateMergeContributionPayload(value,item.contract),
                buildRecovery:item=>structuredSidecarOptions({prompt:`${prompt}\n\nRECOVERY: Return one corrected provenance contribution JSON object only.`,systemPrompt:'Return corrected merge contribution JSON only.',maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:value=>validateMergeContributionRefPayload(value,item.contract),telemetry:{nexusMerge:true,phase:'contribution-consolidation-recovery',sourceTag:identity.sourceTag,round,group:group.index}}),
            });
            const outcome=batch.completed[0];if(!outcome)throw new Error(batch.failed[0]?.error?.message||`Merge source ${identity.sourceTag} contribution consolidation failed.`);reduced.push(outcome.value);
        }
        current=reduced;
        const nextA=identity.sourceTag==='A'?current:peerContributions,nextB=identity.sourceTag==='B'?current:peerContributions;
        const afterTokens=estimateContentTokens(finalMergePrompt({identityA,identityB,titleA,titleB,contributionsA:nextA,contributionsB:nextB,profile})),noProgress=afterTokens>=beforeTokens;
        updateNexusTransactionExecution(transactionId,{aggregation:{phase:'merge-contribution-consolidation',sourceTag:identity.sourceTag,round:round+1,remainingPayloads:current.length,beforeTokens,afterTokens,noProgress,softTargetUnresolved:afterTokens>packing.promptTargetTokens}},'aggregation-consolidated');
        if(noProgress)return current;
    }
    updateNexusTransactionExecution(transactionId,{aggregation:{phase:'merge-contribution-consolidation',sourceTag:identity.sourceTag,softTargetUnresolved:true,reason:'soft-compaction-round-limit'}},'aggregation-soft-target-unresolved');
    return current;
}

function finalRequestValidator(context,semanticContract){return value=>validateMergeFinalRefPayload(value,{provenanceContract:context.provenanceContract,semanticContract});}

export async function executeMergeLogicalDraft({book,entryA,entryB,titleA,titleB,sourceATokens,sourceBTokens,profile='balanced',transactionId,settings={},signal=null}){
    const identityA=mergeSourceIdentity(entryA,'A'),identityB=mergeSourceIdentity(entryB,'B'),baseContract={sourceAUid:identityA.sourceUid,sourceBUid:identityB.sourceUid,sourceAHash:identityA.sourceHash,sourceBHash:identityB.sourceHash};
    const draftProfile=mergeDraftProfile(profile);
    const systemPrompt='You are a precise Nexus merge editor. Preserve exact A/B provenance and return only validated JSON.';
    const packing=resolvePhysicalPackingBudget({role:'maintenance',stage:BUS_STAGE.MAINTENANCE,domain:NEXUS_BATCH_DOMAIN.MERGE,phase:'merge-reshape',requestedMaxTokens:draftProfile.softOutputTokens,systemPrompt,settings,sliceInstructions:'source-tagged contribution extraction and final merge synthesis'});
    updateNexusTransactionExecution(transactionId,{sourceFingerprints:{A:identityA.sourceHash,B:identityB.sourceHash},settings:{softPackingTarget:LOGICAL_SOFT_PACKING_TARGET,physicalPromptTarget:packing.promptTargetTokens,draftProfile:draftProfile.id,softOutputTargetTokens:draftProfile.softOutputTokens}},'physical-budget-resolved');

    const directA=deterministicSourceContributions(entryA.content),directB=deterministicSourceContributions(entryB.content);
    const directContract={...baseContract,allowedSourceAContributions:directA,allowedSourceBContributions:directB};
    const directContext=finalMergeContext({identityA,identityB,titleA,titleB,contributionsA:directA,contributionsB:directB,profile:draftProfile.id}),directPrompt=directContext.prompt,directRefValidator=finalRequestValidator(directContext,directContract);
    if(estimateContentTokens(directPrompt)<=packing.promptTargetTokens){
        updateNexusTransactionExecution(transactionId,{sliceManifest:[{id:'merge-direct',order:0,kind:'final-direct',sourceTags:['A','B']}]},'slice-manifest-planned');
        assertPhysicalPromptBounded(directPrompt,packing.promptTargetTokens,'Merge direct request');
        const batch=await runMergeModelWorkerBatch({
            scopeKind:'independent',signal,domain:NEXUS_BATCH_DOMAIN.MERGE,stage:BUS_STAGE.MAINTENANCE,items:[{contract:directContract}],requestedBatch:false,
            buildRequest:()=>structuredSidecarOptions({prompt:directPrompt,systemPrompt,maxTokens:draftProfile.softOutputTokens,responseLength:MERGE_FINAL_PHYSICAL_RESPONSE_MAX,priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:directRefValidator,telemetry:{nexusMerge:true,phase:'direct-final'}}),
            validate:value=>{const semantic=validateMergeFinalPayload(value,directContract);if(!semantic.valid)return semantic.reason;return validateMergeDraft(value);},
            buildRecovery:()=>structuredSidecarOptions({prompt:`${directPrompt}\n\nRECOVERY: Return corrected sourceARefs/sourceBRefs and complete merged content. Preserve all grounded canon required by the selected draft profile. Nexus binds persistent source identity locally; do not return UIDs or hashes.`,systemPrompt,maxTokens:draftProfile.softOutputTokens,responseLength:MERGE_FINAL_PHYSICAL_RESPONSE_MAX,priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:directRefValidator,telemetry:{nexusMerge:true,phase:'direct-final-recovery'}}),
        });
        const outcome=batch.completed[0];if(!outcome)throw new Error(batch.failed[0]?.error?.message||'Merge direct draft failed after bounded recovery.');
        recordNexusTransactionSlice(transactionId,{sliceId:'merge-direct',recovered:outcome.recovered===true,details:{jobId:outcome.jobId||null}});
        return {draft:outcome.value,identityA,identityB,profile:draftProfile.id,reshapeUsed:false,slot:outcome.response?.tv2?.slot||null,jobId:outcome.jobId||null};
    }

    const buildSlices=(entry,identity)=>sliceSemanticText({text:String(entry.content||''),buildPrompt:fragment=>contributionPrompt(identity,`${identity.sourceTag}-slice-probe`,fragment),targetTokens:packing.promptTargetTokens,label:`Merge source ${identity.sourceTag}`}).map(slice=>({...slice,sourceTag:identity.sourceTag,sliceId:`${identity.sourceTag}-slice-${slice.index}`,identity}));
    const slices=[...buildSlices(entryA,identityA),...buildSlices(entryB,identityB)];
    updateNexusTransactionExecution(transactionId,{sliceManifest:slices.map((slice,order)=>({id:slice.sliceId,order,sourceTag:slice.sourceTag,kind:'source-contribution',estimatedInputTokens:slice.estimatedInputTokens}))},'slice-manifest-planned');
    const sliceBatch=await runMergeModelWorkerBatch({
        scopeKind:'independent',signal,domain:NEXUS_BATCH_DOMAIN.MERGE,stage:BUS_STAGE.MAINTENANCE,items:slices,requestedBatch:slices.length>1,label:`Merge source contributions · ${book} · ${entryA.uid}/${entryB.uid}`,priority:BUS_PRIORITY.MAINTENANCE,dedupKey:`merge-contrib:${book}:${identityA.sourceHash}:${identityB.sourceHash}`,telemetry:{nexusMerge:true,phase:'source-contributions'},
        buildRequest:slice=>{const contractSlice={...slice.identity,sliceId:slice.sliceId},prompt=contributionPrompt(slice.identity,slice.sliceId,slice.content);assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,`Merge ${slice.sourceTag} source slice`);return structuredSidecarOptions({prompt,systemPrompt:'Extract source-tagged Nexus merge contributions. Return exact JSON only.',maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:value=>validateMergeContributionRefPayload(value,contractSlice),telemetry:{nexusMerge:true,phase:'slice',sourceTag:slice.sourceTag,sliceId:slice.sliceId}});},
        validate:(value,slice)=>validateMergeContributionPayload(value,{...slice.identity,sliceId:slice.sliceId}),
        buildRecovery:slice=>{const contractSlice={...slice.identity,sliceId:slice.sliceId},prompt=`${contributionPrompt(slice.identity,slice.sliceId,slice.content)}\n\nRECOVERY: Correct only this exact source-tagged contribution JSON.`;return structuredSidecarOptions({prompt,systemPrompt:'Return corrected merge contribution JSON only.',maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:value=>validateMergeContributionRefPayload(value,contractSlice),telemetry:{nexusMerge:true,phase:'slice-recovery',sourceTag:slice.sourceTag,sliceId:slice.sliceId}});},
    });
    for(const outcome of sliceBatch.completed)recordNexusTransactionSlice(transactionId,{sliceId:outcome.unit.item.sliceId,recovered:outcome.recovered===true,details:{jobId:outcome.jobId||null}});
    if(sliceBatch.failed.length){for(const outcome of sliceBatch.failed)recordNexusTransactionSlice(transactionId,{sliceId:outcome.unit.item.sliceId,failed:true});throw new Error(sliceBatch.failed[0]?.error?.message||'Merge source slice failed after bounded recovery.');}

    let contributionsA=sliceBatch.completed.filter(outcome=>outcome.value.sourceTag==='A').map(outcome=>outcome.value),contributionsB=sliceBatch.completed.filter(outcome=>outcome.value.sourceTag==='B').map(outcome=>outcome.value);
    markNexusTransactionAggregating(transactionId,{phase:'merge-final',sourceASlices:contributionsA.length,sourceBSlices:contributionsB.length});
    contributionsA=await reduceMergeContributions({identity:identityA,contributions:contributionsA,peerContributions:contributionsB,identityA,identityB,titleA,titleB,profile:draftProfile.id,packing,transactionId,signal});
    contributionsB=await reduceMergeContributions({identity:identityB,contributions:contributionsB,peerContributions:contributionsA,identityA,identityB,titleA,titleB,profile:draftProfile.id,packing,transactionId,signal});

    const finalContext=finalMergeContext({identityA,identityB,titleA,titleB,contributionsA,contributionsB,profile:draftProfile.id});
    const contract={...baseContract,allowedSourceAContributions:finalContext.sourceAContributions,allowedSourceBContributions:finalContext.sourceBContributions},prompt=finalContext.prompt,finalRefValidator=finalRequestValidator(finalContext,contract);
    assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,'Merge final aggregation');
    const finalBatch=await runMergeModelWorkerBatch({
        scopeKind:'independent',signal,domain:NEXUS_BATCH_DOMAIN.MERGE,stage:BUS_STAGE.MAINTENANCE,items:[{contract}],requestedBatch:false,
        buildRequest:()=>structuredSidecarOptions({prompt,systemPrompt,maxTokens:draftProfile.softOutputTokens,responseLength:MERGE_FINAL_PHYSICAL_RESPONSE_MAX,priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:finalRefValidator,telemetry:{nexusMerge:true,phase:'final-aggregation'}}),
        validate:value=>{const semantic=validateMergeFinalPayload(value,contract);if(!semantic.valid)return semantic.reason;return validateMergeDraft(value);},
        buildRecovery:()=>structuredSidecarOptions({prompt:`${prompt}\n\nRECOVERY: Return corrected sourceARefs/sourceBRefs and complete merged content. Preserve all grounded canon required by the selected draft profile. Nexus binds persistent source identity locally; do not return UIDs or hashes.`,systemPrompt,maxTokens:draftProfile.softOutputTokens,responseLength:MERGE_FINAL_PHYSICAL_RESPONSE_MAX,priority:BUS_PRIORITY.MAINTENANCE,structuredValidator:finalRefValidator,telemetry:{nexusMerge:true,phase:'final-aggregation-recovery'}}),
    });
    const outcome=finalBatch.completed[0];if(!outcome)throw new Error(finalBatch.failed[0]?.error?.message||'Merge final aggregation failed after bounded recovery.');
    return {draft:outcome.value,identityA,identityB,profile:draftProfile.id,reshapeUsed:true,slot:outcome.response?.tv2?.slot||null,jobId:outcome.jobId||null};
}
