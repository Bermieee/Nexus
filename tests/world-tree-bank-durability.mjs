import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { replaceNexusWorldTree, configureWorldTreeContextProvider } from '../world-tree/index.js';
import { markLegacyWorldTreeMigrated, persistDurableWorldTreeChat } from '../world-tree/durable-state.js';
import { __setDurabilityContextResolverForTests } from '../nexus/host-durability.js';
import { memoryFacadeWorldTreeMutation } from '../world-tree/native-bank-authority.js';

const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
let sequence=0;
async function fixture(t){
  const context={chatId:'bank-story',chatMetadata:{},chat:[],characterId:0,characters:[{name:'Test',avatar:'Test.png'}],getRequestHeaders:()=>({}),saveMetadataDebounced(){}};
  globalThis.nexusBankDurabilityTestContext=context;
  const tree=replaceNexusWorldTree();
  configureWorldTreeContextProvider(()=>globalThis.nexusBankDurabilityTestContext,()=>({configured:true,chatKey:'bank-story',readBooks:['Test book'],writeBooks:['Test book'],primaryWriteBook:'Test book',revision:1}));
  markLegacyWorldTreeMigrated({tree,context});
  __setDurabilityContextResolverForTests(()=>globalThis.nexusBankDurabilityTestContext);
  let persisted=structuredClone(context.chatMetadata),saves=0,fail=new Set();
  context.saveMetadata=async()=>{saves++;if(fail.has(saves))throw Error('Host save failed');persisted=structuredClone(context.chatMetadata);};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,json:async()=>[{chat_metadata:structuredClone(persisted)}]});
  t.after(()=>{globalThis.fetch=originalFetch;configureWorldTreeContextProvider(null);__setDurabilityContextResolverForTests(null);delete globalThis.nexusBankDurabilityTestContext;});
  const stubs={
    '../../../../st-context.js':'export const getContext=()=>globalThis.nexusBankDurabilityTestContext;',
    '../observability/telemetry.js':'export const logEvent=()=>{};',
    '../nexus/work-scope.js':'export const currentNexusChatEpoch=()=>1;',
  };
  async function load(relative,extra={}){
    const url=new URL(relative,import.meta.url),boundary={...stubs,...extra};
    const source=fs.readFileSync(url,'utf8').replace(/from '([^']+)'/g,(_,name)=>`from '${boundary[name]?data(boundary[name]):new URL(name,url).href}'`);
    return import(data(source)+'#'+(++sequence));
  }
  const memory=await load('../memory/store.js');
  const characters=await load('../memory/character-banks.js',{
    '../core/settings.js':'export const getSettings=()=>({memoryBank:{characterBanks:{banks:[]}}});export const updateSettings=()=>{};',
    '../lore/active-books.js':'export const getActiveBooks=()=>[];export const isBookInCurrentStory=()=>true;',
    '../lore/policy.js':'export const canReadBook=()=>true;export const isBookEnabled=()=>true;export const isTv2InjectionBook=()=>true;',
    '../retrieval/search-engine.js':'export const buildTreeEntryIndex=()=>new Map();export const searchTree=()=>[];',
    '../tree/store.js':'export const getTree=()=>null;',
    '../tree/ref-resolver.js':'export const resolveCurrentTreeRef=()=>null;',
    './store.js':'export const getAllMemoryRecords=()=>[];',
  });
  return {context,tree,memory,characters,failNext:()=>fail.add(saves+1),failAll:()=>{context.saveMetadata=async()=>{saves++;throw Error('Storage unavailable');};},saved:()=>structuredClone(persisted),saves:()=>saves};
}

test('failed Memory creation restores both canonical owner and saved snapshot',async t=>{
  const f=await fixture(t);f.failNext();
  await assert.rejects(f.memory.createMemoryRecord({id:'failed',text:'Must not survive',layer:0}),e=>e.tv2RollbackRestored===true);
  assert.equal(f.memory.getMemoryStore().records.failed,undefined);
  assert.equal(f.saved().nexus_world_tree_chat_state_v1.nodes.some(([,n])=>n.data?.sourceRecord?.id==='failed'),false);
  assert.equal(Object.hasOwn(f.context.chatMetadata,'tv2_memory_bank'),false);
});

for(const [name,change] of [
  ['revision',m=>m.reviseMemoryRecord('existing',{text:'Changed'})],
  ['delete',m=>m.deleteMemoryRecord('existing')],
  ['lock',m=>m.setMemoryLocked('existing',true)],
  ['permanence',m=>m.setMemoryPermanentProtected('existing',true)],
])test('failed Memory '+name+' restores canonical record',async t=>{
  const f=await fixture(t);await f.memory.createMemoryRecord({id:'existing',text:'Original',layer:0});
  const before=f.memory.getMemoryRecord('existing');f.failNext();
  await assert.rejects(change(f.memory),e=>e.tv2RollbackRestored===true);
  assert.deepEqual(f.memory.getMemoryRecord('existing'),before);
});

test('Character durable update awaits verification and rolls back a failed save',async t=>{
  const f=await fixture(t),bank=f.characters.addCharacterBank({id:'character',character:'Test character'});
  const before=f.characters.getCharacterBank(bank.id);f.failNext();
  await assert.rejects(f.characters.updateCharacterBankDurably(bank.id,{profile:{appearance:'Changed'}}),e=>e.tv2RollbackRestored===true);
  assert.deepEqual(f.characters.getCharacterBank(bank.id),before);
  assert.equal(f.saves(),2);
});

