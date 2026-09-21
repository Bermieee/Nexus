import { getSettings, updateSettings, updateAuthoritySettingsDurably, assertAuthoritySettingsReady, getAuthoritySettingsStatus } from '../core/settings.js';
import { bumpNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';

const VALID_PERMISSIONS = new Set(['read_write','read_only','write_only']);
const VALID_INJECTION = new Set(['tv2','st']);

function notifyLoreAuthorityChanged(book, reason) {
    const name=String(book||'').trim();
    const why=String(reason||'lore-policy-changed');
    bumpNexusLoreSourceRevision({book:name||null,reason:why});
    try { globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-lore-authority-changed',{detail:{book:name,reason:why}})); } catch {}
}


export function getBookPermission(book){
    const map=getSettings().bookPermissions||{};const name=String(book);
    if(!Object.prototype.hasOwnProperty.call(map,name))return'read_write';
    const value=String(map[name]);
    return VALID_PERMISSIONS.has(value)?value:'deny';
}
export async function setBookPermission(book,permission){
    const name=String(book||'').trim();if(!name)return;
    const value=String(permission);if(!VALID_PERMISSIONS.has(value))throw new Error(`Unsupported lorebook permission: ${value}`);
    const result=await updateAuthoritySettingsDurably(`Lorebook \"${name}\" permission`,[['bookPermissions',name]],s=>{s.bookPermissions=s.bookPermissions||{};if(value==='read_write')delete s.bookPermissions[name];else s.bookPermissions[name]=value;});notifyLoreAuthorityChanged(name,'book-permission-changed');return result;

}
export function canReadBook(book){if(getAuthoritySettingsStatus().status!=='ready')return false;const p=getBookPermission(book);return p==='read_write'||p==='read_only';}
export function canWriteBook(book){if(getAuthoritySettingsStatus().status!=='ready')return false;const p=getBookPermission(book);return p==='read_write'||p==='write_only';}
export function assertReadableBook(book){assertAuthoritySettingsReady(`Lorebook \"${book}\" read authority`);if(!isBookEnabled(book))throw new Error(`Lorebook "${book}" is not enabled for Nexus.`);if(!canReadBook(book))throw new Error(`Lorebook "${book}" is Write Only and cannot be read/search-retrieved by Nexus.`);return true;}
export function assertWritableBook(book){assertAuthoritySettingsReady(`Lorebook \"${book}\" write authority`);if(!isBookEnabled(book))throw new Error(`Lorebook "${book}" is not enabled for Nexus.`);if(!canWriteBook(book))throw new Error(`Lorebook "${book}" is Read Only and cannot be modified by Nexus.`);return true;}

export function getBookInjectionMode(book){
    if(getAuthoritySettingsStatus().status!=='ready')return'invalid';
    const map=getSettings().bookInjectionModes||{};const name=String(book);
    if(!Object.prototype.hasOwnProperty.call(map,name))return'tv2';
    const raw=String(map[name]).toLowerCase();
    if(raw==='sidecar')return'tv2';
    if(raw==='native')return'st';
    return VALID_INJECTION.has(raw)?raw:'invalid';
}
export async function setBookInjectionMode(book,mode){
    const name=String(book||'').trim();if(!name)return;
    let value=String(mode||'tv2').toLowerCase();if(value==='sidecar')value='tv2';if(value==='native')value='st';if(!VALID_INJECTION.has(value))throw new Error(`Unsupported lorebook injection mode: ${value}`);
    const result=await updateAuthoritySettingsDurably(`Lorebook \"${name}\" injection mode`,[['bookInjectionModes',name]],s=>{s.bookInjectionModes=s.bookInjectionModes||{};if(value==='tv2')delete s.bookInjectionModes[name];else s.bookInjectionModes[name]=value;});notifyLoreAuthorityChanged(name,'book-injection-mode-changed');return result;

}
export function isTv2InjectionBook(book){return getBookInjectionMode(book)==='tv2';}
export function isStInjectionBook(book){return getBookInjectionMode(book)==='st';}

export function getBookDescription(book){return String(getSettings().bookDescriptions?.[String(book)]||'');}
export function setBookDescription(book,description){const name=String(book||'').trim();if(!name)return;updateSettings(s=>{s.bookDescriptions=s.bookDescriptions||{};const text=String(description||'').trim();if(text)s.bookDescriptions[name]=text;else delete s.bookDescriptions[name];});bumpNexusLoreSourceRevision({book:name,reason:'book-description-changed'});}

export function isBookEnabled(book){
    const name=String(book||'').trim();if(!name)return false;if(getAuthoritySettingsStatus().status!=='ready')return false;
    const map=getSettings().enabledLorebooks||{};
    if(Object.prototype.hasOwnProperty.call(map,name))return map[name]===true;
    // Upgrade-safe default: a book with an existing Nexus Tree remains managed
    // unless the user explicitly turns it off in Lorebook Selection.
    return !!getSettings().trees?.[name];
}
export async function setBookEnabled(book,enabled){const name=String(book||'').trim();if(!name)return;const result=await updateAuthoritySettingsDurably(`Lorebook \"${name}\" enabled state`,[['enabledLorebooks',name]],s=>{s.enabledLorebooks=s.enabledLorebooks||{};s.enabledLorebooks[name]=enabled===true;});notifyLoreAuthorityChanged(name,'book-enabled-state-changed');return result;}


export async function setBookPolicyDurably(book,{enabled,permission,injectionMode}={}){
    const name=String(book||'').trim();if(!name)return;
    const value=String(permission||'read_write');if(!VALID_PERMISSIONS.has(value))throw new Error(`Unsupported lorebook permission: ${value}`);
    let injection=String(injectionMode||'tv2').toLowerCase();if(injection==='sidecar')injection='tv2';if(injection==='native')injection='st';if(!VALID_INJECTION.has(injection))throw new Error(`Unsupported lorebook injection mode: ${injection}`);
    const result=await updateAuthoritySettingsDurably(`Lorebook \"${name}\" authority policy`,[['enabledLorebooks',name],['bookPermissions',name],['bookInjectionModes',name]],s=>{
        s.enabledLorebooks=s.enabledLorebooks||{};s.enabledLorebooks[name]=enabled===true;
        s.bookPermissions=s.bookPermissions||{};if(value==='read_write')delete s.bookPermissions[name];else s.bookPermissions[name]=value;
        s.bookInjectionModes=s.bookInjectionModes||{};if(injection==='tv2')delete s.bookInjectionModes[name];else s.bookInjectionModes[name]=injection;
    });
    notifyLoreAuthorityChanged(name,'book-authority-policy-changed');
    return result;

}

export function bookPolicyLabel(book){
    const p=getBookPermission(book);const access=p==='read_write'?'READ + WRITE':p==='read_only'?'READ ONLY':p==='write_only'?'WRITE ONLY':'ACCESS BLOCKED';const injection=getBookInjectionMode(book);
    return `${access} · ${injection==='tv2'?'Nexus INJECTION':injection==='st'?'ST INJECTION':'INJECTION BLOCKED'}`;
}
