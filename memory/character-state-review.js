import { getContext } from '../../../../st-context.js';
import { getMemoryRecord } from './store.js';
import {
    getCharacterBanks,
    getCharacterBank,
    getCharacterBankMemories,
    updateCharacterBankDurably,
} from './character-banks.js';
import { characterPresentInText } from './character-match.js';
import {
    CHARACTER_STATE_CLASSIFICATION,
    CHARACTER_STATE_PROPOSAL_STATUS,
    CHARACTER_STATE_DESTINATION,
    CHARACTER_STATE_FIELDS,
    normalizeCharacterStateProposal,
    normalizeCharacterStateSource,
    characterStateFieldDescriptor,
    getCharacterStateField,
    setCharacterStateField,
    characterStateFingerprint,
    characterStateFieldFingerprint,
    classifyCharacterStateDelta,
    characterStateValuesEquivalent,
} from './character-state-contract.js';
import {
    NEXUS_BATCH_DOMAIN,
    runNexusSidecarBatch,
    structuredSidecarOptions,
} from '../nexus/batch-layer.js';
import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import {
    getNexusLedger,
    persistNexusReviewTransaction,
    transitionNexusReviewTransactionDurably,
} from '../nexus/transaction-service.js';
import { currentOperatorReviewScope, normalizeOperatorReviewScope, operatorReviewScopeProjection } from '../nexus/review-scope.js';
import { logEvent } from '../observability/telemetry.js';
import {
    inspectSillyTavernCharacter,
    listSillyTavernCharacters,
    writeSillyTavernCharacterCardPatch,
} from '../character-cards/io.js';
import { buildCardBinding } from '../character-cards/scanner.js';

const MANAGED_START = '[NEXUS CHARACTER STATE START]';
const MANAGED_END = '[NEXUS CHARACTER STATE END]';
const MAX_EVIDENCE_CHARS = 18000;
const MAX_PROPOSALS_PER_REVIEW = 24;

function clean(value) { return String(value ?? '').replace(/\r/g, '').trim(); }
function cleanLine(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function now() { return Date.now(); }
function id(prefix = 'charstate') { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`; }
function hashText(text = '') { let hash = 2166136261; const source = String(text || ''); for (let i = 0; i < source.length; i++) { hash ^= source.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, '0'); }
function normalizeName(value) { return cleanLine(value).toLocaleLowerCase(); }
function unique(values = []) { return [...new Set(values.map(value => cleanLine(value)).filter(Boolean))]; }
function sourceRange(record) { return Array.isArray(record?.turnRange) ? record.turnRange.slice(0, 2).map(Number).filter(Number.isFinite) : []; }
function chatRangeFingerprint(context, range = []) {
    const chat = context?.chat || [];
    const start = Number(range?.[0]), end = Number(range?.[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || start < 0 || end >= chat.length) return '';
    return hashText(chat.slice(start, end + 1).map((message, offset) => {
        const index = start + offset;
        const identity = String(message?.extra?.tv2_message_id || `index:${index}`);
        return `${index}:${identity}:${message?.is_user === true ? 'user' : message?.is_system === true ? 'system' : 'assistant'}:${message?.mes || ''}`;
    }).join('\n'));
}

function memoryFingerprint(record) {
    return hashText(JSON.stringify({
        id: String(record?.id || ''),
        text: String(record?.text || ''),
        updatedAt: Number(record?.updatedAt || 0),
        sourceFingerprint: String(record?.sourceFingerprint || ''),
        sourceMessageIds: Array.isArray(record?.sourceMessageIds) ? record.sourceMessageIds.map(String) : [],
    }));
}

export function characterStateSourceFromChatRange({ context = getContext(), sourceRange = [], label = 'Lifecycle evidence window' } = {}) {
    const range = Array.isArray(sourceRange) ? sourceRange.slice(0, 2).map(Number) : [];
    if (range.length !== 2 || !range.every(Number.isInteger) || range[1] < range[0]) throw new Error('Character State chat-range source requires a valid source range.');
    const chat = context?.chat || [];
    const rows = chat.slice(range[0], range[1] + 1);
    if (!rows.length) throw new Error('Character State chat-range source is empty.');
    return normalizeCharacterStateSource({
        type: 'postturn',
        id: `postturn:${range[0]}-${range[1]}`,
        chatId: context?.chatId || '',
        sourceRange: range,
        messageIds: rows.map((message, offset) => String(message?.extra?.tv2_message_id || `index:${range[0] + offset}`)),
        fingerprint: chatRangeFingerprint(context, range),
        label,
    });
}

export function characterStateSourceFromMemory(record) {
    if (!record?.id) throw new Error('Character State review requires a valid Summary record.');
    return normalizeCharacterStateSource({
        type: 'summary',
        id: record.id,
        chatId: getContext()?.chatId || '',
        sourceRange: sourceRange(record),
        messageIds: record.sourceMessageIds || [],
        fingerprint: memoryFingerprint(record),
        label: record.topics?.[0] || `Summary ${record.id}`,
    });
}

function sourceTextFromMemory(record) { return clean(record?.text).slice(0, MAX_EVIDENCE_CHARS); }

function bankHasMemory(bank, memoryId) {
    if (!memoryId) return false;
    return getCharacterBankMemories(bank).some(memory => String(memory?.id || '') === String(memoryId));
}

export function resolveCharacterReviewBanks({ text = '', characters = [], sourceId = '', bankIds = null } = {}) {
    const explicitIds = Array.isArray(bankIds) ? new Set(bankIds.map(String)) : null;
    const named = new Set((Array.isArray(characters) ? characters : []).map(normalizeName).filter(Boolean));
    const banks = getCharacterBanks().filter(bank => bank.enabled !== false);
    return banks.filter(bank => {
        if (explicitIds) return explicitIds.has(String(bank.id));
        const name = normalizeName(bank.character);
        if (!name) return false;
        if (named.has(name)) return true;
        if (sourceId && bankHasMemory(bank, sourceId)) return true;
        return characterPresentInText(bank.character, String(text || ''));
    });
}

function compactStateForPrompt(bank) {
    const out = {};
    for (const field of Object.keys(CHARACTER_STATE_FIELDS)) {
        const value = getCharacterStateField(bank.state, field);
        if (value) out[field] = value;
    }
    return out;
}

function allowedFieldsText() {
    return Object.entries(CHARACTER_STATE_FIELDS).map(([field, meta]) => `- ${field}: ${meta.label} (${meta.layer}${meta.cardEligible ? ', card-eligible' : ''})`).join('\n');
}

function reviewPrompt({ bank, source, text }) {
    return `Nexus CHARACTER STATE REVIEW\n\nTRACKED CHARACTER\n${bank.character}\n\nCURRENT CHARACTER STATE\n${JSON.stringify(compactStateForPrompt(bank), null, 2)}\n\nEVIDENCE SOURCE\nType: ${source.type}\nID: ${source.id || '(none)'}\n${text || '(empty)'}\n\nALLOWED FIELDS\n${allowedFieldsText()}\n\nTASK\nCompare only evidence about the tracked character against CURRENT CHARACTER STATE. Extract field-level character continuity deltas. Do not summarize the scene. Do not copy room descriptions, other characters' facts, general lore, narration, or speculation. Temporary scene facts MUST use temporary.* fields and must not be promoted into baseline or persistent state. Permanent scars, lasting physical changes, durable abilities, titles, equipment changes, goals, relationships, and identity developments may use persistent.* or baseline.* where appropriate. If the current state already covers the same meaning, classify REDUNDANT. If evidence materially contradicts canonical state, classify CONFLICT. If no character-specific state is supported, return an empty changes array. Never invent facts or infer motives beyond the source.\n\nReturn ONLY JSON:\n{"changes":[{"field":"baseline.personality|baseline.appearance|baseline.clothingGear|baseline.identityBackground|persistent.relationships|persistent.goalsMotivations|persistent.abilitiesCombat|persistent.equipment|persistent.backgroundDevelopments|persistent.conditions|persistent.titlesStatusAffiliations|persistent.physicalChanges|temporary.currentOutfit|temporary.injuries|temporary.mood|temporary.magicalEffects|temporary.carriedItems|temporary.physicalCondition|temporary.sceneNotes","proposedValue":"complete field value after applying the supported delta","classification":"NEW|UPDATE|REDUNDANT|CONFLICT","reason":"short comparison reason","evidence":["brief source-supported fact"]}],"reasoning":"short overall review note"}`;
}

function validateReviewPayload(payload, bank) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { valid: false, reason: 'Character review must return one JSON object.' };
    if (!Array.isArray(payload.changes)) return { valid: false, reason: 'Character review JSON is missing changes[].' };
    if (payload.changes.length > MAX_PROPOSALS_PER_REVIEW) return { valid: false, reason: 'Character review returned too many field changes.' };
    const seen = new Set();
    for (const change of payload.changes) {
        const field = String(change?.field || '');
        if (!CHARACTER_STATE_FIELDS[field]) return { valid: false, reason: `Unknown Character State field: ${field || '(missing)'}.` };
        if (seen.has(field)) return { valid: false, reason: `Character review returned duplicate field ${field}.` };
        seen.add(field);
        if (!clean(change?.proposedValue) && String(change?.classification || '').toUpperCase() !== CHARACTER_STATE_CLASSIFICATION.REDUNDANT) return { valid: false, reason: `Character review returned an empty proposed value for ${field}.` };
        const classification = String(change?.classification || '').toUpperCase();
        if (!Object.values(CHARACTER_STATE_CLASSIFICATION).includes(classification)) return { valid: false, reason: `Unknown Character State classification ${classification || '(missing)'}.` };
    }
    return { valid: true, value: payload, reason: null, bankId: bank.id };
}

