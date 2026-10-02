import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NexusWorldTree } from '../world-tree/store.js';
import { applyWorldTreeContribution, drainWorldTreeContributions } from '../world-tree/intake/runtime.js';
import { buildWorldTreeSceneContribution } from '../world-tree/scene-contribution.js';
import { setWorldTreeCharacterTracking } from '../world-tree/tracking.js';
import {
  createCharacterMemoryRetrievalChannel, characterMemoryRenderBlocks, invalidateCharacterMemoriesForMessage,
  readCharacterMemoryState, retrieveCharacterMemoriesForPrompt, runCharacterMemoryJob,
} from '../world-tree/character-memory.js';
import { RetrievalChannelRegistry } from '../nexus/a52/retrieval-channel-registry.js';
import { createRetrievalIntent } from '../nexus/a52/candidate-bus-contracts.js';
import { createCanonicalWorldTreeReadApi } from '../core/world-tree-api.js';
import { createWorldTreeGraphProvider } from '../nexus/a52/sensory/walker/world-tree-provider.js';
import { createPostTurnJobTable, POST_TURN_JOBS } from '../scheduler/jobs.js';

function ctx(){return{chatId:'chat-a',chatMetadata:{},chat:[
  {is_user:true,mes:'Mara and Eris enter the Ember Tavern.',swipe_id:0},
  {is_user:false,mes:'Eris tells Mara that the silver compass is hidden upstairs.',swipe_id:0},
],saveMetadataDebounced(){}};}
function globalNode(tree,id,label,kind='CHARACTER',extra={}){
  tree.upsertNode({id,kind,scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[id]},temporal:{status:'CURRENT'},data:{label,aliases:[label],...extra}});
  if(kind==='CHARACTER'||extra.trackedCharacter===true)try{tree.registerIdentity({nodeId:id,canonicalLabel:label,entityType:'CHARACTER',aliases:[label],providerId:'TEST',sourceEntityId:id,authorityOrigin:'OWNER_EXPLICIT'});}catch{}
}
function rawScene({sceneId='scene-1',revision=1,lifecycle='OPEN',cast=['Mara','Eris'],location='Ember Tavern',start=0,end=1}={}){
  return{sceneId,revision,lifecycle,sourceRange:{start,end},sourceRevisionRefs:['scene-r'+revision],fields:{
    activeCast:{value:cast.map(name=>({characterId:name,label:name,canonicalEntityId:'character:'+name.toLowerCase(),trackedCharacter:true,state:'PRESENT'}))},
    location:{value:{location}},immediateObjects:{value:[{objectId:'silver compass'}]},activeThreads:{value:[{threadId:'find the compass'}]},
    activeObjectives:{value:[]},narrativeTime:{value:'evening'},atmosphere:{value:{activity:'conversation',focus:'the compass',relationshipFocus:false}},
  }};
}
function sceneView(record,chatId='chat-a'){
  const cast=record.fields.activeCast.value;return{chatId,sceneId:record.sceneId,revision:record.revision,lifecycle:record.lifecycle,participants:cast.map(r=>r.label),participantRefs:cast.map(r=>({id:r.characterId,label:r.label,canonicalEntityId:r.canonicalEntityId,trackedCharacter:true})),
    location:record.fields.location.value.location,objects:['silver compass'],threads:['find the compass'],objectives:[],activity:'conversation',focus:'the compass',narrativeTime:'evening',sourceRevisionRefs:[...record.sourceRevisionRefs]};
}
function sidecar(summary='Mara remembers being told about the hidden compass.',knownBy=['Mara','Eris']){
  const calls=[];const dispatch=(stage,options)=>{calls.push({stage,options});return{promise:Promise.resolve({structuredPayload:{summary,importance:'normal',knownBy,about:['Eris'],mentions:['silver compass']},tv2:{slot:'A'}})};};dispatch.calls=calls;return dispatch;
}
function budget(allowed){return{beginTurn(){return{compute(_id,{total}){const n=Math.min(total,allowed);return{allowed:n,deferred:total-n,total};}};}};}
async function primeScene(tree,context,record){
  const view=sceneView(record);await applyWorldTreeContribution(buildWorldTreeSceneContribution({scene:view,tree}),{tree,context});return view;
}
function setup(){
  const tree=new NexusWorldTree(),context=ctx();globalNode(tree,'character:mara','Mara','CHARACTER',{trackedCharacter:true,tracking:'active'});globalNode(tree,'character:eris','Eris','CHARACTER',{trackedCharacter:true,tracking:'active'});globalNode(tree,'character:nox','Nox','CHARACTER',{trackedCharacter:true,tracking:'active'});globalNode(tree,'location:ember','Ember Tavern','LOCATION');globalNode(tree,'item:compass','silver compass','ITEM');
  return{tree,context};
}

