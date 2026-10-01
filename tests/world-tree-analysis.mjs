import test from 'node:test';
import assert from 'node:assert/strict';
import {NexusWorldTree} from '../world-tree/store.js';
import {readBuilderWorldContext,adaptWorldContextForBuilder2} from '../builder2/world-context.js';
import {Builder2Pipeline} from '../builder2/pipeline.js';
import {Builder2PlanStore,createInMemoryBuilder2PlanAdapter} from '../builder2/plan-store.js';
import {BUILDER2_PHASE} from '../builder2/contracts.js';
import {WorldTreeBuilderController} from '../builder2/world-controller.js';
const api=await import('../builder2/world-analysis.js').catch(()=>({}));

function fixture({ambiguous=false}={}){
  const tree=new NexusWorldTree();
  tree.upsertNode({id:'lore:A:1',kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'LORE',sourceIds:['A#1']},data:{book:'A',uid:1,label:'Alice'}});
  // Oversized ambiguity evidence stays outside Decision Site assistance; all
  // semantic work in this fixture comes from the offline model boundary below.
  const context=readBuilderWorldContext({worldTree:tree,chatId:'offline-chat',selectedSources:[{
    book:'A',uid:1,fingerprint:'alice-v1',title:'Alice',keys:['Alice'],
    content:ambiguous?'Alice '.repeat(2000):'Alice leads the guild.',
  }],authorizedSourceIds:['A#1']});
  const adapter=createInMemoryBuilder2PlanAdapter(),store=new Builder2PlanStore(adapter);
  const semantic={
    analyzeSurveySlice:async({entries})=>({themes:[{themeId:'people',label:'People',purpose:'Character records',aliases:[],evidenceSourceKeys:entries.map(row=>row.sourceKey)}]}),
    planTaxonomy:async()=>({nodes:[{taxonId:'people',parentTaxonId:null,label:'People',purpose:'Character records',aliases:[],evidenceSourceKeys:['A#1'],origin:'builder',protection:'normal',entryPolicy:'allow',canonicalNodeId:null}],reason:'Offline known-good model response'}),
    classifySlice:async({entries})=>({classifications:entries.map(row=>ambiguous
      ?{ref:row.ref,decision:'ambiguous',candidates:[{taxonId:'people',confidence:.5}],reason:'Human placement review required',confidence:.5}
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

test('unresolved semantic ambiguity cannot become an approvable World proposal',async()=>{
  assert.equal(typeof api.analyzeWorldTreeContext,'function');
  const f=fixture({ambiguous:true}),before=f.tree.exportState();
  await assert.rejects(()=>api.analyzeWorldTreeContext(f.context,{runId:'ambiguous',mode:'EXTEND'},f.options),
    /unresolved|ambig|review.*required|requires.*review/i);
  const plan=await f.readPlan();
  assert.notEqual(plan.phase,BUILDER2_PHASE.STAGED);
  assert.equal(plan.metadata.commitEnvelope??null,null);
  assert.deepEqual(f.tree.exportState(),before);
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
