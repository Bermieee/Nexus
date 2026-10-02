import test from 'node:test';
import {createLorebookWorldTreeBuilderHost} from '../builder2/book-world-host.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createNexusUiHostBindings,projectNexusSensoryTrace,projectNexusTruthAssessment } from '../nexus-ui-bindings.js';
import { SillyTavernSelectionBridge } from '../src/ui-core/wave12-sillytavern-host.js';
import { createWave11LiveReceiptBinding } from '../src/ui-core/wave11-live-bindings.js';
import { PromptPlanProductionUIAdapter } from '../src/ui-core/wave6-production-adapters.js';
import { Wave13MemoryUIAdapter,Wave13LoreStudyUIAdapter } from '../src/ui-core/wave13-operator-adapters.js';
import { DemoEvidenceJournal } from '../src/ui-core/demo-visibility.js';
import { SelectedTurnLogModel } from '../src/ui-core/turn-log-diagnostics.js';
import { createNexusDiagnosticEvent } from '../nexus/diagnostics-source.js';
import { NexusWorldTree } from '../world-tree/store.js';
import {createLorebookAuthoringSource} from '../lore/authoring-source.js';
import { BrainDecisionVisibilityAdapter } from '../src/ui-core/brain-decision-visibility.js';
const chatId='Akira Kagenou - 2026-09-16@18h19m27s303ms imported';
function fixture(){
 const frame={chatId,generationId:'generation-1',appliedAt:50,promptHash:'hash',promptTokens:350,sections:[{id:'memory-recall',hash:'section',tokens:150,reused:false}],failedOutlets:[],schedulerEnvelope:{worldRevision:12,sceneRevision:7,sourceRevisionRefs:['a:9|World:3']},worldRevision:12,sceneRevision:7,sourceRevisionRefs:['a:9|World:3']};
 const telemetry={events:[]};let listener;
 const host=createNexusUiHostBindings({readCurrentChatId:()=>chatId,readGenerationFrameDiagnostics:()=>frame,readTelemetry:()=>telemetry,
  readMemorySnapshot:()=>({records:{m:{id:'m',text:'PRIVATE-STORY',layer:0,turnRange:[0,12],routeState:'unrouted'}},evidenceRevision:7}),
  readLoreSnapshot:()=>({worldRevision:3,nodes:[{id:'lore:1',kind:'LORE_FACT',scope:{type:'GLOBAL'},temporal:{status:'CURRENT'},provenance:{sourceIds:['World','1'],sourceRevisionIds:['rev']},data:{book:'World',uid:1,content:'PRIVATE-LORE'}}]}),
  subscribeOwner:fn=>{listener=fn;return()=>listener=null;},
 });return {frame,telemetry,host,notify:()=>listener?.({kind:'OWNER_UPDATE'})};
}

test('Brain explanation recognizes the same frame and host receipts as product activity',()=>{
 const {host,telemetry}=fixture();
 telemetry.events.push({id:'delivery',ts:70,category:'prompt-loader',name:'chat-completion-ready',data:{chatId,generationId:'generation-1',dryRun:false}});
 const model=new BrainDecisionVisibilityAdapter({bindings:host,selectionProvider:host.readSelection}).read();
 assert.equal(model.state,'READY');
 for(const stage of ['contextSeal','promptPlan','contextReceipt','compiledDelivery','delivery'])assert.ok(!model.missingReceipts.includes(stage),stage);
 assert.ok(model.missingReceipts.includes('sensory'));
 assert.ok(model.missingReceipts.includes('truth'));
});

