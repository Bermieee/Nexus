import { extension_settings } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { getSettings, updateSettings, flushSettingsPersistence } from './core/settings.js';
import { normalizeImportedNexusSettings } from './core/settings-migrations.js';
import { normalizeTree, clone } from './tree/model.js';
import { logEvent } from './observability/telemetry.js';
import { exportSmartContextState, importSmartContextState, previewSmartContextStateImport, invalidateSmartContext } from './smart-context/warmer.js';
import { exportMemoryBank, importMemoryBank, previewMemoryBankImport } from './memory/store.js';
import { loadBook } from './lore/store.js';
import { clearRetrievalState } from './retrieval/state.js';
import { clearBootstrapAdmission } from './retrieval/bootstrap-admission.js';
import { clearSearchIndexCache } from './retrieval/search-index-cache.js';
import { flushChatMetadataPersistence } from './nexus/host-durability.js';
import {
    createImportRecoveryRecord,
    createImportRecoveryReservation,
    completeImportRecoveryReservation,
    executeCrashSafeImport,
    classifyImportRecovery,
    IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY,
    IMPORT_RECOVERY_SETTINGS_KEY,
    importUserSettingsProjection,
    preserveImportRecoveryJournal,
    reconcileImportRecovery,
    stripImportRecoveryJournalFromPayload,
} from './nexus/import-recovery-journal.js';
import {
    buildTv2BackupPayload,
    deepClone,
    translateTv1Settings,
    unwrapImportPayload,
    assertSafeImportPayload,
    assertSupportedTv2BackupSchema,
} from './migration-codec.js';

const TV2_VERSION = '0.6.2';

