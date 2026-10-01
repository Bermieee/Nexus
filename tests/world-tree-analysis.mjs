import test from 'node:test';
import assert from 'node:assert/strict';
import {NexusWorldTree} from '../world-tree/store.js';
import {readBuilderWorldContext,adaptWorldContextForBuilder2} from '../builder2/world-context.js';
import {Builder2Pipeline} from '../builder2/pipeline.js';
import {Builder2PlanStore,createInMemoryBuilder2PlanAdapter} from '../builder2/plan-store.js';
import {BUILDER2_PHASE} from '../builder2/contracts.js';
import {WorldTreeBuilderController} from '../builder2/world-controller.js';
const api=await import('../builder2/world-analysis.js').catch(()=>({}));

function fixture({ambiguous=false,gaps=false}={}){
  const tree=new NexusWorldTree();
  tree.upsertNode({id:'lore:A:1',kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'LORE',sourceIds:['A#1']},data:{book:'A',uid:1,label:'Alice'}});
  // Oversized ambiguity evidence stays outside Decision Site assistance; all
  // semantic work in this fixture comes from the offline model boundary below.
  const sources=[{
    book:'A',uid:1,fingerprint:'alice-v1',title:'Alice',keys:['Alice'],
    content:ambiguous?'Alice '.repeat(2000):'Alice leads the guild.',
  }];
  if(gaps)for(const uid of [2,3]){
    sources.push({book:'A',uid,fingerprint:'gap-'+uid,title:'New topic '+uid,content:('New topic '+uid+' ').repeat(2000)});
    tree.upsertNode({id:'lore:A:'+uid,kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'LORE',sourceIds:['A#'+uid]},data:{book:'A',uid,label:'New topic '+uid}});
  }
  const context=readBuilderWorldContext({worldTree:tree,chatId:'offline-chat',selectedSources:sources,authorizedSourceIds:sources.map(s=>'A#'+s.uid)});
  const adapter=createInMemoryBuilder2PlanAdapter(),store=new Builder2PlanStore(adapter);
  const semantic={
    analyzeSurveySlice:async({entries})=>({themes:[{themeId:'people',label:'People',purpose:'Character records',aliases:[],evidenceSourceKeys:entries.map(row=>row.sourceKey)}]}),
    planTaxonomy:async()=>({nodes:[{taxonId:'people',parentTaxonId:null,label:'People',purpose:'Character records',aliases:[],evidenceSourceKeys:['A#1'],origin:'builder',protection:'normal',entryPolicy:'allow',canonicalNodeId:null}],reason:'Offline known-good model response'}),
    consolidateGaps:async({gaps})=>({proposals:gaps.map((g,index)=>({proposalId:'new-'+index,label:'New category '+index,evidenceSourceKeys:[g.sourceKey],purpose:'Additional subject'}))}),
    classifySlice:async({entries})=>({classifications:entries.map(row=>gaps&&row.sourceKey!=='A#1'?{ref:row.ref,decision:'taxonomy_gap',candidates:[],reason:'New category required',confidence:.5}:ambiguous
      ?{ref:row.ref,decision:'ambiguous',candidates:[{taxonId:'people',confidence:.5},{taxonId:'existing:world:nexus',confidence:.5}],reason:'Human placement review required',confidence:.5}
      :{ref:row.ref,decision:'classified',taxonId:'people',candidates:[],reason:'Clear character placement',confidence:1})}),
  };
  const options={runtime:{director:{},coordinator:{}},semanticStore:store,pipelineFactory:input=>new Builder2Pipeline({...input,semantic}),contextReader:async()=>context};
  const readPlan=async()=>{
    const ids=await adapter.listRunIds();
    assert.equal(ids.length,1,'one durable semantic run owns the analysis');
    return store.read(ids[0]);
  };
  return {tree,context,store,semantic,options,readPlan};
}

test('world analysis excludes the WORLD root and reaches validated quality before review',async()=>{
  assert.equal(typeof api.analyzeWorldTreeContext,'function');
  const f=fixture(),before=f.tree.exportState();
  const result=await api.analyzeWorldTreeContext(f.context,{runId:'clean',mode:'EXTEND'},f.options);
  assert.equal(result.organization.groups.some(group=>group.id==='world:nexus'),false);
  assert.equal(result.organization.groups.length,1);
  assert.equal(result.organization.groups[0].label,'People');
  assert.equal(result.organization.groups[0].parentId,'world:nexus');
  assert.deepEqual(result.organization.placements,[{sourceId:'A#1',parentId:result.organization.groups[0].id}]);
  assert.deepEqual(result.coverage,[{sourceId:'A#1',disposition:'PLACED'}]);
  const plan=await f.readPlan();
  assert.equal(plan.phase,BUILDER2_PHASE.VALIDATION);
  assert.equal(plan.qualityReview?.report?.passed,true);
  assert.equal(plan.validation?.passed,true);
  assert.equal(plan.metadata.validateOnly,true);
  assert.equal(plan.metadata.commitEnvelope??null,null);
  assert.equal(plan.metadata.ledgerArtifact??null,null);
  assert.deepEqual(f.tree.exportState(),before,'semantic preview never changes the canonical world');
});

