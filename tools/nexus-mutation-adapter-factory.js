/**
 * Pure factory for Ledger-safe Main → Nexus mutation adapters. Runtime modules
 * inject SillyTavern/lore/proposal dependencies; smoke tests inject in-memory
 * dependencies so the complete adapter lifecycle can be exercised without ST.
 */
export function createNexusToolMutationAdapterFactory(deps = {}) {
    const {
        loadBook, findEntryByUid, clone, getBookPermission, isBookEnabled, canWriteBook,
        getTree, treeBaseline, currentNodeForUid, findNode, isBookInCurrentStory, getStoryScopeStatus,
    } = deps;
    const required = { loadBook, findEntryByUid, clone, getBookPermission, isBookEnabled, canWriteBook, getTree, treeBaseline, currentNodeForUid, findNode, isBookInCurrentStory, getStoryScopeStatus };
    for (const [name, fn] of Object.entries(required)) if (typeof fn !== 'function') throw new Error(`Nexus mutation adapter factory requires dependency: ${name}`);

    function assertFlatMutationArgs(args) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Nexus mutation arguments must be one flat object.');
        for (const [key,value] of Object.entries(args)) if (value !== null && typeof value === 'object') throw new TypeError(`Nexus mutation argument ${key} must be a scalar value, not a nested object/array.`);
        return args;
    }
    function text(value) { return String(value ?? '').trim(); }
    function uid(value) { const n = Number(value); return Number.isInteger(n) && n >= 0 ? n : null; }
    function boolean(value) { return value === true; }
    function bookName(args) { return text(args?.lorebook || args?.book); }
    function policySnapshot(book) {
        const scope=getStoryScopeStatus();
        const storyWritable=!!book&&isBookInCurrentStory(book,{access:'write'});
        return {
            enabled: isBookEnabled(book),
            permission: getBookPermission(book),
            storyWritable,
            storyScope:{configured:scope?.configured===true,mode:String(scope?.mode||''),revision:Number(scope?.revision)||0,writeBooks:[...(scope?.writeBooks||[])].map(String).sort()},
            writable: isBookEnabled(book) && canWriteBook(book) && storyWritable,
        };
    }
    function nodeExists(book, nodeId) {
        if (nodeId == null || nodeId === '') return true;
        const tree = getTree(book);
        return !!findNode(tree?.root, String(nodeId));
    }
    async function entrySnapshot(book, entryUid) {
        if (!book || entryUid == null) return null;
        try {
            const data = await loadBook(book);
            const entry = findEntryByUid(data.entries, entryUid);
            if (!entry) return null;
            return clone({
                uid: Number(entryUid),
                content: entry.content,
                comment: entry.comment,
                key: entry.key || [],
                disable: entry.disable === true,
                constant: entry.constant === true,
            });
        } catch {
            return null;
        }
    }
    function nodeSnapshot(book, entryUid) {
        if (!book || entryUid == null) return null;
        try { return currentNodeForUid(getTree(book), entryUid)?.id || null; } catch { return null; }
    }
    function validation(passed, reason = null, checks = {}) { return { passed, reason: passed ? null : reason, checks }; }

    function normalizeRemember(args = {}) {
        assertFlatMutationArgs(args);
        return {
            lorebook: bookName(args),
            title: text(args.title),
            content: text(args.content),
            nodeId: args.node_id == null ? null : text(args.node_id),
            constant: boolean(args.constant),
        };
    }
    async function rememberAssumptions(args = {}) {
        const draft = normalizeRemember(args);
        return {
            capability: 'remember',
            request: clone(draft),
            bookPolicy: policySnapshot(draft.lorebook),
            tree: treeBaseline(draft.lorebook),
            targetNodeExists: nodeExists(draft.lorebook, draft.nodeId),
        };
    }
    async function validateRemember(draft) {
        const checks = {
            book: !!draft.lorebook,
            title: !!draft.title,
            content: !!draft.content,
            writable: !!draft.lorebook && policySnapshot(draft.lorebook).writable,
            targetNode: !!draft.lorebook && nodeExists(draft.lorebook, draft.nodeId),
        };
        return validation(Object.values(checks).every(Boolean), 'Remember requires a writable Nexus lorebook, non-empty title/content, and a valid destination node.', checks);
    }

    function normalizeUpdate(args = {}) {
        assertFlatMutationArgs(args);
        const patch = {};
        for (const key of ['title', 'content', 'constant', 'disable']) if (args[key] !== undefined) patch[key] = args[key];
        if (args.node_id !== undefined) patch.targetNodeId = args.node_id === null ? null : text(args.node_id);
        return { lorebook: bookName(args), uid: uid(args.uid), patch };
    }
    async function updateAssumptions(args = {}) {
        const draft = normalizeUpdate(args);
        return {
            capability: 'update',
            request: clone(draft),
            bookPolicy: policySnapshot(draft.lorebook),
            sourceEntry: await entrySnapshot(draft.lorebook, draft.uid),
            sourceNodeId: nodeSnapshot(draft.lorebook, draft.uid),
            tree: draft.patch.targetNodeId !== undefined ? treeBaseline(draft.lorebook) : null,
            targetNodeExists: draft.patch.targetNodeId !== undefined ? nodeExists(draft.lorebook, draft.patch.targetNodeId) : true,
        };
    }
    async function validateUpdate(draft) {
        const source = await entrySnapshot(draft.lorebook, draft.uid);
        const checks = {
            book: !!draft.lorebook,
            uid: draft.uid != null,
            sourceExists: !!source,
            hasPatch: Object.keys(draft.patch || {}).length > 0,
            writable: !!draft.lorebook && policySnapshot(draft.lorebook).writable,
            targetNode: draft.patch?.targetNodeId === undefined || nodeExists(draft.lorebook, draft.patch.targetNodeId),
        };
        if (draft.patch?.content !== undefined) checks.content = !!text(draft.patch.content);
        if (draft.patch?.title !== undefined) checks.title = !!text(draft.patch.title);
        return validation(Object.values(checks).every(Boolean), 'Update requires an existing UID, a non-empty patch, writable lorebook access, and a valid requested Tree destination.', checks);
    }

    function normalizeDelete(args = {}) {
        assertFlatMutationArgs(args);
        return {
            lorebook: bookName(args),
            uid: uid(args.uid),
            hardDelete: boolean(args.hard_delete),
            reason: text(args.reason),
        };
    }
    async function deleteAssumptions(args = {}) {
        const draft = normalizeDelete(args);
        return {
            capability: 'delete',
            request: clone(draft),
            bookPolicy: policySnapshot(draft.lorebook),
            sourceEntry: await entrySnapshot(draft.lorebook, draft.uid),
            sourceNodeId: nodeSnapshot(draft.lorebook, draft.uid),
            tree: treeBaseline(draft.lorebook),
        };
    }
    async function validateDelete(draft) {
        const checks = {
            book: !!draft.lorebook,
            uid: draft.uid != null,
            sourceExists: !!(await entrySnapshot(draft.lorebook, draft.uid)),
            writable: !!draft.lorebook && policySnapshot(draft.lorebook).writable,
        };
        return validation(Object.values(checks).every(Boolean), 'Delete requires an existing UID in a writable Nexus lorebook.', checks);
    }

    function normalizeMerge(args = {}) {
        assertFlatMutationArgs(args);
        return {
            lorebook: bookName(args),
            keepUid: uid(args.keep_uid),
            removeUid: uid(args.remove_uid),
            title: args.merged_title === undefined ? undefined : text(args.merged_title),
            content: args.merged_content === undefined ? undefined : text(args.merged_content),
            hardDelete: boolean(args.hard_delete),
            treePolicy: args.tree_policy === undefined ? 'keep' : (['keep', 'removed'].includes(text(args.tree_policy)) ? text(args.tree_policy) : '__invalid__'),
            targetNodeId: args.target_node_id == null ? null : text(args.target_node_id),
        };
    }
    async function mergeAssumptions(args = {}) {
        const draft = normalizeMerge(args);
        return {
            capability: 'merge',
            request: clone(draft),
            bookPolicy: policySnapshot(draft.lorebook),
            keepEntry: await entrySnapshot(draft.lorebook, draft.keepUid),
            removeEntry: await entrySnapshot(draft.lorebook, draft.removeUid),
            keepNodeId: nodeSnapshot(draft.lorebook, draft.keepUid),
            removeNodeId: nodeSnapshot(draft.lorebook, draft.removeUid),
            tree: treeBaseline(draft.lorebook),
            targetNodeExists: nodeExists(draft.lorebook, draft.targetNodeId),
        };
    }
    async function validateMerge(draft) {
        const keep = await entrySnapshot(draft.lorebook, draft.keepUid);
        const remove = await entrySnapshot(draft.lorebook, draft.removeUid);
        const checks = {
            book: !!draft.lorebook,
            keepUid: draft.keepUid != null,
            removeUid: draft.removeUid != null,
            distinct: draft.keepUid != null && draft.removeUid != null && draft.keepUid !== draft.removeUid,
            keepExists: !!keep,
            removeExists: !!remove,
            writable: !!draft.lorebook && policySnapshot(draft.lorebook).writable,
            targetNode: nodeExists(draft.lorebook, draft.targetNodeId),
            treePolicy: ['keep','removed'].includes(draft.treePolicy),
        };
        if (draft.content !== undefined) checks.content = !!draft.content;
        return validation(Object.values(checks).every(Boolean), 'Merge requires two distinct existing UIDs in a writable lorebook and a valid Tree destination.', checks);
    }

    function normalizeSplit(args = {}) {
        assertFlatMutationArgs(args);
        return {
            lorebook: bookName(args),
            uid: uid(args.uid),
            keepTitle: args.keep_title === undefined ? undefined : text(args.keep_title),
            keepContent: text(args.keep_content),
            newTitle: text(args.new_title),
            newContent: text(args.new_content),
            newTargetNodeId: args.new_node_id == null ? null : text(args.new_node_id),
        };
    }
    async function splitAssumptions(args = {}) {
        const draft = normalizeSplit(args);
        return {
            capability: 'split',
            request: clone(draft),
            bookPolicy: policySnapshot(draft.lorebook),
            sourceEntry: await entrySnapshot(draft.lorebook, draft.uid),
            sourceNodeId: nodeSnapshot(draft.lorebook, draft.uid),
            tree: treeBaseline(draft.lorebook),
            targetNodeExists: nodeExists(draft.lorebook, draft.newTargetNodeId),
        };
    }
    async function validateSplit(draft) {
        const checks = {
            book: !!draft.lorebook,
            uid: draft.uid != null,
            sourceExists: !!(await entrySnapshot(draft.lorebook, draft.uid)),
            keepContent: !!draft.keepContent,
            newTitle: !!draft.newTitle,
            newContent: !!draft.newContent,
            writable: !!draft.lorebook && policySnapshot(draft.lorebook).writable,
            targetNode: nodeExists(draft.lorebook, draft.newTargetNodeId),
        };
        return validation(Object.values(checks).every(Boolean), 'Split requires an existing UID, non-empty keep/new content, a new title, writable lorebook access, and a valid destination node.', checks);
    }

    function normalizeOrganize(args = {}) {
        assertFlatMutationArgs(args);
        return {
            lorebook: bookName(args),
            action: text(args.action).toLowerCase(),
            uid: args.uid === undefined ? null : uid(args.uid),
            nodeId: args.node_id == null ? null : text(args.node_id),
            targetNodeId: args.target_node_id == null ? null : text(args.target_node_id),
            parentNodeId: args.parent_node_id == null ? null : text(args.parent_node_id),
            label: args.label === undefined ? undefined : text(args.label),
            summary: args.summary === undefined ? undefined : text(args.summary),
            deleteMode: args.delete_mode === undefined ? 'promote_children' : (['promote_children', 'move_entries_to_parent', 'delete_subtree'].includes(text(args.delete_mode)) ? text(args.delete_mode) : '__invalid__'),
        };
    }
    async function organizeAssumptions(args = {}) {
        const draft = normalizeOrganize(args);
        const moveEntry = draft.action === 'move_entry';
        return {
            capability: 'organize',
            request: clone(draft),
            bookPolicy: policySnapshot(draft.lorebook),
            sourceEntry: moveEntry ? await entrySnapshot(draft.lorebook, draft.uid) : null,
            sourceNodeId: moveEntry ? nodeSnapshot(draft.lorebook, draft.uid) : null,
            tree: treeBaseline(draft.lorebook),
        };
    }
    async function validateOrganize(draft) {
        const actions = new Set(['move_entry', 'create_category', 'rename_category', 'move_category', 'delete_category']);
        const tree = getTree(draft.lorebook);
        const exists = nodeId => !!findNode(tree?.root, nodeId);
        const checks = {
            book: !!draft.lorebook,
            action: actions.has(draft.action),
            writable: !!draft.lorebook && policySnapshot(draft.lorebook).writable,
        };
        if (draft.action === 'move_entry') {
            checks.uid = draft.uid != null;
            checks.sourceExists = !!(await entrySnapshot(draft.lorebook, draft.uid));
            checks.targetNode = !!draft.targetNodeId && exists(draft.targetNodeId);
        } else if (draft.action === 'create_category') {
            checks.label = !!draft.label;
            checks.parentNode = draft.parentNodeId == null || exists(draft.parentNodeId);
        } else if (draft.action === 'rename_category') {
            checks.node = !!draft.nodeId && exists(draft.nodeId);
            checks.patch = draft.label !== undefined || draft.summary !== undefined;
            if (draft.label !== undefined) checks.label = !!draft.label;
        } else if (draft.action === 'move_category') {
            checks.node = !!draft.nodeId && exists(draft.nodeId);
            checks.targetNode = !!draft.targetNodeId && exists(draft.targetNodeId);
            checks.distinct = draft.nodeId !== draft.targetNodeId;
        } else if (draft.action === 'delete_category') {
            checks.node = !!draft.nodeId && exists(draft.nodeId);
            checks.deleteMode = ['promote_children','move_entries_to_parent','delete_subtree'].includes(draft.deleteMode);
        }
        return validation(Object.values(checks).every(Boolean), 'Organize request references an invalid Tree operation, entry, category, or writable lorebook policy.', checks);
    }

    function descriptor({ execute, assumptions, validate: validateDraft, operation }) {
        return {
            execute: async args => execute(args),
            parse: value => clone(value),
            stage: value => clone(value),
            assumptions,
            validate: validateDraft,
            operation,
        };
    }

    /**
     * Main -> Nexus mutation adapters are pure staging + canonical-operation
     * builders. They never create/approve a Lore Proposal during an already
     * approved Function Gateway transaction.
     */
    function buildAdapters() {
        return {
            remember: descriptor({
                execute: normalizeRemember,
                assumptions: rememberAssumptions,
                validate: validateRemember,
                operation: (draft, assumptions) => ({
                    type: 'entry.create', book: draft.lorebook, title: draft.title, content: draft.content,
                    constant: draft.constant === true, targetNodeId: draft.nodeId || null, expectedTree: assumptions?.tree,
                }),
            }),
            update: descriptor({
                execute: normalizeUpdate,
                assumptions: updateAssumptions,
                validate: validateUpdate,
                operation: (draft, assumptions) => ({
                    type: 'entry.update', book: draft.lorebook, uid: Number(draft.uid), patch: clone(draft.patch || {}),
                    targetNodeId: draft.patch?.targetNodeId ?? undefined,
                    expected: clone(assumptions?.sourceEntry || null), expectedNodeId: assumptions?.sourceNodeId || null,
                    expectedTree: draft.patch?.targetNodeId !== undefined ? assumptions?.tree : undefined,
                }),
            }),
            delete: descriptor({
                execute: normalizeDelete,
                assumptions: deleteAssumptions,
                validate: validateDelete,
                operation: (draft, assumptions) => ({
                    type: 'entry.delete', book: draft.lorebook, uid: Number(draft.uid), hardDelete: draft.hardDelete === true,
                    reason: draft.reason || '', expected: clone(assumptions?.sourceEntry || null),
                    expectedNodeId: assumptions?.sourceNodeId || null, expectedTree: assumptions?.tree,
                }),
            }),
            merge: descriptor({
                execute: normalizeMerge,
                assumptions: mergeAssumptions,
                validate: validateMerge,
                operation: (draft, assumptions) => ({
                    type: 'entry.merge', book: draft.lorebook, keepUid: Number(draft.keepUid), removeUid: Number(draft.removeUid),
                    title: draft.title, content: draft.content, hardDelete: draft.hardDelete === true,
                    treePolicy: draft.treePolicy || 'keep', targetNodeId: draft.targetNodeId || null,
                    expectedKeep: clone(assumptions?.keepEntry || null), expectedRemove: clone(assumptions?.removeEntry || null),
                    expectedTree: assumptions?.tree,
                }),
            }),
            split: descriptor({
                execute: normalizeSplit,
                assumptions: splitAssumptions,
                validate: validateSplit,
                operation: (draft, assumptions) => ({
                    type: 'entry.split', book: draft.lorebook, uid: Number(draft.uid), keepTitle: draft.keepTitle,
                    keepContent: draft.keepContent, newTitle: draft.newTitle, newContent: draft.newContent,
                    newTargetNodeId: draft.newTargetNodeId || null, expected: clone(assumptions?.sourceEntry || null),
                    expectedNodeId: assumptions?.sourceNodeId || null, expectedTree: assumptions?.tree,
                }),
            }),
            organize: descriptor({
                execute: normalizeOrganize,
                assumptions: organizeAssumptions,
                validate: validateOrganize,
                operation: (draft, assumptions) => {
                    if (draft.action === 'move_entry') return { type: 'entry.move', book: draft.lorebook, uid: Number(draft.uid), targetNodeId: draft.targetNodeId, expected: clone(assumptions?.sourceEntry || null), expectedNodeId: assumptions?.sourceNodeId || null, expectedTree: assumptions?.tree };
                    if (draft.action === 'create_category') return { type: 'tree.node.create', book: draft.lorebook, label: draft.label, summary: draft.summary || '', parentNodeId: draft.parentNodeId || null, expectedTree: assumptions?.tree };
                    if (draft.action === 'rename_category') return { type: 'tree.node.rename', book: draft.lorebook, nodeId: draft.nodeId, label: draft.label, summary: draft.summary, expectedTree: assumptions?.tree };
                    if (draft.action === 'move_category') return { type: 'tree.node.move', book: draft.lorebook, nodeId: draft.nodeId, newParentNodeId: draft.targetNodeId, expectedTree: assumptions?.tree };
                    if (draft.action === 'delete_category') return { type: 'tree.node.delete', book: draft.lorebook, nodeId: draft.nodeId, mode: draft.deleteMode || 'promote_children', expectedTree: assumptions?.tree };
                    throw new Error(`Unknown organize action: ${draft.action}`);
                },
            }),
        };
    }
    return buildAdapters();
}