function invalidateImportedRetrievalAuthority(reason='migration-import') {
    clearRetrievalState();
    clearBootstrapAdmission({force:true});
    clearSearchIndexCache();
    invalidateSmartContext(reason);
    try { globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-lore-authority-changed',{detail:{reason}})); } catch {}
}


function sourceTv1Settings() {
    return extension_settings?.tunnelvision || null;
}

export function getTunnelVisionMigrationPreview(){
    const source=sourceTv1Settings();
    if(!source)return{available:false,trees:0,sidecar:false};
    const translated=translateTv1Settings(source);
    return{
        available:true,
        trees:Object.keys(source.trees||{}).length,
        sidecar:!!source.sidecarProfile?.endpoint,
        enabledLorebooks:Object.keys(source.enabledLorebooks||{}).filter(k=>source.enabledLorebooks[k]).length,
        retrieval:source.sidecarAutoRetrieval===true,
        smartContext:source.smartContextEnabled===true,
        postTurn:source.postTurnEnabled===true||source.sidecarPostGenWriter===true,
        skipped:translated.skipped,
    };
}


function redactImportPreviewSecrets(value){
    if(Array.isArray(value))return value.map(redactImportPreviewSecrets);
    if(!value||typeof value!=='object')return value;
    const out={};
    for(const [key,item] of Object.entries(value)){
        if(/^(?:apiKey|token|accessToken|refreshToken|password|secret)$/i.test(key)){out[key]=item?'[configured secret — value hidden]':'';continue;}
        out[key]=redactImportPreviewSecrets(item);
    }
    return out;
}

export async function previewTunnelVisionBaseline({importSidecar=true,overwrite=false,treesOnly=false}={}){
    const source=sourceTv1Settings();
    if(!source)throw new Error('No TunnelVision/TV1 settings were found.');
    const translated=translateTv1Settings(source);
    const reconciled=await reconcileImportedTrees(translated.mapped.trees||{});
    const mapped=deepClone(translated.mapped);mapped.trees=reconciled.trees;
    const before=importUserSettingsProjection(deepClone(getSettings()));
    const after=deepClone(before);
    const report=applyMappedTv1(after,mapped,{overwrite,importSidecar,treesOnly});
    return {source:'installed-tv1',overwrite,treesOnly,report:{...report,danglingTreeRefsPruned:reconciled.removed,skipped:translated.skipped},before:redactImportPreviewSecrets(before),after:redactImportPreviewSecrets(after)};
}

export async function previewTv2OrTv1Import(payload,{mode='merge',importSidecar=true,importChatPins=true}={}){
    assertSafeImportPayload(payload);assertSupportedTv2BackupSchema(payload);
    const detected=unwrapImportPayload(payload);
    if(detected.kind==='unknown')throw new Error('Unrecognized import file. Expected a Nexus backup/settings file or a compatible legacy settings JSON.');
    const before=importUserSettingsProjection(deepClone(getSettings()));
    if(detected.kind==='tv1'){
        const translated=translateTv1Settings(detected.data);
        const reconciled=await reconcileImportedTrees(translated.mapped.trees||{});
        const mapped=deepClone(translated.mapped);mapped.trees=reconciled.trees;
        const after=deepClone(before);const report=applyMappedTv1(after,mapped,{overwrite:mode==='replace',importSidecar});
        return {kind:'tv1',mode,report:{...report,danglingTreeRefsPruned:reconciled.removed,skipped:translated.skipped},settingsBefore:redactImportPreviewSecrets(before),settingsAfter:redactImportPreviewSecrets(after),chatBefore:null,chatAfter:null};
    }
    const backup=detected.kind==='tv2-backup'?detected.data:null;
    let incoming=backup?backup.settings:detected.data;
    incoming=stripImportRecoveryJournalFromPayload(deepClone(incoming||{}));
    normalizeImportedNexusSettings(incoming?.nexus);
    const reconciled=await reconcileImportedTrees(incoming.trees||{});if(incoming.trees)incoming.trees=reconciled.trees;
    const after=deepClone(before),prepared=deepClone(incoming);
    if(!importSidecar){if(mode==='replace')prepared.sidecars=deepClone(before.sidecars||{});else delete prepared.sidecars;}
    mergeImportedSettings(after,prepared,{replace:mode==='replace'});delete after[IMPORT_RECOVERY_SETTINGS_KEY];
    let chatBefore=null,chatAfter=null;
    const wantsChatState=!!(importChatPins&&backup?.chatState&&(backup.chatState.smartContext||backup.chatState.memoryBank));
    if(wantsChatState){const context=getContext();if(!context?.chatMetadata)throw new Error('An active chat is required before importing chat-scoped Smart Context or Memory Bank state.');chatBefore=currentImportChatProjection(context);chatAfter=previewImportedChatProjection(backup,mode,context,Date.now());}
    return {kind:detected.kind,mode,danglingTreeRefsPruned:reconciled.removed,settingsBefore:redactImportPreviewSecrets(before),settingsAfter:redactImportPreviewSecrets(after),chatBefore:redactImportPreviewSecrets(chatBefore),chatAfter:redactImportPreviewSecrets(chatAfter),secretsHidden:true};
}

function isEmptySidecar(profile) {
    return !profile?.endpoint && !profile?.model && !profile?.apiKey;
}

function pruneTreeToValidUids(tree, validUids) {
    const copy=normalizeTree(clone(tree),tree?.lorebookName||'');
    let removed=0;
    const walk=node=>{node.entryUids=(node.entryUids||[]).filter(uid=>{const keep=validUids.has(Number(uid));if(!keep)removed++;return keep;});for(const child of node.children||[])walk(child);};
    walk(copy.root);
    return {tree:copy,removed};
}

async function reconcileImportedTrees(trees={}) {
    const out={};let removed=0;
    for(const [book,tree] of Object.entries(trees||{})){
        const normalized=normalizeTree(clone(tree),book);
        const uids=[];const collect=node=>{uids.push(...(node.entryUids||[]));for(const child of node.children||[])collect(child);};collect(normalized.root);
        if(!uids.length){out[book]=normalized;continue;}
        const data=await loadBook(book);
        const valid=new Set(Object.values(data?.entries||{}).map(entry=>Number(entry?.uid)).filter(Number.isFinite));
        const reconciled=pruneTreeToValidUids(normalized,valid);out[book]=reconciled.tree;removed+=reconciled.removed;
    }
    return {trees:out,removed};
}

function applyMappedTv1(target, mapped, { overwrite = false, importSidecar = true, treesOnly = false } = {}) {
    const report = { trees: 0, treesSkipped: 0, enabledLorebooks: 0, sidecarImported: false, settingsImported: [] };
    target.trees ||= {};
    for (const [book, tree] of Object.entries(mapped.trees || {})) {
        if (!overwrite && target.trees[book]) { report.treesSkipped++; continue; }
        target.trees[book] = normalizeTree(clone(tree), book);
        report.trees++;
    }
    target.enabledLorebooks ||= {};
    for (const [book, enabled] of Object.entries(mapped.enabledLorebooks || {})) {
        if (!overwrite && target.enabledLorebooks[book] !== undefined) continue;
        target.enabledLorebooks[book] = !!enabled;
        report.enabledLorebooks++;
    }
    if ((overwrite || !target.selectedLorebook) && mapped.selectedLorebook) target.selectedLorebook = mapped.selectedLorebook;
    // Full migration imports compatible behavior settings. Tree Workspace can
    // request treesOnly so a structural import never unexpectedly changes runtime
    // retrieval, Smart Context, or post-turn behavior.
    if (!treesOnly) {
        target.enabled = mapped.enabled; report.settingsImported.push('enabled');

        target.retrieval ||= {};
        target.retrieval.enabled = mapped.retrieval.enabled;
        target.retrieval.contextMessages = mapped.retrieval.contextMessages;
        target.retrieval.regionPreviewDepth = mapped.retrieval.regionPreviewDepth;
        report.settingsImported.push('retrieval.enabled','retrieval.contextMessages','retrieval.regionPreviewDepth');

        target.smartContext ||= {};
        target.smartContext.enabled = mapped.smartContext.enabled;
        target.smartContext.contextMessages = mapped.smartContext.contextMessages;
        report.settingsImported.push('smartContext.enabled','smartContext.contextMessages');

        target.postTurn ||= {};
        target.postTurn.enabled = mapped.postTurn.enabled;
        target.postTurn.contextMessages = mapped.postTurn.contextMessages;
        report.settingsImported.push('postTurn.enabled','postTurn.contextMessages');
    }

    if (importSidecar && !treesOnly) {
        target.sidecars ||= {};
        if (overwrite || isEmptySidecar(target.sidecars.A)) {
            target.sidecars.A = { ...(target.sidecars.A || {}), ...deepClone(mapped.sidecarA) };
            report.sidecarImported = !!mapped.sidecarA.endpoint || !!mapped.sidecarA.model;
        }
    }
    return report;
}

/** Explicit, non-destructive migration from the currently installed TV1. */
export async function importTunnelVisionBaseline({importSidecar=true,overwrite=false,treesOnly=false}={}){

    return await withImportRecoveryLock(async()=>{
        assertNoImportRecoveryFence();
        const source=sourceTv1Settings();
        if(!source)throw new Error('No TunnelVision/TV1 settings were found.');
        const reservation=createImportRecoveryReservation({id:importOperationId(),targetChatId:null,mode:overwrite?'replace':'merge',at:Date.now()});
        await writeImportRecoveryJournal(reservation,{ownerToken:reservation.ownerToken,expectedRevision:0});
        try{
            const translated=translateTv1Settings(source);
            const reconciled=await reconcileImportedTrees(translated.mapped.trees||{});
            translated.mapped.trees=reconciled.trees;
            const settingsBefore=importUserSettingsProjection(deepClone(getSettings()));
            const settingsAfter=deepClone(settingsBefore);
            const report=applyMappedTv1(settingsAfter,translated.mapped,{overwrite,importSidecar,treesOnly});
            const record=completeImportRecoveryReservation(reservation,{targetChatId:null,mode:overwrite?'replace':'merge',settingsBefore,settingsAfter,includesChatState:false});
            await executeCrashSafeImport(record,importRecoveryAdapters(getContext()));
            report.danglingTreeRefsPruned=reconciled.removed;
            invalidateImportedRetrievalAuthority('tv1-import');
            const result={...report,source:'installed-tv1',overwrite,treesOnly,skipped:translated.skipped,recoverySaga:true,operationId:record.id};
            logEvent('migration','tv1-import-complete',result,'info');
            return result;
        }catch(error){
            const live=getSettings()?.[IMPORT_RECOVERY_SETTINGS_KEY];
            if(String(live?.id||'')===String(reservation.id)&&String(live?.phase||'')==='reserved'){
                try{await clearImportRecoveryJournal(reservation.id,{ownerToken:reservation.ownerToken,expectedRevision:live.revision});}catch{}
            }
            invalidateImportedRetrievalAuthority(error?.tv2RollbackRestored===true?'tv1-import-rolled-back':'tv1-import-recovery-required');
            throw error;
        }
    });

}

export function createTv2Backup({includeSecrets=false,includeCurrentChatPins=true,includeCurrentChatMemory=false}={}) {
    const settings=getSettings();
    const chatState=(includeCurrentChatPins||includeCurrentChatMemory) ? {
        chatId:String(getContext()?.chatId ?? getContext()?.chat_id ?? ''),
        smartContext:includeCurrentChatPins?exportSmartContextState({manualOnly:true}):null,
        memoryBank:includeCurrentChatMemory?exportMemoryBank():null,
    } : null;
    const payload=buildTv2BackupPayload({settings:importUserSettingsProjection(settings),includeSecrets,chatState,extensionVersion:TV2_VERSION});
    logEvent('migration','tv2-backup-created',{
        includeSecrets,
        includeCurrentChatPins,
        includeCurrentChatMemory,
        trees:Object.keys(settings.trees||{}).length,
        sidecarAConfigured:!!settings.sidecars?.A?.endpoint,
        sidecarBConfigured:!!settings.sidecars?.B?.endpoint,
    },'info');
    return payload;
}

function mergeImportedSettings(target, incoming, {replace=false}={}) {
    assertSafeImportPayload(incoming);
    const liveJournal=target&&Object.prototype.hasOwnProperty.call(target,IMPORT_RECOVERY_SETTINGS_KEY)?deepClone(target[IMPORT_RECOVERY_SETTINGS_KEY]):undefined;
    const deferredRecoveries=target&&Object.prototype.hasOwnProperty.call(target,IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY)?deepClone(target[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY]):undefined;
    // Mutation authority is local operator state, not portable configuration.
    // Backups may describe ordinary runtime settings, but importing one must
    // never silently grant Main mutation access or switch the Write Valve.
    const localAuthority={
        callCenter:deepClone(target?.nexus?.callCenter),
        loreWriteValve:deepClone(target?.loreWriteValve),
    };
    const clean=stripImportRecoveryJournalFromPayload(deepClone(incoming||{}));
    for(const [book,tree] of Object.entries(clean.trees||{})) clean.trees[book]=normalizeTree(tree,book);
    if(replace){
        const localKeys={A:String(target.sidecars?.A?.apiKey||''),B:String(target.sidecars?.B?.apiKey||'')};
        const localTypeSafeKey=String(target.decisionCore?.typeSafe?.apiKey||'');
        for(const key of Object.keys(target)) delete target[key];
        Object.assign(target,clean);
        target.sidecars ||= {};
        for(const slot of ['A','B']) if(target.sidecars?.[slot]&&String(target.sidecars[slot].apiKey||'')===''&&localKeys[slot]) target.sidecars[slot].apiKey=localKeys[slot];
        if(target.decisionCore?.typeSafe&&String(target.decisionCore.typeSafe.apiKey||'')===''&&localTypeSafeKey) target.decisionCore.typeSafe.apiKey=localTypeSafeKey;
        target.nexus ||= {};
        if(localAuthority.callCenter!==undefined)target.nexus.callCenter=deepClone(localAuthority.callCenter);
        if(localAuthority.loreWriteValve!==undefined)target.loreWriteValve=deepClone(localAuthority.loreWriteValve);
        if(liveJournal!==undefined)target[IMPORT_RECOVERY_SETTINGS_KEY]=liveJournal;else delete target[IMPORT_RECOVERY_SETTINGS_KEY];
        if(deferredRecoveries!==undefined)target[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY]=deferredRecoveries;else delete target[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY];
        return;
    }
    // Merge mode: incoming backup wins for normal config, but an intentionally
    // redacted/blank API key never erases a key already configured locally.
    const merge=(dst,src,path=[])=>{
        for(const [key,value] of Object.entries(src||{})){
            // Defense in depth: top-level validation rejects these keys, and
            // recursive merge refuses them again so this helper cannot become a
            // prototype-pollution primitive if reused by a future caller.
            if(['__proto__','prototype','constructor'].includes(key)) throw new Error(`Unsafe imported settings key: ${key}`);
            const nextPath=[...path,key];
            if(nextPath.length===3&&nextPath[0]==='sidecars'&&nextPath[2]==='apiKey'&&value==='') continue;
            if(nextPath.length===3&&nextPath[0]==='decisionCore'&&nextPath[1]==='typeSafe'&&nextPath[2]==='apiKey'&&value==='') continue;
            if(value&&typeof value==='object'&&!Array.isArray(value)){
                if(!dst[key]||typeof dst[key]!=='object'||Array.isArray(dst[key]))dst[key]={};
                merge(dst[key],value,nextPath);
            }else dst[key]=deepClone(value);
        }
    };
    merge(target,clean);
    target.nexus ||= {};
    if(localAuthority.callCenter!==undefined)target.nexus.callCenter=deepClone(localAuthority.callCenter);
    if(localAuthority.loreWriteValve!==undefined)target.loreWriteValve=deepClone(localAuthority.loreWriteValve);
    if(liveJournal!==undefined)target[IMPORT_RECOVERY_SETTINGS_KEY]=liveJournal;else delete target[IMPORT_RECOVERY_SETTINGS_KEY];
    if(deferredRecoveries!==undefined)target[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY]=deferredRecoveries;else delete target[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY];
}

const IMPORT_SMART_META_KEY='tv2_smart_context';
const IMPORT_MEMORY_META_KEY='tv2_memory_bank';

function importOperationId(){
    try{if(globalThis.crypto?.randomUUID)return `tv2_import_${globalThis.crypto.randomUUID()}`;}catch{}
    return `tv2_import_${Date.now()}_${Math.random().toString(36).slice(2,10)}`;
}

function assertNoImportRecoveryFence(){
    const row=getSettings()?.[IMPORT_RECOVERY_SETTINGS_KEY];
    if(!row)return;
    const classification=classifyImportRecovery(row,{});
    const invalid=classification?.state==='invalid';
    const error=new Error(invalid
        ? 'Nexus backup import is blocked by malformed/unsupported recovery metadata. Open Migration & Backup and explicitly clear or resolve the recovery fence.'
        : `Nexus backup import is blocked by unresolved recovery authority ${row.id||'(unknown)'}. Reconcile the existing import before starting another.`);
    error.name=invalid?'TV2ImportRecoveryInvalid':'TV2ImportRecoveryPending';
    error.recoveryRecord=deepClone(row);
    error.recoveryClassification=classification;
    throw error;
}

function deferredRecoveryStore(settings=getSettings()){
    const raw=settings?.[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY];
    return raw&&typeof raw==='object'&&!Array.isArray(raw)?deepClone(raw):{};
}

async function parkDeferredImportRecovery(record){
    const chatId=String(record?.targetChatId||'').trim();
    if(!chatId){const error=new Error('Deferred import recovery cannot be parked without its exact target chat identity.');error.name='TV2ImportRecoveryRequired';throw error;}
    const id=String(record?.id||'').trim();
    const current=deferredRecoveryStore();
    current[chatId] ||= {};
    current[chatId][id]=deepClone(record);
    updateSettings(target=>{target[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY]=deepClone(current);});
    await flushSettingsPersistence('Nexus deferred import recovery park',{expected:[{path:[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY],exists:true,value:current}]});
    await clearImportRecoveryJournal(record.id,{ownerToken:record.ownerToken,expectedRevision:record.revision});
    return {status:'parked',chatId,id};
}

async function removeDeferredImportRecovery(chatId,id){
    const current=deferredRecoveryStore();
    if(!current?.[chatId]?.[id])return false;
    delete current[chatId][id];
    if(!Object.keys(current[chatId]||{}).length)delete current[chatId];
    updateSettings(target=>{
        if(Object.keys(current).length)target[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY]=deepClone(current);
        else delete target[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY];
    });
    await flushSettingsPersistence('Nexus deferred import recovery settlement',{expected:[{path:[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY],exists:Object.keys(current).length>0,value:Object.keys(current).length?current:null}]});
    return true;
}

async function removeDeferredImportRecoveryById(id){
    const current=deferredRecoveryStore();
    let changed=false;
    for(const [chatId,rows] of Object.entries(current)){
        if(rows&&Object.prototype.hasOwnProperty.call(rows,id)){delete rows[id];changed=true;}
        if(!Object.keys(rows||{}).length)delete current[chatId];
    }
    if(!changed)return false;
    updateSettings(target=>{
        if(Object.keys(current).length)target[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY]=deepClone(current);
        else delete target[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY];
    });
    await flushSettingsPersistence('Nexus deferred import recovery settlement',{expected:[{path:[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY],exists:Object.keys(current).length>0,value:Object.keys(current).length?current:null}]});
    return true;
}

export function inspectImportRecoveryState(){
    const active=deepClone(getSettings()?.[IMPORT_RECOVERY_SETTINGS_KEY]||null);
    const deferred=deferredRecoveryStore();
    const currentChatId=String(getContext()?.chatId??getContext()?.chat_id??'');
    return {
        active,
        activeClassification:active?classifyImportRecovery(active,{}):null,
        deferred,
        deferredCount:Object.values(deferred).reduce((n,rows)=>n+Object.keys(rows||{}).length,0),
        currentChatId,
        currentChatDeferred:Object.values(deferred?.[currentChatId]||{}).map(deepClone),
    };
}

export async function abandonImportRecoveryFence({force=false}={}){
    return await withImportRecoveryLock(async()=>{
        const row=deepClone(getSettings()?.[IMPORT_RECOVERY_SETTINGS_KEY]||null);
        if(!row)return {status:'none'};
        const invalid=classifyImportRecovery(row,{}).state==='invalid';
        if(!invalid&&force!==true){const error=new Error('Valid recovery authority cannot be abandoned without explicit force confirmation. Reconcile it instead.');error.name='TV2ImportRecoveryConfirmationRequired';throw error;}
        updateSettings(target=>{
            const live=target?.[IMPORT_RECOVERY_SETTINGS_KEY];
            if(JSON.stringify(live)!==JSON.stringify(row)){const error=new Error('Import recovery authority changed before explicit abandon.');error.name='TV2ImportRecoveryRequired';throw error;}
            delete target[IMPORT_RECOVERY_SETTINGS_KEY];
        });
        await flushSettingsPersistence('Nexus explicit import recovery abandon',{expected:[{path:[IMPORT_RECOVERY_SETTINGS_KEY],exists:false,value:null}]});
        if(row?.id)await removeDeferredImportRecoveryById(String(row.id));
        logEvent('migration','tv2-import-recovery-abandoned',{id:row?.id||null,invalid,forced:force===true},'warn');
        return {status:'abandoned',id:row?.id||null,invalid};
    });
}

function currentImportChatProjection(context=getContext()){
    if(!context?.chatMetadata)return undefined;
    return {smartContext:exportSmartContextState({manualOnly:false}),memoryBank:exportMemoryBank()};
}

function previewImportedChatProjection(backup,mode,context=getContext(),at=Date.now()){
    const before=currentImportChatProjection(context);
    if(!before)return undefined;
    const after=deepClone(before);
    if(backup?.chatState?.smartContext){
        after.smartContext=previewSmartContextStateImport(backup.chatState.smartContext,{merge:mode!=='replace',manualOnly:true,baseState:before.smartContext,at});
    }
    if(backup?.chatState?.memoryBank){
        after.memoryBank=previewMemoryBankImport(backup.chatState.memoryBank,{replace:mode==='replace',baseStore:before.memoryBank});
    }
    return after;
}

async function applyImportSettingsProjection(post,label='Nexus backup import settings'){
    const current=getSettings();
    const next=preserveImportRecoveryJournal(current,post||{});
    updateSettings(target=>{for(const key of Object.keys(target))delete target[key];Object.assign(target,deepClone(next));});
    await flushSettingsPersistence(label);
}

async function writeImportRecoveryJournal(record,{ownerToken=null,expectedRevision=null}={}){
    const live=getSettings()?.[IMPORT_RECOVERY_SETTINGS_KEY];
    const expected=Math.max(0,Number(expectedRevision)||0);
    if(expected===0){
        if(live){const error=new Error('Nexus backup import recovery reservation lost admission ownership before it could become durable.');error.name='TV2ImportRecoveryPending';throw error;}
    }else{
        const liveOwner=String(live?.ownerToken||(`legacy:${live?.id||''}`));
        const liveRevision=Number(live?.revision||1);
        if(!live||String(live.id||'')!==String(record?.id||'')||liveOwner!==String(ownerToken||record?.ownerToken||'')||liveRevision!==expected){const error=new Error('Nexus backup import recovery journal ownership/revision changed before update.');error.name='TV2ImportRecoveryRequired';throw error;}
    }
    updateSettings(target=>{target[IMPORT_RECOVERY_SETTINGS_KEY]=deepClone(record);});
    await flushSettingsPersistence('Nexus backup import recovery journal',{expected:[{path:[IMPORT_RECOVERY_SETTINGS_KEY],exists:true,value:record}]});
}

async function clearImportRecoveryJournal(id,{ownerToken=null,expectedRevision=null}={}){
    const live=getSettings()?.[IMPORT_RECOVERY_SETTINGS_KEY];
    const liveOwner=String(live?.ownerToken||(`legacy:${live?.id||''}`));
    const liveRevision=Number(live?.revision||1);
    if(!live||String(live.id||'')!==String(id||'')||liveOwner!==String(ownerToken||'')||(expectedRevision!=null&&liveRevision!==Number(expectedRevision))){
        const error=new Error('Nexus backup import recovery journal ownership/revision changed before clear.');
        error.name='TV2ImportRecoveryRequired';
        throw error;
    }
    updateSettings(target=>{delete target[IMPORT_RECOVERY_SETTINGS_KEY];});
    await flushSettingsPersistence('Nexus backup import recovery journal clear',{expected:[{path:[IMPORT_RECOVERY_SETTINGS_KEY],exists:false,value:null}]});
}

function assertImportChatTarget(context,targetChatId,label='Nexus backup import'){
    const current=String(context?.chatId??context?.chat_id??'');
    if(!context?.chatMetadata||!current||current!==String(targetChatId||'')){
        const error=new Error(`${label} refused because the exact target chat is not active.`);
        error.name='TV2DurabilityBarrierUnavailable';
        throw error;
    }
    return context;
}

async function applyImportChatProjection(context,targetChatId,projection,label='Nexus backup import chat state'){
    assertImportChatTarget(context,targetChatId,label);
    if(projection?.smartContext){
        importSmartContextState(projection.smartContext,{merge:false,manualOnly:false,at:projection.smartContext.lastPinnedAt});
    }
    if(projection?.memoryBank)importMemoryBank(projection.memoryBank,{replace:true});
    await flushChatMetadataPersistence(context,label,{keys:[IMPORT_SMART_META_KEY,IMPORT_MEMORY_META_KEY]});
}

function importRecoveryAdapters(context=getContext()){
    return {
        writeJournal:writeImportRecoveryJournal,
        clearJournal:clearImportRecoveryJournal,
        readSettings:async()=>importUserSettingsProjection(deepClone(getSettings())),
        applySettings:async post=>applyImportSettingsProjection(post,'Nexus backup import settings apply'),
        restoreSettings:async pre=>applyImportSettingsProjection(pre,'Nexus backup import settings rollback'),
        readChat:async chatId=>{
            const live=getContext();
            const current=String(live?.chatId??live?.chat_id??'');
            if(!live?.chatMetadata||!current||current!==String(chatId||''))return undefined;
            return currentImportChatProjection(live);
        },
        applyChat:async(chatId,post)=>applyImportChatProjection(context,chatId,post,'Nexus backup import chat apply'),
        restoreChat:async(chatId,pre)=>applyImportChatProjection(context,chatId,pre,'Nexus backup import chat rollback'),
    };
}

export async function reconcileImportRecoveryOnStartup(){
    // Startup recovery participates in the same cross-tab ownership lock as a
    // new import. Without this, a freshly opened tab could reconcile/clear the
    // recovery record while another tab still owns an in-flight import saga.
    return await withImportRecoveryLock(async()=>{
        const record=getSettings()?.[IMPORT_RECOVERY_SETTINGS_KEY];
        if(record){
            const result=await reconcileImportRecovery(deepClone(record),importRecoveryAdapters(getContext()));
            if(result?.status==='deferred'){
                const parked=await parkDeferredImportRecovery(record);
                logEvent('migration','tv2-import-recovery-parked',{id:record.id,targetChatId:record.targetChatId,status:parked.status},'warn');
                return parked;
            }
            logEvent('migration','tv2-import-recovery-reconciled',{id:record.id,status:result?.status||'unknown'},'info');
            return result;
        }
        return await reconcileDeferredImportRecoveryForCurrentChatLocked();
    });
}

async function reconcileDeferredImportRecoveryForCurrentChatLocked(){
    const context=getContext();
    const chatId=String(context?.chatId??context?.chat_id??'');
    if(!chatId||!context?.chatMetadata)return {status:'none'};
    if(getSettings()?.[IMPORT_RECOVERY_SETTINGS_KEY])return {status:'active-fence-present'};
    const rows=Object.values(deferredRecoveryStore()?.[chatId]||{});
    if(!rows.length)return {status:'none'};
    const record=deepClone(rows.sort((a,b)=>Number(a?.at||0)-Number(b?.at||0))[0]);
    // Re-establish the original durable recovery authority before invoking the
    // generic reconciler, whose owned clear/write operations require the row to
    // be active. The deferred copy remains durable until reconciliation proves
    // success, so a crash during promotion cannot lose the recovery record.
    await writeImportRecoveryJournal(record,{ownerToken:record.ownerToken,expectedRevision:0});
    try{
        const result=await reconcileImportRecovery(record,importRecoveryAdapters(context));
        if(result?.status==='deferred'){
            // The chat disappeared between admission and readback. Park again
            // rather than monopolizing the global active fence.
            await parkDeferredImportRecovery(record);
            return {status:'parked-again',id:record.id,targetChatId:chatId};
        }
        await removeDeferredImportRecovery(chatId,record.id);
        logEvent('migration','tv2-deferred-import-recovery-reconciled',{id:record.id,targetChatId:chatId,status:result?.status||'unknown'},'info');
        return {...result,deferred:true,id:record.id,targetChatId:chatId};
    }catch(error){
        // A valid recovery-required record must remain visible as active
        // authority for operator inspection. Its deferred backup is preserved
        // until explicit settlement, avoiding loss across crashes/tabs.
        logEvent('migration','tv2-deferred-import-recovery-failed',{id:record.id,targetChatId:chatId,error},'error');
        throw error;
    }
}

export async function reconcileDeferredImportRecoveryForCurrentChat(){
    return await withImportRecoveryLock(()=>reconcileDeferredImportRecoveryForCurrentChatLocked());
}

export async function reconcileActiveImportRecovery(){
    return await withImportRecoveryLock(async()=>{
        const record=deepClone(getSettings()?.[IMPORT_RECOVERY_SETTINGS_KEY]||null);
        if(!record)return await reconcileDeferredImportRecoveryForCurrentChatLocked();
        const result=await reconcileImportRecovery(record,importRecoveryAdapters(getContext()));
        if(result?.status==='deferred')return await parkDeferredImportRecovery(record);
        if(record?.id)await removeDeferredImportRecoveryById(String(record.id));
        return result;
    });
}

function restoreSettingsSnapshot(snapshot){
    updateSettings(target=>{for(const key of Object.keys(target))delete target[key];Object.assign(target,deepClone(snapshot||{}));});
}

const IMPORT_LOCK_NAME='tv2_nexus_import_recovery_v2:exclusive';
let importProcessTail=Promise.resolve();
async function withImportRecoveryLock(task){
    const locks=globalThis.navigator?.locks;
    if(locks&&typeof locks.request==='function')return await locks.request(IMPORT_LOCK_NAME,{mode:'exclusive'},task);
    if(typeof globalThis.window!=='undefined'||typeof globalThis.document!=='undefined'){const error=new Error('Nexus backup import requires browser Web Locks for cross-tab admission ownership.');error.name='TV2ImportRecoveryDurabilityUnavailable';throw error;}
    const prior=importProcessTail;let release;const gate=new Promise(resolve=>{release=resolve;});importProcessTail=prior.catch(()=>{}).then(()=>gate);await prior.catch(()=>{});try{return await task();}finally{release();}
}

async function importTv2OrTv1PayloadLocked(payload,{mode='merge',importSidecar=true,importChatPins=true}={}) {
    assertSafeImportPayload(payload);
    assertSupportedTv2BackupSchema(payload);
    assertNoImportRecoveryFence();
    const detected=unwrapImportPayload(payload);
    if(detected.kind==='unknown') throw new Error('Unrecognized import file. Expected a Nexus backup/settings file or a compatible legacy settings JSON.');
    if(detected.kind==='tv1'){

        const reservation=createImportRecoveryReservation({id:importOperationId(),targetChatId:null,mode,at:Date.now()});
        await writeImportRecoveryJournal(reservation,{ownerToken:reservation.ownerToken,expectedRevision:0});
        try{
            const translated=translateTv1Settings(detected.data);
            const reconciled=await reconcileImportedTrees(translated.mapped.trees||{});
            translated.mapped.trees=reconciled.trees;
            const settingsBefore=importUserSettingsProjection(deepClone(getSettings()));
            const settingsAfter=deepClone(settingsBefore);
            const report=applyMappedTv1(settingsAfter,translated.mapped,{overwrite:mode==='replace',importSidecar});
            const record=completeImportRecoveryReservation(reservation,{targetChatId:null,mode,settingsBefore,settingsAfter,includesChatState:false});
            await executeCrashSafeImport(record,importRecoveryAdapters(getContext()));
            report.danglingTreeRefsPruned=reconciled.removed;
            invalidateImportedRetrievalAuthority('tv1-file-import');
            const result={kind:'tv1',mode,...report,skipped:translated.skipped,recoverySaga:true,operationId:record.id};
            logEvent('migration','tv1-file-import-complete',result,'info');
            return result;
        }catch(error){
            const live=getSettings()?.[IMPORT_RECOVERY_SETTINGS_KEY];
            if(String(live?.id||'')===String(reservation.id)&&String(live?.phase||'')==='reserved'){
                try{await clearImportRecoveryJournal(reservation.id,{ownerToken:reservation.ownerToken,expectedRevision:live.revision});}catch{}
            }
            invalidateImportedRetrievalAuthority(error?.tv2RollbackRestored===true?'tv1-file-import-rolled-back':'tv1-file-import-recovery-required');
            throw error;
        }

    }

    const backup=detected.kind==='tv2-backup'?detected.data:null;
    const incoming=backup?backup.settings:detected.data;
    const wantsChatState=!!(importChatPins&&backup?.chatState&&(backup.chatState.smartContext||backup.chatState.memoryBank));
    const context=getContext();
    let targetChatId=null;
    if(wantsChatState){
        if(!context?.chatMetadata)throw new Error('An active chat is required before importing chat-scoped Smart Context or Memory Bank state.');
        const origin=String(backup.chatState.chatId??'');
        const current=String(context.chatId??context.chat_id??'');
        if(origin&&current&&origin!==current)throw new Error(`Backup chat state belongs to chat ${origin}, not the currently open chat ${current}. Import settings separately or open the matching chat.`);
        if(!current)throw new Error('The active chat must have a durable chat identity before importing chat-scoped backup state.');
        targetChatId=current;
    }

    const operationAt=Date.now();
    const reservation=createImportRecoveryReservation({id:importOperationId(),targetChatId,mode,at:operationAt});
    await writeImportRecoveryJournal(reservation,{ownerToken:reservation.ownerToken,expectedRevision:0});

    let incomingPrepared=stripImportRecoveryJournalFromPayload(deepClone(incoming||{}));
    normalizeImportedNexusSettings(incomingPrepared?.nexus);
    let reconciledTrees;
    try{reconciledTrees=await reconcileImportedTrees(incomingPrepared.trees||{});}catch(error){try{await clearImportRecoveryJournal(reservation.id,{ownerToken:reservation.ownerToken,expectedRevision:reservation.revision});}catch{}throw error;}
    if(incomingPrepared.trees)incomingPrepared.trees=reconciledTrees.trees;

    const settingsBefore=importUserSettingsProjection(deepClone(getSettings()));
    const settingsAfter=deepClone(settingsBefore);
    const preparedForMerge=deepClone(incomingPrepared||{});
    if(!importSidecar){
        if(mode==='replace')preparedForMerge.sidecars=deepClone(settingsBefore.sidecars||{});
        else delete preparedForMerge.sidecars;
    }
    mergeImportedSettings(settingsAfter,preparedForMerge,{replace:mode==='replace'});
    delete settingsAfter[IMPORT_RECOVERY_SETTINGS_KEY];

    const chatBefore=wantsChatState?currentImportChatProjection(context):null;
    const chatAfter=wantsChatState?previewImportedChatProjection(backup,mode,context,operationAt):null;
    const record=completeImportRecoveryReservation(reservation,{
        targetChatId,
        mode,
        settingsBefore,
        settingsAfter,
        chatBefore,
        chatAfter,
        includesChatState:wantsChatState,
    });

    try{
        await executeCrashSafeImport(record,importRecoveryAdapters(context));
        let pinsImported=0;
        let memoryImported=0;
        if(importChatPins&&backup?.chatState?.smartContext)pinsImported=Array.isArray(backup.chatState.smartContext.manualPins)?backup.chatState.smartContext.manualPins.length:0;
        if(importChatPins&&backup?.chatState?.memoryBank)memoryImported=Object.keys(backup.chatState.memoryBank.records||{}).length;
        invalidateImportedRetrievalAuthority('tv2-import');
        const result={kind:detected.kind,mode,trees:Object.keys(incomingPrepared?.trees||{}).length,danglingTreeRefsPruned:reconciledTrees.removed,pinsImported,memoryImported,includesSecrets:backup?.includesSecrets===true,recoverySaga:true,operationId:record.id};
        logEvent('migration','tv2-import-complete',result,'info');
        return result;
    }catch(error){
        invalidateImportedRetrievalAuthority(error?.tv2RollbackRestored===true?'tv2-import-rolled-back':'tv2-import-recovery-required');
        throw error;
    }
}


export async function importTv2OrTv1Payload(payload,options={}){return await withImportRecoveryLock(()=>importTv2OrTv1PayloadLocked(payload,options));}
