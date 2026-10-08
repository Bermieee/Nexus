import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildDecisionSiteRequest } from '../decision/site-registry.js';
import { validateDecisionRequest } from '../decision/contracts.js';
import {
  CHARACTER_TRACKING_POLICY,
  characterTrackingFields,
  characterStateFieldTrackingDomain,
} from '../memory/character-state-contract.js';
import {
  CHARACTER_STATE_PROPOSAL_AGREEMENT_SITE_ID,
  CHARACTER_STATE_PROPOSAL_AGREEMENT_MAX,
  CHARACTER_STATE_JEV_REVIEW_THRESHOLD,
  CHARACTER_STATE_JEV_AGREE_THRESHOLD,
  interpretCharacterStateProposalAgreement,
} from '../memory/character-decision-sites.js';

assert.deepEqual(Object.keys(CHARACTER_TRACKING_POLICY),['personality','relationships','status','goals','behavior'],'Tracking Policy must remain the five operator-facing intake domains');

const all=characterTrackingFields({});
assert.ok(all.includes('baseline.personality'));
assert.ok(all.includes('persistent.relationships'));
assert.ok(all.includes('persistent.goalsMotivations'));
assert.ok(all.includes('persistent.behaviorPatterns'));
assert.ok(all.includes('persistent.equipment'));
assert.ok(all.includes('temporary.injuries'));
assert.equal(all.includes('baseline.appearance'),false,'appearance is manual/card-import state, not Summary/chat tracked intake');
assert.equal(all.includes('baseline.identityBackground'),false,'identity/background is not silently learned without a Tracking Policy');
assert.equal(all.includes('persistent.backgroundDevelopments'),false,'background developments remain outside the five intake policies');

const relationsOnly=characterTrackingFields({personality:false,relationships:true,status:false,goals:false,behavior:false});
assert.deepEqual(relationsOnly,CHARACTER_TRACKING_POLICY.relationships.fields);
assert.equal(characterStateFieldTrackingDomain('persistent.relationships'),'relationships');
assert.equal(characterStateFieldTrackingDomain('persistent.behaviorPatterns'),'behavior');
assert.equal(characterStateFieldTrackingDomain('temporary.injuries'),'status');

const context={
  character:'Lili',
  sourceFingerprint:'character-agreement-v1',
  tracking:{personality:true,relationships:true,status:true,goals:true,behavior:true},
  allowedFields:all,
  source:{type:'summary',id:'m1',label:'Test Summary',fingerprint:'summary-v1'},
  sourceText:'Lili accepted a permanent quartermaster title and continues handling Familia logistics.',
  currentState:{'persistent.titlesStatusAffiliations':'Supporter'},
  proposals:[
    {field:'persistent.titlesStatusAffiliations',trackingDomain:'status',classification:'UPDATE',currentValue:'Supporter',proposedValue:'Quartermaster and supporter',reason:'Title changed',evidence:['Accepted permanent quartermaster title.']},
    {field:'persistent.behaviorPatterns',trackingDomain:'behavior',classification:'NEW',currentValue:'',proposedValue:'Habitually handles Familia logistics',reason:'Recurring pattern',evidence:['Continues handling Familia logistics.']},
  ],
};
const built=await buildDecisionSiteRequest(CHARACTER_STATE_PROPOSAL_AGREEMENT_SITE_ID,context);
assert.equal(built.request.mode,'assist');
assert.equal(built.site.metadata?.humanReviewFinal,true);
assert.equal(built.site.metadata?.authority,'never-approve-never-mutate');
assert.equal(built.request.providerPolicy?.fallbackEnabled,false,'agreement site must stay Jev/typed-decision only');
assert.equal(Object.keys(built.request.questions).length,context.proposals.length*3);
validateDecisionRequest(built.request);
assert.ok(CHARACTER_STATE_PROPOSAL_AGREEMENT_MAX>=context.proposals.length);
assert.ok(CHARACTER_STATE_JEV_REVIEW_THRESHOLD<CHARACTER_STATE_JEV_AGREE_THRESHOLD);

