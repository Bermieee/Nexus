import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const semantic = read('builder2/nexus-semantic.js');
const workers = read('nexus/model-worker-bus.js');

// Canonical model-worker routing remains authoritative; Builder only observes
// the lane selected by the existing physical handle.
assert.match(workers,/handle\.meta\.preferredSlot=physical\?\.meta\?\.preferredSlot\|\|null/);
assert.match(workers,/handle\.meta\.assignedSlot=physical\?\.meta\?\.assignedSlot\|\|null/);
assert.match(workers,/handle\.meta\.assignedSlot=slot/);

// Hedge support exists inside one Builder semantic executor and is opt-in.
assert.match(semantic,/async #execute\(\{ stage, systemPrompt, prompt, validator, signal = null, temperature = 0\.15, hedgeAfterMs = 0 \}/);
assert.match(semantic,/const primary = enqueueAttempt\(\)/);
assert.match(semantic,/const primarySlot = String\(primary\.meta\?\.assignedSlot \|\| ''\)\.toUpperCase\(\)/);
assert.match(semantic,/const hedgeSlot = primarySlot === 'A' \? 'B' : 'A'/);
assert.match(semantic,/forceSlot: hedgeSlot/);
assert.match(semantic,/Promise\.any\(\[primaryPromise, hedgePromise\]\)/);
assert.match(semantic,/semantic-hedge-start/);
assert.match(semantic,/semantic-hedge-winner/);

// The same semantic validator guards both physical attempts.
assert.match(semantic,/structuredValidator: objectValidator\(validator\)/);

// Only taxonomy-plan opts in to the hedge. Other Builder semantic stages retain
// their existing single-request behavior.
const hedgeOptIns = semantic.match(/hedgeAfterMs:\s*45000/g) || [];
assert.equal(hedgeOptIns.length, 1);
assert.match(semantic,/stage: 'taxonomy-plan', signal, temperature: 0\.12, hedgeAfterMs: 45000/);

// A winning hedge cannot double-commit: the primary/hedge loser is cancelled
// inside the one executor, before WorkCoordinator returns the logical result.
assert.match(semantic,/primary\.cancel\?\.\('Builder 2 semantic hedge produced the first validated result\.'/);
assert.match(semantic,/hedge\?\.cancel\?\.\('Builder 2 primary produced the first validated result\.'/);

// Existing transport timeout remains unchanged; hedge is latency redundancy, not
// a shorter timeout or weaker semantic contract.
assert.match(semantic,/constructor\(\{ runtime, store, runId, logEvent = null, timeoutMs = 180000/);
assert.doesNotMatch(semantic,/stage: 'taxonomy-plan'[\s\S]{0,120}timeoutMs:/);

console.log('PASS Builder 2 taxonomy-plan first-valid hedge contract');
