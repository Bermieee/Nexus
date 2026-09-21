import { characterPresentInText } from './character-match.js';
import { getContext } from '../../../../st-context.js';
import { getSettings, updateSettings, updateAuthoritySettingsDurably } from '../core/settings.js';
import { getActiveBooks, isBookInCurrentStory } from '../lore/active-books.js';
import { canReadBook, isBookEnabled, isTv2InjectionBook } from '../lore/policy.js';
import { buildTreeEntryIndex, searchTree } from '../retrieval/search-engine.js';
import { getTree } from '../tree/store.js';
import { resolveCurrentTreeRef } from '../tree/ref-resolver.js';
import { logEvent } from '../observability/telemetry.js';
import { getAllMemoryRecords } from './store.js';
import {
    normalizeCharacterState,
    characterStateToLegacyProfile,
    normalizeCharacterStateProposals,
    normalizeCharacterChangeHistory,
    normalizeCharacterFieldProvenance,
    normalizeCharacterCardSync,
} from './character-state-contract.js';

const ROLES = new Set(['lead', 'supporting', 'background']);
const DEFAULT_TRACKING = Object.freeze({
    personality: true,
    relationships: true,
    status: true,
    goals: true,
    behavior: true,
});

function clone(value){ return value == null ? value : JSON.parse(JSON.stringify(value)); }
function uid(){ return `tv2_charbank_${Date.now()}_${Math.random().toString(36).slice(2,8)}`; }
function cleanText(value){ return String(value ?? '').replace(/\s+/g, ' ').trim(); }
const LEGACY_CHARACTER_BANK_STORY = '__unassigned__';
export function currentCharacterBankStoryId(context = getContext()){
    const id = cleanText(context?.chatId ?? context?.chat_id);
    return id || null;
}
function normalizeCharacterBankStoryId(value){ return cleanText(value) || LEGACY_CHARACTER_BANK_STORY; }
function characterBankBelongsToCurrentStory(bank, context = getContext()){
    const storyId = currentCharacterBankStoryId(context);
    return !!storyId && normalizeCharacterBankStoryId(bank?.storyId) === storyId;
}
function escRe(value){ return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normalizeCardBinding(raw = null){
    if (!raw || typeof raw !== 'object') return null;
    const avatar = cleanText(raw.avatar);
    if (!avatar) return null;
    return {
        source: cleanText(raw.source) || 'sillytavern',
        avatar,
        name: cleanText(raw.name),
        fingerprint: cleanText(raw.fingerprint),
        boundAt: Number(raw.boundAt) || 0,
        lastScannedAt: Number(raw.lastScannedAt) || Number(raw.boundAt) || 0,
    };
}

export function normalizeCharacterBank(raw = {}){
    const role = ROLES.has(String(raw.role)) ? String(raw.role) : 'supporting';
    const state = normalizeCharacterState(raw.state || raw.characterState || {}, raw.profile || {});
    const profile = characterStateToLegacyProfile(state);
    const refs = Array.isArray(raw.linkedRefs) ? raw.linkedRefs : [];
    const seen = new Set();
    const linkedRefs = [];
    for (const ref of refs) {
        const book = cleanText(ref?.book);
        const n = Number(ref?.uid);
        if (!book || !Number.isFinite(n)) continue;
        const key = JSON.stringify([book,n]);
        if (seen.has(key)) continue;
        seen.add(key);
        linkedRefs.push({
            book,
            uid: n,
            title: cleanText(ref?.title),
            nodeId: ref?.nodeId ? String(ref.nodeId) : null,
            nodeLabel: cleanText(ref?.nodeLabel),
            path: Array.isArray(ref?.path) ? ref.path.map(String) : [],
        });
    }
    return {
        id: cleanText(raw.id) || uid(),
        storyId: normalizeCharacterBankStoryId(raw.storyId),
        enabled: raw.enabled !== false,
        character: cleanText(raw.character),
        role,
        sceneAware: raw.sceneAware !== false,
        cardBinding: normalizeCardBinding(raw.cardBinding),
        linkedRefs,
        memoryIds: [...new Set((Array.isArray(raw.memoryIds) ? raw.memoryIds : []).map(String).filter(Boolean))],
        memoryRefs: [...new Map((Array.isArray(raw.memoryRefs) ? raw.memoryRefs : []).map(ref => {
            const chatId = cleanText(ref?.chatId);
            const id = cleanText(ref?.id || ref?.memoryId);
            return chatId && id ? [`${chatId}|${id}`, { chatId, id }] : null;
        }).filter(Boolean)).values()],
        // `profile` remains as a compatibility projection for the existing
        // Summary focus/runtime surfaces. Character State v1 is authoritative.
        profile,
        state,
        stateProposals: normalizeCharacterStateProposals(raw.stateProposals || raw.characterStateProposals || []),
        changeHistory: normalizeCharacterChangeHistory(raw.changeHistory || raw.characterChangeHistory || []),
        fieldProvenance: normalizeCharacterFieldProvenance(raw.fieldProvenance || {}),
        cardSync: normalizeCharacterCardSync(raw.cardSync || {}),
        tracking: {
            personality: raw.tracking?.personality !== false,
            relationships: raw.tracking?.relationships !== false,
            status: raw.tracking?.status !== false,
            goals: raw.tracking?.goals !== false,
            behavior: raw.tracking?.behavior !== false,
        },
    };
}


function dedupeCharacterBankIds(banks = []){
    const used=new Set();
    return (Array.isArray(banks)?banks:[]).map((raw,index)=>{
        const bank=normalizeCharacterBank(raw);
        const base=cleanText(bank.id)||`tv2_charbank_${index+1}`;
        let candidate=base,suffix=2;
        while(used.has(candidate))candidate=`${base}__${suffix++}`;
        used.add(candidate);bank.id=candidate;return bank;
    });
}

function normalizeAll(){
    const s = getSettings();
    s.memoryBank = s.memoryBank || {};
    s.memoryBank.characterBanks = s.memoryBank.characterBanks || { enabled: true, banks: [] };
    if (!Array.isArray(s.memoryBank.characterBanks.banks)) s.memoryBank.characterBanks.banks = [];
    s.memoryBank.characterBanks.banks = dedupeCharacterBankIds(s.memoryBank.characterBanks.banks);
    if (s.memoryBank.characterBanks.enabled === undefined) s.memoryBank.characterBanks.enabled = true;
    return s.memoryBank.characterBanks;
}

export function getCharacterBanks({ allStories = false, includeLegacy = false } = {}){
    const banks = normalizeAll().banks;
    if (allStories) return clone(banks);
    const storyId = currentCharacterBankStoryId();
    if (!storyId) return [];
    const visible = banks.filter(bank => characterBankBelongsToCurrentStory(bank) || (includeLegacy && bank.storyId === LEGACY_CHARACTER_BANK_STORY));
    return clone(visible);
}
export function getCharacterBank(id){ return getCharacterBanks().find(bank => bank.id === String(id)) || null; }
export function getLegacyCharacterBanks(){ return clone(normalizeAll().banks.filter(bank => bank.storyId === LEGACY_CHARACTER_BANK_STORY)); }

export function findCharacterBankByCardAvatar(avatar){
    const wanted = cleanText(avatar);
    if (!wanted) return null;
    return getCharacterBanks().find(bank => cleanText(bank.cardBinding?.avatar) === wanted) || null;
}

export function characterBankCardStatus(bankOrId){
    const bank = typeof bankOrId === 'string' ? getCharacterBank(bankOrId) : normalizeCharacterBank(bankOrId || {});
    const binding = bank?.cardBinding;
    if (!binding?.avatar) return { state:'none', bound:false, installed:false, active:false, binding:null };
    const ctx = getContext?.();
    const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
    const installed = characters.some(character => cleanText(character?.avatar || character?.data?.avatar) === binding.avatar);
    const activeCharacter = Number.isInteger(Number(ctx?.characterId)) && Number(ctx.characterId) >= 0 ? characters[Number(ctx.characterId)] : null;
    const activeAvatar = cleanText(activeCharacter?.avatar || activeCharacter?.data?.avatar);
    const active = installed && activeAvatar === binding.avatar;
    return { state:installed?'bound':'unbound', bound:true, installed, active, binding:clone(binding) };
}

export function bindCharacterBankCard(bankId, binding){
    const bank = getCharacterBank(bankId);
    if (!bank) throw new Error('Character Bank not found.');
    const normalized = normalizeCardBinding(binding);
    if (!normalized) throw new Error('A stable SillyTavern character-card avatar identity is required.');
    const collision = getCharacterBanks().find(other => other.id !== bank.id && cleanText(other.cardBinding?.avatar) === normalized.avatar);
    if (collision) throw new Error(`This SillyTavern card is already bound to Character Bank "${collision.character || collision.id}".`);
    const updated = updateCharacterBank(bankId,{cardBinding:normalized});
    if (updated) logEvent('character-memory','card-bound',{
        bankId:updated.id,
        character:updated.character || normalized.name,
        cardName:normalized.name,
        avatar:normalized.avatar,
        fingerprint:normalized.fingerprint || null,
        linkedCount:updated.linkedRefs?.length || 0,
    },'info');
    return updated;
}

export function addCharacterBank(seed = {}){
    const storyId = cleanText(seed?.storyId) || currentCharacterBankStoryId();
    if (!storyId) {
        const error = new Error('Select a chat before creating a Character Bank.');
        error.name = 'TV2CharacterBankScopeUnavailable';
        throw error;
    }
    const bank = normalizeCharacterBank({ ...seed, storyId });
    updateSettings(s => {
        s.memoryBank = s.memoryBank || {};
        s.memoryBank.characterBanks = s.memoryBank.characterBanks || { enabled: true, banks: [] };
        s.memoryBank.characterBanks.banks = Array.isArray(s.memoryBank.characterBanks.banks) ? s.memoryBank.characterBanks.banks : [];
        s.memoryBank.characterBanks.banks.push(bank);
    });
    notify();
    logEvent('character-memory','bank-created',{id:bank.id,storyId:bank.storyId,character:bank.character,role:bank.role},'info');
    if (bank.cardBinding?.avatar) logEvent('character-memory','card-bound',{
        bankId:bank.id,
        character:bank.character || bank.cardBinding.name,
        cardName:bank.cardBinding.name,
        avatar:bank.cardBinding.avatar,
        fingerprint:bank.cardBinding.fingerprint || null,
        linkedCount:bank.linkedRefs?.length || 0,
    },'info');
    return clone(bank);
}


function applyCharacterBankPatchToList(list, id, patch = {}, storyId = currentCharacterBankStoryId()) {
    const index = list.findIndex(bank => String(bank?.id) === String(id) && normalizeCharacterBankStoryId(bank?.storyId) === storyId);
    if (index < 0) return null;
    const base = normalizeCharacterBank(list[index]);
    let statePatch = patch.state === undefined && patch.characterState === undefined ? base.state : (patch.state || patch.characterState);
    if (patch.profile && patch.state === undefined && patch.characterState === undefined) {
        statePatch = normalizeCharacterState({
            ...base.state,
            baseline: {
                ...base.state?.baseline,
                ...(Object.prototype.hasOwnProperty.call(patch.profile, 'personality') ? { personality: patch.profile.personality } : {}),
                ...(Object.prototype.hasOwnProperty.call(patch.profile, 'appearance') ? { appearance: patch.profile.appearance } : {}),
                ...(Object.prototype.hasOwnProperty.call(patch.profile, 'clothingArmor') ? { clothingGear: patch.profile.clothingArmor } : {}),
            },
        }, patch.profile);
    }
    const merged = {
        ...base,
        ...patch,
        tracking: { ...base.tracking, ...(patch.tracking || {}) },
        profile: { ...base.profile, ...(patch.profile || {}) },
        state: statePatch,
        stateProposals: patch.stateProposals === undefined ? base.stateProposals : patch.stateProposals,
        changeHistory: patch.changeHistory === undefined ? base.changeHistory : patch.changeHistory,
        fieldProvenance: patch.fieldProvenance === undefined ? base.fieldProvenance : patch.fieldProvenance,
        cardSync: patch.cardSync === undefined ? base.cardSync : { ...base.cardSync, ...(patch.cardSync || {}) },
        linkedRefs: patch.linkedRefs === undefined ? base.linkedRefs : patch.linkedRefs,
        memoryIds: patch.memoryIds === undefined ? base.memoryIds : patch.memoryIds,
        memoryRefs: patch.memoryRefs === undefined ? base.memoryRefs : patch.memoryRefs,
    };
    const updated = normalizeCharacterBank(merged);
    list[index] = updated;
    return updated;
}

export function updateCharacterBank(id, patch = {}){
    let updated = null;
    updateSettings(s => {
        s.memoryBank = s.memoryBank || {};
        s.memoryBank.characterBanks = s.memoryBank.characterBanks || { enabled: true, banks: [] };
        const list = Array.isArray(s.memoryBank.characterBanks.banks) ? s.memoryBank.characterBanks.banks : [];
        updated = applyCharacterBankPatchToList(list, id, patch, currentCharacterBankStoryId());
        s.memoryBank.characterBanks.banks = list;
    });
    if (updated) {
        notify();
        logEvent('character-memory','bank-updated',{id:updated.id,storyId:updated.storyId,character:updated.character,role:updated.role,enabled:updated.enabled,linkedCount:updated.linkedRefs.length},'debug');
    }
    return clone(updated);
}

/**
 * Authority-bearing Character Bank persistence. Model-produced Character State
 * changes and Character Card reconciliation use this awaited path so the live
 * settings object is not treated as durable merely because it was mutated.
 */
export async function updateCharacterBankDurably(id, patch = {}, { label = 'Character Bank state' } = {}) {
    const storyId = currentCharacterBankStoryId();
    if (!storyId) throw new Error('Select a chat before mutating Character State.');
    let updated = null;
    await updateAuthoritySettingsDurably(label, [['memoryBank','characterBanks','banks']], settings => {
        settings.memoryBank = settings.memoryBank || {};
        settings.memoryBank.characterBanks = settings.memoryBank.characterBanks || { enabled: true, banks: [] };
        const list = Array.isArray(settings.memoryBank.characterBanks.banks) ? settings.memoryBank.characterBanks.banks : [];
        updated = applyCharacterBankPatchToList(list, id, patch, storyId);
        if (!updated) throw new Error('Character Bank not found or no longer belongs to the active story.');
        settings.memoryBank.characterBanks.banks = list;
    });
    notify();
    logEvent('character-memory','bank-updated-durable',{id:updated.id,storyId:updated.storyId,character:updated.character,linkedCount:updated.linkedRefs.length,label},'info');
    return clone(updated);
}

export function removeCharacterBank(id){
    let removed = null;
    updateSettings(s => {
        const list = s.memoryBank?.characterBanks?.banks;
        if (!Array.isArray(list)) return;
        const storyId = currentCharacterBankStoryId();
        const index = list.findIndex(bank => String(bank?.id) === String(id) && normalizeCharacterBankStoryId(bank?.storyId) === storyId);
        if (index < 0) return;
        removed = list[index];
        list.splice(index, 1);
    });
    if (removed) {
        notify();
        logEvent('character-memory','bank-removed',{id:String(id),storyId:normalizeCharacterBankStoryId(removed?.storyId),character:removed.character||''},'info');
    }
    return !!removed;
}

export function setCharacterBanksEnabled(enabled){
    updateSettings(s => {
        s.memoryBank = s.memoryBank || {};
        s.memoryBank.characterBanks = s.memoryBank.characterBanks || { enabled: true, banks: [] };
        s.memoryBank.characterBanks.enabled = enabled === true;
    });
    notify();
}

function notify(){
    try { globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-character-banks-updated')); } catch {}
    try { globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-memory-bank-updated')); } catch {}
}

function recentChatText(maxMessages = 8){
    return (getContext()?.chat || []).slice(-Math.max(1, Number(maxMessages)||8)).map(m => String(m?.mes || '')).join('\n');
}

let lastRuntimeReconciliation = null;
let lastCardRuntimeTrace = new Map();

function normalizedActorNames(value = []){
    return [...new Set((Array.isArray(value) ? value : []).map(value => cleanText(value).toLowerCase()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
}

function sceneParticipantNames(sceneSnapshot = null){
    const values = sceneSnapshot?.acceptedScene?.participants;
    if (!Array.isArray(values)) return null;
    return normalizedActorNames(values);
}
function sceneReferencedCharacterNames(sceneSnapshot = null){
    const rows = sceneSnapshot?.references?.characters;
    if (!Array.isArray(rows)) return [];
    return normalizedActorNames(rows.map(row => row?.name));
}

/**
 * Deterministic scene view for Character Banks. No model calls and no settings
 * mutation occur here. The Work Director may use activeActors as planning data.
 */
export function getCharacterBankSceneSnapshot({ chatText = null, sceneSnapshot = null } = {}){
    const raw = getSettings().memoryBank?.characterBanks || {};
    const sourceBanks = getCharacterBanks();
    const cfg = {
        enabled: raw.enabled !== false,
        banks: sourceBanks.map((bank,index) => normalizeCharacterBank({ ...bank, id: cleanText(bank?.id) || `runtime-bank-${index}` })),
    };
    const text = chatText == null ? recentChatText(8) : String(chatText || '');
    const banks = cfg.banks.map(bank => getCharacterBankRuntime(bank,{chatText:text,sceneSnapshot}));
    const activeActors = normalizedActorNames(banks.filter(bank => bank.enabled && bank.present).map(bank => bank.character));
    const warmActors = normalizedActorNames(banks.filter(bank => bank.enabled && bank.warm).map(bank => bank.character));
    const bankStates = banks.map(bank => ({
        id: bank.id,
        character: bank.character,
        role: bank.role,
        enabled: bank.enabled,
        present: bank.present,
        warm: bank.warm,
        status: bank.status,
        cardBindingState: bank.cardBindingState,
        cardActive: bank.cardActive === true,
        cardInstalled: bank.cardInstalled === true,
        cardAvatar: bank.cardBinding?.avatar || '',
        cardName: bank.cardBinding?.name || '',
        textPresent: bank.textPresent === true,
        linkedRefs: bank.linkedRefs?.length || 0,
    }));
    const state = {
        enabled: cfg.enabled !== false,
        activeActors,
        warmActors,
        bankStates,
    };
    return { ...state, fingerprint: JSON.stringify(state) };
}

function traceBoundCharacterCards(current, source = 'runtime'){
    const next = new Map();
    for (const bank of current?.bankStates || []) {
        const prior = lastCardRuntimeTrace.get(bank.id) || null;
        const snapshot = {
            cardActive: bank.cardActive === true,
            textPresent: bank.textPresent === true,
            cardBindingState: bank.cardBindingState || 'none',
            cardAvatar: bank.cardAvatar || '',
        };
        next.set(bank.id, snapshot);
        if (bank.cardBindingState !== 'bound') continue;
        if (snapshot.cardActive && !prior?.cardActive) {
            logEvent('character-memory','card-active-detected',{
                source,
                bankId:bank.id,
                character:bank.character,
                role:bank.role,
                cardName:bank.cardName || bank.character,
                avatar:bank.cardAvatar,
                linkedCount:bank.linkedRefs || 0,
            },'info');
        }
        if (snapshot.textPresent && !prior?.textPresent) {
            logEvent('character-memory','card-scene-triggered',{
                source,
                bankId:bank.id,
                character:bank.character,
                role:bank.role,
                cardName:bank.cardName || bank.character,
                avatar:bank.cardAvatar,
                trigger:'scene-mention',
                linkedCount:bank.linkedRefs || 0,
            },'info');
        }
    }
    lastCardRuntimeTrace = next;
}

/**
 * Reconcile only ephemeral Character Bank runtime state. Persistent Character
 * Bank configuration remains operator-owned, so this route never enters the
 * Transaction Ledger and never calls a Sidecar.
 */
export function reconcileCharacterBankRuntime({ chatText = null, sceneSnapshot = null, expectedActiveActors = null, source = 'runtime' } = {}){
    const current = getCharacterBankSceneSnapshot({ chatText, sceneSnapshot });
    traceBoundCharacterCards(current, source);
    const expected = expectedActiveActors == null ? null : normalizedActorNames(expectedActiveActors);
    const actorsMatch = expected == null || JSON.stringify(expected) === JSON.stringify(current.activeActors);
    const previous = lastRuntimeReconciliation ? clone(lastRuntimeReconciliation) : null;
    if (!actorsMatch) {
        logEvent('character-memory','runtime-reconcile-skipped',{
            source,
            reason:'scene-actors-changed',
            expectedActiveActors:expected,
            currentActiveActors:current.activeActors,
        },'debug');
        return { skipped:true, reason:'scene-actors-changed', expectedActiveActors:expected, previous, current };
    }
    const changed = !previous || previous.fingerprint !== current.fingerprint;
    lastRuntimeReconciliation = clone(current);
    logEvent('character-memory','runtime-reconciled',{
        source,
        changed,
        activeActors:current.activeActors,
        warmActors:current.warmActors,
        banks:current.bankStates.length,
    }, changed ? 'info' : 'debug');
    return { skipped:false, changed, previous, current };
}

export function getCharacterBankReconciliationState(){
    return lastRuntimeReconciliation ? clone(lastRuntimeReconciliation) : null;
}

export function resetCharacterBankReconciliation(){
    lastRuntimeReconciliation = null;
    lastCardRuntimeTrace = new Map();
}

export function getCharacterBankRuntime(bank, { chatText = null, sceneSnapshot = null } = {}){
    const b = normalizeCharacterBank(bank);
    const cardStatus = characterBankCardStatus(b);
    const text = chatText == null ? recentChatText(8) : String(chatText || '');
    const textPresent = !!b.character && characterPresentInText(b.character, text);
    const participants = sceneParticipantNames(sceneSnapshot);
    const references = sceneReferencedCharacterNames(sceneSnapshot);
    const characterKey = cleanText(b.character).toLowerCase();
    const scannerPresent = participants == null ? null : participants.includes(characterKey);
    const scannerReferenced = references.includes(characterKey);
    // Once Scene Scanner has an accepted snapshot it is authoritative for
    // physical presence. Selecting a SillyTavern card does not prove that the
    // character is physically present in an NPC-only/cutaway scene. Raw text
    // and active-card identity remain fallback/warm evidence only.
    const present = scannerPresent == null ? (textPresent || cardStatus.active === true) : scannerPresent;
    let warm = false;
    let status = 'DORMANT';
    if (!b.enabled || !b.character) status = 'OFF';
    else if (b.role === 'lead') { warm = true; status = present ? 'LEAD · PRESENT' : cardStatus.active ? 'LEAD · ACTIVE CARD' : 'LEAD · WARM'; }
    else if (b.role === 'supporting') {
        warm = b.sceneAware ? (present || scannerReferenced || cardStatus.active === true) : true;
        status = present ? 'SUPPORT · PRESENT' : scannerReferenced ? 'SUPPORT · REFERENCED' : warm ? (cardStatus.active ? 'SUPPORT · ACTIVE CARD' : 'SUPPORT · WARM') : 'SUPPORT · DORMANT';
    } else {
        warm = present || scannerReferenced || cardStatus.active === true;
        status = present ? 'BACKGROUND · PRESENT' : scannerReferenced ? 'BACKGROUND · REFERENCED' : warm && cardStatus.active ? 'BACKGROUND · ACTIVE CARD' : 'BACKGROUND';
    }
    return { ...b, present, textPresent, scannerPresent:scannerPresent===true, scannerReferenced, warm, status, cardBindingState:cardStatus.state, cardInstalled:cardStatus.installed, cardActive:cardStatus.active };
}

function treeContainsUid(book, uid){
    const tree=getTree(book);if(!tree?.root)return false;const target=Number(uid);let found=false;
    const walk=node=>{if(found||!node)return;if((node.entryUids||[]).some(value=>Number(value)===target)){found=true;return;}for(const child of node.children||[])walk(child);};
    walk(tree.root);return found;
}

export function getCharacterWarmRefs({ chatText = null, sceneSnapshot = null } = {}){
    const cfg = normalizeAll();
    if (cfg.enabled === false) return [];
    const text = chatText == null ? recentChatText(8) : String(chatText || '');
    const out = [];
    const seen = new Set();
    for (const bank of getCharacterBanks().map(b => getCharacterBankRuntime(b,{chatText:text,sceneSnapshot}))) {
        if (!bank.warm) continue;
        for (const ref of bank.linkedRefs || []) {
            if (!isBookEnabled(ref.book) || !canReadBook(ref.book) || !isTv2InjectionBook(ref.book) || !isBookInCurrentStory(ref.book,{access:'read'})) continue;
            const resolved=resolveCurrentTreeRef(ref);
            if (!resolved || !treeContainsUid(ref.book, ref.uid)) {
                logEvent('character-memory','dangling-lore-link-skipped',{bankId:bank.id,character:bank.character,book:ref.book,uid:Number(ref.uid)},'warn');
                continue;
            }
            const key = `${resolved.book}:${Number(resolved.uid)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                ...resolved,
                source:`character-bank:${bank.id}`,
                characterBankId:bank.id,
                character:bank.character,
                characterRole:bank.role,
                characterCardBound:bank.cardBindingState === 'bound',
                characterCardActive:bank.cardActive === true,
                characterTextPresent:bank.textPresent === true,
                characterScannerPresent:bank.scannerPresent === true,
                characterScannerReferenced:bank.scannerReferenced === true,
                characterTrigger:bank.scannerPresent ? 'scene-participant' : bank.scannerReferenced ? 'scene-reference' : bank.cardActive ? 'active-card' : (bank.textPresent ? 'scene-mention-fallback' : `${bank.role}-policy`),
                persistentWarm:true,
            });
        }
    }
    return out;
}

export async function resolveCharacterLoreRef(book, uidValue){
    const uidNumber = Number(uidValue);
    const name = cleanText(book);
    if (!name || !Number.isFinite(uidNumber)) throw new Error('A lorebook and numeric UID are required.');
    if (!isBookEnabled(name) || !canReadBook(name) || !isTv2InjectionBook(name)) throw new Error(`Lorebook "${name}" must be Nexus enabled, readable, and use Nexus injection to become a Character Bank warm link.`);
    if (!isBookInCurrentStory(name,{access:'read'})) throw new Error(`Lorebook "${name}" is not readable in the current Story Scope.`);
    const rows = await buildTreeEntryIndex({ books:[name] });
    const row = rows.find(entry => Number(entry.uid) === uidNumber);
    if (!row) throw new Error(`UID ${uidNumber} was not found in the Nexus Tree for "${name}".`);
    return { book:name, uid:uidNumber, title:row.title||'', nodeId:row.nodeId||null, nodeLabel:row.nodeLabel||'', path:Array.isArray(row.path)?row.path:[] };
}

export async function scanCharacterLore(character){
    const name = cleanText(character);
    if (!name) throw new Error('Enter a character name before scanning lore.');
    const books = getActiveBooks({ requireTree:true, access:'read', injection:'tv2' });
    if (!books.length) return [];
    const scanScope = JSON.stringify([...books].map(String).sort());
    // Character scans need a ranked candidate surface, not every matching lore
    // row in memory. searchTree's positive limit is a bounded top-N collector,
    // so very large Trees remain safe before the relevance floor is applied.
    const rows = await searchTree({ query:name, books, includeContent:false, limit:256 });
    const liveBooks=getActiveBooks({ requireTree:true, access:'read', injection:'tv2' });
    const liveScope=JSON.stringify([...liveBooks].map(String).sort());
    if(liveScope!==scanScope){logEvent('character-memory','lore-scan-stale-scope',{character:name,startedBooks:books,currentBooks:liveBooks},'warn');return [];}
    const liveBookSet=new Set(liveBooks.map(String));
    if (!rows.length) return [];
    const best = Math.max(...rows.map(row => Number(row.score)||0), 1);
    const floor = Math.max(5, best * 0.22);
    const kept = rows.filter(row => liveBookSet.has(String(row.book)) && (Number(row.score) >= floor || (row.matched||[]).some(match => ['title-exact','title-phrase','tree-path-phrase','node-summary-phrase'].includes(match))));
    const result = kept.map(row => ({
        book:row.book,
        uid:Number(row.uid),
        title:row.title||'',
        nodeId:row.nodeId||null,
        nodeLabel:row.nodeLabel||'',
        path:Array.isArray(row.path)?row.path:[],
        score:Number(row.score)||0,
        percent:Math.max(1,Math.min(100,Math.round(((Number(row.score)||0)/best)*100))),
        matched:Array.isArray(row.matched)?row.matched:[],
    }));
    logEvent('character-memory','lore-scan',{character:name,books,results:result.length,bestScore:best,scoreFloor:floor},'info');
    return result;
}

export function linkCharacterLore(bankId, ref){
    const bank = getCharacterBank(bankId);
    if (!bank) throw new Error('Character Bank not found.');
    const book=cleanText(ref?.book), uidNumber=Number(ref?.uid);
    if(!book||!Number.isFinite(uidNumber))throw new Error('A current lorebook and numeric UID are required.');
    if(!isBookEnabled(book)||!canReadBook(book)||!isTv2InjectionBook(book)||!isBookInCurrentStory(book,{access:'read'}))throw new Error(`Lorebook "${book}" is no longer legal in the current Story Scope.`);
    if(!treeContainsUid(book,uidNumber))throw new Error(`UID ${uidNumber} is no longer present in the current Nexus Tree for "${book}".`);
    const normalized = normalizeCharacterBank({ ...bank, linkedRefs:[...(bank.linkedRefs||[]), {...ref,book,uid:uidNumber}] });
    return updateCharacterBank(bankId,{linkedRefs:normalized.linkedRefs});
}

export function unlinkCharacterLore(bankId, book, uidValue){
    const bank = getCharacterBank(bankId);
    if (!bank) return null;
    const linkedRefs = (bank.linkedRefs||[]).filter(ref => !(String(ref.book)===String(book)&&Number(ref.uid)===Number(uidValue)));
    return updateCharacterBank(bankId,{linkedRefs});
}

export function linkCharacterMemory(bankId,memoryId){
    const bank=getCharacterBank(bankId);
    if(!bank)throw new Error('Character Bank not found.');
    const id=String(memoryId||''),chatId=String(getContext()?.chatId??'');
    if(!chatId)throw new Error('An active chat is required to link a chat-scoped memory.');
    if(!id||!getAllMemoryRecords().some(record=>record.id===id))throw new Error('Memory record not found.');
    const refs=[...(bank.memoryRefs||[]),{chatId,id}];
    return updateCharacterBank(bankId,{memoryRefs:refs,memoryIds:[...new Set([...(bank.memoryIds||[]),id])]});
}

export function unlinkCharacterMemory(bankId,memoryId){
    const bank=getCharacterBank(bankId);
    if(!bank)return null;
    const id=String(memoryId),chatId=String(getContext()?.chatId??'');
    return updateCharacterBank(bankId,{memoryRefs:(bank.memoryRefs||[]).filter(ref=>!(String(ref.chatId)===chatId&&String(ref.id)===id)),memoryIds:(bank.memoryIds||[]).filter(value=>value!==id)});
}

export function unlinkCharacterMemoryEverywhere(memoryId){
    const id=String(memoryId||''),chatId=String(getContext()?.chatId??'');
    if(!id||!chatId)return [];
    const changed=[];
    for(const bank of getCharacterBanks()){
        const memoryRefs=(bank.memoryRefs||[]).filter(ref=>!(String(ref.chatId)===chatId&&String(ref.id)===id));
        const memoryIds=(bank.memoryIds||[]).filter(value=>String(value)!==id);
        if(memoryRefs.length===(bank.memoryRefs||[]).length&&memoryIds.length===(bank.memoryIds||[]).length)continue;
        const updated=updateCharacterBank(bank.id,{memoryRefs,memoryIds});
        if(updated)changed.push(updated.id);
    }
    if(changed.length)logEvent('character-memory','summary-links-pruned',{memoryId:id,chatId,bankIds:changed},'info');
    return changed;
}

export function isCharacterMemoryExplicitlyLinked(bankOrId,memoryId,{chatId=currentCharacterBankStoryId()}={}){
    const bank=typeof bankOrId==='string'?getCharacterBank(bankOrId):normalizeCharacterBank(bankOrId||{});
    const id=String(memoryId||''),scope=String(chatId||'');
    if(!bank||!id||!scope)return false;
    if((bank.memoryRefs||[]).some(ref=>String(ref.chatId)===scope&&String(ref.id)===id))return true;
    return (bank.memoryIds||[]).some(value=>String(value)===id);
}

export function getCharacterBankMemories(bankOrId){
    const bank = typeof bankOrId === 'string' ? getCharacterBank(bankOrId) : normalizeCharacterBank(bankOrId||{});
    if (!bank?.character) return [];
    const name = bank.character.toLowerCase();
    const chatId=String(getContext()?.chatId??'');
    const explicit=new Set((bank.memoryRefs||[]).filter(ref=>String(ref.chatId)===chatId).map(ref=>String(ref.id)));
    return getAllMemoryRecords().filter(record => {
        if(explicit.has(record.id))return true;
        if ((record.characters||[]).some(value => String(value).toLowerCase() === name)) return true;
        return characterPresentInText(bank.character, record.text||'');
    }).sort((a,b) => (b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0));
}

export function characterBankSummary(){
    const cfg = normalizeAll();
    const banks = getCharacterBanks().map(bank => getCharacterBankRuntime(bank));
    return {
        enabled: cfg.enabled !== false,
        count: banks.length,
        enabledCount: banks.filter(b=>b.enabled).length,
        leadCount: banks.filter(b=>b.enabled&&b.role==='lead').length,
        warmCount: banks.filter(b=>b.enabled&&b.warm).length,
        linkedRefs: banks.reduce((sum,b)=>sum+(b.linkedRefs?.length||0),0),
    };
}

export function buildCharacterSummaryDirective(){
    const cfg = normalizeAll();
    if (cfg.enabled === false) return '';
    const banks = getCharacterBanks().filter(bank => bank.enabled && bank.character);
    if (!banks.length) return '';
    const lines = banks.map(bank => {
        const focus = Object.entries({
            personality:'personality changes', relationships:'relationship changes', status:'status/injuries/equipment', goals:'goals/unresolved threads', behavior:'meaningful behavior changes',
        }).filter(([key])=>bank.tracking?.[key]!==false).map(([,label])=>label).join(', ');
        const reference = [
            bank.profile?.personality ? `baseline personality: ${bank.profile.personality}` : '',
            bank.profile?.appearance ? `appearance: ${bank.profile.appearance}` : '',
            bank.profile?.clothingArmor ? `clothing/armor/equipment: ${bank.profile.clothingArmor}` : '',
        ].filter(Boolean).join('; ');
        return `- ${bank.character} [${bank.role.toUpperCase()}]: preserve ${focus || 'durable character changes'}.${reference ? ` User reference only (do not treat as a new change): ${reference}.` : ''}`;
    });
    return `\nCHARACTER MEMORY BANK FOCUS\nThe user explicitly tracks these characters. When the NEW PASSAGE establishes a durable change about them, preserve it in the summary and include the exact character name in the characters array. Do not invent changes and do not force a character into the summary if nothing changed.\n${lines.join('\n')}\n`;
}
