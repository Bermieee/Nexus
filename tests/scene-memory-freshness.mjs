// Run: node --experimental-vm-modules tests/scene-memory-freshness.mjs
// Production modules, including intake/storage; only host/provider boundaries are doubled.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
if (!vm.SourceTextModule) {
  const result=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(import.meta.url)],{stdio:'inherit'});
  process.exit(result.status??1);
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function runtime(){
  let context,owner,binding=null,advice=async(_site,_input,fallback)=>({choice:fallback});
  const stubs={
    '../../../st-context.js':{getContext:()=>context},
    'observability/telemetry.js':{logEvent:()=>{}},
    'observability/system-events.js':{logSystemEvent:()=>{}},
    'world-tree/index.js':{getNexusWorldTreeOwner:()=>owner,getNexusWorldTree:()=>owner,readWorldTreeStoryBinding:()=>binding},
    'nexus/model-worker-bus.js':{enqueueNexusModelWorkerJob:()=>{throw Error('Unexpected provider call');}},
    'nexus/host-durability.js':{mutateChatMetadataDurably:async(_ctx,_label,_options,mutate)=>mutate()},
    'nexus/hot-cognition.js':{observeNexusHotSceneSignal:()=>{}},
    'sidecar/bus.js':{BUS_STAGE:{SCENE_OBSERVATION:'scene-observation'},BUS_PRIORITY:{SCENE_OBSERVATION:60}},
    'decision/task8-postturn-sites.js':{TASK8_POSTTURN_SITE_IDS:{SCENE_BOUNDARY:'scene.boundary',SCENE_PATH_CONFLICT:'scene.path',WORLD_TREE_GROWTH:'growth'},runTask8ChoiceDecision:(...args)=>advice(...args)},
  };
  const cache=new Map();
  function module(name){
    if(cache.has(name))return cache.get(name);
    const stub=stubs[name];
    const loaded=stub?new vm.SyntheticModule(Object.keys(stub),function(){for(const[k,v]of Object.entries(stub))this.setExport(k,v);},{identifier:name}):new vm.SourceTextModule(fs.readFileSync(path.join(root,name),'utf8'),{identifier:name});
    cache.set(name,loaded);return loaded;
  }
  const entry=new vm.SourceTextModule("export * as scene from './nexus/scene-intelligence.js'; export * as observation from './nexus/a52/scene/observation-specialist.js'; export * as sceneContribution from './world-tree/scene-contribution.js'; export * as memory from './world-tree/character-memory.js'; export * as intake from './world-tree/intake/runtime.js'; export * as store from './world-tree/store.js';",{identifier:'entry.js'});
  await entry.link((specifier,parent)=>module(path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier),specifier))));
  await entry.evaluate();
  owner=new entry.namespace.store.NexusWorldTree();
  return{...entry.namespace,tree:owner,setContext:value=>{context=value;},setBinding:value=>{binding=value;},setAdvice:value=>{advice=value;}};
}
const ctx=()=>({chatId:'chat-a',chatMetadata:{},chat:[{mes:'Mara tells Eris the silver compass is upstairs.',is_user:false,swipe_id:0}],saveMetadataDebounced(){}});
const budget=allowed=>({beginTurn:()=>({compute:(_id,{total})=>({allowed:Math.min(allowed,total),total,deferred:Math.max(0,total-allowed)})})});
function rawScene({id='scene-1',revision=1,cast=['Mara','Eris'],lifecycle='OPEN',end=0}={}){
  return{sceneId:id,revision,lifecycle,sourceRange:{start:0,end},sourceRevisionRefs:['scene-r'+revision],fields:{activeCast:{value:cast.map(label=>({characterId:label,label,canonicalEntityId:'character:'+label.toLowerCase(),trackedCharacter:true,state:'PRESENT'}))},location:{value:{location:'Ember Tavern'}},immediateObjects:{value:[]},activeThreads:{value:[]},activeObjectives:{value:[]},narrativeTime:{value:'evening'},atmosphere:{value:{}}}};
}
function view(record){return{chatId:'chat-a',sceneId:record.sceneId,revision:record.revision,lifecycle:record.lifecycle,participants:record.fields.activeCast.value.map(row=>row.label),participantRefs:record.fields.activeCast.value,location:'Ember Tavern',objects:[],threads:[],objectives:[],sourceRevisionRefs:record.sourceRevisionRefs};}
function writer(){const calls=[];const dispatch=(_stage,options)=>{calls.push(options);return{promise:Promise.resolve({structuredPayload:{summary:'The character remembers the compass clue.',importance:'normal',knownBy:['Mara','Eris'],about:[],mentions:[]}})};};dispatch.calls=calls;return dispatch;}
function seed(tree){for(const label of ['Mara','Eris'])tree.upsertNode({id:'character:'+label.toLowerCase(),kind:'CHARACTER',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[label]},temporal:{status:'CURRENT'},data:{label,trackedCharacter:true}});}
async function primeScene(r,context,record){const result=await r.intake.applyWorldTreeContribution(r.sceneContribution.buildWorldTreeSceneContribution({scene:view(record),tree:r.tree}),{context,tree:r.tree});assert.notEqual(result.rejected,true,JSON.stringify(result));}
const sceneScan={acceptedScene:{participants:['Mara'],location:'Old Tavern'}};
const payload={fields:{location:{value:{location:'Old Tavern'},confidence:1,observationClass:'OBSERVED'}},boundarySignals:{locationTransition:{strength:1}}};

