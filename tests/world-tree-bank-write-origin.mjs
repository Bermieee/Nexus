import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { replaceNexusWorldTree, getNexusWorldTreeOwner } from '../world-tree/index.js';
import { importLegacyMemoryRecordsToWorldTree } from '../world-tree/import-memory-bank.js';
import { importLegacyCharacterBanksToWorldTree } from '../world-tree/import-character-banks.js';
import { markLegacyWorldTreeMigrated } from '../world-tree/durable-state.js';
import { syncMemoryFacadeToWorldTree, syncCharacterFacadeToWorldTree, worldTreeBankAuthorityEnabled } from '../world-tree/native-bank-authority.js';
import { applyWorldTreeCharacterState } from '../world-tree/character-state-contribution.js';
import { characterStateWorldNodeId, localCharacterWorldNodeId } from '../world-tree/character-schema.js';

const ctx=()=>({chatId:'chat-a',chatMetadata:{},saveMetadataDebounced(){}});
const memory=id=>({id,layer:0,text:'Memory '+id,turnRange:[0,1],assistantTurnRange:[1,1],sourceMessageIds:['m0','m1'],sourceFingerprint:'fp',characters:[],locations:[],dates:[],topics:[],threads:[],childIds:[],parentId:null,promotedTo:null,routeState:'unrouted',routeProposalIds:[],routeReasoning:'',routeEvaluation:null,createdAt:1,updatedAt:2,permanent:false,locked:false});
const bank=id=>({id,storyId:'chat-a',enabled:true,character:'Mara',role:'lead',sceneAware:true,cardBinding:null,linkedRefs:[],memoryIds:[],memoryRefs:[],profile:{personality:'steady',appearance:'',clothingArmor:''},state:{baseline:{personality:'steady'},persistent:{relationships:''},temporary:{}},stateProposals:[],changeHistory:[],fieldProvenance:{},cardSync:{},tracking:{personality:true,relationships:true,status:true,goals:true,behavior:true}});

test('post-migration Memory compatibility write settles into persisted World Tree authority',()=>{
  const context=ctx(),tree=replaceNexusWorldTree(),m1=memory('m1');
  importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[m1],control:{activeLayers:[['m1']]}});
  markLegacyWorldTreeMigrated({tree,context,memoryBackup:{records:{m1}},characterBackup:{enabled:true,banks:[]}});
  assert.equal(worldTreeBankAuthorityEnabled(context),true);
  const m2={...m1,text:'Updated memory',updatedAt:3};
  const receipt=syncMemoryFacadeToWorldTree({context,records:[m2],control:{activeLayers:[['m1']],lastUpdatedAt:3},reason:'test'});
  assert.equal(receipt.kind,'NexusWorldTreeMemoryWriteOrigin');
  const node=[...getNexusWorldTreeOwner().iterateNodes({chatId:'chat-a',kind:'MEMORY'})].find(row=>row.data?.sourceRecord?.id==='m1');
  assert.equal(node.data.sourceRecord.text,'Updated memory');assert.equal(node.data.canonicalOwner,'WORLD_TREE');assert.equal(node.data.compatibilityMirror,null);
  assert.ok(context.chatMetadata.nexus_world_tree_chat_state_v1);
});

test('post-migration Character compatibility write settles Character State into persisted World Tree authority',()=>{
  const context=ctx(),tree=replaceNexusWorldTree(),b1=bank('c1');
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'chat-a',banks:[b1],control:{enabled:true}});
  markLegacyWorldTreeMigrated({tree,context,memoryBackup:{records:{}},characterBackup:{enabled:true,banks:[b1]}});
  const b2={...b1,state:{...b1.state,persistent:{relationships:'Mara trusts Lili.'}}};
  const receipt=syncCharacterFacadeToWorldTree({context,banks:[b2],control:{enabled:true},reason:'test'});
  assert.equal(receipt.kind,'NexusWorldTreeCharacterWriteOrigin');
  const state=[...getNexusWorldTreeOwner().iterateNodes({chatId:'chat-a',kind:'CHARACTER_STATE'})].find(row=>row.data?.sourceBank?.id==='c1');
  assert.equal(state.data.sourceBank.state.persistent.relationships,'Mara trusts Lili.');assert.equal(state.data.canonicalOwner,'WORLD_TREE');assert.equal(state.data.compatibilityMirror,null);
  assert.ok(context.chatMetadata.nexus_world_tree_chat_state_v1);
});


