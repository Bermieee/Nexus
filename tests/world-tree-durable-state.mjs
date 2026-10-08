import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusWorldTree } from '../world-tree/store.js';
import { persistDurableWorldTreeChat, hydrateDurableWorldTreeChat, markLegacyWorldTreeMigrated, legacyWorldTreeMigrationStatus, installWorldTreeChatPersistence, WORLD_TREE_CHAT_STATE_METADATA_KEY } from '../world-tree/durable-state.js';

const context=()=>({chatId:'chat-a',chatMetadata:{},saveMetadataDebounced(){}});
test('each durable mutation saves before its duplicate UI notification without another export',()=>{
  const tree=new NexusWorldTree(),ctx=context(),events=[],saved=[],uiSnapshots=[];
  const node={id:'chat:a',kind:'ENTITY',scope:{type:'CHAT',chatId:'chat-a'},provenance:{sourceType:'TEST',sourceIds:['a']},temporal:{status:'CURRENT'},data:{label:'A'}};
  const exportState=tree.exportChatState.bind(tree);let exports=0;
  tree.exportChatState=(...args)=>{exports++;return exportState(...args);};
  ctx.saveMetadataDebounced=()=>saved.push(structuredClone(ctx.chatMetadata[WORLD_TREE_CHAT_STATE_METADATA_KEY]));
  const release=installWorldTreeChatPersistence({tree,getContext:()=>ctx,subscribe:fn=>tree.subscribe(fn)});
  const releaseUi=tree.subscribe(event=>{
    events.push(event.type);
    if(['node-added','edge-added','node-superseded'].includes(event.type))
      uiSnapshots.push({saved:structuredClone(ctx.chatMetadata[WORLD_TREE_CHAT_STATE_METADATA_KEY]),expected:exportState({chatId:'chat-a'})});
  });
  tree.upsertNode(node);
  tree.linkEdge({id:'edge:a',from:'world:nexus',to:node.id,relation:'contains',scope:node.scope,provenance:node.provenance,temporal:{status:'CURRENT'}});
  tree.upsertNode({...node,temporal:{status:'SUPERSEDED'}});
  assert.deepEqual(events,['NODE_CREATED','node-added','EDGE_CREATED','edge-added','NODE_UPDATED','node-superseded']);
  assert.equal(exports,3);assert.equal(saved.length,3);
  for(const snapshot of uiSnapshots)assert.deepEqual(snapshot.saved,snapshot.expected,'durable metadata must already match when UI notification is delivered');
  assert.deepEqual(saved.at(-1),exportState({chatId:'chat-a'}));
  release();releaseUi();
});
test('transient overlay changes stay observable without serializing or saving unchanged durable chat state',()=>{
  const tree=new NexusWorldTree(),ctx=context(),events=[];
  const node={id:'chat:a',kind:'ENTITY',scope:{type:'CHAT',chatId:'chat-a'},provenance:{sourceType:'TEST',sourceIds:['a']},temporal:{status:'CURRENT'},data:{label:'A'}};
  tree.upsertNode(node);
  persistDurableWorldTreeChat({tree,context:ctx});
  const originalSnapshot=structuredClone(ctx.chatMetadata[WORLD_TREE_CHAT_STATE_METADATA_KEY]);
  let exports=0,saves=0;
  const exportState=tree.exportChatState.bind(tree);
  tree.exportChatState=(...args)=>{exports+=1;return exportState(...args);};
  ctx.saveMetadataDebounced=()=>{saves+=1;};
  const releaseEvents=tree.subscribe(event=>events.push(event.type));
  const release=installWorldTreeChatPersistence({tree,getContext:()=>ctx,subscribe:fn=>tree.subscribe(fn)});
  for(let i=0;i<4;i++)tree.addEphemeralOverlay({id:'ov'+i,kind:'RUNTIME',chatId:'chat-a',nodeIds:['chat:a'],expiresAtTurn:2,data:{temporary:i}});
  assert.equal(tree.readUiModel({chatId:'chat-a'}).overlays.length,4);
  assert.deepEqual(tree.expireEphemeral({chatId:'chat-a',currentTurn:2}),['ov0','ov1','ov2','ov3']);
  assert.deepEqual(events,['OVERLAY_UPSERTED','OVERLAY_UPSERTED','OVERLAY_UPSERTED','OVERLAY_UPSERTED','OVERLAYS_EXPIRED']);
  assert.equal(exports,0);
  assert.equal(saves,0);
  assert.deepEqual(ctx.chatMetadata[WORLD_TREE_CHAT_STATE_METADATA_KEY],originalSnapshot);
  tree.upsertNode({...node,data:{label:'Updated'}});
  assert.equal(exports,1);
  assert.equal(saves,1);
  assert.deepEqual(ctx.chatMetadata[WORLD_TREE_CHAT_STATE_METADATA_KEY],exportState({chatId:'chat-a'}));
  release();releaseEvents();
  tree.upsertNode({...node,data:{label:'Unsubscribed'}});
  assert.equal(saves,1);
});
test('chat-scoped World Tree state persists and hydrates without ephemeral overlays',()=>{
  const tree=new NexusWorldTree(),ctx=context();
  tree.upsertNode({id:'chat:a',kind:'ENTITY',scope:{type:'CHAT',chatId:'chat-a'},provenance:{sourceType:'TEST',sourceIds:['a']},temporal:{status:'CURRENT'},data:{label:'A'}});
  tree.addEphemeralOverlay({id:'ov',kind:'RUNTIME',chatId:'chat-a',nodeIds:['chat:a'],expiresAtTurn:2,data:{temporary:true}});
  const saved=persistDurableWorldTreeChat({tree,context:ctx});assert.equal(saved.persisted,false);assert.equal(saved.snapshotUpdated,true);assert.equal(saved.saveRequested,true);assert.ok(ctx.chatMetadata[WORLD_TREE_CHAT_STATE_METADATA_KEY]);
  assert.equal(JSON.stringify(ctx.chatMetadata[WORLD_TREE_CHAT_STATE_METADATA_KEY]).includes('"overlays"'),false);
  tree.removeNode('chat:a');assert.equal(tree.getNode('chat:a',{chatId:'chat-a'}),null);
  const hydrated=hydrateDurableWorldTreeChat({tree,context:ctx});assert.equal(hydrated.hydrated,true);assert.ok(tree.getNode('chat:a',{chatId:'chat-a'}));
});
test('legacy migration marker stores one rollback backup and is idempotent',()=>{
  const tree=new NexusWorldTree(),ctx=context();
  const first=markLegacyWorldTreeMigrated({tree,context:ctx,memoryBackup:{records:{m1:{id:'m1'}}},characterBackup:{enabled:true,banks:[{id:'c1'}]}});
  const second=markLegacyWorldTreeMigrated({tree,context:ctx,memoryBackup:{records:{m2:{id:'m2'}}},characterBackup:{enabled:false,banks:[]}});
  assert.equal(first.migrated,true);assert.equal(second.migratedAt,first.migratedAt);assert.ok(legacyWorldTreeMigrationStatus({context:ctx}).backup.memory.records.m1);
});
