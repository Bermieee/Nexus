import { getContext } from '../../../../st-context.js';

const CHARACTER_CARD_FORMATS = new Set(['png', 'json']);

function context() {
    const ctx = getContext?.();
    if (!ctx) throw new Error('SillyTavern context is unavailable.');
    return ctx;
}

function clean(value) { return String(value ?? '').trim(); }
function first(...values) { for (const value of values) if (clean(value)) return clean(value); return ''; }
function list(value) { return Array.isArray(value) ? value.map(item => clean(item)).filter(Boolean) : []; }
function safeFormat(value) {
    const format = clean(value).toLowerCase();
    if (!CHARACTER_CARD_FORMATS.has(format)) throw new Error(`Unsupported character-card format: ${format || 'unknown'}. Use PNG or JSON.`);
    return format;
}
function stableHash(text = '') {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
function cardData(character = {}) { return character?.data && typeof character.data === 'object' ? character.data : {}; }

export function characterCardFormatFromFile(file) {
    const match = clean(file?.name).match(/\.([^.]+)$/);
    return safeFormat(match?.[1]);
}

export function listSillyTavernCharacters() {
    const ctx = context();
    return (Array.isArray(ctx.characters) ? ctx.characters : []).map((character, index) => ({
        index,
        avatar: first(character?.avatar, cardData(character)?.avatar),
        name: first(cardData(character)?.name, character?.name, character?.avatar?.replace(/\.png$/i, '')),
        character,
    })).filter(row => row.avatar || row.name);
}

export function getCurrentSillyTavernCharacter() {
    const ctx = context();
    const index = Number(ctx.characterId);
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(ctx.characters) || !ctx.characters[index]) {
        throw new Error('No individual SillyTavern character is active in the current chat.');
    }
    return { index, character: ctx.characters[index] };
}

export function inspectSillyTavernCharacter(characterLike = null) {
    const source = characterLike?.character || characterLike || getCurrentSillyTavernCharacter().character;
    const data = cardData(source);
    const card = {
        avatar: first(source?.avatar, data?.avatar),
        name: first(data?.name, source?.name, source?.avatar?.replace(/\.png$/i, '')),
        description: first(data?.description, source?.description),
        personality: first(data?.personality, source?.personality),
        scenario: first(data?.scenario, source?.scenario),
        firstMessage: first(data?.first_mes, data?.first_message, source?.first_mes, source?.first_message),
        exampleMessages: first(data?.mes_example, data?.example_messages, source?.mes_example),
        creatorNotes: first(data?.creator_notes, source?.creator_notes),
        creator: first(data?.creator, source?.creator),
        characterVersion: first(data?.character_version, source?.character_version),
        tags: list(data?.tags?.length ? data.tags : source?.tags),
        alternateGreetings: list(data?.alternate_greetings?.length ? data.alternate_greetings : source?.alternate_greetings),
        systemPrompt: first(data?.system_prompt, source?.system_prompt),
        postHistoryInstructions: first(data?.post_history_instructions, source?.post_history_instructions),
    };
    card.fingerprint = stableHash(JSON.stringify(card));
    return card;
}

export async function importCharacterCard(file) {
    if (!file) throw new Error('Choose a character card to import.');
    const ctx = context();
    const format = characterCardFormatFromFile(file);
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', format);
    formData.append('user_name', String(ctx.name1 || ''));
    const response = await fetch('/api/characters/import', {
        method: 'POST', body: formData,
        headers: ctx.getRequestHeaders?.({ omitContentType: true }) || {}, cache: 'no-cache',
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || data?.error) throw new Error(String(data?.message || data?.error || `SillyTavern import failed (${response.status}).`));
    await ctx.getCharacters?.();
    window.dispatchEvent(new CustomEvent('tv2-character-card-imported', { detail: { fileName: data?.file_name || file.name, format } }));
    return { ...data, format };
}

export async function exportCharacterCard({ avatarUrl, format = 'png' } = {}) {
    const ctx = context();
    const normalizedFormat = safeFormat(format);
    const avatar = clean(avatarUrl);
    if (!avatar) throw new Error('Choose a character to export.');
    const response = await fetch('/api/characters/export', {
        method: 'POST', headers: ctx.getRequestHeaders?.() || { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: normalizedFormat, avatar_url: avatar }),
    });
    if (!response.ok) throw new Error(`SillyTavern export failed (${response.status}).`);
    const blob = await response.blob();
    const filename = avatar.replace(/\.png$/i, `.${normalizedFormat}`) || `character.${normalizedFormat}`;
    return { blob, filename, format: normalizedFormat, avatarUrl: avatar };
}

export function downloadCharacterCard({ blob, filename }) {
    if (!(blob instanceof Blob)) throw new Error('Export did not return a character-card file.');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = clean(filename) || 'character-card'; anchor.style.display = 'none';
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Apply a narrowly scoped merge to an existing SillyTavern Character Card.
 * The caller must provide the fingerprint it reviewed. This function refuses
 * to write if the card changed after review, then asks SillyTavern to validate
 * the merged TavernCard before physical persistence.
 */
export async function writeSillyTavernCharacterCardPatch({ avatarUrl, expectedFingerprint, patch = {} } = {}) {
    const ctx = context();
    const avatar = clean(avatarUrl);
    if (!avatar) throw new Error('Character Card write-back requires a bound avatar identity.');
    const row = listSillyTavernCharacters().find(candidate => candidate.avatar === avatar);
    if (!row) throw new Error(`Bound SillyTavern Character Card "${avatar}" is not installed.`);
    const before = inspectSillyTavernCharacter(row.character);
    const expected = clean(expectedFingerprint);
    if (!expected) throw new Error('Character Card write-back requires a reviewed source fingerprint.');
    if (before.fingerprint !== expected) {
        const error = new Error('The SillyTavern Character Card changed after Nexus prepared this diff. Refresh Card Sync and reconcile the newer card before writing.');
        error.name = 'TV2CharacterCardFingerprintMismatch';
        error.expectedFingerprint = expected;
        error.currentFingerprint = before.fingerprint;
        throw error;
    }
    const allowed = {};
    for (const key of ['description', 'personality']) {
        if (Object.prototype.hasOwnProperty.call(patch || {}, key)) allowed[key] = String(patch[key] ?? '');
    }
    if (!Object.keys(allowed).length) return { changed: false, before, after: before, avatarUrl: avatar };
    const dataPatch = { ...allowed };
    const payload = { avatar, ...allowed, data: dataPatch };
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: ctx.getRequestHeaders?.() || { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
    });
    let detail = null;
    try { detail = await response.json(); } catch {}
    if (!response.ok) throw new Error(String(detail?.message || detail?.error || `SillyTavern Character Card update failed (${response.status}).`));
    await ctx.getCharacters?.();
    const refreshed = listSillyTavernCharacters().find(candidate => candidate.avatar === avatar);
    if (!refreshed) throw new Error('SillyTavern saved the Character Card but Nexus could not reload its authoritative card identity.');
    const after = inspectSillyTavernCharacter(refreshed.character);
    for (const [key, value] of Object.entries(allowed)) {
        if (String(after[key] ?? '') !== String(value)) {
            const error = new Error(`SillyTavern Character Card verification failed for ${key}; the saved card did not match the reviewed draft.`);
            error.name = 'TV2CharacterCardWriteVerificationFailed';
            throw error;
        }
    }
    try { window.dispatchEvent(new CustomEvent('tv2-character-card-updated', { detail: { avatar, beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint } })); } catch {}
    return { changed: after.fingerprint !== before.fingerprint, before, after, avatarUrl: avatar };
}
