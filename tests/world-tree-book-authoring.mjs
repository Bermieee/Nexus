import test from 'node:test';
import assert from 'node:assert/strict';
import {TransactionLedger} from '../nexus/transaction-ledger.js';
import {renderLoreNeuralWorkspace,createLoreNeuralRenderState} from '../src/ui-core/lore-neural-graph.js';
import {projectWorldTreeLoreData,renderLoreStudySurface} from '../src/ui-core/wave13-operator-surfaces.js';
import {Wave13LoreStudyUIAdapter} from '../src/ui-core/wave13-operator-adapters.js';
import {createNexusWorldBuildStore} from '../builder2/nexus-plan-store.js';
const api=await import('../builder2/book-world-host.js').catch(()=>({}));
const reviewApi=await import('../src/ui-core/world-tree-placement-review.js').catch(()=>({}));
function fixture({books:sharedBooks=null,trees:sharedTrees=null,store=null,beforeCommit=null,analysis=null}={}){
  assert.equal(typeof api.createLorebookWorldTreeBuilderHost,'function');
  const books=sharedBooks??new Map(['A','B'].map(book=>[book,{entries:{1:{uid:1,comment:book+' person',content:book+' authored text',key:[book]}}}]));
  const trees=sharedTrees??new Map(),writes=[];
  const host=api.createLorebookWorldTreeBuilderHost({loadBook:async book=>structuredClone(books.get(book)),readTree:book=>structuredClone(trees.get(book)??null),
    assertReadableBook:()=>true,assertWritableBook:()=>true,ledger:new TransactionLedger(),
    store:store??createNexusWorldBuildStore({memory:new Map(),storage:null,indexedDB:null}),commitMutation:async(_id,mutation,options)=>{await beforeCommit?.();await options.preflight();writes.push(structuredClone(mutation));trees.set(mutation.book,structuredClone(mutation.tree));return {state:'committed'};},
    analysis:analysis??(async context=>({organization:{groups:[{id:'lore-group:'+context.binding.book+':people',label:'People',parentId:'world:nexus'}],placements:context.sources.map(source=>({sourceId:source.sourceId,parentId:'lore-group:'+context.binding.book+':people'}))},coverage:context.sources.map(source=>({sourceId:source.sourceId,disposition:'PLACED'}))}))});
  return {host,books,trees,writes};
}
test('explicit Lorebook authoring runs and approves without a chat, preserving authored content and other books',async()=>{
  const {host,books,trees,writes}=fixture(),original=structuredClone(books);
  trees.set('B',{lorebookName:'B',root:{id:'b',label:'B',entryUids:[1],children:[]}});const other=structuredClone(trees.get('B'));
  await host.loadWorldTreeSource({id:'A'});
  assert.deepEqual(host.readWorldTreeBuildSourceIds(),['A#1']);
  const run=await host.startWorldTreeBuild({sourceIds:['A#1']});assert.equal(run.phase,'REVIEW',run.error);
  await host.approveWorldTreeBuild(run.runId,{fingerprint:run.fingerprint,by:'operator'});
  const result=await host.applyWorldTreeBuild(run.runId);assert.equal(result.phase,'COMMITTED',result.error);
  assert.ok(host.readWorldTreeAuthoringModel().nodes.some(n=>n.kind==='LORE_GROUP'&&n.label==='People'));
  assert.ok(host.readWorldTreeLayout().layout.positions['lore-fact:A:1']);
  assert.ok(writes.every(w=>w.type==='tree.replace'&&w.book==='A'));
  assert.deepEqual(books,original);assert.deepEqual(trees.get('B'),other);
});
test('Trash leaves a durably blank authoring canvas with source inventory available after reload',async()=>{
  const {host,trees,books}=fixture();await host.loadWorldTreeSource({id:'A'});
  await host.trashWorldTree({book:'A'});assert.equal(host.readWorldTreeAuthoringModel().worldTreeOrganizationCleared,true);
  assert.deepEqual(host.readWorldTreeBuildSourceIds(),['A#1']);assert.equal(host.readWorldTreeLayout().layout,null);
  const saved=structuredClone(trees.get('A'));await host.loadWorldTreeSource({id:'A'});
  assert.equal(host.readWorldTreeAuthoringModel().worldTreeOrganizationCleared,true);assert.deepEqual(trees.get('A'),saved);assert.equal(books.get('A').entries[1].content,'A authored text');
});
test('selection changes fence approval and all source reads to exactly the selected book',async()=>{
  const {host,writes}=fixture();await host.loadWorldTreeSource({id:'A'});const run=await host.startWorldTreeBuild({sourceIds:['A#1']});
  await host.loadWorldTreeSource({id:'B'});
  assert.throws(()=>host.readWorldTreeBuildSourceIds('A'),/selected|authoring/i);
  await assert.rejects(()=>host.approveWorldTreeBuild(run.runId,{fingerprint:run.fingerprint,by:'operator'}),/selected|authoring/i);
  assert.equal(writes.length,0);assert.ok(host.readWorldTreeAuthoringModel().nodes.filter(n=>n.kind==='LORE_FACT').every(n=>n.id.startsWith('lore-fact:B:')));
});
test('authoring commit refuses an externally changed Tree instead of overwriting it',async()=>{
  const {host,trees,writes}=fixture();await host.loadWorldTreeSource({id:'A'});const run=await host.startWorldTreeBuild({sourceIds:['A#1']});
  await host.approveWorldTreeBuild(run.runId,{fingerprint:run.fingerprint,by:'operator'});
  trees.set('A',{lorebookName:'A',root:{id:'external',label:'External edit',children:[],entryUids:[]}});
  await assert.rejects(()=>host.applyWorldTreeBuild(run.runId),/stale|changed/i);assert.equal(writes.length,0);
});
test('disabled Lore entries stay outside Builder work while remaining authored',async()=>{
  const {host,books}=fixture();books.get('A').entries[2]={uid:2,comment:'Disabled',content:'Preserve me',disable:true};
  await host.loadWorldTreeSource({id:'A'});assert.deepEqual(host.readWorldTreeBuildSourceIds(),['A#1']);
  const run=await host.startWorldTreeBuild({sourceIds:host.readWorldTreeBuildSourceIds()});assert.equal(run.phase,'REVIEW',run.error);assert.equal(books.get('A').entries[2].content,'Preserve me');
});
test('a reviewed build survives refreshing the same book and can still be applied',async()=>{
  const {host}=fixture();await host.loadWorldTreeSource({id:'A'});const run=await host.startWorldTreeBuild({sourceIds:['A#1']});
  await host.approveWorldTreeBuild(run.runId,{fingerprint:run.fingerprint,by:'operator'});await host.loadWorldTreeSource({id:'A'});
  assert.ok((await host.listWorldTreeBuilds()).some(r=>r.runId===run.runId));assert.equal((await host.applyWorldTreeBuild(run.runId)).phase,'COMMITTED');
});
test('a saved approved build remains usable after reconstructing the authoring host',async()=>{
  const {createNexusWorldBuildStore}=await import('../builder2/nexus-plan-store.js');
  const memory=new Map(),store=createNexusWorldBuildStore({memory,storage:null,indexedDB:null});
  const first=fixture({store});await first.host.loadWorldTreeSource({id:'A'});
  const run=await first.host.startWorldTreeBuild({sourceIds:['A#1']});await first.host.approveWorldTreeBuild(run.runId,{fingerprint:run.fingerprint,by:'operator'});
  const second=fixture({books:first.books,trees:first.trees,store:createNexusWorldBuildStore({memory,storage:null,indexedDB:null})});
  await second.host.loadWorldTreeSource({id:'A'});assert.ok((await second.host.listWorldTreeBuilds()).some(r=>r.runId===run.runId));
  assert.equal((await second.host.applyWorldTreeBuild(run.runId)).phase,'COMMITTED');assert.equal(first.writes.length,0);
});
test('changing selection while a write is pending prevents publication, even when returning to the same book',async()=>{
  let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  const {host,writes}=fixture({beforeCommit:async()=>{enter();await gate;}});
  await host.loadWorldTreeSource({id:'A'});const run=await host.startWorldTreeBuild({sourceIds:['A#1']});await host.approveWorldTreeBuild(run.runId,{fingerprint:run.fingerprint,by:'operator'});
  const pending=host.applyWorldTreeBuild(run.runId);await entered;await host.loadWorldTreeSource({id:'B'});await host.loadWorldTreeSource({id:'A'});release();
  await assert.rejects(()=>pending,/changed/i);assert.equal(writes.length,0);
});
test('reapproving a refreshed layout uses the committed organization fingerprint',async()=>{
  const {host}=fixture();await host.loadWorldTreeSource({id:'A'});const run=await host.startWorldTreeBuild({sourceIds:['A#1']});
  await host.approveWorldTreeBuild(run.runId,{fingerprint:run.fingerprint,by:'operator'});await host.applyWorldTreeBuild(run.runId);
  const review=await host.reviewWorldTreeBuildLayout(run.runId);await host.approveWorldTreeBuild(run.runId,{fingerprint:review.fingerprint,by:'operator'});
  const result=await host.retryWorldTreeBuildLayout(run.runId);assert.equal(result.phase,'COMMITTED',result.error);
});
function documentFixture(){
  const create=tag=>{const attrs=new Map();return {tagName:tag.toUpperCase(),disabled:false,dataset:{},style:{},children:[],handlers:{},classList:{add(){},remove(){},toggle(){},contains(){return false;}},setAttribute:(k,v)=>attrs.set(k,String(v)),getAttribute:k=>attrs.get(k)??null,append(...v){this.children.push(...v.filter(Boolean));},addEventListener(event,handler){this.handlers[event]=handler;},removeEventListener(){},getBoundingClientRect:()=>({width:1000,height:800})};};
  return {createElement:create,createElementNS:(_ns,tag)=>create(tag),defaultView:{matchMedia:()=>({matches:false})}};
}
function flatten(root){return [root,...root.children.flatMap(flatten)];}

