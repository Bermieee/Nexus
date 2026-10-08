import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { configureWorldTreeContextProvider, replaceNexusWorldTree } from '../world-tree/index.js';
import { readWorkingState, writeWorkingState, clearWorkingState, bindWorkingStore } from '../core/ephemeral-state.js';
import { GreenRoomStore, createGreenRoomBatch } from '../nexus/a52/green-room.js';
import {beginGenerationFrameState,getGenerationFrameSnapshot,resetGenerationFrameState} from '../nexus/generation-frame-bus.js';
import { writeRetrievalSourcePlan, readRetrievalSourcePlan, clearRetrievalSourcePlan, fallbackRetrievalSourcePlan } from '../retrieval/source-plan.js';
import { writeTask8PostTurnAdvice, readTask8PostTurnAdvice, clearTask8PostTurnAdvice } from '../decision/task8-advice.js';

const dataModule=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
async function hostModule(path,stubs){
  const url=new URL(path,import.meta.url);
  const source=fs.readFileSync(url,'utf8').replace(/from '([^']+)'/g,(_,name)=>`from '${stubs[name]?dataModule(stubs[name]):new URL(name,url).href}'`);
  return import(dataModule(source));
}
test.afterEach(()=>configureWorldTreeContextProvider(null));
const batch=()=>createGreenRoomBatch({sceneRevision:1,characters:[{characterRef:'Mara',confidence:.8,dimensions:{warmth:.5},directEvidenceRefs:['m1'],sourceRevisionSet:['r1'],expiryCondition:{ttlTurns:2}}]});

test('post-turn retrieval plans and advice round-trip through real scoped overlays without entering durable state',()=>{
  const owner=replaceNexusWorldTree(),context={chatId:'chat-a',chatMetadata:{}};
  configureWorldTreeContextProvider(()=>context,()=>({configured:true,chatKey:'chat-a',revision:1,readBooks:['A'],writeBooks:['A'],primaryWriteBook:'A'}));
  const revision=owner.revision,saved=owner.exportState();
  const plan=writeRetrievalSourcePlan(fallbackRetrievalSourcePlan({gate:'MAJOR'}),{context,sceneRevision:3});
  const advice=writeTask8PostTurnAdvice({hotThreads:{thread:{choice:'RESOLVED'}}},{context});
  assert.deepEqual(readRetrievalSourcePlan({context,sceneRevision:3}),plan);
  assert.deepEqual(readTask8PostTurnAdvice({context}),advice);
  assert.equal(readRetrievalSourcePlan({context,sceneRevision:4}),null);
  assert.equal(readRetrievalSourcePlan({context:{chatId:'chat-b'}}),null);
  assert.equal(readTask8PostTurnAdvice({context:{chatId:'chat-b'}}),null);
  const exported=owner.exportState();delete exported.overlayRevision;delete saved.overlayRevision;
  assert.equal(owner.revision,revision);assert.deepEqual(exported,saved);
  assert.throws(()=>writeWorkingState('UNREGISTERED','chat-a',{}),/Unsupported World Tree overlay kind/);
  clearRetrievalSourcePlan({context});clearTask8PostTurnAdvice({context});
  assert.equal(readRetrievalSourcePlan({context}),null);assert.equal(readTask8PostTurnAdvice({context}),null);
});