for(const change of ['chat-switch','same-chat-reactivation','source-edit','source-retraction','story-binding-change'])test('Scene rejects held boundary advice after '+change,async()=>{
  const r=await runtime(),context=ctx();r.setContext(context);seed(r.tree);r.scene.observeNexusSceneAuthority({context,sceneScan,gate:{mode:'MINOR'}});
  let resolve,reached;const entered=new Promise(yes=>{reached=yes;});const held=new Promise(yes=>{resolve=yes;});
  r.setAdvice(async(site,_input,fallback)=>{if(site==='scene.boundary'){reached();return held;}return{choice:fallback};});
  const work=r.scene.runNexusSceneObservationPostTurn({context,sceneScan,gate:{mode:'MINOR'},enqueueSidecar:()=>({promise:Promise.resolve({structuredPayload:payload})})});
  await entered;
  if(change==='chat-switch'||change==='same-chat-reactivation'){
    const next={...ctx(),chatId:'chat-b'};r.setContext(next);r.scene.observeNexusSceneAuthority({context:next,sceneScan:{acceptedScene:{participants:['Mara'],location:'New Harbor'}},gate:{mode:'MINOR'}});
    if(change==='same-chat-reactivation'){r.setContext(context);r.scene.activateNexusSceneIntelligence({context});r.scene.observeNexusSceneAuthority({context,sceneScan:{acceptedScene:{participants:['Mara'],location:'New Harbor'}},gate:{mode:'MINOR'}});}
  }else if(change==='story-binding-change')r.setBinding({chatId:'chat-a',book:'Another Book',revision:2,writable:true});
  else if(change==='source-edit')context.chat[0].mes='Mara said nothing.';
  else r.scene.retractNexusSceneMessage({context,messageIndex:0});
  const before=r.scene.exportNexusSceneIntelligence();resolve({choice:'MINOR_SHIFT'});const result=await work;
  assert.equal(result.stale,true);assert.deepEqual(r.scene.exportNexusSceneIntelligence(),before,'stale advice must not mutate any Scene owner state');
});

