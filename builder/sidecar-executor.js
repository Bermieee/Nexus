import { builderNavigationBrief } from './navigation-policy.js';
import { NEXUS_BATCH_DOMAIN, runNexusSidecarBatch } from '../nexus/batch-layer.js';
import { BUS_STAGE } from '../sidecar/bus.js';
import { logEvent } from '../observability/telemetry.js';
import { createBuilderNodeRefContract, builderNodeIndexForPrompt, normalizePlacementPayloadWithNodeRefs, validateBuilderPlacementMode } from './node-ref-contract.js';
import { normalizePlacementPayload } from './validation.js';

function requiredPositivePlanInteger(label,value,min=1){
    const parsed=Number(value);
    if(!Number.isFinite(parsed)||parsed<min)throw new Error(`Lorebook Builder plan is missing valid ${label}.`);
    return Math.floor(parsed);
}

function builderSliceTimeoutMs(item,batchConfig,{recovery=false}={}){
    const refs=Math.max(1,Array.isArray(item?.refs)?item.refs.length:1);
    const semanticTarget=Math.max(1000,Number(batchConfig?.semanticInputTargetTokens)||1000);
    // Ordinary Builder work keeps the historical 120s profile. Recognized large
    // slices receive bounded headroom derived from planner size; a hard 5m cap
    // still terminates genuine hangs and recovery gets only modest extra room.
    const sizeFactor=Math.max(refs/4,semanticTarget/12000,1);
    const extra=Math.min(150000,Math.round((sizeFactor-1)*45000));
    return Math.min(300000,120000+extra+(recovery?15000:0));
}

function requestPrompt(item,{mode,nodeContract,navigationBrief,semanticRecovery=false}){
    const existing=mode==='full'?[]:builderNodeIndexForPrompt(nodeContract);
    const recovery=semanticRecovery?'\n\nSEMANTIC RECOVERY\nA prior result violated the exact REF/node-ref contract. Recompute from the supplied entries and Tree index. Do not copy the invalid result.':'';
    return [
        `MODE: ${mode}`,
        navigationBrief,
        'AUTHORITATIVE ENTRY REFS:',
        JSON.stringify(item.entries,null,2),
        existing.length?`EXISTING TREE INDEX:\n${JSON.stringify(existing,null,2)}`:'',
        'Return one placement for every supplied REF and no others.',
        'PLACEMENT CONTRACT:',
        '- action MUST be exactly "attach" or "create_and_attach".',
        mode==='full'
            ? '- FULL mode has no existing-node authority. existingNodeId MUST be null; use a path below Root. The action may be "attach" or "create_and_attach" when the path is the placement target.'
            : '- Existing Tree nodes are identified only by short local nodeRef values (T1, T2, ...). Use "attach" with existingNodeId set to an exact supplied T# nodeRef when the exact existing node is known.',
        '- Use "create_and_attach" with a path when Nexus must create/reuse that path from Root downward.',
        '- Do not include "Root" in path; path begins with the first category below Root.',
        '- Never return or invent internal tv2_node_* Tree IDs. Nexus maps any legal T# refs back to internal nodes locally.',
        'Never invent, copy, or return SillyTavern UIDs. REF is the only lore-entry identity allowed in output.',
        'OUTPUT JSON: {"placements":[{"ref":"R1","action":"create_and_attach","existingNodeId":null,"path":["Characters","Name"],"reasoning":"brief","confidence":0.0}]}',
    ].filter(Boolean).join('\n\n')+recovery;
}

