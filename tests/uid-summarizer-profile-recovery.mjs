import assert from 'node:assert/strict';
import fs from 'node:fs';

const uidSource=fs.readFileSync(new URL('../lore/uid-summarizer.js',import.meta.url),'utf8');
for(const required of [
  'profileTolerance',
  'profileSafetyCap',
  'recoveryAttempts:3',
  'RECOVERY ATTEMPT',
  'preferred target is',
  'absolute safety ceiling',
  'safetyCapTokens',
]) assert.ok(uidSource.includes(required),`UID summarizer recovery contract missing: ${required}`);

assert.ok(uidSource.includes("profile==='lean'?1.40:profile==='balanced'?1.30:1.20"),'Profile safety tolerance must remain differentiated');
assert.ok(uidSource.includes('Math.min(4000,Math.ceil(target*profileTolerance(profile)))'),'Safety ceiling must be bounded without collapsing back to the target maximum');
assert.ok(uidSource.includes('usableOption(raw,plan.safetyCapTokens??plan.targetTokens)'),'Validation must use the safety ceiling, not the preferred target');
assert.ok(!uidSource.includes('hard limit is ${plan.targetTokens}'),'Preferred profile target must not be a rejection cliff');

const batchSource=fs.readFileSync(new URL('../nexus/batch-layer.js',import.meta.url),'utf8');
for(const required of [
  'recoveryAttempts = null',
  'maxRecoveryAttempts',
  'recoveryAttempt <= maxRecoveryAttempts',
]) assert.ok(batchSource.includes(required),`Batch recovery override missing: ${required}`);

console.log('UID summarizer target-with-safety-tolerance recovery: PASS');