test('deferred witnessed memory survives departure and metadata reload with its admitted narrative',async()=>{
  const r=await runtime(),context=ctx();r.setContext(context);seed(r.tree);const record=rawScene(),dispatch=writer();
  await primeScene(r,context,record);
  const first=await r.memory.runCharacterMemoryJob({context,tree:r.tree,sceneState:{current:record},sceneView:view(record),gate:{mode:'MINOR'},enqueueSidecar:dispatch,budgetManager:budget(1),generationId:'gen-1'});
  assert.equal(first.deferredCount,1);await r.intake.drainWorldTreeContributions({context,tree:r.tree});
  const pending=Object.values(r.memory.readCharacterMemoryState({context}).pending)[0];
  const reloaded={...ctx(),chatMetadata:structuredClone(context.chatMetadata),chat:structuredClone(context.chat)};reloaded.chat.push({is_user:false,mes:'Eris leaves. Mara alone learns a secret after the departure.'});r.setContext(reloaded);
  const latest=rawScene({revision:2,cast:[pending.characterId==='character:mara'?'Eris':'Mara'],end:1});
  await r.memory.runCharacterMemoryJob({context:reloaded,tree:r.tree,sceneState:{current:latest},sceneView:view(latest),gate:{mode:'NO_CHANGE'},enqueueSidecar:dispatch,budgetManager:budget(8),generationId:'gen-2'});
  await r.intake.drainWorldTreeContributions({context:reloaded,tree:r.tree});
  const memory=[...r.tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})].find(node=>node.data.character===pending.characterId);
  assert.ok(memory,'budget-deferred witness must eventually receive a memory');assert.equal(memory.temporal.status,'HISTORICAL');assert.equal(memory.data.status,'closed');assert.equal(memory.data.sceneRevision,1);
  assert.equal(dispatch.calls.length,2);assert.doesNotMatch(dispatch.calls[1].prompt,/Mara alone learns a secret/);assert.equal(memory.data.sourceRefs.length,1);
  const decisions=r.tree.listDecisionRecords({chatId:'chat-a',site:'character.memory',generationId:'gen-1'});
  assert.ok(decisions.some(row=>row.chosen==='DEFER'&&row.budget.deferred===1));
  const close=decisions.find(row=>row.chosen==='CLOSE');assert.ok(close);assert.equal(close.evidence.length,1);assert.ok(memory.data.decisionRecordIds.includes(close.id));assert.ok(close.reasonCodes.length>0);
  assert.ok(memory.data.decisionRecordIds.some(id=>{const row=r.tree.getDecisionRecord(id);return row?.site==='worldtree.intake'&&row.generationId==='gen-1';}));
});

test('deferred witnessed memory survives scene history eviction and closes',async()=>{
  const r=await runtime(),context=ctx();r.setContext(context);seed(r.tree);const record=rawScene(),dispatch=writer();
  await primeScene(r,context,record);
  await r.memory.runCharacterMemoryJob({context,tree:r.tree,sceneState:{current:record},sceneView:view(record),gate:{mode:'MINOR'},enqueueSidecar:dispatch,budgetManager:budget(0)});
  const latest=rawScene({id:'scene-30',cast:[]});
  await r.memory.runCharacterMemoryJob({context,tree:r.tree,sceneState:{current:latest,history:[]},sceneView:view(latest),gate:{mode:'NO_CHANGE'},enqueueSidecar:dispatch,budgetManager:budget(8)});
  await r.intake.drainWorldTreeContributions({context,tree:r.tree});
  const memories=[...r.tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})];assert.equal(memories.length,2);assert.ok(memories.every(node=>node.temporal.status==='HISTORICAL'));
});

for(const eventName of ['MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED'])test(eventName+' invalidates deferred witnessed input without resurrection after reload',async()=>{
  const r=await runtime(),context=ctx();r.setContext(context);seed(r.tree);const record=rawScene(),dispatch=writer();
  await r.memory.runCharacterMemoryJob({context,tree:r.tree,sceneState:{current:record},sceneView:view(record),gate:{mode:'MINOR'},enqueueSidecar:dispatch,budgetManager:budget(0)});
  if(eventName==='MESSAGE_DELETED')context.chat.splice(0,1);
  else if(eventName==='MESSAGE_SWIPED'){context.chat[0].mes='Mara said nothing.';context.chat[0].swipe_id=1;}
  else context.chat[0].mes='Mara said nothing.';
  await r.memory.invalidateCharacterMemoriesForMessage({context,tree:r.tree,messageIndex:0,eventName});
  assert.equal(Object.keys(r.memory.readCharacterMemoryState({context}).pending).length,0,'source invalidation removes admitted stale work');
  const reload={...ctx(),chatMetadata:structuredClone(context.chatMetadata),chat:structuredClone(context.chat)};r.setContext(reload);const latest=rawScene({revision:2,cast:[]});
  await r.memory.runCharacterMemoryJob({context:reload,tree:r.tree,sceneState:{current:latest},sceneView:view(latest),gate:{mode:'NO_CHANGE'},enqueueSidecar:dispatch,budgetManager:budget(8)});
  assert.equal(dispatch.calls.length,0);assert.equal([...r.tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})].length,0);
});