test('a loaded authoring book does not hide the real story attachment action',async()=>{
  const {host:bindings,writes}=fixture();let binding=null;const attachments=[];
  bindings.readWorldTreeStoryBinding=()=>binding;
  bindings.listWorldTreeAuthoringBooks=()=>['A','B'];
  bindings.readSelectedLorebookSelection=()=>({lorebookId:'A'});
  bindings.attachWorldTreeStoryBook=async({book})=>{attachments.push(book);binding={chatId:'story',book,revision:1};return binding;};
  const adapter=new Wave13LoreStudyUIAdapter({bindings,selectionProvider:()=>({chatId:'story'})}),doc=documentFixture();
  await adapter.loadWorldTreeSource({id:'A'});
  const render=()=>{const root=doc.createElement('div');root.ownerDocument=doc;renderLoreStudySurface(root,{loreStudy:adapter,scope:{listen:(n,e,h)=>n.addEventListener(e,h)}});return root;};
  const button=root=>flatten(root).find(n=>n.tagName==='BUTTON'&&n.textContent==='Attach Lorebook to this story');
  const root=render(),attach=button(root);
  assert.ok(attach,'loading for authoring must not pretend that story attachment exists');
  assert.equal(attach.disabled,false);
  assert.ok(flatten(root).some(n=>n.textContent==='Not attached'));
  assert.deepEqual(attachments,[]);assert.equal(binding,null);assert.equal(writes.length,0);
  await attach.handlers.click();
  assert.deepEqual(attachments,['A']);assert.equal(binding.book,'A');
  assert.equal(button(render()),undefined);
  assert.equal(bindings.readWorldTreeAuthoringBinding().book,'A');
});

