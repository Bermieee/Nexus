import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusWorldTree } from '../world-tree/store.js';
import { persistDurableWorldTreeChat, hydrateDurableWorldTreeChat, markLegacyWorldTreeMigrated, legacyWorldTreeMigrationStatus, WORLD_TREE_CHAT_STATE_METADATA_KEY } from '../world-tree/durable-state.js';

const context=()=>({chatId:'chat-a',chatMetadata:{},saveMetadataDebounced(){}});
test('chat-scoped World Tree state persists and hydrates without ephemeral overlays',()=>{
  const tree=new NexusWorldTree(),ctx=context();
  tree.upsertNode({id:'chat:a',kind:'ENTITY',scope:{type:'CHAT',chatId:'chat-a'},provenance:{sourceType:'TEST',sourceIds:['a']},temporal:{status:'CURRENT'},data:{label:'A'}});
  tree.addEphemeralOverlay({id:'ov',kind:'RUNTIME',chatId:'chat-a',nodeIds:['chat:a'],expiresAtTurn:2,data:{temporary:true}});
  const saved=persistDurableWorldTreeChat({tree,context:ctx});assert.equal(saved.persisted,true);assert.ok(ctx.chatMetadata[WORLD_TREE_CHAT_STATE_METADATA_KEY]);
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
