import { getContext } from '../../../../st-context.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { loadBook, saveBook, createEntryInBook, deleteEntryFromBook, findEntryByUid } from '../lore/store.js';
import { setBookEnabled, setBookPermission, setBookInjectionMode } from '../lore/policy.js';
import { getManagedBooks } from '../lore/active-books.js';
import { clearCurrentStoryScope, configureCurrentStoryScope, getCurrentStoryScope, hasExplicitStoryScope } from '../lore/story-scope.js';
import { getTree, setTreeDirect, deleteTreeDirect } from '../tree/store.js';
import { getCharacterBanks, updateCharacterBank, resetCharacterBankReconciliation, reconcileCharacterBankRuntime } from '../memory/character-banks.js';
import { openMemoryBank } from '../memory/ui.js';
import { runRetrieval, clearRetrieval } from '../retrieval/retriever.js';
import { getRetrievalState, hasReusableInjection } from '../retrieval/state.js';
import { invalidateSmartContext } from '../smart-context/warmer.js';
import { getTelemetrySnapshot, logEvent } from '../observability/telemetry.js';
import { openLorebookBuilder, cancelActiveLorebookBuilderSession } from '../builder/ui.js';
import {
    seedCharacterBankTestWorld,
    resetCharacterBankTestWorld,
    restoreCharacterBankTestSession,
} from '../tests/harness/character-banks/fixture-seeder.js';
import {
    seedWorldLoad,
    restoreWorldLoad,
    advanceGrowthWorld,
    applyWorldMutationBatch,
} from '../tests/harness/world-loads/world-load-seeder.js';

const TEST_BOOK = 'Nexus Test World - Character Banks';
const SMART_META_KEY = 'tv2_smart_context';
const BOOK_SETTING_MAPS = Object.freeze(['enabledLorebooks', 'bookPermissions', 'bookInjectionModes', 'bookDescriptions']);

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function restoreObject(target, snapshot) {
    if (!target || typeof target !== 'object') return;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, clone(snapshot || {}));
}

