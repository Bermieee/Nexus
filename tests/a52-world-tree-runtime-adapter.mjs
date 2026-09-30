import assert from 'node:assert/strict';
import { NexusWorldTree, WorldTreeScopeType, WorldTreeTemporalStatus } from '../world-tree/store.js';
import { importLegacyLoreBookToWorldTree, loreFactWorldNodeId } from '../world-tree/import-lore.js';
import { importLegacyMemoryRecordsToWorldTree } from '../world-tree/import-memory-bank.js';
import {
  createCanonicalWorldTreeReadApi,
  loreNodeId,
  memoryNodeId,
} from '../nexus/a52/shared/world-tree-api.js';
import {
  createWorldTreeGraphProvider,
  resolveWorldTreeAnchors,
} from '../nexus/a52/sensory/walker/world-tree-provider.js';

const tree=new NexusWorldTree();
importLegacyLoreBookToWorldTree(tree,{
  book:'World',
  data:{entries:{
    mara:{
      uid:1,
      comment:'Mara Relationships',
      content:'Mara trusts Iris and relies on her judgment.',
      key:['Mara'],
      disable:false,
      extensions:{nexusTemporal:{status:'CURRENT'}},
    },
    iris:{
      uid:2,
      comment:'Iris',
      content:'Iris keeps the silver key.',
      key:['Iris'],
      disable:false,
      extensions:{nexusTemporal:{status:'HISTORICAL'}},
    },
    unknown:{
      uid:3,
      comment:'Unlabelled Fact',
      content:'A fact without temporal metadata.',
      key:['Unlabelled'],
      disable:false,
    },
  }},
});

tree.linkEdge({
  id:'test-related-mara-iris',
  from:loreFactWorldNodeId('World',1),
  to:loreFactWorldNodeId('World',2),
  relation:'RELATED_TO',
  scope:{type:WorldTreeScopeType.GLOBAL},
  provenance:{sourceType:'TEST',sourceIds:['runtime-adapter']},
  temporal:{status:WorldTreeTemporalStatus.CURRENT},
});

importLegacyMemoryRecordsToWorldTree(tree,{
  chatId:'chat-a',
  records:[{
    id:'mem-1',
    layer:0,
    text:'Mara crossed the eastern bridge.',
    sourceMessageIds:['msg-1'],
    sourceFingerprint:'fp-1',
    characters:['Mara'],
    locations:['Eastern Bridge'],
    updatedAt:10,
    worldTreeValidity:{valid:true,reason:'valid'},
  }],
});

const api=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'chat-a'});
assert.equal(api.diagnostics().owner,'WORLD_TREE');
assert.equal(api.diagnostics().canonical,true);

const mara=api.getNode(loreNodeId('World',1));
assert.ok(mara);
assert.equal(mara.canonicalId,loreFactWorldNodeId('World',1));
assert.equal(mara.temporalStatus,'CURRENT');
assert.equal(mara.payload.book,'World');
assert.equal(mara.payload.uid,1);
assert.equal(api.getNode(loreFactWorldNodeId('World',1)).id,loreNodeId('World',1),'canonical ids should resolve through the compatibility projection');

const iris=api.getNode(loreNodeId('World',2));
assert.equal(iris.temporalStatus,'HISTORICAL');
assert.equal(api.getNode(loreNodeId('World',3)).temporalStatus,'UNRESOLVED','missing temporal metadata must remain unresolved');

const aliases=api.findByAlias('Lady Mara','chat-a');
assert.ok(aliases.some(row=>row.id===loreNodeId('World',1)),'canonical aliases should preserve the port identity normalizer');

const explicitEdges=api.edgesFrom(loreNodeId('World',1));
assert.ok(explicitEdges.some(edge=>edge.to===loreNodeId('World',2)&&edge.meaning==='RELATED_TO'));

const memory=api.getNode(memoryNodeId('mem-1'));
assert.ok(memory);
assert.equal(memory.temporalStatus,'HISTORICAL','Summary Bank records default to historical truth status');
assert.equal(memory.scope,'chat-a');

const detached=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'chat-b'});
assert.equal(detached.getNode(memoryNodeId('mem-1')),null,'chat-scoped memory must not leak into another story');

const anchors=resolveWorldTreeAnchors(api,{acceptedScene:{participants:['Mara'],location:''}},{chatId:'chat-a'});
assert.ok(anchors.includes(loreNodeId('World',1)));

const provider=createWorldTreeGraphProvider({
  worldTree:api,
  sceneScan:{acceptedScene:{participants:['Mara'],location:''}},
  chatId:'chat-a',
  sourceRevisionRefs:['lore-rev:canonical'],
});
const rows=provider.query({anchorEntityIds:[loreNodeId('World',1)],maxDepth:2,maxEdges:32});
assert.ok(rows.some(row=>row.evidenceIdentity===loreNodeId('World',2)),'Walker provider should traverse canonical World Tree edges using projected candidate identities');
assert.equal(provider.metadata.synchronous,true);

console.log('Canonical World Tree runtime adapter: PASS');