test('the story binding stays visible when Builder is editing another book',async()=>{
  const {host:bindings}=fixture();bindings.readWorldTreeStoryBinding=()=>({chatId:'story',book:'A',revision:1});
  bindings.readSelectedLorebookSelection=()=>({lorebookId:'B'});
  const adapter=new Wave13LoreStudyUIAdapter({bindings,selectionProvider:()=>({chatId:'story'})}),doc=documentFixture();
  await adapter.loadWorldTreeSource({id:'B'});
  const root=doc.createElement('div');root.ownerDocument=doc;renderLoreStudySurface(root,{loreStudy:adapter});
  const fact=flatten(root).find(n=>n.children.some(child=>child.textContent==='Story Lorebook'));
  assert.ok(fact,'authoring and story binding need separate product facts');
  assert.ok(fact.children.some(child=>child.textContent==='A'));
  assert.equal(bindings.readWorldTreeAuthoringBinding().book,'B');
});
test('a cleared canvas never draws retained source nodes, links or an automatic replacement tree',()=>{
  const model={worldTreeOrganizationCleared:true,nodes:[{id:'world:nexus',kind:'WORLD'},{id:'lore-fact:A:1',kind:'LORE_FACT',book:'A',label:'A'}],edges:[]};
  const data=projectWorldTreeLoreData(model);data.canonicalWorldNodes=model.nodes;
  const root=renderLoreNeuralWorkspace(documentFixture(),{data,renderState:createLoreNeuralRenderState(),motionMode:'NONE',tools:{build:()=>true}});
  assert.equal(flatten(root).some(n=>n.getAttribute?.('aria-label')==='Circular Lore source and representation graph'),false);
  assert.ok(flatten(root).some(n=>String(n.textContent??'').includes('Tree cleared')));
});
test('the product toolbar loads a book, builds and approves it without an open chat',async()=>{
  const {host:bindings,writes}=fixture();bindings.readWorldTreeStoryBinding=()=>null;bindings.listWorldTreeAuthoringBooks=()=>['A','B'];bindings.readSelectedLorebookSelection=()=>({lorebookId:'A'});
  const adapter=new Wave13LoreStudyUIAdapter({bindings}),doc=documentFixture(),state=createLoreNeuralRenderState(),events=[];
  const render=()=>{const root=doc.createElement('div');root.ownerDocument=doc;renderLoreStudySurface(root,{loreStudy:adapter,loreNeuralState:state,scope:{listen:(n,e,h)=>n.addEventListener(e,h)},notifications:{push:e=>events.push(e)}});return root;};
  const button=(root,label)=>flatten(root).find(n=>n.tagName==='BUTTON'&&n.textContent===label);
  await button(render(),'Load selected Lorebook').handlers.click();
  await button(render(),'Builder').handlers.click();assert.equal(adapter.worldBuilderState.result.phase,'REVIEW');
  const approve=button(render(),'Approve');assert.equal(approve.disabled,false);await approve.handlers.click();
  assert.equal(adapter.worldBuilderState.result.phase,'COMMITTED');assert.ok(writes.length>=2);assert.ok(events.some(e=>e.message==='Builder proposal approved and published to the World Tree.'));
});