test('selected Sensory and Truth reads cannot borrow unscoped or foreign telemetry',()=>{
 const selection={chatId,generationId:'generation-1',turnId:'generation-1'};
 for(const data of [{},{chatId},{generationId:'generation-1'},{chatId,generationId:'other'}]){
  assert.equal(projectNexusSensoryTrace({events:[{category:'nexus.sensory',name:'candidate-envelope',data}]},selection),null);
  assert.equal(projectNexusTruthAssessment({events:[{category:'nexus.truth',name:'assessment-complete',data}]},selection),null);
 }
 const data={chatId,generationId:'generation-1',candidateCount:1};
 assert.ok(projectNexusSensoryTrace({events:[{category:'nexus.sensory',name:'candidate-envelope',data}]},selection));
 const truth=projectNexusTruthAssessment({events:[
  {category:'nexus.truth',name:'candidate-verdict',data:{candidateId:'anonymous',kept:true}},
  {category:'nexus.truth',name:'candidate-verdict',data:{...data,candidateId:'scoped',kept:true}},
  {category:'nexus.truth',name:'assessment-complete',data},
 ]},selection);
 assert.deepEqual(truth.truthResults.map(row=>row.candidateId),['scoped']);
});
test('real host selection gets generation identity and can retain its first turn',()=>{
 const {host}=fixture(),bridge=new SillyTavernSelectionBridge({getContext:()=>({chatId}),ownerBindings:host});
 const selection=bridge.readSelection();assert.equal(selection.generationId,'generation-1');assert.equal(selection.turnId,'generation-1');assert.equal(selection.worldRevision,12);assert.equal(selection.sceneRevision,7);assert.deepEqual(selection.sourceRevisionRefs,['a:9|World:3']);
 const journal=new DemoEvidenceJournal();assert.ok(journal.recordSnapshot({selection,ownerReceipt:host.readSelectedTurnReceipt(selection)}));assert.equal(journal.status().turnCount,1);
});
test('PromptPlan and Memory/Lore adapters read actual Nexus owners without assembly-missing errors',()=>{
 const {host}=fixture();const binding=createWave11LiveReceiptBinding(host),selection=()=>binding.selection();
 const prompt=new PromptPlanProductionUIAdapter({...binding.bridges.promptPlan,readHostDeliveryReceipt:host.readHostDeliveryReceipt,selectionProvider:selection});
 assert.equal(prompt.read().data.totalTokens,350);
 const memory=new Wave13MemoryUIAdapter({bindings:host,selectionProvider:selection});assert.equal(memory.read().data.counts.summaries,1);
 const lore=new Wave13LoreStudyUIAdapter({bindings:host,selectionProvider:selection});assert.equal(lore.read().data.entries.length,1);
 assert.equal(JSON.stringify(host.readMemory()).includes('PRIVATE-STORY'),false);assert.equal(JSON.stringify(host.readLoreStatus()).includes('PRIVATE-LORE'),false);
});
test('applying the extension frame is not reported as host request observation',()=>{
 const {host,telemetry}=fixture();let receipt=host.readHostDeliveryReceipt();assert.equal(receipt.promptInjected,false);
 telemetry.events.push({id:'event',ts:70,category:'prompt-loader',name:'chat-completion-ready',data:{chatId,generationId:'generation-1',dryRun:false,promptHash:'final'}});
 receipt=host.readHostDeliveryReceipt();assert.equal(receipt.promptInjected,true);assert.equal(receipt.requestInjectedAt,70);
 assert.equal(host.readHostDeliveryReceipt({chatId:'foreign'}),null);assert.equal(host.readHostDeliveryReceipt({generationId:'old'}),null);
});
test('learning receipts and logical-to-physical mappings are exposed without inventing execution',()=>{
 const {host,telemetry}=fixture();
 telemetry.events.push({id:'sidecar',ts:80,category:'sidecar-a',name:'request-success',data:{chatId,generationId:'generation-1',turnId:'generation-1',jobId:'physical-1',routeId:'route-1',schedulerTaskId:'foreground-retrieval',schedulerPlanId:'plan-1'}});
 telemetry.events.push({id:'learning',ts:90,category:'learning',name:'post-turn-receipt',data:{chatId,generationId:'generation-1',turnId:'generation-1',status:'COMPLETE',source:'generation-end',cycleId:'cycle-1',stepCount:3,completedAt:90}});
 const cognition=host.readCognitionUiState();assert.deepEqual(cognition.physicalExecution.taskResourceMap,{'foreground-retrieval':['sidecar-a']});assert.equal(cognition.physicalExecution.mappedResourceIdentities[0].planId,'plan-1');
 const receipt=host.readLearningReceipt();assert.equal(receipt.status,'COMPLETE');assert.equal(receipt.cycleId,'cycle-1');assert.equal(host.readGeneration().learningReceipt.receiptId,'learning');
});
test('owner notifications refresh the live binding and chat switches drop prior selection',()=>{
 const {host,frame,notify}=fixture(),binding=createWave11LiveReceiptBinding(host);let seen;
 const release=binding.subscribe(update=>seen=update.selection);frame.generationId='generation-2';notify();assert.equal(seen.generationId,'generation-2');
 frame.chatId='foreign';notify();assert.equal(binding.selection().generationId,null);release();
});

