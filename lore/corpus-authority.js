import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { getActiveBooks, getManagedBooks, getStoryScopeStatus } from './active-books.js';

function clean(value){ return String(value ?? '').trim(); }
function unique(values=[]){ return [...new Set((Array.isArray(values)?values:[]).map(clean).filter(Boolean))]; }
function stable(value){
    if(Array.isArray(value))return value.map(stable);
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
    return value;
}

/**
 * Canonical lore-corpus authority for one Nexus operation.
 *
 * `books` is authoritative when supplied, including an explicit empty array.
 * Callers must never reinterpret [] as "discover books again" downstream.
 * Story-bound work uses Story Scope. Lore maintenance without an active chat is
 * deliberately limited to the operator-selected lorebook instead of silently
 * widening to every globally managed book.
 */
export function captureLoreCorpus({
    books = null,
    purpose = 'story',
    requireTree = false,
    access = 'read',
    injection = 'tv2',
    context = getContext(),
} = {}) {
    const explicit = Array.isArray(books);
    const chatId = context?.chatId ?? context?.chat_id ?? null;
    const managed = getManagedBooks({ requireTree, access, injection });
    const managedSet = new Set(managed);
    let source = 'story-scope';
    let selected;

    if(explicit){
        source = 'explicit';
        selected = unique(books).filter(name=>managedSet.has(name));
    }else if(purpose === 'maintenance' && chatId == null){
        source = 'selected-maintenance-book';
        const current = clean(getSettings()?.selectedLorebook);
        selected = current && managedSet.has(current) ? [current] : [];
    }else{
        selected = getActiveBooks({ requireTree, access, injection });
    }

    const story = getStoryScopeStatus();
    const normalized = unique(selected);
    const identity = stable({
        version: 1,
        source,
        purpose,
        chatId: chatId == null ? null : String(chatId),
        access,
        injection,
        requireTree: requireTree === true,
        books: normalized,
        storyRevision: Number(story?.revision)||0,
        storyMode: story?.mode||null,
    });
    return Object.freeze({ ...identity, books:Object.freeze([...normalized]), fingerprint:JSON.stringify(identity) });
}

export function loreCorpusBooks(options={}){ return [...captureLoreCorpus(options).books]; }
