import test from 'node:test';
import assert from 'node:assert/strict';
import {NexusWorldTree} from '../world-tree/store.js';
import {createStoryWorldTreeView} from '../world-tree/story-view.js';

import {readWorldTreeCharacterInspection as inspect} from '../world-tree/character-inspection.js';
function fixture(){
  const tree=new NexusWorldTree(),binding={chatId:'one',book:'Book'};
  const node=(id,kind,data,chatId=null,status='CURRENT')=>tree.upsertNode({id,kind,data,scope:chatId?{type:'CHAT',chatId}:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[id]},temporal:{status}});
  node('lore:mara','LORE_FACT',{label:'Mara',keys:['Captain Mara'],book:'Book',trackedCharacter:true});
  node('lore:lili','LORE_FACT',{label:'Lili',book:'Book',trackedCharacter:true});
  node('lore:foreign','LORE_FACT',{label:'Mara',book:'Other',trackedCharacter:true});
  node('card:mara','CHARACTER',{label:'Mara',aliases:['Captain Mara'],trackedCharacter:true});
  node('state:one','CHARACTER_STATE',{label:'Mara',characterNodeId:'card:mara',state:{baseline:{personality:'Careful'},persistent:{relationships:'Trusts Lili'},temporary:{mood:'Alert'}},profile:{appearance:'Scar'},sourceBank:{id:'mara',storyId:'one'}},'one');
  node('state:two','CHARACTER_STATE',{label:'Mara',characterNodeId:'card:mara',state:{temporary:{mood:'Foreign secret'}}},'two');
  node('memory:scene','CHARACTER_MEMORY',{character:'lore:mara',summary:'Heard the warning',status:'closed',sceneId:'scene:gate',time:{storyTime:'Dawn'}},'one','HISTORICAL');
  node('scene:gate','SCENE',{label:'Gate'},'one');
  node('memory:linked','MEMORY',{text:'The caravan survived',sourcePresent:true},'one','HISTORICAL');
  node('memory:foreign','CHARACTER_MEMORY',{character:'lore:mara',summary:'Foreign memory'},'two');
  node('memory:lili','CHARACTER_MEMORY',{character:'lore:lili',summary:'Lili secret'},'one');
  node('memory:old','CHARACTER_MEMORY',{character:'lore:mara',summary:'Superseded fact'},'one','SUPERSEDED');
  tree.linkEdge({id:'linked',from:'state:one',to:'memory:linked',relation:'has-memory',scope:{type:'CHAT',chatId:'one'},provenance:{sourceType:'TEST',sourceIds:['linked']}});
  const view=()=>createStoryWorldTreeView(tree,{chatMetadata:{}},binding);
  return{tree,binding,node,view};
}
test('selected lore character resolves state and both memory sources through the bound view',()=>{
  const f=fixture(),before=f.tree.exportState();
  const result=inspect({tree:f.view(),binding:f.binding,nodeId:'lore:mara'});
  assert.equal(result.isCharacter,true);assert.equal(result.states[0].state.baseline.personality,'Careful');
  assert.equal(result.states[0].profile.appearance,'Scar');
  assert.deepEqual(result.memories.map(m=>m.text).sort(),['Heard the warning','The caravan survived']);
  assert.equal(result.memories.find(m=>m.id==='memory:scene').scene,'Gate');
  assert.equal(result.memories.find(m=>m.id==='memory:scene').time,'Dawn');
  assert.deepEqual(f.tree.exportState(),before,'inspection must never mutate story or authored lore');
});
test('inspection rejects another book, another chat and an absent binding',()=>{
  const f=fixture();
  assert.equal(inspect({tree:f.view(),binding:f.binding,nodeId:'lore:foreign'}),null);
  assert.equal(inspect({tree:f.view(),binding:f.binding,nodeId:'state:two'}),null);
  assert.equal(inspect({tree:f.tree,binding:null,nodeId:'lore:mara'}),null);
  const result=inspect({tree:f.view(),binding:f.binding,nodeId:'lore:lili'});
  assert.deepEqual(result.states,[]);assert.deepEqual(result.memories.map(m=>m.text),['Lili secret']);
});
test('same-name ambiguous characters do not borrow another identity state or memories',()=>{
  const f=fixture();f.node('card:duplicate','CHARACTER',{label:'Mara'});
  f.node('duplicate-state','CHARACTER_STATE',{label:'Mara',characterNodeId:'card:duplicate',state:{temporary:{mood:'Wrong person'}}},'one');
  const result=inspect({tree:f.view(),binding:f.binding,nodeId:'lore:mara'});
  assert.equal(result.status,'AMBIGUOUS');assert.deepEqual(result.states,[]);
  assert.deepEqual(result.memories.map(m=>m.text),['Heard the warning']);
});
test('card inspection includes the same lore UID scene memories without merging different characters',()=>{
  const f=fixture(),result=inspect({tree:f.view(),binding:f.binding,nodeId:'card:mara'});
  assert.deepEqual(result.memories.map(m=>m.text).sort(),['Heard the warning','The caravan survived']);
});
test('story memories explicitly about a character appear as story context, not personal scene memories',()=>{
  const f=fixture();f.node('memory:tagged','MEMORY',{text:'Mara negotiated the crossing',characters:['Mara']},'one','HISTORICAL');
  f.node('memory:about','MEMORY',{text:'The captain accepted the terms'},'one','HISTORICAL');
  f.tree.linkEdge({id:'about',from:'memory:about',to:'lore:mara',relation:'about',scope:{type:'CHAT',chatId:'one'},provenance:{sourceType:'TEST',sourceIds:['about']}});
  const result=inspect({tree:f.view(),binding:f.binding,nodeId:'lore:mara'});
  assert.deepEqual(result.memories.filter(m=>m.kind==='MEMORY').map(m=>m.text).sort(),['Mara negotiated the crossing','The captain accepted the terms','The caravan survived']);
});
test('a character with no learned state still exposes its authored information',()=>{
  const f=fixture();f.node('lore:new','LORE_FACT',{label:'New scout',book:'Book',trackedCharacter:true,content:'An experienced navigator from the northern mountains.'});
  const result=inspect({tree:f.view(),binding:f.binding,nodeId:'lore:new'});
  assert.equal(result.authoredProfile,'An experienced navigator from the northern mountains.');
  assert.deepEqual(result.states,[]);assert.deepEqual(result.memories,[]);
});
test('name-tagged story memories are withheld when two tracked UIDs share that name',()=>{
  const f=fixture();f.node('lore:second-mara','LORE_FACT',{label:'Mara',book:'Book',trackedCharacter:true});
  f.node('memory:tagged','MEMORY',{text:'An unidentified Mara left town',characters:['Mara']},'one');
  const result=inspect({tree:f.view(),binding:f.binding,nodeId:'lore:mara'});
  assert.equal(result.memories.some(memory=>memory.id==='memory:tagged'),false);
});
