import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusWorldTree } from '../world-tree/store.js';
import { replaceNexusWorldTree } from '../world-tree/index.js';
import { importLegacyLoreBookToWorldTree, loreFactWorldNodeId } from '../world-tree/import-lore.js';
import { createCanonicalWorldTreeReadApi, loreNodeId } from '../core/world-tree-api.js';

function learn(tree,entries){
  importLegacyLoreBookToWorldTree(tree,{book:'Reader test',data:{entries}});
}
function entry(uid,name,status='CURRENT'){
  return {uid,comment:name,content:name+' is here.',key:[name],extensions:{nexusTemporal:{status}}};
}
test('existing canonical reader observes owner updates, aliases, edges and removal',()=>{
  const tree=new NexusWorldTree();
  learn(tree,{one:entry(1,'First')});
  const api=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'chat-a'});
  const original=api.worldRevision;
  learn(tree,{one:entry(1,'Renamed','HISTORICAL'),two:entry(2,'Second')});
  assert.ok(api.worldRevision>original);
  assert.equal(api.temporalStatus(loreNodeId('Reader test',1)),'HISTORICAL');
  assert.equal(api.findByAlias('First').length,0);
  assert.ok(api.findByAlias('Renamed').length);
  assert.ok(api.getNode(loreNodeId('Reader test',2)));
  tree.linkEdge({id:'reader-edge',from:loreFactWorldNodeId('Reader test',1),to:loreFactWorldNodeId('Reader test',2),relation:'relationship',data:{subtype:'related-to'},scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['reader']},temporal:{status:'CURRENT'}});
  assert.ok(api.edgesFrom(loreNodeId('Reader test',1)).some(row=>row.to===loreNodeId('Reader test',2)));
  tree.removeNode(loreFactWorldNodeId('Reader test',2));
  assert.equal(api.getNode(loreNodeId('Reader test',2)),null);
  assert.equal(api.edgesFrom(loreNodeId('Reader test',1)).length,0);
  assert.equal(api.upsertNode,undefined,'production reader cannot mutate a parallel tree');
});
test('default reader follows replacement of the canonical owner',()=>{
  const first=replaceNexusWorldTree();learn(first,{one:entry(1,'First')});
  const api=createCanonicalWorldTreeReadApi();
  assert.ok(api.getNode(loreNodeId('Reader test',1)));
  const second=replaceNexusWorldTree();learn(second,{two:entry(2,'Second')});
  assert.equal(api.getNode(loreNodeId('Reader test',1)),null);
  assert.ok(api.getNode(loreNodeId('Reader test',2)));
  replaceNexusWorldTree();
});
