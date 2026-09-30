import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const sourceUrl=new URL('../nexus/resource-connections.js',import.meta.url);

async function loadSubject(){
  globalThis.__nexusConnectionTestSettings={
    decisionCore:{enabled:true,mode:'assist',connection:{endpoint:'https://openrouter.ai/api/v1',apiKey:'jev-key',model:'typesafe/jev-1.13',lastTest:null}},
    sidecars:{
      A:{enabled:false,endpoint:'https://openrouter.ai/api/v1',apiKey:'a-key',model:'z-ai/glm-5.3-flash',format:'openai',capabilities:{}},
      B:{enabled:false,endpoint:'https://openrouter.ai/api/v1',apiKey:'b-key',model:'z-ai/glm-5.3-flash',format:'openai',capabilities:{}},
    },
    vectorPaging:{endpoint:'https://openrouter.ai/api/v1',model:'embed-model',connection:{connected:true,lastTest:null}},
  };
  let source=fs.readFileSync(sourceUrl,'utf8');
  source=source.replace("'../core/settings.js'",JSON.stringify(moduleUrl(`
    export const getSettings=()=>globalThis.__nexusConnectionTestSettings;
    export const updateSettings=fn=>{fn(globalThis.__nexusConnectionTestSettings);return globalThis.__nexusConnectionTestSettings;};
  `)));
  source=source.replace("'../decision/index.js'",JSON.stringify(moduleUrl(`
    export const testDecisionConnection=async()=>({ok:true,checkedAt:Date.now(),latencyMs:1,providerModel:'jev'});
  `)));
  source=source.replace("'./jev-connector.js'",JSON.stringify(moduleUrl(`
    export const inferJevProviderFromEndpoint=()=> 'openrouter-jev';
    export const resolveNexusJevConnection=settings=>({
      endpoint:settings.decisionCore.connection.endpoint,
      apiKey:settings.decisionCore.connection.apiKey,
      model:settings.decisionCore.connection.model,
      provider:'openrouter-jev',
      lastTest:settings.decisionCore.connection.lastTest,
    });
  `)));
  source=source.replace("'../sidecar/provider-check.js'",JSON.stringify(moduleUrl(`
    export const checkSidecarProvider=async()=>({usable:true,checkedAt:Date.now(),durationMs:2,model:'z-ai/glm-5.3-flash',checks:[]});
  `)));
  source=source.replace("'../sidecar/client.js'",JSON.stringify(moduleUrl(`
    export const listSidecarModels=async()=>['z-ai/glm-5.3-flash'];
  `)));
  source=source.replace("'../paging/embeddings.js'",JSON.stringify(moduleUrl(`
    export const embedWithSession=async()=>[[0.1,0.2,0.3]];
  `)));
  source=source.replace("'../paging/policy.js'",JSON.stringify(moduleUrl(`
    export const pagingConfig=input=>input||{};
  `)));
  source=source.replace("'../paging/runtime.js'",JSON.stringify(moduleUrl(`
    export const embeddingSessionKeyLoaded=()=>false;
    export const invalidateVectorPaging=()=>{};
    export const setEmbeddingSessionKey=()=>{};
    export const vectorPagingStatus=()=>({busy:false,mode:'auto',error:null});
  `)));
  return import(moduleUrl(source));
}

test('combined Connections snapshot does not reference retired local state variables',async()=>{
  const subject=await loadSubject();
  const before=subject.readNexusConnectionResources({queue:{lanes:{A:{running:[]},B:{running:[]}}}});
  assert.equal(before.resources.length,4);
  assert.equal(before.resources.find(row=>row.resourceId==='nexus-sidecar-a').state,'DISCONNECTED');
  assert.equal(before.resources.find(row=>row.resourceId==='nexus-vectoring').state,'UNVERIFIED');

  assert.doesNotThrow(()=>subject.connectNexusConnectionResource({
    role:'SIDECAR_A',endpoint:'https://openrouter.ai/api/v1',modelId:'z-ai/glm-5.3-flash',apiKey:'a-key',
  }));
  const unverified=subject.readNexusConnectionResources().resources.find(row=>row.resourceId==='nexus-sidecar-a');
  assert.equal(unverified.state,'UNVERIFIED');
  assert.equal(unverified.callable,false);

  const tested=await subject.testNexusConnectionResource('nexus-sidecar-a');
  assert.equal(tested.failure,undefined);
  const ready=subject.readNexusConnectionResources().resources.find(row=>row.resourceId==='nexus-sidecar-a');
  assert.equal(ready.state,'READY');
  assert.equal(ready.callable,true);
  assert.deepEqual(ready.activeCapabilities,['STRUCTURED_EXTRACTION']);
});

test('Jev and Vectoring snapshots stay unverified until test evidence exists',async()=>{
  const subject=await loadSubject();
  const rows=subject.readNexusConnectionResources().resources;
  assert.equal(rows.find(row=>row.resourceId==='nexus-jev').state,'UNVERIFIED');
  assert.equal(rows.find(row=>row.resourceId==='nexus-vectoring').state,'UNVERIFIED');
  assert.deepEqual(rows.find(row=>row.resourceId==='nexus-vectoring').activeCapabilities,[]);
});
