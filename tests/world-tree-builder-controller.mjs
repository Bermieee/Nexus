import test from 'node:test';
import assert from 'node:assert/strict';
import {NexusWorldTree} from '../world-tree/store.js';
import {readBuilderWorldContext} from '../builder2/world-context.js';
import {worldBuildPublicationValue,applyPublishedWorldBuild} from '../world-tree/builder-publication.js';
import {commitWorldBuildThroughNexus} from '../builder2/nexus-commit-adapter.js';
import {TransactionLedger} from '../nexus/transaction-ledger.js';
const api=await import('../builder2/world-controller.js').catch(()=>({}));
function fixture(){
  const tree=new NexusWorldTree(), rows=new Map(); let chat='a',mutations=0,analyses=0,failLayout=false;
  tree.upsertNode({id:'lore:A:1',kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'LORE',sourceIds:['A#1']},data:{book:'A',uid:1,content:'original'}});
  const context=()=>readBuilderWorldContext({worldTree:tree,chatId:chat,selectedSources:[{book:'A',uid:1,fingerprint:'one'}],authorizedSourceIds:['A#1']});
  const store={read:async id=>structuredClone(rows.get(id)??null),write:async p=>{rows.set(p.runId,structuredClone(p));return p;}};
  const controller=new api.WorldTreeBuilderController({context,store,currentChatId:()=>chat,
    analysis:async c=>{analyses++;return {organization:{groups:[{id:'people',label:'People',parentId:'world:nexus'}],placements:[{sourceId:'A#1',parentId:'people'}]},coverage:[{sourceId:'A#1',disposition:'PLACED'}]};},
    mutation:async ({materialization,assertFresh})=>{await assertFresh();mutations++;for(const op of materialization.operations){if(op.node)tree.upsertNode(op.node);else tree.linkEdge(op.edge);}return {state:'committed',worldRevision:tree.revision};},
    layout:{read:async()=>({revision:0}),publish:async()=>{if(failLayout)throw Error('disk full');return {revision:1};}}});
  return {controller,store,tree,rows,context,setChat:value=>chat=value,setFailLayout:value=>failLayout=value,counts:()=>({mutations,analyses})};
}
test('stale resume reanalyzes while retaining reviewed category labels',async()=>{
  const f=fixture(),p=await f.controller.start({sourceIds:['A#1'],chatId:'a'});
  await f.controller.revise(p.runId,{planRevision:p.planRevision,changes:{organization:{...p.plan.organization,groups:[{id:'people',label:'Scholars',parentId:'world:nexus'}]}}});
  f.tree.upsertNode({...f.tree.getNode('lore:A:1'),data:{book:'A',uid:1,content:'edited'}});
  const resumed=await f.controller.resume(p.runId);
  assert.equal(f.counts().analyses,2);
  assert.equal(resumed.plan.organization.groups[0].label,'Scholars');
  assert.equal(resumed.plan.review,null);
});
test('delayed approval cannot resurrect a cancelled record',async()=>{
  const f=fixture(),p=await f.controller.start({sourceIds:['A#1'],chatId:'a'});
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  f.store.writeIfRevision=async(record,revision)=>{
    if(record.phase==='APPROVED'){entered();await gate;}
    if(f.rows.get(record.runId).recordRevision!==revision)return false;
    f.rows.set(record.runId,structuredClone(record));return true;
  };
  const approval=f.controller.approve(p.runId,{fingerprint:p.fingerprint,by:'operator'});
  await started;await f.controller.cancel(p.runId);release();
  await assert.rejects(()=>approval,/revision conflict/);
  assert.equal((await f.controller.read(p.runId)).phase,'CANCELLED');
});
test('review fingerprint fences changes and successful apply is idempotent',async()=>{
  assert.equal(typeof api.WorldTreeBuilderController,'function');
  const f=fixture(), p=await f.controller.start({sourceIds:['A#1'],chatId:'a'});
  assert.equal(p.plan.layout.proposed?.coverage?.complete,true,'the reviewed preview must include the actual planned layout');
  await assert.rejects(()=>f.controller.approve(p.runId,{fingerprint:'bad',by:'operator'}),/fingerprint/);
  await f.controller.approve(p.runId,{fingerprint:p.fingerprint,by:'operator'});
  const first=await f.controller.apply(p.runId),second=await f.controller.apply(p.runId);
  assert.equal(first.phase,'COMMITTED');assert.deepEqual(second.outcome,first.outcome);assert.equal(f.counts().mutations,1);
});
test('layout failure preserves durable world result and retry never repeats world commit',async()=>{
  assert.equal(typeof api.WorldTreeBuilderController,'function');
  const f=fixture(),p=await f.controller.start({sourceIds:['A#1'],chatId:'a'});
  await f.controller.approve(p.runId,{fingerprint:p.fingerprint,by:'operator'});f.setFailLayout(true);
  assert.equal((await f.controller.apply(p.runId)).phase,'LAYOUT_PENDING');f.setFailLayout(false);
  assert.equal((await f.controller.retryLayout(p.runId)).phase,'COMMITTED');assert.equal(f.counts().mutations,1);
});
test('world edits and chat switches fence publication; cancellation keeps owner unchanged',async()=>{
  assert.equal(typeof api.WorldTreeBuilderController,'function');
  const f=fixture(),p=await f.controller.start({sourceIds:['A#1'],chatId:'a'}),before=f.tree.exportState();
  f.setChat('b');await assert.rejects(()=>f.controller.approve(p.runId,{fingerprint:p.fingerprint,by:'operator'}),/chat/i);
  f.setChat('a');await f.controller.cancel(p.runId);assert.deepEqual(f.tree.exportState(),before);
  const next=await f.controller.start({sourceIds:['A#1'],chatId:'a'});await f.controller.approve(next.runId,{fingerprint:next.fingerprint,by:'operator'});
  f.tree.upsertNode({...f.tree.getNode('lore:A:1'),data:{book:'A',uid:1,content:'edited'}});
  await assert.rejects(()=>f.controller.apply(next.runId),/stale/i);assert.equal(f.counts().mutations,0);
});
test('persisted analysis result resumes without provider replay; revisions invalidate approval',async()=>{
  assert.equal(typeof api.WorldTreeBuilderController,'function');
  const f=fixture(),p=await f.controller.start({sourceIds:['A#1'],chatId:'a'});
  await f.controller.resume(p.runId);assert.equal(f.counts().analyses,1);
  const revised=await f.controller.revise(p.runId,{planRevision:p.planRevision,changes:{organization:{...p.plan.organization,groups:[{id:'people',label:'Scholars',parentId:'world:nexus'}]}}});
  assert.notEqual(revised.fingerprint,p.fingerprint);await assert.rejects(()=>f.controller.apply(p.runId),/approval/i);
});
test('durable publication references authored nodes and reload replays organization idempotently',async()=>{
  const f=fixture(),p=await f.controller.start({sourceIds:['A#1'],chatId:'a'});
  const {materializeWorldBuildPlan}=await import('../builder2/world-materializer.js');
  const publication=worldBuildPublicationValue(null,p.plan,materializeWorldBuildPlan(p.plan,f.context()));
  assert.equal(JSON.stringify(publication).includes('original'),false);
  applyPublishedWorldBuild(f.tree,publication);const revision=f.tree.revision;
  applyPublishedWorldBuild(f.tree,publication);assert.equal(f.tree.revision,revision);
  assert.equal(f.tree.getNode('lore:A:1').data.content,'original');
});
test('publication cannot replace a global category or mutate earlier rows on ownership failure',()=>{
  const tree=new NexusWorldTree();tree.upsertNode({id:'authored',kind:'LORE_GROUP',scope:{type:'GLOBAL'},provenance:{sourceType:'LORE',sourceIds:['A#1']},data:{label:'Authored'}});
  const before=tree.exportState();
  assert.throws(()=>applyPublishedWorldBuild(tree,{contract:'nexus-world-tree-organization/v1',chatId:'a',nodes:[{id:'new',kind:'LORE_GROUP',scope:{type:'CHAT',chatId:'a'},provenance:{sourceType:'BUILDER_ORGANIZATION',sourceIds:['A#1']},data:{label:'New'}},{id:'authored',kind:'LORE_GROUP',scope:{type:'CHAT',chatId:'a'},provenance:{sourceType:'BUILDER_ORGANIZATION',sourceIds:['A#1']},data:{label:'Replacement'}}],edges:[]}),/ownership/);
  assert.deepEqual(tree.exportState(),before);
});
test('host context wrappers may change while captured metadata authority stays the same',async()=>{
  const f=fixture(),p=await f.controller.start({sourceIds:['A#1'],chatId:'a'});p.plan.review={by:'operator',approvedFingerprint:p.fingerprint};
  const {materializeWorldBuildPlan}=await import('../builder2/world-materializer.js'),chatMetadata={},getContext=()=>({chatId:'a',chatMetadata});
  const result=await commitWorldBuildThroughNexus({plan:p.plan,materialization:materializeWorldBuildPlan(p.plan,f.context()),assertFresh:async()=>true,getContext,worldTree:f.tree,ledger:new TransactionLedger(),readBinding:()=>({chatId:'a',book:'A',revision:1,writable:true}),
    commitMutation:async(_id,mutation,options)=>{await options.preflight();chatMetadata[mutation.key]=mutation.value;return {state:'committed'};}});
  assert.equal(result.state,'committed');assert.equal(chatMetadata.nexusWorldTreeOrganizationV1.lastRunId,p.runId);
});
test('cancel aborts active provider work and leaves the world intact',async()=>{
  const f=fixture();let began,aborted=false;const ready=new Promise(r=>began=r);
  f.controller.analysis=async(_c,{signal})=>new Promise((_resolve,reject)=>{began();signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});});
  const before=f.tree.exportState(),pending=f.controller.start({sourceIds:['A#1'],chatId:'a'});await ready;
  await f.controller.cancel([...f.rows.keys()][0]);assert.equal((await pending).phase,'CANCELLED');assert.equal(aborted,true);assert.deepEqual(f.tree.exportState(),before);
});
test('a durable commit receipt recovers a lost plan outcome without repeating mutation',async()=>{
  const f=fixture(),p=await f.controller.start({sourceIds:['A#1'],chatId:'a'});await f.controller.approve(p.runId,{fingerprint:p.fingerprint,by:'operator'});
  const write=f.store.write;let failed=false;
  f.store.write=async r=>{if(r.outcome&&!failed){failed=true;throw Error('plan save failed');}return write(r);};
  await assert.rejects(()=>f.controller.apply(p.runId),/plan save failed/);
  f.controller.readCommitted=async()=>({state:'committed',worldRevision:f.tree.revision});
  assert.equal((await f.controller.apply(p.runId)).phase,'COMMITTED');assert.equal(f.counts().mutations,1);
});

