/*
 * Nexus two-domain import recovery saga.
 *
 * Settings and current-chat metadata are distinct host durability domains.  A
 * durable reservation is acquired before asynchronous import preparation, then
 * enriched into a PRE/POST recovery record. Rollback is compare-before-restore:
 * a domain is restored only while it still proves the exact known POST owned by
 * this import. Host APIs still lack atomic conditional writes; callers must keep
 * that final host-level guarantee disposition explicit.
 */

export const IMPORT_RECOVERY_VERSION = 2;
export const IMPORT_RECOVERY_SETTINGS_KEY = 'nexusImportRecoveryV1';
export const IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY = 'nexusDeferredImportRecoveriesV1';
export const IMPORT_RECOVERY_PHASE = Object.freeze({
    RESERVED: 'reserved',
    PREPARED: 'prepared',
    CHAT_APPLIED: 'chat-applied',
    RECOVERY_REQUIRED: 'recovery-required',
});

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function ownerToken() { return globalThis.crypto?.randomUUID?.() || `imp_owner_${Date.now()}_${Math.random().toString(36).slice(2)}`; }

export function stripImportRecoveryJournalFromPayload(settings) {
    const next = settings && typeof settings === 'object' ? clone(settings) : settings;
    if (next && typeof next === 'object') {
        delete next[IMPORT_RECOVERY_SETTINGS_KEY];
        delete next[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY];
    }
    return next;
}
export function preserveImportRecoveryJournal(currentSettings, nextSettings) {
    const next = nextSettings && typeof nextSettings === 'object' ? clone(nextSettings) : {};
    const current = currentSettings && typeof currentSettings === 'object' ? currentSettings : {};
    if (Object.prototype.hasOwnProperty.call(current, IMPORT_RECOVERY_SETTINGS_KEY)) next[IMPORT_RECOVERY_SETTINGS_KEY] = clone(current[IMPORT_RECOVERY_SETTINGS_KEY]);
    else delete next[IMPORT_RECOVERY_SETTINGS_KEY];
    if (Object.prototype.hasOwnProperty.call(current, IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY)) next[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY] = clone(current[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY]);
    else delete next[IMPORT_DEFERRED_RECOVERY_SETTINGS_KEY];
    return next;
}
export function importUserSettingsProjection(settings) { return stripImportRecoveryJournalFromPayload(settings); }
function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])); return value; }
export function sameImportProjection(a,b){try{return JSON.stringify(stable(a))===JSON.stringify(stable(b));}catch{return false;}}
function fnv1a32(text){let hash=0x811c9dc5;for(let i=0;i<text.length;i+=1){hash^=text.charCodeAt(i);hash=Math.imul(hash,0x01000193)>>>0;}return hash.toString(16).padStart(8,'0');}
export function importProjectionFingerprint(value){const text=JSON.stringify(stable(value));return `imp2:${fnv1a32(text)}:${text.length}`;}

export function createImportRecoveryReservation({ id, targetChatId=null, mode='merge', at=Date.now(), owner=null }={}) {
    if(!id)throw new Error('Import recovery requires a stable operation id.');
    return { version:IMPORT_RECOVERY_VERSION,id:String(id),ownerToken:String(owner||ownerToken()),revision:1,phase:IMPORT_RECOVERY_PHASE.RESERVED,at:Number(at)||Date.now(),mode:String(mode||'merge'),targetChatId:targetChatId==null?null:String(targetChatId),includesChatState:false,settings:null,chat:null,recovery:null };
}

export function createImportRecoveryRecord({ id, ownerToken: owner=null, revision=1, targetChatId=null, mode='merge', settingsBefore, settingsAfter, chatBefore=null, chatAfter=null, includesChatState=false, at=Date.now() }={}) {
    if(!id)throw new Error('Import recovery requires a stable operation id.');
    if(settingsBefore===undefined||settingsAfter===undefined)throw new Error('Import recovery requires settings pre/post projections.');
    if(includesChatState&&!String(targetChatId||'').trim())throw new Error('Chat-state import recovery requires the exact originating chat identity.');
    if(includesChatState&&(chatBefore===undefined||chatAfter===undefined))throw new Error('Chat-state import recovery requires chat pre/post projections.');
    return {version:IMPORT_RECOVERY_VERSION,id:String(id),ownerToken:String(owner||ownerToken()),revision:Math.max(1,Number(revision)||1),phase:IMPORT_RECOVERY_PHASE.PREPARED,at:Number(at)||Date.now(),mode:String(mode||'merge'),targetChatId:targetChatId==null?null:String(targetChatId),includesChatState:includesChatState===true,settings:{before:clone(settingsBefore),after:clone(settingsAfter),beforeFingerprint:importProjectionFingerprint(settingsBefore),afterFingerprint:importProjectionFingerprint(settingsAfter)},chat:includesChatState?{before:clone(chatBefore),after:clone(chatAfter),beforeFingerprint:importProjectionFingerprint(chatBefore),afterFingerprint:importProjectionFingerprint(chatAfter)}:null,recovery:null};
}

