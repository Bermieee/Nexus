import { loadBookOwner } from '../lore/store.js';
import { getTreeOwner } from '../tree/store.js';
import { logEvent } from '../observability/telemetry.js';
import { logSystemEvent } from '../observability/system-events.js';
import {getNexusWorldTreeOwner,readWorldTreeStoryBinding,requireWorldTreeStoryBinding} from './index.js';
import {importLegacyLoreBookToWorldTree} from './import-lore.js';
import { compareLoreReadParity } from './lore-read-parity.js';
import { setLoreReadAuthority, invalidateLoreReadAuthority, loreReadAuthorityStatus } from './lore-read-authority.js';

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
  const binding=readWorldTreeStoryBinding();
  if(!binding)return {kind:'NexusWorldTreeLegacyLoreSync',skipped:true,reason:'no-story-binding',books:[]};
  const tree=getNexusWorldTreeOwner();
  try{
    const data=await loadBookOwner(binding.book);
    const ownerTree=getTreeOwner(binding.book);
    requireWorldTreeStoryBinding({expected:binding});
    const before=compareLoreReadParity(tree,{book:binding.book,data,legacyTree:ownerTree});
    if(before.status!=='PASS'||before.controlMetadata!=='PASS')invalidateLoreReadAuthority(binding.book,'pre-import-parity-mismatch');
    const receipt=importLegacyLoreBookToWorldTree(tree,{book:binding.book,data,legacyTree:ownerTree});
    const after=compareLoreReadParity(tree,{book:binding.book,data,legacyTree:ownerTree});
    const loreReadAuthority=setLoreReadAuthority({book:binding.book,parity:after});
    for(const [phase,parity] of [['PRE_IMPORT',before],['POST_IMPORT',after]]){
      logSystemEvent('nexus.gather','lore.read-parity',{
        ...parity,phase,jobId:'lore-read-parity',verdict:parity.status,
        readersSwitched:phase==='POST_IMPORT'&&loreReadAuthority.readersSwitched===true,
        readAuthority:phase==='POST_IMPORT'?loreReadAuthority.authority:'OWNER_IMPORT',
      });
    }
    const result={books:[binding.book],results:[receipt]};
    lastSync=Object.freeze({
      kind:'NexusWorldTreeLegacyLoreSync',reason,at:Date.now(),books:[...result.books],results:result.results,
      loreParity:{before,after},loreReadAuthority,
    });
    logEvent('world-tree','legacy-lore-synced',{reason,books:[...result.books],count:result.books.length,readAuthority:loreReadAuthority.authority},'info');
    return lastSync;
  }catch(error){
    invalidateLoreReadAuthority(binding?.book??null,'sync-failed');
    const failure=Object.freeze({kind:'NexusWorldTreeLegacyLoreSync',reason,at:Date.now(),error:error?.message||String(error),loreReadAuthority:loreReadAuthorityStatus(binding?.book??null)});
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
    addWindowListener('tv2-story-scope-changed',()=>scheduleSync('story-binding-changed')),
  ];
  void scheduleSync('bridge-installed');
  return()=>uninstallLegacyLoreWorldTreeBridge();
}

export function notifyWorldTreeLoreChanged(reason='host-world-info-updated'){
  const binding=readWorldTreeStoryBinding();
  if(binding?.book)invalidateLoreReadAuthority(binding.book,reason);
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
