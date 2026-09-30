import { getSettings } from '../core/settings.js';
import { clone, createTree, normalizeTree, semanticSnapshot } from './model.js';
import { logEvent } from '../observability/telemetry.js';
import { clearRetrievalState } from '../retrieval/state.js';
import { invalidateSearchIndex } from '../retrieval/search-index-cache.js';
import { clearRetrievalPrompt } from '../retrieval/prompt-bridge.js';
import { bumpNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';
import {
    getGlobalWorldTreeDocument,
    mutateGlobalWorldTreeDocumentDirect,
} from '../nexus/world-tree-store.js';
import {
    deleteLoreTreeFromWorldTreeDocument,
    replaceLoreTreeInWorldTreeDocument,
    worldTreeDocumentToLegacyTree,
} from '../nexus/a52/shared/world-tree-tree-codec.js';

function legacyTreeBooks(){
    return Object.keys(getSettings().trees||{}).filter(Boolean);
}

function migrateLegacyTrees(onlyBooks=null){
    const settings=getSettings();
    const existing=getGlobalWorldTreeDocument();
    const requested=onlyBooks==null?legacyTreeBooks():(Array.isArray(onlyBooks)?onlyBooks:[onlyBooks]).map(String);
    const books=requested.filter(book=>settings.trees?.[book]);
    if(!books.length)return false;
    const migrated=[],discarded=[];
    mutateGlobalWorldTreeDocumentDirect((working,liveSettings)=>{
        let doc=working;
        for(const book of books){
            const legacy=liveSettings.trees?.[book];
            if(!legacy)continue;
            if(doc.roots?.lore?.[book]){
                discarded.push(book);
                continue;
            }
            const tree=normalizeTree(clone(legacy),book);
            doc=replaceLoreTreeInWorldTreeDocument(doc,book,tree);
            migrated.push(book);
        }
        return doc;
    },{reason:'legacy-nexus-tree-migration',legacyTreeBooks:books});
    if(migrated.length||discarded.length){
        logEvent('world-tree','legacy-tree-store-retired',{
            migratedBooks:migrated,
            discardedLegacyMirrors:discarded,
            runtimeRemoved:'settings.trees',
            authority:'settings.worldTree',
        },'info');
    }
    return migrated.length>0||discarded.length>0;
}

function ensureBookMigrated(book){
    const name=String(book||'').trim();
    if(!name)return false;
    if(getGlobalWorldTreeDocument().roots?.lore?.[name]){
        if(getSettings().trees?.[name])migrateLegacyTrees([name]);
        return true;
    }
    migrateLegacyTrees([name]);
    return !!getGlobalWorldTreeDocument().roots?.lore?.[name];
}

export function initTreeStore(){
    getSettings();
    migrateLegacyTrees();
}

export function hasTree(book){
    const name=String(book||'').trim();
    if(!name)return false;
    ensureBookMigrated(name);
    return !!getGlobalWorldTreeDocument().roots?.lore?.[name];
}

export function getTree(book){
    const name=String(book||'').trim();
    if(!name)return null;
    ensureBookMigrated(name);
    const tree=worldTreeDocumentToLegacyTree(getGlobalWorldTreeDocument(),name);
    return tree?normalizeTree(clone(tree),name):null;
}

export function ensureTree(book){
    const existing=getTree(book);
    if(existing)return existing;
    const tree=createTree(book);
    setTreeDirect(book,tree);
    logEvent('tree','created',{book,rootId:tree.root?.id||null,store:'world-tree'},'info');
    return clone(tree);
}

/** Executor/internal persistence only. Tools must stage proposals instead. */
export function setTreeDirect(book,tree,{invalidateRetrieval=true,invalidateSearch=true,mutationKind='semantic'}={}){
    const name=String(book||'').trim();
    if(!name)throw new Error('Tree save requires a lorebook name.');
    const copy=normalizeTree(clone(tree),name);
    copy.lastBuilt=Date.now();
    mutateGlobalWorldTreeDocumentDirect(
        document=>replaceLoreTreeInWorldTreeDocument(document,name,copy),
        {reason:`lore-tree-save:${mutationKind}`,legacyTreeBooks:[name]},
    );
    if(invalidateRetrieval){clearRetrievalPrompt({force:true});clearRetrievalState();}
    if(invalidateSearch)invalidateSearchIndex(name);
    bumpNexusLoreSourceRevision({book:name,reason:`world-tree-saved:${mutationKind}`});
    if(mutationKind==='semantic'){
        try{globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-tree-routing-updated',{detail:{book:name}}));}catch{}
    }
    logEvent('tree','saved',{book:name,lastBuilt:copy.lastBuilt,rootId:copy.root?.id||null,mutationKind,invalidateRetrieval,invalidateSearch,store:'world-tree'},'debug');
    return getTree(name);
}

/** Executor/internal persistence only. */
export function deleteTreeDirect(book){
    const name=String(book||'').trim();
    if(!name)return;
    mutateGlobalWorldTreeDocumentDirect(
        document=>deleteLoreTreeFromWorldTreeDocument(document,name),
        {reason:'lore-tree-delete',legacyTreeBooks:[name]},
    );
    clearRetrievalPrompt({force:true});
    clearRetrievalState();
    invalidateSearchIndex(name);
    bumpNexusLoreSourceRevision({book:name,reason:'world-tree-deleted'});
    logEvent('tree','deleted',{book:name,store:'world-tree'},'warn');
}

export function treeBaseline(book){return semanticSnapshot(getTree(book));}

/**
 * Internal bundle persistence projection. The legacy Tree shape remains an API
 * projection only; the complete bundle is committed to the World Tree document
 * in one synchronous settings mutation.
 */
export function setTreeBundleDirect(rows=[],{mutationKind='semantic'}={}){
    const input=Array.isArray(rows)?rows:[];
    const seen=new Set(),now=Date.now();
    const prepared=input.map(row=>{
        const book=String(row?.book||'').trim();
        if(!book)throw new Error('Tree bundle persistence requires an explicit lorebook for every row.');
        if(seen.has(book))throw new Error(`Tree bundle persistence received duplicate lorebook "${book}".`);
        seen.add(book);
        if(row?.tree==null)return{book,tree:null};
        const tree=normalizeTree(clone(row.tree),book);
        tree.lastBuilt=now;
        return{book,tree};
    });
    mutateGlobalWorldTreeDocumentDirect(document=>{
        let next=document;
        for(const row of prepared){
            next=row.tree==null
                ?deleteLoreTreeFromWorldTreeDocument(next,row.book)
                :replaceLoreTreeInWorldTreeDocument(next,row.book,row.tree);
        }
        return next;
    },{reason:`lore-tree-bundle:${mutationKind}`,legacyTreeBooks:prepared.map(row=>row.book)});
    clearRetrievalPrompt({force:true});
    clearRetrievalState();
    for(const row of prepared){
        invalidateSearchIndex(row.book);
        bumpNexusLoreSourceRevision({book:row.book,reason:`${row.tree==null?'world-tree-bundle-delete':'world-tree-bundle-save'}:${mutationKind}`});
        if(mutationKind==='semantic'){
            try{globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-tree-routing-updated',{detail:{book:row.book}}));}catch{}
        }
        logEvent('tree',row.tree==null?'deleted':'saved',{book:row.book,lastBuilt:row.tree?.lastBuilt||null,rootId:row.tree?.root?.id||null,mutationKind,bundle:true,store:'world-tree'},row.tree==null?'warn':'debug');
    }
    return prepared.map(row=>({book:row.book,tree:row.tree==null?null:getTree(row.book)}));
}