function classifyReturnedChange(bank, raw) {
    const field = String(raw?.field || '');
    const currentValue = getCharacterStateField(bank.state, field);
    const proposedValue = clean(raw?.proposedValue);
    const hinted = String(raw?.classification || '').toUpperCase();
    let classification = classifyCharacterStateDelta(currentValue, proposedValue, hinted);
    if (hinted === CHARACTER_STATE_CLASSIFICATION.REDUNDANT && currentValue && proposedValue) classification = CHARACTER_STATE_CLASSIFICATION.REDUNDANT;
    if (hinted === CHARACTER_STATE_CLASSIFICATION.CONFLICT && !characterStateValuesEquivalent(currentValue, proposedValue)) classification = CHARACTER_STATE_CLASSIFICATION.CONFLICT;
    return { field, currentValue, proposedValue, classification };
}

function pendingDuplicate(bank, field, proposedValue, source) {
    return (bank.stateProposals || []).find(row => row.status === CHARACTER_STATE_PROPOSAL_STATUS.PENDING
        && row.field === field
        && characterStateValuesEquivalent(row.proposedValue, proposedValue)
        && String(row.source?.fingerprint || '') === String(source?.fingerprint || '')) || null;
}

function proposalAssumptions(bank, field, source) {
    return {
        chatId: String(getContext()?.chatId || ''),
        storyId: String(bank.storyId || ''),
        bankId: String(bank.id || ''),
        field,
        fieldFingerprint: characterStateFieldFingerprint(bank.state, field),
        sourceType: String(source?.type || ''),
        sourceId: String(source?.id || ''),
        sourceFingerprint: String(source?.fingerprint || ''),
    };
}

function characterStateReviewScope(proposal = {}) {
    const scope = currentOperatorReviewScope();
    if (scope.kind !== 'chat' || !scope.chatId) {
        const error = new Error('Character State review requires an active chat-scoped Operator Review authority.');
        error.name = 'TV2OperatorReviewScopeUnavailable';
        throw error;
    }
    const proposalChatId = String(proposal?.source?.chatId || proposal?.chatId || '').trim();
    if (proposalChatId && proposalChatId !== String(scope.chatId || '')) {
        const error = new Error('Character State review belongs to a different chat scope.');
        error.name = 'TV2OperatorReviewScopeMismatch';
        throw error;
    }
    return scope;
}

function transactionHasCharacterReviewScope(tx, scope, proposal) {
    if (!tx || String(tx.type || '') !== 'character-state-proposal') return false;
    const tagged = tx?.metadata?.reviewScope;
    const identity = tagged ? normalizeOperatorReviewScope(tagged).identity : String(tx?.assumptions?.operatorReviewScope || '').trim();
    if (!identity || identity !== String(scope.identity || '')) return false;
    const chatId = String(tx?.assumptions?.chatId ?? tx?.metadata?.reviewScope?.chatId ?? '');
    if (!chatId || chatId !== String(scope.chatId || '')) return false;
    if (String(tx?.input?.bankId || '') !== String(proposal?.bankId || '')) return false;
    if (String(tx?.input?.field || '') !== String(proposal?.field || '')) return false;
    return true;
}