test('semantic ambiguity is returned for operator review, without granting publication authority',async()=>{
  assert.equal(typeof api.analyzeWorldTreeContext,'function');
  const f=fixture({ambiguous:true}),before=f.tree.exportState();
  const result=await api.analyzeWorldTreeContext(f.context,{runId:'ambiguous',mode:'EXTEND'},f.options);
  assert.equal(result.semanticReview.classifications.length,1);assert.equal(result.semanticReview.classifications[0].sourceKey,'A#1');assert.equal(result.organization,undefined);
  const plan=await f.readPlan();
  assert.notEqual(plan.phase,BUILDER2_PHASE.STAGED);
  assert.equal(plan.metadata.commitEnvelope??null,null);
  assert.deepEqual(f.tree.exportState(),before);
});

test('one ambiguous placement and two category proposals advance after explicit review without repeating model work',async()=>{
  const f=fixture({ambiguous:true,gaps:true}),before=f.tree.exportState();let calls=0;
  const classify=f.semantic.classifySlice;f.semantic.classifySlice=async input=>{calls++;return classify(input);};
  const pending=await api.analyzeWorldTreeContext(f.context,{runId:'mixed',mode:'EXTEND'},f.options),review=pending.semanticReview;
  assert.equal(review.classifications.length,1);assert.equal(review.proposals.length,2);
  const priorCalls=calls;
  const result=await api.analyzeWorldTreeContext(f.context,{runId:'mixed',mode:'EXTEND',review:{token:review.token,classificationDecisions:{'A#1':{action:'map',taxonId:'people'}},gapDecisions:Object.fromEntries(review.proposals.map(p=>[p.proposalId,{action:'approve'}]))}},f.options);
  assert.equal(result.coverage.length,3);assert.ok(result.coverage.every(row=>row.disposition==='PLACED'));assert.equal(result.organization.groups.length,3);
  assert.equal(calls,priorCalls);assert.equal((await f.readPlan()).validation.passed,true);assert.deepEqual(f.tree.exportState(),before);
});

test('pending placement decisions survive controller storage and cannot be applied before validated review',async()=>{
  const f=fixture({ambiguous:true,gaps:true}),records=new Map();let writes=0;
  const options={context:async()=>f.context,currentChatId:()=>f.context.scope.chatId,store:{read:async id=>structuredClone(records.get(id)),write:async record=>records.set(record.runId,structuredClone(record))},analysis:(context,input)=>api.analyzeWorldTreeContext(context,input,f.options),mutation:async()=>{writes++;return {state:'committed',worldRevision:1};},layout:{read:()=>({revision:0}),publish:async()=>({revision:1})}};
  const first=new WorldTreeBuilderController(options),pending=await first.start({sourceIds:f.context.sources.map(s=>s.sourceId),chatId:f.context.scope.chatId});
  assert.equal(pending.phase,'PLACEMENT_REVIEW');assert.equal(pending.plan,null);await assert.rejects(()=>first.apply(pending.runId),/approval/);assert.equal(writes,0);
  const second=new WorldTreeBuilderController(options),review=pending.semanticReview;
  const result=await second.resume(pending.runId,{review:{token:review.token,classificationDecisions:{'A#1':{action:'map',taxonId:'people'}},gapDecisions:Object.fromEntries(review.proposals.map(p=>[p.proposalId,{action:'approve'}]))}});
  assert.equal(result.phase,'REVIEW');assert.equal(writes,0);await second.approve(result.runId,{fingerprint:result.fingerprint,by:'operator'});assert.equal((await second.apply(result.runId)).phase,'COMMITTED');assert.equal(writes,1);
});

