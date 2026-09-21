import { lorebookOperatorReviewScope } from '../nexus/review-scope.js';

export function buildBuilderAssumptions({ book, lorebookInventory, treeInventory } = {}) {
    const scope=lorebookOperatorReviewScope(book);
    return {
        book: String(book || ''),
        chatId: scope.chatId,
        operatorReviewScope: scope.identity,
        lorebookFingerprint: lorebookInventory?.fingerprint || '',
        entries: Object.fromEntries((lorebookInventory?.entries || []).map(entry => [String(entry.uid), entry.fingerprint])),
        treeExists: treeInventory?.exists === true,
        treeVersion: treeInventory?.treeVersion ?? null,
        treeFingerprint: treeInventory?.treeFingerprint || '',
        representedUids: [...(treeInventory?.representedUids || [])],
    };
}