test('the installed post-turn advisory pass reaches completion through real plan and advice storage',async()=>{
  const owner=replaceNexusWorldTree(),context={chatId:'chat-a',chatMetadata:{},chat:[]};
  configureWorldTreeContextProvider(()=>context,()=>({configured:true,chatKey:'chat-a',revision:1,readBooks:['A'],writeBooks:['A'],primaryWriteBook:'A'}));
  const pass=await hostModule('../decision/task8-runtime.js',{
    '../core/world-tree-api.js':'export const createCanonicalWorldTreeReadApi=()=>({allNodes:()=>[],findByAlias:()=>[]});export const normalizeWorldTreeAlias=x=>String(x).toLowerCase();',
    '../nexus/hot-cognition.js':'export const currentNexusHotSnapshot=()=>({segments:{}});',
    '../nexus/scene-intelligence.js':'export const getNexusSceneIntelligenceView=()=>({sceneId:"scene-a",revision:3,participants:[],threads:[]});',
    '../retrieval/diagnostics.js':'export const getRetrievalDiagnosticsSnapshot=()=>({});',
    './task8-postturn-sites.js':'export const TASK8_POSTTURN_SITE_IDS={};export const runRetrievalSourcePlanDecision=async(_,plan)=>({plan,source:"fallback"});export const runTask8ChoiceDecision=async()=>{throw Error("Unexpected provider call");};',
    '../observability/telemetry.js':'export const logEvent=()=>{};',
    '../world-tree/tracking.js':'export const observeWorldTreeTrackAppearances=()=>[];export const recordWorldTreeTrackSuggestion=()=>{};',
    '../world-tree/intake/candidates.js':'export const listWorldTreeCandidates=()=>[];',
    '../world-tree/watch-list.js':'export const syncWorldTreeWatchList=()=>[];export const worldTreeWatchRetrievalBoost=()=>({nodeIds:[],highLikelihoodCount:0});',
    '../scene/scanner.js':'export const getSceneScannerSnapshot=()=>null;',
    '../proposals/store.js':'export const enqueueProposal=()=>{throw Error("Unexpected proposal");};',
    './task8-review-proposals.js':'export const compatibleReflectionReadings=()=>[];export const stageTask8Review=()=>{throw Error("Unexpected review");};',
    '../nexus/work-scope.js':'export const captureNexusWorkScope=()=>({});export const isNexusWorkScopeFresh=()=>true;',
  });
  const advice=await pass.runTask8PostTurnAdvisoryPass({context,gate:{mode:'MAJOR'},generationId:'gen-a'});
  assert.equal(advice.sourcePlan.walker,'deep');
  assert.deepEqual(readTask8PostTurnAdvice({context}),advice);
  assert.equal(readRetrievalSourcePlan({context,sceneRevision:3}).plan.walker,'deep');
  assert.equal(owner.read({chatId:'chat-a'}).overlays.length,2);
});
function seedTracked(owner,name,book=null){
  const id='test-tracked:'+name.toLowerCase();owner.upsertNode({id,kind:'ENTITY',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[id]},temporal:{status:'CURRENT'},data:{label:name,aliases:[name],trackedCharacter:true,tracking:'active',...(book?{book}:{})}});
  owner.registerIdentity({nodeId:id,canonicalLabel:name,entityType:'CHARACTER',aliases:[name],providerId:'TEST',sourceEntityId:id,authorityOrigin:'OWNER_EXPLICIT'});return id;
}

test('working store is backed by node-keyed scoped overlays and excluded from durable export',()=>{
  const owner=replaceNexusWorldTree();
  const store=bindWorkingStore(new GreenRoomStore(),'GREEN_ROOM','chat-a');
  store.putBatch(batch(),{turnSequence:3,activeCharacterRefs:['Mara']});
  const overlay=owner.read({chatId:'chat-a'}).overlays[0];
  assert.deepEqual(overlay.nodeIds,['world:nexus']);
  assert.equal(readWorkingState('GREEN_ROOM','chat-b'),null);
  const recreated=bindWorkingStore(new GreenRoomStore(),'GREEN_ROOM','chat-a');
  assert.equal(recreated.active({turnSequence:4,sceneRevision:1,activeCharacterRefs:['Mara']}).length,1);
  assert.equal(recreated.active({turnSequence:5,sceneRevision:1,activeCharacterRefs:['Mara']}).length,1,'existing expiry includes the second subsequent turn');
  assert.equal(recreated.active({turnSequence:6,sceneRevision:1,activeCharacterRefs:['Mara']}).length,0);
  const saved=owner.exportState();
  assert.equal(JSON.stringify(saved).includes('warmth'),false);
  clearWorkingState('GREEN_ROOM','chat-a');
  assert.equal(store.active({}).length,0,'a stale computation cache cannot resurrect cleared owner state');
  store.putBatch(batch(),{turnSequence:3});
  replaceNexusWorldTree(saved);
  assert.equal(store.active({}).length,0,'durable reload excludes temporary readings');
});