test('the actual toolbar recovers a committed build after its outcome save was interrupted, without repeating organization writes',async()=>{
 const memory=new Map(),store=createNexusWorldBuildStore({memory,storage:null,indexedDB:null});
 const first=fixture({store});await first.host.loadWorldTreeSource({id:'A'});
 const run=await first.host.startWorldTreeBuild({sourceIds:['A#1']});await first.host.approveWorldTreeBuild(run.runId,{fingerprint:run.fingerprint,by:'operator'});
 const write=store.writeIfRevision;let failed=false;
 store.writeIfRevision=async(record,...args)=>{if(record.phase==='LAYOUT_PENDING'&&!failed){failed=true;throw Error('Crash after organization persisted');}return write(record,...args);};
 await assert.rejects(first.host.applyWorldTreeBuild(run.runId),/Crash after organization persisted/);
 assert.equal((await store.read(run.runId)).phase,'COMMITTING');assert.equal(first.writes.length,1);
 const second=fixture({books:first.books,trees:first.trees,store:createNexusWorldBuildStore({memory,storage:null,indexedDB:null})});
 second.host.readWorldTreeStoryBinding=()=>null;
 const adapter=new Wave13LoreStudyUIAdapter({bindings:second.host});await adapter.loadWorldTreeSource({id:'A'});
 const doc=documentFixture(),root=doc.createElement('div');root.ownerDocument=doc;
 renderLoreStudySurface(root,{loreStudy:adapter,loreNeuralState:createLoreNeuralRenderState(),scope:{listen:(n,e,h)=>n.addEventListener(e,h)}});
 const recover=flatten(root).find(n=>n.tagName==='BUTTON'&&n.textContent==='Recover build');
 assert.ok(recover,'COMMITTING must offer recovery on the product toolbar');assert.equal(recover.disabled,false);
 await recover.handlers.click();assert.equal(adapter.worldBuilderState.result.phase,'COMMITTED');
 assert.equal(first.writes.length,1);assert.equal(second.writes.length,1,'only the remaining layout should be saved');
 assert.equal(second.trees.get('A').nexusWorldTreeBuild.runId,run.runId);
});

