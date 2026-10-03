import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusWorldTree } from '../world-tree/store.js';
import { createCanonicalWorldTreeReadApi } from '../core/world-tree-api.js';
import { createWorldTreeGraphProvider } from '../nexus/a52/sensory/walker/world-tree-provider.js';
import { NativeGraphNeighborhoodRetriever } from '../nexus/a52/graph-neighborhood-retriever.js';

function fixture(count){
  const tree=new NexusWorldTree();
  for(let uid=0;uid<count;uid++)tree.upsertNode({id:'entry:'+uid,kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['entry:'+uid]},data:{book:'Book',uid,label:'Common Society',keys:['Common Society'],content:'Common Society oversees this district.'}});
  return {tree,api:createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'chat'})};
}
test('constructor never materializes the duplicate-alias product and each derivation slice honors its grant',()=>{
  const {api}=fixture(400),provider=createWorldTreeGraphProvider({worldTree:api,maxDerivedEdges:2});
  assert.equal(provider.diagnostics().edgeCount,0,'alias pairs must be constructed only while querying');
  assert.equal(provider.diagnostics().derivation?.examinedUnits,0);
  const result=provider.query({anchorEntityIds:['lore:Book:0'],maxEdges:2,maxDepth:2,latencyBudgetMs:1});
  assert.ok(provider.diagnostics().derivation.examinedUnits<=2);
  assert.ok(provider.diagnostics().derivation.materializedEdges<=4);
  assert.equal(result.coverage.complete,false);assert.ok(result.continuation);
  assert.equal(result.coverage.construction.complete,false);
});
test('bounded lazy derivation resumes through every directed alias edge on a small connected fixture',()=>{
  const {api}=fixture(4),seen=new Set();let continuation=null,complete=false;
  for(let page=0;page<100;page++){
    const provider=createWorldTreeGraphProvider({worldTree:api,maxDerivedEdges:2});
    const result=provider.query({anchorEntityIds:['lore:Book:0'],maxEdges:2,maxDepth:3,latencyBudgetMs:10000,continuation});
    result.forEach(edge=>seen.add(edge.edgeId));assert.ok(result.coverage.construction.examinedUnits<=2);
    continuation=result.continuation;if(result.coverage.complete){complete=true;assert.equal(result.coverage.total,24);assert.equal(result.coverage.totalKnown,true);break;}
  }
  assert.equal(complete,true);assert.equal(seen.size,24);
});
test('four thousand shared aliases remain a linear constructor index with no derived work',()=>{
  const {api}=fixture(4000),provider=createWorldTreeGraphProvider({worldTree:api,maxDerivedEdges:2});
  assert.equal(provider.diagnostics().nodeCount,api.allNodes().length);
  assert.ok(provider.diagnostics().nodeCount>=4000);
  assert.equal(provider.diagnostics().edgeCount,0);
  assert.deepEqual(provider.diagnostics().derivation,{examinedUnits:0,materializedEdges:0,materialScans:0});
});
test('reused explicit edge IDs can emit revised evidence during an unfinished Walker page',()=>{
  const {tree,api}=fixture(3);
  tree.linkEdge({id:'relationship',from:'entry:0',to:'entry:1',relation:'relationship',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['edge-source']},data:{subtype:'old-bond'}});
  const run=continuation=>{
    const walker=new NativeGraphNeighborhoodRetriever({temporalGraph:{allClaims:()=>[]}});walker.registerProvider(createWorldTreeGraphProvider({worldTree:api,maxDerivedEdges:2}));
    return walker.retrieve({intentId:'turn',kind:'CURRENT',entityRefs:['lore:Book:0']},{chatId:'chat',worldRevision:api.worldRevision,channelContinuation:continuation,graphTraversal:{maxEdges:2,maxNodes:100,maxDepth:3,maxCandidates:2,latencyBudgetMs:10000}});
  };
  const first=run(null);assert.ok(first.continuation);
  const edge=tree.getEdge('relationship');tree.linkEdge({...edge,data:{...edge.data,subtype:'revised-bond'}});
  const second=run(first.continuation);
  assert.ok(second.some(row=>row.representationText.includes('revised-bond')),'revised source version must not remain suppressed by its reused edge ID');
});
