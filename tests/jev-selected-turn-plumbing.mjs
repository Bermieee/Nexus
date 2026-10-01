import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerDecisionContract } from '../decision/contracts.js';
import { createNexusUiHostBindings } from '../nexus-ui-bindings.js';
import { normalizeJevDecisionReceipt } from '../src/ui-core/wave8-cognition.js';
const url=new URL('../decision/engine.js',import.meta.url);
let code=fs.readFileSync(url,'utf8').replace(/from '([^']+)'/g,(_,path)=>`from '${path==='./telemetry.js'?'data:text/javascript,export const recordDecisionProviderAttempt=()=>{},recordDecisionResult=()=>{};':new URL(path,url).href}'`);
const {createDecisionCoreEngine}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
registerDecisionContract({id:'plumbing-test',version:1,questions:{ready:{type:'noul'}}});
const selection={chatId:'Story A',generationId:'gen-1',turnId:'gen-1'};
const request={contractId:'plumbing-test',contractVersion:1,mode:'assist',sourceFingerprint:'revision-1',state:{},questions:{ready:{type:'noul',instructions:'Is ready?'}}};

test('engine result reaches the real telemetry producer and host without exposing answers',async()=>{
 const events=[];globalThis.jevPlumbingEvents=events;
 const telemetryUrl=new URL('../decision/telemetry.js',import.meta.url);
 const source=fs.readFileSync(telemetryUrl,'utf8').replace(/from '([^']+)'/g,(_,path)=>`from '${path==='../observability/telemetry.js'?'data:text/javascript,export const logEvent=(category,name,data)=>globalThis.jevPlumbingEvents.push({id:"real-jev",category,name,data});':new URL(path,telemetryUrl).href}'`);
 const producer=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const engine=createDecisionCoreEngine({getConfig:()=>({enabled:true,provider:'typesafe-direct',fallbackEnabled:false}),providers:{'typesafe-direct':{evaluate:async()=>({answers:{ready:{type:'noul',value:.9}}})}},telemetry:{recordAttempt:producer.recordDecisionProviderAttempt,recordResult:producer.recordDecisionResult}});
 await engine.evaluate(request,{telemetrySelection:selection});
 const host=createNexusUiHostBindings({readCurrentChatId:()=>selection.chatId,readGenerationFrameIdentity:()=>selection,readTelemetry:()=>({events})});
 const receipt=host.readJev(selection);assert.equal(receipt.provider,'typesafe-direct');
 assert.equal(normalizeJevDecisionReceipt(receipt).state,'COMPLETE');
 assert.equal(events[0].data.answers,undefined);assert.equal(receipt.settlementPerformed,false);
 delete globalThis.jevPlumbingEvents;
});

test('real Jev evaluation emits captured turn identity and physical-attempt evidence',async()=>{
 let recorded;
 const engine=createDecisionCoreEngine({getConfig:()=>({enabled:true,provider:'openrouter-jev',fallbackEnabled:false}),providers:{'openrouter-jev':{evaluate:async()=>({answers:{ready:{type:"noul",value:1}}})}},telemetry:{recordAttempt(){},recordResult:(result,identity)=>{recorded={result,identity};}}});
 const result=await engine.evaluate(request,{telemetrySelection:selection});
 assert.equal(result.ok,true);assert.deepEqual(recorded.identity,selection);
 assert.equal(recorded.result.fallback.attempts[0].physicalAttempt,true);
});

test('an unconfigured provider is not a physical Jev attempt',async()=>{
 let recorded;
 const engine=createDecisionCoreEngine({getConfig:()=>({enabled:true,provider:'openrouter-jev',fallbackEnabled:false}),providers:{'openrouter-jev':{isConfigured:()=>false}},telemetry:{recordAttempt(){},recordResult:r=>recorded=r}});
 await engine.evaluate(request,{telemetrySelection:selection});
 assert.equal(recorded.fallback.attempts[0].physicalAttempt,false);
});

test('only scoped physical Jev completion becomes the selected-turn UI receipt',()=>{
 const telemetry={events:[]};
 const host=createNexusUiHostBindings({readCurrentChatId:()=>selection.chatId,readGenerationFrameIdentity:()=>selection,readTelemetry:()=>telemetry});
 const event={id:'jev-1',category:'decision-core',name:'decision-complete',data:{...selection,provider:'openrouter-jev',ok:true,stale:false,physicalAttempt:true,contractId:'plumbing-test'}};
 telemetry.events.push(event);
 const receipt=host.readJev(selection);assert.ok(receipt);
 assert.equal(host.readSelectedTurnReceipt(selection).producers.jev.status,'DECIDED');
 assert.equal(normalizeJevDecisionReceipt(receipt).state,'COMPLETE');
 assert.equal(receipt.settlementPerformed,false);
 for(const data of [{...event.data,generationId:'other'},{...event.data,chatId:'other'},{provider:'openrouter-jev',physicalAttempt:true},{...event.data,physicalAttempt:false}]){
  telemetry.events=[{...event,data}];assert.equal(host.readJev(selection),null);
 }
 telemetry.events=[{...event,name:'decision-stale',data:{...event.data,ok:false,stale:true}}];
 assert.equal(normalizeJevDecisionReceipt(host.readJev(selection)).state,'STALE');
});
