import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../retrieval/retriever.js',import.meta.url),'utf8');
assert.ok(source.includes("from '../nexus/a52/modes.js'"),'Truth Gate Shadow must use Nexus A52 modes');
assert.ok(source.includes("from '../nexus/a52/nexus-adapters.js'"),'Truth Gate Shadow must use Nexus adapter contract');
assert.ok(source.includes("truthGateMode === A52Mode.SHADOW"),'Step 1 must be Shadow-only');
assert.ok(source.includes("'shadow-candidate-verdict'"),'Step 1 must log each candidate verdict');
assert.ok(source.includes("promptChanged: false"),'Shadow telemetry must explicitly state prompt is unchanged');
assert.ok(!source.includes("truthGateMode === A52Mode.ON"),'Step 1 must not promote Truth Gate to ON before live validation');
assert.ok(source.indexOf("const candidates = dedupeEntryRefs") < source.indexOf("'shadow-candidate-verdict'"),'Truth Gate must classify after candidate assembly');
assert.ok(source.indexOf("'shadow-candidate-verdict'") < source.indexOf("const injectionRun = reviewCandidates.length"),'Truth Gate must run before final injection review/publication');
console.log('Area-52 Truth Gate Shadow wiring: PASS');