test('Green Room keeps source, departure and scene expiry with ephemeral backing',()=>{
  replaceNexusWorldTree();
  const store=bindWorkingStore(new GreenRoomStore(),'GREEN_ROOM','chat-a');
  store.putBatch(batch(),{turnSequence:3});
  assert.equal(store.invalidate({invalidatedSourceRevisionIds:['r1']}),1);
  assert.equal(store.active({}).length,0);
  store.putBatch(batch(),{turnSequence:3});
  assert.equal(store.active({turnSequence:3,sceneRevision:2}).length,0);
  store.putBatch(batch(),{turnSequence:3});
  assert.equal(store.invalidate({departedCharacterRefs:['Mara']}),1);
});

test('installed Hot adapter migrates old key and saves only to ephemeral owner',async()=>{
  const owner=replaceNexusWorldTree();
  const context={chatId:'chat-a',chatMetadata:{},chat:[{is_user:true,mes:'Hello'}]};
  globalThis.workingTestContext=context;globalThis.workingTestScope=null;
  configureWorldTreeContextProvider(()=>globalThis.workingTestContext,()=>globalThis.workingTestScope);
  let hot=await hostModule('../nexus/hot-cognition.js',{
    '../../../../st-context.js':'export const getContext=()=>globalThis.workingTestContext;',
    '../observability/telemetry.js':'export const logEvent=()=>{};',
    '../observability/system-events.js':'export const logSystemEvent=()=>{};',
    './host-durability.js':'export async function mutateChatMetadataDurably(context,label,options,mutate){return mutate();}',
  });
  assert.equal(hot.currentNexusHotSnapshot({context}).worldRevision,owner.revision,'a fresh Hot owner must start at the actual World Tree revision');
  hot.observeNexusHotNarrativeMessage({messageIndex:0,context});
  hot.observeNexusHotGraphNeighborhood({
    hotNeighborhoodSummary:[{ref:'NEXUS_WORLD_TREE|lore:A',sourceRevisionRefs:['lore:a:1']}],
    hotNeighborhoodRefs:['NEXUS_WORLD_TREE|lore:A'],
    hotNeighborhoodSourceRevisionRefs:['lore:a:1'],
    hotNeighborhoodIdentityRevisionRefs:[],
    hotNeighborhoodDependencyRevisionRefs:[],
    intentId:'turn-a',elapsedMs:1,traversedEdgeCount:1,
  },{context,generationId:'gen-a'});
  const unbound=hot.currentNexusHotSnapshot({context});
  assert.equal(unbound.segments.GRAPH_NEIGHBORHOOD.freshness,'FRESH');
  assert.equal(unbound.segments.RECENT_EPISODE_TAIL.value.length,1);
  globalThis.workingTestScope={configured:true,chatKey:'chat-a',revision:1,readBooks:['A'],writeBooks:['A'],primaryWriteBook:'A'};
  const rebound=hot.currentNexusHotSnapshot({context});
  assert.equal(rebound.segments.GRAPH_NEIGHBORHOOD.freshness,'INVALIDATED','book-derived graph state must be invalidated when a binding appears or changes');
  assert.equal(rebound.segments.RECENT_EPISODE_TAIL.value.length,1,'chat-local narrative state survives a binding change');
  const state=readWorkingState('HOT_COGNITION','chat-a',{worldTree:owner});
  assert.ok(state.states[0].segments.RECENT_EPISODE_TAIL.value.length);
  assert.match(state.nexusBindingKey,/"A"/);
  context.chatMetadata.nexus_a52_hot_cognition_v1=state;
  clearWorkingState('HOT_COGNITION','chat-a',{worldTree:owner});
  hot.activateNexusHotCognition({context});
  await hot.persistNexusHotCognition({context});
  assert.equal(Object.hasOwn(context.chatMetadata,'nexus_a52_hot_cognition_v1'),false);
  assert.ok(readWorkingState('HOT_COGNITION','chat-a',{worldTree:owner}));
  assert.equal(JSON.stringify(owner.exportState()).includes('Hello'),false);
  globalThis.workingTestScope={configured:true,chatKey:'chat-a',revision:2,readBooks:['B'],writeBooks:['B'],primaryWriteBook:'B'};
  assert.equal(hot.currentNexusHotSnapshot({context}).segments.GRAPH_NEIGHBORHOOD.freshness,'INVALIDATED');
  globalThis.workingTestScope=null;
  const detached=hot.currentNexusHotSnapshot({context});
  assert.equal(detached.segments.GRAPH_NEIGHBORHOOD.freshness,'INVALIDATED');
  assert.equal(detached.segments.RECENT_EPISODE_TAIL.value.length,1,'removing the binding preserves valid chat-local tail');
  globalThis.workingTestContext={chatId:'chat-b',chatMetadata:{},chat:[]};globalThis.workingTestScope=null;
  hot.activateNexusHotCognition({context:globalThis.workingTestContext});
  assert.equal(readWorkingState('HOT_COGNITION','chat-a',{worldTree:owner}),null);
  assert.equal(hot.currentNexusHotSnapshot({context:globalThis.workingTestContext}).segments.RECENT_EPISODE_TAIL.value.length,0);
  replaceNexusWorldTree(owner.exportState());
  assert.equal(hot.currentNexusHotSnapshot({context:globalThis.workingTestContext}).segments.RECENT_EPISODE_TAIL.value.length,0);
  const reset=hot.resetNexusHotCognition({context:globalThis.workingTestContext});
  assert.equal(reset.worldRevision,owner.revision);
  assert.equal(reset.segments.RECENT_EPISODE_TAIL.value.length,0);
  delete globalThis.workingTestContext;delete globalThis.workingTestScope;
});

