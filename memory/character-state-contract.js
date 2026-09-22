export const CHARACTER_STATE_SCHEMA = 'nexus-character-state/v1';

export const CHARACTER_STATE_CLASSIFICATION = Object.freeze({
    NEW: 'NEW',
    UPDATE: 'UPDATE',
    REDUNDANT: 'REDUNDANT',
    CONFLICT: 'CONFLICT',
});

export const CHARACTER_STATE_PROPOSAL_STATUS = Object.freeze({
    PENDING: 'pending',
    APPLIED: 'applied',
    REJECTED: 'rejected',
    STALE: 'stale',
});

export const CHARACTER_STATE_DESTINATION = Object.freeze({
    BANK_ONLY: 'bank-only',
    BANK_CARD_ELIGIBLE: 'bank-card-eligible',
});

export const CHARACTER_STATE_FIELDS = Object.freeze({
    'baseline.personality': { layer: 'baseline', label: 'Personality / Temperament', cardEligible: true },
    'baseline.appearance': { layer: 'baseline', label: 'Appearance / Identifying Details', cardEligible: true },
    'baseline.clothingGear': { layer: 'baseline', label: 'Clothing / Signature Gear', cardEligible: true },
    'baseline.identityBackground': { layer: 'baseline', label: 'Identity / Background Anchors', cardEligible: true },

    'persistent.relationships': { layer: 'persistent', label: 'Relationships', cardEligible: false },
    'persistent.goalsMotivations': { layer: 'persistent', label: 'Goals / Motivations', cardEligible: true },
    'persistent.behaviorPatterns': { layer: 'persistent', label: 'Behavior / Recurring Patterns', cardEligible: false },
    'persistent.abilitiesCombat': { layer: 'persistent', label: 'Abilities / Combat', cardEligible: true },
    'persistent.equipment': { layer: 'persistent', label: 'Equipment / Permanent Inventory', cardEligible: true },
    'persistent.backgroundDevelopments': { layer: 'persistent', label: 'Background Developments', cardEligible: true },
    'persistent.conditions': { layer: 'persistent', label: 'Persistent Injuries / Conditions', cardEligible: true },
    'persistent.titlesStatusAffiliations': { layer: 'persistent', label: 'Titles / Status / Affiliations', cardEligible: true },
    'persistent.physicalChanges': { layer: 'persistent', label: 'Permanent Physical Changes', cardEligible: true },

    'temporary.currentOutfit': { layer: 'temporary', label: 'Current Outfit', cardEligible: false },
    'temporary.injuries': { layer: 'temporary', label: 'Current Injuries / Condition', cardEligible: false },
    'temporary.mood': { layer: 'temporary', label: 'Mood / Disposition', cardEligible: false },
    'temporary.magicalEffects': { layer: 'temporary', label: 'Temporary Magical Effects', cardEligible: false },
    'temporary.carriedItems': { layer: 'temporary', label: 'Scene-local Carried Items', cardEligible: false },
    'temporary.physicalCondition': { layer: 'temporary', label: 'Immediate Physical Condition', cardEligible: false },
    'temporary.sceneNotes': { layer: 'temporary', label: 'Scene Notes', cardEligible: false },
});

const BASELINE_KEYS = ['personality', 'appearance', 'clothingGear', 'identityBackground'];
const PERSISTENT_KEYS = ['relationships', 'goalsMotivations', 'behaviorPatterns', 'abilitiesCombat', 'equipment', 'backgroundDevelopments', 'conditions', 'titlesStatusAffiliations', 'physicalChanges'];
const TEMPORARY_KEYS = ['currentOutfit', 'injuries', 'mood', 'magicalEffects', 'carriedItems', 'physicalCondition', 'sceneNotes'];

// Tracking Policy is the hard intake boundary for semantic Character State review.
// Fields outside these five user-facing domains remain editable/importable, but
// Summary/chat review must never manufacture proposals for them.
export const CHARACTER_TRACKING_POLICY = Object.freeze({
    personality: Object.freeze({ label: 'Personality', fields: Object.freeze(['baseline.personality']) }),
    relationships: Object.freeze({ label: 'Relationships', fields: Object.freeze(['persistent.relationships']) }),
    status: Object.freeze({ label: 'Status / conditions / equipment', fields: Object.freeze([
        'baseline.clothingGear',
        'persistent.abilitiesCombat', 'persistent.equipment', 'persistent.conditions', 'persistent.titlesStatusAffiliations', 'persistent.physicalChanges',
        'temporary.currentOutfit', 'temporary.injuries', 'temporary.magicalEffects', 'temporary.carriedItems', 'temporary.physicalCondition',
    ]) }),
    goals: Object.freeze({ label: 'Goals / unresolved threads', fields: Object.freeze(['persistent.goalsMotivations']) }),
    behavior: Object.freeze({ label: 'Behavior changes', fields: Object.freeze(['persistent.behaviorPatterns', 'temporary.mood', 'temporary.sceneNotes']) }),
});