test('migration marker makes compatibility drift diagnostic instead of read authority',()=>{
  const source=fs.readFileSync(new URL('../memory/store.js',import.meta.url),'utf8');
  assert.ok(source.includes("const migrated=legacyWorldTreeMigrationStatus({context:getContext()})?.migrated===true"));
  assert.ok(source.includes("const snapshot=(migrated||parityAllowsWorldTree)"));
  const characterSource=fs.readFileSync(new URL('../memory/character-banks.js',import.meta.url),'utf8');
  assert.ok(characterSource.includes("const snapshot=(migrated||parityAllowsWorldTree)?characterTreeReadSnapshot"));
});


test('migrated Memory Bank metadata is retired while the compatibility store projects from World Tree',()=>{
  const context=ctx(),tree=replaceNexusWorldTree(),m1=memory('m-retire');context.chatMetadata.tv2_memory_bank={legacy:true};
  importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[m1],control:{activeLayers:[['m-retire']],evidenceRevision:3}});
  markLegacyWorldTreeMigrated({tree,context,memoryBackup:{records:{'m-retire':m1}},characterBackup:{enabled:true,banks:[]}});
  assert.equal(Object.prototype.hasOwnProperty.call(context.chatMetadata,'tv2_memory_bank'),false);
  assert.ok(context.chatMetadata.nexus_world_tree_legacy_migration_v1.backup.memory.records['m-retire']);
});


test('Character compatibility mutation no longer requires durable current-story settings rows after migration',()=>{
  const source=fs.readFileSync(new URL('../memory/character-banks.js',import.meta.url),'utf8');
  assert.ok(source.includes('function treeBackedCharacterFacade(storyId)'));
  assert.ok(source.includes('retireLegacyCharacterBankSettingsForCurrentStory'));
  assert.ok(source.includes('if(migrated)treeBackedCharacterFacade(storyId).banks.push(bank)'));
  assert.ok(source.includes('if(migrated)updated=applyCharacterBankPatchToList(treeBackedCharacterFacade(storyId).banks'));
});


test('live Memory write origin uses native contributions and not the legacy Memory importer',()=>{
  const source=fs.readFileSync(new URL('../world-tree/native-bank-authority.js',import.meta.url),'utf8');
  assert.equal(source.includes('importLegacyMemoryRecordsToWorldTree'),false);
  assert.ok(source.includes('applyWorldTreeMemoryRecordState'));
  const contribution=fs.readFileSync(new URL('../world-tree/memory-contribution.js',import.meta.url),'utf8');
  assert.ok(contribution.includes("source:'memory'"));
  assert.ok(contribution.includes("canonicalOwner:'WORLD_TREE'"));
});


test('native Character State contribution creates state and identity without legacy Character Bank import',()=>{
  const context=ctx(),tree=replaceNexusWorldTree(),b1=bank('native-char');
  const receipt=applyWorldTreeCharacterState({tree,context,banks:[b1],control:{enabled:true}});
  assert.equal(receipt.kind,'NexusWorldTreeCharacterStateWrite');
  const state=tree.getNode(characterStateWorldNodeId('chat-a','native-char'),{chatId:'chat-a'}),identity=tree.getNode(localCharacterWorldNodeId('chat-a','native-char'),{chatId:'chat-a'});
  assert.ok(state);assert.ok(identity);assert.equal(state.data.canonicalOwner,'WORLD_TREE');assert.equal(state.data.importedFrom,undefined);assert.equal(state.data.nativeCharacterState,true);
  assert.ok(tree.read({chatId:'chat-a',limit:5000}).edges.some(edge=>edge.from===state.id&&edge.to===identity.id&&edge.relation==='state-of'));
});

test('live Character write origin uses native contributions and not the legacy Character importer or direct tree upserts',()=>{
  const source=fs.readFileSync(new URL('../world-tree/native-bank-authority.js',import.meta.url),'utf8');
  assert.equal(source.includes('importLegacyCharacterBanksToWorldTree'),false);
  assert.equal(source.includes('tree.upsertNode('),false);
  assert.ok(source.includes('applyWorldTreeCharacterState'));
});
