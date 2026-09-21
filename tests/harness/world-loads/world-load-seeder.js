import { generateWorld, growthPhaseWorld, buildMutationPlan } from './generate-world.js';
import { getWorldLoadPreset } from './world-load-presets.js';

function requireFn(api, name) {
    if (typeof api?.[name] !== 'function') throw new Error(`World-load harness adapter is missing ${name}().`);
    return api[name].bind(api);
}
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

export async function seedWorldLoad(api, presetId, { growthPhase = null } = {}) {
    const preset = getWorldLoadPreset(presetId);
    const ensureBook = requireFn(api, 'ensureIsolatedBook');
    const clearBook = requireFn(api, 'clearBook');
    const createEntry = requireFn(api, 'createLoreEntry');
    const snapshotBook = requireFn(api, 'snapshotBook');
    const previousBook = clone(await snapshotBook(preset.bookName));
    const world = presetId === 'growth' && growthPhase != null ? growthPhaseWorld(growthPhase) : generateWorld(presetId);
    await ensureBook(preset.bookName);
    await clearBook(preset.bookName);
    await api.enableBook?.(preset.bookName);
    const uidByLogicalId = {};
    const startedAt = Date.now();
    for (const row of world.entries) {
        const created = await createEntry(preset.bookName, {
            title: row.title, content: row.content, keys: row.keys, logicalId: row.logicalId,
            testMetadata: { domain: row.domain, representedIds: row.representedIds },
        });
        const uid = Number(created?.uid);
        if (!Number.isFinite(uid)) throw new Error(`World-load seeder failed to obtain UID for ${row.logicalId}.`);
        uidByLogicalId[row.logicalId] = uid;
    }
    const session = {
        kind: 'nexus-world-load-session', presetId, bookName: preset.bookName, seededAt: Date.now(),
        seedDurationMs: Date.now() - startedAt, world, uidByLogicalId, previousBook,
        hadPreviousBook: previousBook != null, growthPhase: growthPhase == null ? null : Number(growthPhase),
    };
    api.log?.('world-load-seeded', { presetId, entries: world.entries.length, seedDurationMs: session.seedDurationMs });
    return session;
}

export async function restoreWorldLoad(api, session) {
    if (session?.kind !== 'nexus-world-load-session') throw new Error('Invalid Nexus world-load session.');
    if (session.hadPreviousBook) await requireFn(api, 'restoreBook')(session.bookName, clone(session.previousBook));
    else await requireFn(api, 'removeBook')(session.bookName);
    api.log?.('world-load-restored', { presetId: session.presetId, bookName: session.bookName });
}

export async function advanceGrowthWorld(api, session, nextPhase) {
    if (session?.presetId !== 'growth') throw new Error('Growth advancement requires an active growth-world session.');
    const createEntry = requireFn(api, 'createLoreEntry');
    const nextWorld = growthPhaseWorld(nextPhase);
    const existingIds = new Set(Object.keys(session.uidByLogicalId));
    const additions = nextWorld.entries.filter(row => !existingIds.has(row.logicalId));
    for (const row of additions) {
        const created = await createEntry(session.bookName, {
            title: row.title, content: row.content, keys: row.keys, logicalId: row.logicalId,
            testMetadata: { domain: row.domain, representedIds: row.representedIds },
        });
        const uid = Number(created?.uid);
        if (!Number.isFinite(uid)) throw new Error(`Growth world failed to obtain UID for ${row.logicalId}.`);
        session.uidByLogicalId[row.logicalId] = uid;
    }
    session.world = nextWorld;
    session.growthPhase = Number(nextPhase);
    api.log?.('world-load-growth-advanced', { phase: session.growthPhase, additions: additions.length, total: nextWorld.entries.length });
    return { additions: additions.length, total: nextWorld.entries.length, session };
}

export async function applyWorldMutationBatch(api, session, options = {}) {
    const updateEntry = requireFn(api, 'updateLoreEntry');
    const deleteEntry = requireFn(api, 'deleteLoreEntry');
    const plan = buildMutationPlan(session.world, options);
    for (const change of plan.edits) await updateEntry(session.bookName, session.uidByLogicalId[change.logicalId], { append: change.append });
    for (const change of plan.renames) await updateEntry(session.bookName, session.uidByLogicalId[change.logicalId], { title: change.newTitle });
    for (const change of plan.deletes) {
        const uid = session.uidByLogicalId[change.logicalId];
        await deleteEntry(session.bookName, uid);
        delete session.uidByLogicalId[change.logicalId];
    }
    api.log?.('world-load-mutated', { presetId: session.presetId, ...plan });
    return plan;
}
