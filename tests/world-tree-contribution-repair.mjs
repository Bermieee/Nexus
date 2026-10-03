import test from 'node:test';
import assert from 'node:assert/strict';
import {NexusWorldTree} from '../world-tree/store.js';
import {configureWorldTreeContextProvider,replaceNexusWorldTree,getNexusWorldTree} from '../world-tree/index.js';
import {applyWorldTreeContribution,applyDeterministicWorldTreeContribution,drainWorldTreeContributions,enqueueWorldTreeContribution} from '../world-tree/intake/runtime.js';
import {readWorldTreeCandidateState} from '../world-tree/intake/candidates.js';
import {runWorldTreeSceneContributionJob} from '../world-tree/scene-contribution.js';
import {runWorldTreeCardContributionJob} from '../world-tree/card-contribution.js';
import {buildWorldTreeMemoryContribution,buildWorldTreeMemoryRecordContribution} from '../world-tree/memory-contribution.js';
import {syncWorldTreeWatchList,readWorldTreeWatchList} from '../world-tree/watch-list.js';
const ctx=()=>({chatId:'story-a',chat:[],chatMetadata:{},saveMetadataDebounced(){}});
function node(tree,id,label,kind='ENTITY',book=null){tree.upsertNode({id,kind,scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[id]},data:{label,...(book?{book}:{})}});}
function fixture(){configureWorldTreeContextProvider(null);const tree=replaceNexusWorldTree(),context=ctx();let scope={configured:true,chatKey:'story-a',revision:1,readBooks:['A'],writeBooks:['A'],primaryWriteBook:'A'};configureWorldTreeContextProvider(()=>context,()=>scope);return{tree,context,setScope:value=>{scope=value;},scope};}
const contribution=(key,refs,mentions=[],edges=[],nodes=[])=>({kind:'Contribution',source:'memory',scope:{type:'CHAT',chatId:'story-a'},key,sourceRefs:refs,mentions,edges,nodes});
test.afterEach(()=>{configureWorldTreeContextProvider(null);replaceNexusWorldTree();});
test('production scene producer and intake never attach a foreign book alias',async()=>{
 const {tree,context}=fixture();node(tree,'foreign','Foreign Secret','ENTITY','B');
 assert.equal(getNexusWorldTree().getNode('foreign'),null);
 await runWorldTreeSceneContributionJob({context,sceneView:{chatId:'story-a',sceneId:'s1',revision:1,threads:['Foreign Secret'],participants:[]},sceneState:{}});
 await drainWorldTreeContributions({context});assert.equal([...tree.edges.values()].some(e=>e.to==='foreign'),false);
});
test('direct deterministic endpoints and explicit injected trees cannot bypass a book binding',()=>{
 const {tree,context}=fixture();node(tree,'foreign','Secret','ENTITY','B');
 assert.throws(()=>applyDeterministicWorldTreeContribution(contribution('foreign',[{messageId:'m1'}],[],[{from:'x',to:'foreign',meaning:'about',authority:'REMEMBERED'}],[{tempId:'x',kind:'EVENT',label:'Event',authority:'REMEMBERED'}]),{tree,context}),/binding|BOUND|SCOPE/i);
});
test('owner node patches and parent references cannot write outside the story book',()=>{
 const {tree,context}=fixture();node(tree,'foreign','Secret','ENTITY','B');const revision=tree.revision;
 assert.throws(()=>applyDeterministicWorldTreeContribution({kind:'Contribution',source:'owner',scope:{type:'GLOBAL'},key:'patch',sourceRefs:[{ownerEdit:'1'}],nodes:[{tempId:'foreign',kind:'ENTITY',label:'Rewritten Secret',fields:{},authority:'CANON'}],edges:[]},{tree,context}),/BINDING/);
 assert.throws(()=>applyDeterministicWorldTreeContribution(contribution('parent',[{messageId:'m1'}],[],[],[{tempId:'event',kind:'EVENT',label:'Event',fields:{parentId:'foreign'},authority:'REMEMBERED'}]),{tree,context}),/BINDING/);
 assert.equal(tree.revision,revision);
});
test('binding changes during identity advice prevent a stale intake commit',async()=>{
 const f=fixture();node(f.tree,'a','Mara Vale','ENTITY','A');node(f.tree,'b','Mara Vane','ENTITY','A');const revision=f.tree.revision;
 await assert.rejects(()=>applyWorldTreeContribution(contribution('late',[{messageId:'m1'}],[{mentionId:'who',text:'Mara Va'}],[],[{tempId:'event',kind:'EVENT',label:'Observation',authority:'REMEMBERED'}]),{context:f.context,similarityThreshold:.5,similarityMargin:.5,identityAdvisor:async({candidates})=>{f.setScope({...f.scope,revision:2,readBooks:['B'],writeBooks:['B'],primaryWriteBook:'B'});return candidates[0];}}),/binding.*changed|BINDING_CHANGED/);
 assert.equal(f.tree.revision,revision);
});
test('queued scene contributions retain the binding they were produced under',async()=>{
 const f=fixture();node(f.tree,'place-a','Ember Tavern','LOCATION','A');node(f.tree,'place-b','Ember Tavern','LOCATION','B');
 await runWorldTreeSceneContributionJob({context:f.context,sceneView:{chatId:'story-a',sceneId:'s1',revision:1,location:'Ember Tavern',participants:[]},sceneState:{}});
 f.setScope({...f.scope,revision:2,readBooks:['B'],writeBooks:['B'],primaryWriteBook:'B'});
 const result=await drainWorldTreeContributions({context:f.context});assert.ok(result.rejectedCount);assert.equal([...f.tree.nodes.values()].some(n=>n.kind==='SCENE'),false);
});
test('message edits after contribution admission prevent the queued graph write',async()=>{
 const tree=new NexusWorldTree(),context=ctx();context.chat=[{mes:'A compass glints.',is_user:false,swipe_id:0}];
 enqueueWorldTreeContribution(contribution('queued',[{messageId:'message:0'}],[],[],[{tempId:'event',kind:'EVENT',label:'Compass discovered',authority:'REMEMBERED'}]),{context});context.chat[0].mes='Nothing happens.';
 const result=await drainWorldTreeContributions({context,tree});assert.equal(result.rejectedCount,1);assert.equal([...tree.nodes.values()].some(n=>n.kind==='EVENT'),false);
});
test('an admitted Scene message revision remains stale when the source changes before the producer queues it',async()=>{
 const {tree,context}=fixture();context.chat=[{mes:'Edited evidence',is_user:false,swipe_id:0}];
 await runWorldTreeSceneContributionJob({context,sceneView:{chatId:'story-a',sceneId:'s1',revision:1,location:'Back room',participants:[],sourceMessageRefs:[{messageId:'message:0',messageRevision:'12345678'}]},sceneState:{}});
 const result=await drainWorldTreeContributions({context});assert.ok(result.rejectedCount);assert.equal([...tree.nodes.values()].some(n=>n.kind==='SCENE'),false);
});
test('edited message evidence cannot later promote its old unresolved pending edge',async()=>{
 const tree=new NexusWorldTree(),context=ctx();node(tree,'mara','Mara','CHARACTER');context.chat=[{mes:'Mara sees Silver Compass.',is_user:false,swipe_id:0}];
 await applyWorldTreeContribution(contribution('old',[{messageId:'message:0'}],[{mentionId:'item',text:'Silver Compass',kindHint:'ITEM'}],[{from:'mara',to:'item',meaning:'mentions',authority:'REMEMBERED'}]),{context,tree});
 const pending=Object.values(readWorldTreeCandidateState({context}).pendingEdges)[0];context.chat[0].mes='Mara sees nothing.';
 for(const i of [1,2,3]){context.chat.push({mes:'Silver Compass is mentioned.',is_user:false,swipe_id:0});await applyWorldTreeContribution(contribution('new-'+i,[{messageId:'message:'+i}],[{mentionId:'item',text:'Silver Compass',kindHint:'ITEM'}]),{context,tree});}
 assert.equal(tree.getEdge(pending.id,{chatId:'story-a'}),null);
});
test('editing an unresolved memory mention retires old evidence and the delayed edge',async()=>{
 const tree=new NexusWorldTree(),context=ctx();node(tree,'mara','Mara','CHARACTER');
 const record={id:'m1',text:'Mara saw the Silver Compass.',characters:['Mara'],topics:['Silver Compass'],sourceMessageIds:['message:0'],sourceFingerprint:'r1'};
 await applyWorldTreeContribution(buildWorldTreeMemoryRecordContribution({record,chatId:'story-a'}),{tree,context});
 await applyWorldTreeContribution(buildWorldTreeMemoryContribution({record,chatId:'story-a'}),{tree,context});
 const pending=Object.values(readWorldTreeCandidateState({context}).pendingEdges)[0];assert.ok(pending);
 const edited={...record,text:'Mara saw nothing.',topics:[],sourceFingerprint:'r2'};
 await applyWorldTreeContribution(buildWorldTreeMemoryRecordContribution({record:edited,chatId:'story-a'}),{tree,context});
 await applyWorldTreeContribution(buildWorldTreeMemoryContribution({record:edited,chatId:'story-a'}),{tree,context});
 assert.equal(Object.values(readWorldTreeCandidateState({context}).pendingEdges).length,0);
 for(const i of [1,2,3])await applyWorldTreeContribution(contribution('new-'+i,[{messageId:'message:'+i}],[{mentionId:'item',text:'Silver Compass',kindHint:'ENTITY'}]),{tree,context});
 assert.equal(tree.getEdge(pending.id,{chatId:'story-a'}),null);
});
test('native memory deletion immediately retires its uncommitted semantic evidence',async()=>{
 const tree=new NexusWorldTree(),context=ctx();const record={id:'m1',text:'Mara recalls finding a strange object called Silver Compass.',topics:['Silver Compass'],sourceFingerprint:'r1'};
 applyDeterministicWorldTreeContribution(buildWorldTreeMemoryRecordContribution({record,chatId:'story-a'}),{tree,context});await applyWorldTreeContribution(buildWorldTreeMemoryContribution({record,chatId:'story-a'}),{tree,context});
 assert.equal(Object.values(readWorldTreeCandidateState({context}).pendingEdges).length,1);
 applyDeterministicWorldTreeContribution(buildWorldTreeMemoryRecordContribution({record,chatId:'story-a',removed:true}),{tree,context});
 assert.equal(Object.values(readWorldTreeCandidateState({context}).pendingEdges).length,0);assert.equal(Object.values(readWorldTreeCandidateState({context}).candidates).length,0);
});
test('a promoted delayed edge retains its originating source and later source revisions supersede it',async()=>{
 const tree=new NexusWorldTree(),context=ctx();node(tree,'mara','Mara','CHARACTER');
 const input=contribution('origin-r1',[{messageId:'original',revision:1}],[{mentionId:'item',text:'Silver Compass',kindHint:'ITEM'}],[{from:'mara',to:'item',meaning:'mentions',authority:'REMEMBERED'}]);
 await applyWorldTreeContribution(input,{tree,context});const pending=Object.values(readWorldTreeCandidateState({context}).pendingEdges)[0];
 for(const i of [2,3])await applyWorldTreeContribution(contribution('obs-'+i,[{messageId:'m'+i}],[{mentionId:'item',text:'Silver Compass',kindHint:'ITEM'}]),{tree,context});
 const edge=tree.getEdge(pending.id,{chatId:'story-a'});assert.ok(edge);assert.deepEqual(edge.provenance.sourceIds,['memory','origin-r1']);
 await applyWorldTreeContribution(contribution('origin-r2',[{messageId:'original',revision:2}]),{tree,context});
 assert.equal(tree.getEdge(edge.id,{chatId:'story-a'}).temporal.status,'SUPERSEDED');
});
test('unresolved card facts resume against later bound lore without another extraction or invented global nodes',async()=>{
 const {tree,context}=fixture();const card={avatar:'eris.png',name:'Eris',fingerprint:'r1',description:'Eris owns Hidden Inn.',tags:['Explorer']},banks=[{id:'bank',cardBinding:{avatar:'eris.png'}}];let calls=0;
 const sidecar=()=>({promise:Promise.resolve({structuredPayload:(calls++,{aliases:[],facts:[{field:'description',relation:'owns',target:'Hidden Inn',targetKind:'LOCATION',snippet:'owns Hidden Inn'}]})})});
 await runWorldTreeCardContributionJob({context,banks,cards:[card],enqueueSidecar:sidecar});await drainWorldTreeContributions({context});
 assert.equal([...tree.nodes.values()].some(n=>n.data.label==='Hidden Inn'),false);
 node(tree,'inn-b','Hidden Inn','LOCATION','B');node(tree,'inn-a','Hidden Inn','LOCATION','A');node(tree,'role-a','Explorer','ENTITY','A');
 await runWorldTreeCardContributionJob({context,banks,cards:[card],enqueueSidecar:sidecar});await drainWorldTreeContributions({context});
 assert.equal(calls,1);assert.ok([...tree.edges.values()].some(e=>e.relation==='owns'&&e.to==='inn-a'));assert.ok([...tree.edges.values()].some(e=>e.relation==='is-a'&&e.to==='role-a'));assert.equal([...tree.edges.values()].some(e=>e.to==='inn-b'),false);
});
test('unchanged card facts resolve separately for each bound book and preserve the other book lineage',async()=>{
 const f=fixture();node(f.tree,'role-a','Explorer','ENTITY','A');node(f.tree,'role-b','Explorer','ENTITY','B');
 const card={avatar:'eris.png',name:'Eris',fingerprint:'r1',tags:['Explorer']},banks=[{id:'bank',cardBinding:{avatar:'eris.png'}}];
 const run=async()=>{const result=await runWorldTreeCardContributionJob({context:f.context,banks,cards:[card]});await drainWorldTreeContributions({context:f.context});return result;};
 assert.equal((await run()).queuedCount,1);const edgeA=[...f.tree.edges.values()].find(e=>e.to==='role-a'&&e.relation==='is-a');assert.ok(edgeA);
 f.setScope({...f.scope,revision:2,readBooks:['B'],writeBooks:['B'],primaryWriteBook:'B'});assert.equal((await run()).queuedCount,1);
 const edgeB=[...f.tree.edges.values()].find(e=>e.to==='role-b'&&e.relation==='is-a');assert.ok(edgeB);assert.deepEqual(f.tree.getEdge(edgeA.id),edgeA);
 assert.equal((await run()).queuedCount,0);f.setScope({...f.scope,revision:3});assert.equal((await run()).queuedCount,0);assert.deepEqual(f.tree.getEdge(edgeB.id),edgeB);
 assert.equal([...f.tree.nodes.values()].filter(n=>n.kind==='CHARACTER'&&n.data.avatar==='eris.png').length,1);
});
test('actual scene producer promotes Back room and attaches it to the previous scoped tavern',async()=>{
 const {tree,context}=fixture();node(tree,'ember-a','Ember Tavern','LOCATION','A');node(tree,'ember-b','Ember Tavern','LOCATION','B');
 const run=async(location,revision,parentLocation=null)=>{await runWorldTreeSceneContributionJob({context,sceneView:{chatId:'story-a',sceneId:'s1',revision,location,parentLocation,participants:[]},sceneState:{}});await drainWorldTreeContributions({context});};
 await run('Ember Tavern',1);await run('Back room',2,'Ember Tavern');
 const room=[...tree.nodes.values()].find(n=>n.kind==='LOCATION'&&n.data.label==='Back room');assert.ok(room);assert.equal(room.scope.chatId,'story-a');
 assert.ok([...tree.edges.values()].some(e=>e.from===room.id&&e.to==='ember-a'&&e.relation==='part-of'));assert.equal([...tree.edges.values()].some(e=>e.from===room.id&&e.to==='ember-b'),false);
});
test('chronology alone cannot attach an invented room to the prior scene location',async()=>{
 const {tree,context}=fixture();node(tree,'tavern','Ember Tavern','LOCATION','A');
 for(const [revision,location] of [[1,'Ember Tavern'],[2,'Back room']]){await runWorldTreeSceneContributionJob({context,sceneView:{chatId:'story-a',sceneId:'s1',revision,location,participants:[]},sceneState:{}});await drainWorldTreeContributions({context});}
 const room=[...tree.nodes.values()].find(n=>n.data?.label==='Back room');assert.ok(room);assert.equal([...tree.edges.values()].some(e=>e.from===room.id&&e.relation==='part-of'),false);
});
test('contribution writes reject unknown vocabulary atomically and retain old decision references on updates',async()=>{
 const tree=new NexusWorldTree(),context=ctx();node(tree,'a','A');node(tree,'b','B');const revision=tree.revision;
 await assert.rejects(()=>applyWorldTreeContribution(contribution('bad',[{messageId:'m1'}],[],[{from:'a',to:'b',meaning:'teleports-to'}]),{tree,context}),/RELATION_NONCANONICAL|EDGE_MEANING/);assert.equal(tree.revision,revision);
 const item={id:'tracked',kind:'ENTITY',scope:{type:'CHAT',chatId:'story-a'},provenance:{sourceType:'TEST',sourceIds:['a']},data:{label:'Tracked'}};
 tree.applyContributionRevision({ledgerKey:'l1',lineageKey:'l',fingerprint:'1',nodes:[item],decisionRecordIds:['earlier']});tree.applyContributionRevision({ledgerKey:'l2',lineageKey:'l',fingerprint:'2',nodes:[item],decisionRecordIds:['later']});
 assert.deepEqual(tree.getNode('tracked',{chatId:'story-a'}).data.decisionRecordIds,['earlier','later']);
});
test('queued producer decisions retain their admitting generation when drained by a later cycle',async()=>{
 const {tree,context}=fixture();await runWorldTreeSceneContributionJob({context,generationId:'admitting-cycle',sceneView:{chatId:'story-a',sceneId:'s1',revision:1,location:'Unmapped courtyard',participants:[]},sceneState:{}});
 await drainWorldTreeContributions({context,generationId:'later-cycle'});
 const decisions=tree.listDecisionRecords({chatId:'story-a',generationId:'admitting-cycle'});assert.ok(decisions.some(row=>row.site==='worldtree.intake'));assert.ok(decisions.some(row=>row.site==='worldtree.growth'));assert.equal(context.generationId,undefined);
});
test('actual current Scene presence consumes known and promoted watch entries after accepted intake',async()=>{
 for(const known of [true,false]){
  const {tree,context}=fixture();if(known)node(tree,'place-a','Ember Tavern','LOCATION','A');
  syncWorldTreeWatchList({tree,chatId:'story-a',sceneScan:{references:{locations:[{name:'Ember Tavern',relation:'planned-destination'}]}},currentTurn:0});
  assert.equal(readWorldTreeWatchList({tree,chatId:'story-a'}).length,1);
  await runWorldTreeSceneContributionJob({context,generationId:'scene-cycle',sceneView:{chatId:'story-a',sceneId:'s1',revision:1,location:'Ember Tavern',participants:[]},sceneState:{}});await drainWorldTreeContributions({context});
  assert.equal(readWorldTreeWatchList({tree,chatId:'story-a'}).length,0);assert.ok(tree.listDecisionRecords({generationId:'scene-cycle',site:'worldtree.watch'}).some(row=>row.chosen==='ENTER'));
 }
});
