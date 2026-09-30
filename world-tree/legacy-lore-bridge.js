import { getManagedBooks } from '../lore/active-books.js';
import { loadBook } from '../lore/store.js';
import { getTree } from '../tree/store.js';
import { logEvent } from '../observability/telemetry.js';
import { getNexusWorldTree } from './index.js';
import { importLegacyLoreCorpusToWorldTree } from './import-lore.js';

let cleanupFns=[];
let installed=false;
let syncPromise=null;
let pendingReason=null;
let lastSync=null;

function addWindowListener(type,handler){
  try{
    const target=globalThis.window;
    if(!target?.addEventListener)return()=>{};
    target.addEventListener(type,handler);
    return()=>{try{target.removeEventListener(type,handler);}catch{}};
  }catch{return()=>{};}
}

async function performSync(reason='manual'){
  const tree=getNexusWorldTree();
  const books=getManagedBooks({requireTree:false,access:'any',injection:'any'});
  try{
    const result=await importLegacyLoreCorpusToWorldTree(tree,{books,loadBook,getTree});
    lastSync=Object.freeze({kind:'NexusWorldTreeLegacyLoreSync',reason,at:Date.now(),books:[...result.books],results:result.results});
    logEvent('world-tree','legacy-lore-synced',{reason,books:[...result.books],count:result.books.length},'info');
    return lastSync;
  }catch(error){
    const failure=Object.freeze({kind:'NexusWorldTreeLegacyLoreSync',reason,at:Date.now(),error:error?.message||String(error)});
    lastSync=failure;
    logEvent('world-tree','legacy-lore-sync-failed',{reason,error:error?.message||String(error)},'warn');
    return failure;
  }
}

function scheduleSync(reason='legacy-lore-updated'){
  pendingReason=reason;
  if(syncPromise)return syncPromise;
  syncPromise=Promise.resolve().then(async()=>{
    let result=null;
    while(pendingReason){
      const next=pendingReason;pendingReason=null;
      result=await performSync(next);
    }
    return result;
  }).finally(()=>{syncPromise=null;});
  return syncPromise;
}

export function syncLegacyLoreToWorldTree(reason='manual'){
  return scheduleSync(reason);
}

export function installLegacyLoreWorldTreeBridge(){
  if(installed)return()=>uninstallLegacyLoreWorldTreeBridge();
  installed=true;
  cleanupFns=[
    addWindowListener('nexus-lore-source-updated',()=>scheduleSync('nexus-lore-source-updated')),
    addWindowListener('nexus-tree-routing-updated',()=>scheduleSync('nexus-tree-routing-updated')),
  ];
  void scheduleSync('bridge-installed');
  return()=>uninstallLegacyLoreWorldTreeBridge();
}

export function notifyWorldTreeLoreChanged(reason='host-world-info-updated'){
  return scheduleSync(reason);
}

export function uninstallLegacyLoreWorldTreeBridge(){
  for(const cleanup of cleanupFns.splice(0)){try{cleanup();}catch{}}
  installed=false;pendingReason=null;
  return true;
}

export function legacyLoreWorldTreeBridgeStatus(){
  return Object.freeze({kind:'NexusWorldTreeLegacyLoreBridgeStatus',installed,pending:Boolean(syncPromise),lastSync});
}
