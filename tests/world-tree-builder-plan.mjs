import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('../builder2/world-plan.js').catch(() => ({}));
const input = () => ({runId:'run-1',scope:{type:'CHAT',chatId:'story'},worldRevision:4,sourceFence:'sources-1',sources:[{book:'A',uid:1,fingerprint:'a'},{book:'B',uid:1,fingerprint:'b'}],organization:{groups:[{id:'people',label:'People',parentId:null}],placements:[{sourceId:'A#1',parentId:'people'},{sourceId:'B#1',parentId:'people'}]},coverage:[{sourceId:'A#1',disposition:'PLACED'},{sourceId:'B#1',disposition:'PLACED'}]});
test('source identity includes book and UID and inputs cannot mutate the plan',()=>{
  assert.equal(typeof api.createWorldBuildPlan,'function');
  const spec=input(), plan=api.createWorldBuildPlan(spec), fingerprint=api.worldBuildFingerprint(plan);
  assert.deepEqual(plan.sources.map(s=>s.sourceId),['A#1','B#1']);
  spec.organization.groups[0].label='changed';
  assert.equal(api.worldBuildFingerprint(plan),fingerprint);
  assert.equal(api.validateWorldBuildPlan(plan).valid,true);
  const withBody=input();withBody.sources[0].content='authored body';
  assert.equal('content' in api.createWorldBuildPlan(withBody).sources[0],false,'durable plan references the authored owner');
});
test('every source requires one disposition and placed sources require a single parent',()=>{
  assert.equal(typeof api.createWorldBuildPlan,'function');
  const plan=api.createWorldBuildPlan(input());
  plan.coverage.pop(); assert.equal(api.validateWorldBuildPlan(plan).valid,false);
  plan.coverage.push({sourceId:'B#1',disposition:'PLACED'});
  plan.organization.placements.push({sourceId:'A#1',parentId:'people'});
  assert.equal(api.validateWorldBuildPlan(plan).valid,false);
});
test('cycles and processing-status categories are rejected',()=>{
  assert.equal(typeof api.createWorldBuildPlan,'function');
  const plan=api.createWorldBuildPlan(input());
  plan.organization.groups[0].parentId='people'; assert.equal(api.validateWorldBuildPlan(plan).valid,false);
  plan.organization.groups[0].parentId=null; plan.organization.groups[0].label='READY';
  assert.equal(api.validateWorldBuildPlan(plan).valid,false);
});
test('relationships require evidence, temporal meaning and scope; layout links are not facts',()=>{
  assert.equal(typeof api.createWorldBuildPlan,'function');
  const plan=api.createWorldBuildPlan(input());
  plan.relationshipProposals=[{id:'r',from:'A#1',to:'B#1',relation:'KNOWS'}];
  assert.equal(api.validateWorldBuildPlan(plan).valid,false);
  Object.assign(plan.relationshipProposals[0],{evidence:['A#1'],scope:plan.scope,temporal:{status:'UNRESOLVED'}});
  assert.equal(api.validateWorldBuildPlan(plan).valid,true);
  plan.relationshipProposals[0].kind='LAYOUT'; assert.equal(api.validateWorldBuildPlan(plan).valid,false);
});
test('approval does not change fingerprint but changing reviewed layout or scope does',()=>{
  assert.equal(typeof api.createWorldBuildPlan,'function');
  const plan=api.createWorldBuildPlan(input()), fingerprint=api.worldBuildFingerprint(plan);
  plan.review={approvedFingerprint:fingerprint,by:'operator'}; plan.phase='APPROVED';
  assert.equal(api.worldBuildFingerprint(plan),fingerprint);
  plan.layout.pins={people:{x:3,y:4}}; assert.notEqual(api.worldBuildFingerprint(plan),fingerprint);
});
