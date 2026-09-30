import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sidecarScheduler } from '../scheduler/sidecars.js';
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
test('selected-node logical owner finishes and commits through its injected step',async()=>{
 sidecarScheduler.clear();let calls=0;
 globalThis.treeClosureFixture={tree:{root:{id:'root',label:'Port',children:[],entryUids:[1]}},book:{entries:{1:{uid:1,content:'Port is open.'}}}};
 const url=new URL('../tree/summarizer.js',import.meta.url);
 const stubs={
 '../lore/store.js':'export const loadBook=async()=>globalThis.treeClosureFixture.book;',
 './store.js':'export const getTree=()=>globalThis.treeClosureFixture.tree;',
 './model.js':'export const clone=structuredClone;export const findNode=(root,id)=>root.id===id?root:null;export const semanticSnapshot=value=>value;',
 '../sidecar/bus.js':"export const BUS_STAGE={TREE_BUILD:'tree'};export const BUS_PRIORITY={MAINTENANCE:40};",
 '../nexus/model-worker-bus.js':'export const enqueueNexusModelWorkerJob=(domain,stage,request)=>globalThis.treeClosureDispatch(request);export const dispatchNexusModelWorkerUnits=()=>{};',
 '../nexus/batch-layer.js':"export const NEXUS_BATCH_DOMAIN={TREE:'tree'};export const runNexusModelWorkerBatch=()=>{};",
 './summary-execution.js':'export const runTreeSummaryThroughDirector=async execute=>({output:await execute()});',
 '../observability/telemetry.js':'export const logEvent=()=>{};',
 '../observability/token-estimator.js':'export const estimateContentTokens=text=>text.length/4;',
 '../sidecar/normalize-response.js':'export const parseStructuredJsonCandidate=JSON.parse;',
 '../core/cancellation.js':'export const isIntentionalCancellation=error=>error?.name?.includes("ScopeInvalidated");',
 '../lore/policy.js':'export const assertReadableBook=()=>{};export const assertWritableBook=()=>{};',
 './summary-transaction.js':'export const buildTreeSummaryCommitAssumptions=()=>({});export const stageTreeSummaryCommitTransaction=()=>({id:"tx"});',
 '../nexus/mutation-coordinator.js':'export const commitCanonicalNexusMutation=async(id,mutation,options)=>{await options.preflight();globalThis.treeClosureFixture.tree=mutation.tree;return {state:"committed"};};'
 };
 globalThis.treeClosureDispatch=request=>({promise:sidecarScheduler.execute({lane:'background',logicalStep:request.schedulerLogicalStep===true,scope:request.nexusScope,run:async()=>{calls++;return {structuredPayload:{summaries:[{ref:'N1',summary:'The port remains open.'}]}};}})});
 const source=fs.readFileSync(url,'utf8').replace(/from '([^']+)'/g,(_,name)=>`from '${stubs[name]?data(stubs[name]):new URL(name,url).href}'`);
 const owner=await import(data(source));let timer;
 try{
  const output=await Promise.race([owner.generateNodeSummary('world','root'),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('logical owner deadlocked')),250))]);
  assert.equal(output.summary,'The port remains open.');assert.equal(calls,1);assert.equal(globalThis.treeClosureFixture.tree.root.summary,output.summary);
 }finally{clearTimeout(timer);sidecarScheduler.clear();delete globalThis.treeClosureDispatch;delete globalThis.treeClosureFixture;}
});

test('keyword owner reads all source pages and retains more than eight suggestions',async()=>{
 sidecarScheduler.clear();const body='BEGIN_MARK '+ 'a'.repeat(17000)+' MIDDLE_MARK '+ 'b'.repeat(17000)+' END_MARK';
 let calls=0;const pages=[];
 globalThis.keywordClosureFixture={entries:{1:{uid:1,comment:'Source',content:body,key:[]}}};
 const url=new URL('../tree/keyword-advisor.js',import.meta.url);
 const stubs={
  '../lore/store.js':'export const loadBook=async()=>globalThis.keywordClosureFixture;export const findEntryByUid=(entries,uid)=>entries[uid];',
  './store.js':'export const getTree=()=>null;',
  './model.js':'export const findNode=()=>null;export const collectUids=()=>[];',
  '../lore/policy.js':'export const assertReadableBook=()=>{};',
  '../sidecar/bus.js':"export const BUS_STAGE={MAINTENANCE:'maintenance'};export const BUS_PRIORITY={MAINTENANCE:10};",
  '../nexus/batch-layer.js':"export const NEXUS_BATCH_DOMAIN={REASONING:'reasoning'};export const structuredSidecarOptions=value=>value;",
  '../nexus/model-worker-bus.js':'export const enqueueNexusModelWorkerJob=(domain,stage,request)=>globalThis.keywordClosureDispatch(request);',
  '../observability/telemetry.js':'export const logEvent=()=>{};',
  './keyword-decision-site.js':"export const TREE_KEYWORD_SAFETY_SITE_ID='keyword';",
  '../decision/work-director-bridge.js':'export const startDecisionSiteThroughDirector=()=>null;',
  '../nexus/lore-source-revision.js':'export const currentNexusLoreSourceRevision=()=>1;',
 };
 globalThis.keywordClosureDispatch=request=>({promise:sidecarScheduler.execute({lane:'background',logicalStep:request.schedulerLogicalStep===true,scope:request.nexusScope,run:async()=>{
  calls++;pages.push(request.prompt.split('SCOPE\n')[1].split('\n\nCURRENT KEYWORDS')[0]);
  return {text:JSON.stringify({suggestions:Array.from({length:12},(_,i)=>({keyword:`keyword-${calls}-${i}`,confidence:90}))})};
 }})});
 const source=fs.readFileSync(url,'utf8').replace(/from '([^']+)'/g,(_,name)=>`from '${stubs[name]?data(stubs[name]):new URL(name,url).href}'`);
 try{
  const owner=await import(data(source)),result=await owner.suggestKeywords({book:'world',uid:1});
  assert.equal(pages.join(''),'TITLE: Source\nCONTENT:\n'+body);assert.ok(calls>1);assert.equal(result.suggestions.length,calls*12);assert.equal(result.coverage.complete,true);
 }finally{sidecarScheduler.clear();delete globalThis.keywordClosureDispatch;delete globalThis.keywordClosureFixture;}
});
