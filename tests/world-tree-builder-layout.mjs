import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../world-tree/layout.js').catch(()=>({}));
const storage=await import('../world-tree/layout-store.js').catch(()=>({}));
const nodes=[{id:'root',parentId:null},{id:'a',parentId:'root'},{id:'b',parentId:'root'},...Array.from({length:9},(_,i)=>({id:`child${i}`,parentId:'a'}))];
test('layout is deterministic and branching reflects unequal descendant weights',()=>{
  assert.equal(typeof api.planWorldTreeLayout,'function');
  const first=api.planWorldTreeLayout({nodes,seed:'world'}),second=api.planWorldTreeLayout({nodes,seed:'world'});
  assert.deepEqual(second,first);assert.equal(Object.keys(first.positions).length,nodes.length);
  assert.notEqual(first.branches.a.span,first.branches.b.span);
  for(const p of Object.values(first.positions))assert.equal(Number.isFinite(p.x)&&Number.isFinite(p.y),true);
});
test('extension preserves existing positions and pins; reorganize moves only unpinned nodes',()=>{
  assert.equal(typeof api.planWorldTreeLayout,'function');
  const old=api.planWorldTreeLayout({nodes,seed:'world'}),pins={a:{x:50,y:60}};
  const next=api.planWorldTreeLayout({nodes:[...nodes,{id:'new',parentId:'b'}],previousLayout:old,pins,seed:'world'});
  assert.deepEqual(next.positions.child1,old.positions.child1);assert.deepEqual(next.positions.a,pins.a);
  const reorganized=api.planWorldTreeLayout({nodes,previousLayout:old,pins,seed:'other',mode:'REORGANIZE'});
  assert.deepEqual(reorganized.positions.a,pins.a);assert.notDeepEqual(reorganized.positions.b,old.positions.b);
});
test('colliding pins stay fixed with honest warnings',()=>{
  assert.equal(typeof api.planWorldTreeLayout,'function');
  const result=api.planWorldTreeLayout({nodes,pins:{a:{x:0,y:0},b:{x:0,y:0}},seed:'world'});
  assert.deepEqual(result.positions.a,result.positions.b);assert.ok(result.warnings.some(w=>w.kind==='OVERLAP'));
});
test('presentation store rejects stale overwrite and failed save without changing facts',async()=>{
  assert.equal(typeof storage.WorldTreeLayoutStore,'function');
  let fail=false,durable=null;
  const store=new storage.WorldTreeLayoutStore({save:async state=>{if(fail)throw Error('quota');durable=structuredClone(state);}}),scope={worldId:'nexus',type:'CHAT',chatId:'a'};
  const layout=api.planWorldTreeLayout({nodes,seed:'world'});
  const saved=await store.publish({scope,worldRevision:7,expectedLayoutRevision:0,layout});assert.equal(saved.revision,1);
  await assert.rejects(()=>store.publish({scope,worldRevision:7,expectedLayoutRevision:0,layout}),/stale/i);
  const restored=new storage.WorldTreeLayoutStore();restored.restore(durable);assert.deepEqual(restored.read(scope),store.read(scope));
  fail=true;await assert.rejects(()=>store.publish({scope,worldRevision:7,expectedLayoutRevision:1,layout}),/quota/);assert.equal(store.read(scope).revision,1);
});