test('toolbar recovery never repeats an unresolved organization commit or loses its saved run',async()=>{
 const {host:bindings,writes}=fixture();bindings.readWorldTreeStoryBinding=()=>null;
 const adapter=new Wave13LoreStudyUIAdapter({bindings});await adapter.loadWorldTreeSource({id:'A'});
 const result=await bindings.startWorldTreeBuild({sourceIds:['A#1']});
 adapter.worldBuilderState.open=true;adapter.worldBuilderState.result={...result,phase:'COMMITTING'};
 bindings.applyWorldTreeBuild=async()=>{throw Error('Commit recovery is pending; reconcile the durable transaction before retrying');};
 bindings.readWorldTreeBuild=async()=>({...result,phase:'COMMITTING'});
 const doc=documentFixture(),render=()=>{const root=doc.createElement('div');root.ownerDocument=doc;renderLoreStudySurface(root,{loreStudy:adapter,loreNeuralState:createLoreNeuralRenderState(),scope:{listen:(n,e,h)=>n.addEventListener(e,h)}});return root;};
 const recover=flatten(render()).find(n=>n.tagName==='BUTTON'&&n.textContent==='Recover build');assert.ok(recover);
 await recover.handlers.click();assert.equal(writes.length,0);assert.equal(adapter.worldBuilderState.result.runId,result.runId);
 assert.equal(adapter.worldBuilderState.result.phase,'COMMITTING');assert.equal(adapter.worldBuilderState.busy,false);
 assert.ok(flatten(render()).some(n=>n.getAttribute?.('role')==='alert'&&/Commit recovery is pending/.test(n.textContent)));
});

test('a crash before the organization transaction starts resumes the saved approved plan after reload',async()=>{
 const memory=new Map(),store=createNexusWorldBuildStore({memory,storage:null,indexedDB:null}),first=fixture({store});
 await first.host.loadWorldTreeSource({id:'A'});const run=await first.host.startWorldTreeBuild({sourceIds:['A#1']});
 await first.host.approveWorldTreeBuild(run.runId,{fingerprint:run.fingerprint,by:'operator'});
 const saved=await store.read(run.runId);saved.phase='COMMITTING';saved.recordRevision++;await store.write(saved);
 const second=fixture({books:first.books,trees:first.trees,store:createNexusWorldBuildStore({memory,storage:null,indexedDB:null}),analysis:async()=>{throw Error('Saved analysis must not be called again');}});
 second.host.readWorldTreeStoryBinding=()=>null;const adapter=new Wave13LoreStudyUIAdapter({bindings:second.host});await adapter.loadWorldTreeSource({id:'A'});
 const doc=documentFixture(),root=doc.createElement('div');root.ownerDocument=doc;
 renderLoreStudySurface(root,{loreStudy:adapter,loreNeuralState:createLoreNeuralRenderState(),scope:{listen:(n,e,h)=>n.addEventListener(e,h)}});
 await flatten(root).find(n=>n.tagName==='BUTTON'&&n.textContent==='Recover build').handlers.click();
 assert.equal(adapter.worldBuilderState.result.phase,'COMMITTED',adapter.worldBuilderState.error);
 assert.equal(first.writes.length,0);assert.equal(second.writes.length,2);assert.equal(second.trees.has('B'),false);
 assert.equal(second.trees.get('A').nexusWorldTreeBuild.runId,run.runId);
});

test('a failed pre-write attempt is recoverable without repeating analysis or changing authored entries',async()=>{
 let attempts=0;const {host,books,writes}=fixture({beforeCommit:()=>{if(++attempts===1)throw Error('Interrupted before write');}});
 await host.loadWorldTreeSource({id:'A'});const original=structuredClone(books),run=await host.startWorldTreeBuild({sourceIds:['A#1']});
 await host.approveWorldTreeBuild(run.runId,{fingerprint:run.fingerprint,by:'operator'});
 await assert.rejects(host.applyWorldTreeBuild(run.runId),/Interrupted before write/);assert.equal(writes.length,0);
 assert.equal((await host.readWorldTreeBuild(run.runId)).phase,'COMMITTING');
 assert.equal((await host.applyWorldTreeBuild(run.runId)).phase,'COMMITTED');assert.equal(writes.length,2);assert.deepEqual(books,original);
});