test('installed Green Room uses ephemeral backing and rejects a result after chat switch',async()=>{
  const owner=replaceNexusWorldTree();seedTracked(owner,'Mara');
  globalThis.workingTestContext={chatId:'chat-a',chat:[{mes:'Narrative',is_user:false}]};
  globalThis.workingTestScene={sceneId:'scene-a',revision:1,participants:['Mara']};
  const providerBatch=()=>({sceneRevision:1,authority:'INFERRED',characters:[{characterRef:'Mara',confidence:.8,dimensions:{warmth:.5},directEvidenceRefs:['r1'],sourceRevisionSet:['r1'],expiryCondition:{ttlTurns:2}}]});
  globalThis.workingTestJob=()=>({promise:Promise.resolve({structuredPayload:providerBatch()})});
  const green=await hostModule('../nexus/green-room.js',{
    '../../../../st-context.js':'export const getContext=()=>globalThis.workingTestContext;',
    './model-worker-bus.js':'export const enqueueNexusModelWorkerJob=(...args)=>globalThis.workingTestJob(...args);',
    './scene-intelligence.js':'export const getNexusSceneIntelligenceView=()=>globalThis.workingTestScene;',
    './hot-cognition.js':`export const currentNexusHotSnapshot=()=>({segments:{RECENT_EPISODE_TAIL:{value:[{sourceRevisionId:'r1',messageId:'m1',excerpt:'Narrative',sequence:1,role:'assistant'}]}}});`,
    '../memory/character-banks.js':'export const getCharacterBanks=()=>[];',
    '../sidecar/bus.js':`export const BUS_STAGE={GREEN_ROOM:'green-room'};export const BUS_PRIORITY={GREEN_ROOM:67};`,
    '../observability/telemetry.js':'export const logEvent=()=>{};',
    '../observability/system-events.js':'export const logSystemEvent=()=>{};',
  });
  const result=await green.runNexusGreenRoomPostTurn();
  assert.equal(result.updated,true,result.error?.message??JSON.stringify(result));
  assert.ok(readWorkingState('GREEN_ROOM','chat-a').states.length);
  assert.equal(green.getNexusGreenRoomProjection().characters.length,1);
  globalThis.workingTestScene={sceneId:'scene-a',revision:2,participants:['Mara']};
  const carried=green.getNexusGreenRoomProjection();
  assert.equal(carried.characters.length,1,'accepted inference survives a newer revision within the same scene and TTL');
  assert.equal(carried.characters[0].sceneRevision,1,'source revision must remain attributable');
  globalThis.workingTestScene={sceneId:'scene-a',revision:1,participants:['Mara']};
  let resolve;
  globalThis.workingTestJob=()=>({promise:new Promise(r=>{resolve=r;})});
  const pending=green.runNexusGreenRoomPostTurn();
  globalThis.workingTestContext={chatId:'chat-b',chat:[]};
  globalThis.workingTestScene={sceneId:'scene-b',revision:1,participants:['Mara']};
  assert.equal(green.getNexusGreenRoomProjection().characters.length,0);
  resolve({structuredPayload:providerBatch()});
  assert.equal((await pending).reason,'stale-working-state');
  assert.equal(readWorkingState('GREEN_ROOM','chat-a'),null);
  assert.equal(green.getNexusGreenRoomProjection().characters.length,0);
  delete globalThis.workingTestContext;delete globalThis.workingTestScene;delete globalThis.workingTestJob;
});

