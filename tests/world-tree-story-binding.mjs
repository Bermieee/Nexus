import test from 'node:test';
import assert from 'node:assert/strict';
import {configureWorldTreeContextProvider,getNexusWorldTree,getNexusWorldTreeOwner,replaceNexusWorldTree} from '../world-tree/index.js';
import {readWorkingState,writeWorkingState,clearWorkingState} from '../core/ephemeral-state.js';
import {importLegacyLoreBookToWorldTree,loreFactWorldNodeId} from '../world-tree/import-lore.js';
import {createCanonicalWorldTreeReadApi,loreNodeId} from '../core/world-tree-api.js';
import {WORLD_BUILD_METADATA_KEY,applyPublishedWorldBuild} from '../world-tree/builder-publication.js';
import {createWorldTreeBuilderHostBindings} from '../builder2/world-host.js';
import {TransactionLedger} from '../nexus/transaction-ledger.js';
import {commitWorldBuildThroughNexus} from '../builder2/nexus-commit-adapter.js';
import {readWorldTreeStoryBinding,requireWorldTreeStoryBinding} from '../world-tree/index.js';
import {attachWorldTreeStoryBook} from '../world-tree/story-attachment.js';
import {WorldTreeLayoutStore} from '../world-tree/layout-store.js';

function fixture(){
  configureWorldTreeContextProvider(null);
  const tree=replaceNexusWorldTree();
  for(const book of ['A','B'])importLegacyLoreBookToWorldTree(tree,{book,data:{entries:{1:{uid:1,comment:'Same name',content:book,key:['Same name']}}},legacyTree:{root:{id:'root',label:book+' old categories',entryUids:[1]},lastBuilt:1}});
  let context={chatId:'story-a',chatMetadata:{}},scope={configured:true,chatKey:'story-a',revision:1,readBooks:['A'],writeBooks:['A'],primaryWriteBook:'A'};
  configureWorldTreeContextProvider(()=>context,()=>scope);
  return {tree,set:(c,s)=>{context=c;scope=s;},context,scope};
}
test.afterEach(()=>{configureWorldTreeContextProvider(null);replaceNexusWorldTree();});