test('recovery refuses source changes and changed authoring selection instead of replaying an old approval',async()=>{
 const store=createNexusWorldBuildStore({memory:new Map(),storage:null,indexedDB:null}),f=fixture({store});
 await f.host.loadWorldTreeSource({id:'A'});const run=await f.host.startWorldTreeBuild({sourceIds:['A#1']});await f.host.approveWorldTreeBuild(run.runId,{fingerprint:run.fingerprint,by:'operator'});
 const saved=await store.read(run.runId);saved.phase='COMMITTING';saved.recordRevision++;await store.write(saved);
 await f.host.loadWorldTreeSource({id:'B'});await assert.rejects(f.host.applyWorldTreeBuild(run.runId),/selected|authoring/);
 await f.host.loadWorldTreeSource({id:'A'});f.books.get('A').entries[1].content='Changed after approval';
 await assert.rejects(f.host.applyWorldTreeBuild(run.runId),/stale authority/);assert.equal(f.writes.length,0);
 assert.equal((await store.read(run.runId)).phase,'COMMITTING');
});

test('toolbar provides layout review after an interrupted layout publication',async()=>{
 const {host:bindings}=fixture();bindings.readWorldTreeStoryBinding=()=>null;
 const adapter=new Wave13LoreStudyUIAdapter({bindings});await adapter.loadWorldTreeSource({id:'A'});
 const run=await bindings.startWorldTreeBuild({sourceIds:['A#1']});let reviews=0;
 adapter.worldBuilderState.open=true;adapter.worldBuilderState.result={...run,phase:'LAYOUT_PENDING'};
 bindings.reviewWorldTreeBuildLayout=async()=>{reviews++;return {...run,phase:'LAYOUT_REVIEW'};};
 const doc=documentFixture(),root=doc.createElement('div');root.ownerDocument=doc;renderLoreStudySurface(root,{loreStudy:adapter,loreNeuralState:createLoreNeuralRenderState(),scope:{listen:(n,e,h)=>n.addEventListener(e,h)}});
 const review=flatten(root).find(n=>n.tagName==='BUTTON'&&n.textContent==='Review layout');assert.ok(review);assert.equal(review.disabled,false);
 await review.handlers.click();assert.equal(reviews,1);assert.equal(adapter.worldBuilderState.result.phase,'LAYOUT_REVIEW');
});

test('an apply failure refreshes the toolbar from the saved owner phase instead of retaining an obsolete approval',async()=>{
 const {host:bindings}=fixture();bindings.readWorldTreeStoryBinding=()=>null;
 const adapter=new Wave13LoreStudyUIAdapter({bindings});await adapter.loadWorldTreeSource({id:'A'});
 const run=await bindings.startWorldTreeBuild({sourceIds:['A#1']});adapter.worldBuilderState.open=true;adapter.worldBuilderState.result={...run,phase:'APPROVED'};
 bindings.applyWorldTreeBuild=async()=>{throw Error('Interrupted after commit admission');};bindings.readWorldTreeBuild=async()=>({...run,phase:'COMMITTING'});
 const doc=documentFixture(),render=()=>{const root=doc.createElement('div');root.ownerDocument=doc;renderLoreStudySurface(root,{loreStudy:adapter,loreNeuralState:createLoreNeuralRenderState(),scope:{listen:(n,e,h)=>n.addEventListener(e,h)}});return root;};
 await flatten(render()).find(n=>n.tagName==='BUTTON'&&n.textContent==='Approve').handlers.click();
 assert.equal(adapter.worldBuilderState.result.phase,'COMMITTING');assert.equal(adapter.worldBuilderState.busy,false);
 assert.ok(flatten(render()).some(n=>n.tagName==='BUTTON'&&n.textContent==='Recover build'&&!n.disabled));
});
test('the product reports paused analysis honestly rather than announcing a ready proposal',async()=>{
  const {host:bindings}=fixture();bindings.readWorldTreeStoryBinding=()=>null;bindings.readSelectedLorebookSelection=()=>({lorebookId:'A'});
  bindings.startWorldTreeBuild=async()=>({runId:'paused',phase:'ANALYSIS_PAUSED',error:'Provider unavailable'});
  const adapter=new Wave13LoreStudyUIAdapter({bindings}),doc=documentFixture(),events=[];
  await adapter.loadWorldTreeSource({id:'A'});
  const root=doc.createElement('div');root.ownerDocument=doc;renderLoreStudySurface(root,{loreStudy:adapter,loreNeuralState:createLoreNeuralRenderState(),scope:{listen:(n,e,h)=>n.addEventListener(e,h)},notifications:{push:e=>events.push(e)}});
  await flatten(root).find(n=>n.tagName==='BUTTON'&&n.textContent==='Builder').handlers.click();
  assert.equal(events.some(e=>/ready for review/.test(e.message)),false);assert.ok(events.some(e=>e.status==='error'&&e.message.includes('Provider unavailable')));
});

