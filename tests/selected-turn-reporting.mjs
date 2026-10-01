import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as diagnostics from '../retrieval/diagnostics.js';
import { createNexusUiHostBindings } from '../nexus-ui-bindings.js';
import { SelectedTurnGraphVisibilityAdapter } from '../src/ui-core/selected-turn-graph-visibility.js';
import { Wave13CoprocessorStateUIAdapter } from '../src/ui-core/wave13-operator-adapters.js';
const selection={chatId:'story',generationId:'generation',turnId:'generation'};

test('actual traversal receipt reaches the graph inspector without story or query bodies',()=>{
 assert.equal(typeof diagnostics.recordGraphTraversalDiagnostics,'function');
 diagnostics.recordGraphTraversalDiagnostics({...selection,receipt:{kind:'GraphTraversalReceipt',intentId:'intent',query:'SECRET QUERY',traversedEdgeCount:1,visitedNodeCount:2,nominationCount:1,referenceSummary:[{edgeId:'edge',owner:'WORLD_TREE',providerId:'tree',fromEntityId:'one',toEntityId:'two',edgeMeaning:'RELATED_TO',content:'SECRET BODY'}]}});
 const host=createNexusUiHostBindings({readCurrentChatId:()=>selection.chatId,readGenerationFrameIdentity:()=>selection,readGraphTraversal:diagnostics.readGraphTraversalDiagnostics});
 const model=new SelectedTurnGraphVisibilityAdapter({bindings:host,selectionProvider:host.readSelection}).read();
 assert.equal(model.state,'READY');assert.equal(model.summary.traversedEdgeCount,1);
 assert.equal(JSON.stringify(model).includes('SECRET'),false);
 assert.equal(host.readGraphTraversal({...selection,generationId:'foreign'}),null);
 assert.equal(host.readGraphTraversal({...selection,chatId:'foreign'}),null);
});

test('execution counters use scoped request records, deduplicate updates and exclude probes',()=>{
 const start={category:'sidecar-a',name:'request-start',data:{...selection,routeId:'route',jobId:'job',attempt:1,phase:'primary'}};
 const events=[start,{...start,id:'duplicate'}, {...start,name:'request-success'},
  {...start,data:{...start.data,generationId:'other'}},
  {...start,data:{...start.data,routeId:'probe',role:'connectivity-test'}},
  {category:'decision-core',name:'decision-complete',data:{...selection,physicalAttempt:true,jevReturned:true,ok:true,provider:'openrouter-jev'},id:'jev-result'},
 ];
 const host=createNexusUiHostBindings({readCurrentChatId:()=>selection.chatId,readGenerationFrameIdentity:()=>selection,readTelemetry:()=>({events})});
 const physical=host.readCognitionUiState(selection).physicalExecution;
 assert.equal(physical.attempts,2);assert.equal(physical.succeeded,2);assert.equal(physical.failed,0);
 const ui=new Wave13CoprocessorStateUIAdapter({readState:host.readCognitionUiState,selectionProvider:host.readSelection}).read();
 assert.equal(ui.data.physicalExecution.attempts,2);assert.equal(ui.data.physicalExecution.succeeded,2);
 assert.equal(host.readCognitionUiState({...selection,generationId:'other'}),null);
});

test('graph retention is bounded, cloned and clears with its chat diagnostics',()=>{
 for(let i=0;i<34;i++)diagnostics.recordGraphTraversalDiagnostics({chatId:'bounded',generationId:'g'+i,receipt:{kind:'GraphTraversalReceipt',traversedEdgeCount:i}});
 assert.equal(diagnostics.readGraphTraversalDiagnostics({chatId:'bounded',generationId:'g0'}),null);
 const receipt=diagnostics.readGraphTraversalDiagnostics({chatId:'bounded',generationId:'g33'});receipt.traversedEdgeCount=999;
 assert.equal(diagnostics.readGraphTraversalDiagnostics({chatId:'bounded',generationId:'g33'}).traversedEdgeCount,33);
 diagnostics.clearRetrievalDiagnostics({chatId:'bounded'});
 assert.equal(diagnostics.readGraphTraversalDiagnostics({chatId:'bounded',generationId:'g33'}),null);
});

test('request failure, repair and cancellation are distinct from successful execution',()=>{
 const events=['request-failure','request-semantic-repair-needed','request-cancelled'].map((name,i)=>({category:'sidecar-b',name,data:{...selection,routeId:'route-'+i,attempt:1}}));
 const host=createNexusUiHostBindings({readCurrentChatId:()=>selection.chatId,readGenerationFrameIdentity:()=>selection,readTelemetry:()=>({events})});
 const result=host.readCognitionUiState(selection).physicalExecution;
 assert.equal(result.attempts,3);assert.equal(result.failed,2);assert.equal(result.cancelled,1);assert.equal(result.succeeded,0);
});

test('actual client telemetry composition preserves captured identity without binding probes',()=>{
 const source=fs.readFileSync(new URL('../sidecar/client.js',import.meta.url),'utf8');
 const start=source.indexOf('function telemetryBase('),end=source.indexOf('\n}',start)+2;
 const compose=new Function('currentNexusChatEpoch',source.slice(start,end)+';return telemetryBase;')(()=>1);
 const data=compose(selection,{endpoint:'https://provider.invalid'},'request',{});
 assert.equal(data.chatId,selection.chatId);assert.equal(data.generationId,selection.generationId);
 assert.equal(compose({role:'connectivity-test'},{},'probe',{}).generationId,null);
});
