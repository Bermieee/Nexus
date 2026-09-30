import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createWorldTreeDocument,
  normalizeWorldTreeDocument,
  worldTreeDocumentStats,
} from '../nexus/a52/shared/world-tree-document.js';
import {
  deleteLoreTreeFromWorldTreeDocument,
  loreTreeStructuralEdgeCount,
  loreTreeWorldNodeIds,
  replaceLoreTreeInWorldTreeDocument,
  worldTreeDocumentToLegacyTree,
} from '../nexus/a52/shared/world-tree-tree-codec.js';

const legacy={
  lorebookName:'world',
  version:2,
  lastBuilt:123,
  root:{
    id:'root-old',label:'Root',summary:'All lore',keywords:['world'],entryUids:[1],collapsed:false,
    children:[
      {id:'people',label:'People',summary:'Characters',keywords:['cast'],entryUids:[2,3],collapsed:true,children:[]},
      {id:'places',label:'Places',summary:'Locations',keywords:['location'],entryUids:[4],collapsed:false,children:[
        {id:'city',label:'City',summary:'Capital',keywords:['capital'],entryUids:[5],collapsed:false,children:[]},
      ]},
    ],
  },
};

{
  let doc=createWorldTreeDocument();
  doc=replaceLoreTreeInWorldTreeDocument(doc,'world',legacy);
  const stats=worldTreeDocumentStats(doc);
  assert.equal(stats.byKind['tree-root'],1);
  assert.equal(stats.byKind['tree-topic'],3);
  assert.equal(stats.byKind.lore,5);
  assert.equal(stats.loreRoots,1);
  assert.equal(loreTreeWorldNodeIds(doc,'world').length,4);
  assert.equal(loreTreeStructuralEdgeCount(doc,'world'),8);

  const projected=worldTreeDocumentToLegacyTree(doc,'world');
  assert.deepEqual(projected,legacy,'legacy Tree API must round-trip through World Tree nodes/edges');

  const edited=structuredClone(legacy);
  edited.root.children=edited.root.children.filter(node=>node.id!=='places');
  edited.root.entryUids=[1,6];
  edited.lastBuilt=456;
  doc=replaceLoreTreeInWorldTreeDocument(doc,'world',edited);
  assert.equal(loreTreeWorldNodeIds(doc,'world').length,2,'removed legacy topics must not survive replacement');
  assert.ok(doc.nodes['lore:world:4'],'lore artifact nodes survive structural removal');
  assert.ok(doc.nodes['lore:world:6'],'new lore artifact is represented');
  assert.deepEqual(worldTreeDocumentToLegacyTree(doc,'world'),edited);

  doc=deleteLoreTreeFromWorldTreeDocument(doc,'world');
  assert.equal(worldTreeDocumentToLegacyTree(doc,'world'),null);
  assert.ok(doc.nodes['lore:world:1'],'deleting structural Tree must not delete lore artifact identity');
}

{
  const malformed=normalizeWorldTreeDocument({
    version:99,
    revision:4,
    nodes:{
      x:{id:'x',kind:'thread',scope:'chat-1',revision:2,edges:[],payload:{name:'A'}},
      bad:{id:'',kind:'lore'},
    },
    roots:{lore:{world:'missing'}},
  });
  assert.equal(malformed.version,1);
  assert.equal(malformed.revision,4);
  assert.ok(malformed.nodes.x);
  assert.equal(malformed.nodes.bad,undefined);
  assert.equal(malformed.roots.lore.world,undefined);
}

{
  const treeStore=fs.readFileSync(new URL('../tree/store.js',import.meta.url),'utf8');
  const settings=fs.readFileSync(new URL('../core/settings.js',import.meta.url),'utf8');
  const worldStore=fs.readFileSync(new URL('../nexus/world-tree-store.js',import.meta.url),'utf8');

  assert.ok(treeStore.includes('getGlobalWorldTreeDocument'));
  assert.ok(treeStore.includes('replaceLoreTreeInWorldTreeDocument'));
  assert.ok(treeStore.includes("runtimeRemoved:'settings.trees'"));
  assert.ok(!treeStore.includes('settings.trees[book] ='));
  assert.ok(!treeStore.includes('settings.trees[row.book] ='));

  assert.ok(settings.includes("worldTree: { kind:'NexusWorldTreeDocument'"));
  assert.ok(worldStore.includes("logEvent('world-tree','global-mutated'"));
  assert.ok(worldStore.includes('legacyTreeBooks'));
}

console.log('Area-52 canonical World Tree Lore Tree migration: PASS');
