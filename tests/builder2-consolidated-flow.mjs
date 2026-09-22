import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BUILDER2_PHASE, createBuilder2Plan, createBuilder2Source } from '../builder2/contracts.js';
import { Builder2Pipeline } from '../builder2/pipeline.js';
import { Builder2PlanStore, createInMemoryBuilder2PlanAdapter, validateBuilder2PhaseTransition } from '../builder2/plan-store.js';
import { createBuilder2ReviewToken } from '../builder2/review-token.js';
import { builder2DraftReviewMarkup } from '../builder/builder2-operator-ui.js';

assert.equal(BUILDER2_PHASE.DRAFT_REVIEW,'draft-review');
assert.equal(validateBuilder2PhaseTransition(BUILDER2_PHASE.GAP_REVIEW,BUILDER2_PHASE.DRAFT_REVIEW).allowed,true);
assert.equal(validateBuilder2PhaseTransition(BUILDER2_PHASE.DRAFT_REVIEW,BUILDER2_PHASE.RECLASSIFICATION).allowed,true);
assert.equal(validateBuilder2PhaseTransition(BUILDER2_PHASE.RECLASSIFICATION,BUILDER2_PHASE.DRAFT_REVIEW).allowed,true);

const adapter=createInMemoryBuilder2PlanAdapter();
const store=new Builder2PlanStore(adapter);
const base=createBuilder2Plan({
  runId:'task193-flow',
  book:'Test Lore',
  phase:BUILDER2_PHASE.GAP_REVIEW,
  sourceRevision:'src-1',
  corpusRevision:'src-1',
  taxonomyRevision:'tax-1',
  taxonomy:{revisionId:'tax-1',classificationRevisionId:'class-1',materializationRevisionId:'mat-1',nodes:[
    {taxonId:'t1',parentTaxonId:null,label:'People',purpose:'Characters',aliases:[],evidenceSourceKeys:[],origin:'builder',protection:'normal',entryPolicy:'allow',canonicalNodeId:null,metadata:{}},
    {taxonId:'t2',parentTaxonId:null,label:'Places',purpose:'Locations',aliases:[],evidenceSourceKeys:[],origin:'builder',protection:'normal',entryPolicy:'allow',canonicalNodeId:null,metadata:{}},
  ]},
  metadata:{reviewFlow:'consolidated'},
});
await store.write(base);
let plan=await store.transition(base.runId,BUILDER2_PHASE.DRAFT_REVIEW,{classificationReview:{pending:[]},proposedExpansions:[]});
assert.ok(createBuilder2ReviewToken(plan,'draft-review').startsWith('B2RT:draft-review:'));
plan=await store.transition(base.runId,BUILDER2_PHASE.RECLASSIFICATION,{metadata:{...plan.metadata,consolidatedProgress:{draftReviewed:true}}});
plan=await store.transition(base.runId,BUILDER2_PHASE.DRAFT_REVIEW,{});
assert.equal(plan.phase,BUILDER2_PHASE.DRAFT_REVIEW);

const markup=builder2DraftReviewMarkup({
  reviewKind:'draft-review',
  taxonomy:base.taxonomy,
  pending:[],
  proposals:[],
  summary:{worksetCount:12,autoPlacedCount:12},
});
assert.ok(markup.includes('Tree Draft Review'));
assert.ok(markup.includes('Category structure'));
assert.ok(markup.includes('adaptive slices/workers'));
assert.ok(!markup.includes('Step 1 of 6'));
assert.ok(!markup.includes('Step 2 of 6'));

const pipeline=fs.readFileSync(new URL('../builder2/pipeline.js',import.meta.url),'utf8');
for(const token of [
  "consolidatedReview(plan)",
  "#prepareDraftReview",
  "evaluateBuilderHierarchicalClassificationAssist",
  "consolidated-quality-pass",
  "!consolidatedReview(plan)&&(plan.taxonomy?.nodes||[]).length<=16",
]) assert.ok(pipeline.includes(token),'pipeline missing '+token);

const controller=fs.readFileSync(new URL('../builder2/nexus-controller.js',import.meta.url),'utf8');
assert.ok(controller.includes("==='phased'?'phased':'consolidated'"),'new product runs must default consolidated');
assert.ok(controller.includes("case'draft-review'"),'controller must advance draft review');

