import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusWorldTree } from '../world-tree/store.js';
import { applyWorldTreeContribution } from '../world-tree/intake/runtime.js';
import { readWorldTreeCandidateState } from '../world-tree/intake/candidates.js';
import { canonicalWorldTreeEdgeMeaning, WORLD_TREE_EDGE_MEANINGS } from '../world-tree/intake/edge-vocabulary.js';
import { POST_TURN_JOBS, createPostTurnJobTable } from '../scheduler/jobs.js';

const context=chatId=>({chatId,chatMetadata:{},saveMetadataDebounced(){}});
function globalNode(tree,id,label,kind='ENTITY',aliases=[]){
  tree.upsertNode({id,kind,scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[id]},temporal:{status:'CURRENT'},data:{label,aliases}});
}
function contribution({key='k1',sourceRefs=[{messageId:'m1',revision:1}],mentions=[],nodes=[],edges=[]}={}){
  return {kind:'Contribution',source:'scene',scope:{type:'CHAT',chatId:'chat-a'},sourceRefs,key,mentions,nodes,edges};
}

test('Task 1 defines the canonical edge vocabulary and translates known legacy names on read boundaries',()=>{
  assert.equal(WORLD_TREE_EDGE_MEANINGS.length,17);
  assert.equal(canonicalWorldTreeEdgeMeaning('STATE_OF'),'state-of');
  assert.equal(canonicalWorldTreeEdgeMeaning('PRESENT_AT'),'at');
  assert.equal(canonicalWorldTreeEdgeMeaning('PROMOTED_INTO'),'promoted-into');
});

test('one contribution commits nodes and edges as one World Tree revision and is idempotent',async()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a'),before=tree.revision;
  const input=contribution({nodes:[
    {tempId:'room',kind:'LOCATION',label:'Back Room',fields:{},authority:'OBSERVED'},
    {tempId:'box',kind:'ITEM',label:'Silver Box',fields:{},authority:'OBSERVED'},
  ],edges:[{from:'box',to:'room',meaning:'located-in',authority:'OBSERVED'}]});
  const first=await applyWorldTreeContribution(input,{tree,context:ctx});
  assert.equal(first.noOp,false);assert.equal(tree.revision,before+1);assert.equal(first.createdNodeIds.length,2);assert.equal(first.createdEdgeIds.length,1);
  const revision=tree.revision,second=await applyWorldTreeContribution(input,{tree,context:ctx});
  assert.equal(second.noOp,true);assert.equal(tree.revision,revision);
});

test('resolution prefers existing UIDs and aliases and creates no duplicate entity nodes',async()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a');
  globalNode(tree,'character:mara','Mara','CHARACTER',['Innkeeper Mara']);globalNode(tree,'location:ember','Ember Tavern','LOCATION');
  const before=tree.read({chatId:'chat-a'}).nodes.length;
  const result=await applyWorldTreeContribution(contribution({mentions:[
    {mentionId:'mara',text:'Mara',kindHint:'CHARACTER',contextSnippetHash:'h1'},
    {mentionId:'tavern',text:'Ember Tavern',kindHint:'LOCATION',contextSnippetHash:'h2'},
  ],edges:[{from:'mara',to:'tavern',meaning:'at',authority:'OBSERVED'}]}),{tree,context:ctx});
  assert.deepEqual(result.resolutions.map(row=>row.path),['exact','exact']);
  assert.equal(tree.read({chatId:'chat-a'}).nodes.length,before);assert.equal(result.createdEdgeIds.length,1);
});

test('the existing identity registry resolves accepted aliases before similarity or Jev',async()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a');globalNode(tree,'character:mara','Mara','CHARACTER');
  tree.registerIdentity({nodeId:'character:mara',canonicalLabel:'Mara',entityType:'CHARACTER',aliases:['Red Fox'],providerId:'TEST',sourceEntityId:'mara-card',authorityOrigin:'OWNER_EXPLICIT'});
  const result=await applyWorldTreeContribution(contribution({mentions:[{mentionId:'who',text:'Red Fox',kindHint:'CHARACTER'}]}),{tree,context:ctx});
  assert.equal(result.resolutions[0].path,'registry');assert.equal(result.resolutions[0].nodeId,'character:mara');
});

test('similarity resolves only a clear leader and ambiguous matches can use worldtree.identity advice without merging',async()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a');globalNode(tree,'location:ember','Ember Tavern','LOCATION');
  let result=await applyWorldTreeContribution(contribution({key:'sim',sourceRefs:[{messageId:'m2'}],mentions:[{mentionId:'place',text:'Ember Tavrn',kindHint:'LOCATION'}]}),{tree,context:ctx});
  assert.equal(result.resolutions[0].path,'similarity');assert.equal(result.resolutions[0].nodeId,'location:ember');
  globalNode(tree,'entity:mara-a','Mara Vale');globalNode(tree,'entity:mara-b','Mara Vane');
  result=await applyWorldTreeContribution(contribution({key:'jev',sourceRefs:[{messageId:'m3'}],mentions:[{mentionId:'mara',text:'Mara Va',kindHint:'ENTITY'}]}),{
    tree,context:ctx,similarityThreshold:0.5,similarityMargin:0.5,identityAdvisor:async({candidates})=>candidates.find(row=>row.id==='entity:mara-b'),
  });
  assert.equal(result.resolutions[0].path,'jev');assert.equal(result.resolutions[0].nodeId,'entity:mara-b');
  assert.equal(tree.identityRegistry.resolveMention({label:'Mara Va',storyId:'chat-a'}).entity,null,'Jev advice must not settle or add an identity alias');
});

