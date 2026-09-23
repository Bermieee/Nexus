import { stableDecisionFingerprint } from './site-utils.js';

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
    return value;
}
function cleanSiteId(value) { return String(value || 'decision-site').trim() || 'decision-site'; }
export function canonicalDecisionFreshnessInput(input = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return { revisions: stableValue(source.revisions && typeof source.revisions === 'object' && !Array.isArray(source.revisions) ? source.revisions : {}), material: stableValue(Object.prototype.hasOwnProperty.call(source, 'material') ? source.material : null) };
}
export function decisionFreshnessSnapshot(siteId, input = {}) {
    const id = cleanSiteId(siteId), canonical = canonicalDecisionFreshnessInput(input);
    return Object.freeze({ siteId:id, fingerprint:stableDecisionFingerprint(`${id}:freshness`,canonical), revisions:canonical.revisions, materialFingerprint:stableDecisionFingerprint(`${id}:material`,canonical.material) });
}
export function diffDecisionFreshness(initial = null, current = null) {
    const before=initial?.revisions&&typeof initial.revisions==='object'?initial.revisions:{}, after=current?.revisions&&typeof current.revisions==='object'?current.revisions:{};
    const keys=[...new Set([...Object.keys(before),...Object.keys(after)])].sort();
    const revisionChanges=keys.filter(key=>JSON.stringify(stableValue(before[key]??null))!==JSON.stringify(stableValue(after[key]??null))).map(key=>({key,before:before[key]??null,after:after[key]??null}));
    const materialChanged=String(initial?.materialFingerprint||'')!==String(current?.materialFingerprint||'');
    return {changed:String(initial?.fingerprint||'')!==String(current?.fingerprint||''),revisionChanges,materialChanged,initialMaterialFingerprint:initial?.materialFingerprint||null,currentMaterialFingerprint:current?.materialFingerprint||null};
}
/**
 * Initial and final freshness snapshots use this exact same canonical-input
 * builder. The live callback supplies raw current context, never a fingerprint.
 */
export function createDecisionFreshnessContract({siteId,buildCanonicalInput}={}) {
    const id=cleanSiteId(siteId);
    if(typeof buildCanonicalInput!=='function')throw new Error(`Decision freshness ${id} requires buildCanonicalInput().`);
    const snapshot=context=>decisionFreshnessSnapshot(id,buildCanonicalInput(context||{}));
    return Object.freeze({siteId:id,buildCanonicalInput,getInitial(context){return snapshot(context);},async getCurrent(context){const live=typeof context?.readCurrentFreshnessContext==='function'?await context.readCurrentFreshnessContext():context;return snapshot(live||context||{});}});
}
