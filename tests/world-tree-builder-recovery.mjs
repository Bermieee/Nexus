import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverUnappliedWorldBuild} from '../builder2/world-commit-recovery.js';
import {getNexusLedger,inspectNexusCommitJournal} from '../nexus/transaction-service.js';
import {beginNexusCommitIntent,updateNexusCommitIntentPhase,markNexusCommitIntentApplied,resetNexusCommitJournalForTests} from '../nexus/commit-journal.js';
import {acquireNexusMutationResources} from '../nexus/mutation-lock.js';

const plan={runId:'approved-run',binding:{kind:'lorebook',book:'A'},review:{approvedFingerprint:'reviewed'}};
const resources=['lore:A','tree:A'];
function intent({book='A',runId=plan.runId,fingerprint='reviewed',physical=false,applied=false,metadata=false}={}){
 const ledger=getNexusLedger(),binding=metadata?{chatId:'story-a',book,revision:1}:null;
 let tx=ledger.begin({type:metadata?'world-tree-build':'world-tree-book-authoring',assumptions:{book},input:{book}});
 ledger.executing(tx.id);ledger.parsed(tx.id,{});ledger.validated(tx.id,{passed:true});
 const mutation=metadata?{type:'metadata.set',chatId:binding.chatId,key:'nexusWorldTreeOrganizationV1',value:{book,binding,lastRunId:runId,lastFingerprint:fingerprint}}:
  {type:'tree.replace',book,tree:{nexusWorldTreeBuild:{book,runId,fingerprint}}};
 ledger.staged(tx.id,{}, {mutationProposal:{type:mutation.type,draft:mutation,assumptions:{book},approvalRequired:true}});ledger.approve(tx.id,{by:'operator'});
 tx=ledger.prepareCommit(tx.id,{currentAssumptions:{book}});
 beginNexusCommitIntent(tx,{mutation,metadata:{resources:metadata?['metadata:story-a']:['lore:'+book,'tree:'+book]}});
 if(physical)updateNexusCommitIntentPhase(tx.id,'persisting',{physicalPersistenceBegun:true});
 if(applied)markNexusCommitIntentApplied(tx.id,{done:true});
 return tx.id;
}
test.beforeEach(()=>resetNexusCommitJournalForTests());

test('real journal reconciliation settles only the matching provably unstarted build intent',async()=>{
 const target=intent(),other=intent({book:'B',runId:'unrelated'});let checks=0;
 const result=await recoverUnappliedWorldBuild({plan,assertFresh:async()=>{checks++;}});
 assert.equal(result.state,'not-applied');assert.deepEqual(result.reconciled,[target]);assert.equal(checks,2);
 const rows=inspectNexusCommitJournal();assert.equal(rows.find(r=>r.id===target).state,'reconciled-confirmed-not-applied');
 assert.equal(rows.find(r=>r.id===other).state,'committing');
});

test('an unknown physical outcome cannot be converted into permission to replay',async()=>{
 const target=intent({physical:true});
 await assert.rejects(recoverUnappliedWorldBuild({plan,assertFresh:async()=>{}}),/PRE state was not proven/);
 assert.equal(inspectNexusCommitJournal().find(r=>r.id===target).state,'committing');
 // Failure must release the resources rather than stranding the next recovery.
 const lease=await acquireNexusMutationResources(resources,{ownerId:'verify-release',waitTimeoutMs:50});lease.release();
});

test('other runs, fingerprints and applied transactions remain fenced even with unchanged source authority',async()=>{
 for(const options of [{runId:'another-run'},{fingerprint:'other-approval'},{applied:true}]){
  resetNexusCommitJournalForTests();const target=intent(options),before=inspectNexusCommitJournal();
  await assert.rejects(recoverUnappliedWorldBuild({plan,assertFresh:async()=>{}}),/unresolved transaction|POST proof|PRE state|APPLIED/);
  assert.deepEqual(inspectNexusCommitJournal(),before);assert.ok(target);
 }
});

test('story recovery uses exact metadata owner and binding instead of authoring book resources',async()=>{
 const target=intent({metadata:true}),storyPlan={...plan,binding:{chatId:'story-a',book:'A',revision:1}};
 const result=await recoverUnappliedWorldBuild({plan:storyPlan,assertFresh:async()=>{}});
 assert.deepEqual(result.reconciled,[target]);assert.equal(inspectNexusCommitJournal()[0].state,'reconciled-confirmed-not-applied');
});

test('changed authority while waiting for a resource lease is checked before journal settlement',async()=>{
 const target=intent(),lease=await acquireNexusMutationResources(resources,{ownerId:'active-writer'});let fresh=true;
 const pending=recoverUnappliedWorldBuild({plan,assertFresh:async()=>{if(!fresh)throw Error('Reviewed authority changed');}});
 fresh=false;lease.release();await assert.rejects(pending,/Reviewed authority changed/);
 assert.equal(inspectNexusCommitJournal().find(r=>r.id===target).state,'committing');
});

test('unavailable journal evidence fails closed rather than treating an unreadable journal as empty',async()=>{
 await assert.rejects(recoverUnappliedWorldBuild({plan,assertFresh:async()=>{},inspectConflicts:()=>{throw Error('Journal unavailable');}}),/Journal unavailable/);
});