test('Task 4 keeps one open CHARACTER_MEMORY per present tracked character per scene and updates instead of duplicating',async()=>{
  const {tree,context}=setup(),record=rawScene(),view=await primeScene(tree,context,record),writer=sidecar();
  let result=await runCharacterMemoryJob({context,tree,gate:{mode:'MINOR'},sceneState:{chatId:'chat-a',history:[],current:record},sceneView:view,enqueueSidecar:writer,budgetManager:budget(8)});
  assert.equal(result.createdCount,2);assert.equal(writer.calls.length,2);let drain=await drainWorldTreeContributions({context,tree});assert.equal(drain.rejectedCount,0);
  let memories=[...tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})].filter(n=>n.temporal.status==='CURRENT');assert.equal(memories.length,2);assert.ok(memories.every(n=>n.data.status==='open'));assert.ok(memories.every(n=>n.data.knownBy.includes(n.data.character)));
  context.chat.push({is_user:false,mes:'Mara asks Eris to lead the way upstairs.',swipe_id:0});record.revision=2;record.sourceRange.end=2;view.revision=2;
  result=await runCharacterMemoryJob({context,tree,gate:{mode:'MINOR'},sceneState:{chatId:'chat-a',history:[],current:record},sceneView:view,enqueueSidecar:sidecar('Mara remembers Eris revealed the compass location and agreed to lead upstairs.'),budgetManager:budget(8)});
  assert.equal(result.updatedCount,2);await drainWorldTreeContributions({context,tree});const after=[...tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})];assert.equal(after.length,2,'same scene must update stable memory nodes rather than duplicate them');
});

test('absent tracked characters receive no memory and source provenance is bounded with remembers/derived-from edges',async()=>{
  const {tree,context}=setup(),record=rawScene({cast:['Mara']}),view=await primeScene(tree,context,record),writer=sidecar('Mara remembers the compass clue.',['Mara']);
  await runCharacterMemoryJob({context,tree,gate:{mode:'MINOR'},sceneState:{chatId:'chat-a',history:[],current:record},sceneView:view,enqueueSidecar:writer,budgetManager:budget(8)});await drainWorldTreeContributions({context,tree});
  const memories=[...tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})];assert.equal(memories.length,1);assert.equal(memories[0].data.character,'character:mara');assert.ok(memories[0].provenance.messageRefs.length<=6);
  const edges=tree.read({chatId:'chat-a',limit:5000}).edges.filter(e=>e.temporal.status==='CURRENT');assert.ok(edges.some(e=>e.from==='character:mara'&&e.to===memories[0].id&&e.relation==='remembers'));assert.ok(edges.some(e=>e.from===memories[0].id&&e.relation==='derived-from'));
});

test('scene close closes an existing open memory and Truth status becomes HISTORICAL',async()=>{
  const {tree,context}=setup(),open=rawScene({cast:['Mara']}),view=await primeScene(tree,context,open);
  await runCharacterMemoryJob({context,tree,gate:{mode:'MINOR'},sceneState:{chatId:'chat-a',history:[],current:open},sceneView:view,enqueueSidecar:sidecar('Mara remembers the tavern clue.',['Mara']),budgetManager:budget(8)});await drainWorldTreeContributions({context,tree});
  const closed={...structuredClone(open),lifecycle:'CLOSED'},next=rawScene({sceneId:'scene-2',revision:1,cast:[],start:1,end:1});
  const result=await runCharacterMemoryJob({context,tree,gate:{mode:'MAJOR'},sceneState:{chatId:'chat-a',history:[closed],current:next},sceneView:sceneView(next),enqueueSidecar:sidecar(),budgetManager:budget(8)});assert.equal(result.closedCount,1);await drainWorldTreeContributions({context,tree});
  const memory=[...tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})][0];assert.equal(memory.data.status,'closed');assert.equal(memory.temporal.status,'HISTORICAL');
});

