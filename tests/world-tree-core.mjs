import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NexusWorldTree,
  WorldTreeNodeKind,
  WorldTreeScopeType,
  WorldTreeTemporalStatus,
  WorldTreeOverlayKind,
} from '../world-tree/store.js';
import { importLegacyMemoryRecordsToWorldTree, legacyMemoryWorldNodeId } from '../world-tree/import-memory-bank.js';

function memoryNode(tree,{id,chatId,messageId,label='Memory'}){
  return tree.upsertNode({
    id,
    kind:WorldTreeNodeKind.MEMORY,
    scope:{type:WorldTreeScopeType.CHAT,chatId},
    provenance:{sourceType:'MESSAGE',messageRefs:[{chatId,messageId,messageRevision:1}]},
    temporal:{status:WorldTreeTemporalStatus.CURRENT},
    data:{label},
  });
}

test('World Tree starts with one global root and Area 52 identity/temporal primitives',()=>{
  const tree=new NexusWorldTree();
  const read=tree.read({chatId:'chat-a'});
  assert.equal(read.nodes.some(node=>node.id==='world:nexus'),true);
  assert.equal(tree.identityRegistry.exportState().kind,'NativeEntityIdentityRegistrySnapshot');
  assert.equal(tree.temporalStateGraph.exportState().kind,'TemporalStateGraphSnapshot');
});

test('chat scope is explicit and cannot leak message-derived nodes globally',()=>{
  const tree=new NexusWorldTree();
  memoryNode(tree,{id:'memory:a1',chatId:'chat-a',messageId:'m1'});
  memoryNode(tree,{id:'memory:b1',chatId:'chat-b',messageId:'m1'});
  const a=tree.read({chatId:'chat-a'});
  const b=tree.read({chatId:'chat-b'});
  const detached=tree.read({chatId:null});
  assert.equal(a.nodes.some(node=>node.id==='memory:a1'),true);
  assert.equal(a.nodes.some(node=>node.id==='memory:b1'),false);
  assert.equal(b.nodes.some(node=>node.id==='memory:b1'),true);
  assert.equal(detached.nodes.some(node=>node.kind===WorldTreeNodeKind.MEMORY),false);
  assert.throws(()=>tree.upsertNode({
    id:'bad-global-memory',
    kind:WorldTreeNodeKind.MEMORY,
    scope:{type:WorldTreeScopeType.GLOBAL},
    provenance:{sourceType:'MESSAGE',messageRefs:[{chatId:'chat-a',messageId:'m2'}]},
    temporal:{status:WorldTreeTemporalStatus.CURRENT},
    data:{label:'bad'},
  }),/Message-derived durable nodes must be CHAT scoped/);
});

test('global edges cannot point into chat-local state and cross-chat edges are rejected',()=>{
  const tree=new NexusWorldTree();
  tree.upsertNode({
    id:'character:mara',kind:WorldTreeNodeKind.CHARACTER,scope:{type:'GLOBAL'},
    provenance:{sourceType:'CHARACTER_CARD',sourceIds:['mara.png']},temporal:{status:'CURRENT'},data:{label:'Mara'},
  });
  memoryNode(tree,{id:'memory:a1',chatId:'chat-a',messageId:'m1'});
  memoryNode(tree,{id:'memory:b1',chatId:'chat-b',messageId:'m2'});
  assert.throws(()=>tree.linkEdge({
    id:'bad-global-edge',from:'character:mara',to:'memory:a1',relation:'REMEMBERS',scope:{type:'GLOBAL'},
    provenance:{sourceType:'SYSTEM',sourceIds:['test']},temporal:{status:'CURRENT'},
  }),/WORLD_TREE_GLOBAL_EDGE_SCOPE_LEAK/);
  assert.throws(()=>tree.linkEdge({
    id:'bad-chat-edge',from:'memory:a1',to:'memory:b1',relation:'RELATED',scope:{type:'CHAT',chatId:'chat-a'},
    provenance:{sourceType:'SYSTEM',sourceIds:['test']},temporal:{status:'CURRENT'},
  }),/WORLD_TREE_EDGE_CHAT_SCOPE_MISMATCH/);
  const edge=tree.linkEdge({
    id:'good-chat-edge',from:'character:mara',to:'memory:a1',relation:'REMEMBERS',scope:{type:'CHAT',chatId:'chat-a'},
    provenance:{sourceType:'SYSTEM',sourceIds:['test']},temporal:{status:'CURRENT'},
  });
  assert.equal(edge.scope.chatId,'chat-a');
});

test('message edits supersede only nodes derived from the matching chat/message source',()=>{
  const tree=new NexusWorldTree();
  memoryNode(tree,{id:'memory:a1',chatId:'chat-a',messageId:'m1'});
  memoryNode(tree,{id:'memory:a2',chatId:'chat-a',messageId:'m2'});
  memoryNode(tree,{id:'memory:b1',chatId:'chat-b',messageId:'m1'});
  const affected=tree.invalidateMessageSource({chatId:'chat-a',messageId:'m1',messageRevision:1,reason:'message-edited'});
  assert.deepEqual(affected,['memory:a1']);
  assert.equal(tree.getNode('memory:a1',{chatId:'chat-a'}).temporal.status,WorldTreeTemporalStatus.SUPERSEDED);
  assert.equal(tree.getNode('memory:a2',{chatId:'chat-a'}).temporal.status,WorldTreeTemporalStatus.CURRENT);
  assert.equal(tree.getNode('memory:b1',{chatId:'chat-b'}).temporal.status,WorldTreeTemporalStatus.CURRENT);
});

