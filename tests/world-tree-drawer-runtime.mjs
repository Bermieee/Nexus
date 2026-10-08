import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {renderLoreNeuralWorkspace,createLoreNeuralRenderState} from '../src/ui-core/lore-neural-graph.js';
import {renderMemoryOwnerSurface,renderLoreStudySurface} from '../src/ui-core/wave13-operator-surfaces.js';
import {createNexusUiHostBindings} from '../nexus-ui-bindings.js';
import {NexusWorldTree} from '../world-tree/store.js';
import {createStoryWorldTreeView} from '../world-tree/story-view.js';
import {readWorldTreeCharacterInspection} from '../world-tree/character-inspection.js';

function documentFixture(){
  const create=tag=>{
    const attrs=new Map(),classes=new Set();
    const node={
      tagName:String(tag).toUpperCase(),dataset:{},style:{},children:[],handlers:{},className:'',textContent:'',parentNode:null,
      classList:{
        add:(...v)=>v.forEach(s=>classes.add(s)),remove:(...v)=>v.forEach(s=>classes.delete(s)),
        toggle:(s,on)=>{const yes=on===undefined?!classes.has(s):Boolean(on);if(yes)classes.add(s);else classes.delete(s);return yes;},
        contains:s=>classes.has(s)
      },
      setAttribute:(k,v)=>attrs.set(k,String(v)),getAttribute:k=>attrs.get(k)??null,removeAttribute:k=>attrs.delete(k),
      append(...v){for(const child of v.flat().filter(Boolean)){child.parentNode=this;this.children.push(child);}},
      appendChild(v){this.append(v);return v;},addEventListener(k,v){this.handlers[k]=v;},removeEventListener(){},
      querySelector(){return null;},getBoundingClientRect:()=>({left:0,top:0,width:1000,height:800}),
      setPointerCapture(){},releasePointerCapture(){},
    };
    return node;
  };
  return {createElement:create,createElementNS:(_ns,tag)=>create(tag),defaultView:{matchMedia:()=>({matches:false})}};
}
function flatten(root){return [root,...root.children.flatMap(flatten)];}
function nodeText(node){return String(node?.textContent??'')+(node?.children??[]).map(nodeText).join('');}
function buttonByText(root,text){return flatten(root).find(n=>n.tagName==='BUTTON'&&nodeText(n).startsWith(text));}
function sourceBubble(root){return flatten(root).find(n=>String(n.getAttribute?.('aria-label')??'').startsWith('Lore source '));}

test('selected character UID exposes its state and memories and refreshes on selection',()=>{
  const doc=documentFixture(),state=createLoreNeuralRenderState(),scope={listen:(n,k,h)=>n.addEventListener(k,h)};
  const data={entries:[1,2].map(uid=>({sourceId:'lore-fact:Book:'+uid,uid,title:uid===1?'Mara':'Lili',operatorState:'READY',worldTreeKind:'LORE_FACT',trackedCharacter:true})),operatorCounts:{READY:2}};
  const reads=[];
  const tools={readCharacter:nodeId=>{reads.push(nodeId);return {nodeId,chatId:'story',book:'Book',isCharacter:true,status:'READY',authoredProfile:'Born in the northern mountains.',states:[{id:'s',state:{baseline:{personality:nodeId.endsWith(':1')?'Careful captain':'Steady scout'},persistent:{relationships:'Trusts the caravan'},temporary:{mood:'Alert'}}}],memories:[{id:'m',kind:'CHARACTER_MEMORY',text:nodeId.endsWith(':1')?'Heard the warning':'Saw the signal',status:'closed',scene:'Gate',time:'Dawn'}]};}};
  const render=()=>renderLoreNeuralWorkspace(doc,{data,renderState:state,scope,motionMode:'NONE',tools});
  state.selectedNodeId='lore-fact:Book:1';let root=render();
  assert.ok(buttonByText(root,'Character'),'character information belongs to the selected UID inspector');
  buttonByText(root,'Character').handlers.click();root=render();
  assert.match(nodeText(root),/Careful captain/);assert.match(nodeText(root),/Trusts the caravan/);assert.match(nodeText(root),/Alert/);
  assert.match(nodeText(root),/Born in the northern mountains/);
  buttonByText(root,'Memories').handlers.click();root=render();
  assert.match(nodeText(root),/Heard the warning/);assert.match(nodeText(root),/Gate/);assert.match(nodeText(root),/Dawn/);
  state.selectedNodeId='lore-fact:Book:2';root=render();
  assert.match(nodeText(root),/Saw the signal/);assert.doesNotMatch(nodeText(root),/Heard the warning/);
  assert.equal(reads.at(-1),'lore-fact:Book:2');
});