test('writer results are rejected when admitted source changes during the call',async()=>{
  const r=await runtime(),context=ctx();r.setContext(context);seed(r.tree);const record=rawScene();let finish,reached;const entered=new Promise(yes=>{reached=yes;});
  const work=r.memory.runCharacterMemoryJob({context,tree:r.tree,sceneState:{current:record},sceneView:view(record),gate:{mode:'MINOR'},enqueueSidecar:()=>{reached();return{promise:new Promise(yes=>{finish=yes;})};},budgetManager:budget(1)});
  await entered;context.chat[0].mes='There was no clue.';await r.memory.invalidateCharacterMemoriesForMessage({context,tree:r.tree,messageIndex:0});finish({structuredPayload:{summary:'Mara remembers the removed clue.',importance:'normal',knownBy:[],about:[],mentions:[]}});await work;
  assert.equal(r.intake.readWorldTreeContributionQueue({context}).length,0);assert.equal(Object.keys(r.memory.readCharacterMemoryState({context}).pending).length,0,'stale writer must not restore invalidated pending rows');
});

test('scene close records the generation decision and keeps it reachable from the closed memory',async()=>{
  const r=await runtime(),context=ctx();r.setContext(context);seed(r.tree);const record=rawScene({cast:['Mara']}),dispatch=writer();await primeScene(r,context,record);
  await r.memory.runCharacterMemoryJob({context,tree:r.tree,sceneState:{current:record},sceneView:view(record),gate:{mode:'MINOR'},enqueueSidecar:dispatch,budgetManager:budget(8),generationId:'gen-1'});await r.intake.drainWorldTreeContributions({context,tree:r.tree});
  const closed=rawScene({cast:['Mara'],lifecycle:'CLOSED',revision:2}),latest=rawScene({id:'scene-2',cast:[]});
  await r.memory.runCharacterMemoryJob({context,tree:r.tree,sceneState:{current:latest,history:[closed]},sceneView:view(latest),gate:{mode:'NO_CHANGE'},enqueueSidecar:dispatch,budgetManager:budget(8),generationId:'gen-2'});await r.intake.drainWorldTreeContributions({context,tree:r.tree});
  const decision=r.tree.listDecisionRecords({site:'character.memory',generationId:'gen-2'}).find(row=>row.chosen==='CLOSE');assert.ok(decision);
  const memory=[...r.tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})][0];assert.equal(memory.data.status,'closed');assert.ok(memory.data.decisionRecordIds.includes(decision.id));assert.ok(memory.data.decisionRecordIds.some(id=>r.tree.getDecisionRecord(id)?.generationId==='gen-1'));
  assert.ok(memory.data.decisionRecordIds.some(id=>{const row=r.tree.getDecisionRecord(id);return row?.site==='worldtree.intake'&&row.generationId==='gen-2';}));
});
test('memory state transitions use complete incident edges beyond the display projection',async()=>{
  const r=await runtime(),context=ctx();r.setContext(context);seed(r.tree);
  for(let i=0;i<5002;i++)r.tree.upsertNode({id:'background:'+i,kind:'ENTITY',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['background:'+i]},data:{label:'Background '+i}});
  const record=rawScene({cast:['Mara']});await primeScene(r,context,record);
  await r.memory.runCharacterMemoryJob({context,tree:r.tree,sceneState:{current:record},sceneView:view(record),gate:{mode:'MINOR'},enqueueSidecar:writer(),budgetManager:budget(8)});
  await r.intake.drainWorldTreeContributions({context,tree:r.tree});
  const closed=rawScene({cast:['Mara'],lifecycle:'CLOSED',revision:2}),latest=rawScene({id:'scene-2',cast:[]});
  await r.memory.runCharacterMemoryJob({context,tree:r.tree,sceneState:{current:latest,history:[closed]},sceneView:view(latest),gate:{mode:'NO_CHANGE'},enqueueSidecar:writer(),budgetManager:budget(8)});
  const drained=await r.intake.drainWorldTreeContributions({context,tree:r.tree});assert.equal(drained.rejectedCount,0);
  const memory=[...r.tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})][0];assert.equal(memory.data.status,'closed');
  assert.ok([...r.tree.iterateEdges({chatId:'chat-a'})].some(edge=>edge.from===memory.id&&edge.relation==='derived-from'&&edge.temporal.status==='HISTORICAL'));
});