test('edit supersedes the affected memory, advances rebuild epoch, and next run creates a new node',async()=>{
  const {tree,context}=setup(),record=rawScene({cast:['Mara']}),view=await primeScene(tree,context,record);
  await runCharacterMemoryJob({context,tree,gate:{mode:'MINOR'},sceneState:{chatId:'chat-a',history:[],current:record},sceneView:view,enqueueSidecar:sidecar('Mara remembers the first version.',['Mara']),budgetManager:budget(8)});await drainWorldTreeContributions({context,tree});
  const before=[...tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})][0];
  const invalid=await invalidateCharacterMemoriesForMessage({context,tree,messageIndex:1,eventName:'MESSAGE_EDITED'});assert.equal(invalid.supersededCount,1);await drainWorldTreeContributions({context,tree});assert.equal(tree.getNode(before.id,{chatId:'chat-a'}).temporal.status,'SUPERSEDED');
  context.chat[1]={is_user:false,mes:'Eris instead tells Mara the compass is under the stairs.',swipe_id:1};record.revision=2;view.revision=2;
  await runCharacterMemoryJob({context,tree,gate:{mode:'MINOR'},eventType:'MESSAGE_EDITED',sceneState:{chatId:'chat-a',history:[],current:record},sceneView:view,enqueueSidecar:sidecar('Mara remembers Eris corrected the clue: the compass is under the stairs.',['Mara']),budgetManager:budget(8)});await drainWorldTreeContributions({context,tree});
  const current=[...tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})].filter(n=>n.temporal.status==='CURRENT');assert.equal(current.length,1);assert.notEqual(current[0].id,before.id);assert.equal(current[0].data.rebuildEpoch,1);
});

test('budget overflow persists as background-pending work and is processed on a later NO_CHANGE pass',async()=>{
  const {tree,context}=setup(),record=rawScene({cast:['Mara','Eris','Nox']}),view=await primeScene(tree,context,record),writer=sidecar();
  const first=await runCharacterMemoryJob({context,tree,gate:{mode:'MINOR'},sceneState:{chatId:'chat-a',history:[],current:record},sceneView:view,enqueueSidecar:writer,budgetManager:budget(1)});assert.equal(first.queuedCount,1);assert.equal(first.deferredCount,2);assert.equal(Object.keys(readCharacterMemoryState({context}).pending).length,2);await drainWorldTreeContributions({context,tree});
  const second=await runCharacterMemoryJob({context,tree,gate:{mode:'NO_CHANGE'},sceneState:{chatId:'chat-a',history:[],current:record},sceneView:view,enqueueSidecar:writer,budgetManager:budget(8)});assert.equal(second.queuedCount,2);assert.equal(second.deferredCount,0);await drainWorldTreeContributions({context,tree});assert.equal([...tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})].filter(n=>n.temporal.status==='CURRENT').length,3);
});

test('tracking off pauses existing memories without deleting them',async()=>{
  const {tree,context}=setup(),record=rawScene({cast:['Mara']}),view=await primeScene(tree,context,record);
  await runCharacterMemoryJob({context,tree,gate:{mode:'MINOR'},sceneState:{chatId:'chat-a',history:[],current:record},sceneView:view,enqueueSidecar:sidecar('Mara remembers the clue.',['Mara']),budgetManager:budget(8)});await drainWorldTreeContributions({context,tree});
  const before=[...tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})][0];await setWorldTreeCharacterTracking({nodeId:'character:mara',tracked:false,tree,context});
  const after=tree.getNode(before.id,{chatId:'chat-a'});assert.ok(after);assert.equal(after.data.status,'tracking-paused');assert.equal(after.temporal.status,'HISTORICAL');
});

