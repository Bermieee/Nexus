import test from 'node:test';
import assert from 'node:assert/strict';
import {NexusWorldTree} from '../world-tree/store.js';
import {readBuilderWorldContext} from '../builder2/world-context.js';
import {createWorldBuildPlan} from '../builder2/world-plan.js';
const api=await import('../builder2/world-materializer.js').catch(()=>({}));
function fixture(){
  const worldTree=new NexusWorldTree();
  const provenance={sourceType:'LORE',sourceIds:['A#1']};
  worldTree.upsertNode({id:'people',kind:'LORE_GROUP',scope:{type:'GLOBAL'},provenance,data:{label:'People'}});
  worldTree.upsertNode({id:'lore:A:1',kind:'LORE_FACT',parentId:'people',scope:{type:'GLOBAL'},provenance,temporal:{status:'UNRESOLVED'},data:{book:'A',uid:1,content:'unchanged authored text'}});
  const context=readBuilderWorldContext({worldTree,chatId:'a',selectedSources:[{book:'A',uid:1,fingerprint:'a'}],authorizedSourceIds:['A#1']});
  const plan=createWorldBuildPlan({runId:'run',scope:{type:'GLOBAL'},sourceFence:context.sourceFence,worldRevision:context.worldRevision,sources:context.sources,organization:{groups:[{id:'new',label:'Scholars',parentId:'people'}],placements:[{sourceId:'A#1',parentId:'new'}],navigationLinks:[{id:'nav',from:'people',to:'new'}]},coverage:[{sourceId:'A#1',disposition:'PLACED'}],identityMatches:[{sourceId:'A#1',candidateId:'someone',status:'UNRESOLVED'}]});
  return {worldTree,context,plan};
}
test('canonical preview reuses groups, moves a source once, preserves authority and does not mutate owner',()=>{
  assert.equal(typeof api.materializeWorldBuildPlan,'function');
  const {worldTree,context,plan}=fixture(), before=worldTree.exportState();
  const result=api.materializeWorldBuildPlan(plan,context);
  assert.deepEqual(worldTree.exportState(),before);
  assert.equal(result.preview.nodes.filter(n=>n.id==='lore:A:1').length,1);
  const source=result.preview.nodes.find(n=>n.id==='lore:A:1');
  assert.equal(source.parentId,'new'); assert.equal(source.data.content,'unchanged authored text'); assert.equal(source.temporal.status,'UNRESOLVED');
  assert.equal(result.operations.some(op=>op.kind==='MERGE_IDENTITY'),false);
  assert.equal(result.preview.edges[0].relation,'contains');
  assert.equal(api.validateWorldBuildMaterialization(result,context).valid,true);
});
test('exclusion leaves existing knowledge intact and missing parent or cycles reject materialization',()=>{
  assert.equal(typeof api.materializeWorldBuildPlan,'function');
  const {context,plan}=fixture(); plan.organization.placements=[]; plan.coverage[0].disposition='EXCLUDED';
  assert.equal(api.materializeWorldBuildPlan(plan,context).preview.nodes.some(n=>n.id==='lore:A:1'),true);
  plan.organization.groups[0].parentId='missing'; assert.throws(()=>api.materializeWorldBuildPlan(plan,context),/parent/i);
  plan.organization.groups[0].parentId='new'; assert.throws(()=>api.materializeWorldBuildPlan(plan,context),/cycle/i);
});
test('a story proposal cannot replace an authored edge identity',()=>{
  const {context,plan}=fixture();
  plan.scope={type:'CHAT',chatId:'a'};
  context.relationships.push({id:'nav',from:'people',to:'lore:A:1',relation:'KNOWS',scope:{type:'GLOBAL'},provenance:{sourceType:'LORE'}});
  assert.throws(()=>api.materializeWorldBuildPlan(plan,context),/edge.*ownership/i);
});