function legacyCharacterReviewTransactionIsAdoptable(tx, scope, proposal) {
    if (!tx || String(tx.type || '') !== 'character-state-proposal') return false;
    const taggedIdentity = tx?.metadata?.reviewScope ? normalizeOperatorReviewScope(tx.metadata.reviewScope).identity : '';
    const assumedIdentity = String(tx?.assumptions?.operatorReviewScope || '').trim();
    // A transaction that already declares another scope is not legacy; fail closed.
    if (taggedIdentity || assumedIdentity) return false;
    const chatId = String(tx?.assumptions?.chatId || '').trim();
    return !!chatId
        && chatId === String(scope.chatId || '')
        && String(tx?.input?.bankId || '') === String(proposal?.bankId || '')
        && String(tx?.input?.field || '') === String(proposal?.field || '');
}

async function stageProposalTransaction(proposal) {
    const ledger = getNexusLedger();
    const reviewScope = characterStateReviewScope(proposal);
    const assumptions = {
        chatId: proposal.source.chatId || reviewScope.chatId || '',
        storyId: proposal.storyId,
        bankId: proposal.bankId,
        field: proposal.field,
        fieldFingerprint: proposal.fieldFingerprint,
        sourceType: proposal.source.type,
        sourceId: proposal.source.id,
        sourceFingerprint: proposal.source.fingerprint,
        operatorReviewScope: reviewScope.identity,
    };
    let tx = ledger.begin({
        type: 'character-state-proposal',
        input: { bankId: proposal.bankId, field: proposal.field, source: proposal.source },
        assumptions,
        metadata: { source: 'character-state', domain: 'character-state', character: proposal.character, classification: proposal.classification, reviewScope: operatorReviewScopeProjection(reviewScope, 0) },
    });
    ledger.executing(tx.id);
    ledger.parsed(tx.id, { proposedValue: proposal.proposedValue, classification: proposal.classification, reason: proposal.reason });
    ledger.validated(tx.id, { passed: true, field: proposal.field });
    tx = ledger.staged(tx.id, { bankId: proposal.bankId, field: proposal.field, proposedValue: proposal.proposedValue }, {
        mutationProposal: {
            id: `charstate_mut_${proposal.id}`,
            type: 'character-state-field-update',
            target: { bankId: proposal.bankId, field: proposal.field },
            draft: { value: proposal.proposedValue, destination: proposal.destination },
            assumptions,
            approvalRequired: true,
            metadata: { character: proposal.character, classification: proposal.classification, source: proposal.source },
        },
    });
    await persistNexusReviewTransaction(tx.id);
    return tx.id;
}

async function storeReviewResults(bank, rows) {
    if (!rows.length) return bank;
    return await updateCharacterBankDurably(bank.id, { stateProposals: [...(bank.stateProposals || []), ...rows] }, { label: `Character State review · ${bank.character || bank.id}` });
}

async function ensureScopedProposalTransaction(bank, proposal) {
    if (!proposal?.id || proposal.status !== CHARACTER_STATE_PROPOSAL_STATUS.PENDING) return { bank, proposal };
    const ledger = getNexusLedger();
    const reviewScope = characterStateReviewScope(proposal);
    const current = proposal.transactionId ? ledger.read(proposal.transactionId) : null;
    if (transactionHasCharacterReviewScope(current, reviewScope, proposal)) return { bank, proposal };

    if (current) {
        const taggedIdentity = current?.metadata?.reviewScope ? normalizeOperatorReviewScope(current.metadata.reviewScope).identity : '';
        const assumedIdentity = String(current?.assumptions?.operatorReviewScope || '').trim();
        if ((taggedIdentity || assumedIdentity) && !legacyCharacterReviewTransactionIsAdoptable(current, reviewScope, proposal)) {
            const error = new Error(`Character State review transaction ${current.id} belongs to a different review scope.`);
            error.name = 'TV2OperatorReviewScopeMismatch';
            throw error;
        }
        if (String(current.type || '') !== 'character-state-proposal') {
            const error = new Error(`Character State proposal ${proposal.id} references an unexpected Ledger transaction type.`);
            error.name = 'TV2CharacterStateTransactionMismatch';
            throw error;
        }
    }

    // Legacy Character State proposals created before typed review scopes may
    // point at an unscoped or no-longer-restored Ledger transaction. Re-stage
    // from the authoritative Character Bank proposal rather than weakening the
    // Operator Review store's fail-closed scope checks.
    const replacementId = await stageProposalTransaction({ ...proposal, transactionId: '' });
    const rows = (bank.stateProposals || []).map(row => row.id === proposal.id
        ? normalizeCharacterStateProposal({ ...row, transactionId: replacementId, updatedAt: now() })
        : row);
    const saved = await updateCharacterBankDurably(bank.id, { stateProposals: rows }, { label: `Repair Character State review scope · ${bank.character}` });
    if (current && legacyCharacterReviewTransactionIsAdoptable(current, reviewScope, proposal) && String(current.state || '') === 'staged') {
        try { ledger.cancel(current.id, 'Superseded by typed Character State review transaction.'); } catch {}
    }
    const repaired = saved.stateProposals.find(row => row.id === proposal.id);
    logEvent('character-state', 'review-transaction-restaged', { bankId: bank.id, character: bank.character, proposalId: proposal.id, priorTransactionId: proposal.transactionId || null, transactionId: replacementId, sourceType: proposal.source?.type || null, sourceId: proposal.source?.id || null }, 'warn');
    return { bank: saved, proposal: repaired };
}

async function executeReviewForBank({ bank, source, text, runBatch = runNexusSidecarBatch } = {}) {
    const prompt = reviewPrompt({ bank, source, text });
    const systemPrompt = 'You are Nexus Character State comparison. Return validated JSON only. You propose; Nexus owns classification validation, persistence, approval, and mutation.';
    const result = await runBatch({
        domain: NEXUS_BATCH_DOMAIN.MEMORY_BANK,
        stage: BUS_STAGE.SUMMARY,
        items: [{ bankId: bank.id }],
        requestedBatch: false,
        label: `Character State Review · ${bank.character || bank.id}`,
        priority: BUS_PRIORITY.SUMMARY,
        buildRequest: () => structuredSidecarOptions({
            prompt,
            systemPrompt,
            maxTokens: 2400,
            priority: BUS_PRIORITY.SUMMARY,
            structuredValidator: value => validateReviewPayload(value, bank),
            telemetry: { characterStateReview: true, bankId: bank.id, sourceType: source.type, sourceId: source.id },
        }),
        parse: textValue => parseStructuredJsonCandidate(textValue, { validator: value => validateReviewPayload(value, bank), label: `Character State Review for ${bank.character || bank.id}` }),
        validate: value => validateReviewPayload(value, bank),
        buildRecovery: () => structuredSidecarOptions({
            prompt: `${prompt}\n\nRECOVERY: Return one corrected JSON object only. Use only the allowed fields and this exact character evidence.`,
            systemPrompt,
            maxTokens: 2400,
            priority: BUS_PRIORITY.SUMMARY,
            structuredValidator: value => validateReviewPayload(value, bank),
            telemetry: { characterStateReview: true, recovery: true, bankId: bank.id, sourceType: source.type, sourceId: source.id },
        }),
    });
    const outcome = result.completed?.[0];
    if (!outcome) throw new Error(result.failed?.[0]?.error?.message || `Character State Review failed for ${bank.character || bank.id}.`);
    return { payload: outcome.value, slot: outcome.response?.tv2?.slot || null, jobId: outcome.jobId || outcome.response?.tv2?.jobId || null, recovered: outcome.recovered === true };
}