export const CHARACTER_STATE_FIELD_TRACKING_DOMAIN = Object.freeze(Object.fromEntries(
    Object.entries(CHARACTER_TRACKING_POLICY).flatMap(([domain, spec]) => spec.fields.map(field => [field, domain])),
));

export function enabledCharacterTrackingDomains(tracking = {}) {
    return Object.keys(CHARACTER_TRACKING_POLICY).filter(domain => tracking?.[domain] !== false);
}

export function characterTrackingFields(tracking = {}) {
    const out = [];
    for (const domain of enabledCharacterTrackingDomains(tracking)) out.push(...CHARACTER_TRACKING_POLICY[domain].fields);
    return [...new Set(out)].filter(field => !!CHARACTER_STATE_FIELDS[field]);
}

export function characterStateFieldTrackingDomain(field = '') {
    return CHARACTER_STATE_FIELD_TRACKING_DOMAIN[String(field || '')] || null;
}

export function characterStateFieldAllowedByTracking(field = '', tracking = {}) {
    const domain = characterStateFieldTrackingDomain(field);
    return !!domain && tracking?.[domain] !== false;
}
const CLASSIFICATIONS = new Set(Object.values(CHARACTER_STATE_CLASSIFICATION));
const STATUSES = new Set(Object.values(CHARACTER_STATE_PROPOSAL_STATUS));
const DESTINATIONS = new Set(Object.values(CHARACTER_STATE_DESTINATION));