test('Hot Cognition and Green Room state lives in an ephemeral non-durable overlay',()=>{
  const tree=new NexusWorldTree();
  memoryNode(tree,{id:'memory:a1',chatId:'chat-a',messageId:'m1'});
  tree.addEphemeralOverlay({
    id:'green:1',kind:WorldTreeOverlayKind.GREEN_ROOM,chatId:'chat-a',turnId:'7',generationId:'g7',
    nodeIds:['memory:a1'],expiresAtTurn:9,data:{guess:'Mara may leave'},
  });
  assert.equal(tree.read({chatId:'chat-a'}).overlays.length,1);
  const exported=tree.exportState();
  assert.equal('overlays' in exported,false);
  assert.equal(JSON.stringify(exported).includes('Mara may leave'),false);
  assert.deepEqual(tree.expireEphemeral({chatId:'chat-a',currentTurn:9}),['green:1']);
  assert.equal(tree.read({chatId:'chat-a'}).overlays.length,0);
});

test('World Tree UI model is bounded, read-only, and source-body free',()=>{
  const tree=new NexusWorldTree();
  tree.upsertNode({
    id:'lore:gate',kind:WorldTreeNodeKind.LORE_FACT,scope:{type:'GLOBAL'},
    provenance:{sourceType:'LOREBOOK',sourceIds:['book-1'],sourceRevisionIds:['rev-1']},
    temporal:{status:'HISTORICAL'},data:{label:'Old gate location',body:'internal importer payload'},
  });
  const model=tree.readUiModel({chatId:'chat-a'});
  assert.equal(model.kind,'NexusWorldTreeUiModel');
  assert.equal(model.owner,'WORLD_TREE');
  assert.equal(model.mutationAuthority,false);
  assert.equal(model.rawSourceBodiesIncluded,false);
  assert.equal(model.nodes.find(node=>node.id==='lore:gate').temporal.status,'HISTORICAL');
  assert.equal('data' in model.nodes.find(node=>node.id==='lore:gate'),false);
});


test('legacy Memory Bank importer preserves message provenance and is idempotent',()=>{
  const tree=new NexusWorldTree();
  const records=[{
    id:'mem-1',
    layer:0,
    text:'Mara crossed the eastern bridge.',
    turnRange:[4,7],
    sourceMessageIds:['msg-4','msg-5','msg-6','msg-7'],
    sourceFingerprint:'fp-1',
    characters:['Mara'],
    locations:['Eastern Bridge'],
    updatedAt:100,
    worldTreeValidity:{valid:true,reason:'valid'},
  }];
  const first=importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records});
  assert.equal(first.created.length,1);
  assert.equal(first.updated.length,0);
  const nodeId=legacyMemoryWorldNodeId('chat-a','mem-1');
  const node=tree.getNode(nodeId,{chatId:'chat-a'});
  assert.equal(node.provenance.messageRefs.length,4);
  assert.deepEqual(node.provenance.messageRefs.map(row=>row.messageId),['msg-4','msg-5','msg-6','msg-7']);
  assert.equal(node.scope.type,'CHAT');
  assert.equal(node.scope.chatId,'chat-a');
  assert.equal(node.temporal.status,'CURRENT');
  const revision=node.revision;

  const second=importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records});
  assert.equal(second.created.length,0);
  assert.equal(second.updated.length,0);
  assert.deepEqual(second.unchanged,[nodeId]);
  assert.equal(tree.getNode(nodeId,{chatId:'chat-a'}).revision,revision);
});

test('legacy Memory Bank importer supersedes records invalidated by source-message changes',()=>{
  const tree=new NexusWorldTree();
  const valid={
    id:'mem-1',layer:0,text:'A remembered event',sourceMessageIds:['msg-1'],sourceFingerprint:'fp-a',
    updatedAt:100,worldTreeValidity:{valid:true,reason:'valid'},
  };
  importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[valid]});
  const invalid={...valid,worldTreeValidity:{valid:false,reason:'source-fingerprint-changed'}};
  const result=importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[invalid]});
  assert.equal(result.updated.length,1);
  const node=tree.getNode(legacyMemoryWorldNodeId('chat-a','mem-1'),{chatId:'chat-a'});
  assert.equal(node.temporal.status,'SUPERSEDED');
  assert.equal(node.temporal.reason,'source-fingerprint-changed');
  assert.equal(node.data.sourceValidity.valid,false);
});

test('legacy Memory promotion hierarchy becomes explicit World Tree graph edges',()=>{
  const tree=new NexusWorldTree();
  const child={
    id:'child',layer:0,text:'Child memory',sourceMessageIds:['msg-1'],sourceFingerprint:'fp-child',
    parentId:'parent',promotedTo:'parent',updatedAt:10,worldTreeValidity:{valid:true,reason:'valid'},
  };
  const parent={
    id:'parent',layer:1,text:'Parent summary',sourceMessageIds:['msg-1','msg-2'],sourceFingerprint:'fp-parent',
    childIds:['child'],updatedAt:20,worldTreeValidity:{valid:true,reason:'valid'},
  };
  const result=importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[child,parent]});
  assert.equal(result.edges.length,1);
  const read=tree.read({chatId:'chat-a'});
  const edge=read.edges.find(row=>row.relation==='PROMOTED_INTO');
  assert.ok(edge);
  assert.equal(edge.from,legacyMemoryWorldNodeId('chat-a','child'));
  assert.equal(edge.to,legacyMemoryWorldNodeId('chat-a','parent'));
  assert.equal(tree.getNode(edge.from,{chatId:'chat-a'}).temporal.status,'SUPERSEDED');
});