test('a concurrent saved-run change prevents recovery from resurrecting its earlier approval',async()=>{
 const f=fixture(),run=await f.controller.start({sourceIds:['A#1'],chatId:'a'});await f.controller.approve(run.runId,{fingerprint:run.fingerprint,by:'operator'});
 const saved=await f.store.read(run.runId);saved.phase='COMMITTING';await f.store.write(saved);
 f.store.writeIfRevision=async(record,revision)=>{if(f.rows.get(record.runId).recordRevision!==revision)return false;f.rows.set(record.runId,structuredClone(record));return true;};
 f.controller.recoverUnapplied=async({assertFresh})=>{await assertFresh();const changed=await f.store.read(run.runId);changed.recordRevision++;await f.store.write(changed);return {state:'not-applied'};};
 await assert.rejects(f.controller.apply(run.runId),/revision conflict/);assert.equal(f.counts().mutations,0);
 assert.equal((await f.controller.read(run.runId)).phase,'COMMITTING');
});
test('pending layout can be reviewed again after world changes without another organization commit',async()=>{
  const f=fixture(),p=await f.controller.start({sourceIds:['A#1'],chatId:'a'});
  await f.controller.approve(p.runId,{fingerprint:p.fingerprint,by:'operator'});f.setFailLayout(true);
  await f.controller.apply(p.runId);
  f.tree.upsertNode({id:'scene',kind:'ENTITY',scope:{type:'CHAT',chatId:'a'},provenance:{sourceType:'SCENE',sourceIds:['turn:1']},data:{label:'Scene entity'}});
  const reviewed=await f.controller.reviewLayout(p.runId);assert.equal(reviewed.phase,'LAYOUT_REVIEW');
  await assert.rejects(()=>f.controller.retryLayout(p.runId),/approve/);
  await f.controller.approve(p.runId,{fingerprint:reviewed.fingerprint,by:'operator'});f.setFailLayout(false);
  assert.equal((await f.controller.retryLayout(p.runId)).phase,'COMMITTED');assert.equal(f.counts().mutations,1);
});
