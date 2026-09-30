import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorldTreeDocument, worldTreeDocumentStats } from '../nexus/a52/shared/world-tree-document.js';
import {
  memoryWorldTreeMetaNodeId,
  memoryWorldTreeNodeIds,
  replaceMemoryStoreInWorldTreeDocument,
  worldTreeDocumentToMemoryStore,
} from '../nexus/a52/shared/world-tree-memory-codec.js';

const store={
  version:4,
  summarizedUpTo:12,
  records:{
    a:{
      id:'a',layer:0,text:'Mara entered the city.',turnRange:[1,4],assistantTurnRange:[1,2],
      createdAt:10,updatedAt:12,sourceMessageIds:['m1','m2'],sourceFingerprint:'f1',
      childIds:[],parentId:'b',promotedTo:'b',characters:['Mara'],locations:['City'],dates:[],
      topics:['arrival'],threads:['key'],routeState:'unrouted',routeProposalIds:[],routeReasoning:'',
      routeEvaluation:null,source:'summary',sidecarSlot:'A',cycleId:'c1',permanent:false,locked:false,revisions:[],
    },
    b:{
      id:'b',layer:1,text:'Mara is established in the city.',turnRange:[1,8],assistantTurnRange:[1,4],
      createdAt:20,updatedAt:22,sourceMessageIds:['m1','m2','m3'],sourceFingerprint:'f2',
      childIds:['a'],parentId:null,promotedTo:null,characters:['Mara'],locations:['City'],dates:[],
      topics:['arrival'],threads:['key'],routeState:'unrouted',routeProposalIds:[],routeReasoning:'',
      routeEvaluation:null,source:'promotion',sidecarSlot:'B',cycleId:'c2',permanent:true,locked:true,revisions:[],
    },
  },
  activeLayers:[['a'],['b']],
  permanentIds:['b'],
  compressedIndices:[1,2],
  coverageReceipts:[{id:'coverage:a',turnRange:[1,4],sourceMessageIds:['m1','m2'],sourceFingerprint:'f1',sourceMemoryId:'a',source:'layer0-summary',createdAt:10}],
  sequence:2,
  evidenceRevision:7,
  lastCycleId:'c2',
  lastUpdatedAt:22,
};

{
  let doc=createWorldTreeDocument();
  doc.nodes['lore:world:9']={
    id:'lore:world:9',kind:'lore',scope:'global',revision:1,sourceRefs:['lore:world:9'],
    temporalStatus:'CURRENT',supersededBy:null,aliases:[],edges:[],authorityClass:'SOURCE_CANON',metadata:{},payload:{book:'world',uid:9},
  };
  doc=replaceMemoryStoreInWorldTreeDocument(doc,store,{chatId:'chat-1'});
  const ids=memoryWorldTreeNodeIds(doc,{chatId:'chat-1'});
  assert.deepEqual(ids,['memory:a','memory:b']);
  assert.ok(doc.nodes[memoryWorldTreeMetaNodeId('chat-1')]);
  assert.ok(doc.nodes['memory:b'].edges.some(edge=>edge.meaning==='SUMMARIZES_MEMORY'&&edge.to==='memory:a'));
  assert.ok(doc.nodes['memory:a'].edges.some(edge=>edge.meaning==='PROMOTED_TO'&&edge.to==='memory:b'));
  assert.equal(doc.nodes['memory:a'].temporalStatus,'HISTORICAL');
  assert.ok(doc.nodes['lore:world:9'],'unrelated World Tree nodes must survive Memory Bank replacement');

  const projected=worldTreeDocumentToMemoryStore(doc,{chatId:'chat-1'});
  assert.deepEqual(projected,store);

  const edited=structuredClone(store);
  delete edited.records.a;
  edited.activeLayers=[[],['b']];
  edited.permanentIds=['b'];
  doc=replaceMemoryStoreInWorldTreeDocument(doc,edited,{chatId:'chat-1'});
  assert.deepEqual(memoryWorldTreeNodeIds(doc,{chatId:'chat-1'}),['memory:b']);
  assert.deepEqual(worldTreeDocumentToMemoryStore(doc,{chatId:'chat-1'}),edited);
  const stats=worldTreeDocumentStats(doc);
  assert.equal(stats.byKind.memory,1);
  assert.equal(stats.byKind['memory-store-meta'],1);
}

{
  const memoryStore=fs.readFileSync(new URL('../memory/store.js',import.meta.url),'utf8');
  const worldStore=fs.readFileSync(new URL('../nexus/world-tree-store.js',import.meta.url),'utf8');
  assert.ok(memoryStore.includes("const LEGACY_META_KEY = 'tv2_memory_bank'"));
  assert.ok(memoryStore.includes('const META_KEY = NEXUS_CHAT_WORLD_TREE_META_KEY'));
  assert.ok(memoryStore.includes('worldTreeDocumentToMemoryStore'));
  assert.ok(memoryStore.includes('replaceMemoryStoreInWorldTreeDocument'));
  assert.ok(memoryStore.includes("runtimeRemoved:'chatMetadata.tv2_memory_bank'"));
  assert.ok(!memoryStore.includes("ctx.chatMetadata[META_KEY]=freshStore()"));
  assert.ok(!memoryStore.includes("ctx.chatMetadata[META_KEY]=previewMemoryBankImport"));
  assert.ok(!memoryStore.includes("ctx.chatMetadata[LEGACY_META_KEY]="),'legacy Memory Bank must remain read-only');
  assert.ok(worldStore.includes("NEXUS_CHAT_WORLD_TREE_META_KEY='nexus_world_tree_v1'"));
  assert.ok(worldStore.includes('mutateChatWorldTreeDocumentLocal'));
}

console.log('Area-52 canonical World Tree Memory Bank migration: PASS');