export async function reviewCharacterEvidence({ source, text, characters = [], bankIds = null, runBatch = runNexusSidecarBatch } = {}) {
    const normalizedSource = normalizeCharacterStateSource(source || {});
    const evidenceText = clean(text).slice(0, MAX_EVIDENCE_CHARS);
    if (!evidenceText) return { reviewed: 0, proposals: [], redundant: [], reason: 'Evidence was empty.' };
    const banks = resolveCharacterReviewBanks({ text: evidenceText, characters, sourceId: normalizedSource.id, bankIds });
    if (!banks.length) return { reviewed: 0, proposals: [], redundant: [], reason: 'No configured Character Bank was relevant to this evidence.' };
    const proposals = [], redundant = [], reviews = [];
    for (const initialBank of banks) {
        const bank = getCharacterBank(initialBank.id);
        if (!bank || bank.enabled === false) continue;
        const execution = await executeReviewForBank({ bank, source: normalizedSource, text: evidenceText, runBatch });
        const stagedRows = [];
        try {
            for (const raw of execution.payload?.changes || []) {
                const classified = classifyReturnedChange(bank, raw);
                const descriptor = characterStateFieldDescriptor(classified.field);
                if (!descriptor) continue;
                const normalizedRow = {
                    id: id('charstate_prop'),
                    bankId: bank.id,
                    storyId: bank.storyId,
                    character: bank.character,
                    field: classified.field,
                    layer: descriptor.layer,
                    classification: classified.classification,
                    status: CHARACTER_STATE_PROPOSAL_STATUS.PENDING,
                    currentValue: classified.currentValue,
                    proposedValue: classified.proposedValue,
                    reason: clean(raw?.reason),
                    evidence: unique(Array.isArray(raw?.evidence) ? raw.evidence : []),
                    source: normalizedSource,
                    destination: descriptor.cardEligible ? CHARACTER_STATE_DESTINATION.BANK_CARD_ELIGIBLE : CHARACTER_STATE_DESTINATION.BANK_ONLY,
                    cardEligible: descriptor.cardEligible === true,
                    fieldFingerprint: characterStateFieldFingerprint(bank.state, classified.field),
                    stateFingerprint: characterStateFingerprint(bank.state),
                    createdAt: now(),
                    updatedAt: now(),
                };
                if (classified.classification === CHARACTER_STATE_CLASSIFICATION.REDUNDANT) {
                    redundant.push(normalizeCharacterStateProposal({ ...normalizedRow, status: CHARACTER_STATE_PROPOSAL_STATUS.APPLIED, resolutionReason: 'Existing Character State already covers equivalent information.', resolvedAt: now() }));
                    continue;
                }
                const duplicate = pendingDuplicate(bank, classified.field, classified.proposedValue, normalizedSource) || stagedRows.find(row => row.field === classified.field && characterStateValuesEquivalent(row.proposedValue, classified.proposedValue));
                if (duplicate) continue;
                const proposal = normalizeCharacterStateProposal(normalizedRow);
                proposal.transactionId = await stageProposalTransaction(proposal);
                stagedRows.push(proposal);
            }
            if (stagedRows.length) await storeReviewResults(bank, stagedRows);
        } catch (error) {
            // A proposal is not authoritative until Character Bank persistence owns
            // it. Do not leave staged Ledger review rows orphaned if local proposal
            // persistence fails after staging one or more rows.
            for (const proposal of stagedRows) {
                try { await transitionLedger(proposal.transactionId, shadow => shadow.abort(proposal.transactionId, 'Character Bank proposal persistence failed before review publication.'), { failClosed: false }); } catch {}
            }
            throw error;
        }
        proposals.push(...stagedRows);
        reviews.push({ bankId: bank.id, character: bank.character, changes: execution.payload?.changes?.length || 0, staged: stagedRows.length, slot: execution.slot, jobId: execution.jobId, recovered: execution.recovered });
        logEvent('character-state', 'review-complete', { bankId: bank.id, character: bank.character, sourceType: normalizedSource.type, sourceId: normalizedSource.id, staged: stagedRows.length, redundant: (execution.payload?.changes || []).length - stagedRows.length, slot: execution.slot, jobId: execution.jobId }, stagedRows.length ? 'info' : 'debug');
    }
    return { reviewed: reviews.length, proposals: clone(proposals), redundant: clone(redundant), reviews, reason: proposals.length ? `${proposals.length} Character State change proposal${proposals.length === 1 ? '' : 's'} staged.` : 'No Character Bank changes detected. Existing state already covers the character-specific information in this evidence.' };
}

export async function reviewSummaryForCharacterState(memoryId, options = {}) {
    const record = getMemoryRecord(memoryId);
    if (!record) throw new Error('Summary no longer exists.');
    const source = characterStateSourceFromMemory(record);
    return await reviewCharacterEvidence({
        source,
        text: sourceTextFromMemory(record),
        characters: record.characters || [],
        bankIds: options.bankIds || null,
        runBatch: options.runBatch || runNexusSidecarBatch,
    });
}

function currentSourceFingerprint(source) {
    if (source?.type === 'summary' && source.id) {
        const record = getMemoryRecord(source.id);
        return record ? memoryFingerprint(record) : null;
    }
    if (source?.type === 'postturn' || source?.type === 'chat') {
        const ctx = getContext();
        if (source.chatId && String(ctx?.chatId || '') !== String(source.chatId)) return null;
        if (Array.isArray(source.sourceRange) && source.sourceRange.length === 2) return chatRangeFingerprint(ctx, source.sourceRange) || null;
        const wanted = new Set((source.messageIds || []).map(String));
        if (!wanted.size) return source.fingerprint || '';
        const rows = (ctx?.chat || []).filter((message, index) => wanted.has(String(message?.extra?.tv2_message_id || `index:${index}`)));
        if (rows.length !== wanted.size) return null;
        return hashText(rows.map((message, index) => `${message?.extra?.tv2_message_id || `index:${index}`}:${message?.mes || ''}`).join('\n'));
    }
    return source?.fingerprint || '';
}

