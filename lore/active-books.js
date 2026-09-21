import { world_names, selected_world_info } from '../../../../world-info.js';
import { getSettings } from '../core/settings.js';
import { getTree } from '../tree/store.js';
import { canReadBook, canWriteBook, getBookInjectionMode, isBookEnabled } from './policy.js';
import { getCurrentStoryScope } from './story-scope.js';

/**
 * Return every lorebook Nexus is globally allowed to manage. This is a content-
 * management list, not a story/retrieval list.
 */
export function getManagedBooks({ requireTree = false, access = 'any', injection = 'any' } = {}) {
    const settings = getSettings();
    const host = new Set((Array.isArray(world_names)?world_names:[]).map(name=>String(name||'').trim()).filter(Boolean));
    const names = new Set();
    for (const name of selected_world_info || []) if (host.has(name) && settings.enabledLorebooks?.[name] !== false) names.add(name);
    for (const [name, enabled] of Object.entries(settings.enabledLorebooks || {})) if (enabled && host.has(name)) names.add(name);
    let list=[...names].filter(isBookEnabled);
    // A truthy persisted Tree shell is not retrieval-ready.  Require the
    // canonical root so bootstrap admission is not withdrawn during a partial
    // build/import before Tree Retrieval can actually resolve anything.
    if(requireTree)list=list.filter(name=>!!getTree(name)?.root);
    if(access==='read')list=list.filter(canReadBook);
    else if(access==='write')list=list.filter(canWriteBook);
    if(injection==='tv2')list=list.filter(name=>getBookInjectionMode(name)==='tv2');
    else if(injection==='st')list=list.filter(name=>getBookInjectionMode(name)==='st');
    return list;
}

/**
 * Return lorebooks legal for the CURRENT CHAT/STORY.
 *
 * Global enablement means "Nexus may manage this book". It does not mean the
 * book belongs to every story. Ambiguous multi-book installs fail closed until
 * the operator configures Story Scope.
 */
export function getActiveBooks({ requireTree = false, access = 'any', injection = 'any', ignoreStoryScope = false } = {}) {
    const managedAny = getManagedBooks({ requireTree:false, access:'any', injection:'any' });
    if (ignoreStoryScope) return getManagedBooks({ requireTree, access, injection });
    const scope = getCurrentStoryScope({ managedBooks: managedAny });
    const allowed = access === 'read'
        ? new Set(scope.readBooks || [])
        : access === 'write'
            ? new Set(scope.writeBooks || [])
            : new Set([...(scope.readBooks || []), ...(scope.writeBooks || [])]);
    return getManagedBooks({ requireTree, access, injection }).filter(name => allowed.has(name));
}

export function getStoryScopeStatus() {
    const managedBooks = getManagedBooks({ requireTree:false, access:'any', injection:'any' });
    return getCurrentStoryScope({ managedBooks });
}

export function isBookInCurrentStory(book, { access = 'any' } = {}) {
    const name = String(book || '').trim();
    if (!name) return false;
    const scope = getStoryScopeStatus();
    if (access === 'read') return scope.readBooks.includes(name);
    if (access === 'write') return scope.writeBooks.includes(name);
    return scope.readBooks.includes(name) || scope.writeBooks.includes(name);
}
