import { createBuildRequest, createLedgerMutationPlan } from '../builder/contracts.js';
import { createMutationProposal } from '../nexus/contracts.js';
import { clone, semanticSnapshot } from '../tree/model.js';
import { lorebookOperatorReviewScope } from '../nexus/review-scope.js';
import { Builder2Pipeline } from './pipeline.js';
import { BUILDER2_PHASE } from './contracts.js';
import { Builder2RunLifetime } from './run-lifetime.js';
import { createNexusBuilder2PlanStore, listNexusBuilder2Plans } from './nexus-plan-store.js';
import {
    assertNexusBuilder2ReviewScope,
    buildNexusBuilder2Workset,
    determineNexusBuilder2Mode,
    inspectNexusBuilder2Authority,
    minimalNexusBuilder2WorksetAuthority,
    readNexusBuilder2CurrentAuthority,
    readNexusBuilder2LiveContext,
} from './nexus-authority.js';
import { materializeBuilder2NexusTree, validateBuilder2NexusMaterialization } from './nexus-materializer.js';
import { createBuilder2NexusCommitAssumptions, commitBuilder2ThroughNexus } from './nexus-commit-adapter.js';

const TERMINAL_PLAN=new Set([BUILDER2_PHASE.COMMITTED,BUILDER2_PHASE.CANCELLED,BUILDER2_PHASE.STALE]);
function clean(v){return String(v??'').trim();}
function required(name,fn){if(typeof fn!=='function')throw new Error(`Builder 2 Nexus controller requires ${name}().`);return fn;}
function requestedSemanticResource(value){
    const resource=clean(value||'auto').toLowerCase();
    return resource==='main'||resource==='sidecar'?resource:'auto';
}
function runReviewKind(phase){return({[BUILDER2_PHASE.TAXONOMY_REVIEW]:'taxonomy-review',[BUILDER2_PHASE.CLASSIFICATION_REVIEW]:'classification-review',[BUILDER2_PHASE.GAP_REVIEW]:'gap-review',[BUILDER2_PHASE.RECONCILIATION]:'reconciliation-review',[BUILDER2_PHASE.QUALITY_REVIEW]:'quality-review',[BUILDER2_PHASE.VALIDATION]:'preview'})[phase]||null;}
function retryableBuilderPreIntentFailure(tx){
    if(clean(tx?.state)!=='failed')return false;
    const rows=Array.isArray(tx?.history)?tx.history:[];
    return rows.some(row=>clean(row?.state)==='failed'&&clean(row?.details?.phase)==='canonical-pre-intent');
}
function abortError(reason='Lorebook Builder 2 cancelled.'){
    if(reason instanceof Error)return reason;
    if(typeof DOMException==='function')return new DOMException(String(reason),'AbortError');
    const e=new Error(String(reason));e.name='AbortError';return e;
}

export function builder2PipelineConfigFromPlanningConfig(planning = null) {
    if (!planning || typeof planning !== 'object') return {};
    const out = {};
    const maxEntries = Number(planning.maxEntriesPerJob);
    if (Number.isFinite(maxEntries) && maxEntries >= 1) {
        const bounded = Math.max(1, Math.min(50, Math.floor(maxEntries)));
        out.surveyMaxEntries = bounded;
        out.classifyMaxEntries = bounded;
    }
    const semanticInputTargetTokens = Number(planning.semanticInputTargetTokens);
    if (Number.isFinite(semanticInputTargetTokens) && semanticInputTargetTokens >= 1000) {
        out.semanticInputTargetTokens = Math.max(1000, Math.min(100000, Math.floor(semanticInputTargetTokens)));
    }
    return out;
}

function operationsForHandoff(handoff={}){
    return [
        ...(handoff.structuralOperations||[]).map(op=>({type:`builder2-${op.op}`,...clone(op)})),
        ...(handoff.uidPlacements||[]).map(row=>({type:'attach-lore-uid',uid:row.uid,nodeId:row.nodeId,sourceKey:row.sourceKey})),
        ...(handoff.sourceRemovals||[]).map(row=>({type:'detach-lore-uid',uid:row.uid,sourceKey:row.sourceKey,reason:row.reason})),
        ...(handoff.sourceExclusions||[]).map(row=>({type:'detach-lore-uid',uid:row.uid,sourceKey:row.sourceKey,reason:row.reason||'operator-nonsemantic'})),
        {type:'update-builder-manifest',book:handoff.book,engine:'builder2'},
    ];
}

/**
 * Product adapter for Builder 2. Semantic phases own only derived BuilderPlan
 * state. Canonical transaction and Tree mutation authority remain in Nexus.
 */