function proposalFreshness(bank, proposal) {
    const changes = [];
    if (!bank) changes.push('bank-missing');
    else {
        if (String(bank.storyId || '') !== String(proposal.storyId || '')) changes.push('story-changed');
        if (characterStateFieldFingerprint(bank.state, proposal.field) !== String(proposal.fieldFingerprint || '')) changes.push('field-changed');
    }
    const currentFingerprint = currentSourceFingerprint(proposal.source);
    if (proposal.source?.fingerprint && currentFingerprint !== proposal.source.fingerprint) changes.push('source-changed');
    return { fresh: changes.length === 0, changes, currentSourceFingerprint: currentFingerprint };
}

async function updateProposalStatus(bank, proposalId, patch, label) {
    const rows = (bank.stateProposals || []).map(row => row.id === proposalId ? normalizeCharacterStateProposal({ ...row, ...patch, updatedAt: now() }) : row);
    return await updateCharacterBankDurably(bank.id, { stateProposals: rows }, { label });
}

async function transitionLedger(transactionId, transition, { failClosed = true } = {}) {
    if (!transactionId) {
        if (failClosed) throw new Error('Character State mutation requires a staged Ledger transaction.');
        return null;
    }
    try { return await transitionNexusReviewTransactionDurably(transactionId, transition); }
    catch (error) {
        logEvent('character-state', 'ledger-transition-failed', { transactionId, error }, failClosed ? 'error' : 'warn');
        if (failClosed) throw error;
        return null;
    }
}

export async function rejectCharacterStateProposal(proposalId, reason = 'Rejected by operator.') {
    const banks = getCharacterBanks();
    let bank = banks.find(row => (row.stateProposals || []).some(proposal => proposal.id === String(proposalId)));
    let proposal = bank?.stateProposals?.find(row => row.id === String(proposalId));
    if (!bank || !proposal) throw new Error('Character State proposal not found.');
    if (proposal.status !== CHARACTER_STATE_PROPOSAL_STATUS.PENDING) return clone(proposal);
    ({ bank, proposal } = await ensureScopedProposalTransaction(bank, proposal));
    const saved = await updateProposalStatus(bank, proposal.id, { status: CHARACTER_STATE_PROPOSAL_STATUS.REJECTED, resolvedAt: now(), resolutionReason: reason }, `Reject Character State proposal · ${bank.character}`);
    await transitionLedger(proposal.transactionId, shadow => shadow.reject(proposal.transactionId, reason));
    return clone(saved.stateProposals.find(row => row.id === proposal.id));
}

function historyEntry(bank, proposal, oldValue, newValue) {
    return {
        id: id('charstate_change'),
        bankId: bank.id,
        storyId: bank.storyId,
        character: bank.character,
        field: proposal.field,
        classification: proposal.classification,
        oldValue,
        newValue,
        source: proposal.source,
        destination: proposal.destination,
        cardWrite: false,
        cardFingerprint: '',
        proposalId: proposal.id,
        appliedAt: now(),
    };
}

export async function approveCharacterStateProposal(proposalId) {
    let bank = getCharacterBanks().find(row => (row.stateProposals || []).some(proposal => proposal.id === String(proposalId)));
    let proposal = bank?.stateProposals?.find(row => row.id === String(proposalId));
    if (!bank || !proposal) throw new Error('Character State proposal not found.');
    if (proposal.status !== CHARACTER_STATE_PROPOSAL_STATUS.PENDING) return clone(proposal);
    ({ bank, proposal } = await ensureScopedProposalTransaction(bank, proposal));
    const freshness = proposalFreshness(bank, proposal);
    if (!freshness.fresh) {
        const reason = `Character State proposal became stale: ${freshness.changes.join(', ')}.`;
        const saved = await updateProposalStatus(bank, proposal.id, { status: CHARACTER_STATE_PROPOSAL_STATUS.STALE, resolvedAt: now(), resolutionReason: reason }, `Stale Character State proposal · ${bank.character}`);
        await transitionLedger(proposal.transactionId, shadow => shadow.stale(proposal.transactionId, reason, freshness));
        return clone(saved.stateProposals.find(row => row.id === proposal.id));
    }
    const currentAssumptions = proposalAssumptions(bank, proposal.field, proposal.source);
    await transitionLedger(proposal.transactionId, shadow => shadow.approve(proposal.transactionId, { by: 'operator', metadata: { surface: 'character-state-review' } }));
    const prepared = await transitionLedger(proposal.transactionId, shadow => shadow.prepareCommit(proposal.transactionId, { currentAssumptions }));
    if (prepared?.state === 'stale') {
        const reason = 'Character State proposal became stale before commit.';
        const saved = await updateProposalStatus(bank, proposal.id, { status: CHARACTER_STATE_PROPOSAL_STATUS.STALE, resolvedAt: now(), resolutionReason: reason }, `Stale Character State proposal · ${bank.character}`);
        return clone(saved.stateProposals.find(row => row.id === proposal.id));
    }
    const oldValue = getCharacterStateField(bank.state, proposal.field);
    const nextState = setCharacterStateField(bank.state, proposal.field, proposal.proposedValue);
    if (proposal.field.startsWith('temporary.')) {
        nextState.temporary.sceneId = String(getContext()?.chatId || '');
        nextState.temporary.sourceRevision = proposal.source.fingerprint || '';
    }
    const proposals = (bank.stateProposals || []).map(row => row.id === proposal.id ? normalizeCharacterStateProposal({ ...row, status: CHARACTER_STATE_PROPOSAL_STATUS.APPLIED, resolvedAt: now(), resolutionReason: 'Approved by operator.', updatedAt: now() }) : row);
    const history = [...(bank.changeHistory || []), historyEntry(bank, proposal, oldValue, proposal.proposedValue)];
    const provenance = clone(bank.fieldProvenance || {});
    provenance[proposal.field] = [...(provenance[proposal.field] || []), { source: proposal.source, proposalId: proposal.id, appliedAt: now() }].slice(-12);
    const pendingEligibleFields = new Set(bank.cardSync?.pendingEligibleFields || []);
    if (proposal.cardEligible) pendingEligibleFields.add(proposal.field);
    let saved;
    try {
        saved = await updateCharacterBankDurably(bank.id, {
            state: nextState,
            stateProposals: proposals,
            changeHistory: history,
            fieldProvenance: provenance,
            cardSync: { ...(bank.cardSync || {}), pendingEligibleFields: [...pendingEligibleFields] },
        }, { label: `Apply Character State · ${bank.character} · ${proposal.field}` });
    } catch (error) {
        await transitionLedger(proposal.transactionId, shadow => shadow.fail(proposal.transactionId, error, { phase: 'character-bank-persistence' }));
        throw error;
    }
    await transitionLedger(proposal.transactionId, shadow => shadow.completeCommit(proposal.transactionId, { bankId: bank.id, field: proposal.field, value: proposal.proposedValue, appliedAt: now() }));
    logEvent('character-state', 'proposal-applied', { bankId: bank.id, character: bank.character, proposalId: proposal.id, transactionId: proposal.transactionId, field: proposal.field, classification: proposal.classification, cardEligible: proposal.cardEligible }, 'info');
    return clone(saved.stateProposals.find(row => row.id === proposal.id));
}

