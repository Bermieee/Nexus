import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { updateAssistantTurnCounter, countAssistantTurnsForCadence } from '../lifecycle/cadence-counter.js';

let loadId=0;
async function loadLifecycle(){
  const url=new URL('../lifecycle/scheduler.js',import.meta.url);
  const source=fs.readFileSync(url,'utf8').replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)';/g,(_,names,path)=>
    path.startsWith('../scheduler/')||path==='../core/budget.js'?`import {${names}} from '${new URL(path,url).href}';`:`const {${names}}=globalThis.schedulerFixture;`);
  return import('data:text/javascript;base64,'+Buffer.from(source+`\n// fixture ${++loadId}`).toString('base64'));
}
function fixture({failReview=false,manual=false}={}){
  const calls=[];let active=0,peak=0;
  const work=(name,value)=>async()=>{calls.push(name);active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;if(name==='review'&&failReview)throw new Error('review-failed');return value;};
  const context={chatId:'parity',chatMetadata:{},chat:[{is_user:false,mes:'reply'}],saveMetadataDebounced(){}};
  const settings={enabled:true,scheduler:{enabled:true,tasks:{},intervals:{}},memoryBank:{enabled:true,loreRouting:{enabled:true,maxPerCycle:1}}};
  globalThis.schedulerFixture={
    getContext:()=>context,getSettings:()=>settings,logEvent:()=>{},currentNexusChatEpoch:()=>1,
    captureNexusWorkScope:()=>({chatId:'parity',epoch:1}),isNexusWorkScopeFresh:()=>true,
    updateAssistantTurnCounter,countAssistantTurnsForCadence,
    memoryStats:()=>({}),setLastCycleId:()=>{},getMemoryRecord:id=>({id}),
    getLifecyclePhysicalLeaseSnapshot:()=>[],invalidateLifecyclePhysicalLeasesForCycle:()=>0,
    runLifecyclePhysicalLease:async({execute})=>({value:await execute()}),runCheckpointedLifecycleTask:async({execute})=>execute(),
    isIntentionalCancellation:()=>false,getSceneAuthority:()=>({}),
    isNexusGreenRoomRefreshDue:()=>false,invalidateNexusGreenRoomForSourceChange:()=>0,
    retractNexusSceneMessage:()=>{},
    runNexusSceneObservationPostTurn:async()=>({path:'sidecar'}),runNexusGreenRoomPostTurn:async()=>({accepted:1}),
    runWorldTreeCardContributionJob:async()=>({skipped:true,reason:'no-card-revision'}),runWorldTreeSceneContributionJob:async()=>({skipped:true,reason:'no-scene-revision'}),runCharacterMemoryJob:async()=>({skipped:true,reason:'no-work'}),invalidateCharacterMemoriesForMessage:async()=>({skipped:true,reason:'no-edit'}),runWorldTreeMemoryContributionJob:async()=>({skipped:true,reason:'no-memory-revision'}),drainWorldTreeContributions:async()=>({skipped:true,reason:'empty'}),
    drainPostTurn:work('manual-review',{operations:3}),runAutomaticPostTurnLifecycle:work('review',{operations:3}),
    refreshNotebookFromScene:work('notebook',{updated:true}),preWarmSmartContext:work('warm',{refs:['fact']}),
    runHousekeeper:work('housekeeper',{status:'complete',findingCount:2}),isHousekeeperSuccessfulRun:r=>r?.status==='complete',
    inspectSummaryEligibility:()=>({due:true}),createNextSummary:work('summary',{created:true,record:{id:'s',turnRange:[0,0]}}),
    promoteDueSummaries:work('promotion',{promotions:1,results:[{parent:{id:'p'}}]}),
    routeUnroutedMemories:work('manual-routing',{count:2,results:[]}),runAutomaticLoreRoutingLifecycle:work('routing',{count:2,results:[]}),
    routeMemoryToLore:()=>{},
  };
  return {context,calls,settings,peak:()=>peak,manual};
}
test('actual lifecycle keeps post-turn outputs and branch ordering under two-job dispatch',async()=>{
  const f=fixture();const module=await loadLifecycle();
  const cycle=await module.runLifecycleCycle({source:'parity',includeNotebook:true});
  assert.equal(cycle.status,'complete');
  assert.deepEqual(cycle.result.parallelResults,[{scene:{path:'sidecar'},greenRoom:{accepted:1}},{operations:3},{updated:true},{refs:['fact']},{status:'complete',findingCount:2}]);
  assert.deepEqual(cycle.result.summary,{summary:{created:true,record:{id:'s',turnRange:[0,0]}},promotion:{promotions:1,results:[{parent:{id:'p'}}]},routing:{count:2,results:[]}});
  assert.ok(f.calls.indexOf('summary')<f.calls.indexOf('promotion'));
  assert.ok(f.calls.indexOf('promotion')<f.calls.indexOf('routing'));
  assert.equal(f.peak(),2);
});
test('manual routing and disabled cadence remain unchanged',async()=>{
  const f=fixture();const module=await loadLifecycle();
  const cycle=await module.runLifecycleCycle({manual:true,includeNotebook:true});
  assert.equal(cycle.status,'complete');assert.ok(f.calls.includes('manual-review'));assert.ok(f.calls.includes('manual-routing'));assert.ok(!f.calls.includes('review'));
  f.calls.length=0;f.settings.scheduler.tasks={postTurn:false,notebook:false,smartWarm:false,housekeeper:false,summary:false,promotion:false,loreRouting:false};
  const skipped=await module.runLifecycleCycle({includeNotebook:true});
  assert.equal(skipped.status,'complete');assert.deepEqual(f.calls,[]);
});
test('a review exception does not prevent notebook or summary completion',async()=>{
  const f=fixture({failReview:true});const module=await loadLifecycle();
  const cycle=await module.runLifecycleCycle({includeNotebook:true});
  assert.equal(cycle.status,'partial');assert.equal(cycle.result.parallelResults[1].error,'review-failed');
  assert.ok(f.calls.includes('notebook'));assert.ok(f.calls.includes('routing'));
});
test('Scene and Green Room run when Director owns review, with no legacy review requested',async()=>{
  fixture();const module=await loadLifecycle();
  const cycle=await module.runLifecycleCycle({source:'generation-end',includePostTurn:false,includeScene:true,includeGreenRoom:true});
  assert.equal(cycle.status,'complete');
  assert.deepEqual(cycle.result.parallelResults[0],{scene:{path:'sidecar'},greenRoom:{accepted:1}});
});
test('NO_CHANGE skips Scene and Green Room unless Green Room TTL is due',async()=>{
  fixture();globalThis.schedulerFixture.getSceneAuthority=()=>({gate:{mode:'NO_CHANGE'}});
  const module=await loadLifecycle();const cycle=await module.runLifecycleCycle({source:'generation-end'});
  assert.ok(cycle.steps.some(row=>row.name==='scene-observation'&&row.status==='skipped'));
  assert.ok(cycle.steps.some(row=>row.name==='green-room'&&row.status==='skipped'));
});

