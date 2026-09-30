import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusWorldTree } from '../world-tree/store.js';
import { replaceNexusWorldTree } from '../world-tree/index.js';
import { subscribeWorldTreeUi } from '../core/world-tree-events.js';
import { createNexusUiHostBindings } from '../nexus-ui-bindings.js';
import { SillyTavernSelectionBridge } from '../src/ui-core/wave12-sillytavern-host.js';

function node(owner,id,chatId=null,status='CURRENT'){
  return owner.upsertNode({id,kind:'ENTITY',scope:chatId?{type:'CHAT',chatId}:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[id]},temporal:{status},data:{label:'SECRET-BODY',content:'SECRET-STORY'}});
}
test('owner emits node-added, edge-added and actual supersession with id, kind and scope',()=>{
  const owner=new NexusWorldTree(),events=[];owner.subscribe(event=>events.push(event));
  node(owner,'a','chat-a');node(owner,'b','chat-a');
  owner.linkEdge({id:'edge-a-b',from:'a',to:'b',relation:'RELATED_TO',scope:{type:'CHAT',chatId:'chat-a'},provenance:{sourceType:'TEST',sourceIds:['edge']},temporal:{status:'CURRENT'}});
  node(owner,'a','chat-a','SUPERSEDED');node(owner,'a','chat-a','SUPERSEDED');
  const added=events.filter(event=>event.type==='node-added'),edges=events.filter(event=>event.type==='edge-added'),superseded=events.filter(event=>event.type==='node-superseded');
  assert.equal(added.length,2);assert.equal(edges.length,1);assert.equal(superseded.length,1);
  assert.deepEqual(superseded[0].payload,{nodeId:'a',kind:'ENTITY',scope:{type:'CHAT',chatId:'chat-a'}});
  assert.deepEqual(edges[0].payload,{edgeId:'edge-a-b',kind:'WORLD_TREE_EDGE',scope:{type:'CHAT',chatId:'chat-a'}});
  assert.equal(JSON.stringify([...added,...edges,...superseded]).includes('SECRET-'),false);
  assert.ok(events.some(event=>event.type==='NODE_CREATED'),'existing listeners remain compatible');
});

test('UI events are deferred, scoped at delivery and dropped on unsubscribe',()=>{
  const owner=replaceNexusWorldTree(),events=[],tasks=[];let chatId='chat-a';
  const release=subscribeWorldTreeUi(event=>events.push(event),{getChatId:()=>chatId,schedule:fn=>tasks.push(fn)});
  node(owner,'a','chat-a');node(owner,'b','chat-b');node(owner,'global');
  assert.equal(events.length,0);assert.equal(tasks.length,1);
  chatId='chat-b';tasks.shift()();
  assert.deepEqual(events.map(event=>event.payload.nodeId),['b','global']);
  node(owner,'pending','chat-b');release();tasks.shift()();
  assert.equal(events.length,2);assert.equal(owner.listeners.size,0);
});

test('subscription follows owner replacement and rejects old queued events',()=>{
  const old=replaceNexusWorldTree(),events=[],tasks=[];
  const release=subscribeWorldTreeUi(event=>events.push(event),{schedule:fn=>tasks.push(fn)});
  node(old,'old');const current=replaceNexusWorldTree();node(current,'new');
  while(tasks.length)tasks.shift()();
  assert.equal(events.some(event=>event.payload.nodeId==='old'),false);
  assert.ok(events.some(event=>event.type==='world-tree-replaced'));
  assert.ok(events.some(event=>event.payload.nodeId==='new'));
  assert.equal(old.listeners.size,0);release();assert.equal(current.listeners.size,0);
});

test('host binding connects owner events to the existing UI selection bridge',()=>{
  const owner=replaceNexusWorldTree(),tasks=[],updates=[];
  const host=createNexusUiHostBindings({subscribeWorldTree:listener=>subscribeWorldTreeUi(listener,{getChatId:()=> 'chat-a',schedule:fn=>tasks.push(fn)})});
  assert.equal(typeof host.world.subscribe,'function');
  const bridge=new SillyTavernSelectionBridge({getContext:()=>({chatId:'chat-a'}),ownerBindings:host});
  const release=bridge.subscribe(event=>updates.push(event));
  node(owner,'new-branch','chat-a');while(tasks.length)tasks.shift()();
  assert.equal(updates.length,1);assert.equal(updates[0].kind,'NEXUS_RECEIPT_UPDATED');
  assert.equal(updates[0].selection.chatId,'chat-a');
  release();bridge.destroy();assert.equal(owner.listeners.size,0);
});

test('failing subscribers cannot break World Tree writes',()=>{
  const owner=replaceNexusWorldTree(),tasks=[];
  const release=subscribeWorldTreeUi(()=>{throw new Error('UI failed');},{schedule:fn=>tasks.push(fn)});
  assert.doesNotThrow(()=>node(owner,'safe'));
  assert.doesNotThrow(()=>{while(tasks.length)tasks.shift()();});
  release();
});
