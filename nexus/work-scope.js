import { revisionFromMessages } from './message-settle-barrier.js';
import { currentNexusLoreSourceRevision } from './lore-source-revision.js';

let chatEpoch = 1;
let lastInvalidation = { at: 0, reason: 'initial' };
let foregroundGenerationId = null;

function chatIdOf(context) {
    const value = context?.chatId;
    return value == null ? null : String(value);
}

export function currentNexusChatEpoch() { return chatEpoch; }
export function currentNexusForegroundGenerationId() { return foregroundGenerationId; }
export function beginNexusForegroundGeneration(generationId) {
    foregroundGenerationId = generationId == null ? null : String(generationId);
    return foregroundGenerationId;
}
export function endNexusForegroundGeneration(generationId = null) {
    if (generationId == null) return false;
    if (foregroundGenerationId == null || String(generationId) !== String(foregroundGenerationId)) return false;
    foregroundGenerationId = null;
    return true;
}

export function invalidateNexusChatScope(reason = 'chat-invalidated') {
    chatEpoch += 1;
    lastInvalidation = { at: Date.now(), reason: String(reason || 'chat-invalidated') };
    return { epoch: chatEpoch, ...lastInvalidation };
}

export function captureNexusWorkScope(context, { revision = null, includeRevision = true, generationId = null, includeGeneration = false, kind = 'chat', includeSourceRevision = false, sourceBooks = [] } = {}) {
    if (kind === 'independent') return Object.freeze({ kind: 'independent', chatId: null, epoch: null, revision: null, generationId: null, sourceRevision: null, sourceBooks: [] });
    const chatId = chatIdOf(context);
    const resolvedRevision = includeRevision
        ? String(revision || revisionFromMessages(context?.chat || [], { chatId }, { includeAll: true }))
        : null;
    const resolvedGeneration = includeGeneration ? String(generationId ?? foregroundGenerationId ?? '') || null : null;
    const books=[...new Set((sourceBooks||[]).map(value=>String(value||'').trim()).filter(Boolean))].sort();
    const sourceRevision=includeSourceRevision?currentNexusLoreSourceRevision(books):null;
    return Object.freeze({ kind: 'chat', chatId, epoch: chatEpoch, revision: resolvedRevision, generationId: resolvedGeneration, sourceRevision, sourceBooks:books });
}

export function isNexusWorkScopeFresh(scope, context, { checkRevision = true } = {}) {
    if (!scope || typeof scope !== 'object') return false;
    if (scope.kind === 'independent') return true;
    if (Number(scope.epoch) !== chatEpoch) return false;
    if ((scope.chatId ?? null) !== chatIdOf(context)) return false;
    if (scope.generationId != null && String(scope.generationId) !== String(foregroundGenerationId ?? '')) return false;
    if (scope.sourceRevision && String(scope.sourceRevision) !== currentNexusLoreSourceRevision(scope.sourceBooks||[])) return false;
    if (checkRevision && scope.revision) {
        const currentRevision = revisionFromMessages(context?.chat || [], { chatId: chatIdOf(context) }, { includeAll: true });
        if (String(scope.revision) !== String(currentRevision)) return false;
    }
    return true;
}

export function assertNexusWorkScopeFresh(scope, context, options = {}) {
    if (isNexusWorkScopeFresh(scope, context, options)) return true;
    const error = new Error('Nexus work scope became stale before an authoritative state change.');
    error.name = 'TV2ScopeInvalidated';
    error.nexusScope = scope ? { ...scope } : null;
    error.currentScope = captureNexusWorkScope(context, { includeRevision: options.checkRevision !== false });
    throw error;
}

export function nexusScopeDedupKey(base, scope) {
    const prefix = String(base || 'nexus-work');
    if (!scope) return prefix;
    if (scope.kind === 'independent') return `${prefix}|scope:independent`;
    return `${prefix}|chat:${scope.chatId ?? 'none'}|epoch:${Number(scope.epoch) || 0}|rev:${scope.revision || 'none'}|source:${scope.sourceRevision||'none'}|generation:${scope.generationId ?? 'none'}`;
}

export function describeNexusWorkScope() {
    return { epoch: chatEpoch, lastInvalidation: { ...lastInvalidation } };
}
