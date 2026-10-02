import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NexusWorldTree } from '../world-tree/store.js';
import {
  importLegacyLoreBookToWorldTree,
  loreBookWorldNodeId,
  loreFactWorldNodeId,
  loreGroupWorldNodeId,
} from '../world-tree/import-lore.js';
import {
  compareLoreReadParity,
  reconstructLoreBookFromWorldTree,
  reconstructLoreTreeFromWorldTree,
} from '../world-tree/lore-read-parity.js';

const entry=(uid=7)=>({
  uid,comment:'Mara',content:'Mara is the quartermaster.',key:['Mara','quartermaster'],
  keysecondary:['Familia'],constant:false,selective:true,disable:false,order:42,position:0,depth:4,
  probability:95,useProbability:true,displayIndex:3,
  extensions:{nexusTemporal:{status:'CURRENT',validFrom:'chapter-2'}},
});
const book=()=>({name:'World',scanDepth:2,recursive:true,entries:{'17':entry()}});
const legacyTree=()=>({
  version:3,book:'World',lastBuilt:123,
  root:{id:'root',label:'ROOT',summary:'All lore',keywords:['world'],entryUids:[],children:[
    {id:'people',label:'People',summary:'Characters',keywords:['people','cast'],entryUids:[7],children:[]},
  ]},
});

test('complete Lorebook entry, book metadata and structural Tree survive World Tree import',()=>{
  const tree=new NexusWorldTree(),data=book(),oldTree=legacyTree();
  importLegacyLoreBookToWorldTree(tree,{book:'World',data,legacyTree:oldTree});
  assert.deepEqual(reconstructLoreBookFromWorldTree(tree,'World'),data);
  assert.deepEqual(reconstructLoreTreeFromWorldTree(tree,'World'),oldTree);
  assert.deepEqual(tree.getNode(loreFactWorldNodeId('World',7),{chatId:null}).data.sourceEntry,data.entries['17']);
  assert.equal(tree.getNode(loreFactWorldNodeId('World',7),{chatId:null}).data.sourceEntryKey,'17');
  assert.deepEqual(tree.getNode(loreGroupWorldNodeId('World','people'),{chatId:null}).data.entryUids,[7]);
  const parity=compareLoreReadParity(tree,{book:'World',data,legacyTree:oldTree});
  assert.equal(parity.status,'PASS');assert.equal(parity.controlMetadata,'PASS');
});

test('entry metadata-only edits refresh and parity catches full owner payload',()=>{
  const tree=new NexusWorldTree(),data=book(),oldTree=legacyTree();
  importLegacyLoreBookToWorldTree(tree,{book:'World',data,legacyTree:oldTree});
  const changed=structuredClone(data);changed.entries['17'].displayIndex=9;changed.entries['17'].keysecondary=['Familia','Guild'];
  const receipt=importLegacyLoreBookToWorldTree(tree,{book:'World',data:changed,legacyTree:oldTree});
  assert(receipt.updated.includes(loreFactWorldNodeId('World',7)));
  assert.equal(compareLoreReadParity(tree,{book:'World',data:changed,legacyTree:oldTree}).status,'PASS');
});

test('removed lore source is audit history but no longer reconstructed as a live read',()=>{
  const tree=new NexusWorldTree(),data=book(),oldTree=legacyTree();
  importLegacyLoreBookToWorldTree(tree,{book:'World',data,legacyTree:oldTree});
  const empty={...data,entries:{}};
  const emptyTree={...oldTree,root:{...oldTree.root,children:[]}};
  importLegacyLoreBookToWorldTree(tree,{book:'World',data:empty,legacyTree:emptyTree});
  const historical=tree.getNode(loreFactWorldNodeId('World',7),{chatId:null});
  assert.equal(historical.temporal.status,'SUPERSEDED');assert.equal(historical.data.sourcePresent,false);
  assert.deepEqual(reconstructLoreBookFromWorldTree(tree,'World').entries,{});
  assert.equal(compareLoreReadParity(tree,{book:'World',data:empty,legacyTree:emptyTree}).status,'PASS');
});