const answers={};
for(let i=1;i<=2;i+=1){
  answers[`proposal_${i}_supported`]={type:'noul',value:i===1?0.92:0.5};
  answers[`proposal_${i}_policy_fit`]={type:'noul',value:i===1?0.91:0.8};
  answers[`proposal_${i}_state_change`]={type:'noul',value:i===1?0.88:0.8};
}
const verdicts=interpretCharacterStateProposalAgreement({answers},context.proposals);
assert.equal(verdicts[0].status,'agreed');
assert.equal(verdicts[1].status,'uncertain');

const reviewSource=fs.readFileSync(new URL('../memory/character-state-review.js',import.meta.url),'utf8');
for(const required of [
  'characterTrackingFields',
  'validateReviewPayload(value, bank, allowedFields)',
  'CHARACTER_STATE_PROPOSAL_AGREEMENT_SITE_ID',
  'runDecisionSiteThroughDirector',
  'reviewRecentChatForCharacterState',
  'filtered: clone(filtered)',
]) assert.ok(reviewSource.includes(required),`review wiring missing: ${required}`);

const hostSource=fs.readFileSync(new URL('../nexus-ui-host.js',import.meta.url),'utf8');
for(const required of [
  'characterReview:Object.freeze',
  'getCharacterBanks',
  'getCharacterBankMemories',
  'CHARACTER_TRACKING_POLICY',
  'reviewRecentChatForCharacterState',
  'reviewSummaryForCharacterState',
  'approveCharacterStateProposal',
  'rejectCharacterStateProposal',
  'humanApprovalFinal:true',
]) assert.ok(hostSource.includes(required),`Character host binding missing: ${required}`);

const adapterSource=fs.readFileSync(new URL('../src/ui-core/wave13-operator-adapters.js',import.meta.url),'utf8');
for(const required of [
  'characterReviewState()',
  'updateCharacterTracking',
  'reviewRecentCharacterChat',
  'reviewCharacterSummary',
  'approveCharacterProposal',
  'rejectCharacterProposal',
  'humanApprovalFinal:true',
]) assert.ok(adapterSource.includes(required),`Character UI adapter missing: ${required}`);

const uiSource=fs.readFileSync(new URL('../src/ui-core/wave13-operator-surfaces.js',import.meta.url),'utf8');
for(const required of [
  'renderCharacterStateReviewRail',
  'Character State Review',
  'Review Recent Chat',
  'Review Summary',
  'Jev agreed',
  'Jev uncertain',
  'Jev unavailable',
  'nexus-character-review-rail',
  'nexus-character-review-row',
  "uiCharacterReviewRow:'true'",
  "label:'Approve'",
  "label:'Reject'",
  'memory.approveCharacterProposal',
  'memory.rejectCharacterProposal',
  'memory.reviewRecentCharacterChat',
  'memory.reviewCharacterSummary',
]) assert.ok(uiSource.includes(required),`Character UI Core wiring missing: ${required}`);
// The Memory rail item was retired: Character State review now lives in the World Tree workspace.
assert.ok(uiSource.includes("registry.update('world-tree'")&&uiSource.includes('renderMemoryOwnerSurface(body,{...ctx,memory})'),'Character review must stay reachable inside the World Tree workspace');
assert.ok(!uiSource.includes("['memory-product','memory']"),'there is no Memory rail workspace any more');
assert.ok(!uiSource.includes("id:'character-review'"),'Character Review must not become a separate workspace');
assert.ok(uiSource.includes('Manual review only.'),'UI must state the manual-review boundary');
assert.ok(uiSource.includes('you remain the final approval authority'),'UI must keep human approval explicit');

const uiCss=fs.readFileSync(new URL('../styles/ui-core-wave13.css',import.meta.url),'utf8');
for(const required of [
  'nexus-character-review-rail',
  'nexus-character-review-policy-card',
  'nexus-character-review-policy-rows',
  'nexus-character-review-row__actions',
  '@media(max-width:700px)',
]) assert.ok(uiCss.includes(required),`Character responsive UI Core contract missing: ${required}`);
assert.ok(!uiCss.includes('nexus-character-review-workspace'),'Character Review must remain inside the Memory section, not become a center workspace');

console.log('Character review policy: PASS', {
  trackedFields:all.length,
  agreementQuestions:Object.keys(built.request.questions).length,
  verdicts:verdicts.map(row=>row.status),
});