test('an explicit exclusion stays distinct from deferral and never removes authored sources',async()=>{
  const f=fixture({ambiguous:true,gaps:true}),before=f.tree.exportState();
  const pending=await api.analyzeWorldTreeContext(f.context,{runId:'dispositions',mode:'EXTEND'},f.options),review=pending.semanticReview;
  const result=await api.analyzeWorldTreeContext(f.context,{runId:'dispositions',mode:'EXTEND',review:{token:review.token,classificationDecisions:{'A#1':{action:'exclude'}},gapDecisions:{[review.proposals[0].proposalId]:{action:'defer'},[review.proposals[1].proposalId]:{action:'approve'}}}},f.options);
  assert.equal(result.coverage.find(row=>row.sourceId==='A#1').disposition,'EXCLUDED');
  assert.equal(result.coverage.find(row=>row.sourceId===review.proposals[0].evidenceSourceKeys[0]).disposition,'UNRESOLVED');
  assert.equal(result.coverage.find(row=>row.sourceId===review.proposals[1].evidenceSourceKeys[0]).disposition,'PLACED');
  assert.deepEqual(f.tree.exportState(),before);
});

test('placement review rejects a stale token or changed source before granting a preview',async()=>{
  const f=fixture({ambiguous:true});const pending=await api.analyzeWorldTreeContext(f.context,{runId:'stale-token',mode:'EXTEND'},f.options);
  await assert.rejects(()=>api.analyzeWorldTreeContext(f.context,{runId:'stale-token',mode:'EXTEND',review:{token:'wrong-token',classificationDecisions:{'A#1':{action:'map',taxonId:'people'}}}},f.options),/token|stale/i);
  const records=new Map(),context=structuredClone(f.context);let analysisCalls=0;
  const controller=new WorldTreeBuilderController({context:async()=>context,currentChatId:()=>context.scope.chatId,store:{read:async id=>structuredClone(records.get(id)),write:async r=>records.set(r.runId,structuredClone(r))},analysis:async()=>{analysisCalls++;return pending;},mutation:async()=>{throw Error('Must not write');},layout:{read:()=>({revision:0}),publish:()=>{throw Error('Must not publish');}}});
  const run=await controller.start({sourceIds:['A#1'],chatId:context.scope.chatId});context.sourceFence+='-edited';
  await assert.rejects(()=>controller.resume(run.runId,{review:{token:run.semanticReview.token,classificationDecisions:{'A#1':{action:'map',taxonId:'people'}}}}),/stale/i);assert.equal(analysisCalls,1);
});

test('an edited source allocates new semantic analysis and reaches a fresh review',async()=>{
  const f=fixture({ambiguous:true}),records=new Map();let context=f.context;
  const controller=new WorldTreeBuilderController({context:async()=>context,currentChatId:()=>context.scope.chatId,store:{read:async id=>structuredClone(records.get(id)),write:async r=>records.set(r.runId,structuredClone(r))},analysis:(ctx,input)=>api.analyzeWorldTreeContext(ctx,input,{...f.options,contextReader:async()=>context}),mutation:async()=>{throw Error('Must not write');},layout:{read:()=>({revision:0}),publish:()=>{throw Error('Must not publish');}}});
  const pending=await controller.start({sourceIds:['A#1'],chatId:context.scope.chatId});assert.equal(pending.phase,'PLACEMENT_REVIEW');
  context=structuredClone(context);context.sources[0].content+=' Edited.';context.sources[0].fingerprint='alice-v2';context.sourceFence+='-edited';
  const refreshed=await controller.resume(pending.runId);assert.equal(refreshed.phase,'PLACEMENT_REVIEW');assert.notEqual(refreshed.semanticReview.semanticRunId,pending.semanticReview.semanticRunId);
  const preview=await controller.resume(pending.runId,{review:{token:refreshed.semanticReview.token,classificationDecisions:{'A#1':{action:'map',taxonId:'people'}}}});assert.equal(preview.phase,'REVIEW');
});

test('retry after accepted review and preview failure retains exact choices and rejects changed choices',async()=>{
  const f=fixture({ambiguous:true}),records=new Map();let failLayout=false;
  const controller=new WorldTreeBuilderController({context:async()=>f.context,currentChatId:()=>f.context.scope.chatId,store:{read:async id=>structuredClone(records.get(id)),write:async r=>records.set(r.runId,structuredClone(r))},analysis:(ctx,input)=>api.analyzeWorldTreeContext(ctx,input,f.options),mutation:async()=>{throw Error('Must not write');},layout:{read:()=>{if(failLayout)throw Error('Temporary preview storage failure');return {revision:0};},publish:()=>{throw Error('Must not publish');}}});
  const pending=await controller.start({sourceIds:['A#1'],chatId:f.context.scope.chatId}),review={token:pending.semanticReview.token,classificationDecisions:{'A#1':{action:'map',taxonId:'people'}}};failLayout=true;
  await assert.rejects(()=>controller.resume(pending.runId,{review}),/Temporary preview/);failLayout=false;
  await assert.rejects(()=>controller.resume(pending.runId,{review:{...review,classificationDecisions:{'A#1':{action:'defer'}}}}),/saved accepted review/);
  await assert.rejects(()=>controller.resume(pending.runId,{review:{...review,token:'wrong'}}),/saved accepted review/);
  const preview=await controller.resume(pending.runId,{review});assert.equal(preview.phase,'REVIEW');assert.equal(preview.coverage[0].disposition,'PLACED');
});

