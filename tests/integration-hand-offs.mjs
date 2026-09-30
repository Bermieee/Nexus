import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { replaceNexusWorldTree } from '../world-tree/index.js';
import { createCanonicalWorldTreeReadApi, loreNodeId } from '../core/world-tree-api.js';
import { hotContinuityCandidates } from '../core/continuity-channel.js';
import { importLegacyLoreBookToWorldTree, loreFactWorldNodeId } from '../world-tree/import-lore.js';
import { NexusSensoryBackbone, createNexusCandidateChannel } from '../nexus/a52/sensory/backbone.js';
import { RetrievalChannelCapability } from '../nexus/a52/candidate-bus-contracts.js';
import { createWorldTreeGraphProvider } from '../nexus/a52/sensory/walker/world-tree-provider.js';
import { NativeGraphNeighborhoodRetriever } from '../nexus/a52/graph-neighborhood-retriever.js';
import { assessWorldTreeCandidates } from '../nexus/a52/truth/status-resolver.js';

const dataModule=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
async function hostModule(path,stubs){
  const url=new URL(path,import.meta.url);
  const source=fs.readFileSync(url,'utf8').replace(/from '([^']+)'/g,(_,name)=>`from '${stubs[name]?dataModule(stubs[name]):new URL(name,url).href}'`);
  return import(dataModule(source));
}
let hot,scene,green;
const context=()=>globalThis.handoffContext;
const common={
  '../../../../st-context.js':'export const getContext=()=>globalThis.handoffContext;',
  '../observability/telemetry.js':'export const logEvent=()=>{};',
  './host-durability.js':'export async function mutateChatMetadataDurably(context,label,options,mutate){return mutate();}',
};
before(async()=>{
  globalThis.handoffContext={chatId:'handoff-chat',chatMetadata:{},chat:[{is_user:false,mes:'Mara stands in the harbor.'}]};
  hot=await hostModule('../nexus/hot-cognition.js',common);
  globalThis.handoffHot=hot;
  scene=await hostModule('../nexus/scene-intelligence.js',{
    ...common,
    './hot-cognition.js':'export const observeNexusHotSceneSignal=(args)=>globalThis.handoffHot.observeNexusHotSceneSignal(args);',
    './model-worker-bus.js':'export const enqueueNexusModelWorkerJob=()=>{throw new Error("unexpected provider call")};',
    '../sidecar/bus.js':"export const BUS_STAGE={SCENE_OBSERVATION:'scene-observation'};export const BUS_PRIORITY={SCENE_OBSERVATION:50};",
  });
  globalThis.handoffScene=scene;
  green=await hostModule('../nexus/green-room.js',{
    ...common,
    './hot-cognition.js':'export const currentNexusHotSnapshot=(args)=>globalThis.handoffHot.currentNexusHotSnapshot(args);',
    './scene-intelligence.js':'export const getNexusSceneIntelligenceView=(args)=>globalThis.handoffScene.getNexusSceneIntelligenceView(args);',
    './model-worker-bus.js':'export const enqueueNexusModelWorkerJob=(...args)=>globalThis.handoffJob(...args);',
    '../memory/character-banks.js':'export const getCharacterBanks=()=>[];',
    '../sidecar/bus.js':"export const BUS_STAGE={GREEN_ROOM:'green-room'};export const BUS_PRIORITY={GREEN_ROOM:67};",
  });
});
function start(){
  const owner=replaceNexusWorldTree();
  hot.resetNexusHotCognition({context:context()});
  scene.resetNexusSceneIntelligence({context:context()});
  green.resetNexusGreenRoom();
  return owner;
}
function observe(){
  return scene.observeNexusSceneAuthority({context:context(),gate:{mode:'MAJOR_CHANGE'},sceneScan:{scanRevision:1,acceptedScene:{participants:['Mara'],location:'Harbor',timeContext:'Morning',activity:'talking'}}});
}
function lore(owner){
  importLegacyLoreBookToWorldTree(owner,{book:'Handoff world',data:{entries:{
    mara:{uid:1,comment:'Mara',key:['Mara'],content:'Mara is at the harbor.',extensions:{nexusTemporal:{status:'CURRENT'}}},
    iris:{uid:2,comment:'Iris',key:['Iris'],content:'Iris once kept the key.',extensions:{nexusTemporal:{status:'HISTORICAL'}}},
  }}});
  return createCanonicalWorldTreeReadApi({worldTree:owner,chatId:context().chatId});
}

test('Scene integration signal reaches the actual Hot adapter',()=>{
  start();const view=observe();
  const snapshot=hot.currentNexusHotSnapshot({context:context()});
  assert.equal(snapshot.sceneId,view.sceneId);
  assert.equal(snapshot.sceneRevision,view.revision);
  assert.deepEqual(snapshot.segments.ACTIVE_CAST.value.map(row=>row.id),['Mara']);
  assert.equal(snapshot.segments.LOCATION.value,'Harbor');
});

