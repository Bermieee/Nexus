import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Wave13LoreStudyUIAdapter} from '../src/ui-core/wave13-operator-adapters.js';
import {WorldTreeBuilderController} from '../builder2/world-controller.js';
import {NexusWorldTree} from '../world-tree/store.js';
import {readBuilderWorldContext} from '../builder2/world-context.js';
import {renderWorldTreeBuilderConsole} from '../src/ui-core/world-tree-builder-console.js';
import {renderLoreNeuralWorkspace,createLoreNeuralRenderState,applyCanonicalWorldHierarchy} from '../src/ui-core/lore-neural-graph.js';
function documentFixture(){
  const create=tag=>{const attrs=new Map(),classes=new Set();return {tagName:tag.toUpperCase(),dataset:{},style:{},children:[],handlers:{},classList:{add:(...v)=>v.forEach(s=>classes.add(s)),remove:(...v)=>v.forEach(s=>classes.delete(s)),toggle(){},contains:s=>classes.has(s)},
    setAttribute:(k,v)=>attrs.set(k,String(v)),getAttribute:k=>attrs.get(k)??null,append(...v){this.children.push(...v.filter(Boolean));},appendChild(v){this.append(v);return v;},addEventListener(k,v){this.handlers[k]=v;},removeEventListener(){},getBoundingClientRect:()=>({left:0,top:0,width:1000,height:800})};};
  return {createElement:create,createElementNS:(_ns,tag)=>create(tag),defaultView:{matchMedia:()=>({matches:false})}};
}
function flatten(root){return [root,...root.children.flatMap(flatten)];}
const api=await import('../builder2/world-host.js').catch(()=>({}));
const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
test('paused Builder shows its actual failure instead of only a phase badge',()=>{
  const doc=documentFixture();
  const root=renderLoreNeuralWorkspace(doc,{data:{entries:[{sourceId:'a',uid:1,operatorState:'READY'}]},renderState:createLoreNeuralRenderState(),motionMode:'NONE',tools:{builder:{active:true,busy:false,phase:'ANALYSIS_PAUSED',error:'Builder requires active chat'}}});
  assert.ok(flatten(root).some(n=>n.getAttribute?.('role')==='alert'&&n.textContent==='Builder requires active chat'));
});
test('flattened canonical books receive a finite fitted presentation without changing owner data',()=>{
  const doc=documentFixture(),state=createLoreNeuralRenderState();
  const nodes=[{id:'world:nexus',kind:'WORLD',parentId:null},{id:'book',kind:'LORE_SOURCE',label:'Book',parentId:'world:nexus'},...Array.from({length:105},(_,uid)=>({id:'source:'+uid,kind:'LORE_FACT',parentId:'book',label:'Source '+uid}))];
  const before=structuredClone(nodes);
  const root=renderLoreNeuralWorkspace(doc,{data:{canonicalWorldNodes:nodes,entries:nodes.slice(2).map((n,uid)=>({sourceId:n.id,uid,operatorState:'READY',worldParentId:'book',worldParentKind:'LORE_SOURCE',worldParentLabel:'Book'}))},renderState:state,motionMode:'NONE'});
  const svg=flatten(root).find(n=>n.tagName==='SVG'&&n.getAttribute('aria-label')==='Circular Lore source and representation graph');
  const [x,y,width,height]=svg.getAttribute('viewBox').split(' ').map(Number);
  const circles=flatten(svg).filter(n=>n.tagName==='CIRCLE'&&n.getAttribute('cx')!==null);
  assert.ok(circles.every(n=>{const cx=Number(n.getAttribute('cx')),cy=Number(n.getAttribute('cy'));return cx>=x&&cx<=x+width&&cy>=y&&cy<=y+height;}));
  assert.deepEqual(nodes,before);
});
test('owner reads hydrate organization before UI use and build inventory exceeds snapshot caps',async()=>{
  const {replaceNexusWorldTree,getNexusWorldTree,configureWorldTreeContextProvider}=await import('../world-tree/index.js');
  const world=replaceNexusWorldTree();
  for(let uid=0;uid<650;uid++)world.upsertNode({id:'source:'+uid,kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'LORE',sourceIds:['A#'+uid]},data:{book:'A',uid}});
  const publication={contract:'nexus-world-tree-organization/v1',chatId:'a',nodes:[{id:'persisted',kind:'LORE_GROUP',scope:{type:'CHAT',chatId:'a'},provenance:{sourceType:'BUILDER_ORGANIZATION',sourceIds:['A#1']},data:{label:'Persisted'}}],edges:[]};
  const context={chatId:'a',chatMetadata:{nexusWorldTreeOrganizationV1:publication}};
  configureWorldTreeContextProvider(()=>context);
  try{assert.ok(getNexusWorldTree().getNode('persisted',{chatId:'a'}));const bindings=api.createWorldTreeBuilderHostBindings({getContext:()=>context});assert.equal(bindings.readWorldTreeBuildSourceIds('A').length,650);}finally{configureWorldTreeContextProvider(null);replaceNexusWorldTree();}
});
test('canonical preview includes empty categories',()=>{
  const graph={hubs:[],edges:[]};
  applyCanonicalWorldHierarchy(graph,{canonicalWorldNodes:[{id:'empty',kind:'LORE_GROUP',label:'Empty',parentId:'world:nexus'}]});
  assert.ok(graph.hubs.some(h=>h.canonicalNodeId==='empty'));
});
test('missing durable browser storage disables only Builder',()=>{
  globalThis.window={};globalThis.document={};
  try{const bindings=api.createWorldTreeBuilderHostBindings({getContext:()=>({chatId:'a'}),runtime:{director:{},coordinator:{}}});assert.ok(bindings.worldTreeBuilderUnavailableReason);assert.equal(bindings.startWorldTreeBuild,undefined);}finally{delete globalThis.window;delete globalThis.document;}
});
test('installed host actions delegate through the operator adapter without duplicate invocation',async()=>{
  assert.equal(typeof api.createWorldTreeBuilderHostBindings,'function');
  let starts=0,applies=0;
  const controller={start:async input=>{starts++;return {runId:'r',chatId:input.chatId,phase:'REVIEW',fingerprint:'f'};},read:async()=>({runId:'r'}),revise:async()=>({}),approve:async()=>({}),apply:async()=>{applies++;return {phase:'COMMITTED'};},cancel:async()=>({}),resume:async()=>({}),retryLayout:async()=>({})};
  const bindings=api.createWorldTreeBuilderHostBindings({getContext:()=>({chatId:'a'}),controller,layoutStore:{read:()=>({revision:0})}});
  const adapter=new Wave13LoreStudyUIAdapter({bindings});
  assert.equal(adapter.capabilities().worldTreeBuilder,true);
  await adapter.startWorldTreeBuild({sourceIds:['A#1']});await adapter.applyWorldTreeBuild('r');
  assert.equal(starts,1);assert.equal(applies,1);
});
test('unavailable owner disables Builder instead of pretending analysis can run',()=>{
  assert.equal(new Wave13LoreStudyUIAdapter({bindings:{}}).capabilities().worldTreeBuilder,false);
});
test('console preview, edits, renderer layout and Apply traverse the actual controller and adapter',async()=>{
  const world=new NexusWorldTree(),rows=new Map();let commits=0;
  world.upsertNode({id:'lore-fact:A:1',kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'LORE',sourceIds:['A#1']},data:{book:'A',uid:1,label:'Alex',content:'PRIVATE AUTHOR TEXT'}});
  const context=()=>readBuilderWorldContext({worldTree:world,chatId:'a',selectedSources:[{book:'A',uid:1,title:'Alex',fingerprint:'one'}],authorizedSourceIds:['A#1']});
  const controller=new WorldTreeBuilderController({context,currentChatId:()=> 'a',store:{read:async id=>structuredClone(rows.get(id)),write:async r=>rows.set(r.runId,structuredClone(r))},
    analysis:async()=>({organization:{groups:[{id:'people',label:'People',parentId:'world:nexus'}],placements:[{sourceId:'A#1',parentId:'people'}]},coverage:[{sourceId:'A#1',disposition:'PLACED'}]}),
    mutation:async({materialization,assertFresh})=>{await assertFresh();commits++;for(const op of materialization.operations){if(op.node)world.upsertNode(op.node);else world.linkEdge(op.edge);}return {state:'committed',worldRevision:world.revision};},
    layout:{read:()=>({revision:0}),publish:async()=>({revision:1})}});
  const bindings=api.createWorldTreeBuilderHostBindings({getContext:()=>({chatId:'a'}),controller,layoutStore:{read:()=>({revision:0})}}),adapter=new Wave13LoreStudyUIAdapter({bindings});
  const state=adapter.worldBuilderState;state.open=true;
  const doc=documentFixture(),scope={listen:(node,key,handler)=>node.addEventListener(key,handler)},render=()=>renderWorldTreeBuilderConsole(doc,{state,loreStudy:adapter,sourceIds:['A#1'],scope});
  const before=world.exportState();
  await flatten(render()).find(n=>n.textContent==='Analyze placement').handlers.click();assert.equal(state.result.phase,'REVIEW');assert.deepEqual(world.exportState(),before);
  assert.equal(JSON.stringify(state.result).includes('PRIVATE AUTHOR TEXT'),false);
  const category=flatten(render()).find(n=>n.getAttribute('aria-label')==='Category People');category.value='Scholars';await category.handlers.change();assert.equal(state.result.plan.organization.groups[0].label,'Scholars');
  const preview=state.result.preview,layout=state.result.plan.layout.proposed,renderState=createLoreNeuralRenderState();renderState.ownerLayout=layout;
  const graph=renderLoreNeuralWorkspace(doc,{data:{entries:[{sourceId:'lore-fact:A:1',uid:1,title:'Alex',operatorState:'READY',worldParentId:'people',worldParentKind:'LORE_GROUP',worldParentLabel:'Scholars'}],canonicalWorldNodes:preview.nodes,operatorCounts:{READY:1}},renderState,scope,motionMode:'NONE'});
  assert.ok(flatten(graph).some(n=>n.getAttribute('cx')===String(layout.positions['lore-fact:A:1'].x+500)));
  const apply=flatten(render()).find(n=>n.textContent==='Apply reviewed build');await Promise.all([apply.handlers.click(),apply.handlers.click()]);assert.equal(commits,1);assert.equal(state.result.phase,'COMMITTED');
});


