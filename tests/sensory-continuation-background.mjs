import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundScheduler } from '../scheduler/background.js';
import { NexusWorldTree } from '../world-tree/store.js';
import { createCanonicalWorldTreeReadApi } from '../core/world-tree-api.js';
import { NexusSensoryBackbone, createNexusCandidateChannel } from '../nexus/a52/sensory/backbone.js';
import { createBudgetManager } from '../core/budget.js';
import { scheduleSensoryContinuation } from '../retrieval/sensory-continuation.js';

function fixture(){
  const tree=new NexusWorldTree();
  const candidates=Array.from({length:6},(_,uid)=>({book:'Book',uid,title:'Entry '+uid,content:'Entry '+uid}));
  for(const row of candidates)tree.upsertNode({id:'source:'+row.uid,kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['source:'+row.uid]},data:{book:row.book,uid:row.uid,label:row.title,keys:[row.title],content:row.content}});
  const api=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'chat'});
  const first=new NexusSensoryBackbone().register(createNexusCandidateChannel({channelId:'lexical',candidates,worldTree:api})).retrieveEnvelope({worldTree:api,worldRevision:api.worldRevision,candidateLimit:2,latencyBudgetMs:10000});
  let state=first.envelope.metadata.continuation,scope={chatId:'chat',epoch:1,worldRevision:api.worldRevision};
  const scheduler=new BackgroundScheduler({captureScope:()=>({...scope,worldRevision:api.worldRevision}),isFresh:captured=>captured.chatId===scope.chatId&&captured.worldRevision===api.worldRevision});
  const options={scheduler,context:{chatId:'chat'},worldTree:api,budgetManager:createBudgetManager(),readState:()=>structuredClone(state),writeState:value=>{state=structuredClone(value);},sliceTimeMs:1000};
  return {tree,api,scheduler,options,read:()=>state,setScope:value=>{scope=value;}};
}
test('background source drain survives unrelated growth and stages results for a new query',async()=>{
  const f=fixture();f.scheduler.loan('turn');const work=scheduleSensoryContinuation(f.options);
  f.tree.upsertNode({id:'unrelated',kind:'ENTITY',scope:{type:'CHAT',chatId:'chat'},provenance:{sourceType:'TEST',sourceIds:['unrelated']},data:{label:'Growth'}});
  f.scheduler.resume('turn');await work;
  assert.equal(f.read().nominations.length,0);assert.equal(f.read().readyNominations.length,4);
  const next=new NexusSensoryBackbone().retrieveEnvelope({worldTree:f.api,query:'new question',worldRevision:f.api.worldRevision,sceneRevision:7,sourceRevisionSet:['new-corpus'],candidateLimit:10,latencyBudgetMs:10000,continuation:f.read()});
  assert.equal(next.candidates.length,4);assert.equal(next.envelope.metadata.continuation,null);
});
test('background publication revalidates a source edited at its checkpoint',async()=>{
  const f=fixture();let edited=false;
  f.scheduler.emit=(name,data)=>{if(name==='scheduler.checkpoint'&&data.action==='save'&&!edited){edited=true;const node=f.tree.getNode('source:5');f.tree.upsertNode({...node,data:{...node.data,content:'Edited tail'}});}};
  await scheduleSensoryContinuation(f.options);
  assert.ok(f.read().readyNominations.every(row=>row.representationRef!=='lore:Book:5'||row.representationText==='Edited tail'));
});
test('chat and binding switches reject queued background publications',async()=>{
  for(const change of ['chat','binding']){
    const f=fixture();let binding='Book A';
    const scopedApi=new Proxy(f.api,{get:(target,key)=>key==='readScopeKey'?binding:Reflect.get(target,key)});
    f.scheduler.loan('turn');const work=scheduleSensoryContinuation({...f.options,worldTree:scopedApi});
    if(change==='chat')f.setScope({chatId:'other',epoch:2});else binding='Book B';
    f.scheduler.resume('turn');await assert.rejects(work,{name:'TV2ScopeInvalidated'});
    assert.equal(f.read().readyNominations,undefined);
  }
});
