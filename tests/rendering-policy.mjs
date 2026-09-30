import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NexusMotionMode,
  installNexusRenderingPolicy,
  setNexusMotionMode,
  createNexusSvgElement,
  createNexusSvgAnimation,
  startNexusSvgAnimations,
} from '../core/rendering-policy.js';

function node(tagName,namespaceURI=null){
  const attrs=new Map(),children=[];
  return{
    tagName,namespaceURI,children,parentNode:null,
    setAttribute(key,value){attrs.set(String(key),String(value));},
    getAttribute(key){return attrs.has(String(key))?attrs.get(String(key)):null;},
    append(...rows){for(const row of rows){if(row){children.push(row);row.parentNode=this;}}},
    appendChild(row){this.append(row);return row;},
    beginElementCalls:0,beginElementAtCalls:[],
    beginElement(){this.beginElementCalls+=1;},
    beginElementAt(value){this.beginElementAtCalls.push(value);},
  };
}

function fakeDocument({reduced=false}={}){
  const byId=new Map();
  const documentElement=node('HTML');
  const head=node('HEAD');
  const document={
    documentElement,head,
    defaultView:{matchMedia:()=>({matches:reduced,addEventListener(){}})},
    createElement(tag){const row=node(String(tag).toUpperCase());Object.defineProperty(row,'id',{get(){return row.getAttribute('id')},set(v){row.setAttribute('id',v);byId.set(String(v),row)}});return row;},
    createElementNS(ns,tag){return node(String(tag),ns);},
    getElementById(id){return byId.get(String(id))??null;},
  };
  const originalAppend=head.append.bind(head);
  head.append=(...rows)=>{for(const row of rows)if(row?.id)byId.set(String(row.id),row);originalAppend(...rows);};
  return document;
}

test('installs extension-wide SVG and motion policy',()=>{
  const document=fakeDocument({reduced:false});
  const snapshot=installNexusRenderingPolicy({document,motionMode:NexusMotionMode.SYSTEM});
  assert.equal(snapshot.svg.supported,true);
  assert.equal(snapshot.animationsEnabled,true);
  assert.equal(document.documentElement.getAttribute('data-nexus-rendering-policy'),'active');
  assert.equal(document.documentElement.getAttribute('data-nexus-svg'),'native');
  assert.equal(document.documentElement.getAttribute('data-nexus-motion'),'full');
});

test('system motion policy honors reduced-motion preference',()=>{
  const document=fakeDocument({reduced:true});
  const snapshot=installNexusRenderingPolicy({document,motionMode:NexusMotionMode.SYSTEM});
  assert.equal(snapshot.reducedMotion,true);
  assert.equal(snapshot.animationsEnabled,false);
  assert.equal(document.documentElement.getAttribute('data-nexus-motion'),'reduced');
  const full=setNexusMotionMode(NexusMotionMode.FULL,{document});
  assert.equal(full.reducedMotion,false);
});

test('shared SVG helpers create namespace-correct elements and bounded native animation',()=>{
  const document=fakeDocument();
  installNexusRenderingPolicy({document,motionMode:NexusMotionMode.FULL});
  const svg=createNexusSvgElement(document,'svg',{viewBox:'0 0 10 10'});
  const animation=createNexusSvgAnimation(document,{attributeName:'r',from:0,to:10,begin:250,dur:500});
  svg.append(animation);
  assert.equal(svg.namespaceURI,'http://www.w3.org/2000/svg');
  assert.equal(animation.namespaceURI,'http://www.w3.org/2000/svg');
  assert.equal(animation.getAttribute('data-nexus-start-ms'),'250');
  const started=startNexusSvgAnimations(svg,{document});
  assert.equal(started,1);
  assert.deepEqual(animation.beginElementAtCalls,[0.25]);
});
