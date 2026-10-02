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

/*
 * The legacy Memory window had its own Delete button and therefore needed a
 * UI-specific preserveCoverage branch. UI Core intentionally exposes the Memory
 * owner as read-only. Until a mutation surface is deliberately reintroduced,
 * the safe contract is stronger: there is no UI deletion path that can bypass
 * lore-digest settlement/recovery.
 */
const ui=fs.readFileSync(new URL('../src/ui-core/wave13-operator-surfaces.js',import.meta.url),'utf8');
const adapter=fs.readFileSync(new URL('../src/ui-core/wave13-operator-adapters.js',import.meta.url),'utf8');
const host=fs.readFileSync(new URL('../nexus-ui-host.js',import.meta.url),'utf8');
assert.ok(ui.includes('No UI mutation action is exposed.'),'UI Core Memory must explicitly remain read-only at the operator surface');
assert.ok(adapter.includes('mutation:false'),'Memory UI adapter must advertise no generic Memory mutation authority');
assert.equal(ui.includes('deleteMemoryRecord'),false,'UI Core must not call the Memory delete primitive directly');
assert.equal(host.includes('deleteMemoryRecord'),false,'host bindings must not export a hidden Memory delete escape hatch');
assert.equal(ui.includes('operator-delete-digested'),false,'digest coverage policy belongs to the durable Memory owner, not UI Core');
assert.equal(ui.includes('Delete Summary'),false,'a Summary delete control must not appear without a reviewed owner mutation contract');

console.log('Summary digest durable coverage/recovery: PASS');