test('placement review requires explicit choices and continues the saved run',async()=>{
  const state={result:{runId:'saved',phase:'PLACEMENT_REVIEW',semanticReview:{token:'token',taxonomy:[{taxonId:'people',label:'People',entryPolicy:'allow'}],classifications:[{sourceKey:'A#1',title:'Alice',reason:'Uncertain'}],proposals:[{proposalId:'p1',label:'Places',evidenceSourceKeys:['A#2']},{proposalId:'p2',label:'Items',evidenceSourceKeys:['A#3']}]}}};
  let submitted=null;const render=()=>reviewApi.renderWorldTreePlacementReview(documentFixture(),{state,loreStudy:{resumeWorldTreeBuild:async(id,input)=>{submitted={id,input};return {runId:id,phase:'REVIEW'};}},scope:{listen:(node,key,handler)=>node.addEventListener(key,handler)}});
  let root=render();assert.equal(flatten(root).find(n=>n.textContent==='Continue to preview').disabled,true);
  for(const [label,value] of [['Placement A#1','map:people'],['Category proposal p1','approve'],['Category proposal p2','defer']]){
    const select=flatten(root).find(n=>n.getAttribute?.('aria-label')===label);select.value=value;select.handlers.change();root=render();
  }
  const button=flatten(root).find(n=>n.textContent==='Continue to preview');assert.equal(button.disabled,false);await button.handlers.click();
  assert.equal(submitted.id,'saved');assert.deepEqual(submitted.input.review,{token:'token',classificationDecisions:{'A#1':{action:'map',taxonId:'people'}},gapDecisions:{p1:{action:'approve'},p2:{action:'defer'}}});assert.equal(state.result.phase,'REVIEW');
});

test('the starting screen ignores the host placeholder and enables Load after explicitly choosing a book',()=>{
  const {host:bindings}=fixture();bindings.readWorldTreeStoryBinding=()=>null;bindings.listWorldTreeAuthoringBooks=()=>['A','B'];bindings.readSelectedLorebookSelection=()=>({lorebookId:'--- Pick to Edit ---'});
  const adapter=new Wave13LoreStudyUIAdapter({bindings}),doc=documentFixture(),render=()=>{const root=doc.createElement('div');root.ownerDocument=doc;renderLoreStudySurface(root,{loreStudy:adapter,loreNeuralState:createLoreNeuralRenderState(),scope:{listen:(n,e,h)=>n.addEventListener(e,h)}});return root;};
  let root=render();assert.equal(flatten(root).find(n=>n.textContent==='Load selected Lorebook').disabled,true);
  const chooser=flatten(root).find(n=>n.getAttribute?.('aria-label')==='Lorebook to build');chooser.value='B';chooser.handlers.change();
  root=render();assert.equal(flatten(root).find(n=>n.textContent==='Load selected Lorebook').disabled,false);
});

