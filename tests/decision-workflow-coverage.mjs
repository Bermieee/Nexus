import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildDecisionSiteRequest, listDecisionSites } from '../decision/site-registry.js';
import { validateDecisionRequest } from '../decision/contracts.js';
import { CHARACTER_STATE_REVIEW_PREFLIGHT_SITE_ID } from '../memory/character-decision-sites.js';
import { SMART_CONTEXT_WARM_REVIEW_SITE_ID, SMART_CONTEXT_DECISION_MAX_CANDIDATES } from '../smart-context/decision-site.js';
import { UID_SUMMARY_DRAFT_REVIEW_SITE_ID } from '../lore/uid-decision-site.js';
import { TREE_KEYWORD_SAFETY_SITE_ID } from '../tree/keyword-decision-site.js';
import { PROPOSAL_REVIEW_TRIAGE_SITE_ID } from '../proposals/decision-site.js';
import { MAINTENANCE_FINDING_TRIAGE_SITE_ID } from '../maintenance/decision-site.js';

const cases=[
  [CHARACTER_STATE_REVIEW_PREFLIGHT_SITE_ID,{character:'Lili',sourceFingerprint:'char-v1',sourceText:'Lili accepted a permanent quartermaster title.',currentState:{},pendingFields:[]}],
  [SMART_CONTEXT_WARM_REVIEW_SITE_ID,{sourceFingerprint:'warm-v1',sceneNeed:'Forge repair scene',warmBudget:2,candidates:Array.from({length:SMART_CONTEXT_DECISION_MAX_CANDIDATES+3},(_,i)=>({book:'Lore',uid:i+1,title:`Candidate ${i+1}`,summary:'bounded lore candidate',score:100-i}))}],
  [UID_SUMMARY_DRAFT_REVIEW_SITE_ID,{sourceFingerprint:'uid-v1',sourceIdentity:{book:'Lore',uid:7},sourceDigest:'Durable source canon.',drafts:[{profile:'Lean',summary:'Lean draft',keywords:['lean']},{profile:'Balanced',summary:'Balanced draft',keywords:['balanced']},{profile:'Heavy',summary:'Heavy draft',keywords:['heavy']}]}],
  [TREE_KEYWORD_SAFETY_SITE_ID,{sourceFingerprint:'kw-v1',book:'Lore',uid:7,title:'Hestia Familia',content:'Familia details',candidates:[{keyword:'Hestia Familia',collisionCount:0},{keyword:'family',collisionCount:21}]}],
  [PROPOSAL_REVIEW_TRIAGE_SITE_ID,{sourceFingerprint:'prop-v1',proposals:[{id:'p1',status:'pending',source:'postturn',op:{type:'entry.update',book:'Lore',uid:7,content:'x'}},{id:'p2',status:'pending',source:'summary',op:{type:'entry.create',book:'Lore',content:'y'}}]}],
  [MAINTENANCE_FINDING_TRIAGE_SITE_ID,{sourceFingerprint:'maint-v1',findings:[{id:'f1',kind:'duplicate',title:'Possible duplicate',evidence:'Two entries strongly overlap.'},{id:'f2',kind:'keyword',title:'Broad keyword',evidence:'Common keyword activates many entries.'}]}],
];

for(const [siteId,context] of cases){
  const {site,request}=await buildDecisionSiteRequest(siteId,context);
  assert.equal(request.mode,'shadow',`${siteId} must default shadow`);
  assert.ok(request.sourceFingerprint,`${siteId} needs source fingerprint`);
  assert.ok(Object.keys(request.questions).length>0,`${siteId} needs typed questions`);
  validateDecisionRequest(request);
  assert.equal(site.metadata?.shadowOnly,true,`${siteId} must declare shadowOnly`);
  assert.notEqual(site.metadata?.authority,'mutation',`${siteId} cannot own mutation authority`);
}
const ids=new Set(listDecisionSites().map(row=>row.id));
for(const [siteId] of cases)assert.ok(ids.has(siteId),`registered: ${siteId}`);

const warm=(await buildDecisionSiteRequest(SMART_CONTEXT_WARM_REVIEW_SITE_ID,cases[1][1])).request;
assert.equal(warm.state.candidates.length,SMART_CONTEXT_DECISION_MAX_CANDIDATES,'warm site must bound candidate state');
assert.equal(Object.keys(warm.questions).length,SMART_CONTEXT_DECISION_MAX_CANDIDATES*2,'warm question count must match bounded candidate set');

console.log('Decision workflow coverage: PASS',cases.length,'sites');


const wiring=[
  ['memory/character-state-review.js','CHARACTER_STATE_REVIEW_PREFLIGHT_SITE_ID'],
  ['smart-context/warmer.js','SMART_CONTEXT_WARM_REVIEW_SITE_ID'],
  ['lore/uid-summarizer.js','UID_SUMMARY_DRAFT_REVIEW_SITE_ID'],
  ['tree/keyword-advisor.js','TREE_KEYWORD_SAFETY_SITE_ID'],
  ['proposals/ui.js','PROPOSAL_REVIEW_TRIAGE_SITE_ID'],
  ['maintenance/housekeeper.js','MAINTENANCE_FINDING_TRIAGE_SITE_ID'],
];
for(const [path,siteId] of wiring){
  const source=fs.readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
  assert.ok(source.includes(siteId),`${path} must reference ${siteId}`);
  assert.ok(source.includes('startDecisionSiteThroughDirector'),`${path} must route shadow work through Work Director`);
}
assert.ok(fs.readFileSync(new URL('../lore/uid-summarizer.js',import.meta.url),'utf8').includes('uidSourceIdentity(liveEntry,Number(uid))'),'UID draft freshness must fingerprint the live entry with the correct signature');
console.log('Decision workflow wiring: PASS',wiring.length,'subsystems');
