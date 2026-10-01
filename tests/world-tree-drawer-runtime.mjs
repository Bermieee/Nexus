import test from 'node:test';
import assert from 'node:assert/strict';
import {renderLoreNeuralWorkspace,createLoreNeuralRenderState} from '../src/ui-core/lore-neural-graph.js';

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
function buttonByText(root,text){return flatten(root).find(n=>n.tagName==='BUTTON'&&nodeText(n)===text);}
function sourceBubble(root){return flatten(root).find(n=>String(n.getAttribute?.('aria-label')??'').startsWith('Lore source '));}

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
  const connections=buttonByText(root,'Connections');
  assert.ok(connections);
  connections.handlers.click();
  assert.equal(state.rightDrawerView,'connections');

  root=renderLoreNeuralWorkspace(doc,{data,selected,renderState:state,scope,refresh:()=>{},motionMode:'NONE',tools:{openUidSummarizer:()=>true}});
  const scene=buttonByText(root,'Scene');
  assert.ok(scene);
  scene.handlers.click();
  assert.equal(state.rightDrawerView,'scene');
});

test('World Tree core renders the Nexus brand mark',()=>{
  const doc=documentFixture(),state=createLoreNeuralRenderState(),scope={listen:(node,key,handler)=>node.addEventListener(key,handler)};
  const root=renderLoreNeuralWorkspace(doc,{data:{entries:[{sourceId:'x',uid:1,title:'One',operatorState:'READY',retrievalReady:true}],operatorCounts:{READY:1}},selected:{snapshot:{entries:[{uid:1,comment:'One',content:'One'}]}},renderState:state,scope,motionMode:'NONE'});
  const mark=flatten(root).find(n=>n.tagName==='IMAGE'&&n.className==='nexus-lore-core-node__brand');
  assert.ok(mark,'Nexus brand image must render in World Tree core');
});
