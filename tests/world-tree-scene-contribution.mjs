import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NexusWorldTree } from '../world-tree/store.js';
import { buildWorldTreeSceneContribution, buildWorldTreeSceneCoPresenceContribution, runWorldTreeSceneContributionJob } from '../world-tree/scene-contribution.js';
import { applyWorldTreeContribution, drainWorldTreeContributions, readWorldTreeContributionQueue } from '../world-tree/intake/runtime.js';
import { readWorldTreeCandidateState } from '../world-tree/intake/candidates.js';
import { createPostTurnJobTable, POST_TURN_JOBS } from '../scheduler/jobs.js';

const context=()=>({chatId:'chat-a',chatMetadata:{},saveMetadataDebounced(){}});
function globalNode(tree,id,label,kind='ENTITY'){tree.upsertNode({id,kind,scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[id]},temporal:{status:'CURRENT'},data:{label,aliases:[label]}});}
function scene(overrides={}){return{chatId:'chat-a',sceneId:'scene-1',revision:1,lifecycle:'OPEN',participantRefs:[{id:'Mara',label:'Mara',canonicalEntityId:'character:mara',trackedCharacter:true}],participants:['Mara'],location:'Ember Tavern',objects:['Silver Compass'],threads:['Find the map'],objectives:[],activity:'conversation',focus:'the map',narrativeTime:'evening',relationshipFocus:false,sourceRevisionRefs:['scan-r1'],...overrides};}
function rawScene({sceneId='scene-1',revision=1,lifecycle='OPEN',cast=['Mara'],location='Ember Tavern',objects=[],threads=[]}={}){return{sceneId,revision,lifecycle,sourceRevisionRefs:['scan-'+sceneId+'-'+revision],fields:{activeCast:{value:cast.map(row=>typeof row==='string'?{characterId:row,label:row,state:'PRESENT'}:row)},location:{value:{location}},immediateObjects:{value:objects.map(objectId=>({objectId}))},activeThreads:{value:threads.map(threadId=>({threadId}))},activeObjectives:{value:[]},narrativeTime:{value:'evening'},atmosphere:{value:{activity:'conversation',focus:null,relationshipFocus:false}}}};}