test('the no-chat product flow creates a fresh book and selects only that authoring source',async()=>{
  const {host:bindings,books}=fixture();bindings.readWorldTreeStoryBinding=()=>null;bindings.readSelectedLorebookSelection=()=>({lorebookId:'--- Pick to Edit ---'});bindings.listWorldTreeAuthoringBooks=()=>[...books.keys()];
  bindings.createWorldTreeBook=async({name})=>{books.set(name,{entries:{}});return bindings.loadWorldTreeSource({id:name});};
  const adapter=new Wave13LoreStudyUIAdapter({bindings}),doc=documentFixture(),root=doc.createElement('div');root.ownerDocument=doc;
  renderLoreStudySurface(root,{loreStudy:adapter,loreNeuralState:createLoreNeuralRenderState(),scope:{listen:(n,e,h)=>n.addEventListener(e,h)}});
  const input=flatten(root).find(n=>n.getAttribute?.('aria-label')==='New Lorebook name'),button=flatten(root).find(n=>n.textContent==='Create Lorebook');
  assert.equal(button.disabled,true);input.value='Fresh';input.handlers.input();assert.equal(button.disabled,false);await button.handlers.click();
  assert.equal(adapter.worldBuilderState.selectedBook,'Fresh');assert.equal(bindings.readWorldTreeAuthoringBinding().book,'Fresh');assert.deepEqual(books.get('Fresh').entries,{});assert.equal(books.get('A').entries[1].content,'A authored text');
});

test('loading the same book after product reload restores its pending placement review',async()=>{
  const memory=new Map(),store=createNexusWorldBuildStore({memory,storage:null,indexedDB:null}),analysis=async()=>({semanticReview:{token:'pending-token',taxonomy:[{taxonId:'people',label:'People',entryPolicy:'allow'}],classifications:[{sourceKey:'A#1',title:'A person'}],proposals:[]}});
  const first=fixture({store,analysis});await first.host.loadWorldTreeSource({id:'A'});const pending=await first.host.startWorldTreeBuild({sourceIds:['A#1']});assert.equal(pending.phase,'PLACEMENT_REVIEW');
  const second=fixture({books:first.books,trees:first.trees,store:createNexusWorldBuildStore({memory,storage:null,indexedDB:null}),analysis});second.host.readWorldTreeStoryBinding=()=>null;
  const adapter=new Wave13LoreStudyUIAdapter({bindings:second.host});await adapter.loadWorldTreeSource({id:'A'});assert.equal(adapter.worldBuilderState.result.runId,pending.runId);
  const doc=documentFixture(),root=doc.createElement('div');root.ownerDocument=doc;renderLoreStudySurface(root,{loreStudy:adapter,loreNeuralState:createLoreNeuralRenderState(),scope:{listen:(n,e,h)=>n.addEventListener(e,h)}});
  assert.ok(flatten(root).some(n=>n.getAttribute?.('aria-label')==='Builder placement review'));
  await adapter.loadWorldTreeSource({id:'B'});assert.equal(adapter.worldBuilderState.result,null);
});

test('a paused initial analysis restores after reload and resumes the same run from the product toolbar',async()=>{
  const memory=new Map(),store=createNexusWorldBuildStore({memory,storage:null,indexedDB:null});let available=false;
  const analysis=async context=>{if(!available)throw Error('Provider temporarily unavailable');return {organization:{groups:[{id:'lore-group:A:people',label:'People',parentId:'world:nexus'}],placements:context.sources.map(s=>({sourceId:s.sourceId,parentId:'lore-group:A:people'}))},coverage:context.sources.map(s=>({sourceId:s.sourceId,disposition:'PLACED'}))};};
  const first=fixture({store,analysis});await first.host.loadWorldTreeSource({id:'A'});const paused=await first.host.startWorldTreeBuild({sourceIds:['A#1']});assert.equal(paused.phase,'ANALYSIS_PAUSED');
  const second=fixture({books:first.books,trees:first.trees,store:createNexusWorldBuildStore({memory,storage:null,indexedDB:null}),analysis});second.host.readWorldTreeStoryBinding=()=>null;
  const adapter=new Wave13LoreStudyUIAdapter({bindings:second.host});await adapter.loadWorldTreeSource({id:'A'});assert.equal(adapter.worldBuilderState.result.runId,paused.runId);
  const doc=documentFixture(),root=doc.createElement('div');root.ownerDocument=doc;renderLoreStudySurface(root,{loreStudy:adapter,loreNeuralState:createLoreNeuralRenderState(),scope:{listen:(n,e,h)=>n.addEventListener(e,h)}});
  available=true;await flatten(root).find(n=>n.textContent==='Resume analysis').handlers.click();assert.equal(adapter.worldBuilderState.result.runId,paused.runId);assert.equal(adapter.worldBuilderState.result.phase,'REVIEW');assert.equal((await store.list()).length,1);
});
