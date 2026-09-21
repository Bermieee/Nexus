import { builderNavigationBrief } from './navigation-policy.js';
import {
    NEXUS_CALL_DIRECTION,
    NEXUS_CALL_TARGET,
    createCallTicket,
} from '../nexus/contracts.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import { normalizePlacementPayload } from './validation.js';
import { currentNexusChatEpoch } from '../nexus/work-scope.js';
import { createBuilderNodeRefContract, builderNodeIndexForPrompt, normalizePlacementPayloadWithNodeRefs, validateBuilderPlacementMode } from './node-ref-contract.js';

function promptForJob(job,{mode,lorebookInventory,nodeContract,navigationBrief,semanticRecovery=false}){
    const byRef=new Map(lorebookInventory.activeEntries.map(entry=>[entry.ref,entry]));
    const contentByRef=new Map((lorebookInventory._sourceEntries||[]).map(row=>[row.ref,row.content]));
    const entries=(job.metadata?.refs||[]).map(ref=>{
        const entry=byRef.get(ref);
        if(!entry)throw new Error(`Lorebook Builder Main job ${job.type} references unknown ${ref}.`);
        return {ref,title:entry.title,keys:entry.keys,content:contentByRef.get(ref)||''};
    });
    const existing=mode==='full'?[]:builderNodeIndexForPrompt(nodeContract);
    const recovery=semanticRecovery?'\n\nSEMANTIC RECOVERY\nA prior result violated the exact REF/node-ref contract. Recompute from the supplied entries and Tree index. Do not copy the invalid result.':'';
    return [
        `MODE: ${mode}`,
        navigationBrief,
        'AUTHORITATIVE ENTRY REFS:',
        JSON.stringify(entries,null,2),
        existing.length?`EXISTING TREE INDEX:\n${JSON.stringify(existing,null,2)}`:'',
        'Return exactly one placement for every supplied REF and no others.',
        mode==='full'
            ? 'FULL mode has no existing-node authority. existingNodeId MUST be null; return a path below Root for every placement.'
            : 'Existing Tree nodes are identified only by short local nodeRef values (T1, T2, ...). Use existingNodeId only with an exact supplied T# nodeRef when an existing node is appropriate; otherwise return path labels from Root downward.',
        'Never return or invent internal tv2_node_* Tree IDs. Nexus maps any legal T# refs back to internal nodes locally.',
        'Never invent, copy, infer, or return SillyTavern UIDs. REF is the only lore-entry identity allowed in output.',
        mode==='full'
            ? 'Return JSON only: {"placements":[{"ref":"R1","action":"create_and_attach","existingNodeId":null,"path":["Characters","Name"],"reasoning":"brief","confidence":0.9}]}'
            : 'Return JSON only: {"placements":[{"ref":"R1","action":"attach","existingNodeId":"T1","path":[],"reasoning":"brief","confidence":0.9}]}',
    ].filter(Boolean).join('\n\n')+recovery;
}

function resultText(value){
    if(typeof value==='string')return value;
    if(typeof value?.text==='string')return value.text;
    if(typeof value?.content==='string')return value.content;
    return JSON.stringify(value??'');
}

function validateSliceCoverage(normalized,refs,jobType,mode){
    normalized=validateBuilderPlacementMode(normalized,mode);
    const expected=new Set(refs),got=normalized.placements.map(row=>row.ref);
    if(got.length!==expected.size||new Set(got).size!==got.length||got.some(ref=>!expected.has(ref))){
        throw new Error(`Lorebook Builder Main job ${jobType} must return every legal REF exactly once and no others.`);
    }
    return normalized;
}

/** Main-model Builder semantic executor. Main remains outside the Sidecar pool. */
export class MainLorebookBuilderExecutor{
    constructor({runtimeProvider,responseLength=4096}={}){
        if(typeof runtimeProvider!=='function')throw new Error('Main Lorebook Builder executor requires runtimeProvider().');
        this.runtimeProvider=runtimeProvider;
        this.responseLength=Math.max(512,Math.floor(Number(responseLength)||4096));
    }

