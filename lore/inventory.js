import { getContext } from '../../../../st-context.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { clearRetrievalState } from '../retrieval/state.js';
import { clearRetrievalPrompt } from '../retrieval/prompt-bridge.js';
import { invalidateSearchIndex } from '../retrieval/search-index-cache.js';
import { invalidateLorePaging } from '../paging/lore-runtime.js';
import { bumpNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';
import { logEvent } from '../observability/telemetry.js';
import { getManagedBooks } from './active-books.js';
import { configureCurrentStoryScope, storyScopeMetaKey } from './story-scope.js';
import { getHostLorebookNames } from './host-inventory.js';

const BOOK_MAPS = Object.freeze(['enabledLorebooks','bookPermissions','bookInjectionModes','bookDescriptions']);

function cleanName(value){ return String(value ?? '').trim(); }

/**
 * SillyTavern owns lorebook existence. Nexus may cache/index/configure a host
 * book, but stale Nexus state can never keep a deleted World Info book alive.
 */
export async function reconcileNexusLorebookInventory({reason='host-world-info-refresh'}={}){
    const hostNames=getHostLorebookNames(),host=new Set(hostNames),settings=getSettings();
    const candidates=new Set();
    for(const mapName of BOOK_MAPS) for(const name of Object.keys(settings?.[mapName]||{})) candidates.add(name);
    for(const name of Object.keys(settings?.trees||{})) candidates.add(name);
    for(const name of Object.keys(settings?.loreWriteValve?.books||{})) candidates.add(name);
    if(settings?.selectedLorebook) candidates.add(String(settings.selectedLorebook));
    const removed=[...candidates].map(cleanName).filter(name=>name&&!host.has(name)).sort((a,b)=>a.localeCompare(b));
    if(!removed.length) return {changed:false,removed:[],hostNames};

    updateSettings(s=>{
        for(const name of removed){
            for(const mapName of BOOK_MAPS){ if(s[mapName]&&typeof s[mapName]==='object') delete s[mapName][name]; }
            if(s.trees&&typeof s.trees==='object') delete s.trees[name];
            if(s.loreWriteValve?.books&&typeof s.loreWriteValve.books==='object') delete s.loreWriteValve.books[name];
        }
        if(s.selectedLorebook&&!host.has(cleanName(s.selectedLorebook))) s.selectedLorebook=hostNames[0]||null;
    });

    clearRetrievalPrompt({force:true});
    clearRetrievalState();
    for(const name of removed) invalidateSearchIndex(name);
    try{ invalidateLorePaging(`host-lorebook-pruned:${reason}`,{resetProvider:false}); }catch{}
    bumpNexusLoreSourceRevision({reason:`host-lorebook-pruned:${reason}`,broad:true});

    // Explicit Story Scope is durable chat authority. Re-save it only when its
    // raw projection still names a host-deleted book; normalization alone is not
    // enough because the stale name must not reappear if a future book reuses it.
    try{
        const context=getContext(),key=storyScopeMetaKey(),raw=context?.chatMetadata?.[key];
        if(raw?.configured===true){
            const rawNames=[...(raw.readBooks||[]),...(raw.writeBooks||[]),raw.primaryWriteBook].map(cleanName).filter(Boolean);
            if(rawNames.some(name=>!host.has(name))){
                const managedBooks=getManagedBooks({requireTree:false,access:'any',injection:'any'});
                const managed=new Set(managedBooks);
                const readBooks=(raw.readBooks||[]).map(cleanName).filter(name=>managed.has(name));
                const writeBooks=(raw.writeBooks||[]).map(cleanName).filter(name=>managed.has(name));
                const primary=writeBooks.includes(cleanName(raw.primaryWriteBook))?cleanName(raw.primaryWriteBook):(writeBooks[0]||null);
                await configureCurrentStoryScope({readBooks,writeBooks,primaryWriteBook:primary,reason:`host-prune:${reason}`},{managedBooks});
            }
        }
    }catch(error){
        // Runtime access already fails closed against the host inventory. A
        // metadata durability failure is observable but cannot resurrect books.
        logEvent('lore','host-inventory-scope-prune-failed',{reason,removed,error:error?.message||String(error)},'warn');
    }

    try{globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-lore-source-updated',{detail:{reason:`host-prune:${reason}`,removed:[...removed]}}));}catch{}
    logEvent('lore','host-inventory-pruned',{reason,removed,hostNames},'info');
    return {changed:true,removed,hostNames};
}
