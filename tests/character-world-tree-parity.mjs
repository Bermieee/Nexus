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
import { loreFactWorldNodeId } from '../world-tree/import-lore.js';
import { createCanonicalWorldTreeReadApi } from '../core/world-tree-api.js';
import { createWorldTreeGraphProvider } from '../nexus/a52/sensory/walker/world-tree-provider.js';

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

  const migration=fs.readFileSync(new URL('../world-tree/legacy-migration.js',import.meta.url),'utf8');
  for(const required of [
    'getCharacterOwnerBanks','getCharacterOwnerControlSnapshot','compareCharacterBankParity',
    "logSystemEvent('nexus.gather','character.read-parity'","characterReadAuthority=getCharacterReadAuthorityStatus()",
  ])assert.ok(migration.includes(required),'Character migration parity/cutover wiring missing '+required);
  assert.equal(migration.includes('banks:getCharacterBanks('),false,'Character importer must never read through its own switched family API');
  assert.equal(migration.includes("tv2-character-banks-updated"),false,'retired Character Bank events must not drive World Tree mutation');
});


test('Character State relationships and Lore evidence become traversable World Tree graph semantics',()=>{
  const tree=new NexusWorldTree(),mara=bank('mara','Mara'),lili=bank('lili','Lili');
  mara.state={...mara.state,persistent:{...mara.state.persistent,relationships:'Mara trusts Lili and relies on her judgment.',goalsMotivations:'Protect the caravan.'}};
  mara.linkedRefs=[{book:'World',uid:7,title:'Mara and Lili',nodeId:'n',nodeLabel:'People',path:['People']}];
  tree.upsertNode({id:loreFactWorldNodeId('World',7),kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['World','7']},temporal:{status:'CURRENT'},data:{label:'Mara and Lili',book:'World',uid:7,content:'Their alliance is documented.'}});
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'one',banks:[mara,lili],control:{enabled:true}});
  const maraId=localCharacterWorldNodeId('one','mara'),liliId=localCharacterWorldNodeId('one','lili'),stateId=characterStateWorldNodeId('one','mara');
  const current=tree.read({chatId:'one',limit:5000}).edges.filter(edge=>edge.temporal.status==='CURRENT');
  assert.ok(current.some(edge=>edge.from===maraId&&edge.to===liliId&&edge.relation==='relationship'&&edge.data?.subtype==='character-state'));
  assert.ok(current.some(edge=>edge.from===stateId&&edge.to===loreFactWorldNodeId('World',7)&&edge.relation==='derived-from'));
  const read=createCanonicalWorldTreeReadApi({chatId:'one',worldTree:tree}),stateNode=read.getNode(stateId);
  assert.match(stateNode.payload.text,/Relationships: Mara trusts Lili/);assert.match(stateNode.payload.text,/Goals: Protect the caravan/);
  const provider=createWorldTreeGraphProvider({worldTree:read,chatId:'one'}),edges=provider.query({anchorEntityIds:[maraId],maxDepth:2,maxEdges:64});
  assert.ok(edges.some(edge=>edge.edgeMeaning==='relationship'&&edge.relationshipRefs?.includes('character-state')));
  assert.ok(edges.some(edge=>edge.toEntityId===stateId&&/Mara trusts Lili/.test(edge.representationText)));
});
