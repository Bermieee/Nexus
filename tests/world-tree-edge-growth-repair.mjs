import test from 'node:test';
import assert from 'node:assert/strict';
import {configureWorldTreeContextProvider,replaceNexusWorldTree} from '../world-tree/index.js';
import {enqueueWorldTreeContribution,drainWorldTreeContributions,applyWorldTreeContribution,applyDeterministicWorldTreeContribution} from '../world-tree/intake/runtime.js';
import {readWorldTreeCandidateState} from '../world-tree/intake/candidates.js';
function fixture(){
 const context={chatId:'growth-story',chat:[],chatMetadata:{},saveMetadataDebounced(){}};
 let scope={configured:true,chatKey:context.chatId,revision:1,readBooks:['A'],writeBooks:['A'],primaryWriteBook:'A'};
 const tree=replaceNexusWorldTree();configureWorldTreeContextProvider(()=>context,()=>scope);
 for(const id of ['left','right'])tree.upsertNode({id,kind:'ENTITY',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[id]},data:{label:id,book:'A'}});
 return{tree,context,setBook:book=>{scope={...scope,revision:scope.revision+1,readBooks:[book],writeBooks:[book],primaryWriteBook:book};}};
}
function proposal(context,index,authority='INFERRED',relation='owns'){
 context.chat.push({mes:'Evidence '+index,is_user:false,swipe_id:0});
 return{kind:'Contribution',source:'memory',scope:{type:'CHAT',chatId:context.chatId},key:'inference-'+index,sourceRefs:[{messageId:'message:'+index}],nodes:[],mentions:[],edges:[{from:'left',to:'right',meaning:relation,authority}]};
}
const links=tree=>[...tree.edges.values()].filter(e=>e.relation==='owns'&&e.temporal.status==='CURRENT');
test.afterEach(()=>{configureWorldTreeContextProvider(null);replaceNexusWorldTree();});
test('production queue defers a known-endpoint inferred link and persists independent evidence through reload',async()=>{
 const {tree,context}=fixture();enqueueWorldTreeContribution(proposal(context,0),{context});await drainWorldTreeContributions({context});
 assert.equal(links(tree).length,0);assert.equal(Object.keys(readWorldTreeCandidateState({context}).edgeCandidates??{}).length,1);
 context.chatMetadata=JSON.parse(JSON.stringify(context.chatMetadata));
 enqueueWorldTreeContribution(proposal(context,1),{context});await drainWorldTreeContributions({context});assert.equal(links(tree).length,0);
 enqueueWorldTreeContribution(proposal(context,2),{context});await drainWorldTreeContributions({context});assert.equal(links(tree).length,1);
 const edge=links(tree)[0];assert.deepEqual(edge.provenance.messageRefs.map(ref=>ref.messageId).sort(),['message:0','message:1','message:2']);
});
test('edited deferred edge evidence cannot validate a later inference',async()=>{
 const {tree,context}=fixture();enqueueWorldTreeContribution(proposal(context,0),{context});await drainWorldTreeContributions({context});context.chat[0].mes='Evidence removed';
 for(const index of [1,2]){enqueueWorldTreeContribution(proposal(context,index),{context});await drainWorldTreeContributions({context});}
 assert.equal(links(tree).length,0);
});
test('high authority links and source-backed memory structure still grow immediately',async()=>{
 const {tree,context}=fixture();enqueueWorldTreeContribution(proposal(context,0,'CANON'),{context});await drainWorldTreeContributions({context});assert.equal(links(tree).length,1);
 const record=proposal(context,1,'REMEMBERED','about');enqueueWorldTreeContribution(record,{context});await drainWorldTreeContributions({context});assert.ok([...tree.edges.values()].some(e=>e.relation==='about'&&e.temporal.status==='CURRENT'));
});
test('borderline inferred links use growth advice and recheck source freshness after the reply',async()=>{
 const {tree,context}=fixture();await applyWorldTreeContribution(proposal(context,0),{tree,context});let calls=0;
 const input=proposal(context,1);
 await assert.rejects(()=>applyWorldTreeContribution(input,{tree,context,growthAdvisor:async()=>{calls++;context.chat[1].mes='Edited during growth advice';return{choice:'GROW',source:'provider'};}}),/SOURCE_CHANGED/);
 assert.equal(calls,1);assert.equal(links(tree).length,0);
});
test('promoted discoveries retain all supporting references in provenance and growth evidence',async()=>{
 const {tree,context}=fixture();
 for(const index of [0,1,2]){const input=proposal(context,index);input.edges=[];input.mentions=[{mentionId:'new',text:'Glass Lantern',kindHint:'ITEM'}];enqueueWorldTreeContribution(input,{context});await drainWorldTreeContributions({context});}
 const discovery=[...tree.nodes.values()].find(n=>n.data.label==='Glass Lantern');assert.ok(discovery);assert.deepEqual(discovery.provenance.messageRefs.map(ref=>ref.messageId).sort(),['message:0','message:1','message:2']);
 const decision=[...tree.decisionRecords.values()].find(row=>row.site==='worldtree.growth'&&row.chosen==='GROW'&&row.subject.id.startsWith('mention-candidate:'));
 assert.equal(decision.evidence.length,3);
});
test('a source revision removing a deferred relationship retires its independent support',async()=>{
 const {tree,context}=fixture();const first=proposal(context,0);await applyWorldTreeContribution(first,{tree,context});
 await applyWorldTreeContribution({...first,key:'edited-r2',sourceRefs:[{messageId:'message:0',revision:2}],edges:[]},{tree,context});
 for(const index of [1,2]){enqueueWorldTreeContribution(proposal(context,index),{context});await drainWorldTreeContributions({context});}
 assert.equal(links(tree).length,0);
});
test('borderline provider advice can grow a supported edge with both references',async()=>{
 const {tree,context}=fixture();await applyWorldTreeContribution(proposal(context,0),{tree,context});let calls=0;
 const result=await applyWorldTreeContribution(proposal(context,1),{tree,context,growthAdvisor:async()=>{calls++;return{choice:'GROW',source:'provider'};}});
 assert.equal(calls,1);assert.equal(result.createdEdgeIds.length,1);assert.equal(links(tree)[0].provenance.messageRefs.length,2);
});
test('a single inferred pending edge cannot grow just because its missing endpoint is later discovered',async()=>{
 const {tree,context}=fixture();const first=proposal(context,0);first.mentions=[{mentionId:'new',text:'Glass Lantern',kindHint:'ITEM'}];first.edges=[{from:'left',to:'new',meaning:'owns',authority:'INFERRED'}];enqueueWorldTreeContribution(first,{context});await drainWorldTreeContributions({context});
 for(const index of [1,2]){const input=proposal(context,index);input.edges=[];input.mentions=first.mentions;enqueueWorldTreeContribution(input,{context});await drainWorldTreeContributions({context});}
 assert.ok([...tree.nodes.values()].some(n=>n.data.label==='Glass Lantern'));assert.equal(links(tree).length,0);assert.equal(Object.keys(readWorldTreeCandidateState({context}).edgeCandidates).length,1);
});
test('public deterministic intake rejects current inferred nodes and edges instead of bypassing growth',()=>{
 const {tree,context}=fixture(),input=proposal(context,0),before=tree.exportState();
 assert.throws(()=>applyDeterministicWorldTreeContribution(input,{tree,context}),/ASYNC_INTAKE_REQUIRED/);assert.deepEqual(tree.exportState(),before);
 const nodeInput={...input,key:'inferred-node',edges:[],nodes:[{tempId:'observation',kind:'EVENT',label:'Unverified discovery',authority:'INFERRED'}]};
 assert.throws(()=>applyDeterministicWorldTreeContribution(nodeInput,{tree,context}),/ASYNC_INTAKE_REQUIRED/);assert.deepEqual(tree.exportState(),before);
 for(const authority of ['CANON','CARD','OBSERVED','REMEMBERED']){
  const explicit={...input,key:'explicit-'+authority,sourceRefs:[{ownerEdit:authority}],nodes:[{tempId:'explicit',kind:'EVENT',label:'Explicit '+authority,authority}],edges:[{from:'explicit',to:'right',meaning:'about',authority}]};
  assert.equal(applyDeterministicWorldTreeContribution(explicit,{tree,context}).createdEdgeIds.length,1);
 }
});
test('async intake rejects directly supplied current inferred nodes in both scopes without graph or decision mutation',async()=>{
 const {tree,context}=fixture();
 for(const scope of [{type:'GLOBAL'},{type:'CHAT',chatId:context.chatId}]){
  const before=tree.exportState(),input={kind:'Contribution',source:'memory',scope,key:'unsupported-'+scope.type,sourceRefs:[{messageId:'message:0'}],mentions:[],edges:[],nodes:[{tempId:'speculative',kind:'ENTITY',label:'Unverified entity',authority:'INFERRED'}]};
  await assert.rejects(()=>applyWorldTreeContribution(input,{tree,context}),/INFERRED_NODE_REQUIRES_MENTION_CANDIDATE/);
  assert.deepEqual(tree.exportState(),before);
 }
});
