import { loadBook } from '../lore/store.js';
import { getTree } from './store.js';
import { clone, findNode, semanticSnapshot } from './model.js';
import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { enqueueNexusModelWorkerJob, dispatchNexusModelWorkerUnits } from '../nexus/model-worker-bus.js';
import { NEXUS_BATCH_DOMAIN, runNexusModelWorkerBatch } from '../nexus/batch-layer.js';
import { runTreeSummaryThroughDirector } from './summary-execution.js';
import { logEvent } from '../observability/telemetry.js';
import { estimateContentTokens } from '../observability/token-estimator.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import {
    createTreeSummaryRefContract,
    validateTreeSummaryRefPayload,
    mapTreeSummaryRefsToNodeIds,
    settleTreeSummaryBatches,
    partitionTreeSummaryDependencies,
    combineTreeSummaryRecoveryResults,
} from './summary-contract.js';
import { createTreeSummarySourceSnapshot, assertTreeSummarySourceFresh, compactTreeSummaryFingerprint, treeSummarySourceKey } from './summary-source.js';
import { isIntentionalCancellation } from '../core/cancellation.js';
import { assertReadableBook, assertWritableBook } from '../lore/policy.js';
import { buildTreeSummaryCommitAssumptions, stageTreeSummaryCommitTransaction } from './summary-transaction.js';
import { commitCanonicalNexusMutation } from '../nexus/mutation-coordinator.js';

function entriesMap(data){const out=new Map();for(const entry of Object.values(data?.entries||{})){const uid=Number(entry?.uid);if(Number.isFinite(uid))out.set(uid,entry);}return out;}
function titleOf(entry,uid){return String(entry?.comment||entry?.key?.[0]||`UID ${uid}`);}
function semanticError(message,details={}){const error=new Error(message);error.name='NexusSemanticValidationError';error.semantic=true;error.validation=details;return error;}
function depthRows(root){const rows=[];const walk=(node,depth)=>{rows.push({node,depth});for(const child of node.children||[])walk(child,depth+1);};walk(root,0);return rows;}
function directEntryText(node,lookup){const parts=[];for(const uid of node.entryUids||[]){const e=lookup.get(Number(uid));if(!e||e.disable===true)continue;parts.push(`[UID ${uid}] ${titleOf(e,uid)}\n${String(e.content||'').trim()}`);}return parts.join('\n\n');}
function nodeContext(node,lookup,ref=''){const direct=directEntryText(node,lookup);const children=(node.children||[]).map(child=>`- ${child.label}${child.summary?`: ${child.summary}`:''}`).join('\n');return [`NODE: ${node.label}`,ref?`SUMMARY REF: ${ref}`:'',direct?`DIRECT LORE ENTRIES\n${direct}`:'',children?`CHILD NODES\n${children}`:''].filter(Boolean).join('\n\n');}

function semanticTreeKey(tree){return JSON.stringify(semanticSnapshot(tree));}
function staleTreeError(book){const error=new Error(`Tree "${book}" changed while summaries were being generated. No stale summary snapshot was written.`);error.name='TV2TreeSummaryStale';return error;}
function isSummaryGlobalAbort(error){return isIntentionalCancellation(error)||error?.name==='TV2TreeSummaryStale'||error?.name==='TV2TreeSummarySourceStale';}

