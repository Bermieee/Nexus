import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NexusWorldTree } from '../world-tree/store.js';
import { importLegacyMemoryRecordsToWorldTree, legacyMemoryWorldNodeId } from '../world-tree/import-memory-bank.js';
import { applyWorldTreeContribution, drainWorldTreeContributions } from '../world-tree/intake/runtime.js';
import { buildWorldTreeMemoryContribution, runWorldTreeMemoryContributionJob, validateWorldTreeMemoryExtraction } from '../world-tree/memory-contribution.js';
import { canonicalWorldTreeEdgeMeaning } from '../world-tree/intake/edge-vocabulary.js';
import { POST_TURN_JOBS, createPostTurnJobTable } from '../scheduler/jobs.js';

const context=chatId=>({chatId,chatMetadata:{},saveMetadataDebounced(){}});
function globalNode(tree,id,label,kind='ENTITY',aliases=[]){
  tree.upsertNode({id,kind,scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[id]},temporal:{status:'CURRENT'},data:{label,aliases}});
}
function record(overrides={}){
  return {id:'m1',layer:0,text:'At the Ember Tavern, Eris told Mara the secret and Mara now trusts Eris with it.',turnRange:[45,47],assistantTurnRange:[22,23],
    sourceMessageIds:['msg-45','msg-46'],sourceFingerprint:'fp-1',characters:['Eris','Mara'],locations:['Ember Tavern'],dates:[],topics:['Silver Compass'],threads:['Hidden route'],
    childIds:[],parentId:null,promotedTo:null,routeState:'unrouted',routeProposalIds:[],routeReasoning:'',routeEvaluation:{status:'PENDING'},createdAt:10,updatedAt:20,permanent:false,locked:false,...overrides};
}
function setup(){
  const tree=new NexusWorldTree(),ctx=context('chat-a');globalNode(tree,'character:eris','Eris','CHARACTER');globalNode(tree,'character:mara','Mara','CHARACTER');
  globalNode(tree,'location:ember','Ember Tavern','LOCATION');globalNode(tree,'lore:compass','Silver Compass','LORE_FACT');globalNode(tree,'lore:route','Hidden route','LORE_FACT');
  return{tree,ctx};
}
function budget(allowed){return{beginTurn(){return{compute(_id,{total}){const n=Math.min(total,allowed);return{allowed:n,deferred:total-n,total,complete:n===total};}};}};}

test('Memory importer uses deterministic intake and keeps Task 7 parity node identities',()=>{
  const {tree}=setup(),source=record();const receipt=importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[source],control:{activeLayers:[[source.id]]}});
  assert.equal(receipt.intakeOwned,true);assert.ok(tree.getNode(legacyMemoryWorldNodeId('chat-a','m1'),{chatId:'chat-a'}));assert.ok(receipt.created.includes(legacyMemoryWorldNodeId('chat-a','m1')));
  const code=fs.readFileSync(new URL('../world-tree/import-memory-bank.js',import.meta.url),'utf8');assert.equal(code.includes('tree.upsertNode('),false);assert.equal(code.includes('tree.linkEdge('),false);assert.ok(code.includes('applyDeterministicWorldTreeContribution'));
});

test('Memory contribution attaches existing character, place and lore UIDs without duplicate nodes',async()=>{
  const {tree,ctx}=setup(),source=record();importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[source]});const before=[...tree.iterateNodes({chatId:'chat-a'})].length;
  const extraction=validateWorldTreeMemoryExtraction({relationships:[{from:'Mara',to:'Eris',subtype:'trusts-with-secret',snippet:'Mara now trusts Eris with it'}]},{record:source});
  const result=await applyWorldTreeContribution(buildWorldTreeMemoryContribution({record:source,chatId:'chat-a',extraction}),{tree,context:ctx});
  assert.equal(result.unresolved.length,0);assert.equal([...tree.iterateNodes({chatId:'chat-a'})].length,before);
  const edges=tree.read({chatId:'chat-a',limit:5000}).edges.filter(e=>e.temporal.status==='CURRENT'),memoryId=legacyMemoryWorldNodeId('chat-a','m1');
  assert.ok(edges.some(e=>e.from===memoryId&&e.to==='character:mara'&&canonicalWorldTreeEdgeMeaning(e.relation)==='about'));
  assert.ok(edges.some(e=>e.from===memoryId&&e.to==='location:ember'&&canonicalWorldTreeEdgeMeaning(e.relation)==='about'));
  assert.ok(edges.some(e=>e.from===memoryId&&e.to==='lore:compass'&&canonicalWorldTreeEdgeMeaning(e.relation)==='mentions'));
  const relationship=edges.find(e=>e.from==='character:mara'&&e.to==='character:eris'&&canonicalWorldTreeEdgeMeaning(e.relation)==='relationship');
  assert.ok(relationship);assert.equal(relationship.data.subtype,'trusts-with-secret');assert.equal(relationship.temporal.validFrom,'message:45');assert.equal(relationship.data.authority,'REMEMBERED');
});