test('Character State review keeps approval actions without exposing tracking policy controls',()=>{
  const doc=documentFixture(),host=doc.createElement('div');host.ownerDocument=doc;
  const memory={read:()=>({source:{operationalState:'IDLE'},data:{}}),capabilities:()=>({}),characterReviewState:()=>({banks:[{id:'mara',character:'Mara',tracking:{goals:false},linkedSummaries:[]}],review:{proposals:[]}})};
  renderMemoryOwnerSurface(host,{memory});
  assert.match(nodeText(host),/Review Recent Chat/);
  assert.equal(flatten(host).some(n=>n.dataset?.characterPolicy),false,'field policy remains internal');
  assert.doesNotMatch(nodeText(host),/Tracking Policy/);
});

test('assembled World Tree inspector reads canonical character memories only for the matching story book',()=>{
  const tree=new NexusWorldTree(),doc=documentFixture(),state=createLoreNeuralRenderState(),scope={listen:(n,k,h)=>n.addEventListener(k,h)};
  const add=(id,kind,data,chatId=null)=>tree.upsertNode({id,kind,data,scope:chatId?{type:'CHAT',chatId}:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[id]}});
  add('lore-fact:Book:1','LORE_FACT',{label:'Mara',book:'Book',trackedCharacter:true});
  add('personal','CHARACTER_MEMORY',{character:'lore-fact:Book:1',summary:'Witnessed the rescue',status:'open'},'story');
  let binding={chatId:'story',book:'Book'},authoringBook='Book';
  const model=()=>createStoryWorldTreeView(tree,{chatMetadata:{}},binding);
  const hostBindings=createNexusUiHostBindings({readWorldTree:()=>model().readUiModel({chatId:'story'}),readWorldTreeCharacter:(nodeId,selection)=>{
    assert.deepEqual(selection,{chatId:'story',book:'Book'});
    return readWorldTreeCharacterInspection({tree:model(),binding,nodeId});
  }});
  const loreStudy={read:()=>({data:{},source:{}}),capabilities:()=>({}),selectedLorebook:()=>({}),readWorldTreeStoryBinding:()=>binding,
    worldBuilderBindings:{readWorldTreeAuthoringBinding:()=>({book:authoringBook}),readWorldTreeAuthoringModel:()=>tree.readUiModel({chatId:'story'})}};
  state.selectedNodeId='lore-fact:Book:1';state.rightDrawerView='memories';
  const render=()=>{const root=doc.createElement('div');root.ownerDocument=doc;renderLoreStudySurface(root,{loreStudy,worldTree:hostBindings.world,loreNeuralState:state,scope});return root;};
  assert.match(nodeText(render()),/Witnessed the rescue/);
  authoringBook='Other';assert.doesNotMatch(nodeText(render()),/Witnessed the rescue/);
  assert.match(nodeText(render()),/bound story/);
  authoringBook='Book';binding=null;assert.doesNotMatch(nodeText(render()),/Witnessed the rescue/);
});

test('failed character reads are shown as unavailable rather than an empty memory bank',()=>{
  const doc=documentFixture(),state=createLoreNeuralRenderState();state.selectedNodeId='mara';state.rightDrawerView='memories';
  const root=renderLoreNeuralWorkspace(doc,{data:{entries:[{sourceId:'mara',uid:1,title:'Mara',operatorState:'READY',trackedCharacter:true}]},renderState:state,motionMode:'NONE',tools:{readCharacter:()=>{throw new Error('owner unavailable');}}});
  assert.match(nodeText(root),/could not be read/);assert.doesNotMatch(nodeText(root),/No memories recorded/);
});
const readCss=()=>fs.readFileSync(new URL('../styles/ui-core-lore-neural.css',import.meta.url),'utf8');