test('unresolved mentions persist outside the tree and promote only after separate turns',async()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a');
  for(let turn=1;turn<=2;turn++){
    await applyWorldTreeContribution(contribution({key:'unknown-'+turn,sourceRefs:[{messageId:'turn-'+turn,revision:1}],mentions:[{mentionId:'stranger',text:'Garrick',kindHint:'CHARACTER'}]}),{tree,context:ctx});
    assert.equal([...tree.iterateNodes({chatId:'chat-a'})].some(row=>row.data?.label==='Garrick'),false);
  }
  const persisted=readWorldTreeCandidateState({context:ctx,chatId:'chat-a'});assert.equal(Object.values(persisted.candidates)[0].mentionCount,2);
  const third=await applyWorldTreeContribution(contribution({key:'unknown-3',sourceRefs:[{messageId:'turn-3',revision:1}],mentions:[{mentionId:'stranger',text:'Garrick',kindHint:'CHARACTER'}]}),{tree,context:ctx});
  assert.equal(third.resolutions[0].path,'promoted');
  const node=tree.getNode(third.resolutions[0].nodeId,{chatId:'chat-a'});assert.equal(node.scope.type,'CHAT');assert.equal(node.kind,'ENTITY');
  assert.equal(Object.keys(readWorldTreeCandidateState({context:ctx,chatId:'chat-a'}).candidates).length,0);
});

test('mention-once relations remain pending edges until the unresolved candidate is promoted',async()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a');globalNode(tree,'character:mara','Mara','CHARACTER');
  await applyWorldTreeContribution(contribution({key:'p1',sourceRefs:[{messageId:'p1'}],mentions:[{mentionId:'mara',text:'Mara'},{mentionId:'compass',text:'Silver Compass',kindHint:'ITEM'}],edges:[{from:'mara',to:'compass',meaning:'mentions',authority:'OBSERVED'}]}),{tree,context:ctx});
  assert.equal(tree.read({chatId:'chat-a'}).edges.length,0);assert.equal(Object.keys(readWorldTreeCandidateState({context:ctx,chatId:'chat-a'}).pendingEdges).length,1);
  await applyWorldTreeContribution(contribution({key:'p2',sourceRefs:[{messageId:'p2'}],mentions:[{mentionId:'compass',text:'Silver Compass',kindHint:'ITEM'}]}),{tree,context:ctx});
  const promoted=await applyWorldTreeContribution(contribution({key:'p3',sourceRefs:[{messageId:'p3'}],mentions:[{mentionId:'compass',text:'Silver Compass',kindHint:'ITEM'}]}),{tree,context:ctx});
  assert.equal(promoted.resolutions[0].path,'promoted');assert.equal(tree.read({chatId:'chat-a'}).edges.some(row=>canonicalWorldTreeEdgeMeaning(row.relation)==='mentions'),true);
});

test('a chat contribution cannot cross into another chat and rejection is atomic',async()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a');
  tree.upsertNode({id:'a',kind:'ENTITY',scope:{type:'CHAT',chatId:'chat-a'},provenance:{sourceType:'TEST',sourceIds:['a']},temporal:{status:'CURRENT'},data:{label:'A'}});
  tree.upsertNode({id:'b',kind:'ENTITY',scope:{type:'CHAT',chatId:'chat-b'},provenance:{sourceType:'TEST',sourceIds:['b']},temporal:{status:'CURRENT'},data:{label:'B'}});
  const before=tree.revision;
  await assert.rejects(()=>applyWorldTreeContribution(contribution({key:'cross',sourceRefs:[{messageId:'x'}],edges:[{from:'a',to:'b',meaning:'relationship',subtype:'knows',authority:'OBSERVED'}]}),{tree,context:ctx}),/WORLD_TREE_EDGE_CHAT_SCOPE_MISMATCH/);
  assert.equal(tree.revision,before);
});

test('a new source revision supersedes nodes owned by the previous contribution lineage instead of deleting them',async()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a');
  const first=await applyWorldTreeContribution(contribution({key:'edit-r1',sourceRefs:[{messageId:'edit-me',revision:1}],nodes:[{tempId:'fact',kind:'ENTITY',label:'Temporary Fact',fields:{},authority:'OBSERVED'}]}),{tree,context:ctx});
  const nodeId=first.createdNodeIds[0],before=tree.revision;
  const second=await applyWorldTreeContribution(contribution({key:'edit-r2',sourceRefs:[{messageId:'edit-me',revision:2}],nodes:[]}),{tree,context:ctx});
  assert.equal(tree.revision,before+1);assert.equal(tree.getNode(nodeId,{chatId:'chat-a'}).temporal.status,'SUPERSEDED');assert.deepEqual(second.supersededNodeIds,[nodeId]);
});

test('worldtree.intake is a post-turn row and waits for current contribution producers when present',()=>{
  assert.ok(POST_TURN_JOBS.some(row=>row.id==='worldtree.intake'&&row.needsSidecar===false));
  const executors={'scene.observe':async()=>({}), 'worldtree.contribute.card':async()=>({}), 'postturn.review':async()=>({}), 'memory.summaryBranch':async()=>({}), 'worldtree.intake':async()=>({})};
  const row=createPostTurnJobTable(executors).find(item=>item.id==='worldtree.intake');
  assert.deepEqual(row.dependencies,['scene.observe','worldtree.contribute.card','postturn.review','memory.summaryBranch']);
});