test('a legacy paused record resumes in a fresh semantic revision instead of reopening stale analysis',async()=>{
  const f=fixture({ambiguous:true});await api.analyzeWorldTreeContext(f.context,{runId:'legacy',mode:'EXTEND'},f.options);
  const context=structuredClone(f.context);context.sources[0].content+=' Edited';context.sources[0].fingerprint='v2';context.sourceFence+='v2';
  const records=new Map([['legacy',{runId:'legacy',phase:'ANALYSIS_PAUSED',planRevision:0,recordRevision:1,sourceIds:['A#1'],chatId:context.scope.chatId,mode:'EXTEND',plan:null}]]);
  const controller=new WorldTreeBuilderController({context:async()=>context,currentChatId:()=>context.scope.chatId,store:{read:async id=>structuredClone(records.get(id)),write:async r=>records.set(r.runId,structuredClone(r))},analysis:(ctx,input)=>api.analyzeWorldTreeContext(ctx,input,{...f.options,contextReader:async()=>context}),mutation:async()=>{throw Error('Must not write');},layout:{read:()=>({revision:0}),publish:()=>{throw Error('Must not publish');}}});
  const recovered=await controller.resume('legacy');assert.equal(recovered.phase,'PLACEMENT_REVIEW');assert.equal(recovered.semanticReview.semanticRunId,'legacy:analysis:2');
});

test('resumed semantic quality blockers prevent World proposal materialization',async()=>{
  assert.equal(typeof api.analyzeWorldTreeContext,'function');
  const f=fixture(),adapted=adaptWorldContextForBuilder2(f.context),semanticRun='blocked:analysis:1';
  const pipeline=new Builder2Pipeline({store:f.store,semantic:f.semantic,contextLoader:async()=>adapted});
  const step=await pipeline.startWorldContext(f.context,{runId:semanticRun,metadata:{reviewFlow:'consolidated'}});
  await f.store.transition(semanticRun,BUILDER2_PHASE.QUALITY_REVIEW,{
    classifications:step.plan.classifications.map(row=>({...row,taxonId:'existing:world:nexus'})),
    qualityReview:{report:{passed:false,blockers:[{blockerId:'container:A#1',type:'container-only-attachment'}]},status:'blocked'},
  });
  await assert.rejects(()=>api.analyzeWorldTreeContext(f.context,{runId:'blocked',mode:'EXTEND'},f.options),
    /quality|block|review.*required|requires.*review/i);
  const plan=await f.readPlan();
  assert.equal(plan.qualityReview.report.passed,false);
  assert.equal(plan.structuralPlan,null);
  assert.equal(plan.metadata.commitEnvelope??null,null);
});

test('successful resumed analysis clears the previous paused failure',async()=>{
  assert.equal(typeof api.analyzeWorldTreeContext,'function');
  const f=fixture(),records=new Map();let unavailable=true;
  const controller=new WorldTreeBuilderController({
    context:async()=>f.context,currentChatId:()=>f.context.scope.chatId,
    store:{read:async id=>structuredClone(records.get(id)??null),write:async record=>records.set(record.runId,structuredClone(record))},
    analysis:async(context,input)=>{
      if(unavailable)throw Error('Offline provider unavailable');
      return api.analyzeWorldTreeContext(context,input,f.options);
    },
    mutation:async()=>{throw Error('Review must not commit');},
    layout:{read:async()=>({revision:0}),publish:async()=>{throw Error('Review must not publish');}},
  });
  const paused=await controller.start({sourceIds:['A#1'],chatId:f.context.scope.chatId});
  assert.equal(paused.phase,'ANALYSIS_PAUSED');
  assert.equal(paused.error,'Offline provider unavailable');
  unavailable=false;
  const resumed=await controller.resume(paused.runId);
  assert.equal(resumed.phase,'REVIEW');
  assert.equal(resumed.error,null);
  assert.equal(resumed.plan.layout.proposed.coverage.complete,true);
});