export function completeImportRecoveryReservation(reservation, spec={}) {
    if(!reservation||String(reservation.phase)!==IMPORT_RECOVERY_PHASE.RESERVED)throw new Error('Import recovery reservation is not active.');
    return createImportRecoveryRecord({ ...spec,id:reservation.id,ownerToken:reservation.ownerToken,revision:Number(reservation.revision||1)+1,mode:spec.mode||reservation.mode,targetChatId:spec.targetChatId??reservation.targetChatId,at:reservation.at });
}

function normalizeRecord(record){
    if(!record||typeof record!=='object')return null;
    if(Number(record.version)===IMPORT_RECOVERY_VERSION){
        if(!String(record.id||'').trim()||!String(record.ownerToken||'').trim()||!Number.isInteger(Number(record.revision))||Number(record.revision)<1)return null;
        return clone(record);
    }
    // Known v1 records are preserved/recoverable, never interpreted as empty.
    if(Number(record.version)===1&&String(record.id||'').trim())return {...clone(record),version:IMPORT_RECOVERY_VERSION,ownerToken:`legacy:${record.id}`,revision:1};
    return null;
}
function classifyOne(current,before,after){if(current===undefined)return'unavailable';if(sameImportProjection(current,before))return'pre';if(sameImportProjection(current,after))return'post';return'divergent';}
export function classifyImportRecovery(record,{settingsCurrent,chatCurrent}={}){
    const normalized=normalizeRecord(record);if(!normalized)return{state:'invalid',settings:'unknown',chat:'unknown'};
    if(normalized.phase===IMPORT_RECOVERY_PHASE.RESERVED&&!normalized.settings)return{state:'reserved',settings:'not-applied',chat:'not-applicable'};
    const settings=classifyOne(settingsCurrent,normalized.settings?.before,normalized.settings?.after);
    const chat=normalized.includesChatState?classifyOne(chatCurrent,normalized.chat?.before,normalized.chat?.after):'not-applicable';
    let state;if(settings==='divergent'||chat==='divergent')state='conflict';else if(settings==='unavailable'||chat==='unavailable')state='deferred';else if(settings==='post'&&(chat==='post'||chat==='not-applicable'))state='complete-post';else if(settings==='pre'&&(chat==='pre'||chat==='not-applicable'))state='complete-pre';else state='mixed';return{state,settings,chat};
}
export function planImportRecovery(record,current={}){const classification=classifyImportRecovery(record,current);switch(classification.state){case'reserved':return{classification,action:'clear-reservation',restoreSettings:false,restoreChat:false,clear:true};case'complete-post':return{classification,action:'finalize-success',restoreSettings:false,restoreChat:false,clear:true};case'complete-pre':return{classification,action:'clear-aborted',restoreSettings:false,restoreChat:false,clear:true};case'mixed':return{classification,action:'rollback-to-pre',restoreSettings:classification.settings==='post',restoreChat:classification.chat==='post',clear:false};case'deferred':return{classification,action:'defer',restoreSettings:false,restoreChat:false,clear:false};default:return{classification,action:'recovery-required',restoreSettings:false,restoreChat:false,clear:false};}}
function recoveryError(message,cause=null,details=null){const error=new Error(message);error.name='TV2ImportRecoveryRequired';if(cause)error.cause=cause;if(details)error.details=details;return error;}
function nextRecord(record,patch={}){return{...clone(record),...clone(patch),version:IMPORT_RECOVERY_VERSION,revision:Number(record.revision||1)+1};}
async function writeOwned(adapters,record,priorRevision=null){return await adapters.writeJournal?.(clone(record),{ownerToken:record.ownerToken,expectedRevision:priorRevision});}
async function clearOwned(adapters,record){return await adapters.clearJournal?.(record.id,{ownerToken:record.ownerToken,expectedRevision:Number(record.revision||1)});}
async function assertDomainStill(record,adapters,domain,expected='post'){
    const current=domain==='settings'?await adapters.readSettings?.():await adapters.readChat?.(record.targetChatId);
    const spec=domain==='settings'?record.settings:record.chat;
    const state=classifyOne(current,spec?.before,spec?.after);
    if(state!==expected){throw recoveryError(`Nexus import ${domain} rollback ownership changed before restore; expected exact ${expected} state but found ${state}.`,null,{domain,state,expected});}
    return current;
}
async function restoreOwnedDomains(record,adapters,{settings=false,chat=false}={}){
    if(chat){await assertDomainStill(record,adapters,'chat','post');await adapters.restoreChat?.(record.targetChatId,clone(record.chat.before));}
    if(settings){await assertDomainStill(record,adapters,'settings','post');await adapters.restoreSettings?.(clone(record.settings.before));}
}