test('an unbound first lifecycle runs Scene without a canonical Memory control write',async()=>{
 const f=fixture();
 const url=new URL('../memory/store.js',import.meta.url);
 const stubs={
  '../../../../st-context.js':'export const getContext=()=>globalThis.schedulerFixture.getContext();',
  '../observability/telemetry.js':'export const logEvent=()=>{};',
  '../nexus/host-durability.js':'export const mutateChatMetadataDurably=()=>{throw Error("unexpected durable write");};',
  '../nexus/work-scope.js':'export const currentNexusChatEpoch=()=>1;',
 };
 const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
 const source=fs.readFileSync(url,'utf8').replace(/from '([^']+)'/g,(_,name)=>`from '${stubs[name]?data(stubs[name]):new URL(name,url).href}'`);
 const memory=await import(data(source));
 globalThis.schedulerFixture.setLastCycleId=memory.setLastCycleId;
 const module=await loadLifecycle();
 const cycle=await module.runLifecycleCycle({source:'generation-end',includePostTurn:false,includeScene:true,includeGreenRoom:true,includeNotebook:false,includeSummary:false,includePromotion:false,includeLoreRouting:false,includeHousekeeper:false,includeSmartWarm:false});
 assert.equal(cycle.status,'complete');
 assert.ok(cycle.steps.some(step=>step.name==='scene-observation'&&step.status==='complete'));
 assert.equal(f.context.chatMetadata.tv2_story_scope_v1,undefined);
 assert.equal(memory.getMemoryReadSnapshot().records&&Object.keys(memory.getMemoryReadSnapshot().records).length,0);
});

test('learning receipt exposes bounded failure attribution without raw exception contents',async()=>{
 fixture();const module=await loadLifecycle();
 assert.equal(typeof module.createLifecycleLearningReceipt,'function');
 const selection={chatId:'parity',generationId:'gen',source:'generation-end',completedAt:1};
 const receipt=module.createLifecycleLearningReceipt({failed:true,error:Object.assign(new Error('PRIVATE NARRATIVE / API SECRET'),{name:'NexusWorldTreeMigrationRequired'})},selection);
 assert.equal(receipt.status,'FAILED');assert.equal(receipt.reasonCode,'NexusWorldTreeMigrationRequired');
 assert.equal(receipt.cycleId,null);assert.equal(receipt.stepCount,0);assert.equal(JSON.stringify(receipt).includes('PRIVATE'),false);
 const partial=module.createLifecycleLearningReceipt({id:'cycle',status:'partial',steps:[{name:'scene-observation',status:'complete'},{name:'green-room',status:'failed',error:'PRIVATE'}]},selection);
 assert.equal(partial.status,'PARTIAL');assert.deepEqual(partial.failedSteps,['green-room']);assert.equal(partial.failedStepCount,1);
 assert.equal(module.createLifecycleLearningReceipt({skipped:true,reason:'automatic-disabled'},selection).status,'SKIPPED');
 assert.equal(module.createLifecycleLearningReceipt(null,selection).status,'PENDING');
});
