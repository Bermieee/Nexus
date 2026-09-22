import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

// Live 0.7.5 diagnostics: Retrieval called the bounded-tail helper without
// importing it, crashing foreground retrieval before lore publication.
const retriever = read('retrieval/retriever.js');
assert.match(retriever, /isNarrativeSceneMessage,\s*tailNarrativeSceneMessages,\s*mergeInjectionSliceSelections/);
assert.match(retriever, /function immediateSceneChat[\s\S]*tailNarrativeSceneMessages/);

// Live GLM scene response placed reasoning one level too deep under references.
// Execute the pure normalizer directly from source so the observed provider
// shape remains a regression fixture without loading SillyTavern host modules.
const scanner = read('scene/scanner.js');
const start = scanner.indexOf('export function normalizeSceneScanPayload');
const end = scanner.indexOf('\nfunction sceneScanValidator', start);
assert.ok(start >= 0 && end > start, 'Scene scan payload normalizer must remain present');
const fnSource = scanner.slice(start, end).replace(/^export\s+/, '');
const clean = value => String(value ?? '').replace(/\s+/g,' ').trim();
const normalizeSceneScanPayload = new Function('clean', `${fnSource}; return normalizeSceneScanPayload;`)(clean);
const misplaced = {
  scene: {
    participants: ['Akira','Nanahoshi'],
    location: "Nanahoshi's Workshop",
    activity: 'conversation',
    objective: 'continue discussion',
    focus: 'food and tomorrow\'s teardown',
    timeContext: 'Monday',
    relationshipFocus: true,
  },
  references: {
    characters: [],
    locations: [{name:'Cafeteria',relation:'planned-destination'}],
    organizations: [],
    concepts: [],
    items: [],
    reasoning: 'Same dyad and location; cafeteria is only a planned destination.',
  },
};
const normalized = normalizeSceneScanPayload(misplaced);
assert.equal(normalized.reasoning, 'Same dyad and location; cafeteria is only a planned destination.');
assert.equal(Object.hasOwn(normalized.references,'reasoning'), false);
assert.deepEqual(normalized.references.locations, misplaced.references.locations);

// Main disabled must remain disabled after runtime/gateway discovery. A
// connected ST Main gateway is capability, not operator authorization.
const worker = read('nexus/model-worker-bus.js');
assert.match(worker, /mainConfigured=mainConfigured&&!!gateway\?\.isConnected\?\.\(\)/);
assert.doesNotMatch(worker, /mainConfigured=mainEligible&&!!gateway\?\.isConnected\?\.\(\)/);

console.log('PASS live-generation regression contracts');