test('Task 5 scene contribution is chat-scoped OBSERVED graph data with the required scene relationships',()=>{
  const tree=new NexusWorldTree();globalNode(tree,'character:mara','Mara','CHARACTER');globalNode(tree,'location:ember','Ember Tavern','LOCATION');
  const value=buildWorldTreeSceneContribution({scene:scene(),tree});assert.deepEqual(value.scope,{type:'CHAT',chatId:'chat-a'});assert.equal(value.source,'scene');assert.equal(value.nodes.length,1);assert.equal(value.nodes[0].kind,'SCENE');assert.equal(value.nodes[0].authority,'OBSERVED');
  assert.ok(value.edges.some(edge=>edge.from==='character:mara'&&edge.to==='scene'&&edge.meaning==='present-in'));assert.ok(value.edges.some(edge=>edge.from==='scene'&&edge.to==='location:ember'&&edge.meaning==='at'));assert.ok(value.edges.some(edge=>edge.from==='scene'&&edge.meaning==='about'));assert.ok(value.edges.some(edge=>edge.meaning==='located-in'));
});
test('scene intake reuses canonical cast and location UIDs and creates one chat-scoped SCENE node',async()=>{
  const tree=new NexusWorldTree(),ctx=context();globalNode(tree,'character:mara','Mara','CHARACTER');globalNode(tree,'location:ember','Ember Tavern','LOCATION');
  const receipt=await applyWorldTreeContribution(buildWorldTreeSceneContribution({scene:scene({objects:[],threads:[]}),tree}),{tree,context:ctx});assert.equal(receipt.createdNodeIds.length,1);
  const node=tree.getNode(receipt.createdNodeIds[0],{chatId:'chat-a'});assert.equal(node.kind,'SCENE');assert.equal(node.scope.type,'CHAT');assert.equal(node.data.authority,'OBSERVED');
  const edges=tree.read({chatId:'chat-a',limit:5000}).edges.filter(edge=>edge.temporal.status==='CURRENT');assert.ok(edges.some(edge=>edge.from==='character:mara'&&edge.relation==='present-in'&&edge.to===node.id));assert.ok(edges.some(edge=>edge.from===node.id&&edge.relation==='at'&&edge.to==='location:ember'));
});
test('Scene cast and current location promote unresolved candidates immediately while an invented object remains a candidate',async()=>{
  const tree=new NexusWorldTree(),ctx=context(),input=buildWorldTreeSceneContribution({scene:scene({participantRefs:[{id:'Garrick',label:'Garrick'}],participants:['Garrick'],location:'Moonlit Clearing',objects:['Silver Compass'],threads:[]}),tree});
  const receipt=await applyWorldTreeContribution(input,{tree,context:ctx}),cast=receipt.resolutions.find(row=>row.mentionId.startsWith('cast:')),place=receipt.resolutions.find(row=>row.mentionId.startsWith('location:')),object=receipt.resolutions.find(row=>row.mentionId.startsWith('object:'));
  assert.equal(cast.path,'promoted');assert.equal(place.path,'promoted');assert.equal(object.path,'unresolved');assert.equal(tree.getNode(cast.nodeId,{chatId:'chat-a'}).scope.type,'CHAT');assert.equal(tree.getNode(place.nodeId,{chatId:'chat-a'}).kind,'LOCATION');
  assert.ok(Object.values(readWorldTreeCandidateState({context:ctx,chatId:'chat-a'}).candidates).some(row=>row.label==='Silver Compass'));
});
test('a repeated invented object promotes through the candidate rule and attaches located-in to the current location',async()=>{
  const tree=new NexusWorldTree(),ctx=context();globalNode(tree,'location:ember','Ember Tavern','LOCATION');
  for(let revision=1;revision<=3;revision++)await applyWorldTreeContribution(buildWorldTreeSceneContribution({scene:scene({revision,participantRefs:[],participants:[],objects:['Silver Compass'],threads:[]}),tree}),{tree,context:ctx});
  const object=[...tree.iterateNodes({chatId:'chat-a'})].find(node=>node.kind==='ITEM'&&node.data?.label==='Silver Compass');assert(object);assert.ok(tree.read({chatId:'chat-a',limit:5000}).edges.some(edge=>edge.from===object.id&&edge.to==='location:ember'&&edge.relation==='located-in'&&edge.temporal.status==='CURRENT'));
});
test('an explicitly nested invented location links part-of its nearest resolved location UID',async()=>{
  const tree=new NexusWorldTree(),ctx=context();globalNode(tree,'location:ember','Ember Tavern','LOCATION');
  await applyWorldTreeContribution(buildWorldTreeSceneContribution({scene:scene({participantRefs:[],participants:[],location:'Back Room of Ember Tavern',objects:[],threads:[]}),tree}),{tree,context:ctx});
  const child=[...tree.iterateNodes({chatId:'chat-a'})].find(node=>node.kind==='LOCATION'&&node.data?.label==='Back Room of Ember Tavern');assert(child);assert.ok(tree.read({chatId:'chat-a',limit:5000}).edges.some(edge=>edge.from===child.id&&edge.to==='location:ember'&&edge.relation==='part-of'&&edge.temporal.status==='CURRENT'));
});
test('co-presence is one weighted relationship edge per pair and revisions supersede the prior aggregate',async()=>{
  const tree=new NexusWorldTree(),ctx=context();globalNode(tree,'character:mara','Mara','CHARACTER');globalNode(tree,'character:eris','Eris','CHARACTER');
  const refs=[{id:'Mara',label:'Mara',canonicalEntityId:'character:mara'},{id:'Eris',label:'Eris',canonicalEntityId:'character:eris'}];
  await applyWorldTreeContribution(buildWorldTreeSceneCoPresenceContribution({chatId:'chat-a',scenes:[scene({sceneId:'s1',participantRefs:refs,participants:['Mara','Eris'],objects:[],threads:[]})]}),{tree,context:ctx});
  await applyWorldTreeContribution(buildWorldTreeSceneCoPresenceContribution({chatId:'chat-a',scenes:[scene({sceneId:'s1',participantRefs:refs,participants:['Mara','Eris'],objects:[],threads:[]}),scene({sceneId:'s2',participantRefs:refs,participants:['Mara','Eris'],objects:[],threads:[]})]}),{tree,context:ctx});
  const all=tree.read({chatId:'chat-a',limit:5000}).edges.filter(edge=>edge.relation==='relationship'&&edge.data?.subtype==='co-present'),current=all.filter(edge=>edge.temporal.status==='CURRENT');assert.equal(current.length,1);assert.equal(current[0].data.weight,2);assert.deepEqual(current[0].data.sourceSceneIds,['s1','s2']);assert.ok(all.some(edge=>edge.temporal.status==='SUPERSEDED'));
  await applyWorldTreeContribution(buildWorldTreeSceneCoPresenceContribution({chatId:'chat-a',scenes:[scene({sceneId:'s1',participantRefs:[refs[0]],participants:['Mara'],objects:[],threads:[]})]}),{tree,context:ctx});
  assert.equal(tree.read({chatId:'chat-a',limit:5000}).edges.filter(edge=>edge.relation==='relationship'&&edge.data?.subtype==='co-present'&&edge.temporal.status==='CURRENT').length,0);
});
test('closing a scene updates the stable scene lineage to HISTORICAL instead of leaving current scene state',async()=>{
  const tree=new NexusWorldTree(),ctx=context();globalNode(tree,'character:mara','Mara','CHARACTER');globalNode(tree,'location:ember','Ember Tavern','LOCATION');
  const first=await applyWorldTreeContribution(buildWorldTreeSceneContribution({scene:scene({objects:[],threads:[]}),tree}),{tree,context:ctx}),sceneId=first.createdNodeIds[0];
  await applyWorldTreeContribution(buildWorldTreeSceneContribution({scene:scene({lifecycle:'CLOSED',objects:[],threads:[]}),tree}),{tree,context:ctx});const node=tree.getNode(sceneId,{chatId:'chat-a'});assert.equal(node.temporal.status,'HISTORICAL');assert.equal(node.data.lifecycle,'CLOSED');
});
test('scene contribution job queues only changed scene lineages plus co-presence and then becomes a no-op after intake',async()=>{
  const tree=new NexusWorldTree(),ctx=context();globalNode(tree,'character:mara','Mara','CHARACTER');globalNode(tree,'location:ember','Ember Tavern','LOCATION');
  const current=rawScene({cast:[{characterId:'Mara',label:'Mara',canonicalEntityId:'character:mara',trackedCharacter:true,state:'PRESENT'}]}),state={chatId:'chat-a',history:[],current};
  const first=await runWorldTreeSceneContributionJob({context:ctx,tree,sceneState:state,sceneView:null});assert.equal(first.queuedCount,2);assert.equal(readWorldTreeContributionQueue({context:ctx}).length,2);
  const drained=await drainWorldTreeContributions({context:ctx,tree});assert.equal(drained.rejectedCount,0);assert.equal(drained.appliedCount,1);assert.equal(drained.noOpCount,1,'empty co-presence aggregate is a valid idempotent no-op');
  const second=await runWorldTreeSceneContributionJob({context:ctx,tree,sceneState:state,sceneView:null});assert.equal(second.skipped,true);assert.equal(second.reason,'no-scene-revision');
});
test('scheduler places worldtree.contribute.scene after Scene observation and makes intake wait for it without changing public parallel results',()=>{
  assert.ok(POST_TURN_JOBS.some(row=>row.id==='worldtree.contribute.scene'&&row.needsSidecar===false));const executors={'scene.observe':async()=>({}),'worldtree.contribute.scene':async()=>({}),'worldtree.intake':async()=>({})},table=createPostTurnJobTable(executors),sceneRow=table.find(row=>row.id==='worldtree.contribute.scene'),intake=table.find(row=>row.id==='worldtree.intake');
  assert.deepEqual(sceneRow.dependencies,['scene.observe']);assert.deepEqual(intake.dependencies,['scene.observe','worldtree.contribute.scene']);const lifecycle=fs.readFileSync(new URL('../lifecycle/scheduler.js',import.meta.url),'utf8');assert.ok(lifecycle.includes("'worldtree.contribute.scene','decision.postTurn','worldtree.intake'"));
});
