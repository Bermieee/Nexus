import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NexusWorldTree } from '../world-tree/store.js';
import { setWorldTreeCharacterTracking,resolveTrackedCharacterReference,trackedSceneCharacterNames,observeWorldTreeTrackAppearances,recordWorldTreeTrackSuggestion,readWorldTreeTrackSuggestions } from '../world-tree/tracking.js';

const context=chatId=>({chatId,chatMetadata:{},saveMetadataDebounced(){}});
function loreNpc(tree,id='lore:garrick'){
  tree.upsertNode({id,kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST_LORE',sourceIds:[id],sourceRevisionIds:['r1']},temporal:{status:'CURRENT'},data:{label:'Garrick — Innkeeper',keys:['Garrick','Innkeeper Garrick']}});
  return tree.getNode(id);
}

test('owner tracking toggle updates the global UID through one intake revision and registers character aliases',async()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a');loreNpc(tree);const before=tree.revision;
  const on=await setWorldTreeCharacterTracking({nodeId:'lore:garrick',tracked:true,tree,context:ctx});
  assert.equal(on.tracked,true);assert.equal(tree.revision,before+1);assert.equal(tree.getNode('lore:garrick').data.tracking,'active');
  const resolved=tree.identityRegistry.resolveMention({label:'Garrick',entityType:'CHARACTER'});
  assert.equal(resolved.entity?.entityId,'lore:garrick');
  assert.equal(resolveTrackedCharacterReference('Innkeeper Garrick',{tree,chatId:'chat-a'}).nodeId,'lore:garrick');
  const same=await setWorldTreeCharacterTracking({nodeId:'lore:garrick',tracked:true,tree,context:ctx});assert.equal(same.noOp,true);assert.equal(tree.revision,before+1);
});

test('turning tracking off pauses the setting without deleting the UID and Green Room cast selection drops it',async()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a');loreNpc(tree);
  await setWorldTreeCharacterTracking({nodeId:'lore:garrick',tracked:true,tree,context:ctx});
  const scene={chatId:'chat-a',participants:['Garrick']};assert.deepEqual(trackedSceneCharacterNames(scene,{tree,chatId:'chat-a'}),['Garrick']);
  await setWorldTreeCharacterTracking({nodeId:'lore:garrick',tracked:false,tree,context:ctx});
  const node=tree.getNode('lore:garrick');assert.ok(node);assert.equal(node.data.trackedCharacter,false);assert.equal(node.data.tracking,'paused');
  assert.equal(resolveTrackedCharacterReference('Garrick',{tree,chatId:'chat-a'}),null);assert.deepEqual(trackedSceneCharacterNames(scene,{tree,chatId:'chat-a'}),[]);
});

test('tracking refuses chat-local and unsupported nodes',async()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a');
  tree.upsertNode({id:'local',kind:'ENTITY',scope:{type:'CHAT',chatId:'chat-a'},provenance:{sourceType:'TEST',sourceIds:['local'],messageRefs:[{chatId:'chat-a',messageId:'1'}]},temporal:{status:'CURRENT'},data:{label:'Local'}});
  tree.upsertNode({id:'place',kind:'LOCATION',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['place']},temporal:{status:'CURRENT'},data:{label:'Place'}});
  await assert.rejects(()=>setWorldTreeCharacterTracking({nodeId:'local',tree,context:ctx}),/NOT_GLOBAL_UID/);
  await assert.rejects(()=>setWorldTreeCharacterTracking({nodeId:'place',tree,context:ctx}),/NOT_GLOBAL_UID/);
});

test('repeated cast appearances create only a per-chat suggestion and never auto-track',()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a');loreNpc(tree);const before=tree.revision;
  let candidate=null;
  for(let i=1;i<=5;i++){const rows=observeWorldTreeTrackAppearances({context:ctx,tree,scene:{sceneId:'scene-'+i,participants:['Garrick']}});candidate=rows[0];}
  assert.equal(candidate.sceneCount,5);assert.equal(tree.revision,before);assert.notEqual(tree.getNode('lore:garrick').data.trackedCharacter,true);
  recordWorldTreeTrackSuggestion(candidate,{context:ctx,decisionSource:'fallback'});
  const suggestions=readWorldTreeTrackSuggestions({context:ctx,tree});assert.equal(suggestions.length,1);assert.equal(suggestions[0].sceneCount,5);assert.notEqual(tree.getNode('lore:garrick').data.trackedCharacter,true);
});

test('same scene is counted once for fallback threshold',()=>{
  const tree=new NexusWorldTree(),ctx=context('chat-a');loreNpc(tree);
  for(let i=0;i<8;i++)observeWorldTreeTrackAppearances({context:ctx,tree,scene:{sceneId:'same-scene',participants:['Garrick']}});
  const row=observeWorldTreeTrackAppearances({context:ctx,tree,scene:{sceneId:'same-scene',participants:['Garrick']}})[0];assert.equal(row.sceneCount,1);
});

test('Task 2 wiring keeps bound cards automatically tracked and the UI exposes only the allowed tracking controls',()=>{
  const cardProducer=fs.readFileSync(new URL('../world-tree/card-contribution.js',import.meta.url),'utf8');
  assert.ok(cardProducer.includes('trackedCharacter:true'));assert.ok(cardProducer.includes("trackingSource:'bound-character-card'"));
  const importer=fs.readFileSync(new URL('../world-tree/import-character-banks.js',import.meta.url),'utf8');assert.ok(importer.includes('applyDeterministicWorldTreeContribution'));
  const scene=fs.readFileSync(new URL('../nexus/scene-intelligence.js',import.meta.url),'utf8');assert.ok(scene.includes('resolveTrackedCharacterReference'));assert.ok(scene.includes('canonicalEntityId'));
  const green=fs.readFileSync(new URL('../nexus/green-room.js',import.meta.url),'utf8');assert.ok(green.includes('trackedSceneCharacterNames'));
  const ui=fs.readFileSync(new URL('../src/ui-core/lore-neural-graph.js',import.meta.url),'utf8');
  for(const token of ['Track as character','Tracked characters','is-tracked-character','Tracking suggestions'])assert.ok(ui.includes(token),'missing tracking UI token '+token);
});
