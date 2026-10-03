import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSystemTelemetryHook } from '../core/system-telemetry.js';
import { projectNexusDiagnosticTelemetryFromObservability } from '../nexus/diagnostics-source.js';
import { createNexusUiHostBindings, projectNexusSensoryTrace, projectNexusTruthAssessment } from '../nexus-ui-bindings.js';
import { renderDiagnosticsCenter } from '../src/ui-core/wave13-operator-surfaces.js';
import { createWave11LiveReceiptBinding } from '../src/ui-core/wave11-live-bindings.js';

const categories=['nexus.truth','nexus.sensory','nexus.walker','nexus.hot','nexus.scene','nexus.greenroom','nexus.scatter','nexus.gather','nexus.resource-probe'];
const channels=['truth','sensory','graph-walker','hot-cognition','scene-intelligence','green-room','scatter','gather','resource-probe'];
function feed(){
  const events=[],tasks=[];
  const hook=createSystemTelemetryHook({emit:(category,name,data,level)=>events.push({id:'event-'+events.length,category,name,data,level,ts:1}),schedule:fn=>tasks.push(fn)});
  const flush=()=>{while(tasks.length)tasks.shift()();};
  return{hook,events,tasks,flush};
}
function fakeDocument(){
  return {createElement(tag){return{tagName:tag.toUpperCase(),dataset:{},children:[],textContent:'',setAttribute(){},addEventListener(){},append(...children){this.children.push(...children);}};}};
}
function text(node){return [node.textContent,...node.children.map(child=>typeof child==='string'?child:text(child))].join(' ');}

test('subsystem owner status reaches the existing Diagnostics panel',()=>{
 const host=createNexusUiHostBindings({readSubsystemStatus:()=>({maintenance:{lastStatus:'COMPLETE'},paging:{mode:'auto',indexReady:true},postturn:{pendingCount:3},smartContext:{status:'READY'}})});
 const panel=renderDiagnosticsCenter(fakeDocument(),{diagnostics:{read:()=>({telemetry:{nexus:host.readDiagnosticsTelemetry().telemetry}})}});
 const rendered=text(panel);for(const label of ['Maintenance','Paging','Postturn','Smart Context'])assert.ok(rendered.includes(label),label);
 assert.ok(rendered.includes('COMPLETE'));assert.ok(rendered.includes('auto'));
});

test('all nine channels reach the host Diagnostics read and actual existing panel',()=>{
  const f=feed();
  for(const category of categories)f.hook(category,'observed',{status:'READY',chatId:'chat-a',generationId:'gen-a',rawPrompt:'SECRET-PROMPT',content:'SECRET-STORY',reasoning:'SECRET-REASONING',apiKey:'SECRET-KEY',responseBody:'SECRET-RESPONSE'});
  assert.equal(f.events.length,0,'generation does not execute the sink synchronously');
  f.flush();
  const host=createNexusUiHostBindings({readTelemetry:()=>({events:f.events}),readSystemDiagnostics:()=>projectNexusDiagnosticTelemetryFromObservability({events:f.events})});
  const snapshot=host.readDiagnosticsTelemetry({chatId:'chat-a'});
  assert.deepEqual(Object.keys(snapshot.telemetry.systems.channels),channels);
  for(const channel of channels)assert.equal(snapshot.telemetry.systems.channels[channel].data.status,'READY');
  assert.equal(JSON.stringify(snapshot).includes('SECRET-'),false);
  const panel=renderDiagnosticsCenter(fakeDocument(),{diagnostics:{read:()=>({telemetry:{nexus:snapshot.telemetry}})}});
  const rendered=text(panel);
  for(const channel of channels)assert.ok(rendered.includes(channel),channel+' missing in panel');
});

test('failed or malformed diagnostic sinks cannot throw into callers and queues stay bounded',()=>{
  const tasks=[];let calls=0;
  const hook=createSystemTelemetryHook({maxPending:4,batchSize:2,emit(){calls++;throw new Error('sink failed');},schedule:fn=>tasks.push(fn)});
  for(let i=0;i<20;i++)assert.doesNotThrow(()=>hook('nexus.hot','changed',{hotRevision:i}));
  assert.equal(calls,0);assert.equal(tasks.length,1);
  assert.doesNotThrow(()=>{while(tasks.length)tasks.shift()();});
  assert.equal(calls,4);
  assert.doesNotThrow(()=>hook('nexus.hot','changed',new Proxy({},{get(){throw new Error('bad metadata');}})));
  assert.doesNotThrow(()=>createSystemTelemetryHook({emit(){},schedule(){throw new Error('no scheduler');}})('nexus.hot','changed',{}));
  const host=createNexusUiHostBindings({readTelemetry(){throw new Error('read failed');},readSystemDiagnostics(){throw new Error('read failed');}});
  assert.doesNotThrow(()=>host.readDiagnosticsTelemetry());
});