test('World Tree sizing does not stretch its collapsed Memory review into an empty screen',()=>{
  const css=readCss();
  assert.doesNotMatch(css,/\.nexus-wave13-shell>\.nexus-shell__workspace:has\(\.nexus-world-tree-shell\)>\*\s*\{/,
    'only the tree should fill the viewport; unrelated sections must keep their natural height');
  assert.match(css,/\.nexus-wave13-shell>\.nexus-shell__workspace:has\(\.nexus-world-tree-shell\)\s*\{[^}]*overflow:auto!important;/,
    'the review below the tree must remain reachable without a hidden scroll offset');
});

test('World Tree side drawers toggle and selected UID opens contextual inspector',()=>{
  const doc=documentFixture(),state=createLoreNeuralRenderState();
  const scope={listen:(node,key,handler)=>node.addEventListener(key,handler)};
  const selected={snapshot:{id:'Book',title:'Book',entries:[{uid:30,comment:'Water God Style',content:'Sword style lore',key:['water','sword']}]}};
  const data={entries:[{
    sourceId:'lore-fact:Book:30',uid:30,title:'Water God Style',operatorState:'READY',retrievalReady:true,
    worldParentId:'martial',worldParentKind:'LORE_GROUP',worldParentLabel:'Martial Arts & Swordsmanship',
    sourceRevisionId:'r1',representations:[],artifactIds:[],
  }],operatorCounts:{READY:1},canonicalWorldNodes:[],worldEdges:[]};

  let root=renderLoreNeuralWorkspace(doc,{data,selected,renderState:state,scope,refresh:()=>{},motionMode:'NONE',tools:{openUidSummarizer:()=>true}});
  assert.equal(state.leftDrawerOpen,true);
  buttonByText(root,'World').handlers.click();
  assert.equal(state.leftDrawerOpen,false,'clicking active left tab should collapse drawer');

  root=renderLoreNeuralWorkspace(doc,{data,selected,renderState:state,scope,refresh:()=>{},motionMode:'NONE',tools:{openUidSummarizer:()=>true}});
  buttonByText(root,'Categories').handlers.click();
  assert.equal(state.leftDrawerOpen,true);
  assert.equal(state.leftDrawerView,'categories');

  root=renderLoreNeuralWorkspace(doc,{data,selected,renderState:state,scope,refresh:()=>{},motionMode:'NONE',tools:{openUidSummarizer:()=>true}});
  const bubble=sourceBubble(root);
  assert.ok(bubble,'source bubble should render');
  bubble.handlers.click({});
  assert.equal(state.selectedNodeKind,'source');
  assert.equal(state.rightDrawerOpen,true);
  assert.equal(state.rightDrawerView,'inspector');

  root=renderLoreNeuralWorkspace(doc,{data,selected,renderState:state,scope,refresh:()=>{},motionMode:'NONE',tools:{openUidSummarizer:()=>true}});
  assert.equal(state.rightDrawerView,'connections','single inspector should normalize to its first internal tab');
  assert.ok(flatten(root).some(n=>n.className==='nexus-inspector-window'||n.getAttribute?.('class')==='nexus-inspector-window'),'one right-side inspector window should render');

  const scene=buttonByText(root,'Scene Intelligence');
  assert.ok(scene);
  scene.handlers.click();
  assert.equal(state.rightDrawerView,'scene');

  root=renderLoreNeuralWorkspace(doc,{data,selected,renderState:state,scope,refresh:()=>{},motionMode:'NONE',tools:{openUidSummarizer:()=>true}});
  const details=buttonByText(root,'Details');
  assert.ok(details);
  details.handlers.click();
  assert.equal(state.rightDrawerView,'details');

  root=renderLoreNeuralWorkspace(doc,{data,selected,renderState:state,scope,refresh:()=>{},motionMode:'NONE',tools:{openUidSummarizer:()=>true}});
  const collapse=flatten(root).find(n=>n.tagName==='BUTTON'&&String(n.getAttribute?.('aria-label')??'')==='Collapse inspector');
  assert.ok(collapse,'inspector collapse control should render');
  collapse.handlers.click();
  assert.equal(state.rightDrawerOpen,false);
});

test('World Tree core renders the Nexus brand mark',()=>{
  const doc=documentFixture(),state=createLoreNeuralRenderState(),scope={listen:(node,key,handler)=>node.addEventListener(key,handler)};
  const root=renderLoreNeuralWorkspace(doc,{data:{entries:[{sourceId:'x',uid:1,title:'One',operatorState:'READY',retrievalReady:true}],operatorCounts:{READY:1}},selected:{snapshot:{entries:[{uid:1,comment:'One',content:'One'}]}},renderState:state,scope,motionMode:'NONE'});
  const mark=flatten(root).find(n=>n.tagName==='IMAGE'&&(n.className==='nexus-lore-core-node__brand'||n.getAttribute?.('class')==='nexus-lore-core-node__brand'));
  assert.ok(mark,'Nexus brand image must render in World Tree core');
});


test('collapsed World Tree surfaces cannot retain ghost pointer regions',()=>{
  const css=readCss();
  assert.match(css,/\.nexus-world-tree-shell \.nexus-world-drawer\[data-open=false\]>.nexus-world-drawer__surface\{[\s\S]*?visibility:hidden;[\s\S]*?pointer-events:none!important;/);
  assert.match(css,/\.nexus-world-tree-shell \.nexus-inspector-drawer\[data-open=false\]>.nexus-inspector-window\{[\s\S]*?visibility:hidden;[\s\S]*?pointer-events:none!important;/);
  assert.match(css,/\.nexus-inspector-drawer__handle\{[\s\S]*?pointer-events:auto!important;/);
});