export async function reconcileImportRecovery(recordLike,adapters={}){
    let record=normalizeRecord(recordLike);if(!record)throw recoveryError('Nexus import recovery record has an unsupported or malformed schema.');
    const settingsCurrent=record.settings?await adapters.readSettings?.():undefined;const chatCurrent=record.includesChatState?await adapters.readChat?.(record.targetChatId):null;const plan=planImportRecovery(record,{settingsCurrent,chatCurrent});
    if(plan.action==='defer')return{status:'deferred',plan,record:clone(record)};
    if(plan.action==='clear-reservation'){await clearOwned(adapters,record);return{status:'aborted-before-write',plan};}
    if(plan.action==='recovery-required'){const next=nextRecord(record,{phase:IMPORT_RECOVERY_PHASE.RECOVERY_REQUIRED,recovery:{at:Date.now(),reason:'persisted state diverged from both import pre-image and post-image',classification:plan.classification}});await writeOwned(adapters,next,record.revision);throw recoveryError('Nexus import recovery found divergent persisted state and refused to guess.',null,plan.classification);}
    if(plan.action==='rollback-to-pre'){
        try{await restoreOwnedDomains(record,adapters,{chat:plan.restoreChat,settings:plan.restoreSettings});}
        catch(error){const next=nextRecord(record,{phase:IMPORT_RECOVERY_PHASE.RECOVERY_REQUIRED,recovery:{at:Date.now(),reason:error?.message||String(error),classification:plan.classification}});try{await writeOwned(adapters,next,record.revision);}catch{}throw error;}
        const verifySettings=await adapters.readSettings?.();const verifyChat=record.includesChatState?await adapters.readChat?.(record.targetChatId):null;const after=classifyImportRecovery(record,{settingsCurrent:verifySettings,chatCurrent:verifyChat});
        if(after.state!=='complete-pre'){const next=nextRecord(record,{phase:IMPORT_RECOVERY_PHASE.RECOVERY_REQUIRED,recovery:{at:Date.now(),reason:'rollback could not be durably proven',classification:after}});await writeOwned(adapters,next,record.revision);throw recoveryError('Nexus import rollback could not be durably proven.',null,after);}
    }
    await clearOwned(adapters,record);return{status:plan.action==='finalize-success'?'completed':'rolled-back',plan};
}

export async function executeCrashSafeImport(recordLike,adapters={}){
    let record=normalizeRecord(recordLike);if(!record||!record.settings||String(record.phase)!==IMPORT_RECOVERY_PHASE.PREPARED)throw new Error('Invalid prepared Nexus import recovery record.');
    await writeOwned(adapters,record,Number(record.revision||1)-1);
    try{
        if(record.includesChatState){await adapters.applyChat?.(record.targetChatId,clone(record.chat.after));const chatCurrent=await adapters.readChat?.(record.targetChatId);if(!sameImportProjection(chatCurrent,record.chat.after))throw new Error('Imported chat-state durability could not be proven.');const advanced=nextRecord(record,{phase:IMPORT_RECOVERY_PHASE.CHAT_APPLIED});await writeOwned(adapters,advanced,record.revision);record=advanced;}
        await adapters.applySettings?.(clone(record.settings.after));const settingsCurrent=await adapters.readSettings?.();if(!sameImportProjection(settingsCurrent,record.settings.after))throw new Error('Imported settings durability could not be proven.');
        await clearOwned(adapters,record);return{status:'completed',id:record.id};
    }catch(error){
        try{
            const currentSettings=await adapters.readSettings?.();const currentChat=record.includesChatState?await adapters.readChat?.(record.targetChatId):null;const classification=classifyImportRecovery(record,{settingsCurrent:currentSettings,chatCurrent:currentChat});
            if(classification.state==='complete-pre'){await clearOwned(adapters,record);try{error.tv2RollbackRestored=true;}catch{}throw error;}
            if(!['mixed','complete-post'].includes(classification.state))throw recoveryError('Nexus import failed but current state no longer matches the import-owned post-state; rollback refused.',error,classification);
            await restoreOwnedDomains(record,adapters,{chat:classification.chat==='post',settings:classification.settings==='post'});
            const verifySettings=await adapters.readSettings?.();const verifyChat=record.includesChatState?await adapters.readChat?.(record.targetChatId):null;const after=classifyImportRecovery(record,{settingsCurrent:verifySettings,chatCurrent:verifyChat});if(after.state!=='complete-pre')throw recoveryError('Nexus import failed and rollback durability could not be proven.',error,after);
            await clearOwned(adapters,record);try{error.tv2RollbackRestored=true;}catch{}throw error;
        }catch(rollbackError){
            if(rollbackError===error)throw error;
            const next=nextRecord(record,{phase:IMPORT_RECOVERY_PHASE.RECOVERY_REQUIRED,recovery:{at:Date.now(),reason:rollbackError?.message||String(rollbackError)}});try{await writeOwned(adapters,next,record.revision);}catch{}throw recoveryError('Nexus import failed and entered recovery-required state.',error,{rollbackError:rollbackError?.message||String(rollbackError)});
        }
    }
}
