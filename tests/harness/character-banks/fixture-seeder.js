import {
    TEST_BOOK,
    LORE_ENTRIES,
    TREE_PLAN,
    buildResolvedCharacterBankSeeds,
} from './fixture-definition.js';

function assertFn(api, name) {
    if (typeof api?.[name] !== 'function') throw new Error(`Character Bank fixture seeder requires ${name}().`);
    return api[name].bind(api);
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function validSession(session) {
    return session?.kind === 'nexus-character-bank-test-session' && session?.book === TEST_BOOK;
}

/**
 * Seed the isolated Character Bank test world.
 *
 * The seeder is dependency-injected on purpose. The next build may wire these
 * operations to the current Nexus/ST storage layer without the fixture becoming
 * a second production storage implementation.
 *
 * Required api:
 *   ensureIsolatedBook(bookName) -> bookHandle/metadata
 *   clearBook(bookName)
 *   createLoreEntry(bookName, {title,content,keys}) -> {uid,title?}
 *   saveTree(bookName, tree)
 *   getCharacterBanks() -> current persistent banks
 *   replaceCharacterBanks(banks)
 *
 * Optional api:
 *   enableBook(bookName)
 *   setBookReadWritePolicy(bookName)
 *   snapshotBook(bookName) -> opaque snapshot
 *   restoreBook(bookName, snapshot)
 *   removeBook(bookName)
 *   log(event, details)
 *
 * Pass baselineSession when reseeding an already-active test session. This keeps
 * teardown anchored to the operator state that existed before Test Mode began.
 */
export async function seedCharacterBankTestWorld(api, { reset = true, baselineSession = null } = {}) {
    const ensureIsolatedBook = assertFn(api, 'ensureIsolatedBook');
    const clearBook = assertFn(api, 'clearBook');
    const createLoreEntry = assertFn(api, 'createLoreEntry');
    const saveTree = assertFn(api, 'saveTree');
    const getCharacterBanks = assertFn(api, 'getCharacterBanks');
    const replaceCharacterBanks = assertFn(api, 'replaceCharacterBanks');

    const inheritedBaseline = validSession(baselineSession) ? clone(baselineSession.restore) : null;
    const previousBanks = inheritedBaseline ? clone(inheritedBaseline.previousBanks) : clone(await getCharacterBanks());
    const previousBook = inheritedBaseline
        ? clone(inheritedBaseline.previousBook)
        : (typeof api.snapshotBook === 'function' ? clone(await api.snapshotBook(TEST_BOOK)) : undefined);
    const hadBookSnapshot = inheritedBaseline ? inheritedBaseline.hadBookSnapshot === true : previousBook !== undefined;

    await ensureIsolatedBook(TEST_BOOK);
    if (reset) await clearBook(TEST_BOOK);
    await api.enableBook?.(TEST_BOOK);
    await api.setBookReadWritePolicy?.(TEST_BOOK);

    const uidByLogicalId = {};
    for (const entry of LORE_ENTRIES) {
        const created = await createLoreEntry(TEST_BOOK, {
            title: entry.title,
            content: entry.content,
            keys: clone(entry.keys),
            logicalId: entry.logicalId,
        });
        const uid = Number(created?.uid);
        if (!Number.isFinite(uid)) throw new Error(`Seeder could not resolve UID for ${entry.logicalId}.`);
        uidByLogicalId[entry.logicalId] = uid;
        api.log?.('character-bank-fixture-entry-created', { logicalId: entry.logicalId, uid, title: entry.title });
    }

    const nodeByLogicalId = {};
    let nodeCounter = 0;
    const makeNode = (plan, path = []) => {
        const herePath = plan.label === 'Root' ? [] : [...path, plan.label];
        const node = {
            id: `tv2_test_charbank_node_${++nodeCounter}`,
            label: plan.label,
            summary: plan.summary || '',
            keywords: [],
            entryUids: [],
            children: [],
            collapsed: false,
        };
        for (const logicalId of plan.logicalEntries || []) {
            const uid = Number(uidByLogicalId[logicalId]);
            if (!Number.isFinite(uid)) throw new Error(`Tree plan references unresolved fixture entry ${logicalId}.`);
            node.entryUids.push(uid);
            nodeByLogicalId[logicalId] = { id: node.id, label: node.label, path: herePath };
        }
        node.children = (plan.children || []).map(child => makeNode(child, herePath));
        return node;
    };

    const tree = {
        lorebookName: TEST_BOOK,
        version: 2,
        lastBuilt: Date.now(),
        root: makeNode(TREE_PLAN),
    };
    await saveTree(TEST_BOOK, tree);

    const banks = buildResolvedCharacterBankSeeds(uidByLogicalId, nodeByLogicalId);
    if (banks.length !== 2 || banks.some(bank => bank.linkedRefs.length !== 5)) {
        throw new Error('Canonical Character Bank seed did not resolve exactly two banks with five linked refs each.');
    }
    await replaceCharacterBanks(banks);

    const session = {
        kind: 'nexus-character-bank-test-session',
        book: TEST_BOOK,
        entryCount: LORE_ENTRIES.length,
        bankCount: banks.length,
        uidByLogicalId,
        tree,
        banks,
        restore: {
            previousBanks,
            previousBook,
            hadBookSnapshot,
        },
    };
    api.log?.('character-bank-fixture-seeded', { book: TEST_BOOK, entryCount: session.entryCount, bankCount: session.bankCount });
    return session;
}

export async function restoreCharacterBankTestSession(api, session) {
    if (!validSession(session)) throw new Error('Invalid Character Bank test session.');
    const replaceCharacterBanks = assertFn(api, 'replaceCharacterBanks');
    await replaceCharacterBanks(clone(session.restore?.previousBanks || []));

    if (session.restore?.hadBookSnapshot) {
        if (typeof api.restoreBook !== 'function') throw new Error('A pre-existing test lorebook was snapshotted, but restoreBook() is unavailable.');
        await api.restoreBook(TEST_BOOK, clone(session.restore.previousBook));
    } else if (typeof api.removeBook === 'function') {
        await api.removeBook(TEST_BOOK);
    }

    api.log?.('character-bank-fixture-restored', { book: TEST_BOOK, restoredBankCount: session.restore?.previousBanks?.length || 0 });
    return true;
}

export async function resetCharacterBankTestWorld(api, session) {
    if (!validSession(session)) throw new Error('Reset requires the active Character Bank test session so the original operator baseline is preserved.');
    return seedCharacterBankTestWorld(api, { reset: true, baselineSession: session });
}