async function commitSummaryUpdates(book,expectedTree,updates,expectedSource){
    if(!updates?.length)return expectedTree;
    const current=getTree(book);if(!current)throw staleTreeError(book);
    if(semanticTreeKey(current)!==semanticTreeKey(expectedTree))throw staleTreeError(book);
    const currentData=await loadBook(book);
    const currentSource=createTreeSummarySourceSnapshot(current,currentData);
    const nodeIds=updates.map(([nodeId])=>String(nodeId));
    assertTreeSummarySourceFresh(expectedSource,currentSource,nodeIds);
    const effectiveUpdates=[];
    for(const [nodeId,summary] of updates){
        const target=findNode(current.root,nodeId);if(!target)throw staleTreeError(book);
        const nextSummary=String(summary||'').trim();if(!nextSummary)throw new Error(`Tree summary update for ${nodeId} is empty.`);
        if(String(target.summary||'').trim()!==nextSummary)effectiveUpdates.push([String(nodeId),nextSummary]);
    }
    if(!effectiveUpdates.length)return current;

    const staged=stageTreeSummaryCommitTransaction({book,tree:current,sourceSnapshot:currentSource,updates:effectiveUpdates,metadata:{nodeCount:effectiveUpdates.length}});
    const next=clone(current);
    for(const [nodeId,summary] of effectiveUpdates){const target=findNode(next.root,nodeId);if(!target)throw staleTreeError(book);target.summary=summary;}
    const mutation={type:'tree.replace',book,tree:next,expectedTree:semanticSnapshot(current),loreDependency:true,mutationKind:'summary-only'};
    let admitted=null;
    const readAdmittedSource=async()=>{
        const lockedTree=getTree(book);if(!lockedTree||semanticTreeKey(lockedTree)!==semanticTreeKey(current))throw staleTreeError(book);
        const lockedData=await loadBook(book);
        const lockedSource=createTreeSummarySourceSnapshot(lockedTree,lockedData);
        assertTreeSummarySourceFresh(currentSource,lockedSource,effectiveUpdates.map(([nodeId])=>nodeId));
        admitted={tree:lockedTree,source:lockedSource};
        return admitted;
    };
    const preflight=async()=>{await readAdmittedSource();};
    const currentAssumptions=async()=>{
        const live=admitted||await readAdmittedSource();
        return buildTreeSummaryCommitAssumptions({book,tree:live.tree,sourceSnapshot:live.source,nodeIds:effectiveUpdates.map(([nodeId])=>nodeId)});
    };
    const committed=await commitCanonicalNexusMutation(staged.id,mutation,{
        currentAssumptions,
        preflight,
        metadata:{source:'tree-summary',nodeCount:effectiveUpdates.length},
        committed:result=>({book,nodeIds:effectiveUpdates.map(([nodeId])=>nodeId),tree:clone(result?.tree||next)}),
    });
    if(committed?.state==='stale')throw staleTreeError(book);
    return clone(committed?.committed?.tree||getTree(book)||next);
}

function packSummaryBatches(rows,lookup,{maxNodes=10,targetInputTokens=24000,model=''}={}){const batches=[];let current=[];const flush=()=>{if(current.length)batches.push(current),current=[];};for(const row of rows){const candidate=[...current,row],contract=createTreeSummaryRefContract(candidate);const estimated=estimateContentTokens(candidate.map(({node},index)=>nodeContext(node,lookup,contract.refs[index]?.ref)).join('\n\n---\n\n'),model);if(current.length&&(candidate.length>maxNodes||estimated>targetInputTokens)){flush();current=[row];}else current=candidate;}flush();return batches;}