function emitBankUpdate() {
    try { globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-character-banks-updated')); } catch {}
    try { globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-memory-bank-updated')); } catch {}
}

async function worldInfoModule() {
    return import('../../../../world-info.js');
}

function bookSettingSnapshot(book) {
    const settings = getSettings();
    const out = {};
    for (const mapName of BOOK_SETTING_MAPS) {
        const map = settings?.[mapName] || {};
        out[mapName] = Object.prototype.hasOwnProperty.call(map, book)
            ? { present: true, value: clone(map[book]) }
            : { present: false, value: undefined };
    }
    return out;
}

function restoreBookSettingSnapshot(book, snapshot = {}) {
    updateSettings(settings => {
        for (const mapName of BOOK_SETTING_MAPS) {
            settings[mapName] = settings[mapName] || {};
            const row = snapshot?.[mapName];
            if (row?.present) settings[mapName][book] = clone(row.value);
            else delete settings[mapName][book];
        }
    });
}

async function snapshotBook(book) {
    const wi = await worldInfoModule();
    const exists = Array.isArray(wi.world_names) && wi.world_names.includes(book);
    let data = null;
    if (exists) {
        try { data = clone(await loadBook(book)); }
        catch (error) {
            throw new Error(`Existing Test Mode lorebook \"${book}\" could not be snapshotted safely: ${error?.message || error}`);
        }
    }
    return {
        exists,
        data,
        tree: clone(getTree(book)),
        settings: bookSettingSnapshot(book),
    };
}

async function ensureIsolatedBook(book) {
    const wi = await worldInfoModule();
    if (Array.isArray(wi.world_names) && wi.world_names.includes(book)) return true;
    if (typeof wi.createNewWorldInfo !== 'function') throw new Error('SillyTavern createNewWorldInfo() is unavailable; Test Mode cannot safely create the isolated lorebook.');
    const created = await wi.createNewWorldInfo(book, { interactive: false });
    if (created === false && !(Array.isArray(wi.world_names) && wi.world_names.includes(book))) {
        throw new Error(`Could not create isolated Test Mode lorebook "${book}".`);
    }
    return true;
}

async function clearBook(book) {
    const data = await loadBook(book);
    data.entries = {};
    await saveBook(book, data);
    return true;
}

async function createLoreEntry(book, entry) {
    const data = await loadBook(book);
    const created = await createEntryInBook(book, data, entry);
    return { uid: Number(created?.entry?.uid), title: String(created?.entry?.comment || entry?.title || '') };
}


async function updateLoreEntry(book, uid, change = {}) {
    const data = await loadBook(book);
    const entry = findEntryByUid(data.entries, uid);
    if (!entry) throw new Error(`UID ${uid} not found in "${book}".`);
    if (Object.prototype.hasOwnProperty.call(change, 'title')) entry.comment = String(change.title || '').trim();
    if (Object.prototype.hasOwnProperty.call(change, 'content')) entry.content = String(change.content || '');
    if (Object.prototype.hasOwnProperty.call(change, 'append')) entry.content = `${String(entry.content || '')}${String(change.append || '')}`;
    if (Array.isArray(change.keys)) entry.key = change.keys.map(String).map(v => v.trim()).filter(Boolean);
    await saveBook(book, data);
    return { uid: Number(uid), title: String(entry.comment || ''), contentChars: String(entry.content || '').length };
}

async function deleteLoreEntry(book, uid) {
    const data = await loadBook(book);
    await deleteEntryFromBook(book, data, uid, true);
    await saveBook(book, data);
    return { uid: Number(uid), deleted: true };
}

function replaceCharacterBanks(banks) {
    updateSettings(settings => {
        settings.memoryBank = settings.memoryBank || {};
        settings.memoryBank.characterBanks = settings.memoryBank.characterBanks || { enabled: true, banks: [] };
        settings.memoryBank.characterBanks.enabled = true;
        settings.memoryBank.characterBanks.banks = clone(Array.isArray(banks) ? banks : []);
    });
    resetCharacterBankReconciliation();
    emitBankUpdate();
    return getCharacterBanks();
}

async function restoreBook(book, snapshot) {
    if (!snapshot || snapshot.exists !== true) {
        const wi = await worldInfoModule();
        if (Array.isArray(wi.world_names) && wi.world_names.includes(book) && typeof wi.deleteWorldInfo === 'function') {
            await wi.deleteWorldInfo(book);
        }
        deleteTreeDirect(book);
        restoreBookSettingSnapshot(book, snapshot?.settings || {});
        return true;
    }

    await ensureIsolatedBook(book);
    if (snapshot.data) await saveBook(book, clone(snapshot.data));
    if (snapshot.tree) setTreeDirect(book, clone(snapshot.tree));
    else deleteTreeDirect(book);
    restoreBookSettingSnapshot(book, snapshot.settings || {});
    return true;
}

async function removeBook(book) {
    const wi = await worldInfoModule();
    if (Array.isArray(wi.world_names) && wi.world_names.includes(book)) {
        if (typeof wi.deleteWorldInfo !== 'function') throw new Error('SillyTavern deleteWorldInfo() is unavailable; refusing to leave an un-restorable Test Mode book.');
        await wi.deleteWorldInfo(book);
    }
    deleteTreeDirect(book);
    updateSettings(settings => {
        for (const mapName of BOOK_SETTING_MAPS) {
            settings[mapName] = settings[mapName] || {};
            delete settings[mapName][book];
        }
    });
    return true;
}

function fixtureApi() {
    return {
        ensureIsolatedBook,
        clearBook,
        createLoreEntry,
        saveTree: async (book, tree) => setTreeDirect(book, tree),
        getCharacterBanks,
        replaceCharacterBanks,
        enableBook: async book => setBookEnabled(book, true),
        setBookReadWritePolicy: async book => {
            await setBookPermission(book, 'read_write');
            await setBookInjectionMode(book, 'tv2');
        },
        snapshotBook,
        restoreBook,
        removeBook,
        log: (event, details) => logEvent('test-harness', event, details || {}, 'debug'),
    };
}


function worldFixtureApi() {
    return {
        ensureIsolatedBook,
        clearBook,
        createLoreEntry,
        updateLoreEntry,
        deleteLoreEntry,
        snapshotBook,
        restoreBook,
        removeBook,
        enableBook: async book => {
            await setBookEnabled(book, true);
            await setBookPermission(book, 'read_write');
            await setBookInjectionMode(book, 'tv2');
            return true;
        },
        log: (event, details) => logEvent('test-harness', event, details || {}, 'debug'),
    };
}

function makeMessage(text, { user = true } = {}) {
    return {
        is_user: user === true,
        is_system: false,
        mes: String(text || ''),
        name: user ? 'Nexus Test User' : 'Nexus Test Assistant',
        send_date: Date.now(),
    };
}

async function withSyntheticChat(messages, fn) {
    const context = getContext();
    if (!context || !Array.isArray(context.chat)) throw new Error('No active SillyTavern chat is available for Nexus Test Mode.');
    const chat = context.chat;
    const original = chat.slice();
    chat.splice(0, chat.length, ...messages.map(message => clone(message)));
    try {
        return await fn(context);
    } finally {
        chat.splice(0, chat.length, ...original);
        // Never leave a synthetic test injection attached to the operator's real
        // prompt. Logical retrieval state is intentionally retained until the
        // next scenario/reset so NO_CHANGE reuse can be exercised.
        clearRetrieval({ clearState: false, force: true });
    }
}

function gateObservation(result) {
    const state = getRetrievalState();
    const gate = result?.gate || state?.lastGate || null;
    return {
        mode: gate?.mode || null,
        reason: gate?.reason || '',
        confidence: Number(gate?.confidence) || 0,
        signals: Array.isArray(gate?.signals) ? [...gate.signals] : [],
        signalDetails: clone(gate?.signalDetails || {}),
        reused: result?.reused === true,
        degraded: result?.degraded === true,
        retrievalPlan: clone(result?.retrievalPlan || null),
        reusableInjection: hasReusableInjection(),
        refs: clone(result?.refs || state?.lastInjectedRefs || []),
        regionRefs: clone(result?.regionRefs || state?.lastRegionRefs || []),
        nodeRefs: clone(result?.nodeRefs || state?.lastNodeRefs || []),
        noChangeStreak: Number(state?.noChangeStreak) || 0,
    };
}

export function createNexusTestModeAdapter() {
    let fixtureSession = null;
    let baselineSnapshot = null;
    let lastGateObservation = null;
    let changeGateBaselineText = '';
    let characterScene = [];
    let worldLoadSession = null;
    let worldLoadBuilderResult = null;

    function captureRuntimeBaseline() {
        if (baselineSnapshot) return;
        const context = getContext();
        const managedBooks = getManagedBooks({ requireTree: false, access: 'any', injection: 'any' });
        baselineSnapshot = {
            retrieval: clone(getRetrievalState()),
            smartMeta: clone(context?.chatMetadata?.[SMART_META_KEY]),
            hadSmartMeta: !!context?.chatMetadata && Object.prototype.hasOwnProperty.call(context.chatMetadata, SMART_META_KEY),
            storyScopeConfigured: hasExplicitStoryScope(context),
            storyScope: clone(getCurrentStoryScope({ managedBooks })),
        };
    }

    async function ensureFixture() {
        captureRuntimeBaseline();
        if (!fixtureSession) fixtureSession = await seedCharacterBankTestWorld(fixtureApi(), { reset: true });
        return fixtureSession;
    }

    async function restoreRuntimeBaseline() {
        if (!baselineSnapshot) return false;
        clearRetrieval({ clearState: true, force: true });
        if (baselineSnapshot?.retrieval) restoreObject(getRetrievalState(), baselineSnapshot.retrieval);
        const context = getContext();
        if (context?.chatMetadata) {
            if (baselineSnapshot?.hadSmartMeta) context.chatMetadata[SMART_META_KEY] = clone(baselineSnapshot.smartMeta);
            else delete context.chatMetadata[SMART_META_KEY];
            try { context.saveMetadataDebounced?.(); } catch {}
        }
        const managedBooks = getManagedBooks({ requireTree: false, access: 'any', injection: 'any' });
        if (baselineSnapshot?.storyScopeConfigured) {
            const previousScope = baselineSnapshot.storyScope || {};
            configureCurrentStoryScope({
                readBooks: previousScope.readBooks || [],
                writeBooks: previousScope.writeBooks || [],
                primaryWriteBook: previousScope.primaryWriteBook || null,
                reason: 'test-mode-story-scope-restored',
            }, { managedBooks });
        } else {
            clearCurrentStoryScope({ managedBooks, reason: 'test-mode-story-scope-restored' });
        }
        invalidateSmartContext('test-mode-restored');
        return true;
    }

    async function restoreAll() {
        if (!fixtureSession && !worldLoadSession && !baselineSnapshot) return { restored: false, reason: 'no-active-test-mode-session' };
        cancelActiveLorebookBuilderSession?.('test-mode-restore');
        if (worldLoadSession) await restoreWorldLoad(worldFixtureApi(), worldLoadSession);
        worldLoadSession = null;
        worldLoadBuilderResult = null;
        if (fixtureSession) await restoreCharacterBankTestSession(fixtureApi(), fixtureSession);
        fixtureSession = null;
        await restoreRuntimeBaseline();
        baselineSnapshot = null;
        lastGateObservation = null;
        changeGateBaselineText = '';
        characterScene = [];
        logEvent('test-harness', 'test-mode-restored', { book: TEST_BOOK }, 'info');
        return { restored: true, book: TEST_BOOK };
    }

    async function runSyntheticRetrieval(messages, source) {
        await ensureFixture();
        const settings = getSettings();
        if (!settings.enabled || settings.retrieval?.enabled === false) {
            throw new Error('Nexus retrieval must be enabled before running live Change Gate / Character Bank Test Mode scenarios.');
        }
        const result = await withSyntheticChat(messages, () => runRetrieval());
        lastGateObservation = { ...gateObservation(result), source };
        return { result, observation: clone(lastGateObservation) };
    }

    const characterBanks = {
        seedFixture: async () => {
            captureRuntimeBaseline();
            if (fixtureSession) fixtureSession = await resetCharacterBankTestWorld(fixtureApi(), fixtureSession);
            else fixtureSession = await seedCharacterBankTestWorld(fixtureApi(), { reset: true });
            characterScene = [];
            clearRetrieval({ clearState: true, force: true });
            return { book: TEST_BOOK, entries: fixtureSession.entryCount, banks: fixtureSession.bankCount };
        },
        resetFixture: async () => {
            await ensureFixture();
            fixtureSession = await resetCharacterBankTestWorld(fixtureApi(), fixtureSession);
            characterScene = [];
            clearRetrieval({ clearState: true, force: true });
            return { reset: true, book: TEST_BOOK };
        },
        restoreFixture: restoreAll,
        openCharacterBanks: async () => openMemoryBank('characters'),
        captureDiagnostics: async () => getTelemetrySnapshot(),
        setBankEnabled: async (character, enabled) => {
            await ensureFixture();
            const bank = getCharacterBanks().find(row => row.character === String(character));
            if (!bank) throw new Error(`Test Character Bank "${character}" was not found.`);
            return updateCharacterBank(bank.id, { enabled: enabled === true });
        },
        setBankRole: async (character, role) => {
            await ensureFixture();
            const bank = getCharacterBanks().find(row => row.character === String(character));
            if (!bank) throw new Error(`Test Character Bank "${character}" was not found.`);
            return updateCharacterBank(bank.id, { role: String(role) });
        },
        putSceneTurn: async command => {
            await ensureFixture();
            if (command?.id === 'baseline-empty') {
                characterScene = [];
                clearRetrieval({ clearState: true, force: true });
            }
            characterScene.push(makeMessage(command?.text || '', { user: true }));
            const run = await runSyntheticRetrieval(characterScene, `character-bank:${command?.id || 'scene'}`);
            const chatText = characterScene.map(message => message.mes).join('\n');
            const reconciliation = reconcileCharacterBankRuntime({ chatText, source: `test-harness:${command?.id || 'scene'}` });
            return {
                commandId: command?.id || null,
                expected: clone(command?.expected || {}),
                observation: run.observation,
                characterRuntime: clone(reconciliation?.current || reconciliation),
            };
        },
        log: (message, details) => logEvent('test-harness', String(message || 'character-bank'), details || {}, 'debug'),
    };

    const changeGate = {
        resetScenarioSession: async ({ scenarioId = null } = {}) => {
            await ensureFixture();
            clearRetrieval({ clearState: true, force: true });
            changeGateBaselineText = '';
            lastGateObservation = null;
            logEvent('test-harness', 'change-gate-reset', { scenarioId }, 'debug');
            return true;
        },
        primeBaseline: async ({ text, requireReusableInjection = false, scenarioId = null } = {}) => {
            changeGateBaselineText = String(text || '');
            const run = await runSyntheticRetrieval([makeMessage(changeGateBaselineText)], `change-gate:${scenarioId}:baseline`);
            if (requireReusableInjection && !hasReusableInjection()) {
                throw new Error(`Scenario ${scenarioId || ''} could not establish a reusable Nexus injection baseline.`);
            }
            return run;
        },
        submitSceneTurn: async ({ text, scenarioId = null } = {}) => {
            const baseline = changeGateBaselineText || 'Zareth Vale and Mira Vey remain at the same Lantern Tavern table with the road map open.';
            const messages = [makeMessage(baseline, { user: false }), makeMessage(text, { user: true })];
            return runSyntheticRetrieval(messages, `change-gate:${scenarioId}:current`);
        },
        clearReusableInjection: async () => {
            clearRetrieval({ clearState: true, force: true });
            return true;
        },
        reproduceNoResolvableLatestUserText: async ({ scenarioId = null } = {}) => {
            const baseline = changeGateBaselineText || 'Zareth Vale and Mira Vey remain at the Lantern Tavern table.';
            return runSyntheticRetrieval([makeMessage(baseline, { user: false })], `change-gate:${scenarioId}:no-resolvable-user-text`);
        },
        getNoChangeRefreshThreshold: async () => Number(getSettings().retrieval?.refreshAfterNoChangeTurns) || 3,
        readLastGateObservation: async () => clone(lastGateObservation),
        captureDiagnostics: async () => getTelemetrySnapshot(),
        log: (message, details) => logEvent('test-harness', String(message || 'change-gate'), details || {}, 'debug'),
    };



    const worldLoads = {
        seedPreset: async presetId => {
            captureRuntimeBaseline();
            cancelActiveLorebookBuilderSession?.('test-world-reseed');
            if (worldLoadSession) await restoreWorldLoad(worldFixtureApi(), worldLoadSession);
            worldLoadSession = await seedWorldLoad(worldFixtureApi(), String(presetId || 'medium'));
            worldLoadBuilderResult = null;
            const managedBooks = getManagedBooks({ requireTree: false, access: 'any', injection: 'any' });
            configureCurrentStoryScope({
                readBooks: [worldLoadSession.bookName],
                writeBooks: [worldLoadSession.bookName],
                primaryWriteBook: worldLoadSession.bookName,
                reason: `test-harness-world-load:${worldLoadSession.presetId}`,
            }, { managedBooks });
            clearRetrieval({ clearState: true, force: true });
            invalidateSmartContext('test-world-seeded');
            return {
                presetId: worldLoadSession.presetId,
                bookName: worldLoadSession.bookName,
                entries: worldLoadSession.world?.entries?.length || 0,
                seedDurationMs: worldLoadSession.seedDurationMs,
            };
        },
        runBuilder: async presetId => {
            const requested = String(presetId || worldLoadSession?.presetId || 'medium');
            if (!worldLoadSession || worldLoadSession.presetId !== requested) await worldLoads.seedPreset(requested);
            worldLoadBuilderResult = await openLorebookBuilder(worldLoadSession.bookName);
            return {
                presetId: worldLoadSession.presetId,
                bookName: worldLoadSession.bookName,
                mode: worldLoadBuilderResult?.mode || null,
                state: worldLoadBuilderResult?.state || null,
                transactionId: worldLoadBuilderResult?.transactionId || null,
                addedCount: worldLoadBuilderResult?.preview?.added?.length || 0,
                newNodeCount: worldLoadBuilderResult?.preview?.newNodes?.length || 0,
            };
        },
        restoreSession: async presetId => {
            if (!worldLoadSession) return { restored: false, reason: 'no-active-world-load-session' };
            if (presetId && String(presetId) !== worldLoadSession.presetId) throw new Error(`Active world-load preset is ${worldLoadSession.presetId}, not ${presetId}.`);
            cancelActiveLorebookBuilderSession?.('test-world-restore');
            const restoredPreset = worldLoadSession.presetId;
            await restoreWorldLoad(worldFixtureApi(), worldLoadSession);
            worldLoadSession = null;
            worldLoadBuilderResult = null;
            await restoreRuntimeBaseline();
            baselineSnapshot = null;
            return { restored: true, presetId: restoredPreset };
        },
        applyMutationBatch: async presetId => {
            if (!worldLoadSession || (presetId && String(presetId) !== worldLoadSession.presetId)) throw new Error('Seed the requested world-load preset before applying mutations.');
            return applyWorldMutationBatch(worldFixtureApi(), worldLoadSession);
        },
        advanceGrowthPhase: async () => {
            if (!worldLoadSession || worldLoadSession.presetId !== 'growth') throw new Error('Seed the Growth world before advancing phases.');
            const phases = worldLoadSession.world?.preset?.growthPhases || [];
            const current = Number(worldLoadSession.growthPhase) || 0;
            if (current >= phases.length - 1) return { complete: true, phase: current, total: worldLoadSession.world?.entries?.length || 0 };
            return advanceGrowthWorld(worldFixtureApi(), worldLoadSession, current + 1);
        },
        cancelBuilder: async () => ({ cancelled: cancelActiveLorebookBuilderSession?.('test-harness-cancel') === true }),
        captureDiagnostics: async () => getTelemetrySnapshot(),
        log: (message, details) => logEvent('test-harness', String(message || 'world-load'), details || {}, 'debug'),
    };

    return { characterBanks, changeGate, worldLoads, restore: restoreAll };
}