test('metadata-only deferred events preserve the existing Cognition read models',()=>{
  const f=feed();
  f.hook('nexus.truth','candidate-verdict',{chatId:'chat-a',generationId:'gen-a',kind:'lore',candidateId:'candidate:1',classification:'CURRENT',kept:true,usableForIntent:true,reasons:['current-usable']});
  f.hook('nexus.truth','assessment-complete',{chatId:'chat-a',generationId:'gen-a',kind:'lore',intent:'CURRENT',candidateCount:1,keptCount:1});
  f.hook('nexus.sensory','candidate-envelope',{chatId:'chat-a',generationId:'gen-a',candidateCount:1,fusionReceipt:{freshness:'FRESH',inputNominationCount:3,inputChannelCount:2,perChannelCounts:{lexical:2},unavailableChannels:[],degradedChannels:[]},channelReceipts:[{channelId:'lexical'}]});
  f.flush();
  const selection={chatId:'chat-a',generationId:'gen-a'};
  assert.deepEqual(projectNexusTruthAssessment({events:f.events},selection).admittedCandidateIds,['candidate:1']);
  const sensory=projectNexusSensoryTrace({events:f.events},selection);
  assert.equal(sensory.trace.inputNominationCount,3);assert.equal(sensory.trace.inputChannelCount,2);assert.equal(sensory.trace.uniqueCandidates,1);
});

test('Sensory telemetry preserves unknown revision fences through deferred emission and repeated projection',()=>{
  const f=feed(),selection={chatId:'chat-a',generationId:'gen-a',worldRevision:229,sceneRevision:3};
  f.hook('nexus.sensory','candidate-envelope',{chatId:selection.chatId,generationId:selection.generationId,candidateCount:1});
  f.flush();
  assert.equal(f.events[0].data.sceneRevision,null,'missing Scene revision must not become revision zero');
  assert.equal(f.events[0].data.worldRevision,null);
  const projected=projectNexusDiagnosticTelemetryFromObservability({events:f.events});
  assert.equal(projected.events[0].data.selection.sceneRevision,null);
  assert.equal(projected.events[0].data.selection.worldRevision,null);
  const binding=createWave11LiveReceiptBinding({initialSelection:selection,
    readSensoryTrace:query=>projectNexusSensoryTrace({events:f.events},query)});
  const sensory=binding.bridges.cognition.readSensoryTrace();
  assert.equal(sensory.sceneRevision,null,'the selection must not fabricate a missing producer revision');
  assert.equal(sensory.trace.sceneRevision,null);
  assert.equal(sensory.trace.uniqueCandidates,1);
  for(const [sceneRevision,code] of [[0,'LIVE_RECEIPT_STALE'],[4,'LIVE_RECEIPT_FUTURE']]){
    f.events.length=0;
    f.hook('nexus.sensory','candidate-envelope',{...selection,sceneRevision,candidateCount:1});f.flush();
    assert.throws(()=>binding.bridges.cognition.readSensoryTrace(),error=>error.code===code&&error.actual.sceneRevision===sceneRevision);
  }
});

test('provider checks emit sanitized resource-probe events for success and missing endpoint',async()=>{
  const url=new URL('../sidecar/provider-check.js',import.meta.url),events=[];
  globalThis.probeDiagnosticTest=(...args)=>events.push(args);
  const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
  let source=fs.readFileSync(url,'utf8');
  source=source.replace("'../observability/system-events.js'",JSON.stringify(moduleUrl('export const logSystemEvent=(...args)=>globalThis.probeDiagnosticTest(...args);')));
  source=source.replace("'./client.js'",JSON.stringify(moduleUrl(`export const providerCapabilityKey=()=> 'capacity';export const listSidecarModels=async()=>['model'];export const callSidecar=async()=>({text:'NEXUS_OK',structuredPayload:{nexus_provider_check:true}});`)));
  const provider=await import(moduleUrl(source));
  assert.equal((await provider.checkSidecarProvider({})).usable,false);
  assert.equal((await provider.checkSidecarProvider({endpoint:'https://secret-endpoint',apiKey:'SECRET',model:'model',id:'A'})).usable,true);
  assert.equal(events.length,2);assert.equal(events[1][0],'nexus.resource-probe');assert.equal(events[1][2].callable,true);
  assert.equal(JSON.stringify(events).includes('secret-endpoint'),false);assert.equal(JSON.stringify(events).includes('SECRET'),false);
  delete globalThis.probeDiagnosticTest;
});
