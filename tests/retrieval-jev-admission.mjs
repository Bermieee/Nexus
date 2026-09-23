import assert from 'node:assert/strict';
import fs from 'node:fs';

const decision=fs.readFileSync(new URL('../retrieval/decision-sites.js',import.meta.url),'utf8');
const retriever=fs.readFileSync(new URL('../retrieval/retriever.js',import.meta.url),'utf8');
const warmer=fs.readFileSync(new URL('../smart-context/warmer.js',import.meta.url),'utf8');

for(const required of [
  'candidateFreshnessInput',
  'createDecisionFreshnessContract',
  'readCurrentFreshnessContext',
  'readCurrentChatRevision',
  'partitionRetrievalDecisionCandidates',
  'Promise.all(chunks.map',
  'assist-partial',
  'unresolvedChunkCount',
  'retrieval-candidate-admission-batched',
]) assert.ok(decision.includes(required),`Jev admission contract missing: ${required}`);

assert.ok(!decision.includes("candidates.length>MAX_ENTRY_DECISION_CANDIDATES)return{handled:false,reason:'candidate-bound-exceeded'"),'Entry candidate admission must not bound out pools above 48');
assert.ok(!decision.includes('readCurrentNeedText'),'Candidate freshness must not recompute need text with a different formatter');
assert.ok(!decision.includes('currentNodeForUid'),'Candidate freshness must not reinterpret request-local routing node provenance as live canonical placement');
assert.ok(decision.includes('liveEntryTitle(entry,original.uid)')||decision.includes('liveEntryTitle(entry, original.uid)'),'Candidate freshness must reread canonical live entry titles with the same fallback semantics as Retrieval');
assert.ok(decision.includes("String(entry.content||'')")||decision.includes("String(entry.content || '')"),'Candidate freshness must still reread live lore content');
const treeStore=fs.readFileSync(new URL('../tree/store.js',import.meta.url),'utf8');
assert.ok(treeStore.includes('bumpNexusLoreSourceRevision'),'Tree mutations must remain fenced by the shared source revision when routing provenance stays frozen');
assert.ok(retriever.includes('chatRevision: scope?.revision || null'),'Retriever must bind Jev freshness to the captured chat revision');
assert.ok(retriever.includes('readCurrentChatRevision'),'Retriever must provide live chat-revision freshness');
assert.ok(retriever.includes('jevSelectedCount'),'Retriever telemetry must expose Jev kept count');
assert.ok(retriever.includes('unresolvedCount'),'Retriever telemetry must expose fail-open unresolved count');
assert.ok(retriever.includes('prunedCount'),'Retriever telemetry must expose actual Jev pruning');
assert.ok(retriever.includes('const injectionRun = reviewCandidates.length'),'Jev may prefilter candidates but cannot replace final Lore Injection review');
assert.ok(retriever.includes('await runInjectionReview({'),'Filtered candidates must still enter Lore Injection review');
assert.ok(!retriever.includes("reasoning:'Decision Core Assist admitted exact lore candidates before worker execution.'"),'Jev must never be treated as final injection authority');
assert.ok(warmer.includes('activePinAuthorityMigrationV2'),'Buggy derived continuity pins must be cleared once after the Jev authority repair');
assert.ok(warmer.includes('store.activePins = []'),'Continuity migration must clear only derived active pins');
assert.ok(!warmer.includes('store.manualPins = [];\n        store.activePinAuthorityMigrationV2'),'Continuity migration must not clear manual pins');

const start=decision.indexOf('export function partitionRetrievalDecisionCandidates');
const end=decision.indexOf('\nexport async function evaluateRetrievalCandidateAdmissionAssist',start);
assert.ok(start>=0&&end>start,'Partition helper must remain directly testable');
const fnSource=decision.slice(start,end).replace(/^export\s+/,'');
const MAX_ENTRY_DECISION_CANDIDATES=48;
const partition=new Function('MAX_ENTRY_DECISION_CANDIDATES',`${fnSource}; return partitionRetrievalDecisionCandidates;`)(MAX_ENTRY_DECISION_CANDIDATES);
assert.deepEqual(partition(Array.from({length:47},(_,i)=>i)).map(x=>x.length),[47]);
assert.deepEqual(partition(Array.from({length:48},(_,i)=>i)).map(x=>x.length),[48]);
assert.deepEqual(partition(Array.from({length:55},(_,i)=>i)).map(x=>x.length),[48,7]);
assert.deepEqual(partition(Array.from({length:97},(_,i)=>i)).map(x=>x.length),[48,48,1]);

console.log('Retrieval Jev prefilter/freshness/chunking/continuity authority: PASS');
