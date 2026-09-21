import { hashLogicalSource } from './large-input-reshape.js';

/** Canonical local identity for one Merge source. Never delegated to the model. */
export function mergeSourceIdentity(entry,sourceTag='A'){
    const sourceUid=Number(entry?.uid);
    const sourceHash=hashLogicalSource(JSON.stringify({
        uid:sourceUid,
        title:String(entry?.comment||''),
        keys:[...(entry?.key||[])],
        content:String(entry?.content||''),
        disable:entry?.disable===true,
    }));
    return {sourceTag:String(sourceTag),sourceUid,sourceHash};
}

export const MERGE_DRAFT_PROFILES = Object.freeze({
    lean: Object.freeze({ label: 'Lean', detail: 'concise', softOutputTokens: 1200, instruction: 'Prefer a concise, tightly de-duplicated result. Preserve every load-bearing fact even when doing so makes the draft longer than the stylistic target.' }),
    balanced: Object.freeze({ label: 'Balanced', detail: 'balanced', softOutputTokens: 2400, instruction: 'Balance compactness with narrative and continuity detail. Preserve every load-bearing fact; do not compress merely to hit a number.' }),
    heavy: Object.freeze({ label: 'Heavy', detail: 'full-fidelity', softOutputTokens: 4096, instruction: 'Prefer full-fidelity continuity with richer relationship, chronology, behavioral, emotional, and sensory detail. Do not omit grounded canon for brevity.' }),
});

export function normalizeMergeDraftProfile(value='balanced'){
    const key=String(value||'').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(MERGE_DRAFT_PROFILES,key)?key:'balanced';
}

export function mergeDraftProfile(value='balanced'){
    const id=normalizeMergeDraftProfile(value);
    return {id,...MERGE_DRAFT_PROFILES[id]};
}

export function validateMergeDraft(draft){
    if(!String(draft?.content||'').trim())return 'Sidecar returned no merge draft.';
    return true;
}