export async function applySelectedCharacterStateProposals(proposalIds = []) {
    const results = [];
    for (const proposalId of unique(proposalIds)) {
        try {
            const value = await approveCharacterStateProposal(proposalId);
            results.push({ proposalId, status: 'fulfilled', value });
        } catch (error) {
            results.push({ proposalId, status: 'rejected', error: error?.message || String(error) });
        }
    }
    const applied = results.filter(row => row.status === 'fulfilled' && row.value?.status === CHARACTER_STATE_PROPOSAL_STATUS.APPLIED);
    const stale = results.filter(row => row.status === 'fulfilled' && row.value?.status === CHARACTER_STATE_PROPOSAL_STATUS.STALE);
    const failed = results.filter(row => row.status === 'rejected');
    return { results, applied, stale, failed };
}

export function getCharacterStateReviewSnapshot(bankId = null) {
    const banks = bankId ? [getCharacterBank(bankId)].filter(Boolean) : getCharacterBanks();
    const proposals = banks.flatMap(bank => (bank.stateProposals || []).map(proposal => ({ ...proposal, bankCharacter: bank.character })))
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    return {
        pending: proposals.filter(row => row.status === CHARACTER_STATE_PROPOSAL_STATUS.PENDING),
        resolved: proposals.filter(row => row.status !== CHARACTER_STATE_PROPOSAL_STATUS.PENDING),
        proposals,
    };
}

function stripManagedBlock(text = '') {
    const source = clean(text);
    if (!source) return '';
    const start = source.indexOf(MANAGED_START), end = source.indexOf(MANAGED_END);
    if (start < 0 || end < start) return source;
    return clean(`${source.slice(0, start)}${source.slice(end + MANAGED_END.length)}`);
}

function managedLines(bank, fields) {
    const selected = new Set(fields || []);
    const rows = [];
    for (const field of Object.keys(CHARACTER_STATE_FIELDS)) {
        if (!selected.has(field)) continue;
        const value = getCharacterStateField(bank.state, field);
        if (!value) continue;
        const descriptor = CHARACTER_STATE_FIELDS[field];
        rows.push(`${descriptor.label}: ${value}`);
    }
    return rows;
}

function withManagedBlock(original, lines) {
    const base = stripManagedBlock(original);
    if (!lines.length) return base;
    return [base, base ? '' : '', MANAGED_START, ...lines, MANAGED_END].filter((value, index, array) => !(value === '' && index === 0) && !(value === '' && array[index - 1] === '')).join('\n').trim();
}

export function buildCharacterCardSyncDraft(bankId) {
    const bank = getCharacterBank(bankId);
    if (!bank) throw new Error('Character Bank not found.');
    if (!bank.cardBinding?.avatar) return { available: false, reason: 'Character Bank is not bound to a SillyTavern Character Card.', bank };
    const row = listSillyTavernCharacters().find(candidate => candidate.avatar === bank.cardBinding.avatar);
    if (!row) return { available: false, reason: 'Bound SillyTavern Character Card is not installed.', bank };
    const card = inspectSillyTavernCharacter(row.character);
    const expectedFingerprint = bank.cardBinding.fingerprint || bank.cardSync?.lastSyncedFingerprint || card.fingerprint;
    const fingerprintMismatch = !!expectedFingerprint && expectedFingerprint !== card.fingerprint;
    const fields = (bank.cardSync?.pendingEligibleFields || []).filter(field => CHARACTER_STATE_FIELDS[field]?.cardEligible === true);
    // Only fields that were previously synchronized by Nexus, plus newly approved
    // card-eligible fields, may enter the managed card block. Merely having a
    // value in Character Bank does not authorize Nexus to project it into the
    // external SillyTavern card.
    const managedFields = [...new Set([...(bank.cardSync?.managedEligibleFields || []), ...fields])]
        .filter(field => CHARACTER_STATE_FIELDS[field]?.cardEligible === true);
    const personalityFields = managedFields.filter(field => field === 'baseline.personality');
    const descriptionFields = managedFields.filter(field => field !== 'baseline.personality');
    const proposedPersonality = personalityFields.length ? withManagedBlock(card.personality, managedLines(bank, personalityFields)) : stripManagedBlock(card.personality);
    const proposedDescription = descriptionFields.length ? withManagedBlock(card.description, managedLines(bank, descriptionFields)) : stripManagedBlock(card.description);
    const changes = [];
    // A card write is only armed by an approved Bank + Card eligible proposal.
    // When armed, rebuild the complete Nexus-managed block so an incremental
    // write never erases previously-synced Character State fields.
    if (fields.length && proposedPersonality !== card.personality) changes.push({ field: 'personality', current: card.personality, proposed: proposedPersonality, stateFields: personalityFields });
    if (fields.length && proposedDescription !== card.description) changes.push({ field: 'description', current: card.description, proposed: proposedDescription, stateFields: descriptionFields });
    const inFlight = clean(bank.cardSync?.inFlightTransactionId);
    const recoveryRequired = bank.cardSync?.recoveryRequired === true;
    const requiresReconciliation = recoveryRequired || !!inFlight;
    const reconciliationReason = recoveryRequired
        ? (bank.cardSync?.recoveryReason || 'A previous Character Card write did not settle cleanly and requires operator reconciliation.')
        : (inFlight ? 'A previous Character Card sync did not reach a terminal Character Bank state. Reconcile the current card before another write.' : '');
    return {
        available: true,
        bank,
        card,
        expectedFingerprint,
        fingerprintMismatch,
        requiresReconciliation,
        reconciliationReason,
        fields,
        managedFields,
        changes,
        proposedCard: { personality: proposedPersonality, description: proposedDescription },
        canWrite: !fingerprintMismatch && !requiresReconciliation && fields.length > 0 && changes.length > 0,
        reason: requiresReconciliation ? reconciliationReason : (fingerprintMismatch ? 'The bound Character Card changed since the last Nexus scan. Refresh/reconcile the binding before write-back.' : (changes.length ? 'Card diff ready for explicit approval.' : 'No approved card-eligible Character State changes are waiting.')),
    };
}

