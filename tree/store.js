import { getSettings, updateSettings } from '../core/settings.js';
import { clone, createTree, normalizeTree, semanticSnapshot } from './model.js';
import { logEvent } from '../observability/telemetry.js';
import { clearRetrievalState } from '../retrieval/state.js';
import { invalidateSearchIndex } from '../retrieval/search-index-cache.js';
import { clearRetrievalPrompt } from '../retrieval/prompt-bridge.js';
import { bumpNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';

export function initTreeStore() { getSettings(); }

export function hasTree(book) {
    return !!getSettings().trees?.[String(book || '')];
}

export function getTree(book) {
    const raw = getSettings().trees?.[book];
    return raw ? normalizeTree(clone(raw), book) : null;
}

export function ensureTree(book) {
    const existing = getTree(book);
    if (existing) return existing;
    const tree = createTree(book);
    setTreeDirect(book, tree);
    logEvent('tree','created',{book,rootId:tree.root?.id||null},'info');
    return clone(tree);
}

/** Executor/internal persistence only. Tools must stage proposals instead. */
export function setTreeDirect(book, tree, { invalidateRetrieval = true, invalidateSearch = true, mutationKind = 'semantic' } = {}) {
    const copy = normalizeTree(clone(tree), book);
    copy.lastBuilt = Date.now();
    updateSettings(settings => { settings.trees[book] = copy; });
    if (invalidateRetrieval) { clearRetrievalPrompt({force:true}); clearRetrievalState(); }
    if (invalidateSearch) invalidateSearchIndex(book);
    bumpNexusLoreSourceRevision({book,reason:`tree-saved:${mutationKind}`});
    if (mutationKind === 'semantic') {
        try { globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-tree-routing-updated',{detail:{book}})); } catch {}
    }
    logEvent('tree','saved',{book,lastBuilt:copy.lastBuilt,rootId:copy.root?.id||null,mutationKind,invalidateRetrieval,invalidateSearch},'debug');
    return clone(copy);
}

/** Executor/internal persistence only. */
export function deleteTreeDirect(book) {
    updateSettings(settings => { delete settings.trees[book]; });
    clearRetrievalPrompt({force:true});
    clearRetrievalState();
    invalidateSearchIndex(book);
    bumpNexusLoreSourceRevision({book,reason:'tree-deleted'});
    logEvent('tree','deleted',{book},'warn');
}

export function treeBaseline(book) { return semanticSnapshot(getTree(book)); }

/**
 * Internal bundle persistence projection. Every Tree in the bundle is applied
 * to the in-memory Nexus settings object in one synchronous settings mutation,
 * so the host durability barrier can prove the complete bundle projection
 * without ever exposing a deliberately partial Nexus settings state.
 */
export function setTreeBundleDirect(rows = [], { mutationKind = 'semantic' } = {}) {
    const input = Array.isArray(rows) ? rows : [];
    const seen = new Set();
    const now = Date.now();
    const prepared = input.map(row => {
        const book = String(row?.book || '').trim();
        if (!book) throw new Error('Tree bundle persistence requires an explicit lorebook for every row.');
        if (seen.has(book)) throw new Error(`Tree bundle persistence received duplicate lorebook "${book}".`);
        seen.add(book);
        if (row?.tree == null) return { book, tree: null };
        const tree = normalizeTree(clone(row.tree), book);
        tree.lastBuilt = now;
        return { book, tree };
    });
    updateSettings(settings => {
        settings.trees = settings.trees || {};
        for (const row of prepared) {
            if (row.tree == null) delete settings.trees[row.book];
            else settings.trees[row.book] = clone(row.tree);
        }
    });
    clearRetrievalPrompt({force:true});
    clearRetrievalState();
    for (const row of prepared) {
        invalidateSearchIndex(row.book);
        bumpNexusLoreSourceRevision({book:row.book,reason:`${row.tree==null?'tree-bundle-delete':'tree-bundle-save'}:${mutationKind}`});
        if (mutationKind === 'semantic') {
            try { globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-tree-routing-updated',{detail:{book:row.book}})); } catch {}
        }
        logEvent('tree', row.tree == null ? 'deleted' : 'saved', { book: row.book, lastBuilt: row.tree?.lastBuilt || null, rootId: row.tree?.root?.id || null, mutationKind, bundle: true }, row.tree == null ? 'warn' : 'debug');
    }
    return prepared.map(row => ({ book: row.book, tree: clone(row.tree) }));
}
