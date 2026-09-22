import assert from 'node:assert/strict';
import fs from 'node:fs';

const decision=fs.readFileSync(new URL('../retrieval/decision-sites.js',import.meta.url),'utf8');
const retriever=fs.readFileSync(new URL('../retrieval/retriever.js',import.meta.url),'utf8');

for(const required of [
  'chatRevision: clean(chatRevision)',
  'needText: context.needText',
  'readCurrentChatRevision',
  'partitionRetrievalDecisionCandidates',
  'Promise.all(chunks.map',
  'assist-partial',
  'unresolvedChunkCount',
  'retrieval-candidate-admission-batched',
]) assert.ok(decision.includes(required),`Jev admission contract missing: ${required}`);

assert.ok(!decision.includes("candidates.length>MAX_ENTRY_DECISION_CANDIDATES)return{handled:false,reason:'candidate-bound-exceeded'"),'Entry candidate admission must not bound out pools above 48');
assert.ok(!decision.includes('readCurrentNeedText'),'Candidate freshness must not recompute need text with a different formatter');
assert.ok(retriever.includes('chatRevision: scope?.revision || null'),'Retriever must bind Jev freshness to the captured chat revision');
assert.ok(retriever.includes('readCurrentChatRevision'),'Retriever must provide live chat-revision freshness');
assert.ok(retriever.includes('jevSelectedCount'),'Retriever telemetry must expose Jev kept count');
assert.ok(retriever.includes('unresolvedCount'),'Retriever telemetry must expose fail-open unresolved count');
assert.ok(retriever.includes('prunedCount'),'Retriever telemetry must expose actual Jev pruning');

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

console.log('Retrieval Jev candidate admission freshness/chunking: PASS');