export class NexusBuilder2Controller {
    constructor({
        loadBook,
        getTree,
        assertReadableBook=()=>true,
        assertWritableBook=()=>true,
        runtime,
        commitMutation,
        persistReviewTransaction=null,
        cancelReviewTransactionDurably=null,
        staleReviewTransactionDurably=null,
        logEvent=()=>{},
        planStoreFactory=createNexusBuilder2PlanStore,
        semanticFactory=null,
        resolveSemanticResource=null,
        planningConfigProvider=null,
        pipelineFactory=options=>new Builder2Pipeline(options),
        materialize=materializeBuilder2NexusTree,
        now=()=>Date.now(),
    }={}){
        this.loadBook=required('loadBook',loadBook);this.getTree=required('getTree',getTree);
        this.assertReadableBook=required('assertReadableBook',assertReadableBook);this.assertWritableBook=required('assertWritableBook',assertWritableBook);
        if(!runtime?.director||!runtime?.coordinator||!runtime?.ledger)throw new Error('Builder 2 Nexus controller requires Director, WorkCoordinator, and Transaction Ledger.');
        this.runtime=runtime;this.ledger=runtime.ledger;this.commitMutation=required('commitMutation',commitMutation);
        this.persistReviewTransaction=persistReviewTransaction;this.cancelReviewTransactionDurably=cancelReviewTransactionDurably;this.staleReviewTransactionDurably=staleReviewTransactionDurably;
        this.logEvent=typeof logEvent==='function'?logEvent:()=>{};this.planStoreFactory=planStoreFactory;this.semanticFactory=required('semanticFactory',semanticFactory);this.resolveSemanticResource=required('resolveSemanticResource',resolveSemanticResource);this.planningConfigProvider=typeof planningConfigProvider==='function'?planningConfigProvider:null;this.pipelineFactory=pipelineFactory;this.materialize=materialize;this.now=now;
        this.runs=new Map();
    }

    async inspect(book){
        const name=clean(book);this.assertReadableBook(name);const data=await this.loadBook(name),tree=this.getTree(name);const inspection=inspectNexusBuilder2Authority({book:name,data,tree});
        return {data,tree,inspection,lorebookInventory:{book:name,entryCount:inspection.corpusSources.length,activeCount:inspection.corpusSources.filter(s=>!s.disabled&&!s.removed).length},treeInventory:{...inspection.treeInventory,representedCount:inspection.representedUids.length,unrepresentedCount:inspection.unrepresentedUids.length,changedCount:inspection.changedUids.length,duplicateUidRefs:inspection.duplicateUids.map(uid=>({uid})),orphanedTreeUids:inspection.orphanedTreeUids}};
    }

