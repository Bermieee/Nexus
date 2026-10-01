import test from 'node:test';
import assert from 'node:assert/strict';
import {Wave13LoreStudyUIAdapter} from '../src/ui-core/wave13-operator-adapters.js';
import {WorldTreeBuilderController} from '../builder2/world-controller.js';
import {NexusWorldTree} from '../world-tree/store.js';
import {readBuilderWorldContext} from '../builder2/world-context.js';
import {renderWorldTreeBuilderConsole} from '../src/ui-core/world-tree-builder-console.js';
import {renderLoreNeuralWorkspace,createLoreNeuralRenderState} from '../src/ui-core/lore-neural-graph.js';
function documentFixture(){
  const create=tag=>{const attrs=new Map(),classes=new Set();return {tagName:tag.toUpperCase(),dataset:{},style:{},children:[],handlers:{},classList:{add:(...v)=>v.forEach(s=>classes.add(s)),remove:(...v)=>v.forEach(s=>classes.delete(s)),toggle(){},contains:s=>classes.has(s)},
    setAttribute:(k,v)=>attrs.set(k,String(v)),getAttribute:k=>attrs.get(k)??null,append(...v){this.children.push(...v.filter(Boolean));},appendChild(v){this.append(v);return v;},addEventListener(k,v){this.handlers[k]=v;},removeEventListener(){},getBoundingClientRect:()=>({left:0,top:0,width:1000,height:800})};};
  return {createElement:create,createElementNS:(_ns,tag)=>create(tag),defaultView:{matchMedia:()=>({matches:false})}};
}
function flatten(root){return [root,...root.children.flatMap(flatten)];}
const api=await import('../builder2/world-host.js').catch(()=>({}));
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
