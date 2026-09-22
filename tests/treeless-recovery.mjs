// Run: node --experimental-vm-modules tests/treeless-recovery.mjs
// Real recovery lifecycle and Tree operations; only host storage is replaced.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
let book, tree;
const stubs = {
 'lore/store.js': { clone, loadBook: async () => clone(book), saveBook: async (_,v) => {book=clone(v);}, findEntryByUid: (entries,uid) => {const rows=Object.values(entries||{}).filter(x=>Number(x.uid)===Number(uid));return rows.length===1?rows[0]:null;} },
 'tree/store.js': {getTree:()=>clone(tree),setTreeDirect:(_,v)=>(tree=clone(v)),deleteTreeDirect:()=>{tree=null;},setTreeBundleDirect:()=>{throw Error('unexpected bundle');}},
 'core/settings.js': {flushSettingsPersistence:async()=>{}},
 'nexus/host-durability.js':{flushChatMetadataPersistence:async()=>{}},
 'nexus/mutation-lock.js':{assertNexusMutationAuthority:()=>{},loreMutationResource:b=>'lore:'+b,treeMutationResource:b=>'tree:'+b,metadataMutationResource:b=>'metadata:'+b},
};
const cache=new Map();
async function load(name){
 if(cache.has(name))return cache.get(name);
 const stub=stubs[name];
 const m=stub?new vm.SyntheticModule(Object.keys(stub),function(){for(const [k,v] of Object.entries(stub))this.setExport(k,v);},{identifier:name}):new vm.SourceTextModule(fs.readFileSync(path.join(root,name),'utf8'),{identifier:name});
 cache.set(name,m);
 await m.link((specifier,parent)=>load(path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier),specifier))));return m;
}
const mod=await load('nexus/mutation-recovery.js');await mod.evaluate();const r=mod.namespace;
const model=cache.get('tree/model.js').namespace,ops=cache.get('tree/ops.js').namespace;
const op={type:'entry.create',book:'Test',title:'A',content:'Canon',keys:['A']};
const entry={uid:1,comment:'A',content:'Canon',key:['A'],constant:false,disable:false,selective:false};
async function staged(withTree=false){book={entries:{}};tree=withTree?model.createTree('Test'):null;return r.captureMutationRecoveryState(op);}
async function written(s){book.entries[1]=clone(entry);return r.checkpointMutationRecoveryState(s,{checkpoint:{domain:'lore',book:'Test',operation:'lore.create',createdUid:1,touchedUids:[1],postBook:clone(book)}});}
let count=0;
async function test(name,fn){try{await fn();console.log('PASS',name);count++;}catch(e){console.error('FAIL',name);throw e;}}
await test('Tree-less create finalizes without manufacturing a Tree',async()=>{const s=await written(await staged());const done=await r.finalizeMutationRecoveryState(s,{executionResult:{createdUid:1}});assert.equal((await r.inspectMutationRecoveryState(done)).state,'post');assert.equal(tree,null);});
await test('interrupted Tree-less create is proven from durable UID checkpoint',async()=>{const s=await written(await staged());assert.equal((await r.inspectMutationRecoveryState(s)).state,'post');});
await test('existing Tree assignment is required and then accepted',async()=>{let s=await written(await staged(true));await assert.rejects(r.finalizeMutationRecoveryState(s,{executionResult:{createdUid:1}}));ops.assignEntry(tree,1);s=await r.checkpointMutationRecoveryState(s,{checkpoint:{domain:'tree',book:'Test',postTree:clone(tree)}});const done=await r.finalizeMutationRecoveryState(s,{executionResult:{createdUid:1}});assert.equal((await r.inspectMutationRecoveryState(done)).state,'post');});
await test('checkpoint cannot prove changed payload, extra UID, missing checkpoint or unexpected Tree',async()=>{const s=await written(await staged());book.entries[1].content='Changed';assert.equal((await r.inspectMutationRecoveryState(s)).compatible,false);book.entries[1]=clone(entry);book.entries[2]={...entry,uid:2};assert.equal((await r.inspectMutationRecoveryState(s)).compatible,false);delete book.entries[2];const noProof=clone(s);noProof.addedUids=[];assert.equal((await r.inspectMutationRecoveryState(noProof)).compatible,false);tree=model.createTree('Test');assert.equal((await r.inspectMutationRecoveryState(s)).compatible,false);});
await test('known legacy failure settles only with matching journal and physical proof',async()=>{
 const s=await written(await staged());s.generatedCompositeExpectation.generatedAssignment={mode:'fresh-created-root'};delete s.preView.assignments;
 const row={state:'recovery-required',physicalPersistenceBegun:true,error:'Create recovery finalization refused because the newly-created Tree did not match the complete canonical create effect.'};
 const upgraded=r.upgradeTreelessCreateRecoveryExpectation(s,op,row);assert.equal((await r.inspectMutationRecoveryState(upgraded)).state,'post');assert.equal(s.generatedCompositeExpectation.generatedAssignment.mode,'fresh-created-root');
 for(const invalid of [{...row,error:'Save failed'},{...row,physicalPersistenceBegun:false}])assert.equal((await r.inspectMutationRecoveryState(r.upgradeTreelessCreateRecoveryExpectation(s,op,invalid))).compatible,false);
 assert.equal((await r.inspectMutationRecoveryState(r.upgradeTreelessCreateRecoveryExpectation(s,{...op,content:'Other'},row))).compatible,false);
 book.entries[1].content='Other';assert.equal((await r.inspectMutationRecoveryState(upgraded)).compatible,false);
});
await test('Tree-less rollback removes only its generated entry and needs no Tree',async()=>{const s=await written(await staged());const done=await r.finalizeMutationRecoveryState(s,{executionResult:{createdUid:1}});const result=await r.applyMutationRecoveryPreStateUnsafe(done);assert.equal(result.verifiedState,'pre');assert.equal(Object.keys(book.entries).length,0);assert.equal(tree,null);});
await test('explicit target requires placement in that node',async()=>{await staged(true);const child=model.createNode('Category');tree.root.children.push(child);const targeted={...op,targetNodeId:child.id};let s=await written(await r.captureMutationRecoveryState(targeted));ops.assignEntry(tree,1);await assert.rejects(r.finalizeMutationRecoveryState(s,{executionResult:{createdUid:1}}));ops.assignEntry(tree,1,child.id);s=await r.checkpointMutationRecoveryState(s,{checkpoint:{domain:'tree',book:'Test',postTree:clone(tree)}});const done=await r.finalizeMutationRecoveryState(s,{executionResult:{createdUid:1}});assert.equal((await r.inspectMutationRecoveryState(done)).state,'post');});
await test('legacy migration does not reinterpret missing or Tree-write checkpoints',async()=>{const s=await written(await staged());s.generatedCompositeExpectation.generatedAssignment={mode:'fresh-created-root'};delete s.preView.assignments;const row={state:'recovery-required',physicalPersistenceBegun:true,error:'Create recovery finalization refused because the newly-created Tree did not match the complete canonical create effect.'};for(const checkpoints of [[],[...s.subwriteCheckpoints,{domain:'tree'}]]){const old={...s,subwriteCheckpoints:checkpoints};assert.equal((await r.inspectMutationRecoveryState(r.upgradeTreelessCreateRecoveryExpectation(old,op,row))).compatible,false);}});
await test('checkpoint rollback preserves unrelated lore and rejects changed owned data',async()=>{const s=await written(await staged());book.entries[1].content='Changed';await assert.rejects(r.applyMutationRecoveryPreStateUnsafe(s));assert.equal(book.entries[1].content,'Changed');book.entries[1]=clone(entry);const result=await r.applyMutationRecoveryPreStateUnsafe(s);assert.equal(result.verifiedState,'pre');assert.equal(Object.keys(book.entries).length,0);const fresh=await written(await staged());const done=await r.finalizeMutationRecoveryState(fresh,{executionResult:{createdUid:1}});book.entries[2]={...entry,uid:2,content:'Unrelated'};await r.applyMutationRecoveryPreStateUnsafe(done);assert.equal(book.entries[2].content,'Unrelated');assert.equal(book.entries[1],undefined);});
console.log(`${count} recovery scenarios passed`);