test('a committed Scene observation retracts the fields attributed to its original message',async()=>{
  const r=await runtime(),context=ctx();r.setContext(context);seed(r.tree);r.scene.observeNexusSceneAuthority({context,sceneScan,gate:{mode:'MINOR'}});
  await r.scene.runNexusSceneObservationPostTurn({context,sceneScan,gate:{mode:'MINOR'},enqueueSidecar:()=>({promise:Promise.resolve({structuredPayload:payload})})});
  const result=r.scene.retractNexusSceneMessage({context,messageIndex:0,eventName:'MESSAGE_EDITED'});
  assert.ok(result.affectedFields>0);assert.equal(r.scene.exportNexusSceneIntelligence().current.fields.location.observationClass,'UNKNOWN');
});

test('Scene contribution views preserve source revisions and explicit generic place containment',async()=>{
  const r=await runtime(),context=ctx();r.setContext(context);seed(r.tree);
  r.scene.observeNexusSceneAuthority({context,sceneScan:{acceptedScene:{participants:['Mara'],location:'Back room',parentLocation:'Ember Tavern'}},gate:{mode:'MINOR'}});
  const before=r.scene.getNexusSceneIntelligenceView({chatId:'chat-a'});assert.deepEqual(before.sourceRange,{start:0,end:0});assert.equal(before.parentLocation,'Ember Tavern');assert.equal(before.sourceMessageRefs.length,1);
  context.chat[0].mes='The original place observation was edited away.';const after=r.scene.getNexusSceneIntelligenceView({chatId:'chat-a'});
  assert.deepEqual(after.sourceMessageRefs,before.sourceMessageRefs,'reads must preserve the observed source revision instead of rehashing edited evidence');
  const retracted=r.scene.retractNexusSceneMessage({context,messageIndex:0});assert.ok(retracted.affectedFields>0);assert.equal(r.scene.exportNexusSceneIntelligence().current.fields.location.observationClass,'UNKNOWN');
});

for(const [place,parent] of [['Laboratory','Orion Observatory'],['Archives','Cedar Academy']])test('worker JSON grows explicit '+place+' containment through Scene and story contribution',async()=>{
  const r=await runtime(),context=ctx(),narrative='Mara enters the '+place+' inside '+parent+'.';context.chat[0].mes=narrative;r.setContext(context);r.setBinding({chatId:'chat-a',book:'A',revision:1,writable:true});
  r.tree.upsertNode({id:'known-parent',kind:'LOCATION',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['known-parent']},data:{label:parent,book:'A'}});
  const scan={acceptedScene:{participants:[],location:parent}};r.scene.observeNexusSceneAuthority({context,sceneScan:scan,gate:{mode:'MINOR'}});
  const raw={fields:{location:{value:{location:place,parentLocation:parent,containmentEvidence:narrative},confidence:1,observationClass:'OBSERVED'}},boundarySignals:{}};
  let input,verdict;
  const run=await r.scene.runNexusSceneObservationPostTurn({context,sceneScan:scan,gate:{mode:'MINOR'},enqueueSidecar:(_stage,options)=>{
    input=JSON.parse(options.prompt.split('\n').slice(1).join('\n')).data;verdict=options.structuredValidator(raw);
    return{promise:Promise.resolve({text:JSON.stringify(raw)})};
  }});
  assert.deepEqual(input.locationObservation?.parentLocation,{type:'string|null',requires:'explicit spatial containment in narrative'});assert.equal(verdict.valid,true);assert.equal(verdict.value.fields.location.value.parentLocation,parent);
  assert.equal(run.updated,true);assert.equal(run.scene.parentLocation,parent);
  const persisted=structuredClone(context.chatMetadata),other={...ctx(),chatId:'chat-other'};r.setContext(other);r.scene.activateNexusSceneIntelligence({context:other});context.chatMetadata=persisted;r.setContext(context);r.scene.activateNexusSceneIntelligence({context});
  const restored=r.scene.getNexusSceneIntelligenceView({chatId:'chat-a'});assert.equal(restored.parentLocation,parent);
  await r.sceneContribution.runWorldTreeSceneContributionJob({context,tree:r.tree,sceneView:restored,sceneState:r.scene.exportNexusSceneIntelligence()});
  const result=await r.intake.drainWorldTreeContributions({context,tree:r.tree});assert.equal(result.rejectedCount,0);
  const child=[...r.tree.iterateNodes({chatId:'chat-a',kind:'LOCATION'})].find(node=>node.data.label===place);assert.ok(child);
  assert.ok([...r.tree.edges.values()].some(edge=>edge.from===child.id&&edge.to==='known-parent'&&edge.relation==='part-of'&&edge.temporal.status==='CURRENT'));
});

