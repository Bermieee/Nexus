import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SidecarScheduler } from '../scheduler/sidecars.js';
import { runNexusForegroundScatterGather } from '../nexus/scatter-gather-runtime.js';
import { WorkDirector } from '../nexus/work-director.js';
import { NexusWorkCoordinator } from '../nexus/work-coordinator.js';
import { beginGenerationFrameState, sealGenerationFrameState, getGenerationFrameSnapshot } from '../nexus/generation-frame-bus.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function replaceFunction(source,name,body){
 const start=source.indexOf(`async function ${name}(`);assert(start>=0);const open=source.indexOf('){',start)+1;
 let depth=1,end=open+1;for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}
 return source.slice(0,open+1)+body+source.slice(end-1);
}
test('actual model-worker bus uses sidecars when operator Main policy is disabled',async()=>{
 const slots=[],scheduler=new SidecarScheduler();
 globalThis.schedulerBusFixture={sidecarScheduler:scheduler,logEvent:()=>{},captureNexusWorkScope:()=>({kind:'independent'}),isNexusWorkScopeFresh:()=>true,currentNexusChatEpoch:()=>1,
  estimateSidecarCall:()=>({}),resolveAutoReasoningEffort:()=> 'low',resolveSidecarTransportTimeout:()=>1000,
  recordAdaptivePhysicalWorkerSample:()=>{},recommendAdaptivePhysicalWorkerPlan:()=>({}),chooseNexusModelWorkerResource:()=> 'sidecar',isNexusMainPreferredWorker:()=>false,resolveNexusModelWorkerPoolPlan:()=>({}),resolveNexusModelWorkerLanePreference:()=>false,
  dispatch:(domain,stage,options)=>{slots.push(options);return {id:'physical',meta:{assignedSlot:options.forceSlot},promise:Promise.resolve({text:'ok',tv2:{slot:options.forceSlot}})};}};
 let source=fs.readFileSync(new URL('../nexus/model-worker-bus.js',import.meta.url),'utf8');
 source=source.replace(/import\s*\{([^}]+)\}\s*from\s*'[^']+';/g,(_,names)=>`const {${names}}=globalThis.schedulerBusFixture;`).replace(/export\s*\{[^}]+\}\s*from\s*'[^']+';/g,'');
 source=replaceFunction(source,'getModelWorkerHostContext','return {};');
 source=replaceFunction(source,'canDispatchModelWorkerSidecar','return true;');
 source=source.replace('let sidecarBusModulePromise = null;',"let sidecarBusModulePromise = Promise.resolve({availableSidecarWorkSlots:()=>['A','B'],canBatchSidecarWork:()=>false});");
 source=replaceFunction(source,'mainPolicyEnabled','return false;');
 source=replaceFunction(source,'runtimeSnapshot','return {runtime:null,gateway:null,snap:{}};');
 source=replaceFunction(source,'enqueueModelWorkerSidecar','return globalThis.schedulerBusFixture.dispatch(domain,stage,options);');
 const bus=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const job=bus.enqueueNexusModelWorkerJob('tree','tree-build',{schedulerLane:'background',nexusScope:{kind:'independent'},mainEligible:true,forceMain:true});
 scheduler.loan('queued');const controller=new AbortController();const cancelled=bus.enqueueNexusModelWorkerJob('tree','tree-build',{schedulerLane:'background',nexusScope:{kind:'independent'},signal:controller.signal});controller.abort();await assert.rejects(cancelled.promise);scheduler.resume('queued');
 assert.equal((await job.promise).text,'ok');assert.equal(slots.length,1);assert.equal(slots[0].forceSlot,'B');assert.equal(slots[0].mainEligible,false);assert.equal(slots[0].forceMain,false);assert.equal(slots[0].preemptible,false);
});
test('actual foreground gather returns at deadline and frame seals while a provider drains',async()=>{
 const wait=deferred(),runtime={director:new WorkDirector(),coordinator:new NexusWorkCoordinator()};
 beginGenerationFrameState({generationId:'deadline',schedulerEnvelope:{scopeEpoch:1,deadline:Date.now()+1000}});
 const start=Date.now();
 const result=await runNexusForegroundScatterGather({generationId:'deadline',runtime,deadlineMs:1000,scope:{chatId:'one',revision:'r'},isFresh:()=>true,
  executors:{'foreground-bootstrap':async()=>({ready:true}),'foreground-retrieval':()=>wait.promise,'foreground-memory':async()=>({ready:true})}});
 assert(Date.now()-start<1800);assert.equal(result.quorum.satisfied,true);assert.equal(result.bundle.closeReason,'HARD_DEADLINE');assert(result.bundle.fallbacksUsed.some(row=>row.taskId==='foreground-retrieval'));
 const sealed=sealGenerationFrameState({generationId:'deadline'});assert.equal(sealed.state,'sealed');const before=JSON.stringify(getGenerationFrameSnapshot());
 wait.resolve({ready:true,late:true});await new Promise(r=>setTimeout(r,20));assert.equal(JSON.stringify(getGenerationFrameSnapshot()),before);
});
import { sidecarScheduler } from '../scheduler/sidecars.js';
import { publishRetrievalLoreOutlet, takeLateForegroundReadProposal, admitLateForegroundReadProposal } from '../nexus/generation-frame-ports.js';
test('fresh held read output passes its typed owner port into the actual next frame',async()=>{
 const scope={chatId:'carry',revision:'same'};
 beginGenerationFrameState({generationId:'prior'});sealGenerationFrameState({generationId:'prior'});const prior=JSON.stringify(getGenerationFrameSnapshot());
 assert.equal(publishRetrievalLoreOutlet({generationId:'prior',status:'ready',content:'Remember the key.',refs:[{book:'world',uid:1}]}).accepted,false);
 const proposal=takeLateForegroundReadProposal('foreground-retrieval','prior');assert(proposal);assert.equal(JSON.stringify(getGenerationFrameSnapshot()),prior);
 sidecarScheduler.lateResults.set(JSON.stringify(['foreground-retrieval',scope]),{scope,payload:{ownerResult:{refs:[{book:'world',uid:1}]},proposal}});
 beginGenerationFrameState({generationId:'next'});
 const result=await runNexusForegroundScatterGather({generationId:'next',scope,runtime:{director:new WorkDirector(),coordinator:new NexusWorkCoordinator()},deadlineMs:2000,isFresh:()=>true,
  admitLate:(id,held)=>admitLateForegroundReadProposal(id,held,{generationId:'next',isFresh:()=>true}),
  executors:{'foreground-bootstrap':async()=>({ready:true}),'foreground-retrieval':async()=>{throw new Error('offline');},'foreground-memory':async()=>({ready:true})}});
 assert.equal(result.settled[1].status,'fulfilled');assert.equal(getGenerationFrameSnapshot().outlets['retrieval-lore'].content,'Remember the key.');assert.equal(sidecarScheduler.lateResults.has(JSON.stringify(['foreground-retrieval',scope])),false);
});
