import { WORLD_LOAD_ORDER, getWorldLoadPreset } from './world-load-presets.js';
import { generateWorld, growthPhaseWorld, buildMutationPlan } from './generate-world.js';

export function validateGeneratedWorld(presetId) {
    const preset = getWorldLoadPreset(presetId);
    const world = generateWorld(presetId);
    const failures = [];
    if (world.entries.length !== preset.targetEntries) failures.push(`entry-count:${world.entries.length}!=${preset.targetEntries}`);
    const ids = new Set(world.entries.map(row => row.logicalId));
    if (ids.size !== world.entries.length) failures.push('logical-id-duplicates');
    const domains = new Set(world.entries.map(row => row.domain));
    for (const required of world.oracle.requiredDomains) if (!domains.has(required)) failures.push(`missing-domain:${required}`);
    if (!world.oracle.anchors.length) failures.push('no-anchors');
    const plan = buildMutationPlan(world);
    if (plan.total <= 0 || plan.total > world.entries.length) failures.push('bad-mutation-plan');
    return { presetId, pass: failures.length === 0, failures, entries: world.entries.length, anchors: world.oracle.anchors.length, mutationPlan: plan.total };
}

export function validateWorldLoadFixtures() {
    const results = WORLD_LOAD_ORDER.map(validateGeneratedWorld);
    const growth = getWorldLoadPreset('growth');
    let last = 0;
    const growthFailures = [];
    growth.growthPhases.forEach((target, index) => {
        const world = growthPhaseWorld(index);
        if (world.entries.length !== target) growthFailures.push(`phase-${index}:${world.entries.length}!=${target}`);
        if (world.entries.length <= last) growthFailures.push(`phase-${index}:not-increasing`);
        last = world.entries.length;
    });
    return { pass: results.every(r => r.pass) && growthFailures.length === 0, results, growthFailures };
}