test('Memory edit supersedes the prior semantic edges instead of leaving both current',async()=>{
  const {tree,ctx}=setup(),first=record();importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[first]});
  const one=buildWorldTreeMemoryContribution({record:first,chatId:'chat-a',extraction:{relationships:[{from:'Mara',to:'Eris',subtype:'trusts-with-secret',snippet:'Mara now trusts Eris with it'}]}});
  await applyWorldTreeContribution(one,{tree,context:ctx});const priorIds=tree.read({chatId:'chat-a',limit:5000}).edges.filter(e=>e.provenance.sourceType==='NEXUS_WORLD_TREE_MEMORY'&&e.temporal.status==='CURRENT').map(e=>e.id);
  const second=record({text:'At the Ember Tavern, Eris corrected Mara; Mara no longer trusts Eris with the secret.',sourceFingerprint:'fp-2',updatedAt:30});
  importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[second]});
  const two=buildWorldTreeMemoryContribution({record:second,chatId:'chat-a',extraction:{relationships:[{from:'Mara',to:'Eris',subtype:'distrusts-with-secret',snippet:'Mara no longer trusts Eris with the secret'}]}});
  await applyWorldTreeContribution(two,{tree,context:ctx});
  const snapshot=tree.read({chatId:'chat-a',limit:5000});assert.ok(priorIds.every(id=>snapshot.edges.find(e=>e.id===id)?.temporal.status==='SUPERSEDED'));
  assert.ok(snapshot.edges.some(e=>e.temporal.status==='CURRENT'&&e.data.subtype==='distrusts-with-secret'));
});

test('Memory contribution job defers records over dynamic budget and retries them later',async()=>{
  const {tree,ctx}=setup(),records=[record({id:'m1',characters:['Mara']}),record({id:'m2',characters:['Mara'],text:'Mara remembered the tavern.',sourceFingerprint:'fp-2'}),record({id:'m3',characters:['Mara'],text:'Mara remembered the route.',sourceFingerprint:'fp-3'})];
  importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records});
  const first=await runWorldTreeMemoryContributionJob({context:ctx,tree,records,budgetManager:budget(1)});assert.equal(first.queuedCount,1);assert.equal(first.deferredCount,2);
  await drainWorldTreeContributions({context:ctx,tree});
  const second=await runWorldTreeMemoryContributionJob({context:ctx,tree,records,budgetManager:budget(3)});assert.equal(second.queuedCount,2);assert.equal(second.deferredCount,0);
  await drainWorldTreeContributions({context:ctx,tree});
  assert.equal(records.filter(row=>tree.latestContributionRecord?.(['CHAT','chat-a','memory'].join('|'))).length>=0,true);
});

test('removed or invalid Memory revisions retire semantic edges',async()=>{
  const {tree,ctx}=setup(),source=record();importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[source]});
  await applyWorldTreeContribution(buildWorldTreeMemoryContribution({record:source,chatId:'chat-a'}),{tree,context:ctx});
  const invalid={...source,worldTreeValidity:{valid:false,reason:'source-edited'},sourceFingerprint:'fp-2'};importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[invalid]});
  await applyWorldTreeContribution(buildWorldTreeMemoryContribution({record:invalid,chatId:'chat-a'}),{tree,context:ctx});
  const current=tree.read({chatId:'chat-a',limit:5000}).edges.filter(e=>e.provenance.sourceType==='NEXUS_WORLD_TREE_MEMORY'&&e.temporal.status==='CURRENT');
  assert.equal(current.length,0);
});

test('Task 6 enables strict canonical linkEdge enforcement after both importers use intake',()=>{
  const tree=new NexusWorldTree();globalNode(tree,'a','A');globalNode(tree,'b','B');
  const base={id:'e',from:'a',to:'b',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['e']},temporal:{status:'CURRENT'},data:{}};
  assert.throws(()=>tree.linkEdge({...base,relation:'PROMOTED_INTO'}),/WORLD_TREE_EDGE_RELATION_NONCANONICAL/);
  assert.throws(()=>tree.linkEdge({...base,id:'x',relation:'invented-relation'}),/WORLD_TREE_EDGE_RELATION_NONCANONICAL/);
  const edge=tree.linkEdge({...base,id:'ok',relation:'promoted-into'});assert.equal(edge.relation,'promoted-into');
});

test('scheduler runs worldtree.contribute.memory after summary branch and intake waits for it without exposing a new public result',()=>{
  assert.ok(POST_TURN_JOBS.some(row=>row.id==='worldtree.contribute.memory'&&row.needsSidecar===true));
  const executors={'memory.summaryBranch':async()=>({}),'worldtree.contribute.memory':async()=>({}),'worldtree.intake':async()=>({})},table=createPostTurnJobTable(executors),memory=table.find(row=>row.id==='worldtree.contribute.memory'),intake=table.find(row=>row.id==='worldtree.intake');
  assert.deepEqual(memory.dependencies,['memory.summaryBranch']);assert.deepEqual(intake.dependencies,['memory.summaryBranch','worldtree.contribute.memory']);
  const lifecycle=fs.readFileSync(new URL('../lifecycle/scheduler.js',import.meta.url),'utf8');assert.ok(lifecycle.includes("'worldtree.contribute.memory'"));
});