function requestedIds(batch){return batch.map(({node})=>String(node.id));}
function summaryRequest(book,batch,lookup,sourceSnapshot,{label='Tree node summaries',semanticRecovery=false,signal=null}={}){
    const contract=createTreeSummaryRefContract(batch);
    const recovery=semanticRecovery?'\n\nSEMANTIC RECOVERY\nA prior result failed the exact requested-ref contract. Recompute from the supplied lore. Do not copy or repair the invalid result. Return one fresh exact payload.':'';
    const prompt=`Nexus TREE SUMMARY GENERATION\n\nYou are writing navigation summaries for a lorebook Tree. These summaries help later Nexus retrieval decide which nodes to inspect without reading the whole lorebook.\n\nRules:\n- Write 1-2 concise sentences per node describing the durable topics/information it contains.\n- Preserve specific domain nouns, character names, locations, systems, arcs, or dates when they materially define the node.\n- Do NOT generate activation keywords, keyword lists, tags, or vague filler.\n- Do NOT invent facts not present in the supplied entries/child summaries.\n- Each supplied node has a short local SUMMARY REF (N1, N2, ...). Return exactly one summary for every Required summary ref, no extras and no duplicates.\n- Do NOT return or invent internal Tree node IDs. Nexus maps summary refs back to internal nodes locally.\n- Return one JSON object with a summaries array. Each array item must contain ref and summary. Do not include examples, analysis, markdown, or prose outside that JSON object.\n\nLOREBOOK: ${book}\n\n${batch.map(({node},index)=>nodeContext(node,lookup,contract.refs[index]?.ref)).join('\n\n---\n\n')}\n\nRequired summary refs: ${contract.refs.map(row=>row.ref).join(', ')}${recovery}`;
    const structuredValidator=value=>validateTreeSummaryRefPayload(value,contract);
    const requestFingerprint=compactTreeSummaryFingerprint({prompt,source:treeSummarySourceKey(sourceSnapshot,requestedIds(batch))});
    return {
        label,priority:BUS_PRIORITY.MAINTENANCE,scopeKind:'independent',
        dedupKey:semanticRecovery?null:`tree-summary:${book}:${requestFingerprint}`,
        systemPrompt:'You are Nexus Tree summary generation. Return only the final JSON object; do not expose analysis.',
        reasoningEffort:'auto',excludeReasoning:true,responseFormat:'json_object',structuredValidator,
        synthesisCandidateParser:text=>parseStructuredJsonCandidate(text,{validator:structuredValidator,label:'Tree summary Model Worker'}),
        telemetry:{treeSummary:true,requestedNodeIds:requestedIds(batch),summaryRefs:contract.refs.map(row=>row.ref),sourceFingerprint:treeSummarySourceKey(sourceSnapshot,requestedIds(batch)),semanticRecovery},
        prompt,signal,
    };
}
function summaryOutput(result,batch){
    const finish=String(result?.finishReason||'').toLowerCase();
    if(['length','max_tokens','max_output_tokens'].includes(finish))throw semanticError('Tree summary Model Worker was truncated before semantic validation.',{finishReason:result?.finishReason,requestedNodeIds:requestedIds(batch)});
    const contract=createTreeSummaryRefContract(batch),validator=value=>validateTreeSummaryRefPayload(value,contract);
    const parsed=result?.structuredPayload??parseStructuredJsonCandidate(result?.text||'',{validator,label:'Tree summary Model Worker'});
    const verdict=validator(parsed);
    if(!verdict.valid)throw semanticError(verdict.reason||'Tree summary failed exact requested-ref validation.',verdict);
    return {summaries:mapTreeSummaryRefsToNodeIds(verdict.value||parsed,contract),parsed:verdict.value||parsed,slot:result?.tv2?.slot||null,jobId:result?.tv2?.jobId||null};
}
async function summarizeBatch(book,batch,lookup,sourceSnapshot,options={}){
    const request=summaryRequest(book,batch,lookup,sourceSnapshot,options);
    const directed=await runTreeSummaryThroughDirector(async()=>{
        const job=enqueueNexusModelWorkerJob(NEXUS_BATCH_DOMAIN.TREE,BUS_STAGE.TREE_BUILD,{...request,mainEligible:true});
        const result=await job.promise;
        const output=summaryOutput(result,batch);output.jobId=job?.id||output.jobId||null;return output;
    },{label:request.label||'Tree Summary',priority:BUS_PRIORITY.MAINTENANCE,signal:options.signal||null,metadata:{book,nodeIds:requestedIds(batch),modelWorker:true}});
    return directed.output;
}

async function semanticRecovery(book,batch,lookup,sourceSnapshot,options,error){
    logEvent('tree','summary-semantic-recovery',{book,batchSize:batch.length,nodeIds:requestedIds(batch),error,attemptLimit:1},'warn');
    return summarizeBatch(book,batch,lookup,sourceSnapshot,{...options,semanticRecovery:true,label:`${options.label||'Tree summary'} · semantic recovery`});
}

function recoverySuccess(outputs=[]){return {outputs:[...outputs],failed:[]};}
function recoveryFailure(batch,error){return {outputs:[],failed:[{batch,error}]};}

async function summarizeBatchWithRecovery(book,batch,lookup,sourceSnapshot,options={}){
    try{return recoverySuccess([await summarizeBatch(book,batch,lookup,sourceSnapshot,options)]);}
    catch(error){
        if(isSummaryGlobalAbort(error))throw error;
        if(error?.semantic===true||error?.name==='NexusSemanticValidationError'){
            try{return recoverySuccess([await semanticRecovery(book,batch,lookup,sourceSnapshot,options,error)]);}
            catch(recoveryError){if(isSummaryGlobalAbort(recoveryError))throw recoveryError;return recoveryFailure(batch,recoveryError);}
        }
        if(batch.length<2)return recoveryFailure(batch,error);
        const midpoint=Math.ceil(batch.length/2);
        logEvent('tree','summary-batch-split-retry',{book,batchSize:batch.length,left:midpoint,right:batch.length-midpoint,error},'warn');
        const left=await summarizeBatchWithRecovery(book,batch.slice(0,midpoint),lookup,sourceSnapshot,{...options,label:`${options.label||'Tree summary'} · recovery A`});
        const right=await summarizeBatchWithRecovery(book,batch.slice(midpoint),lookup,sourceSnapshot,{...options,label:`${options.label||'Tree summary'} · recovery B`});
        return combineTreeSummaryRecoveryResults(left,right);
    }
}

