import { createBudgetManager } from '../core/budget.js';
import { NexusSensoryBackbone } from '../nexus/a52/sensory/backbone.js';
import { NativeGraphNeighborhoodRetriever } from '../nexus/a52/graph-neighborhood-retriever.js';
import { createWorldTreeGraphProvider } from '../nexus/a52/sensory/walker/world-tree-provider.js';
import { refreshSensoryNomination, sensoryNominationSourceKey } from '../nexus/a52/sensory/source-continuation.js';
import { readSensoryContinuation, writeSensoryContinuation, createSensoryTurnPlan } from './source-plan.js';
import { stableHash } from '../nexus/a52/browser-runtime-utils.js';

const active=new WeakMap();
const hasWork=state=>Boolean(state&&(state.nominations?.length||Object.keys(state.channels?.providers??{}).length));
const stateKey=state=>stableHash(state,{length:32});

// Uses the existing cooperative lane. Outputs are working-state candidates;
// this owner never updates a sealed prompt or writes canonical graph records.
export function scheduleSensoryContinuation({scheduler,context,worldTree,budgetManager=createBudgetManager(),sliceTimeMs=15,
  readState=()=>readSensoryContinuation({context}),writeState=value=>writeSensoryContinuation(value,{context}),emit=()=>{}}={}){
  const initial=readState();if(!hasWork(initial))return Promise.resolve({complete:true,staged:0});
  const binding=worldTree.readScopeKey??context?.chatId,scope=scheduler.captureScope(),id='sensory.continue:'+String(context?.chatId??scope?.chatId);
  let jobs=active.get(scheduler);if(!jobs){jobs=new Map();active.set(scheduler,jobs);}if(jobs.has(id))return jobs.get(id);
  const fresh=captured=>{
    const current=scheduler.captureScope();
    return captured?.chatId===current?.chatId&&captured?.epoch===current?.epoch&&captured?.worldOwnerId===current?.worldOwnerId&&captured?.policyRevision===current?.policyRevision&&(worldTree.readScopeKey??context?.chatId)===binding;
  };
  const row={id,lane:'background',priority:5,needsSidecar:false,restartOnStale:false,trigger:{everyTurn:true},inputs:()=>({chatId:context?.chatId}),isFresh:fresh,
    async *steps(input,ctx){
      let staged=0,position=0;
      while(ctx.isFresh()){
        const state=readState();if(!hasWork(state))return {complete:true,staged};
        const key=stateKey(state),started=Date.now(),worldSize=Math.max(1,worldTree.allNodes().length);
        const graphState=state.channels?.providers?.ZZ_NATIVE_GRAPH_WALKER;
        const plan=createSensoryTurnPlan({budgetManager,timeMs:sliceTimeMs,worldSize,sourcePlan:{walker:graphState?'deep':'skip'},promptTokens:4096,channelTotals:{}});
        const grant=plan.frame.compute('sensory.background',{total:(state.nominations?.length??0)+(graphState?worldSize*4:0),defaultUnits:64,defaultWorldSize:64,sanityCeiling:4096});
        if(!grant.allowed)return {complete:false,deferred:true,reason:'NO_BACKGROUND_BUDGET',staged};
        const backbone=new NexusSensoryBackbone();
        if(graphState){const walker=new NativeGraphNeighborhoodRetriever({temporalGraph:{allClaims:()=>[]},limits:plan.walkerLimits});walker.registerProvider(createWorldTreeGraphProvider({worldTree}));backbone.register(walker);}
        const ready=state.readyNominations??[],readyKeys=ready.map(sensoryNominationSourceKey);
        const result=backbone.retrieveEnvelope({query:state.query,intent:state.intent??'CURRENT',chatId:context?.chatId,generationId:state.generationId??null,worldTree,
          anchorEntityIds:state.anchorEntityIds??[],sourceRevisionSet:state.sourceRevisionSet??[],worldRevision:worldTree.worldRevision,sceneRevision:state.sceneRevision??0,
          graphTraversal:plan.walkerLimits,latencyBudgetMs:sliceTimeMs,candidateLimit:grant.allowed,
          continuation:{...state,readyNominations:[],deliveredSourceKeys:[...(state.deliveredSourceKeys??[]),...readyKeys]}});
        const selected=new Set(result.candidates.flatMap(candidate=>candidate.channelNominations.map(nomination=>nomination.nominationId)));
        const pool=[...(state.nominations??[]),...result.gathered.nominations,...result.gathered.deferredNominations];
        const additions=pool.filter(nomination=>selected.has(nomination.nominationId));
        const next=result.envelope.metadata.continuation??{...state,nominations:[],channels:result.gathered.continuation};
        // A checkpoint can be held while the foreground borrows the lane. Both
        // the working-state version and each source are rechecked at publication.
        const step={schedulerOwnerStep:true,kind:'PUBLICATION',position:++position,
          accept:()=>ctx.isFresh()&&stateKey(readState())===key,
          publish:()=>{
            if(!ctx.isFresh()||stateKey(readState())!==key)throw Object.assign(new Error('Sensory continuation state changed'),{name:'TV2ScopeInvalidated'});
            const kept=[...ready,...additions].map(row=>refreshSensoryNomination(row,{worldTree,query:state.query,sourceRevisionSet:state.sourceRevisionSet??[],worldRevision:worldTree.worldRevision,sceneRevision:state.sceneRevision??0})).filter(Boolean);
            const distinct=[...new Map(kept.map(row=>[row.nominationId,row])).values()];
            writeState({...next,readyNominations:distinct,deliveredSourceKeys:state.deliveredSourceKeys??[]});staged+=distinct.length-ready.length;
            budgetManager.observe('sensory.background',{units:grant.allowed,durationMs:Date.now()-started});
            emit('continuation-staged',{jobId:id,staged:distinct.length,remaining:next.nominations?.length??0,coverage:result.envelope.metadata.coverage});
          },
        };
        yield step;
        if(!additions.length&&stateKey(next)===stateKey(state))return {complete:false,deferred:true,reason:'AWAITING_LARGER_GRANT',staged};
      }
      return {complete:false,staged};
    },accept:()=>fresh(scope),onResult:value=>value?.schedulerOwnerStep?value.publish():undefined,
  };
  const work=scheduler.enqueue(row,{scope});jobs.set(id,work);
  work.then(()=>jobs.delete(id),()=>jobs.delete(id));return work;
}
