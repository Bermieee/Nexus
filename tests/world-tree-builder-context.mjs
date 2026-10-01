import test from 'node:test';
import assert from 'node:assert/strict';
import {NexusWorldTree} from '../world-tree/store.js';
const api=await import('../builder2/world-context.js').catch(()=>({}));
function fixture(){
  const worldTree=new NexusWorldTree();
  for(const [id,kind,scope] of [['people','LORE_GROUP',{type:'GLOBAL'}],['local','CHARACTER',{type:'CHAT',chatId:'a'}],['foreign','CHARACTER',{type:'CHAT',chatId:'b'}]]) worldTree.upsertNode({id,kind,scope,provenance:{sourceType:'LORE',sourceIds:['A#1']},data:{label:kind==='CHARACTER'?'Alex':'People'}});
  return {worldTree,chatId:'a',selectedSources:[{book:'A',uid:1,fingerprint:'a',title:'Alex',content:'Person'},{book:'B',uid:1,fingerprint:'b'}],authorizedSourceIds:['A#1']};
}
test('context reads wider groups and authorized story identities without merging names',()=>{
  assert.equal(typeof api.readBuilderWorldContext,'function');
  const context=api.readBuilderWorldContext(fixture());
  assert.equal(context.groups.some(g=>g.id==='people'),true);
  assert.deepEqual(context.sources.map(s=>s.sourceId),['A#1']);
  assert.equal(context.entities.some(e=>e.id==='foreign'),false);
  assert.equal(context.identityMatches[0].status,'UNRESOLVED');
  assert.equal(context.identityMatches[0].candidateId,'local');
  assert.equal(context.coverage.excluded[0].sourceId,'B#1');
});
test('all authorized sources survive analysis batching with distinct book identities',()=>{
  assert.equal(typeof api.readBuilderWorldContext,'function');
  const f=fixture(); f.selectedSources=Array.from({length:73},(_,uid)=>({book:'A',uid,fingerprint:String(uid),content:'source'})); f.authorizedSourceIds=f.selectedSources.map(s=>`A#${s.uid}`);
  const context=api.readBuilderWorldContext(f), adapted=api.adaptWorldContextForBuilder2(context);
  assert.equal(adapted.worksetSources.length,73);
  assert.equal(adapted.treeInventory.nodes.some(n=>n.id==='people'),true);
  assert.equal(adapted.worldRevision,context.worldRevision);
  assert.equal(context.coverage.complete,true);
});
