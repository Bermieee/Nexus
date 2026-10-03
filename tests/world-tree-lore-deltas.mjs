import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
if(!vm.SourceTextModule){const result=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(import.meta.url)],{stdio:'inherit'});process.exit(result.status??1);}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function fixture(){
 const context={chatId:'story-a',chatMetadata:{},chat:[],saveMetadataDebounced(){}};
 let scope={version:2,configured:true,chatKey:'story-a',revision:1,readBooks:['A'],writeBooks:['A'],primaryWriteBook:'A'};
 let data={name:'A',scanDepth:2,entries:{1:{uid:1,comment:'Mara',key:['Mara'],content:'Mara is an innkeeper.'},2:{uid:2,comment:'Ember Tavern',key:['Ember Tavern'],content:'A quiet inn.'}}},legacyTree=null,loader=async()=>structuredClone(data);
 const stubs={
  'lore/store.js':{loadBookOwner:book=>loader(book)},'tree/store.js':{getTreeOwner:()=>structuredClone(legacyTree)},
  '../../../st-context.js':{getContext:()=>context},'observability/telemetry.js':{logEvent:()=>{}},'observability/system-events.js':{logSystemEvent:()=>{}},
  'decision/task8-postturn-sites.js':{TASK8_POSTTURN_SITE_IDS:{WORLDTREE_IDENTITY:'identity',WORLDTREE_GROWTH:'growth'},runTask8ChoiceDecision:async(_site,_input,fallback)=>({choice:fallback})},
 };
 const cache=new Map(),module=name=>{if(cache.has(name))return cache.get(name);const stub=stubs[name],value=stub?new vm.SyntheticModule(Object.keys(stub),function(){for(const[k,v]of Object.entries(stub))this.setExport(k,v);},{identifier:name}):new vm.SourceTextModule(fs.readFileSync(path.join(root,name),'utf8'),{identifier:name});cache.set(name,value);return value;};
 const entry=new vm.SourceTextModule("export * as bridge from './world-tree/legacy-lore-bridge.js'; export * as world from './world-tree/index.js'; export * as lore from './world-tree/import-lore.js'; export * as parity from './world-tree/lore-read-parity.js'; export * as revisions from './nexus/lore-source-revision.js';",{identifier:'entry.js'});
 await entry.link((specifier,parent)=>module(path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier),specifier))));await entry.evaluate();
 const {world,lore}=entry.namespace,tree=world.replaceNexusWorldTree();lore.importLegacyLoreBookToWorldTree(tree,{book:'B',data:{entries:{1:{uid:1,comment:'Foreign',content:'Unrelated canon'}}}});
 world.configureWorldTreeContextProvider(()=>context,()=>scope);context.chatMetadata.tv2_story_scope_v1=scope;
 return {...entry.namespace,tree,context,getData:()=>data,setData:value=>{data=value;},setTree:value=>{legacyTree=value;},setLoader:value=>{loader=value;},setBinding:book=>{scope={...scope,revision:scope.revision+1,readBooks:[book],writeBooks:[book],primaryWriteBook:book};context.chatMetadata.tv2_story_scope_v1=scope;}};
}
test('production lore bridge applies an edited UID through intake while preserving unrelated entries and foreign books',async()=>{
 const f=await fixture();await f.bridge.syncLegacyLoreToWorldTree('initial');const unchanged=f.tree.getNode('lore-fact:A:2'),foreign=f.tree.getNode('lore-fact:B:1');
 const revised=structuredClone(f.getData());revised.entries[1].content='Mara guards the Ember Tavern.';revised.entries[1].displayIndex=8;f.setData(revised);f.revisions.bumpNexusLoreSourceRevision({book:'A'});
 const receipt=await f.bridge.syncLegacyLoreToWorldTree('entry-edit');assert.equal(receipt.loreParity.after.status,'PASS');
 assert.deepEqual(f.tree.getNode('lore-fact:A:1').data.sourceEntry,revised.entries[1]);assert.deepEqual(f.tree.getNode('lore-fact:A:2'),unchanged);assert.deepEqual(f.tree.getNode('lore-fact:B:1'),foreign);
 const records=[...f.tree.contributionLedger.values()].filter(row=>row.source==='lore');assert.ok(records.length,'live edits must flow through Contribution intake');
 assert.ok([...f.tree.edges.values()].some(e=>e.from==='lore-fact:A:1'&&e.to==='lore-fact:A:2'&&e.relation==='about'&&e.temporal.status==='CURRENT'));
});
test('production lore removal supersedes its source and derived edges and refreshes control metadata parity',async()=>{
 const f=await fixture();await f.bridge.syncLegacyLoreToWorldTree('initial');const revised=structuredClone(f.getData());revised.entries[1].content='Mara guards the Ember Tavern.';f.setData(revised);await f.bridge.syncLegacyLoreToWorldTree('edit');
 const semantic=[...f.tree.edges.values()].find(e=>e.from==='lore-fact:A:1'&&e.relation==='about');assert.ok(semantic);
 const removed=structuredClone(revised);delete removed.entries[1];removed.scanDepth=5;f.setData(removed);f.revisions.bumpNexusLoreSourceRevision({book:'A'});
 const receipt=await f.bridge.syncLegacyLoreToWorldTree('remove');assert.equal(receipt.loreParity.after.status,'PASS');assert.equal(receipt.loreParity.after.controlMetadata,'PASS');
 assert.equal(f.tree.getNode('lore-fact:A:1').temporal.status,'SUPERSEDED');assert.equal(f.tree.getNode('lore-fact:A:1').data.sourcePresent,false);assert.equal(f.tree.getEdge(semantic.id).temporal.status,'SUPERSEDED');
 assert.equal([...f.tree.edges.values()].filter(e=>e.to==='lore-fact:A:1'&&e.relation==='contains'&&e.temporal.status==='CURRENT').length,0);
 assert.deepEqual(f.parity.reconstructLoreBookFromWorldTree(f.tree,'A'),removed);
});
test('removing a referenced Lore UID retires surviving incoming semantic links',async()=>{
 const f=await fixture();await f.bridge.syncLegacyLoreToWorldTree('initial');const edited=structuredClone(f.getData());edited.entries[1].content='Mara guards the Ember Tavern.';f.setData(edited);await f.bridge.syncLegacyLoreToWorldTree('edit');
 const link=[...f.tree.edges.values()].find(e=>e.from==='lore-fact:A:1'&&e.to==='lore-fact:A:2'&&e.relation==='about');assert.ok(link);
 const removed=structuredClone(edited);delete removed.entries[2];f.setData(removed);await f.bridge.syncLegacyLoreToWorldTree('remove-target');
 assert.equal(f.tree.getNode('lore-fact:A:2').temporal.status,'SUPERSEDED');assert.equal(f.tree.getEdge(link.id).temporal.status,'SUPERSEDED');
 assert.deepEqual(f.parity.reconstructLoreBookFromWorldTree(f.tree,'A'),removed);
});
test('lore bridge discards a loaded snapshot when the binding or source revision changed during load',async()=>{
 for(const change of ['binding','source']){
  const f=await fixture();let release,reached;const entered=new Promise(resolve=>{reached=resolve;});const hold=new Promise(resolve=>{release=resolve;});
  f.setLoader(async()=>{reached();await hold;return structuredClone(f.getData());});const before=f.tree.exportState();const work=f.bridge.syncLegacyLoreToWorldTree('held');await entered;
  if(change==='binding')f.setBinding('B');else f.revisions.bumpNexusLoreSourceRevision({book:'A'});release();const result=await work;
  assert.ok(result.error||result.stale);assert.deepEqual(f.tree.exportState(),before);
 }
});
test('routing deltas update control nodes and retire prior entry containment without processing an unchanged UID',async()=>{
 const f=await fixture();const group=(id,uids)=>({id,label:id,entryUids:uids,children:[]});f.setTree({book:'A',lastBuilt:1,root:{id:'root',label:'A',entryUids:[],children:[group('left',[1]),group('right',[2])]}});
 await f.bridge.syncLegacyLoreToWorldTree('initial');const before=f.tree.getNode('lore-fact:A:2');
 f.setTree({book:'A',lastBuilt:2,root:{id:'root',label:'A',entryUids:[],children:[group('left',[]),group('right',[1,2])]}});f.revisions.bumpNexusLoreSourceRevision({book:'A'});
 const receipt=await f.bridge.syncLegacyLoreToWorldTree('routing');assert.equal(receipt.loreParity.after.controlMetadata,'PASS');assert.deepEqual(f.tree.getNode('lore-fact:A:2'),before);
 assert.equal([...f.tree.edges.values()].filter(e=>e.to==='lore-fact:A:1'&&e.relation==='contains'&&e.temporal.status==='CURRENT').length,1);
});
test('ambiguous lore mention work resumes when a later delta disambiguates the bound source',async()=>{
 const f=await fixture(),initial=structuredClone(f.getData());initial.entries[3]={uid:3,comment:'Ember Tavern',key:['Ember Tavern'],content:'A different inn.'};f.setData(initial);await f.bridge.syncLegacyLoreToWorldTree('initial');
 const edited=structuredClone(initial);edited.entries[1].content='Mara guards the Ember Tavern.';f.setData(edited);await f.bridge.syncLegacyLoreToWorldTree('edit');
 assert.equal([...f.tree.edges.values()].some(e=>e.from==='lore-fact:A:1'&&e.relation==='about'&&e.temporal.status==='CURRENT'),false);
 const resolved=structuredClone(edited);delete resolved.entries[3];f.setData(resolved);const receipt=await f.bridge.syncLegacyLoreToWorldTree('disambiguate');assert.equal(receipt.loreParity.after.status,'PASS');
 assert.ok([...f.tree.edges.values()].some(e=>e.from==='lore-fact:A:1'&&e.to==='lore-fact:A:2'&&e.relation==='about'&&e.temporal.status==='CURRENT'));
});
