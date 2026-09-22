import assert from 'node:assert/strict';
import fs from 'node:fs';

const uidSource=fs.readFileSync(new URL('../lore/uid-summarizer.js',import.meta.url),'utf8');
for(const required of [
  'profileWritingTarget',
  'recoveryAttempts:3',
  'RECOVERY ATTEMPT',
  'hard ceiling is',
  'writingTarget',
  'estimated tokens; hard limit is',
]) assert.ok(uidSource.includes(required),`UID summarizer recovery contract missing: ${required}`);

const batchSource=fs.readFileSync(new URL('../nexus/batch-layer.js',import.meta.url),'utf8');
for(const required of [
  'recoveryAttempts = null',
  'maxRecoveryAttempts',
  'recoveryAttempt <= maxRecoveryAttempts',
]) assert.ok(batchSource.includes(required),`Batch recovery override missing: ${required}`);

const match=uidSource.match(/function profileWritingTarget\(plan,\{recoveryAttempt=0\}=\{\}\)\{([^}]+)\}/);
assert.ok(match,'profileWritingTarget helper must remain explicit and local to UID summarizer');
assert.ok(uidSource.includes('ratio=recoveryAttempt<=0?.78:recoveryAttempt===1?.68:.58'),'UID recovery targets must tighten across retries');

console.log('UID summarizer bounded profile recovery: PASS');
