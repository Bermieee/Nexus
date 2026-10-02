import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NexusWorldTree } from '../world-tree/store.js';
import {
  importLegacyCharacterBanksToWorldTree,
  characterStateWorldNodeId,
  localCharacterWorldNodeId,
  legacyCharacterControlWorldNodeId,
} from '../world-tree/import-character-banks.js';
import { compareCharacterBankParity } from '../world-tree/character-read-parity.js';

const bank=(id='c1',character='Mara')=>({
  id,storyId:'one',enabled:true,character,role:'supporting',sceneAware:true,
  cardBinding:null,
  linkedRefs:[{book:'World',uid:7,title:'Mara',nodeId:'n',nodeLabel:'People',path:['People']}],
  memoryIds:['m1'],memoryRefs:[{chatId:'one',id:'m1'}],
  profile:{personality:'dry',appearance:'scar',clothingArmor:'coat'},
  state:{revision:3,aliases:['Captain Mara'],baseline:{personality:'dry'},persistent:{relationships:'trusts Lili'}},
  stateProposals:[{id:'p1',field:'persistent.relationships',status:'pending'}],
  changeHistory:[{id:'h1',field:'persistent.relationships',at:10}],
  fieldProvenance:{'persistent.relationships':[{provenanceRef:'memory:m1'}]},
  cardSync:{fingerprint:'card-fp',lastSyncedAt:11},
  tracking:{personality:true,relationships:true,status:true,goals:false,behavior:true},
});

test('complete Character Bank survives World Tree export/reload and parity',()=>{
  const tree=new NexusWorldTree(),source=bank();
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'one',banks:[source],control:{enabled:true}});
  const node=tree.getNode(characterStateWorldNodeId('one',source.id),{chatId:'one'});
  assert.deepEqual(node.data.sourceBank,source);
  assert.equal(node.data.sourcePresent,true);
  assert.equal(node.data.sourceOrder,0);
  assert(tree.getNode(localCharacterWorldNodeId('one',source.id),{chatId:'one'}));
  const restored=new NexusWorldTree({snapshot:tree.exportState()});
  const parity=compareCharacterBankParity(restored,{chatId:'one',banks:[source],control:{enabled:true}});
  assert.equal(parity.status,'PASS');assert.equal(parity.controlMetadata,'PASS');
});

test('tracking/proposal/history-only changes refresh Character import',()=>{
  const tree=new NexusWorldTree(),source=bank();
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'one',banks:[source],control:{enabled:true}});
  const changed={...source,tracking:{...source.tracking,goals:true},stateProposals:[...source.stateProposals,{id:'p2',field:'persistent.goalsMotivations',status:'pending'}],changeHistory:[...source.changeHistory,{id:'h2',field:'persistent.goalsMotivations',at:12}]};
  const receipt=importLegacyCharacterBanksToWorldTree(tree,{chatId:'one',banks:[changed],control:{enabled:true}});
  assert(receipt.updated.includes(characterStateWorldNodeId('one',source.id)));
  assert.equal(compareCharacterBankParity(tree,{chatId:'one',banks:[changed],control:{enabled:true}}).status,'PASS');
});

test('Character order is preserved and participates in parity',()=>{
  const tree=new NexusWorldTree(),a=bank('a','A'),b=bank('b','B');
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'one',banks:[a,b],control:{enabled:true}});
  assert.equal(tree.getNode(characterStateWorldNodeId('one','a'),{chatId:'one'}).data.sourceOrder,0);
  assert.equal(tree.getNode(characterStateWorldNodeId('one','b'),{chatId:'one'}).data.sourceOrder,1);
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'one',banks:[b,a],control:{enabled:true}});
  assert.equal(tree.getNode(characterStateWorldNodeId('one','b'),{chatId:'one'}).data.sourceOrder,0);
  assert.equal(tree.getNode(characterStateWorldNodeId('one','a'),{chatId:'one'}).data.sourceOrder,1);
  assert.equal(compareCharacterBankParity(tree,{chatId:'one',banks:[b,a],control:{enabled:true}}).status,'PASS');
});

test('removed local Character Bank becomes superseded audit history and can restore',()=>{
  const tree=new NexusWorldTree(),source=bank();
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'one',banks:[source],control:{enabled:true}});
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'one',banks:[],control:{enabled:true}});
  const state=tree.getNode(characterStateWorldNodeId('one',source.id),{chatId:'one'});
  const identity=tree.getNode(localCharacterWorldNodeId('one',source.id),{chatId:'one'});
  assert.equal(state.temporal.status,'SUPERSEDED');assert.equal(state.data.sourcePresent,false);
  assert.equal(identity.temporal.status,'SUPERSEDED');assert.equal(identity.data.sourcePresent,false);
  assert.equal(compareCharacterBankParity(tree,{chatId:'one',banks:[],control:{enabled:true}}).status,'PASS');
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'one',banks:[source],control:{enabled:true}});
  assert.equal(compareCharacterBankParity(tree,{chatId:'one',banks:[source],control:{enabled:true}}).status,'PASS');
});

test('Character control enable state is canonical parity metadata',()=>{
  const tree=new NexusWorldTree(),source=bank();
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'one',banks:[source],control:{enabled:false}});
  const control=tree.getNode(legacyCharacterControlWorldNodeId('one'),{chatId:'one'});
  assert.equal(control.kind,'SUMMARY');assert.equal(control.data.enabled,false);
  assert.equal(compareCharacterBankParity(tree,{chatId:'one',banks:[source],control:{enabled:false}}).status,'PASS');
  const mismatch=compareCharacterBankParity(tree,{chatId:'one',banks:[source],control:{enabled:true}});
  assert.equal(mismatch.status,'MISMATCH');assert.equal(mismatch.controlMetadata,'MISMATCH');
});

test('Character family readers share one parity-gated World Tree authority',()=>{
  const source=fs.readFileSync(new URL('../memory/character-banks.js',import.meta.url),'utf8');
  for(const required of [
    'function characterReadAuthoritySnapshot()',
    "parity.status==='PASS'&&parity.controlMetadata==='PASS'",
    "authority:'WORLD_TREE'",
    "authority:'OWNER_IMPORT'",
    'export function getCharacterOwnerBanks',
    'export function getCharacterReadAuthorityStatus()',
    'export function getCharacterReadControlSnapshot()',
    'return clone(characterReadAuthoritySnapshot().banks)',
  ])assert.ok(source.includes(required),'Character cutover contract missing '+required);
  assert.ok(source.includes('const cfg = getCharacterReadControlSnapshot();'),'Character runtime policy must read the switched control projection');

  const bridge=fs.readFileSync(new URL('../world-tree/legacy-world-bridge.js',import.meta.url),'utf8');
  for(const required of [
    'getCharacterOwnerBanks','getCharacterOwnerControlSnapshot','compareCharacterBankParity',
    "logSystemEvent('nexus.gather','character.read-parity'","characterReadAuthority=getCharacterReadAuthorityStatus()",
  ])assert.ok(bridge.includes(required),'Character bridge parity/cutover wiring missing '+required);
  assert.equal(bridge.includes('banks:getCharacterBanks('),false,'Character importer must never read through its own switched family API');
});