test('Scene cast becomes the actual Green Room provider input',async()=>{
  start();const view=observe();hot.observeNexusHotNarrativeMessage({context:context(),messageIndex:0});
  let input;
  globalThis.handoffJob=(role,stage,options)=>{
    input=JSON.parse(options.prompt.split('\n').slice(1).join('\n')).data;
    const ref=input.evidence[0].ref;
    return {promise:Promise.resolve({structuredPayload:{sceneRevision:view.revision,authority:'INFERRED',characters:[{characterRef:'Mara',confidence:.8,dimensions:{warmth:.5},directEvidenceRefs:[ref],sourceRevisionSet:[input.evidence[0].sourceRevisionId]}]}})};
  };
  const result=await green.runNexusGreenRoomPostTurn({context:context()});
  assert.equal(result.updated,true,result.error?.message);
  assert.deepEqual(input.characters.map(row=>row.characterRef),view.participants);
  assert.equal(green.getNexusGreenRoomProjection({context:context()}).characters[0].characterRef,'Mara');
});

test('Hot continuity nominates canonical Lore through ActiveContinuity',()=>{
  const owner=start();observe();const api=lore(owner);
  const rows=hotContinuityCandidates(api,hot.currentNexusHotSnapshot({context:context()}),{chatId:context().chatId});
  const sensory=new NexusSensoryBackbone();
  sensory.register(createNexusCandidateChannel({channelId:'hot-continuity',candidates:rows,sourceRevisionRefs:['revision-1'],capability:RetrievalChannelCapability.ACTIVE_CONTINUITY}));
  const result=sensory.retrieveEnvelope({query:'Mara',sourceRevisionSet:['revision-1']});
  assert.ok(result.envelope.candidates.some(row=>row.evidenceIdentity===loreNodeId('Handoff world',1)));
  assert.ok(result.envelope.candidates[0].channelNominations.some(row=>row.channelId==='hot-continuity'));
});

test('Walker traversal receipt populates the actual Hot graph segment',()=>{
  const owner=start();observe();const api=lore(owner);
  owner.linkEdge({id:'handoff-edge',from:loreFactWorldNodeId('Handoff world',1),to:loreFactWorldNodeId('Handoff world',2),relation:'RELATED_TO',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['handoff']},temporal:{status:'CURRENT'}});
  const walker=new NativeGraphNeighborhoodRetriever({temporalGraph:{allClaims(){return[];},readReferences(){return{references:[]};}},isSourceRevisionCurrent:ref=>ref==='revision-1'});
  walker.registerProvider(createWorldTreeGraphProvider({worldTree:api,chatId:context().chatId,sourceRevisionRefs:['revision-1']}));
  const sensory=new NexusSensoryBackbone();sensory.register(walker);
  sensory.retrieveEnvelope({query:'Mara',anchorEntityIds:[loreNodeId('Handoff world',1)],sourceRevisionSet:['revision-1']});
  const receipt=walker.diagnostics().lastReceipt;
  assert.ok(receipt.hotNeighborhoodRefs.length);
  hot.observeNexusHotGraphNeighborhood(receipt,{context:context()});
  const graph=hot.currentNexusHotSnapshot({context:context()}).segments.GRAPH_NEIGHBORHOOD;
  assert.equal(graph.freshness,'FRESH');
  assert.deepEqual([...graph.value.refs].sort(),[...receipt.hotNeighborhoodRefs].sort());
});

test('Sensory envelope reaches Truth without losing fusion identity and references',()=>{
  const owner=start();const api=lore(owner);
  const sensory=new NexusSensoryBackbone();
  sensory.register(createNexusCandidateChannel({channelId:'lexical',candidates:[{book:'Handoff world',uid:1},{book:'Handoff world',uid:2}],sourceRevisionRefs:['revision-1']}));
  const {envelope}=sensory.retrieveEnvelope({query:'Mara',sourceRevisionSet:['revision-1']});
  const assessment=assessWorldTreeCandidates(envelope,{worldTree:api});
  assert.equal(assessment.inputEnvelope,envelope);
  assert.equal(assessment.candidateSetId,envelope.candidateSetId);
  assert.equal(assessment.fusionReceipt,envelope.fusionReceipt);
  assert.deepEqual(assessment.rows.map(row=>row.candidateId),envelope.candidates.map(row=>row.candidateId));
  for(const row of assessment.candidates){
    const original=envelope.candidates.find(candidate=>candidate.candidateId===row.candidateId);
    assert.deepEqual(row.provenance,original.provenance);
    assert.deepEqual(row.sourceRevisionRefs,original.sourceRevisionRefs);
    assert.deepEqual(row.channelNominations,original.channelNominations);
  }
  assert.equal(assessment.rows.find(row=>row.candidate.evidenceIdentity===loreNodeId('Handoff world',2)).verdict.classification,'HISTORICAL');
  const retriever=fs.readFileSync(new URL('../retrieval/retriever.js',import.meta.url),'utf8');
  assert.match(retriever,/assessWorldTreeCandidates\(sensoryResult\.envelope/);
  assert.ok(retriever.indexOf('truthAssessment.candidates.map')>retriever.indexOf('assessWorldTreeCandidates(sensoryResult.envelope'));
});