for(const narrative of ['Mara leaves Orion Observatory and arrives at Laboratory.','Mara enters Laboratory.'])test('worker parent claims without explicit source containment cannot create hierarchy: '+narrative,async()=>{
  const r=await runtime(),context=ctx();context.chat[0].mes=narrative;r.setContext(context);r.tree.upsertNode({id:'known-parent',kind:'LOCATION',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['known-parent']},data:{label:'Orion Observatory'}});
  const scan={acceptedScene:{participants:[],location:'Orion Observatory'}};r.scene.observeNexusSceneAuthority({context,sceneScan:scan,gate:{mode:'MINOR'}});
  const raw={fields:{location:{value:{location:'Laboratory',parentLocation:'Orion Observatory',containmentEvidence:narrative},confidence:1,observationClass:'OBSERVED'}},boundarySignals:{}};
  const run=await r.scene.runNexusSceneObservationPostTurn({context,sceneScan:scan,gate:{mode:'MINOR'},enqueueSidecar:()=>({promise:Promise.resolve({text:JSON.stringify(raw)})})});
  assert.equal(run.scene.location,'Laboratory');assert.equal(run.scene.parentLocation,null);
  const contribution=r.sceneContribution.buildWorldTreeSceneContribution({context,tree:r.tree,scene:run.scene});assert.equal(contribution.edges.some(edge=>edge.meaning==='part-of'),false);
});

test('foreign-book parent mention never becomes a containment endpoint',async()=>{
  const r=await runtime(),context=ctx(),narrative='Mara enters Laboratory inside Other Observatory.';context.chat[0].mes=narrative;r.setContext(context);r.setBinding({chatId:'chat-a',book:'A',revision:1,writable:true});
  r.tree.upsertNode({id:'foreign-parent',kind:'LOCATION',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['foreign-parent']},data:{label:'Other Observatory',book:'B'}});
  const scan={acceptedScene:{participants:[],location:'Laboratory'}};r.scene.observeNexusSceneAuthority({context,sceneScan:scan,gate:{mode:'MINOR'}});
  const raw={fields:{location:{value:{location:'Laboratory',parentLocation:'Other Observatory',containmentEvidence:narrative},confidence:1,observationClass:'OBSERVED'}},boundarySignals:{}};
  const run=await r.scene.runNexusSceneObservationPostTurn({context,sceneScan:scan,gate:{mode:'MINOR'},enqueueSidecar:()=>({promise:Promise.resolve({text:JSON.stringify(raw)})})});
  await r.sceneContribution.runWorldTreeSceneContributionJob({context,tree:r.tree,sceneView:run.scene,sceneState:r.scene.exportNexusSceneIntelligence()});await r.intake.drainWorldTreeContributions({context,tree:r.tree});
  assert.equal([...r.tree.edges.values()].some(edge=>edge.to==='foreign-parent'||edge.from==='foreign-parent'),false);
});