    async execute({request,mode,buildPlan,lorebookInventory,treeInventory,signal=null}={}){
        const runtime=this.runtimeProvider();
        if(!runtime?.callCenter||!runtime?.generationGateway)throw new Error('Nexus Main boundary runtime is unavailable.');
        if(!runtime.generationGateway.isConnected())throw new Error('Main/ST Generation Gateway is not connected for Lorebook Builder.');
        const navigationBrief=builderNavigationBrief({lorebookInventory,treeInventory,mode});
        const placements=[],nodeContract=createBuilderNodeRefContract(mode==='full'?{nodes:[]}:treeInventory);
        const jobs=(buildPlan.jobs||[]).filter(job=>job.metadata?.builder===true&&job.metadata?.semanticResource==='main'&&Array.isArray(job.metadata?.refs));

        const runJob=async(job,{semanticRecovery=false}={})=>{
            const refs=job.metadata?.refs||[];
            const ticket=createCallTicket({
                direction:NEXUS_CALL_DIRECTION.NEXUS_TO_MAIN,
                source:'lorebook-builder',capability:'lorebook-builder',preferredTarget:NEXUS_CALL_TARGET.ST_MAIN,
                automatic:request?.metadata?.automatic===true,correlationId:request.id,
                arguments:{
                    systemPrompt:semanticRecovery?'You are Nexus Lorebook Builder recovery. Return exact structured JSON only.':'You are Nexus Lorebook Builder semantic placement. Return exact structured JSON only.',
                    prompt:promptForJob(job,{mode,lorebookInventory,nodeContract,navigationBrief,semanticRecovery}),
                },
                contextPolicy:{mode:'minimal'},
                responsePolicy:{mode:'return-draft-only',responseLength:this.responseLength,trimNames:false},
                metadata:{builderRunId:request.id,builderMode:mode,builderJobId:job.id||job.type,nexusPlanId:buildPlan?.id||job?.planId||null,nexusDirectorJobId:job.id||null,nexusDirectorJobType:job.type||null,semanticResource:'main',semanticRecovery,actor:'nexus-builder',nexusChatEpoch:currentNexusChatEpoch(),chatBound:true},
            });
            const boundary=await runtime.callCenter.dispatch(ticket,{
                approved:true,
                logic:{targetHealth:runtime.generationGateway.isConnected()?'healthy':'unhealthy'},
                signal,
                timeoutMs:Math.max(1000,Math.min(300000,Number(request?.metadata?.mainTimeoutMs)||120000)),
            });
            if(signal?.aborted)throw new DOMException('Lorebook Builder Main analysis cancelled.','AbortError');
            if(boundary.state!=='completed'){
                const error=new Error(`Lorebook Builder Main boundary ${boundary.state}: ${boundary.error||boundary.decision?.reason||boundary.gate?.reason||'request did not complete'}`);
                error.name=boundary.state==='deferred'?'TV2BuilderAdmissionDeferred':'TV2BuilderBoundaryFailure';
                error.deferred=boundary.state==='deferred'||boundary.state==='blocked';
                error.boundaryState=boundary.state;
                throw error;
            }
            try{
                const parsed=parseStructuredJsonCandidate(resultText(boundary.result),{
                    validator:value=>{
                        try{return {valid:true,score:100,value:validateBuilderPlacementMode(normalizePlacementPayloadWithNodeRefs(value,nodeContract),mode)};}
                        catch(error){return {valid:false,score:0,reason:error?.message||String(error)};}
                    },
                    label:'Lorebook Builder Main placement',
                });
                return validateSliceCoverage(normalizePlacementPayload(parsed),refs,job.type,mode);
            }catch(cause){
                const error=new Error(cause?.message||String(cause));error.name='NexusSemanticValidationError';error.semantic=true;error.cause=cause;throw error;
            }
        };

        for(const job of jobs){
            if(signal?.aborted)throw new DOMException('Lorebook Builder Main analysis cancelled.','AbortError');
            let normalized;
            try{normalized=await runJob(job);}
            catch(error){
                if(signal?.aborted||error?.name==='AbortError'||error?.name==='TV2BatchCancelled'||error?.name==='TV2WorkStale'||error?.semantic!==true)throw error;
                normalized=await runJob(job,{semanticRecovery:true});
            }
            placements.push(...normalized.placements);
        }
        return {placements};
    }
}