test('production chat names survive the diagnostic producer identity boundary',()=>{
 const event=createNexusDiagnosticEvent({channelId:'scatter',name:'completed',selection:{chatId,generationId:'generation-1'}});
 assert.equal(event.data.selection.chatId,chatId);
});

test('deep export preserves scalar execution metadata while redacting secrets',()=>{
 const diagnostics={read:()=>({a:{b:{c:{d:{e:{f:{generationId:'generation-1',prompt:'PRIVATE',authorization:'PRIVATE'}}}}}}})};
 const model=new SelectedTurnLogModel({diagnostics});
 const row=model.exportDiagnostics().operationalSnapshot.a.b.c.d.e.f;
 assert.equal(row.generationId,'generation-1');assert.equal(row.prompt,'[REDACTED]');assert.equal(row.authorization,'[REDACTED]');
});

test('a dry run cannot prove host delivery and an open next frame cannot borrow an old seal',()=>{
 const {host,telemetry}=fixture();
 telemetry.events.push({ts:70,category:'prompt-loader',name:'chat-completion-ready',data:{chatId,generationId:'generation-1',dryRun:true}});
 assert.equal(host.readHostDeliveryReceipt().promptInjected,false);
 const next=createNexusUiHostBindings({readCurrentChatId:()=>chatId,readGenerationFrameIdentity:()=>({chatId,generationId:'generation-2',state:'open'}),readGenerationFrameDiagnostics:()=>({chatId,generationId:'generation-1',appliedAt:50})});
 assert.equal(next.readSelection().generationId,'generation-2');assert.equal(next.readContextSeal(),null);
});

