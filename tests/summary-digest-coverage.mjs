import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateLoreDigestCleanup } from '../memory/lore-digest-policy.js';

const settledSaga={state:'committed',deleteAfterDigest:true,proposalIds:['p1']};
assert.equal(evaluateLoreDigestCleanup({saga:settledSaga,proposals:[{id:'p1',status:'approved'}]}).allowed,true,'approved committed Lore digest should own durable cleanup authority');
assert.equal(evaluateLoreDigestCleanup({saga:settledSaga,proposals:[{id:'p1',status:'pending'}]}).allowed,false,'pending Lore children must not claim durable digest coverage');

const store=fs.readFileSync(new URL('../memory/store.js',import.meta.url),'utf8');
assert.ok(store.includes('export async function restoreMemoryCoverageFromRecord'),'Memory Bank must be able to restore coverage after a digested Summary record is gone');
assert.ok(store.includes('coverageReceiptValidity(receipt,chat)'),'coverage restoration must fail closed if the source chat changed');
assert.ok(store.includes("source:'committed-lore-digest-recovery'")===false,'store must remain destination-agnostic about the recovery caller');

const settlement=fs.readFileSync(new URL('../memory/lore-digest-settlement.js',import.meta.url),'utf8');
assert.ok(settlement.includes("restoreMemoryCoverageFromRecord(coverageSource,{source:'committed-lore-digest'})"),'Summary→Lore cleanup must reassert coverage before deleting the staging Summary');
assert.ok(settlement.includes('saga?.postMemoryRecord||saga?.preMemoryRecord'),'deleted Summary coverage must be recoverable from durable saga evidence');
assert.ok(settlement.includes('export async function reconcileDigestedSummaryCoverage'),'startup must repair coverage lost by older digest/delete behavior');
assert.ok(settlement.includes('digestVerdictForSaga(saga).allowed===true'),'manual deletion may preserve coverage only after canonical Lore digestion is proven');

const router=fs.readFileSync(new URL('../memory/lore-router.js',import.meta.url),'utf8');
assert.ok(router.includes('await reconcileDigestedSummaryCoverage({chatId})'),'Lore startup reconciliation must repair historical digest coverage before Summary eligibility is trusted');

const ui=fs.readFileSync(new URL('../memory/ui.js',import.meta.url),'utf8');
assert.ok(ui.includes('const preserveCoverage=isMemoryLoreDigestSettled'),'Delete must distinguish a canonically digested Summary from an undigested/bad Summary');
assert.ok(ui.includes("preserveCoverage?'operator-delete-digested':'operator-delete'"),'proven digests must keep coverage while ordinary deletion still reopens the range');

console.log('Summary digest durable coverage/recovery: PASS');