async function summarizeDepthBatches(book,batches,lookup,sourceSnapshot,{scopeLabel,depth,signal=null}={}){
    const labels=batches.map((batch,index)=>`Summarize ${scopeLabel} · depth ${depth} · batch ${index+1}/${batches.length} · ${batch.length} node${batch.length===1?'':'s'}`);
    if(batches.length===1)return [await summarizeBatchWithRecovery(book,batches[0],lookup,sourceSnapshot,{label:labels[0],signal})];
    let dispatched;
    try{
        const directed=await runTreeSummaryThroughDirector(()=>runNexusModelWorkerBatch({
            domain:NEXUS_BATCH_DOMAIN.TREE,stage:BUS_STAGE.TREE_BUILD,items:batches,requestedBatch:true,allowPartial:true,scopeKind:'independent',signal,
            label:`Summarize ${scopeLabel} · depth ${depth} · ${batches.length} Model Worker batches`,priority:BUS_PRIORITY.MAINTENANCE,role:'treeBuild',
            dedupKey:`tree-summary-depth:${book}:${scopeLabel}:${depth}:${treeSummarySourceKey(sourceSnapshot,batches.flatMap(requestedIds))}`,
            buildRequest:(batch,{index=0}={})=>({...summaryRequest(book,batch,lookup,sourceSnapshot,{label:labels[index]||`Tree summary batch ${index+1}`,signal}),mainEligible:true}),
            parse:(_text,batch,response)=>summaryOutput(response,batch),validate:()=>true,
            buildRecovery:(batch,outcome,{attempt=1}={})=>({...summaryRequest(book,batch,lookup,sourceSnapshot,{label:`Tree summary semantic recovery ${attempt}`,signal,semanticRecovery:true}),mainEligible:true,telemetry:{treeSummary:true,semanticRecovery:true,recoveryReason:outcome?.error?.message||null}}),
            dispatchUnits:input=>dispatchNexusModelWorkerUnits(input),
        }),{label:`Tree Summary · ${scopeLabel} · depth ${depth}`,priority:BUS_PRIORITY.MAINTENANCE,signal,metadata:{book,scopeLabel,depth,batchCount:batches.length,modelWorker:true}});
        dispatched=directed.output;
    }catch(error){
        if(isSummaryGlobalAbort(error))throw error;
        logEvent('tree','summary-batch-scatter-failed',{book,scopeLabel,depth,batchCount:batches.length,error},'warn');
        return settleTreeSummaryBatches(batches,(batch,index)=>summarizeBatchWithRecovery(book,batch,lookup,sourceSnapshot,{label:`${labels[index]} · sequential recovery`,signal}),{isGlobalAbort:isSummaryGlobalAbort});
    }
    const completed=new Map((dispatched?.completed||[]).map(row=>[Number(row?.unit?.index),row]));
    const failed=new Map((dispatched?.failed||[]).map(row=>[Number(row?.unit?.index),row]));
    return settleTreeSummaryBatches(batches,async(batch,index)=>{
        const row=completed.get(index);
        try{
            if(!row)throw failed.get(index)?.error||new Error('Tree summary batch returned no result.');
            return recoverySuccess([row.value]);
        }catch(error){
            if(isSummaryGlobalAbort(error))throw error;
            logEvent('tree','summary-batch-result-recovery',{book,scopeLabel,depth,batchIndex:index+1,batchSize:batch.length,error,semantic:error?.semantic===true},'warn');
            return summarizeBatchWithRecovery(book,batch,lookup,sourceSnapshot,{label:`${labels[index]} · result recovery`,signal});
        }
    },{isGlobalAbort:isSummaryGlobalAbort});
}

export async function generateNodeSummary(book,nodeId,{signal=null}={}){
    assertReadableBook(book);assertWritableBook(book);
    const tree=getTree(book);if(!tree)throw new Error(`No Tree exists for "${book}".`);
    const node=findNode(tree.root,nodeId);if(!node)throw new Error(`Tree node ${nodeId} not found.`);
    const data=await loadBook(book),lookup=entriesMap(data),sourceSnapshot=createTreeSummarySourceSnapshot(tree,data);
    const result=await summarizeBatchWithRecovery(book,[{node}],lookup,sourceSnapshot,{label:`Summarize Tree node · ${node.label}`,signal});
    if(result.failed.length)throw result.failed[0].error;
    const out=result.outputs[0],summary=out?.summaries?.get(String(node.id));if(!summary)throw new Error('Model Worker did not return a summary for the selected node.');
    await commitSummaryUpdates(book,tree,[[node.id,summary]],sourceSnapshot);
    logEvent('tree','node-summary-generated',{book,nodeId:node.id,nodeLabel:node.label,summary,slot:out.slot,jobId:out.jobId},'info');
    return {summary,nodeId:node.id,nodeLabel:node.label,slot:out.slot};
}