test('character-memory Sensory Net channel ranks only ACTIVE_CAST memories and MEMORY rendering groups them per character',async()=>{
  const {tree,context}=setup(),record=rawScene({cast:['Mara','Eris']}),view=await primeScene(tree,context,record);
  await runCharacterMemoryJob({context,tree,gate:{mode:'MINOR'},sceneState:{chatId:'chat-a',history:[],current:record},sceneView:view,enqueueSidecar:sidecar(),budgetManager:budget(8)});await drainWorldTreeContributions({context,tree});
  const registry=new RetrievalChannelRegistry();registry.register(createCharacterMemoryRetrievalChannel({tree,chatId:'chat-a',activeCharacterIds:['character:mara'],locationId:'location:ember',participantIds:['character:eris']}));
  const result=registry.retrieveAllSync({intents:[createRetrievalIntent({intentId:'turn',kind:'CURRENT',query:'compass',entityRefs:['character:mara']})],context:{},channelIds:['character-memory']});
  assert.ok(result.nominations.length>=1);assert.ok(result.nominations.every(n=>n.metadata.characterId==='character:mara'));assert.equal(result.channelReceipts[0].channelId,'character-memory');
  const blocks=characterMemoryRenderBlocks(result.nominations.map(n=>tree.getNode(n.candidateId,{chatId:'chat-a'})).map(n=>({id:n.id,...n.data})));assert.ok(blocks.some(b=>b.text.startsWith('Mara remembers')));
  const recallCode=fs.readFileSync(new URL('../memory/recall.js',import.meta.url),'utf8');assert.ok(recallCode.includes('retrieveCharacterMemoriesForPrompt'));assert.ok(recallCode.includes('characterMemoryRenderBlocks'));assert.ok(recallCode.includes('publishMemoryRecallOutlet'));
});

test('Walker can traverse character -> memory -> location and sees the summary representation',async()=>{
  const {tree,context}=setup(),record=rawScene({cast:['Mara']}),view=await primeScene(tree,context,record);
  await runCharacterMemoryJob({context,tree,gate:{mode:'MINOR'},sceneState:{chatId:'chat-a',history:[],current:record},sceneView:view,enqueueSidecar:sidecar('Mara remembers Eris said the compass is upstairs.',['Mara']),budgetManager:budget(8)});await drainWorldTreeContributions({context,tree});
  const read=createCanonicalWorldTreeReadApi({chatId:'chat-a',worldTree:tree}),provider=createWorldTreeGraphProvider({worldTree:read,chatId:'chat-a'}),edges=provider.query({anchorEntityIds:['character:mara'],maxDepth:2,maxEdges:32});
  assert.ok(edges.some(e=>e.edgeMeaning==='remembers'&&e.toEntityId.includes('contribution-node:character-memory')));assert.ok(edges.some(e=>e.representationText.includes('remembers')||e.representationText.includes('compass')));
});

test('scheduler runs character.memory after scene contributions and intake waits for it; implementation has no direct Tree writes',()=>{
  assert.ok(POST_TURN_JOBS.some(row=>row.id==='character.memory'&&row.needsSidecar===true));
  const executors={'worldtree.contribute.scene':async()=>({}),'character.memory':async()=>({}),'worldtree.intake':async()=>({})},table=createPostTurnJobTable(executors),memory=table.find(row=>row.id==='character.memory'),intake=table.find(row=>row.id==='worldtree.intake');
  assert.deepEqual(memory.dependencies,['worldtree.contribute.scene']);assert.deepEqual(intake.dependencies,['worldtree.contribute.scene','character.memory']);
  const code=fs.readFileSync(new URL('../world-tree/character-memory.js',import.meta.url),'utf8');assert.equal(code.includes('tree.upsertNode('),false);assert.equal(code.includes('tree.linkEdge('),false);assert.ok(code.includes('enqueueWorldTreeContribution'));assert.ok(code.includes("logEvent('character-memory'"));
});