export async function reconcileCharacterCardBinding(bankId) {
    const bank = getCharacterBank(bankId);
    if (!bank?.cardBinding?.avatar) throw new Error('Character Bank is not bound to a SillyTavern Character Card.');
    const row = listSillyTavernCharacters().find(candidate => candidate.avatar === bank.cardBinding.avatar);
    if (!row) throw new Error('Bound SillyTavern Character Card is not installed.');
    const card = inspectSillyTavernCharacter(row.character);
    const binding = buildCardBinding(card, now(), bank.cardBinding);
    return await updateCharacterBankDurably(bank.id, { cardBinding: binding, cardSync: { ...(bank.cardSync || {}), lastSyncedFingerprint: card.fingerprint, lastSyncedAt: now(), recoveryRequired: false, recoveryReason: '', recoveryTransactionId: '', recoveryAvatar: '', recoveryObservedFingerprint: '', inFlightTransactionId: '', inFlightExpectedFingerprint: '', inFlightAt: 0 } }, { label: `Reconcile Character Card binding · ${bank.character}` });
}

async function recordCardSyncRecovery(bankId, txId, result, error, rollbackError = null) {
    const current = getCharacterBank(bankId);
    const reason = rollbackError
        ? `Character Card write succeeded but Character Bank finalization failed, and automatic card rollback also failed: ${rollbackError?.message || rollbackError}`
        : `Character Card sync was rolled back after Character Bank finalization failed: ${error?.message || error}`;
    if (current) {
        try {
            const cardSync = {
                ...(current.cardSync || {}),
                recoveryRequired: !!rollbackError,
                recoveryReason: reason,
                recoveryTransactionId: rollbackError ? txId : '',
                recoveryAvatar: rollbackError ? String(result?.after?.avatar || result?.before?.avatar || '') : '',
                recoveryObservedFingerprint: rollbackError ? String(result?.after?.fingerprint || '') : '',
                inFlightTransactionId: rollbackError ? txId : '',
                inFlightExpectedFingerprint: rollbackError ? String(result?.before?.fingerprint || '') : '',
                inFlightAt: rollbackError ? now() : 0,
            };
            const binding = !rollbackError && result?.rollback?.after ? buildCardBinding(result.rollback.after, now(), current.cardBinding) : current.cardBinding;
            await updateCharacterBankDurably(bankId, { cardBinding: binding, cardSync }, { label: rollbackError ? `Character Card recovery required · ${current.character}` : `Character Card rollback settled · ${current.character}` });
        } catch (recoveryPersistenceError) {
            logEvent('character-state', 'card-sync-recovery-state-persist-failed', { bankId, transactionId: txId, error: recoveryPersistenceError, rollbackError }, 'error');
        }
    }
    return reason;
}

async function rollbackCharacterCardSync({ bankId, transactionId, result, error }) {
    let rollback = null;
    try {
        rollback = await writeSillyTavernCharacterCardPatch({
            avatarUrl: result.after.avatar,
            expectedFingerprint: result.after.fingerprint,
            patch: { personality: result.before.personality, description: result.before.description },
        });
        result.rollback = rollback;
    } catch (rollbackError) {
        const reason = await recordCardSyncRecovery(bankId, transactionId, result, error, rollbackError);
        logEvent('character-state', 'card-sync-rollback-failed', { bankId, transactionId, reason, error, rollbackError, beforeFingerprint: result.before?.fingerprint, observedFingerprint: result.after?.fingerprint }, 'error');
        const recoveryError = new Error(`${reason} Open Card Sync and reconcile the current SillyTavern card before any further write-back.`);
        recoveryError.name = 'TV2CharacterCardReconciliationRequired';
        recoveryError.transactionId = transactionId;
        recoveryError.avatar = result.after?.avatar || result.before?.avatar || '';
        recoveryError.observedFingerprint = result.after?.fingerprint || '';
        // Deliberately leave the review transaction in COMMITTING. The physical
        // result is unresolved and must not be misrepresented as a clean failure.
        throw recoveryError;
    }
    await recordCardSyncRecovery(bankId, transactionId, result, error, null);
    try { await transitionLedger(transactionId, shadow => shadow.fail(transactionId, error, { phase: 'character-bank-finalization', physicalCardRollback: 'verified' })); } catch {}
    logEvent('character-state', 'card-sync-rolled-back', { bankId, transactionId, beforeFingerprint: result.before?.fingerprint, rollbackFingerprint: rollback?.after?.fingerprint, error }, 'warn');
    throw error;
}