test('unbound empty Green Room reads and lifecycle work do not attempt a canonical mutation',async()=>{
 const owner=replaceNexusWorldTree();
 seedTracked(owner,'Foreign character','Other book');
 globalThis.emptyGreenContext={chatId:'unbound-green',chatMetadata:{},chat:[{is_user:false,mes:'A quiet courtyard.'}]};
 configureWorldTreeContextProvider(()=>globalThis.emptyGreenContext,()=>null);
 const green=await hostModule('../nexus/green-room.js',{
  '../../../../st-context.js':'export const getContext=()=>globalThis.emptyGreenContext;',
  './scene-intelligence.js':'export const getNexusSceneIntelligenceView=()=>({sceneId:"scene-empty",revision:1,participants:["Foreign character"]});',
  './hot-cognition.js':'export const currentNexusHotSnapshot=()=>null;',
  './model-worker-bus.js':'export const enqueueNexusModelWorkerJob=()=>{throw Error("unexpected provider call");};',
  '../memory/character-banks.js':'export const getCharacterBanks=()=>[];',
  '../sidecar/bus.js':'export const BUS_STAGE={GREEN_ROOM:"green-room"};export const BUS_PRIORITY={GREEN_ROOM:67};',
  '../observability/system-events.js':'export const logSystemEvent=()=>{};',
 });
 assert.deepEqual(green.getNexusGreenRoomProjection().characters,[]);
 globalThis.emptyGreenAdapter=green;
 const outlets=await hostModule('../nexus/generation-frame-outlets.js',{
  '../../../../st-context.js':'export const getContext=()=>globalThis.emptyGreenContext;',
  '../lore/active-books.js':'export const getStoryScopeStatus=()=>({mode:"unbound",readBooks:[],writeBooks:[]});',
  '../scene/runtime.js':'export const getSceneAuthority=()=>null;',
  './scene-intelligence.js':'export const getNexusSceneIntelligenceView=()=>null;export const renderNexusSceneIntelligence=()=>"";',
  './green-room.js':'export const getNexusGreenRoomProjection=options=>globalThis.emptyGreenAdapter.getNexusGreenRoomProjection(options);export const renderNexusGreenRoom=projection=>globalThis.emptyGreenAdapter.renderNexusGreenRoom(projection);',
  '../memory/character-banks.js':'export const getCharacterBankSceneSnapshot=()=>({enabled:true,bankStates:[]});',
  '../memory/store.js':'export const memoryStats=()=>({total:0});',
  '../smart-context/warmer.js':'export const getPinnedRefs=()=>[];export const getWarmCandidates=()=>[];export const getLastWarmStats=()=>null;',
  './transaction-service.js':'export const getNexusLedger=()=>({list:()=>[]});',
 });
 beginGenerationFrameState({chatId:'unbound-green',generationId:'empty-bank-generation'});
 try{
  const publication=outlets.settleGenerationFrameSubsystemOutlets({generationId:'empty-bank-generation'});
  assert.equal(publication.characters.accepted,true);
  assert.equal(getGenerationFrameSnapshot().outlets['character-banks'].status,'empty','the real typed outlet must publish an empty bank rather than fail a protected write');
 }finally{resetGenerationFrameState();delete globalThis.emptyGreenAdapter;}
 assert.equal(green.nexusGreenRoomDiagnostics().metrics.active,0);
 assert.equal(green.invalidateNexusGreenRoomForSourceChange(),0);
 assert.equal((await green.runNexusGreenRoomPostTurn()).reason,'no-active-cast');
 globalThis.emptyGreenContext={chatId:'another-unbound-green',chatMetadata:{},chat:[]};
 assert.deepEqual(green.getNexusGreenRoomProjection().characters,[]);
 assert.equal(green.resetNexusGreenRoom(),true);
 assert.equal(owner.read({chatId:'unbound-green'}).overlays.length,0);
 delete globalThis.emptyGreenContext;
});