for(const eventName of ['MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED'])test('committed character memory cleanup survives '+eventName+' and the real intake drain',async()=>{
  const r=await runtime(),context=ctx();r.setContext(context);seed(r.tree);const record=rawScene({cast:['Mara']});await primeScene(r,context,record);
  await r.memory.runCharacterMemoryJob({context,tree:r.tree,sceneState:{current:record},sceneView:view(record),gate:{mode:'MINOR'},enqueueSidecar:writer(),budgetManager:budget(8),generationId:'original-generation'});
  await r.intake.drainWorldTreeContributions({context,tree:r.tree});const node=[...r.tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})][0];assert.ok(node);
  const originalRefs=structuredClone(node.data.sourceRefs);
  if(eventName==='MESSAGE_DELETED')context.chat.splice(0,1);else{context.chat[0].mes='Mara heard no clue.';if(eventName==='MESSAGE_SWIPED')context.chat[0].swipe_id=1;}
  await r.memory.invalidateCharacterMemoriesForMessage({context,tree:r.tree,messageIndex:0,eventName});
  const reloaded={...context,chatMetadata:structuredClone(context.chatMetadata),chat:structuredClone(context.chat)};r.setContext(reloaded);
  const result=await r.intake.drainWorldTreeContributions({context:reloaded,tree:r.tree});assert.equal(result.rejectedCount,0);const after=r.tree.getNode(node.id,{chatId:'chat-a'});
  assert.equal(after.temporal.status,'SUPERSEDED');assert.equal(after.data.status,'superseded');assert.deepEqual(after.data.sourceRefs,originalRefs);assert.deepEqual(after.provenance,node.provenance);
  assert.equal([...r.tree.edges.values()].some(edge=>edge.from===node.id&&edge.temporal.status==='CURRENT'),false);
});

for(const eventName of ['MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED'])test('Scene retraction after '+eventName+' never republishes deleted place evidence across reload',async()=>{
  const r=await runtime(),context=ctx(),narrative='Mara enters Laboratory inside Orion Observatory.';context.chat[0].mes=narrative;r.setContext(context);
  r.tree.upsertNode({id:'known-parent',kind:'LOCATION',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['known-parent']},data:{label:'Orion Observatory'}});
  const scan={acceptedScene:{participants:[],location:'Orion Observatory'}};r.scene.observeNexusSceneAuthority({context,sceneScan:scan,gate:{mode:'MINOR'}});
  const raw={fields:{location:{value:{location:'Laboratory',parentLocation:'Orion Observatory',containmentEvidence:narrative},confidence:1,observationClass:'OBSERVED'}},boundarySignals:{}};
  await r.scene.runNexusSceneObservationPostTurn({context,sceneScan:scan,gate:{mode:'MINOR'},enqueueSidecar:()=>({promise:Promise.resolve({text:JSON.stringify(raw)})})});
  await r.sceneContribution.runWorldTreeSceneContributionJob({context,tree:r.tree,sceneView:r.scene.getNexusSceneIntelligenceView({chatId:'chat-a'}),sceneState:r.scene.exportNexusSceneIntelligence()});await r.intake.drainWorldTreeContributions({context,tree:r.tree});
  const child=[...r.tree.iterateNodes({chatId:'chat-a',kind:'LOCATION'})].find(node=>node.data.label==='Laboratory');assert.ok(child);
  if(eventName==='MESSAGE_DELETED')context.chat.splice(0,1);else{context.chat[0].mes='Mara remains outdoors.';if(eventName==='MESSAGE_SWIPED')context.chat[0].swipe_id=1;}
  r.scene.retractNexusSceneMessage({context,messageIndex:0,eventName});await r.scene.persistNexusSceneIntelligence({context});
  const saved=structuredClone(context.chatMetadata),other={...ctx(),chatId:'another-chat'};r.setContext(other);r.scene.activateNexusSceneIntelligence({context:other});context.chatMetadata=saved;r.setContext(context);r.scene.activateNexusSceneIntelligence({context});
  const state=r.scene.exportNexusSceneIntelligence(),scene=r.scene.getNexusSceneIntelligenceView({chatId:'chat-a'});assert.equal(scene.location,null);assert.equal(scene.parentLocation,null);assert.equal(r.sceneContribution.sceneRecordToContributionView(state.current,{chatId:'chat-a'}).location,null);
  await r.sceneContribution.runWorldTreeSceneContributionJob({context,tree:r.tree,sceneView:scene,sceneState:state});const result=await r.intake.drainWorldTreeContributions({context,tree:r.tree});assert.equal(result.rejectedCount,0);
  assert.equal(r.tree.getNode(child.id,{chatId:'chat-a'}).temporal.status,'SUPERSEDED');assert.equal([...r.tree.edges.values()].some(edge=>edge.from===child.id&&edge.relation==='part-of'&&edge.temporal.status==='CURRENT'),false);
});