test('Character durable update refuses success when both save and rollback fail',async t=>{
  const f=await fixture(t),bank=f.characters.addCharacterBank({id:'character',character:'Test character'});f.failAll();
  await assert.rejects(f.characters.updateCharacterBankDurably(bank.id,{profile:{appearance:'Changed'}}),e=>e.name==='TV2RollbackIndeterminate');
});

test('Character durable update is present in verified saved state',async t=>{
  const f=await fixture(t),bank=f.characters.addCharacterBank({id:'character',character:'Test character'});
  await f.characters.updateCharacterBankDurably(bank.id,{profile:{appearance:'White cloak'}});
  assert.equal(f.saves(),1);
  assert(f.saved().nexus_world_tree_chat_state_v1.nodes.some(([,n])=>n.data?.sourceBank?.profile?.appearance==='White cloak'));
});

test('snapshotting never claims a debounced save is verified durability',()=>{
  const result=persistDurableWorldTreeChat({tree:replaceNexusWorldTree(),context:{chatId:'test',chatMetadata:{},saveMetadataDebounced(){throw Error('No storage');}}});
  assert.equal(result.persisted,false);assert.equal(result.saveRequested,false);assert.equal(result.snapshotUpdated,true);
});

test('Lore route preview targets the canonical snapshot without mutating the owner',async t=>{
  const f=await fixture(t);await f.memory.createMemoryRecord({id:'route',text:'A memory',layer:0});
  const preview=f.memory.previewMemoryRouteState('route',{state:'routed-noop'});
  const before=f.tree.exportState(),mutation=memoryFacadeWorldTreeMutation(f.context,preview.store,f.memory.getMemoryOwnerReadControlSnapshot(preview.store));
  assert.equal(mutation.key,'nexus_world_tree_chat_state_v1');
  assert.deepEqual(mutation.expected,f.context.chatMetadata.nexus_world_tree_chat_state_v1);
  assert(mutation.value.nodes.some(([,n])=>n.data?.sourceRecord?.id==='route'&&n.data.sourceRecord.routeState==='routed-noop'));
  assert.deepEqual(f.tree.exportState(),before);
});

test('same-revision replacement owner invalidates the Memory facade',async t=>{
  const f=await fixture(t);await f.memory.createMemoryRecord({id:'replacement',text:'Old',layer:0});
  f.memory.getMemoryStore();f.memory.getMemoryReadSnapshot();
  const snapshot=f.tree.exportState();
  for(const [,node]of snapshot.nodes)if(node.data?.sourceRecord?.id==='replacement')node.data.sourceRecord.text='Restored owner';
  replaceNexusWorldTree(snapshot);
  assert.equal(f.memory.getMemoryStore().records.replacement.text,'Restored owner');
  assert.equal(f.memory.getMemoryReadSnapshot().records.replacement.text,'Restored owner');
});

test('bank rollback preserves another story written during a failed save',async t=>{
  const f=await fixture(t),save=f.context.saveMetadata;let calls=0;
  f.context.saveMetadata=async()=>{
    if(++calls===1){f.tree.upsertNode({id:'other-story-node',kind:'ENTITY',scope:{type:'CHAT',chatId:'other'},provenance:{sourceType:'TEST',sourceIds:['other']},data:{label:'Other story'}});throw Error('First save failed');}
    return save();
  };
  await assert.rejects(f.memory.createMemoryRecord({id:'failed',text:'Failed mutation'}),e=>e.tv2RollbackRestored===true);
  assert.equal(f.memory.getMemoryStore().records.failed,undefined);
  assert.equal(f.tree.getNode('other-story-node',{chatId:'other'}).data.label,'Other story');
});

test('bank rollback refuses to overwrite a newer same-story contribution',async t=>{
  const f=await fixture(t);f.context.saveMetadata=async()=>{
    f.tree.upsertNode({id:'newer-node',kind:'ENTITY',scope:{type:'CHAT',chatId:'bank-story'},provenance:{sourceType:'TEST',sourceIds:['newer']},data:{label:'Newer contribution'}});
    persistDurableWorldTreeChat({tree:f.tree,context:f.context});throw Error('Save interrupted');
  };
  await assert.rejects(f.memory.createMemoryRecord({id:'interrupted',text:'Interrupted mutation'}),e=>e.name==='TV2RollbackIndeterminate'&&e.tv2RollbackRestored!==true);
  assert.equal(f.tree.getNode('newer-node',{chatId:'bank-story'}).data.label,'Newer contribution');
});

test('a binding switch during bank persistence rejects and restores the original mutation',async t=>{
  const f=await fixture(t),save=f.context.saveMetadata;let calls=0;
  f.context.saveMetadata=async()=>{
    if(++calls===1)configureWorldTreeContextProvider(()=>f.context,()=>({configured:true,chatKey:'bank-story',readBooks:['Different book'],writeBooks:['Different book'],primaryWriteBook:'Different book',revision:2}));
    return save();
  };
  await assert.rejects(f.memory.createMemoryRecord({id:'old-binding',text:'Must be rejected'}),e=>e.tv2RollbackRestored===true);
  assert.equal(f.memory.getMemoryStore().records['old-binding'],undefined);
});
