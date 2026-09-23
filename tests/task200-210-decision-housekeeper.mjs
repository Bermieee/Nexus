import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDecisionFreshnessContract, decisionFreshnessSnapshot, diffDecisionFreshness } from '../decision/freshness.js';
import { DECISION_PROVIDER_CLASS } from '../decision/constants.js';
import { interpretMaintenanceFindingTriage } from '../maintenance/decision-site.js';

const buildCanonicalInput=context=>({
  revisions:{chat:String(context.chatRevision||''),source:String(context.sourceRevision||'')},
  material:{need:String(context.need||''),rows:(context.rows||[]).map(row=>({id:String(row.id),text:String(row.text||'')}))},
});
const contract=createDecisionFreshnessContract({siteId:'test.freshness',buildCanonicalInput});
const initialContext={chatRevision:'chat-7',sourceRevision:'lore-9',need:'same need',rows:[{id:'1',text:'same evidence'}]};
const initial=contract.getInitial(initialContext);
const same=await contract.getCurrent({...initialContext,readCurrentFreshnessContext:()=>({...initialContext})});
assert.equal(initial.fingerprint,same.fingerprint,'unchanged raw inputs must not false-stale');

const reorderedA=decisionFreshnessSnapshot('test.order',{revisions:{b:'2',a:'1'},material:{z:2,a:1}});
const reorderedB=decisionFreshnessSnapshot('test.order',{revisions:{a:'1',b:'2'},material:{a:1,z:2}});
assert.equal(reorderedA.fingerprint,reorderedB.fingerprint,'object key order must canonicalize');

const changedRevision=decisionFreshnessSnapshot('test.freshness',{revisions:{chat:'chat-8',source:'lore-9'},material:{need:'same need',rows:[{id:'1',text:'same evidence'}]}});
const revisionDiff=diffDecisionFreshness(initial,changedRevision);
assert.equal(revisionDiff.changed,true);
assert.equal(revisionDiff.materialChanged,false,'revision-only changes must be identified separately from material changes');
assert.deepEqual(revisionDiff.revisionChanges.map(row=>row.key),['chat']);

const changedMaterial=decisionFreshnessSnapshot('test.freshness',{revisions:{chat:'chat-7',source:'lore-9'},material:{need:'changed need',rows:[{id:'1',text:'same evidence'}]}});
const materialDiff=diffDecisionFreshness(initial,changedMaterial);
assert.equal(materialDiff.changed,true);
assert.equal(materialDiff.materialChanged,true);
assert.equal(materialDiff.revisionChanges.length,0);

const findings=[{id:'f1',category:'MERGE_CANDIDATE'},{id:'f2',category:'OVERSIZED'}];
const answer=(value,confidence=0.9)=>({value,confidence});
const triaged=interpretMaintenanceFindingTriage({
  ok:true,stale:false,providerClass:DECISION_PROVIDER_CLASS.TYPED_DECISION,provider:'jev',
  answers:{
    finding_1_priority:answer(3),finding_1_semantic_review:answer(0.1),finding_1_route:answer('DETERMINISTIC'),
    finding_2_priority:answer(2),finding_2_semantic_review:answer(0.8),finding_2_route:answer('SIDECAR'),
  },
},findings);
assert.equal(triaged.handled,true);
assert.equal(triaged.rows[0].sidecarRequired,false,'confident deterministic triage may skip redundant Sidecar review');
assert.equal(triaged.rows[1].sidecarRequired,true,'SIDECAR route must retain generative review');

const uncertain=interpretMaintenanceFindingTriage({
  ok:true,stale:false,providerClass:DECISION_PROVIDER_CLASS.TYPED_DECISION,
  answers:{finding_1_priority:answer(2,0.2),finding_1_semantic_review:answer(0.2,0.2),finding_1_route:answer('OPERATOR',0.2)},
},findings.slice(0,1));
assert.equal(uncertain.rows[0].sidecarRequired,true,'low-confidence Jev must fail open');
assert.equal(interpretMaintenanceFindingTriage({ok:false,stale:true},findings).handled,false,'stale Jev cannot own triage');

const housekeeper=fs.readFileSync(new URL('../maintenance/housekeeper.js',import.meta.url),'utf8');
for(const required of [
  'runDecisionSiteThroughDirector',
  'Promise.all(workers)',
  'housekeeper-triage-complete',
  "sidecarSkipReason='decision-triage-resolved-without-sidecar'",
  'allowedFindingIds',
  'sidecarFindings.map(sidecarFindingPacket)',
  'readCurrentFreshnessContext',
])assert.ok(housekeeper.includes(required),`Housekeeper #200 wiring missing: ${required}`);
assert.ok(!housekeeper.includes('evaluateHousekeeperMergeAssist'),'Housekeeper must not run per-pair Jev before canonical triage');
assert.ok(!housekeeper.includes('evaluateHousekeeperSemanticOverloadAssist'),'Housekeeper must not run per-entry overload Jev before canonical triage');
assert.ok(!housekeeper.includes('maintenance-finding-triage-shadow'),'redundant shadow triage must be removed');
assert.ok(!housekeeper.includes('bookReport.mergeCandidates = bookReport.mergeCandidates.filter'),'Jev may not delete deterministic findings');
assert.ok(housekeeper.indexOf('housekeeper-early-reuse-hit')<housekeeper.indexOf('report.canonicalReadCounts.memory+=1'),'#201 early reuse must remain before canonical reads');
assert.ok(housekeeper.includes('scanBook(book,settings,{sourceData:data,sourceTree:tree})')||housekeeper.includes('scanBook(book, settings, { sourceData: data, sourceTree: tree })'),'#201 deduplicated lore/Tree reads must remain');

const maintenance=fs.readFileSync(new URL('../maintenance/decision-site.js',import.meta.url),'utf8');
for(const required of ["authority:'triage-only'","canonicalMutation:false","humanReviewFinal:true","providerPolicy:{fallbackEnabled:false","freshness:MAINTENANCE_FRESHNESS"])assert.ok(maintenance.includes(required),`Maintenance authority fence missing: ${required}`);

const promoted=[
  '../retrieval/decision-sites.js',
  '../smart-context/decision-site.js',
  '../memory/character-decision-sites.js',
  '../memory/decision-sites.js',
  '../maintenance/housekeeper-decision-site.js',
  '../maintenance/decision-site.js',
].map(path=>fs.readFileSync(new URL(path,import.meta.url),'utf8'));
for(const source of promoted)assert.ok(source.includes('createDecisionFreshnessContract'),'promoted Decision sites must use the shared canonical freshness contract');
assert.ok(!promoted[1].includes('resolveDecisionFingerprint'),'Smart Context must not use an ad hoc final fingerprint formatter');
assert.ok(!promoted[2].includes('resolveDecisionFingerprint'),'Character State must not use an ad hoc final fingerprint formatter');

const telemetry=fs.readFileSync(new URL('../decision/telemetry.js',import.meta.url),'utf8');
assert.ok(telemetry.includes('staleDetails'),'stale telemetry must explain revision/material changes');
assert.ok(telemetry.includes('materialFingerprint'),'telemetry must expose bounded material identity without source text');
assert.ok(!/sourceFreshness\.material\b/.test(telemetry),'telemetry must not export canonical source material');

console.log('Tasks #200/#210 Housekeeper triage + canonical freshness: PASS');