for(const change of ['summary','target-revision','binding'])test('character memory state cleanup rejects changed '+change+' rather than admitting new evidence',async()=>{
  const r=await runtime(),context=ctx();r.setContext(context);seed(r.tree);const record=rawScene({cast:['Mara']});await primeScene(r,context,record);
  await r.memory.runCharacterMemoryJob({context,tree:r.tree,sceneState:{current:record},sceneView:view(record),gate:{mode:'MINOR'},enqueueSidecar:writer(),budgetManager:budget(8)});await r.intake.drainWorldTreeContributions({context,tree:r.tree});
  const node=[...r.tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})][0];context.chat[0].mes='Mara heard no clue.';
  if(change==='binding')r.setBinding({chatId:'chat-a',book:'A',revision:1,writable:true});
  await r.memory.invalidateCharacterMemoriesForMessage({context,tree:r.tree,messageIndex:0});
  if(change==='summary')context.chatMetadata.nexus_world_tree_intake_queue_v1.items[0].contribution.nodes[0].fields.summary='New invented canon from a forged cleanup.';
  else if(change==='target-revision')r.tree.upsertNode({...node,data:{...node.data,summary:'A newer legitimate memory revision.'}});
  else r.setBinding({chatId:'chat-a',book:'B',revision:2,writable:true});
  const before=r.tree.getNode(node.id,{chatId:'chat-a'}),result=await r.intake.drainWorldTreeContributions({context,tree:r.tree});assert.equal(result.rejectedCount,1);assert.deepEqual(r.tree.getNode(node.id,{chatId:'chat-a'}),before);
});

test('editing a witnessed message retracts its closed Scene history and supersedes the old place contribution',async()=>{
  const r=await runtime(),context=ctx(),narrative='Mara enters Laboratory inside Orion Observatory.';context.chat[0].mes=narrative;r.setContext(context);
  r.tree.upsertNode({id:'known-parent',kind:'LOCATION',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['known-parent']},data:{label:'Orion Observatory'}});
  const scan={scanRevision:1,acceptedScene:{participants:[],location:'Orion Observatory'}};r.scene.observeNexusSceneAuthority({context,sceneScan:scan,gate:{mode:'MINOR'}});
  const raw={fields:{location:{value:{location:'Laboratory',parentLocation:'Orion Observatory',containmentEvidence:narrative},confidence:1,observationClass:'OBSERVED'}},boundarySignals:{}};
  await r.scene.runNexusSceneObservationPostTurn({context,sceneScan:scan,gate:{mode:'MINOR'},enqueueSidecar:()=>({promise:Promise.resolve({text:JSON.stringify(raw)})})});
  context.chat.push({is_user:false,mes:'Mara now stands in Open Meadow.'});r.scene.observeNexusSceneAuthority({context,sceneScan:{scanRevision:2,acceptedScene:{participants:[],location:'Open Meadow'}},gate:{mode:'MAJOR'}});
  await r.sceneContribution.runWorldTreeSceneContributionJob({context,tree:r.tree,sceneView:r.scene.getNexusSceneIntelligenceView({chatId:'chat-a'}),sceneState:r.scene.exportNexusSceneIntelligence()});await r.intake.drainWorldTreeContributions({context,tree:r.tree});
  const child=[...r.tree.iterateNodes({chatId:'chat-a',kind:'LOCATION'})].find(node=>node.data.label==='Laboratory');assert.ok(child);
  context.chat[0].mes='Mara never entered the laboratory.';r.scene.retractNexusSceneMessage({context,messageIndex:0});
  const state=r.scene.exportNexusSceneIntelligence();assert.equal(r.sceneContribution.sceneRecordToContributionView(state.history[0],{chatId:'chat-a'}).location,null);
  await r.sceneContribution.runWorldTreeSceneContributionJob({context,tree:r.tree,sceneView:r.scene.getNexusSceneIntelligenceView({chatId:'chat-a'}),sceneState:state});const result=await r.intake.drainWorldTreeContributions({context,tree:r.tree});assert.equal(result.rejectedCount,0);assert.equal(r.tree.getNode(child.id,{chatId:'chat-a'}).temporal.status,'SUPERSEDED');
});