test('same-chat binding replacement rejects an in-flight Green Room result and clears prior inferred state',async()=>{
 const owner=replaceNexusWorldTree();seedTracked(owner,'Mara','A');seedTracked(owner,'Lili','B');
 const context={chatId:'binding-green',chatMetadata:{},chat:[{is_user:false,mes:'Narrative'}]};
 let book='A';
 configureWorldTreeContextProvider(()=>context,()=>({configured:true,chatKey:context.chatId,revision:book==='A'?1:2,readBooks:[book],writeBooks:[book],primaryWriteBook:book}));
 globalThis.bindingGreenContext=context;
 let resolve;globalThis.bindingGreenJob=()=>({promise:new Promise(r=>{resolve=r;})});
 const green=await hostModule('../nexus/green-room.js',{
  '../../../../st-context.js':'export const getContext=()=>globalThis.bindingGreenContext;',
  './scene-intelligence.js':'export const getNexusSceneIntelligenceView=()=>({sceneId:"same-scene",revision:1,participants:["Mara","Lili"]});',
  './hot-cognition.js':'export const currentNexusHotSnapshot=()=>({segments:{RECENT_EPISODE_TAIL:{value:[{sourceRevisionId:"r1",excerpt:"Mara waits."}]}}});',
  './model-worker-bus.js':'export const enqueueNexusModelWorkerJob=()=>globalThis.bindingGreenJob();',
  '../memory/character-banks.js':'export const getCharacterBanks=()=>[];',
  '../sidecar/bus.js':'export const BUS_STAGE={GREEN_ROOM:"green-room"};export const BUS_PRIORITY={GREEN_ROOM:67};',
  '../observability/system-events.js':'export const logSystemEvent=()=>{};',
 });
 const batch={sceneRevision:1,authority:'INFERRED',characters:[{characterRef:'Mara',confidence:.8,dimensions:{warmth:.5},directEvidenceRefs:['r1'],sourceRevisionSet:['r1'],expiryCondition:{ttlTurns:2}}]};
 const first=green.runNexusGreenRoomPostTurn();resolve({structuredPayload:batch});assert.equal((await first).accepted,1);
 const pending=green.runNexusGreenRoomPostTurn();book='B';
 assert.deepEqual(green.getNexusGreenRoomProjection().characters,[]);
 resolve({structuredPayload:batch});assert.equal((await pending).reason,'stale-working-state');
 assert.equal(readWorkingState('GREEN_ROOM',context.chatId),null);
 assert.equal(owner.getNode('test-tracked:mara').data.book,'A');
 delete globalThis.bindingGreenContext;delete globalThis.bindingGreenJob;
});