export async function generateSummariesForSubtree(book,nodeId,{onlyMissing=false,targetNodeIds=null,onProgress=null,maxNodesPerBatch=10,targetInputTokens=24000,signal=null}={}){
    assertReadableBook(book);assertWritableBook(book);
    const tree=getTree(book);if(!tree)throw new Error(`No Tree exists for "${book}".`);
    const data=await loadBook(book),lookup=entriesMap(data),sourceSnapshot=createTreeSummarySourceSnapshot(tree,data),copy=clone(tree),scope=findNode(copy.root,nodeId)||copy.root;
    const rows=depthRows(scope),depths=[...new Set(rows.map(r=>r.depth))].sort((a,b)=>b-a);
    const explicitTargets=Array.isArray(targetNodeIds)&&targetNodeIds.length?new Set(targetNodeIds.map(String)):null;
    const eligible=rows.filter(({node})=>explicitTargets?explicitTargets.has(String(node.id)):(!onlyMissing||!String(node.summary||'').trim()));
    const eligibleIds=new Set(eligible.map(({node})=>String(node.id))),succeededIds=new Set(),failed=[],blocked=[],pendingUpdates=new Map();
    let done=0;
    for(const depth of depths){
        const candidates=rows.filter(r=>r.depth===depth&&eligibleIds.has(String(r.node.id)));
        const dependency=partitionTreeSummaryDependencies(candidates,{eligibleIds,succeededIds});
        for(const item of dependency.blocked){
            const node=item.row.node;
            blocked.push({nodeId:node.id,nodeLabel:node.label,blockedBy:item.blockedBy,error:'Dependent child summary was not refreshed successfully in this run.'});
            logEvent('tree','summary-node-blocked',{book,scopeNodeId:scope.id,depth,nodeId:node.id,nodeLabel:node.label,blockedBy:item.blockedBy},'warn');
        }
        const layer=dependency.ready;
        const batches=packSummaryBatches(layer,lookup,{maxNodes:Math.max(1,Math.min(10,Number(maxNodesPerBatch)||10)),targetInputTokens});
        let depthOutputs=[];
        try{depthOutputs=await summarizeDepthBatches(book,batches,lookup,sourceSnapshot,{scopeLabel:scope.label,depth,signal});}
        catch(error){if(isSummaryGlobalAbort(error))throw error;depthOutputs=batches.map(batch=>recoveryFailure(batch,error));}
        for(let i=0;i<batches.length;i++){
            const batch=batches[i],result=depthOutputs[i];
            if(result?.error){
                failed.push(...batch.map(({node})=>({nodeId:node.id,nodeLabel:node.label,error:result.error?.message||String(result.error)})));
                logEvent('tree','summary-batch-failed',{book,scopeNodeId:scope.id,depth,batchSize:batch.length,error:result.error},'error');
                continue;
            }
            for(const segment of result?.failed||[]){
                const segmentBatch=segment.batch||[];
                failed.push(...segmentBatch.map(({node})=>({nodeId:node.id,nodeLabel:node.label,error:segment.error?.message||String(segment.error)})));
                logEvent('tree','summary-batch-failed',{book,scopeNodeId:scope.id,depth,batchSize:segmentBatch.length,error:segment.error},'error');
            }
            for(const out of result?.outputs||[]){
                for(const [updatedNodeId,summary] of out.summaries||[]){
                    const updated=findNode(copy.root,updatedNodeId);if(!updated)continue;
                    updated.summary=summary;pendingUpdates.set(String(updatedNodeId),summary);succeededIds.add(String(updatedNodeId));done++;
                    onProgress?.({done,total:eligible.length,nodeId:updatedNodeId,nodeLabel:updated.label||'',depth,scopeNodeId:scope.id});
                }
            }
        }
    }
    if(pendingUpdates.size)await commitSummaryUpdates(book,tree,[...pendingUpdates.entries()],sourceSnapshot);
    const resumeNodeIds=[...new Set([...failed.map(row=>String(row.nodeId)),...blocked.map(row=>String(row.nodeId))])];
    logEvent('tree','tree-summaries-generated',{book,scopeNodeId:scope.id,scopeLabel:scope.label,onlyMissing,targeted:!!explicitTargets,total:eligible.length,processed:done,failedCount:failed.length,blockedCount:blocked.length,resumeCount:resumeNodeIds.length},failed.length||blocked.length?'warn':'info');
    return {book,scopeNodeId:scope.id,scopeLabel:scope.label,total:eligible.length,processed:done,failed,blocked,resumeNodeIds,canResume:resumeNodeIds.length>0};
}

export async function generateSummariesForTree(book,options={}){return generateSummariesForSubtree(book,null,options);}