export async function commitCharacterCardSync(bankId, { expectedFingerprint = null } = {}) {
    let draft = buildCharacterCardSyncDraft(bankId);
    if (!draft.available) throw new Error(draft.reason);
    if (draft.requiresReconciliation) {
        const error = new Error(draft.reason);
        error.name = 'TV2CharacterCardReconciliationRequired';
        throw error;
    }
    if (draft.fingerprintMismatch) {
        const error = new Error(draft.reason);
        error.name = 'TV2CharacterCardFingerprintMismatch';
        throw error;
    }
    if (!draft.fields.length || !draft.changes.length) return { changed: false, draft, reason: draft.reason };
    const expected = clean(expectedFingerprint || draft.expectedFingerprint || draft.card.fingerprint);
    if (expected !== draft.card.fingerprint) throw new Error('The reviewed Character Card diff is stale. Refresh Card Sync before applying it.');
    const ledger = getNexusLedger();
    const assumptions = {
        chatId: String(getContext()?.chatId || ''),
        storyId: draft.bank.storyId,
        bankId: draft.bank.id,
        stateFingerprint: characterStateFingerprint(draft.bank.state),
        cardAvatar: draft.card.avatar,
        cardFingerprint: draft.card.fingerprint,
        fields: draft.fields,
    };
    let tx = ledger.begin({ type: 'character-card-sync', input: { bankId: draft.bank.id, avatar: draft.card.avatar }, assumptions, metadata: { domain: 'character-state', character: draft.bank.character } });
    ledger.executing(tx.id);
    ledger.parsed(tx.id, { changes: draft.changes });
    ledger.validated(tx.id, { passed: true, fingerprint: draft.card.fingerprint });
    tx = ledger.staged(tx.id, { changes: draft.changes, proposedCard: draft.proposedCard }, { mutationProposal: { type: 'character-card-sync', target: { avatar: draft.card.avatar }, draft: draft.proposedCard, assumptions, approvalRequired: true, metadata: { bankId: draft.bank.id, fields: draft.fields } } });
    await persistNexusReviewTransaction(tx.id);
    await transitionLedger(tx.id, shadow => shadow.approve(tx.id, { by: 'operator', metadata: { surface: 'character-card-sync' } }));

    // Re-read both Character Bank state and the ST card immediately before the
    // Ledger freshness check. Passing the original assumptions back to Ledger
    // would only prove that the draft equals itself, not that it is still fresh.
    draft = buildCharacterCardSyncDraft(bankId);
    const currentAssumptions = {
        chatId: String(getContext()?.chatId || ''),
        storyId: draft.bank?.storyId || '',
        bankId: draft.bank?.id || '',
        stateFingerprint: characterStateFingerprint(draft.bank?.state || {}),
        cardAvatar: draft.card?.avatar || '',
        cardFingerprint: draft.card?.fingerprint || '',
        fields: draft.fields || [],
    };
    const prepared = await transitionLedger(tx.id, shadow => shadow.prepareCommit(tx.id, { currentAssumptions }));
    if (prepared?.state === 'stale') {
        const error = new Error('The Character Card sync became stale before commit. Refresh Card Sync and review the current diff.');
        error.name = 'TV2CharacterCardSyncStale';
        throw error;
    }
    if (!draft.canWrite || draft.card.fingerprint !== expected) {
        const error = new Error(draft.reason || 'The Character Card sync is no longer writable from the reviewed state.');
        error.name = draft.fingerprintMismatch ? 'TV2CharacterCardFingerprintMismatch' : 'TV2CharacterCardSyncStale';
        try { await transitionLedger(tx.id, shadow => shadow.fail(tx.id, error, { phase: 'pre-write-revalidation' })); } catch {}
        throw error;
    }

    // Persist an owned in-flight marker before physical ST mutation. If the
    // browser disappears after the card write, the next Card Sync view sees an
    // unresolved Character Bank-owned reconciliation state instead of assuming
    // the previous baseline is still authoritative.
    const preflightBank = getCharacterBank(bankId);
    try {
        await updateCharacterBankDurably(bankId, {
            cardSync: {
                ...(preflightBank.cardSync || {}),
                inFlightTransactionId: tx.id,
                inFlightExpectedFingerprint: draft.card.fingerprint,
                inFlightAt: now(),
                recoveryRequired: false,
                recoveryReason: '',
                recoveryTransactionId: '',
                recoveryAvatar: '',
                recoveryObservedFingerprint: '',
            },
        }, { label: `Character Card sync intent · ${preflightBank.character}` });
    } catch (error) {
        try { await transitionLedger(tx.id, shadow => shadow.fail(tx.id, error, { phase: 'card-sync-intent-persistence' })); } catch {}
        throw error;
    }

    let result;
    try {
        result = await writeSillyTavernCharacterCardPatch({ avatarUrl: draft.card.avatar, expectedFingerprint: draft.card.fingerprint, patch: draft.proposedCard });
    } catch (error) {
        const current = getCharacterBank(bankId);
        try {
            await updateCharacterBankDurably(bankId, { cardSync: { ...(current.cardSync || {}), inFlightTransactionId: '', inFlightExpectedFingerprint: '', inFlightAt: 0 } }, { label: `Clear failed Character Card sync intent · ${current.character}` });
        } catch {}
        await transitionLedger(tx.id, shadow => shadow.fail(tx.id, error, { phase: 'sillytavern-card-write' }));
        throw error;
    }

    let currentBank = getCharacterBank(bankId);
    if (!currentBank || characterStateFingerprint(currentBank.state) !== assumptions.stateFingerprint) {
        const error = new Error('Character State changed while SillyTavern was writing the reviewed card. Nexus restored the previous card instead of finalizing a stale sync.');
        error.name = 'TV2CharacterCardSyncConcurrentStateChange';
        return await rollbackCharacterCardSync({ bankId, transactionId: tx.id, result, error });
    }

    const binding = buildCardBinding(result.after, now(), currentBank.cardBinding);
    const syncedFields = new Set(draft.fields);
    const latestHistoryIdByField = new Map();
    for (const row of currentBank.changeHistory || []) if (syncedFields.has(row.field) && row.cardWrite !== true) latestHistoryIdByField.set(row.field, row.id);
    const history = (currentBank.changeHistory || []).map(row => latestHistoryIdByField.get(row.field) === row.id ? { ...row, cardWrite: true, cardFingerprint: result.after.fingerprint } : row);
    let saved;
    try {
        saved = await updateCharacterBankDurably(bankId, {
            cardBinding: binding,
            changeHistory: history,
            cardSync: {
                ...(currentBank.cardSync || {}),
                lastSyncedFingerprint: result.after.fingerprint,
                lastSyncedAt: now(),
                lastDraftFingerprint: draft.card.fingerprint,
                pendingEligibleFields: (currentBank.cardSync?.pendingEligibleFields || []).filter(field => !syncedFields.has(field)),
                managedEligibleFields: [...new Set([...(currentBank.cardSync?.managedEligibleFields || []), ...draft.fields])],
                recoveryRequired: false,
                recoveryReason: '',
                recoveryTransactionId: '',
                recoveryAvatar: '',
                recoveryObservedFingerprint: '',
                inFlightTransactionId: '',
                inFlightExpectedFingerprint: '',
                inFlightAt: 0,
            },
        }, { label: `Character Card sync · ${currentBank.character}` });
    } catch (error) {
        return await rollbackCharacterCardSync({ bankId, transactionId: tx.id, result, error });
    }

    try {
        await transitionLedger(tx.id, shadow => shadow.completeCommit(tx.id, { avatar: result.after.avatar, fingerprint: result.after.fingerprint, fields: draft.fields, appliedAt: now() }));
    } catch (error) {
        // Card + Character Bank authority are already durably aligned. Retry the
        // durable review projection once, but never roll back a proven applied
        // mutation merely because its audit projection had a transient failure.
        try { await transitionLedger(tx.id, shadow => shadow.completeCommit(tx.id, { avatar: result.after.avatar, fingerprint: result.after.fingerprint, fields: draft.fields, appliedAt: now(), settlementRetry: true })); }
        catch (settlementError) {
            logEvent('character-state', 'card-sync-ledger-settlement-degraded', { bankId, transactionId: tx.id, error, settlementError }, 'error');
        }
    }
    logEvent('character-state', 'card-sync-complete', { bankId, character: saved.character, avatar: result.after.avatar, beforeFingerprint: result.before.fingerprint, afterFingerprint: result.after.fingerprint, fields: draft.fields, transactionId: tx.id }, 'info');
    return { changed: result.changed, bank: saved, before: result.before, after: result.after, fields: draft.fields, transactionId: tx.id, reason: 'Reviewed Character Card update applied and verified.' };
}