function clone(value){ return value == null ? value : JSON.parse(JSON.stringify(value)); }
function clean(value){ return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function cleanLong(value){ return String(value ?? '').replace(/\r/g, '').trim(); }
function finite(value, fallback = 0){ const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function object(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function cleanRecord(source, keys){ const input = object(source); return Object.fromEntries(keys.map(key => [key, cleanLong(input[key])])); }
function simpleHash(text = ''){ let hash = 2166136261; const source = String(text || ''); for (let i = 0; i < source.length; i++) { hash ^= source.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, '0'); }
function normalizeDecisionReview(raw = null){
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const status = ['agreed','uncertain','unavailable'].includes(clean(raw.status).toLowerCase()) ? clean(raw.status).toLowerCase() : '';
    if (!status) return null;
    const probability = value => { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null; };
    return {
        status,
        provider: clean(raw.provider),
        providerModel: clean(raw.providerModel),
        supported: probability(raw.supported),
        policyFit: probability(raw.policyFit),
        stateChange: probability(raw.stateChange),
        checkedAt: finite(raw.checkedAt, 0),
        reason: cleanLong(raw.reason),
    };
}

export function normalizeCharacterState(raw = {}, legacyProfile = {}){
    const source = object(raw);
    const baseline = cleanRecord(source.baseline, BASELINE_KEYS);
    if (!baseline.personality) baseline.personality = cleanLong(legacyProfile?.personality);
    if (!baseline.appearance) baseline.appearance = cleanLong(legacyProfile?.appearance);
    if (!baseline.clothingGear) baseline.clothingGear = cleanLong(legacyProfile?.clothingArmor);
    const temporary = cleanRecord(source.temporary, TEMPORARY_KEYS);
    return {
        schema: CHARACTER_STATE_SCHEMA,
        baseline,
        persistent: cleanRecord(source.persistent, PERSISTENT_KEYS),
        temporary: {
            ...temporary,
            updatedAt: finite(source.temporary?.updatedAt, 0),
            sceneId: clean(source.temporary?.sceneId),
            sourceRevision: clean(source.temporary?.sourceRevision),
        },
    };
}

export function characterStateToLegacyProfile(state = {}){
    const normalized = normalizeCharacterState(state);
    return {
        personality: normalized.baseline.personality,
        appearance: normalized.baseline.appearance,
        clothingArmor: normalized.baseline.clothingGear,
    };
}

export function getCharacterStateField(state = {}, field = ''){
    if (!CHARACTER_STATE_FIELDS[field]) return '';
    const [layer, key] = String(field).split('.');
    return cleanLong(normalizeCharacterState(state)?.[layer]?.[key]);
}

export function setCharacterStateField(state = {}, field = '', value = ''){
    if (!CHARACTER_STATE_FIELDS[field]) throw new Error(`Unknown Character State field: ${field || '(missing)'}.`);
    const next = normalizeCharacterState(state);
    const [layer, key] = String(field).split('.');
    next[layer][key] = cleanLong(value);
    if (layer === 'temporary') next.temporary.updatedAt = Date.now();
    return next;
}

export function characterStateFingerprint(state = {}){
    const normalized = normalizeCharacterState(state);
    return simpleHash(JSON.stringify({ baseline: normalized.baseline, persistent: normalized.persistent, temporary: normalized.temporary }));
}

export function characterStateFieldFingerprint(state = {}, field = ''){
    return simpleHash(JSON.stringify({ field: String(field), value: getCharacterStateField(state, field) }));
}

export function normalizeCharacterStateSource(raw = {}){
    const source = object(raw);
    return {
        type: clean(source.type) || 'unknown',
        id: clean(source.id),
        chatId: clean(source.chatId),
        sourceRange: Array.isArray(source.sourceRange) ? source.sourceRange.slice(0, 2).map(Number).filter(Number.isFinite) : [],
        messageIds: [...new Set((Array.isArray(source.messageIds) ? source.messageIds : []).map(clean).filter(Boolean))],
        fingerprint: clean(source.fingerprint),
        label: clean(source.label),
    };
}

export function normalizeCharacterStateProposal(raw = {}){
    const field = CHARACTER_STATE_FIELDS[raw.field] ? String(raw.field) : '';
    const descriptor = CHARACTER_STATE_FIELDS[field] || { layer: clean(raw.layer), cardEligible: false };
    const classification = CLASSIFICATIONS.has(String(raw.classification).toUpperCase()) ? String(raw.classification).toUpperCase() : CHARACTER_STATE_CLASSIFICATION.UPDATE;
    const status = STATUSES.has(String(raw.status).toLowerCase()) ? String(raw.status).toLowerCase() : CHARACTER_STATE_PROPOSAL_STATUS.PENDING;
    const destination = DESTINATIONS.has(String(raw.destination)) ? String(raw.destination) : (descriptor.cardEligible ? CHARACTER_STATE_DESTINATION.BANK_CARD_ELIGIBLE : CHARACTER_STATE_DESTINATION.BANK_ONLY);
    return {
        id: clean(raw.id),
        transactionId: clean(raw.transactionId),
        bankId: clean(raw.bankId),
        storyId: clean(raw.storyId),
        character: clean(raw.character),
        field,
        layer: descriptor.layer || clean(raw.layer),
        classification,
        status,
        currentValue: cleanLong(raw.currentValue),
        proposedValue: cleanLong(raw.proposedValue),
        reason: cleanLong(raw.reason),
        evidence: [...new Set((Array.isArray(raw.evidence) ? raw.evidence : []).map(cleanLong).filter(Boolean))],
        source: normalizeCharacterStateSource(raw.source),
        destination,
        cardEligible: destination === CHARACTER_STATE_DESTINATION.BANK_CARD_ELIGIBLE && descriptor.cardEligible === true,
        fieldFingerprint: clean(raw.fieldFingerprint),
        stateFingerprint: clean(raw.stateFingerprint),
        decisionReview: normalizeDecisionReview(raw.decisionReview),
        createdAt: finite(raw.createdAt, Date.now()),
        updatedAt: finite(raw.updatedAt, finite(raw.createdAt, Date.now())),
        resolvedAt: finite(raw.resolvedAt, 0),
        resolutionReason: cleanLong(raw.resolutionReason),
    };
}

export function normalizeCharacterStateProposals(raw = []){
    const seen = new Set();
    const rows = [];
    for (const value of Array.isArray(raw) ? raw : []) {
        const row = normalizeCharacterStateProposal(value);
        if (!row.id || !row.field || seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
    }
    return rows.slice(-200);
}

export function normalizeCharacterChangeHistory(raw = []){
    return (Array.isArray(raw) ? raw : []).map(row => ({
        id: clean(row?.id),
        bankId: clean(row?.bankId),
        storyId: clean(row?.storyId),
        character: clean(row?.character),
        field: CHARACTER_STATE_FIELDS[row?.field] ? String(row.field) : clean(row?.field),
        classification: CLASSIFICATIONS.has(String(row?.classification).toUpperCase()) ? String(row.classification).toUpperCase() : CHARACTER_STATE_CLASSIFICATION.UPDATE,
        oldValue: cleanLong(row?.oldValue),
        newValue: cleanLong(row?.newValue),
        source: normalizeCharacterStateSource(row?.source),
        destination: DESTINATIONS.has(String(row?.destination)) ? String(row.destination) : CHARACTER_STATE_DESTINATION.BANK_ONLY,
        cardWrite: row?.cardWrite === true,
        cardFingerprint: clean(row?.cardFingerprint),
        proposalId: clean(row?.proposalId),
        appliedAt: finite(row?.appliedAt, 0),
    })).filter(row => row.id && row.field).slice(-160);
}

export function normalizeCharacterFieldProvenance(raw = {}){
    const out = {};
    for (const field of Object.keys(CHARACTER_STATE_FIELDS)) {
        const rows = Array.isArray(raw?.[field]) ? raw[field] : [];
        out[field] = rows.map(row => ({
            source: normalizeCharacterStateSource(row?.source || row),
            proposalId: clean(row?.proposalId),
            appliedAt: finite(row?.appliedAt, 0),
        })).filter(row => row.source.type !== 'unknown' || row.source.id || row.proposalId).slice(-12);
    }
    return out;
}

export function normalizeCharacterCardSync(raw = {}){
    const source = object(raw);
    return {
        lastSyncedFingerprint: clean(source.lastSyncedFingerprint),
        lastSyncedAt: finite(source.lastSyncedAt, 0),
        lastDraftFingerprint: clean(source.lastDraftFingerprint),
        pendingEligibleFields: [...new Set((Array.isArray(source.pendingEligibleFields) ? source.pendingEligibleFields : []).filter(field => CHARACTER_STATE_FIELDS[field]?.cardEligible === true).map(String))],
        managedEligibleFields: [...new Set((Array.isArray(source.managedEligibleFields) ? source.managedEligibleFields : []).filter(field => CHARACTER_STATE_FIELDS[field]?.cardEligible === true).map(String))],
        recoveryRequired: source.recoveryRequired === true,
        recoveryReason: cleanLong(source.recoveryReason),
        recoveryTransactionId: clean(source.recoveryTransactionId),
        recoveryAvatar: clean(source.recoveryAvatar),
        recoveryObservedFingerprint: clean(source.recoveryObservedFingerprint),
        inFlightTransactionId: clean(source.inFlightTransactionId),
        inFlightExpectedFingerprint: clean(source.inFlightExpectedFingerprint),
        inFlightAt: finite(source.inFlightAt, 0),
    };
}

export function isCharacterStateField(field){ return !!CHARACTER_STATE_FIELDS[String(field || '')]; }
export function characterStateFieldDescriptor(field){ return CHARACTER_STATE_FIELDS[String(field || '')] ? { ...CHARACTER_STATE_FIELDS[String(field)] } : null; }

export function characterStateValuesEquivalent(a, b){
    const norm = value => cleanLong(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
    return norm(a) === norm(b);
}

export function classifyCharacterStateDelta(currentValue, proposedValue, hintedClassification = null){
    const current = cleanLong(currentValue);
    const proposed = cleanLong(proposedValue);
    const hint = String(hintedClassification || '').toUpperCase();
    if (!proposed || characterStateValuesEquivalent(current, proposed)) return CHARACTER_STATE_CLASSIFICATION.REDUNDANT;
    if (!current) return CHARACTER_STATE_CLASSIFICATION.NEW;
    if (hint === CHARACTER_STATE_CLASSIFICATION.CONFLICT) return CHARACTER_STATE_CLASSIFICATION.CONFLICT;
    return CHARACTER_STATE_CLASSIFICATION.UPDATE;
}

export function describeCharacterStateField(field){
    const descriptor = CHARACTER_STATE_FIELDS[String(field || '')];
    return descriptor ? { field: String(field), ...descriptor } : null;
}

export function cloneCharacterState(value){ return clone(normalizeCharacterState(value)); }