test('production mount connects owner callbacks and releases telemetry subscription',async()=>{
 let captured,listener,released=false;
 const owners={createNexusUiHostBindings,createLorebookWorldTreeBuilderHost,assertReadableBook:()=>true,assertWritableBook:()=>true,projectNexusSensoryTrace,projectNexusTruthAssessment,mountWave12SillyTavernInterface:({hostBindings})=>{captured=hostBindings;return {destroy(){}};},
  createLorebookAuthoringSource,getHostLorebookNames:()=>['Unmanaged book'],canReadBook:()=>true,assertAuthoritySettingsReady:()=>true,isBookEnabled:()=>false,setBookEnabled:async()=>true,
  getGenerationFrameIdentity:()=>({chatId,generationId:'g-live',state:'open'}),getGenerationFrameDiagnostics:()=>null,
  getMemoryStore:()=>({records:{m:{id:'m',layer:0}},evidenceRevision:2}),readNexusWorldTree:()=>({nodes:[],worldRevision:2}),readNexusWorldTreeLoreMetadata:()=>({nodes:[],worldRevision:2}),
  getNexusLedger:()=>({list:()=>[]}),getHousekeeperRuntimeStatus:()=>({lastStatus:'COMPLETE'}),vectorPagingStatus:()=>({enabled:true}),
  getLastWarmStats:()=>({status:'READY'}),getPostTurnBacklogState:()=>({pending:2}),
  onTelemetryChange:fn=>{listener=fn;return()=>{released=true;};},subscribeWorldTreeUi:()=>()=>{},
  getTelemetrySnapshot:()=>({events:[]}),getSettings:()=>({}),getJobQueue:()=>({healthSnapshot:()=>({})}),
  getDecisionTelemetrySnapshot:()=>({}),getSceneScannerSnapshot:()=>null,getNexusSceneIntelligenceView:()=>null,
  getRetrievalDiagnosticsSnapshot:()=>({}),snapshotMainBridgeStatus:()=>({}),readNexusWorldTreeUiModel:()=>({}),
  legacyWorldTreeMigrationRuntimeStatus:()=>({}),legacyLoreWorldTreeBridgeStatus:()=>({}),projectNexusDiagnosticTelemetryFromObservability:()=>({}),
  currentNexusHotSnapshot:()=>null,nexusForegroundScatterGatherDiagnostics:()=>null,
  readGraphTraversalDiagnostics:()=>null,inspectSelectedWorldGraph:()=>null,createWorldTreeBuilderHostBindings,
  readNexusConnectionResources:()=>[],readSelectedGenerationPerformanceReceipt:()=>({chatId,generationId:'g-live',performance:{stages:[{stage:'host',elapsedMs:2}]}}),
 };
 globalThis.__nexusHostTestOwners=owners;
 try{
  let code=fs.readFileSync(new URL('../nexus-ui-host.js',import.meta.url),'utf8');
  code=code.replace(/import\s*\{([^}]+)\}\s*from\s*'[^']+';/g,(_,names)=>`const {${names}}=globalThis.__nexusHostTestOwners;`);
  const module=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  module.mountNexusUi({getContext:()=>({chatId})});
  assert.deepEqual(captured.listWorldTreeAuthoringBooks(),['Unmanaged book']);assert.equal(typeof captured.createWorldTreeBook,'function');
  assert.equal(captured.readSelection().generationId,'g-live');assert.equal(captured.readMemory().summaries.length,1);
  assert.equal(captured.readSelectedTurnReceipt().kind,'NexusSelectedTurnReceipt');assert.equal(captured.readSelectedTurnReceipt().performance.stages[0].elapsedMs,2);
  assert.equal(captured.readLoreStatus().revision,2);assert.equal(captured.readDiagnosticsTelemetry().telemetry.subsystems.maintenance.lastStatus,'COMPLETE');
  let notified=false;const release=captured.subscribe(()=>notified=true);listener({});assert.equal(notified,true);release();assert.equal(released,true);module.destroyNexusUi();
 }finally{delete globalThis.__nexusHostTestOwners;}
});

test('Lore metadata read reports bounds, excludes foreign chats and omits authored bodies',()=>{
 const tree=new NexusWorldTree();
 for(const [id,scope] of [['one',{type:'GLOBAL'}],['two',{type:'GLOBAL'}],['foreign',{type:'CHAT',chatId:'other'}]])tree.upsertNode({id,kind:'LORE_FACT',scope,provenance:{sourceType:'SILLYTAVERN_WORLD_INFO',sourceIds:['Book','1']},temporal:{status:'CURRENT'},data:{book:'Book',uid:1,content:'PRIVATE-BODY'}});
 const result=tree.readLoreMetadata({chatId,limit:1});
 assert.deepEqual(result.coverage,{total:2,returned:1,complete:false});assert.equal(JSON.stringify(result).includes('PRIVATE-BODY'),false);
 assert.equal(tree.readLoreMetadata({chatId}).nodes.some(row=>row.id==='foreign'),false);
 const {host}=fixture();assert.equal(host.readLoreStatus().entries[0].learnedRevisionId,null);assert.equal(host.readLoreStatus().entries[0].retrievalReady,false);
});

test('a new generation cannot borrow prior Scatter or Gather execution evidence',()=>{
 const host=createNexusUiHostBindings({readCurrentChatId:()=>chatId,readGenerationFrameIdentity:()=>({chatId,generationId:'new'}),readScatter:()=>({chatId,generationId:'old',jobs:[{jobId:'old-job'}]}),readGather:()=>({chatId,generationId:'old',results:[{resultId:'old-result',accepted:true}]})});
 assert.equal(host.readCognitiveChoice(),null);
 assert.equal(host.readSelectedTurnReceipt().stages.find(row=>row.stage==='gather').status,'NO_EVIDENCE');
 assert.deepEqual(host.readCognitionUiState().activeTasks,[]);
});
import {createWorldTreeBuilderHostBindings} from '../builder2/world-host.js';
