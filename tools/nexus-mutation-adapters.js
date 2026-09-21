import { loadBook, findEntryByUid, clone } from '../lore/store.js';
import { getBookPermission, isBookEnabled, canWriteBook } from '../lore/policy.js';
import { getTree, treeBaseline } from '../tree/store.js';
import { currentNodeForUid } from '../tree/ops.js';
import { findNode } from '../tree/model.js';
import { createNexusToolMutationAdapterFactory } from './nexus-mutation-adapter-factory.js';
import { isBookInCurrentStory, getStoryScopeStatus } from '../lore/active-books.js';

/** Runtime-bound mutation adapters used by the Main → Nexus Function Gateway. */
export function createNexusToolMutationAdapters() {
    return createNexusToolMutationAdapterFactory({
        loadBook, findEntryByUid, clone,
        getBookPermission, isBookEnabled, canWriteBook,
        getTree, treeBaseline, currentNodeForUid, findNode, isBookInCurrentStory, getStoryScopeStatus,
    });
}
