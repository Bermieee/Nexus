import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusWorldTree } from '../world-tree/store.js';
import { createCanonicalWorldTreeReadApi } from '../core/world-tree-api.js';
import { createWorldTreeGraphProvider } from '../nexus/a52/sensory/walker/world-tree-provider.js';
import { NexusSensoryBackbone, createNexusCandidateChannel } from '../nexus/a52/sensory/backbone.js';
import { NativeGraphNeighborhoodRetriever } from '../nexus/a52/graph-neighborhood-retriever.js';
import { createBudgetManager } from '../core/budget.js';
import { createSensoryTurnPlan, readSensoryContinuation, writeSensoryContinuation } from '../retrieval/source-plan.js';
import { replaceNexusWorldTree } from '../world-tree/index.js';

const add=(tree,id)=>tree.upsertNode({id,kind:'ENTITY',scope:{type:'CHAT',chatId:'budget-chat'},provenance:{sourceType:'TEST',sourceIds:[id]},data:{label:id}});
test('canonical reads reach nodes and edges beyond the display projection',()=>{
  const tree=new NexusWorldTree();for(let i=0;i<5005;i++)add(tree,'entity:'+i);
  tree.linkEdge({id:'late-edge',from:'entity:0',to:'entity:5004',relation:'relationship',scope:{type:'CHAT',chatId:'budget-chat'},provenance:{sourceType:'TEST',sourceIds:['late-edge']}});
  const api=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'budget-chat'});
  assert.equal(api.getNode('entity:5004')?.id,'entity:5004');
  assert.equal(api.allNodes().length,[...tree.iterateNodes({chatId:'budget-chat'})].length);
  assert.equal(api.findByAlias('entity:5004').length,1);
  assert.equal(api.nodesFor('entity:5004').length,1);
  assert.equal(api.edgesFrom('entity:0')[0]?.to,'entity:5004');
});
test('graph honors depth grants and returns resumable edge pages',()=>{
  const tree=new NexusWorldTree();for(let i=0;i<=5;i++)add(tree,'chain:'+i);
  for(let i=0;i<5;i++)tree.linkEdge({id:'chain-edge:'+i,from:'chain:'+i,to:'chain:'+(i+1),relation:'part-of',scope:{type:'CHAT',chatId:'budget-chat'},provenance:{sourceType:'TEST',sourceIds:['chain-edge:'+i]}});
  const graph=createWorldTreeGraphProvider({worldTree:createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'budget-chat'}),maxDerivedEdges:1000});
  assert.ok(graph.query({anchorEntityIds:['chain:0'],maxDepth:5,maxEdges:1000}).some(e=>e.toEntityId==='chain:5'));
  const first=graph.query({anchorEntityIds:['chain:0'],maxDepth:5,maxEdges:2});
  assert.equal(first.coverage.complete,false);assert.ok(first.continuation);
  const second=graph.query({anchorEntityIds:['chain:0'],maxDepth:5,maxEdges:2,continuation:first.continuation});
  assert.ok(second.length);assert.ok(second.every(e=>!first.some(a=>a.edgeId===e.edgeId)));
});
test('zero graph grant retains all work for continuation',()=>{
  const tree=new NexusWorldTree();add(tree,'hub');add(tree,'leaf');
  tree.linkEdge({id:'zero-edge',from:'hub',to:'leaf',relation:'relationship',scope:{type:'CHAT',chatId:'budget-chat'},provenance:{sourceType:'TEST',sourceIds:['zero-edge']}});
  const graph=createWorldTreeGraphProvider({worldTree:createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'budget-chat'})});
  const result=graph.query({anchorEntityIds:['hub'],maxEdges:0});
  assert.equal(result.length,0);assert.equal(result.coverage.complete,false);assert.ok(result.continuation);
});
const rows=Array.from({length:200},(_,uid)=>({book:'Book',uid,title:'Entry '+uid,content:'Entry '+uid}));
const backbone=()=>new NexusSensoryBackbone().register(createNexusCandidateChannel({channelId:'lexical',candidates:rows})).register(createNexusCandidateChannel({channelId:'paging',candidates:[{book:'Book',uid:999,content:'Paging'}]}));
test('dynamic candidate grants reach registry and fusion rather than legacy defaults',()=>{
  const result=backbone().retrieveEnvelope({latencyBudgetMs:10000,candidateLimit:2000});
  assert.equal(result.candidates.length,201);
  assert.equal(result.gathered.channelReceipts.find(r=>r.channelId==='lexical').status,'OK');
});
test('bounded candidate work reports and resumes without silently losing nominations',()=>{
  const bus=backbone(),first=bus.retrieveEnvelope({latencyBudgetMs:10000,candidateLimit:40});
  assert.equal(first.candidates.length,40);assert.equal(first.envelope.metadata.coverage.complete,false);
  assert.equal(first.gathered.channelReceipts.find(r=>r.channelId==='lexical').status,'PARTIAL_CANDIDATE_BUDGET');
  assert.ok(first.envelope.metadata.continuation);
  const second=bus.retrieveEnvelope({latencyBudgetMs:10000,candidateLimit:2000,continuation:first.envelope.metadata.continuation});
  assert.equal(new Set([...first.candidates,...second.candidates].map(c=>c.candidateId)).size,201);
});
test('a new turn backbone drains the continuation from the chat working owner',()=>{
  replaceNexusWorldTree();const context={chatId:'continuation-chat'};
  const first=backbone().retrieveEnvelope({latencyBudgetMs:10000,candidateLimit:40});
  writeSensoryContinuation(first.envelope.metadata.continuation,{context});
  const second=backbone().retrieveEnvelope({latencyBudgetMs:10000,candidateLimit:2000,continuation:readSensoryContinuation({context})});
  writeSensoryContinuation(second.envelope.metadata.continuation,{context});
  assert.equal(new Set([...first.candidates,...second.candidates].map(c=>c.candidateId)).size,201);
  assert.equal(readSensoryContinuation({context}),null);
  assert.equal(readSensoryContinuation({context:{chatId:'other-chat'}}),null);
  replaceNexusWorldTree();
});
test('Walker skip leaves other sources enabled in the actual backbone',()=>{
  const bus=backbone();
  bus.register(new NativeGraphNeighborhoodRetriever({temporalGraph:{allClaims:()=>[]}}));
  const result=bus.retrieveEnvelope({sourcePlan:{walker:'skip',vector:'normal'},latencyBudgetMs:10000,candidateLimit:2000,graphTraversal:{latencyBudgetMs:0}});
  assert.equal(result.candidates.length,201);
  assert.ok(result.gathered.channelReceipts.every(row=>row.channelId!=='ZZ_NATIVE_GRAPH_WALKER'));
});
test('Walker preserves provider partial coverage and resumes candidate omissions',()=>{
  const walker=new NativeGraphNeighborhoodRetriever({temporalGraph:{allClaims:()=>[]}});
  walker.registerProvider({providerId:'test-owner',owner:'WORLD_TREE',isRevisionCurrent:()=>true,query:()=>Array.from({length:5},(_,i)=>({edgeId:'edge:'+i,fromEntityId:'hub',toEntityId:'leaf:'+i,edgeMeaning:'relationship',sourceRevisionRefs:['revision'],temporalStatus:'CURRENT'}))});
  const bus=new NexusSensoryBackbone().register(walker);
  const opts={anchorEntityIds:['hub'],latencyBudgetMs:10000,candidateLimit:10,graphTraversal:{maxDepth:5,maxEdges:100,maxNodes:100,maxCandidates:2,latencyBudgetMs:10000}};
  const first=bus.retrieveEnvelope(opts);
  assert.equal(first.candidates.length,2);assert.equal(first.envelope.metadata.coverage.complete,false);
  assert.ok(first.envelope.metadata.continuation);
  const second=bus.retrieveEnvelope({...opts,graphTraversal:{...opts.graphTraversal,maxCandidates:10},continuation:first.envelope.metadata.continuation});
  assert.equal(new Set([...first.candidates,...second.candidates].map(c=>c.candidateId)).size,5);
});
test('production Sensory planning applies outlet room, observed costs and reservations',()=>{
  const events=[],manager=createBudgetManager({now:()=>0,emit:(...event)=>events.push(event)});
  manager.observe('sensory.channel.lexical',{units:1,durationMs:10});
  const plan=createSensoryTurnPlan({budgetManager:manager,timeMs:100,worldSize:2000,promptTokens:100,tokenShare:.5,tokensPerCandidate:5,sourcePlan:{walker:'skip'},channelTotals:{lexical:200},reservations:[{id:'other-job',ms:80}]});
  assert.equal(plan.latencyBudgetMs,100);assert.equal(plan.walkerLimits.latencyBudgetMs,0);
  assert.equal(plan.channelCandidateLimits.lexical,2);
  const receipt=plan.receipts.find(row=>row.id==='sensory.channel.lexical');
  assert.equal(receipt.drivers.promptTokens,100);assert.equal(receipt.drivers.tokenShare,.5);assert.equal(receipt.drivers.reservedMs,80);assert.equal(receipt.drivers.msPerUnit,10);
  assert.ok(receipt.continuation);assert.ok(events.some(row=>row[1]==='budget.plan'));
});
test('a small shared time envelope preserves a source grant alongside Walker',()=>{
  const manager=createBudgetManager({now:()=>0});
  const plan=createSensoryTurnPlan({budgetManager:manager,timeMs:15,worldSize:2000,sourcePlan:{walker:'normal'},channelTotals:{lexical:200}});
  assert.ok(plan.channelCandidateLimits.lexical>0);
  assert.ok(plan.walkerLimits.latencyBudgetMs<plan.latencyBudgetMs);
});
function loreWorld(count=6){
  const tree=new NexusWorldTree();
  for(let uid=0;uid<count;uid++)tree.upsertNode({id:'source:'+uid,kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['source:'+uid]},data:{book:'Book',uid,label:'Entry '+uid,keys:['Entry '+uid],content:'Entry '+uid}});
  return tree;
}
function sourceBackbone(api){
  return new NexusSensoryBackbone().register(createNexusCandidateChannel({channelId:'lexical',worldTree:api,candidates:api.allNodes().filter(node=>node.kind==='lore').map(node=>({book:node.payload.book,uid:node.payload.uid,title:node.payload.title,content:node.payload.content}))}));
}
test('new questions retain source-local tail work for bounded continuation drain',()=>{
  const tree=loreWorld(),api=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'budget-chat'});
  let continuation=null;const seen=new Set();
  for(let turn=0;turn<3;turn++){
    add(tree,'unrelated:'+turn);
    const result=sourceBackbone(api).retrieveEnvelope({query:'question '+turn,sceneRevision:turn,worldRevision:api.worldRevision,sourceRevisionSet:['corpus:'+turn],latencyBudgetMs:10000,candidateLimit:2,continuation,worldTree:api});
    result.candidates.forEach(row=>seen.add(row.candidateId));continuation=result.envelope.metadata.continuation;
    assert.ok(result.candidates.some(row=>row.candidateId==='lore:Book:0'),'fresh source remains eligible on each new question');
    assert.ok(continuation.nominations.some(row=>row.candidateId==='lore:Book:5'),'the incomplete tail survives frame changes');
  }
  for(let slice=0;slice<6&&continuation;slice++){
    const result=sourceBackbone(api).retrieveEnvelope({query:'question 2',sceneRevision:2,worldRevision:api.worldRevision,sourceRevisionSet:['corpus:2'],latencyBudgetMs:10000,candidateLimit:2,continuation,worldTree:api});
    assert.ok(result.candidates.length<=2);result.candidates.forEach(row=>seen.add(row.candidateId));continuation=result.envelope.metadata.continuation;
  }
  assert.equal(seen.size,6);assert.equal(continuation,null);
});
test('editing a deferred source invalidates old evidence before continuation fusion',()=>{
  const tree=loreWorld(),api=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'budget-chat'});
  const first=sourceBackbone(api).retrieveEnvelope({query:'old',worldRevision:api.worldRevision,latencyBudgetMs:10000,candidateLimit:2,worldTree:api});
  const node=tree.getNode('source:5');tree.upsertNode({...node,data:{...node.data,content:'Edited tail'}});
  const second=sourceBackbone(api).retrieveEnvelope({query:'new',sceneRevision:5,worldRevision:api.worldRevision,latencyBudgetMs:10000,candidateLimit:10,continuation:first.envelope.metadata.continuation,worldTree:api});
  assert.ok(second.candidates.every(row=>row.candidateId!=='lore:Book:5'||row.representationText==='Edited tail'));
  assert.ok(second.envelope.metadata.continuationValidation.invalidated>0);
});
test('a new question can retrieve a source delivered by the previous continuation frame',()=>{
  const tree=loreWorld(2),api=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'budget-chat'});
  const first=sourceBackbone(api).retrieveEnvelope({query:'first question',worldRevision:api.worldRevision,latencyBudgetMs:10000,candidateLimit:1,worldTree:api,generationId:'g1'});
  const second=sourceBackbone(api).retrieveEnvelope({query:'where is Entry 0?',sceneRevision:2,worldRevision:api.worldRevision,latencyBudgetMs:10000,candidateLimit:10,continuation:first.envelope.metadata.continuation,worldTree:api,generationId:'g2'});
  assert.ok(second.candidates.some(row=>row.candidateId==='lore:Book:0'),'old delivery accounting cannot hide fresh evidence for a new question');
});
test('an identical question in a new generation can retrieve its previously delivered source',()=>{
  const tree=loreWorld(2),api=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'budget-chat'});
  const options={query:'Entry 0',worldRevision:api.worldRevision,latencyBudgetMs:10000,candidateLimit:1,worldTree:api};
  const first=sourceBackbone(api).retrieveEnvelope({...options,generationId:'g1'});
  const second=sourceBackbone(api).retrieveEnvelope({...options,candidateLimit:10,generationId:'g2',continuation:first.envelope.metadata.continuation});
  assert.ok(second.candidates.some(row=>row.candidateId==='lore:Book:0'));
});
test('a CURRENT link cannot surface a removed Lore target as current evidence',()=>{
  const tree=loreWorld(2),source=tree.getNode('source:0'),target=tree.getNode('source:1');
  tree.upsertNode({...target,temporal:{status:'SUPERSEDED'}});
  tree.linkEdge({id:'retained-link',from:source.id,to:target.id,relation:'about',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['retained-link']},temporal:{status:'CURRENT'}});
  const api=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'budget-chat'}),provider=createWorldTreeGraphProvider({worldTree:api});
  const edges=provider.query({anchorEntityIds:['lore:Book:0'],maxEdges:100,maxDepth:2,latencyBudgetMs:10000});
  assert.ok(edges.length);assert.ok(edges.every(edge=>edge.temporalStatus==='SUPERSEDED'));
  const walker=new NativeGraphNeighborhoodRetriever({temporalGraph:{allClaims:()=>[]}});walker.registerProvider(provider);
  const result=new NexusSensoryBackbone().register(walker).retrieveEnvelope({worldTree:api,intent:'CURRENT',anchorEntityIds:['lore:Book:0'],candidateLimit:10,latencyBudgetMs:10000});
  assert.equal(result.candidates.length,0);
});
test('Walker advances a source-local frontier across unrelated world and scene revisions',()=>{
  const tree=new NexusWorldTree();add(tree,'hub');
  for(let i=0;i<6;i++){add(tree,'leaf:'+i);tree.linkEdge({id:'edge:'+i,from:'hub',to:'leaf:'+i,relation:'relationship',scope:{type:'CHAT',chatId:'budget-chat'},provenance:{sourceType:'TEST',sourceIds:['edge:'+i]}});}
  const api=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'budget-chat'});let continuation=null;const seen=new Set();
  for(let turn=0;turn<8;turn++){
    add(tree,'growth:'+turn);
    const walker=new NativeGraphNeighborhoodRetriever({temporalGraph:{allClaims:()=>[]}});
    walker.registerProvider(createWorldTreeGraphProvider({worldTree:api}));
    const result=new NexusSensoryBackbone().register(walker).retrieveEnvelope({worldTree:api,query:'same question',worldRevision:api.worldRevision,sceneRevision:turn,anchorEntityIds:['hub'],candidateLimit:2,latencyBudgetMs:10000,graphTraversal:{maxDepth:2,maxEdges:2,maxNodes:100,maxCandidates:2,latencyBudgetMs:10000},continuation});
    result.candidates.forEach(row=>seen.add(row.representationRef));continuation=result.envelope.metadata.continuation;
    if(!continuation)break;
  }
  assert.ok(seen.has('leaf:5'),'tail graph source must progress despite world growth');
});
for(const change of ['question','generation'])test('Walker can re-emit earlier source evidence after a new '+change,()=>{
  const tree=new NexusWorldTree();for(const id of ['hub','Silver Compass','Unrelated Tail'])add(tree,id);
  for(const [index,target]of ['Silver Compass','Unrelated Tail'].entries())tree.linkEdge({id:'edge:'+index,from:'hub',to:target,relation:'relationship',scope:{type:'CHAT',chatId:'budget-chat'},provenance:{sourceType:'TEST',sourceIds:['edge:'+index]}});
  const api=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'budget-chat'});
  const run=({continuation=null,query='first question',generationId='g1',limit=1}={})=>{
    const walker=new NativeGraphNeighborhoodRetriever({temporalGraph:{allClaims:()=>[]}});walker.registerProvider(createWorldTreeGraphProvider({worldTree:api}));
    return new NexusSensoryBackbone().register(walker).retrieveEnvelope({worldTree:api,query,generationId,worldRevision:api.worldRevision,anchorEntityIds:['hub'],candidateLimit:limit,latencyBudgetMs:10000,graphTraversal:{maxDepth:2,maxEdges:10,maxNodes:100,maxCandidates:limit,latencyBudgetMs:10000},continuation});
  };
  const first=run();assert.ok(first.candidates.some(row=>row.representationRef==='Silver Compass'));
  const resumed=run({continuation:first.envelope.metadata.continuation,limit:10,query:change==='question'?'where is Silver Compass?':'first question',generationId:change==='generation'?'g2':'g1'});
  assert.ok(resumed.candidates.some(row=>row.representationRef==='Silver Compass'),'saved graph emission accounting cannot hide a fresh relevant source');
});
test('validated canonical graph source refs stay fresh beside the current corpus ref',()=>{
  const tree=new NexusWorldTree();add(tree,'hub');add(tree,'leaf');
  tree.linkEdge({id:'source-edge',from:'hub',to:'leaf',relation:'relationship',scope:{type:'CHAT',chatId:'budget-chat'},provenance:{sourceType:'TEST',sourceIds:['source-edge']}});
  const api=createCanonicalWorldTreeReadApi({worldTree:tree,chatId:'budget-chat'}),walker=new NativeGraphNeighborhoodRetriever({temporalGraph:{allClaims:()=>[]}});
  walker.registerProvider(createWorldTreeGraphProvider({worldTree:api}));
  const result=new NexusSensoryBackbone().register(walker).retrieveEnvelope({worldTree:api,worldRevision:api.worldRevision,sourceRevisionSet:['corpus-current'],anchorEntityIds:['hub'],candidateLimit:10,latencyBudgetMs:10000});
  assert.ok(result.candidates.length);assert.ok(result.candidates.every(candidate=>candidate.freshness==='FRESH'));
});