    #createRun(runId,{externalSignal=null,planningConfig=null}={}){
        const store=this.planStoreFactory();
        const lifetime=new Builder2RunLifetime({externalSignal,onState:event=>this.logEvent('builder2','run-state',{runId,...event},event.state==='failed'?'error':'debug')});
        const adapters={loadBookFn:this.loadBook,getTreeFn:this.getTree};
        const resolvedPlanning=planningConfig||(this.planningConfigProvider?this.planningConfigProvider({semanticResource:'model-worker'}):null);
        const pipelineConfig=builder2PipelineConfigFromPlanningConfig(resolvedPlanning);
        const semantic=this.semanticFactory({
            runtime:this.runtime,
            store,
            runId,
            logEvent:this.logEvent,
            semanticPacking:{
                maxEntries:pipelineConfig.classifyMaxEntries??pipelineConfig.surveyMaxEntries??24,
                targetInputTokens:pipelineConfig.semanticInputTargetTokens??null,
            },
        });
        const pipeline=this.pipelineFactory({
            store,semantic,signal:lifetime.signal,config:pipelineConfig,
            readCurrentAuthority:plan=>readNexusBuilder2CurrentAuthority(plan,adapters),
            contextLoader:plan=>readNexusBuilder2LiveContext(plan,adapters),
        });
        const run={runId,store,lifetime,semantic,pipeline,adapters,planningConfig:resolvedPlanning,pipelineConfig};this.runs.set(runId,run);return run;
    }

    async #runFor(runId,{externalSignal=null}={}){
        const id=clean(runId);if(this.runs.has(id))return this.runs.get(id);
        const run=this.#createRun(id,{externalSignal});const plan=await run.store.read(id);if(!plan){run.lifetime.dispose();this.runs.delete(id);throw new Error(`Unknown Builder 2 run ${id}.`);}return run;
    }

    #findBuilderTransaction(runId){
        const id=clean(runId);
        const rows=(typeof this.ledger.list==='function'?this.ledger.list():[]).filter(row=>row?.type==='lorebook-builder2'&&clean(row?.metadata?.builderRunId||row?.input?.builderRunId)===id);
        if(!rows.length)return null;
        const active=rows.filter(row=>!['committed','stale','aborted','failed','cancelled'].includes(clean(row.state)));
        const pool=active.length?active:rows;
        return pool.sort((a,b)=>Number(b.updatedAt||b.createdAt||0)-Number(a.updatedAt||a.createdAt||0))[0]||null;
    }

    async listResumable(book=null){
        const store=this.planStoreFactory();
        const plans=await listNexusBuilder2Plans(store,{book,includeTerminal:false});
        const filtered=plans.filter(plan=>{const planBook=clean(plan?.book);if(!planBook)return false;const scope=lorebookOperatorReviewScope(planBook);return clean(plan?.metadata?.operatorReviewScope)===clean(scope.identity);});
        return filtered.map(plan=>({
            runId:plan.runId,book:plan.book,mode:plan.mode,phase:plan.phase,planRevision:plan.planRevision,
            updatedAt:plan.updatedAt||plan.createdAt||0,reviewKind:runReviewKind(plan.phase),
            transactionId:this.#findBuilderTransaction(plan.runId)?.id||null,validateOnly:plan.metadata?.validateOnly===true,
            semanticResource:clean(plan?.metadata?.semanticResource||'model-worker').toLowerCase(),
            requestedSemanticResource:requestedSemanticResource(plan?.metadata?.requestMetadata?.semanticResource),
        }));
    }

    async resume(runId,{signal=null}={}){
        const run=await this.#runFor(runId,{externalSignal:signal});
        let plan=await run.store.read(runId);
        assertNexusBuilder2ReviewScope(plan);
        const tx=this.#findBuilderTransaction(runId);
        if(plan.phase===BUILDER2_PHASE.STAGED&&tx){
            if(tx.state==='committed'){
                try{plan=await run.store.transition(runId,BUILDER2_PHASE.COMMITTED,{metadata:{...(plan.metadata||{}),recoveredTransactionId:tx.id}});}catch{}
                run.lifetime.complete(tx);
                return{engine:'builder2',state:'committed',runId,book:plan.book,mode:plan.mode,transactionId:tx.id,preview:clone(tx.staged?.delta||null),mutationProposal:tx.mutationProposal||null,recovered:true};
            }
            if(retryableBuilderPreIntentFailure(tx)){
                // No journal intent and no physical persistence ever existed. The
                // durable Builder STAGED plan is still authoritative, so re-stage
                // it into a fresh Ledger transaction instead of killing millions
                // of tokens of semantic work because local durability was briefly
                // unavailable (for example browser localStorage quota pressure).
                const resumed=await run.pipeline.resume(runId),envelope=resumed?.commitEnvelope||resumed?.plan?.metadata?.commitEnvelope;
                if(!envelope)throw new Error('Recovered Builder 2 pre-intent failure is missing its durable commit envelope.');
                return this.#stagePlanThroughLedger(run,resumed.plan||plan,envelope,{recovered:true});
            }
            if(['stale','failed','aborted','cancelled'].includes(tx.state)){
                const target=tx.state==='cancelled'?BUILDER2_PHASE.CANCELLED:BUILDER2_PHASE.STALE;
                try{plan=await run.store.transition(runId,target,{metadata:{...(plan.metadata||{}),recoveredTransactionId:tx.id,recoveredTransactionState:tx.state}});}catch{}
                if(target===BUILDER2_PHASE.CANCELLED)run.lifetime.cancel(`Recovered Builder 2 review is ${tx.state}.`);else run.lifetime.stale(`Recovered Builder 2 review is ${tx.state}.`);
                return{engine:'builder2',state:tx.state,runId,book:plan.book,mode:plan.mode,transactionId:tx.id,recovered:true};
            }
            return{engine:'builder2',state:tx.state,runId,book:plan.book,mode:plan.mode,transactionId:tx.id,preview:clone(tx.staged?.delta||null),mutationProposal:tx.mutationProposal||null,recovered:true};
        }
        const step=await run.pipeline.resume(runId);
        if(step?.staged===true){
            const envelope=step.commitEnvelope||step.plan?.metadata?.commitEnvelope;
            if(!envelope)throw new Error('Recovered Builder 2 STAGED plan is missing its commit envelope.');
            return this.#stagePlanThroughLedger(run,step.plan,envelope,{recovered:true});
        }
        return this.#normalizeStep(step,run);
    }

    async resumeLatest(book,{signal=null}={}){
        const rows=await this.listResumable(book);
        if(!rows.length)return null;
        return this.resume(rows[0].runId,{signal});
    }

    async #reviewPayload(plan,reviewKind,run){
        if(reviewKind==='taxonomy-review')return{taxonomy:clone(plan.taxonomy),canApprove:true};
        if(reviewKind==='classification-review'){
            const ctx=await readNexusBuilder2LiveContext(plan,run.adapters),byKey=new Map(ctx.worksetSources.map(s=>[s.sourceKey,s])),taxa=new Map((plan.taxonomy?.nodes||[]).map(t=>[t.taxonId,t]));
            const homeByUid=new Map();for(const node of ctx.treeInventory?.nodes||[])for(const uid of node.entryUids||[])if(!homeByUid.has(Number(uid)))homeByUid.set(Number(uid),{nodeId:node.id,label:node.label,path:node.path||[node.label]});
            const pending=(plan.classifications||[]).filter(c=>(plan.classificationReview?.pending||[]).includes(c.sourceKey)).map(c=>{const source=byKey.get(c.sourceKey),home=source?homeByUid.get(Number(source.uid)):null;return{sourceKey:c.sourceKey,uid:source?.uid??null,title:source?.title||c.sourceKey,reason:c.reason,candidates:(c.candidates||[]).map(x=>({...x,label:taxa.get(x.taxonId)?.label||x.taxonId})),currentPlacement:home?clone(home):null,deferredFromPriorRun:c.metadata?.resolvedDisposition==='deferred'};});
            const rows=plan.classifications||[];
            return{pending,taxonomy:(plan.taxonomy?.nodes||[]).filter(t=>t.entryPolicy!=='container-only').map(t=>({taxonId:t.taxonId,label:t.label,parentTaxonId:t.parentTaxonId,purpose:t.purpose})),summary:{worksetCount:ctx.worksetSources.length,autoPlacedCount:rows.filter(c=>c.decision==='classified').length,gapCount:rows.filter(c=>c.decision==='taxonomy_gap').length,reviewCount:pending.length,priorDeferredCount:pending.filter(row=>row.deferredFromPriorRun).length},canApprove:pending.length===0};
        }
        if(reviewKind==='gap-review'){
            const proposals=clone(plan.proposedExpansions||[]),covered=[...new Set(proposals.flatMap(p=>p.evidenceSourceKeys||[]))];
            return{proposals,taxonomy:clone(plan.taxonomy?.nodes||[]),summary:{proposalCount:proposals.length,sourceCount:covered.length,fallbackCount:proposals.filter(p=>p.fallback===true).length},canApprove:proposals.every(p=>!['pending','rejected'].includes(p.status))};
        }
        if(reviewKind==='reconciliation-review')return{reconciliation:clone(plan.reconciliation||{}),canApprove:true};
        if(reviewKind==='quality-review'){
            const report=clone(plan.qualityReview?.report||{}),ctx=await readNexusBuilder2LiveContext(plan,run.adapters),byKey=new Map(ctx.worksetSources.map(s=>[s.sourceKey,s])),byClass=new Map((plan.classifications||[]).map(c=>[c.sourceKey,c]));
            const unresolvedBlockers=(report.blockers||[]).filter(b=>b.type==='unresolved-classification'&&b.sourceKey);
            const unresolved=unresolvedBlockers.map(b=>{const c=byClass.get(b.sourceKey),src=byKey.get(b.sourceKey);return{sourceKey:b.sourceKey,uid:src?.uid??null,title:src?.title||b.sourceKey,decision:c?.decision||b.decision||'unknown',reason:c?.reason||'',resolvedDisposition:c?.metadata?.resolvedDisposition||null};});
            return{report,unresolved,taxonomy:(plan.taxonomy?.nodes||[]).filter(t=>t.entryPolicy!=='container-only').map(t=>({taxonId:t.taxonId,label:t.label,parentTaxonId:t.parentTaxonId,purpose:t.purpose})),canApprove:report.passed===true,canResolve:unresolvedBlockers.length>0};
        }
        if(reviewKind==='preview'){
            const ctx=await readNexusBuilder2LiveContext(plan,run.adapters);
            const materialized=this.materialize({book:plan.book,baselineTree:ctx.tree,corpusSources:ctx.corpusSources,handoff:plan.structuralPlan,quality:plan.qualityReview?.report,now:this.now()});
            const classes=new Map((plan.classifications||[]).map(row=>[row.sourceKey,row]));
            const previewPlacements=(plan.previewModel?.changes||[]).filter(row=>!row.removed).map(row=>{const classification=classes.get(row.sourceKey);return{sourceKey:row.sourceKey,uid:row.uid,title:row.title,currentTaxonId:classification?.taxonId||null,manualOverride:classification?.metadata?.manualOverride===true,afterPath:clone(row.afterPath||[])};}).filter(row=>row.currentTaxonId);
            return{preview:materialized.delta,builder2Preview:clone(plan.previewModel),taxonomy:clone(plan.taxonomy?.nodes||[]),previewPlacements,canApprove:true};
        }
        return{};
    }

    async #normalizeStep(step,run){
        const plan=step?.plan;if(!plan)throw new Error('Builder 2 pipeline returned no plan.');const reviewKind=step.reviewKind||null;
        const payload=reviewKind?await this.#reviewPayload(plan,reviewKind,run):{};
        return{engine:'builder2',state:reviewKind?'review':clean(plan.phase),runId:plan.runId,book:plan.book,mode:plan.mode,validateOnly:plan.metadata?.validateOnly===true,transactionId:null,reviewKind,reviewToken:step.reviewToken||null,planRevision:plan.planRevision,...payload};
    }

    async start(requestLike={}, {signal=null,onTransaction=null}={}){
        const request=createBuildRequest(requestLike);this.assertReadableBook(request.book);this.assertWritableBook(request.book);
        const requestedResource=requestedSemanticResource(request?.metadata?.semanticResource);
        // An explicit physical-resource contract is operator intent. Validate it
        // before resumable-run discovery so a new `main` request cannot silently
        // resume an older Sidecar-constrained run (or vice versa). Auto remains
        // topology-adaptive and may resume/migrate old auto plans into the pool.
        const explicitlyResolved=requestedResource==='auto'?null:this.resolveSemanticResource(request,this.runtime);
        const unfinished=await this.listResumable(request.book);
        if(unfinished.length){
            const candidate=unfinished[0];
            if(Boolean(candidate.validateOnly)!==Boolean(request.validateOnly)){
                const error=new Error(`Builder 2 run ${candidate.runId} is unfinished for ${request.book}; resume or cancel it before starting a different validation/commit intent.`);
                error.name='TV2Builder2ResumeRequired';error.runId=candidate.runId;error.resumeCandidate=clone(candidate);throw error;
            }
            const candidateResource=requestedSemanticResource(candidate.requestedSemanticResource);
            if(requestedResource!=='auto'&&candidateResource!==requestedResource){
                const error=new Error(`Builder 2 run ${candidate.runId} is unfinished for ${request.book} with ${candidateResource} worker intent; resume or cancel it before starting a new ${requestedResource} worker intent.`);
                error.name='TV2Builder2ResumeRequired';error.runId=candidate.runId;error.resumeCandidate=clone(candidate);
                error.requestedSemanticResource=requestedResource;error.resumeSemanticResource=candidateResource;throw error;
            }
            this.logEvent('builder2','run-resume-discovered',{book:request.book,runId:candidate.runId,phase:candidate.phase,requestedSemanticResource:requestedResource},'info');
            return this.resume(candidate.runId,{signal});
        }
        const {data,tree,inspection}=await this.inspect(request.book);const mode=determineNexusBuilder2Mode(request,inspection);
        this.logEvent('builder2','run-inspected',{runId:request.id,book:request.book,mode,entryCount:inspection.corpusSources.length,unrepresentedCount:inspection.unrepresentedUids.length,changedCount:inspection.changedUids.length,duplicateCount:inspection.duplicateUids.length,orphanedCount:inspection.orphanedTreeUids.length},'info');
        if(mode==='noop')return{engine:'builder2',runId:request.id,book:request.book,mode,state:'current',transactionId:null,preview:{unchangedCount:inspection.representedUids.length,added:[],newNodes:[],conflicts:[]}};
        const semanticResource=explicitlyResolved||this.resolveSemanticResource(request,this.runtime); // fail closed before durable work if no eligible Model Worker exists
        const planningConfig=this.planningConfigProvider?this.planningConfigProvider({semanticResource}):null;
        if(planningConfig)this.logEvent('builder2','semantic-packing-config',{runId:request.id,book:request.book,semanticResource,maxEntriesPerRequest:planningConfig.maxEntriesPerJob,semanticInputTargetTokens:planningConfig.semanticInputTargetTokens,maxJobsPerWave:planningConfig.maxJobsPerWave,waveTargetInputTokens:planningConfig.waveTargetInputTokens},'info');
        const workset=buildNexusBuilder2Workset({book:request.book,mode,inspection});
        const scope=lorebookOperatorReviewScope(request.book);const run=this.#createRun(request.id,{externalSignal:signal,planningConfig});onTransaction?.(request.id);
        try{
            const step=await run.pipeline.start({runId:request.id,book:request.book,mode,worksetSources:workset,corpusSources:inspection.corpusSources,treeInventory:inspection.treeInventory,validateOnly:request.validateOnly,metadata:{source:request.source,semanticResource,semanticPacking:planningConfig?{maxEntriesPerRequest:planningConfig.maxEntriesPerJob,targetInputTokens:planningConfig.semanticInputTargetTokens}:null,operatorReviewScope:scope.identity,chatId:scope.chatId,storyId:scope.storyId,worksetAuthority:minimalNexusBuilder2WorksetAuthority(workset),requestMetadata:clone(request.metadata||{})}});
            return await this.#normalizeStep(step,run);
        }catch(error){
            if(error?.name==='AbortError'||run.lifetime.signal.aborted){await this.#cancelPlanIfOwned(run,run.lifetime.signal.reason||error);}
            else run.lifetime.fail(error);
            throw error;
        }
    }

    async advanceReview(runId,{reviewKind,token,approved=true,decisions={},nodes=null}={}){
        const run=await this.#runFor(runId);const before=await run.store.read(runId);assertNexusBuilder2ReviewScope(before);
        const requestedReviewKind=clean(reviewKind);
        try{
            let step;switch(requestedReviewKind){
                case'taxonomy-review':step=await run.pipeline.reviewTaxonomy(runId,{token,approved,nodes});break;
                case'classification-review':step=await run.pipeline.reviewClassifications(runId,{token,decisions});break;
                case'gap-review':step=await run.pipeline.reviewGaps(runId,{token,decisions});break;
                case'reconciliation-review':step=await run.pipeline.reviewReconciliation(runId,{token,decisions});break;
                case'quality-review':step=await run.pipeline.reviewQuality(runId,{token,approved,decisions});break;
                default:throw new Error(`Unknown Builder 2 review kind ${String(reviewKind)}.`);
            }
            return this.#normalizeStep(step,run);
        }catch(error){
            const current=await run.store.read(runId);
            const progressed=!!current&&(Number(current.planRevision||0)>Number(before?.planRevision||0)||clean(current.phase)!==clean(before?.phase));
            const reviewConflict=error?.name==='Builder2ReviewConflictError';
            if(progressed||reviewConflict){
                this.logEvent('builder2','review-state-resync',{runId,requestedReviewKind,submittedPlanRevision:before?.planRevision??null,currentPlanRevision:current?.planRevision??null,beforePhase:before?.phase||null,currentPhase:current?.phase||null,reason:reviewConflict?'review-token-conflict':'downstream-continuation-error',error:error?.message||String(error)},reviewConflict?'warn':'error');
                try{
                    const resumed=await run.pipeline.resume(runId);
                    const normalized=await this.#normalizeStep(resumed,run);
                    return{...normalized,recoveredReviewState:true,recoveredReviewError:{name:error?.name||'Error',message:error?.message||String(error),requestedReviewKind,beforePhase:before?.phase||null,currentPhase:current?.phase||null,submittedPlanRevision:before?.planRevision??null,currentPlanRevision:current?.planRevision??null}};
                }catch(resumeError){
                    const wrapped=new Error(`Builder 2 advanced beyond ${requestedReviewKind||'review'} but continuation recovery also failed: ${resumeError?.message||String(resumeError)}`);
                    wrapped.name='TV2Builder2ReviewContinuationError';
                    wrapped.cause=resumeError;
                    wrapped.originalReviewError=error;
                    wrapped.runId=runId;
                    wrapped.currentPhase=current?.phase||null;
                    wrapped.currentPlanRevision=current?.planRevision??null;
                    throw wrapped;
                }
            }
            throw error;
        }
    }

    async applyPreviewOverride(runId,{token,sourceKey,taxonId}={}){const run=await this.#runFor(runId);const p=await run.store.read(runId);assertNexusBuilder2ReviewScope(p);return this.#normalizeStep(await run.pipeline.applyPreviewOverride(runId,{token,sourceKey,taxonId}),run);}
    async resetPreviewOverride(runId,{token,sourceKey}={}){const run=await this.#runFor(runId);const p=await run.store.read(runId);assertNexusBuilder2ReviewScope(p);return this.#normalizeStep(await run.pipeline.resetPreviewOverride(runId,{token,sourceKey}),run);}

    async stagePreview(runId,{token,approved=true}={}){
        const run=await this.#runFor(runId);let plan=await run.store.read(runId);assertNexusBuilder2ReviewScope(plan);
        // HOTFIX14: staging is an idempotent boundary. Once a preview has been
        // durably staged, a UI retry/reload must reuse the existing Ledger
        // transaction instead of re-consuming the now-obsolete preview token.
        if(plan.phase===BUILDER2_PHASE.STAGED||plan.phase===BUILDER2_PHASE.COMMITTED){
            const tx=this.#findBuilderTransaction(runId);
            if(tx){
                if(tx.state==='committed'||plan.phase===BUILDER2_PHASE.COMMITTED)return{engine:'builder2',state:'committed',runId,book:plan.book,mode:plan.mode,transactionId:tx.id,preview:clone(tx.staged?.delta||null),mutationProposal:tx.mutationProposal||null,recovered:true};
                if(retryableBuilderPreIntentFailure(tx)){
                    const resumed=await run.pipeline.resume(runId),envelope=resumed?.commitEnvelope||resumed?.plan?.metadata?.commitEnvelope;
                    if(envelope)return this.#stagePlanThroughLedger(run,resumed.plan||plan,envelope,{recovered:true});
                }
                if(['stale','failed','aborted','cancelled'].includes(tx.state))return{engine:'builder2',state:tx.state,runId,book:plan.book,mode:plan.mode,transactionId:tx.id,preview:clone(tx.staged?.delta||null),mutationProposal:tx.mutationProposal||null,recovered:true};
                return{engine:'builder2',state:tx.state,runId,book:plan.book,mode:plan.mode,transactionId:tx.id,preview:clone(tx.staged?.delta||null),mutationProposal:tx.mutationProposal||null,recovered:true};
            }
            if(plan.phase===BUILDER2_PHASE.STAGED){
                const resumed=await run.pipeline.resume(runId),envelope=resumed?.commitEnvelope||resumed?.plan?.metadata?.commitEnvelope;
                if(envelope)return this.#stagePlanThroughLedger(run,resumed.plan||plan,envelope,{recovered:true});
            }
        }
        const staged=await run.pipeline.reviewPreview(runId,{token,approved});
        if(staged?.readOnly){run.lifetime.complete(staged);return{engine:'builder2',state:'validated',readOnly:true,runId,book:plan.book,mode:plan.mode,transactionId:null,preview:(await this.#reviewPayload(staged.plan,'preview',run)).preview,validation:staged.validation,staged:false,committed:false};}
        plan=staged.plan;
        return this.#stagePlanThroughLedger(run,plan,staged.commitEnvelope);
    }

    async #stagePlanThroughLedger(run,plan,commitEnvelope,{recovered=false}={}){
        const runId=plan.runId;
        const ctx=await readNexusBuilder2LiveContext(plan,run.adapters);const handoff=commitEnvelope?.structuralHandoff;
        if(!handoff?.handoffFingerprint)throw new Error('Builder 2 STAGED plan is missing structural handoff authority.');
        const materialized=this.materialize({book:plan.book,baselineTree:ctx.tree,corpusSources:ctx.corpusSources,handoff,quality:plan.qualityReview?.report,now:this.now()});
        const structural=validateBuilder2NexusMaterialization({tree:materialized.tree,corpusSources:ctx.corpusSources});if(!structural.passed)throw new Error(`Builder 2 Nexus materialization failed: ${structural.errors.join(' ')}`);
        const fresh=await run.pipeline.resume(runId);
        if(fresh?.terminal===true||fresh?.plan?.phase===BUILDER2_PHASE.STALE)throw new Error('Recovered Builder 2 STAGED plan became stale before Nexus review staging.');
        plan=await run.store.read(runId);
        const current=await readNexusBuilder2CurrentAuthority(plan,run.adapters);
        const assumptions=createBuilder2NexusCommitAssumptions(plan,current,handoff.handoffFingerprint);
        const operations=operationsForHandoff(handoff);const ledgerPlan=createLedgerMutationPlan({book:plan.book,mode:plan.mode,operations,assumptions,delta:materialized.delta});
        let tx=null;
        try{
            tx=this.ledger.begin({type:'lorebook-builder2',input:{builderRunId:runId,mode:plan.mode,engine:'builder2'},snapshot:{tree:clone(ctx.tree),commitEnvelope:clone(commitEnvelope)},assumptions,metadata:{builder2:true,builderRunId:runId,builderPlanRevision:plan.planRevision,book:plan.book,mode:plan.mode,source:plan.metadata?.source||'operator',reviewScope:{kind:'lorebook',identity:plan.metadata?.operatorReviewScope||null,book:plan.book,chatId:null},recovered:recovered===true}});
            this.ledger.executing(tx.id);this.ledger.parsed(tx.id,{builder2:true,handoffFingerprint:handoff.handoffFingerprint,envelopeFingerprint:commitEnvelope.envelopeFingerprint});this.ledger.validated(tx.id,{passed:true,structural,builder2Validation:clone(plan.validation||null)});
            this.ledger.staged(tx.id,ledgerPlan,{mutationProposal:createMutationProposal({transactionId:tx.id,type:'lorebook-builder2-tree-delta',target:{book:plan.book,tree:true},draft:{mode:plan.mode,delta:materialized.delta,operations,builder2:{runId,handoffFingerprint:handoff.handoffFingerprint,envelopeFingerprint:commitEnvelope.envelopeFingerprint}},assumptions,approvalRequired:true,metadata:{builder2:true,builderRunId:runId,builderPlanRevision:plan.planRevision}})});
            if(typeof this.persistReviewTransaction!=='function'){const e=new Error('Builder 2 review durability is unavailable.');e.name='TV2OperatorReviewDurabilityUnavailable';throw e;}
            await this.persistReviewTransaction(tx.id);
        }catch(error){
            if(tx){const cur=this.ledger.read(tx.id);if(cur&&!['committed','stale','aborted','failed','cancelled','committing'].includes(cur.state)){try{this.ledger.cancel(tx.id,`Builder 2 staging failed: ${error?.message||error}`);}catch{}}}
            const latest=await run.store.read(runId);if(latest?.phase===BUILDER2_PHASE.STAGED){try{await run.store.transition(runId,BUILDER2_PHASE.STALE,{metadata:{...(latest.metadata||{}),nexusStageFailure:String(error?.message||error)}});}catch{}}
            run.lifetime.stale(error);throw error;
        }
        const final=this.ledger.read(tx.id);this.logEvent('builder2','proposal-staged',{runId,transactionId:tx.id,book:plan.book,mode:plan.mode,addedCount:materialized.delta.added?.length||0,newNodeCount:materialized.delta.newNodes?.length||0,recovered},'info');
        return{engine:'builder2',state:final.state,runId,book:plan.book,mode:plan.mode,transactionId:tx.id,preview:materialized.delta,mutationProposal:final.mutationProposal,recovered};
    }

    async approveAndCommit(transactionId,{by='operator'}={}){
        const tx=this.ledger.read(transactionId);if(!tx)throw new Error(`Unknown Lorebook Builder 2 transaction ${transactionId}.`);if(tx.type!=='lorebook-builder2')throw new Error(`Transaction ${transactionId} is not a Builder 2 transaction.`);
        const runId=clean(tx.metadata?.builderRunId||tx.input?.builderRunId),run=await this.#runFor(runId),plan=await run.store.read(runId);assertNexusBuilder2ReviewScope(plan);const book=tx.metadata?.book||plan.book;this.assertWritableBook(book);
        // A commit retry may arrive after the canonical mutation already settled.
        // Treat the Ledger as authority and return the terminal result instead of
        // trying to drive an already-COMMITTED BuilderPlan through STAGED again.
        if(tx.state==='committed')return{state:'committed',transactionId,committed:clone(tx.committed||null),recovered:true};
        if(['stale','failed','aborted','cancelled'].includes(tx.state))return{state:tx.state,transactionId,error:tx.error||null,recovered:true};
        const nextTree=tx.staged?.delta?.nextTree;if(!nextTree?.root)throw new Error('Builder 2 staged transaction has no next Tree draft.');
        if(tx.state==='staged')this.ledger.approve(transactionId,{by,metadata:{surface:'lorebook-builder2-preview',builderRunId:runId}});
        const approved=this.ledger.read(transactionId);if(approved.approval?.approved!==true)throw new Error('Builder 2 canonical commit requires explicit operator approval.');
        const handoffFingerprint=approved.assumptions?.handoffFingerprint||plan.metadata?.commitEnvelope?.handoffFingerprint;if(!handoffFingerprint)throw new Error('Builder 2 staged transaction is missing handoff fingerprint.');
        const mutation={type:'tree.replace',book,loreDependency:true,tree:clone(nextTree),expectedTree:semanticSnapshot(tx.snapshot?.tree||null)};
        let result;
        try{
            result=await commitBuilder2ThroughNexus({store:run.store,runId,transactionId,mutation,handoffFingerprint,approvedBy:by,commitMutation:this.commitMutation,readCurrentAuthority:p=>readNexusBuilder2CurrentAuthority(p,run.adapters),targetLedger:this.ledger,signal:run.lifetime.signal,metadata:{surface:'lorebook-builder2-preview',mode:plan.mode},committed:execution=>({book,tree:clone(execution?.tree||nextTree),delta:clone(tx.staged?.delta||null),builder2:{runId,handoffFingerprint}})});
        }catch(error){
            if(error?.tv2PreMutationStale===true||error?.name==='TV2MutationStale'){
                await this.#settleReviewStaleDurably(transactionId,error?.message||'Builder 2 canonical commit became stale.',{fresh:false,required:true,changes:(error?.builder2Reasons||[]).map(reason=>({path:'builder2-authority',reason}))});
                run.lifetime.stale(error);
            }
            throw error;
        }
        if(result?.state==='committed')run.lifetime.complete(result);
        else if(result?.state==='stale'){
            await this.#settleReviewStaleDurably(transactionId,result?.error||'Builder 2 commit became stale.',result?.freshness||{fresh:false,required:true,changes:(result?.reasons||[]).map(reason=>({path:'builder2-authority',reason}))});
            run.lifetime.stale(result?.error||'Builder 2 commit became stale.');
        }
        this.logEvent('builder2',result?.state==='committed'?'committed':'commit-settled',{runId,transactionId,book,state:result?.state},result?.state==='committed'?'info':'warn');return result;
    }

    async #settleReviewStaleDurably(transactionId,reason,freshness=null){
        const current=this.ledger.read(transactionId);
        if(!current||['committed','aborted','failed','cancelled'].includes(current.state))return current;
        if(current.state==='stale'){
            if(typeof this.persistReviewTransaction!=='function'){
                const error=new Error('Builder 2 durable STALE review persistence is unavailable.');
                error.name='TV2OperatorReviewDurabilityUnavailable';
                throw error;
            }
            await this.persistReviewTransaction(transactionId);
            return this.ledger.read(transactionId);
        }
        if(typeof this.staleReviewTransactionDurably!=='function'){
            const error=new Error('Builder 2 durable STALE review settlement is unavailable.');
            error.name='TV2OperatorReviewDurabilityUnavailable';
            throw error;
        }
        return this.staleReviewTransactionDurably(transactionId,reason,freshness,{targetLedger:this.ledger});
    }

    async #cancelPlanIfOwned(run,reason){
        if(!run)return null;run.lifetime.cancel(reason||'Builder 2 cancelled.');const plan=await run.store.read(run.runId);if(!plan||TERMINAL_PLAN.has(plan.phase))return plan;try{return await run.store.transition(run.runId,BUILDER2_PHASE.CANCELLED,{metadata:{...(plan.metadata||{}),cancelReason:String(reason?.message||reason||'cancelled')}});}catch{return await run.store.read(run.runId);}
    }

    cancel(id,reason='Lorebook Builder 2 cancelled by operator.'){
        const key=clean(id),tx=this.ledger.read(key);if(tx){if(['committed','stale','aborted','failed','cancelled','committing'].includes(tx.state))return tx;if(tx.state==='staged'){const e=new Error('Staged Builder 2 review must be cancelled through the durable review boundary.');e.name='TV2OperatorReviewDurabilityRequired';throw e;}return this.ledger.cancel(key,reason);}
        const run=this.runs.get(key);if(run){void this.#cancelPlanIfOwned(run,reason);return{runId:key,state:'cancelled'};}return null;
    }

    async cancelDurably(id,reason='Lorebook Builder 2 cancelled by operator.'){
        const key=clean(id),tx=this.ledger.read(key);if(tx){if(['committed','stale','aborted','failed','cancelled','committing'].includes(tx.state))return tx;if(tx.state!=='staged')return this.ledger.cancel(key,reason);if(typeof this.cancelReviewTransactionDurably!=='function'){const e=new Error('Builder 2 review cancellation durability is unavailable.');e.name='TV2OperatorReviewDurabilityUnavailable';throw e;}const out=await this.cancelReviewTransactionDurably(key,reason,{targetLedger:this.ledger});const runId=clean(tx.metadata?.builderRunId);if(runId){try{const run=await this.#runFor(runId);await this.#cancelPlanIfOwned(run,reason);}catch{}}return out;}
        const run=await this.#runFor(key);return this.#cancelPlanIfOwned(run,reason);
    }

    async restageEditedTree(){const e=new Error('Builder 2 final preview uses structured placement overrides; arbitrary Tree restaging is disabled.');e.name='TV2Builder2UseStructuredOverride';throw e;}
}
