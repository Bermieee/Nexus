import test from 'node:test';
import assert from 'node:assert/strict';
import {NexusBuilder2SemanticAdapter} from '../builder2/nexus-semantic.js';

for(const bookAuthoring of [true,false])test(`single and batched Builder model work use ${bookAuthoring?'book-independent':'chat'} scope`,async()=>{
  const plan={runId:'scope-test',book:'A',planRevision:1,phase:'survey',metadata:{semanticResource:'model-worker',...(bookAuthoring?{authoringBook:'A'}:{})}},requests=[],batches=[];
  const response={themes:[{label:'People',purpose:'Character records',evidenceRefs:['R1']}],notes:''};
  const runtime={director:{buildRequestedPlan:p=>({...p,id:'offline-plan'})},coordinator:{run:async(p,{executors})=>({jobs:[{state:'succeeded',result:{value:await executors[p.jobs[0].type](p.jobs[0],p,{})}}]})}};
  const adapter=new NexusBuilder2SemanticAdapter({runtime,runId:plan.runId,store:{read:async()=>structuredClone(plan),transition:async(_id,_phase,patch)=>Object.assign(plan,patch)},
    enqueue:(_domain,_stage,options)=>{requests.push(options);return {promise:Promise.resolve({text:JSON.stringify(response)}),meta:{assignedSlot:'A'}};},
    runBatch:async options=>{batches.push(options);return {completed:options.items.map((item,index)=>({unit:{item,index},value:options.parse(JSON.stringify(response),item)})),failed:[]};},semanticPacking:{multiplexTaxonomy:false}});
  const entries=[{ref:'R1',sourceKey:'A#1',title:'Alice',keys:[],content:'Alice leads the guild.'}];
  await adapter.analyzeSurveySlice({entries});await adapter.analyzeSurveySlices({slices:[{entries}]});
  const expected=bookAuthoring?'independent':'chat';assert.equal(requests[0].scopeKind,expected);assert.equal(batches[0].scopeKind,expected);assert.equal(batches[0].buildRequest(batches[0].items[0]).scopeKind,expected);
});
