import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceNexusWorldTree, getNexusWorldTreeOwner } from '../world-tree/index.js';
import { importLegacyMemoryRecordsToWorldTree } from '../world-tree/import-memory-bank.js';
import { importLegacyCharacterBanksToWorldTree } from '../world-tree/import-character-banks.js';
import { markLegacyWorldTreeMigrated } from '../world-tree/durable-state.js';
import { syncMemoryFacadeToWorldTree, syncCharacterFacadeToWorldTree, worldTreeBankAuthorityEnabled } from '../world-tree/native-bank-authority.js';

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
  assert.equal(node.data.sourceRecord.text,'Updated memory');assert.equal(node.data.canonicalOwner,'WORLD_TREE');assert.equal(node.data.compatibilityMirror,'MEMORY_BANK');
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
  assert.equal(state.data.sourceBank.state.persistent.relationships,'Mara trusts Lili.');assert.equal(state.data.canonicalOwner,'WORLD_TREE');assert.equal(state.data.compatibilityMirror,'CHARACTER_BANK');
  assert.ok(context.chatMetadata.nexus_world_tree_chat_state_v1);
});