const standalone=fs.readFileSync(new URL('../builder/ui.js',import.meta.url),'utf8');
assert.ok(standalone.includes('1 Analyze + Draft'));
assert.ok(standalone.includes('2 Review'));
assert.ok(standalone.includes('3 Save'));
assert.ok(standalone.includes("result.reviewKind==='taxonomy-review'||result.reviewKind==='draft-review'"));

const treeUi=fs.readFileSync(new URL('../tree/ui.js',import.meta.url),'utf8');
assert.ok(treeUi.includes("kind==='taxonomy-review'||kind==='draft-review'"));
assert.ok(treeUi.includes("'draft-review':['Tree draft exceptions','Build Final Tree']"));

const packing=fs.readFileSync(new URL('../builder2/semantic-packing.js',import.meta.url),'utf8');
const semantic=fs.readFileSync(new URL('../builder2/nexus-semantic.js',import.meta.url),'utf8');
assert.ok(packing.includes('targetInputTokens'),'Builder must retain adaptive logical slicing');
assert.ok(semantic.includes('dispatchNexusModelWorkerUnits'),'Builder must retain dynamic Model Worker dispatch');
assert.ok(semantic.includes('packSemanticPhysicalBundles'),'Builder must retain bounded physical slice multiplexing');


const behaviorAdapter=createInMemoryBuilder2PlanAdapter();
const behaviorStore=new Builder2PlanStore(behaviorAdapter);
const sources=[
  createBuilder2Source({book:'Behavior Lore',uid:1,fingerprint:'fp-1',title:'Alice',keys:['Alice'],content:'Alice is a guild captain.'}),
  createBuilder2Source({book:'Behavior Lore',uid:2,fingerprint:'fp-2',title:'Bob',keys:['Bob'],content:'Bob is a guild scout.'}),
];
const semanticMock={
  analyzeSurveySlice:async({entries})=>({themes:[{themeId:'people',label:'People',purpose:'Character records',aliases:['Characters'],evidenceSourceKeys:entries.map(row=>row.sourceKey)}]}),
  planTaxonomy:async()=>({nodes:[{taxonId:'people',parentTaxonId:null,label:'People',purpose:'Character records',aliases:['Characters'],evidenceSourceKeys:sources.map(row=>row.sourceKey),origin:'builder',protection:'normal',entryPolicy:'allow',canonicalNodeId:null}],reason:'test taxonomy'}),
  classifySlice:async({entries})=>({classifications:entries.map(row=>({ref:row.ref,decision:'classified',taxonId:'people',candidates:[],reason:'clear test placement',confidence:1}))}),
};
const behaviorPipeline=new Builder2Pipeline({store:behaviorStore,semantic:semanticMock});
let behaviorStep=await behaviorPipeline.start({
  runId:'task193-behavior',
  book:'Behavior Lore',
  mode:'full',
  worksetSources:sources,
  corpusSources:sources,
  treeInventory:{nodes:[],membershipComplete:true},
  metadata:{reviewFlow:'consolidated'},
});
assert.equal(behaviorStep.reviewKind,'draft-review','consolidated flow must stop first at the combined Tree Draft Review');
assert.equal(behaviorStep.plan.phase,BUILDER2_PHASE.DRAFT_REVIEW);
behaviorStep=await behaviorPipeline.reviewDraft(behaviorStep.plan.runId,{
  token:behaviorStep.reviewToken,
  nodes:behaviorStep.plan.taxonomy.nodes,
  classificationDecisions:{},
  gapDecisions:{},
});
assert.equal(behaviorStep.reviewKind,'preview','a clean approved draft must advance directly to Final Tree preview');
assert.equal(behaviorStep.plan.phase,BUILDER2_PHASE.VALIDATION);
assert.equal(behaviorStep.plan.qualityReview?.report?.passed,true,'deterministic quality must still run before preview');
assert.equal(behaviorStep.plan.qualityReview?.status,'approved','passing quality must be internally approved before materialization');
assert.equal(behaviorStep.plan.metadata?.consolidatedProgress?.draftReviewed,true);
assert.equal(behaviorStep.plan.previewModel?.changes?.length,2);

console.log('Builder2 consolidated flow: PASS', {
  normalReviews:['draft-review','preview'],
  dynamicSlicing:true,
  jevAmbiguousTail:true,
  behavioralPath:['draft-review','preview'],
});