test('Builder can target the current canonical World Tree without a selected Lorebook',()=>{
  const host=read('builder2/world-host.js');
  assert.match(host,/readWorldTreeBuildSourceIds:book=>/);
  assert.match(host,/\(!book\|\|n\.data\.book===book\)/);
  assert.match(host,/\`\$\{n\.data\.book\}#\$\{Number\(n\.data\.uid\)\}\`/);
});

test('World Tree Builder button starts analysis directly and never opens the old console',()=>{
  const surface=read('src/ui-core/wave13-operator-surfaces.js');
  assert.equal(surface.includes('renderWorldTreeBuilderConsole'),false,'World Tree should not mount the legacy Builder console');
  assert.match(surface,/build:caps\.worldTreeBuilder&&entries\.length\?async/);
  assert.match(surface,/state\.result=await loreStudy\.startWorldTreeBuild\(\{sourceIds:state\.sourceIds,mode:state\.mode\?\?'EXTEND'\}\)/);
  assert.match(surface,/loreNeuralState\.leftDrawerOpen=false/);
  assert.match(surface,/loreNeuralState\.rightDrawerOpen=false/);
});

test('Builder proposal mode replaces toolbar Builder with Approve Re-run Trash controls',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const css=read('styles/ui-core-lore-neural.css');
  assert.match(graph,/label:builderBusy\?'Working…':'Approve'/);
  assert.match(graph,/label:'Re-run'/);
  assert.match(graph,/label:'Trash'/);
  assert.match(graph,/Trash this Builder proposal\. Published World Tree remains unchanged\./);
  assert.match(css,/World Tree Builder proposal mode/);
  assert.match(css,/data-workspace-mode=BUILDER_REVIEW/);
  assert.match(css,/nexus-world-builder-action\.is-trash/);
});

test('Builder preview controls render on the graph at runtime',()=>{
  const doc=documentFixture(),state=createLoreNeuralRenderState();
  state.workspaceMode='BUILDER_REVIEW';
  const scope={listen:(node,key,handler)=>node.addEventListener(key,handler)};
  let approved=0,rerun=0,trashed=0;
  const root=renderLoreNeuralWorkspace(doc,{
    data:{entries:[{sourceId:'lore-fact:A:1',uid:1,title:'Alex',operatorState:'READY',retrievalReady:true}],operatorCounts:{READY:1}},
    selected:{snapshot:{entries:[{uid:1,comment:'Alex',content:'Text'}]}},
    renderState:state,scope,motionMode:'NONE',
    tools:{builder:{active:true,busy:false,phase:'REVIEW',approve:()=>approved++,rerun:()=>rerun++,trash:()=>trashed++}},
  });
  const buttons=flatten(root).filter(n=>n.tagName==='BUTTON');
  const byText=text=>buttons.find(n=>n.textContent===text);
  assert.ok(byText('Approve'));assert.ok(byText('Re-run'));assert.ok(byText('Trash'));
  byText('Approve').handlers.click();byText('Re-run').handlers.click();byText('Trash').handlers.click();
  assert.equal(approved,1);assert.equal(rerun,1);assert.equal(trashed,1);
});


test('Wave12 forwards the complete World Tree Builder owner contract',()=>{
  const host=read('src/ui-core/wave12-sillytavern-host.js');
  for(const key of [
    'startWorldTreeBuild','readWorldTreeBuild','reviseWorldTreeBuild','approveWorldTreeBuild','applyWorldTreeBuild',
    'cancelWorldTreeBuild','resumeWorldTreeBuild','retryWorldTreeBuildLayout','reviewWorldTreeBuildLayout',
    'readWorldTreeLayout','saveWorldTreeLayoutPins','readWorldTreeBuildSourceIds','listWorldTreeBuilds','trashWorldTree'
  ]) assert.equal(host.includes("'"+key+"'"),true,'Wave12 missing Builder binding '+key);
});

test('Trash Tree is distinct from trashing a Builder proposal',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const surface=read('src/ui-core/wave13-operator-surfaces.js');
  const owner=read('builder2/world-host.js');
  assert.match(graph,/label:'Trash Tree'/);
  assert.match(graph,/label:'Confirm Trash'/);
  assert.match(graph,/label:'Trash'/);
  assert.match(surface,/loreStudy\.trashWorldTree\(\{book:sourceBook\}\)/);
  assert.match(owner,/type:'tree\.delete'/);
  assert.match(owner,/WORLD_BUILD_METADATA_KEY,LAYOUT_KEY/);
  assert.match(owner,/syncLegacyLoreToWorldTree\('ui-trash-world-tree'\)/);
});

test('World Tree edge removal clears stale Builder navigation edges',()=>{
  const world=new NexusWorldTree();
  world.upsertNode({id:'source-a',kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['A#1']},data:{book:'A',uid:1}});
  world.upsertNode({id:'group-a',kind:'LORE_GROUP',scope:{type:'CHAT',chatId:'chat-a'},provenance:{sourceType:'BUILDER_ORGANIZATION',sourceIds:['A#1']},data:{label:'Group A'}});
  world.linkEdge({id:'edge-a',from:'group-a',to:'source-a',relation:'NAVIGATION',scope:{type:'CHAT',chatId:'chat-a'},provenance:{sourceType:'BUILDER_ORGANIZATION',sourceIds:['A#1']},data:{primaryPlacement:true}});
  assert.ok(world.getEdge('edge-a',{chatId:'chat-a'}));
  assert.equal(world.removeEdge('edge-a',{reason:'test'}),true);
  assert.equal(world.getEdge('edge-a',{chatId:'chat-a'}),null);
});


test('Trash Tree legacy deletion is lorebook-scoped and does not require an active chat',()=>{
  const owner=read('builder2/world-host.js');
  assert.equal(owner.includes("Trash Tree requires an active chat."),false);
  assert.match(owner,/reviewScope:lorebookOperatorReviewScope\(id\)/);
  assert.match(owner,/if\(chatId&&context\?\.chatMetadata\)/);
  assert.match(owner,/importLegacyLoreBookToWorldTree\(world,\{book:id,data:await loadBook\(id\),legacyTree:null\}\)/);
  assert.match(owner,/organizationCleared:Boolean\(chatId\)/);
  assert.match(owner,/layoutCleared:Boolean\(chatId\)/);
});

test('Trash Tree canonical commands always carry an explicit typed scope without review-store persistence',()=>{
  const owner=read('builder2/world-host.js');
  assert.match(owner,/metadata:\{source:'explicit-operator-command',reviewScope:operatorReviewScopeProjection\(resolvedScope,0\)\}/);
  assert.match(owner,/operatorReviewScope:resolvedScope\.identity/);
  assert.match(owner,/normalizeOperatorReviewScope\(\{chatId,storyId:/);
  const helper=owner.slice(owner.indexOf('const commitOperatorMutation='),owner.indexOf('const trashWorldTree='));
  assert.equal(helper.includes('persistNexusReviewTransaction'),false);
});


test('Trash Tree explicit operator command does not enter the review store',()=>{
  const owner=read('builder2/world-host.js');
  const helper=owner.slice(owner.indexOf('const commitOperatorMutation='),owner.indexOf('const trashWorldTree='));
  assert.equal(helper.includes('persistNexusReviewTransaction'),false,'Trash Tree must not persist as a review draft');
  assert.match(helper,/metadata:\{source:'explicit-operator-command'/);
  assert.match(helper,/ledger\.approve\(tx\.id,\{by:'operator'/);
  assert.match(helper,/commitCanonicalNexusMutation\(tx\.id,mutation/);
});