export class SidecarLorebookBuilderExecutor{
    async execute({request,mode,buildPlan,lorebookInventory,treeInventory,signal=null}={}){
        const batchConfig={
            maxEntriesPerJob:requiredPositivePlanInteger('maxEntriesPerSemanticSlice',buildPlan.metadata?.maxEntriesPerSemanticSlice,1),
            semanticInputTargetTokens:requiredPositivePlanInteger('semanticInputTargetTokens',buildPlan.metadata?.semanticInputTargetTokens,1000),
            maxJobsPerWave:requiredPositivePlanInteger('maxJobsPerWave',buildPlan.metadata?.maxJobsPerWave,1),
            waveTargetInputTokens:requiredPositivePlanInteger('waveTargetInputTokens',buildPlan.metadata?.waveTargetInputTokens,1000),
        };
        const navigationBrief=builderNavigationBrief({lorebookInventory,treeInventory,mode});
        const nodeContract=createBuilderNodeRefContract(mode==='full'?{nodes:[]}:treeInventory);
        const semanticJobs=(buildPlan.jobs||[]).filter(job=>job.metadata?.builder===true&&job.metadata?.semanticResource!=='main'&&Array.isArray(job.metadata?.refs));
        const byRef=new Map(lorebookInventory.activeEntries.map(entry=>[entry.ref,entry]));
        const contentByRef=new Map((lorebookInventory._sourceEntries||[]).map(row=>[row.ref,row.content]));
        const items=semanticJobs.map(job=>({
            jobId:job.type,
            refs:job.metadata?.refs||[],
            entries:(job.metadata?.refs||[]).map(ref=>{
                const entry=byRef.get(ref);
                if(!entry)throw new Error(`Lorebook Builder job ${job.type} references unknown ${ref}.`);
                return {ref,title:entry.title,keys:entry.keys,content:contentByRef.get(ref)||''};
            }),
        }));
        if(signal?.aborted)throw new DOMException('Lorebook Builder Sidecar analysis cancelled.','AbortError');
        const bindPlacementPayload=value=>{
            try{return {valid:true,score:100,value:validateBuilderPlacementMode(normalizePlacementPayloadWithNodeRefs(value,nodeContract),mode)};}
            catch(error){return {valid:false,score:0,reason:error?.message||String(error)};}
        };
        const validatePayload=(value,item)=>{
            let normalized;
            try{normalized=validateBuilderPlacementMode(value,mode);}catch(error){return error?.message||String(error);}
            const expected=new Set(item.refs),got=normalized.placements.map(row=>row.ref);
            if(got.length!==expected.size||new Set(got).size!==got.length)return 'Builder slice must return every REF exactly once.';
            if(got.some(ref=>!expected.has(ref)))return 'Builder slice returned a REF outside its legal candidate subset.';
            return true;
        };
        const result=await runNexusSidecarBatch({
            domain:NEXUS_BATCH_DOMAIN.TREE,
            stage:BUS_STAGE.TREE_BUILD,
            items,
            buildRequest:item=>{
                logEvent('builder','provider-request-shape',{runId:request.id,book:request.book,jobId:item.jobId,semanticRefCount:item.refs.length,semanticRefs:[...item.refs],planningConfig:batchConfig},'info');
                return {
                    systemPrompt:'You are Nexus Lorebook Builder semantic placement. Return exact structured JSON only.',
                    prompt:requestPrompt(item,{mode,nodeContract,navigationBrief}),
                    responseFormat:'json_object',temperature:0.2,structuredValidator:bindPlacementPayload,timeoutMs:builderSliceTimeoutMs(item,batchConfig),
                    label:`Lorebook Builder · ${mode} · ${item.jobId}`,
                    telemetry:{builderRunId:request.id,builderMode:mode,builderJobId:item.jobId},
                };
            },
            validate:validatePayload,
            buildRecovery:item=>{
                logEvent('builder','provider-request-shape',{runId:request.id,book:request.book,jobId:item.jobId,semanticRefCount:item.refs.length,semanticRefs:[...item.refs],planningConfig:batchConfig,recovery:true},'info');
                return {
                    systemPrompt:mode==='full'?'You are Nexus Lorebook Builder recovery. Return only the required JSON placements; FULL mode requires existingNodeId=null.':'You are Nexus Lorebook Builder recovery. Return only the required JSON placements for the supplied REFs and legal T# node refs.',
                    prompt:requestPrompt(item,{mode,nodeContract,navigationBrief,semanticRecovery:true}),
                    responseFormat:'json_object',temperature:0.1,structuredValidator:bindPlacementPayload,timeoutMs:builderSliceTimeoutMs(item,batchConfig,{recovery:true}),
                    label:`Lorebook Builder recovery · ${item.jobId}`,
                    telemetry:{builderRunId:request.id,builderMode:mode,builderJobId:item.jobId,recovery:true},
                };
            },
            label:`Lorebook Builder · ${mode}`,priority:18,role:'treeBuild',executionMode:'adaptive',
            allowPartial:true,requestedBatch:items.length>1,
            maxBatchItems:batchConfig.maxJobsPerWave,targetInputTokens:batchConfig.waveTargetInputTokens,
            dedupKey:`lorebook-builder:${request.book}:${request.id}:${items.map(item=>item.jobId).join(',')||'empty'}`,
            telemetry:{builderRunId:request.id,builderMode:mode,book:request.book},
            signal,
            foregroundAdjacent:request?.metadata?.foregroundAdjacent===true||request?.metadata?.foregroundDependency===true,
            generationId:request?.metadata?.foregroundGenerationId||null,
        });
        if(signal?.aborted)throw new DOMException('Lorebook Builder Sidecar analysis cancelled.','AbortError');
        if (result.failed.length) throw new Error(`Lorebook Builder semantic placement failed for ${result.failed.length} slice(s); no Tree proposal was staged.`);
        return {placements:result.completed.flatMap(row=>normalizePlacementPayload(row.value).placements)};
    }
}