test('structural group mismatch blocks Lore cutover independently of source snapshot',()=>{
  const tree=new NexusWorldTree(),data=book(),oldTree=legacyTree();
  importLegacyLoreBookToWorldTree(tree,{book:'World',data,legacyTree:oldTree});
  const group=tree.getNode(loreGroupWorldNodeId('World','people'),{chatId:null});
  tree.upsertNode({...group,data:{...group.data,entryUids:[]}});
  const parity=compareLoreReadParity(tree,{book:'World',data,legacyTree:oldTree});
  assert.equal(parity.status,'MISMATCH');assert.equal(parity.controlMetadata,'MISMATCH');assert(parity.controlMismatches.includes('groups'));
});

test('Lore family gates both content and structural reads and preserves explicit owner APIs for import/write',()=>{
  const loreStore=fs.readFileSync(new URL('../lore/store.js',import.meta.url),'utf8');
  assert.ok(loreStore.includes('export async function loadBookOwner(book)'));
  assert.ok(loreStore.includes("if(loreReadAuthorityStatus(book).authority==='WORLD_TREE')"));
  assert.ok(loreStore.indexOf("if(loreReadAuthorityStatus(book).authority==='WORLD_TREE')")<loreStore.indexOf('return clone(await loadBookOwner(book));'),'verified reads must decide World Tree authority before touching owner book storage');
  assert.ok(loreStore.includes("invalidateLoreReadAuthority(book,'owner-book-saved')"));
  assert.ok(loreStore.includes('data = clone(await loadBookOwner(book));'),'writer rebase must remain owner-side');

  const treeStore=fs.readFileSync(new URL('../tree/store.js',import.meta.url),'utf8');
  assert.ok(treeStore.includes('export function getTreeOwner(book)'));
  assert.ok(treeStore.includes("if(loreReadAuthorityStatus(book).authority==='WORLD_TREE')"));
  assert.ok(treeStore.includes("invalidateLoreReadAuthority(book,'owner-tree-saved')"));
  assert.ok(treeStore.includes('treeBaseline(book) { return semanticSnapshot(getTreeOwner(book));'),'mutation baselines must remain owner-side');

  const bridge=fs.readFileSync(new URL('../world-tree/legacy-lore-bridge.js',import.meta.url),'utf8');
  for(const required of [
    'loadBookOwner','getTreeOwner','compareLoreReadParity',
    "logSystemEvent('nexus.gather','lore.read-parity'",
    'setLoreReadAuthority({book:binding.book,parity:after})',
    "readersSwitched:phase==='POST_IMPORT'&&loreReadAuthority.readersSwitched===true",
  ])assert.ok(bridge.includes(required),'Lore bridge cutover wiring missing '+required);
  assert.equal(bridge.includes('await loadBook(binding.book)'),false,'Lore bridge must not import through its own switched read API');
  assert.equal(bridge.includes('getTree(binding.book)'),false,'Lore bridge must not import through its own switched Tree API');
});

test('Lore parity diagnostics are metadata-only',()=>{
  const tree=new NexusWorldTree(),data=book(),oldTree=legacyTree();
  importLegacyLoreBookToWorldTree(tree,{book:'World',data,legacyTree:oldTree});
  const node=tree.getNode(loreFactWorldNodeId('World',7),{chatId:null});delete node.data.sourceEntry.displayIndex;tree.upsertNode(node);
  const parity=compareLoreReadParity(tree,{book:'World',data,legacyTree:oldTree});
  assert.equal(parity.status,'MISMATCH');
  const serialized=JSON.stringify(parity);
  assert.equal(serialized.includes('Mara is the quartermaster.'),false);
  assert(parity.fields.includes('displayIndex'));
});