test('all canonical read surfaces exclude the other story book, even with colliding UIDs and aliases',()=>{
  fixture();const owner=getNexusWorldTree();
  assert.deepEqual(owner.readLoreMetadata().nodes.map(n=>n.data.book),['A']);
  assert.equal(owner.getNode(loreFactWorldNodeId('B',1)),null);
  assert.ok(![...owner.iterateNodes()].some(n=>n.data?.book==='B'));
  assert.ok(!owner.readUiModel().nodes.some(n=>n.id===loreFactWorldNodeId('B',1)));
  const api=createCanonicalWorldTreeReadApi({chatId:'story-a'});
  assert.equal(api.getNode(loreNodeId('B',1)),null);
  assert.equal(api.findByAlias('Same name').filter(n=>n.kind==='lore').length,1);
});
test('a retained reader invalidates when the binding changes without an owner revision change',()=>{
  const f=fixture(),api=createCanonicalWorldTreeReadApi({chatId:'story-a'}),revision=f.tree.revision;
  assert.ok(api.getNode(loreNodeId('A',1)));
  f.set(f.context,{...f.scope,revision:2,readBooks:['B'],writeBooks:['B'],primaryWriteBook:'B'});
  assert.equal(f.tree.revision,revision);
  assert.equal(api.getNode(loreNodeId('A',1)),null);
  assert.ok(api.getNode(loreNodeId('B',1)));
});
test('missing, ambiguous, copied and foreign chat bindings all fail closed',()=>{
  const f=fixture();
  for(const scope of [null,{...f.scope,configured:false,mode:'inferred-single-managed-book'},{...f.scope,readBooks:['A','B']},{...f.scope,chatKey:'story-b'}]){
    f.set(f.context,scope);assert.equal(getNexusWorldTree().read().nodes.length,0);
  }
  f.set({...f.context,chatId:null},f.scope);assert.equal(getNexusWorldTree().read().nodes.length,0);
  f.set(f.context,f.scope);assert.equal(getNexusWorldTree().read({chatId:'story-b'}).nodes.length,0);
});
test('an explicit owner-only working-state path stays chat-scoped without opening Lorebook mutation authority',()=>{
  configureWorldTreeContextProvider(null);replaceNexusWorldTree();
  let context={chatId:'story-unbound',chatMetadata:{}};
  configureWorldTreeContextProvider(()=>context,()=>null);
  assert.throws(()=>getNexusWorldTree().addEphemeralOverlay({id:'blocked',kind:'HOT_COGNITION',chatId:'story-unbound',nodeIds:['world:nexus'],data:{}}),/requires one Lorebook bound/);
  const owner=getNexusWorldTreeOwner();
  const written=writeWorkingState('HOT_COGNITION','story-unbound',{hotRevision:1},{worldTree:owner});
  assert.equal(written.chatId,'story-unbound');
  assert.deepEqual(readWorkingState('HOT_COGNITION','story-unbound',{worldTree:owner}),{hotRevision:1});
  assert.equal(readWorkingState('HOT_COGNITION','story-other',{worldTree:owner}),null);
  context={chatId:'story-other',chatMetadata:{}};
  assert.equal(readWorkingState('HOT_COGNITION','story-other',{worldTree:owner}),null);
  assert.equal(clearWorkingState('HOT_COGNITION','story-unbound',{worldTree:owner}).length,1);
  assert.equal(readWorkingState('HOT_COGNITION','story-unbound',{worldTree:owner}),null);
});
test('a story clear suppresses legacy organization on refresh and reload without mutating other books',()=>{
  const f=fixture(),before=f.tree.exportState();
  f.context.chatMetadata[WORLD_BUILD_METADATA_KEY]={contract:'nexus-world-tree-organization/v1',chatId:'story-a',book:'A',revision:1,cleared:true,nodes:[],edges:[]};
  const view=getNexusWorldTree().read();
  assert.ok(!view.nodes.some(n=>n.kind==='LORE_GROUP'));
  assert.equal(view.nodes.find(n=>n.id===loreFactWorldNodeId('A',1)).parentId,'lorebook:A');
  assert.deepEqual(f.tree.exportState(),before,'clearing one story must not rewrite globally cached authored sources or categories');
  configureWorldTreeContextProvider(null);replaceNexusWorldTree(before);
  configureWorldTreeContextProvider(()=>f.context,()=>f.scope);
  assert.ok(!getNexusWorldTree().read().nodes.some(n=>n.kind==='LORE_GROUP'));
});
test('Trash derives its target from the binding, writes only that chat, and cannot delete authored/global trees',async()=>{
  const f=fixture(),before=f.tree.exportState(),other={unrelated:'preserved'};let writes=0;
  const bindings=createWorldTreeBuilderHostBindings({getContext:()=>f.context,ledger:new TransactionLedger(),commitMutation:async(_id,mutation,options)=>{
    await options.preflight();assert.equal(mutation.type,'metadata.set');assert.equal(mutation.chatId,'story-a');
    f.context.chatMetadata[mutation.key]=structuredClone(mutation.value);writes++;return {state:'committed'};
  }});
  await assert.rejects(bindings.trashWorldTree({book:'B'}),/binding/);
  await assert.rejects(bindings.trashWorldTree({book:'--- Pick to Edit ---'}),/binding/);
  assert.equal(writes,0);
  const receipt=await bindings.trashWorldTree();assert.equal(receipt.book,'A');assert.equal(writes,1);
  assert.deepEqual(f.tree.exportState(),before);assert.deepEqual(other,{unrelated:'preserved'});
  assert.ok(!getNexusWorldTree().read().nodes.some(n=>n.kind==='LORE_GROUP'));
  const second=await bindings.trashWorldTree();assert.equal(second.alreadyCleared,true);assert.equal(writes,1);
});
test('a binding change while a Trash mutation is waiting prevents physical persistence',async()=>{
  const f=fixture();let writes=0;
  const bindings=createWorldTreeBuilderHostBindings({getContext:()=>f.context,ledger:new TransactionLedger(),commitMutation:async(_id,mutation,options)=>{
    f.set(f.context,{...f.scope,revision:2,readBooks:['B'],writeBooks:['B'],primaryWriteBook:'B'});
    await options.preflight();writes++;return {state:'committed'};
  }});
  await assert.rejects(bindings.trashWorldTree(),/binding changed/);assert.equal(writes,0);
  assert.equal(f.context.chatMetadata[WORLD_BUILD_METADATA_KEY],undefined);
});
test('a publication cannot link or parent a bound story group into another book',()=>{
  const f=fixture(),before=f.tree.exportState();
  const group={id:'new-a',kind:'LORE_GROUP',scope:{type:'CHAT',chatId:'story-a'},parentId:'world:nexus',provenance:{sourceType:'BUILDER_ORGANIZATION',sourceIds:['A#1']},data:{label:'A group'}};
  const foreign={id:'foreign-edge',scope:{type:'CHAT',chatId:'story-a'},from:group.id,to:loreFactWorldNodeId('B',1),relation:'NAVIGATION',provenance:group.provenance};
  assert.throws(()=>applyPublishedWorldBuild(f.tree,{contract:'nexus-world-tree-organization/v1',chatId:'story-a',book:'A',nodes:[group],edges:[foreign]}),/binding/);
  assert.deepEqual(f.tree.exportState(),before);
  assert.throws(()=>applyPublishedWorldBuild(f.tree,{contract:'nexus-world-tree-organization/v1',chatId:'story-a',book:'A',nodes:[{...group,parentId:'lorebook:B'}],edges:[]}),/binding/);
  assert.deepEqual(f.tree.exportState(),before);
});
test('a copied same-book receipt cannot replay another story\'s organization',async()=>{
  const f=fixture(),before=f.tree.exportState(),binding=requireWorldTreeStoryBinding();
  f.context.chatMetadata[WORLD_BUILD_METADATA_KEY]={contract:'nexus-world-tree-organization/v1',chatId:'story-b',book:'A',binding:{...binding,chatId:'story-b'},lastRunId:'copied',lastFingerprint:'fingerprint',nodes:[],edges:[]};
  await assert.rejects(commitWorldBuildThroughNexus({plan:{runId:'copied',scope:{type:'CHAT',chatId:'story-a'},binding,sources:[{book:'A',uid:1}],review:{approvedFingerprint:'fingerprint',by:'operator'}},
    getContext:()=>f.context,readBinding:requireWorldTreeStoryBinding,worldTree:f.tree,assertFresh:async()=>{throw Error('stale copied review');},ledger:new TransactionLedger(),commitMutation:async()=>{throw Error('unexpected physical mutation');}}),/stale copied review/);
  assert.deepEqual(f.tree.exportState(),before);
});
test('explicit attachment sends only the chosen book to the existing durable Story Scope writer and reload keeps it',async()=>{
  const context={chatId:'story-a',chatMetadata:{}},other={chatId:'story-b',chatMetadata:{tv2_story_scope_v1:{readBooks:['B']}}};let writes=0;
  const dependencies={getContext:()=>context,getManagedBooks:()=>['A','B'],configureCurrentStoryScope:async value=>{writes++;context.chatMetadata.tv2_story_scope_v1={...value,configured:true,version:2,chatKey:'story-a',revision:1};return {revision:1};}};
  await assert.rejects(attachWorldTreeStoryBook({book:'--- Pick to Edit ---',...dependencies}),/valid Lorebook/);assert.equal(writes,0);
  await attachWorldTreeStoryBook({book:'A',...dependencies});assert.deepEqual(context.chatMetadata.tv2_story_scope_v1.readBooks,['A']);assert.deepEqual(context.chatMetadata.tv2_story_scope_v1.writeBooks,['A']);assert.equal(context.chatMetadata.tv2_story_scope_v1.primaryWriteBook,'A');assert.deepEqual(other.chatMetadata.tv2_story_scope_v1.readBooks,['B']);assert.equal(writes,1);
  const reloaded={chatId:'story-a',chatMetadata:structuredClone(context.chatMetadata)};
  configureWorldTreeContextProvider(()=>reloaded,()=>reloaded.chatMetadata.tv2_story_scope_v1);
  const binding=readWorldTreeStoryBinding();
  assert.equal(binding.chatId,'story-a');assert.equal(binding.book,'A');assert.equal(binding.writable,true);
  assert.deepEqual(reloaded.chatMetadata.tv2_story_scope_v1.readBooks,['A']);assert.deepEqual(reloaded.chatMetadata.tv2_story_scope_v1.writeBooks,['A']);
});
test('a pending pin save cannot restore layout after Trash, including a new host after reload',async()=>{
  const f=fixture(),store=new WorldTreeLayoutStore(),binding=requireWorldTreeStoryBinding();
  await store.publish({scope:{worldId:'nexus',type:'CHAT',chatId:'story-a'},worldRevision:f.tree.revision,expectedLayoutRevision:0,layout:{positions:{'world:nexus':{x:0,y:0}},pins:{}}});
  f.context.chatMetadata.nexusWorldTreeLayoutV1={...store.exportState(),binding};
  let begin,release;const started=new Promise(resolve=>begin=resolve),waiting=new Promise(resolve=>release=resolve);
  const options={getContext:()=>f.context,ledger:new TransactionLedger(),commitMutation:async(_id,mutation,commit)=>{
    if(mutation.key==='nexusWorldTreeLayoutV1'){begin();await waiting;}
    await commit.preflight();f.context.chatMetadata[mutation.key]=structuredClone(mutation.value);return {state:'committed'};
  }};
  const host=createWorldTreeBuilderHostBindings(options),pending=host.saveWorldTreeLayoutPins({'world:nexus':{x:999,y:999}});
  const rejected=assert.rejects(pending,/organization changed/);
  await started;await host.trashWorldTree();release();await rejected;
  assert.equal(createWorldTreeBuilderHostBindings(options).readWorldTreeLayout().layout,null);
});
test('an attachment waiting for durable metadata admission cannot overwrite a newer binding',async()=>{
  const context={chatId:'story-a',chatMetadata:{}};let writes=0;
  await assert.rejects(attachWorldTreeStoryBook({book:'A',getContext:()=>context,getManagedBooks:()=>['A','B'],configureCurrentStoryScope:async(_scope,options)=>{
    context.chatMetadata.tv2_story_scope_v1={configured:true,version:2,chatKey:'story-a',revision:2,readBooks:['B']};
    options.preflight();writes++;return {revision:3};
  }}),/binding changed/);
  assert.equal(writes,0);assert.deepEqual(context.chatMetadata.tv2_story_scope_v1.readBooks,['B']);
});
