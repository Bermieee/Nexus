export const WORLD_LOAD_FIXTURE_VERSION = '0.1.0';

export const WORLD_LOAD_PRESETS = Object.freeze({
    medium: Object.freeze({
        id: 'medium',
        label: 'Medium World — Harbor Marches',
        bookName: 'Nexus Test World - Harbor Marches',
        seed: 0x4d454449,
        targetEntries: 384,
        entityPlan: { characters: 18, locations: 42, factions: 12, objects: 54, systems: 18 },
        content: { baseParagraphs: 2, longEntryEvery: 19, tinyEntryEvery: 0, aliasEvery: 5, nearDuplicateEvery: 0, duplicateTitleEvery: 0 },
        workload: { expectedClass: 'normal-medium', buildMode: 'full+incremental', responsivenessProbeTurns: 4, mutationBatch: 24 },
        purpose: 'Normal regression corpus: enough hierarchy, aliases, cross-links, history, and Character Bank candidates to force non-trivial Builder decisions without obscuring individual errors.',
    }),
    heavy: Object.freeze({
        id: 'heavy',
        label: 'Heavy World — Ashfall Dominion',
        bookName: 'Nexus Test World - Ashfall Dominion',
        seed: 0x48454156,
        targetEntries: 1280,
        entityPlan: { characters: 44, locations: 118, factions: 30, objects: 170, systems: 46 },
        content: { baseParagraphs: 3, longEntryEvery: 13, tinyEntryEvery: 0, aliasEvery: 4, nearDuplicateEvery: 41, duplicateTitleEvery: 0 },
        workload: { expectedClass: 'heavy', buildMode: 'full+incremental', responsivenessProbeTurns: 8, mutationBatch: 96 },
        purpose: 'Sustained Builder/Director/Batch/Sidecar load with enough entries to require slicing and reconciliation while ordinary foreground generation must stay usable.',
    }),
    massive: Object.freeze({
        id: 'massive',
        label: 'Massive World — Crownless Expanse',
        bookName: 'Nexus Test World - Crownless Expanse',
        seed: 0x4d415353,
        targetEntries: 3072,
        entityPlan: { characters: 96, locations: 290, factions: 72, objects: 430, systems: 116 },
        content: { baseParagraphs: 3, longEntryEvery: 11, tinyEntryEvery: 0, aliasEvery: 3, nearDuplicateEvery: 29, duplicateTitleEvery: 0 },
        workload: { expectedClass: 'architecture-scale', buildMode: 'full+incremental', responsivenessProbeTurns: 12, mutationBatch: 256 },
        purpose: 'Architecture-scale corpus intended to force partitioning, batching, Sidecar parallelism, cancellation, stale-work handling, and long-running foreground/background coexistence.',
    }),
    hostile: Object.freeze({
        id: 'hostile',
        label: 'Hostile World — Broken Ledger',
        bookName: 'Nexus Test World - Broken Ledger',
        seed: 0x484f5354,
        targetEntries: 768,
        entityPlan: { characters: 28, locations: 64, factions: 20, objects: 88, systems: 28 },
        content: { baseParagraphs: 2, longEntryEvery: 9, tinyEntryEvery: 11, aliasEvery: 2, nearDuplicateEvery: 17, duplicateTitleEvery: 23, missingKeywordsEvery: 19 },
        workload: { expectedClass: 'hostile', buildMode: 'full+reconcile', responsivenessProbeTurns: 6, mutationBatch: 72 },
        purpose: 'Resilience corpus with aliases, duplicate titles, near-duplicate prose, tiny/very-long entries, missing keyword metadata, rename pressure, and deliberately awkward cross-links.',
    }),
    growth: Object.freeze({
        id: 'growth',
        label: 'Growth World — Living Frontier',
        bookName: 'Nexus Test World - Living Frontier',
        seed: 0x47524f57,
        targetEntries: 1280,
        growthPhases: [128, 320, 640, 960, 1280],
        entityPlan: { characters: 40, locations: 100, factions: 28, objects: 150, systems: 42 },
        content: { baseParagraphs: 2, longEntryEvery: 15, tinyEntryEvery: 0, aliasEvery: 4, nearDuplicateEvery: 37, duplicateTitleEvery: 0 },
        workload: { expectedClass: 'incremental-longevity', buildMode: 'incremental-only-after-prime', responsivenessProbeTurns: 6, mutationBatch: 64 },
        purpose: 'Longevity corpus that starts small and grows through fixed phases so incremental Builder reconciliation, changed-entry repair, deletion, rename, and stale Tree handling can be tested repeatedly.',
    }),
});

export const WORLD_LOAD_ORDER = Object.freeze(['medium', 'heavy', 'massive', 'hostile', 'growth']);

export function getWorldLoadPreset(id) {
    const preset = WORLD_LOAD_PRESETS[id];
    if (!preset) throw new Error(`Unknown Nexus world-load preset: ${id}`);
    return preset;
}
