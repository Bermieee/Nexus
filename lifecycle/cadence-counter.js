export const CADENCE_COUNTER_VERSION = 1;

function isAssistantTurn(message) {
    return message?.is_user === false && message?.is_system !== true;
}

export function countAssistantTurnsForCadence(messages = []) {
    let count = 0;
    for (const message of Array.isArray(messages) ? messages : []) if (isAssistantTurn(message)) count += 1;
    return count;
}

function normalizedCounter(counter = null) {
    if (!counter || typeof counter !== 'object') return null;
    const assistantTurns = Number(counter.assistantTurns);
    const messageCount = Number(counter.messageCount);
    const structureEpoch = Number(counter.structureEpoch);
    const counterRevision = Number(counter.counterRevision);
    if (!Number.isFinite(assistantTurns) || assistantTurns < 0) return null;
    if (!Number.isFinite(messageCount) || messageCount < 0) return null;
    return {
        assistantTurns: Math.floor(assistantTurns),
        messageCount: Math.floor(messageCount),
        structureEpoch: Number.isFinite(structureEpoch) ? structureEpoch : 0,
        counterRevision: Number.isFinite(counterRevision) && counterRevision >= 0 ? Math.floor(counterRevision) : 0,
    };
}

export function updateAssistantTurnCounter(counter, messages = [], { epoch = 0, forceRebase = false, reason = null } = {}) {
    const chat = Array.isArray(messages) ? messages : [];
    const currentEpoch = Number.isFinite(Number(epoch)) ? Number(epoch) : 0;
    const prior = normalizedCounter(counter);
    const mustRebase = forceRebase || !prior || prior.messageCount > chat.length || prior.structureEpoch !== currentEpoch;
    if (mustRebase) {
        const assistantTurns = countAssistantTurnsForCadence(chat);
        return {
            counter: {
                assistantTurns,
                messageCount: chat.length,
                structureEpoch: currentEpoch,
                counterRevision: (prior?.counterRevision || 0) + 1,
            },
            inspectedMessages: chat.length,
            rebased: true,
            reason: reason || (!prior ? 'counter-uninitialized' : prior.messageCount > chat.length ? 'chat-shortened' : prior.structureEpoch !== currentEpoch ? 'structure-epoch-changed' : 'forced-rebase'),
        };
    }

    let assistantTurns = prior.assistantTurns;
    for (let index = prior.messageCount; index < chat.length; index += 1) if (isAssistantTurn(chat[index])) assistantTurns += 1;
    const inspectedMessages = Math.max(0, chat.length - prior.messageCount);
    return {
        counter: {
            assistantTurns,
            messageCount: chat.length,
            structureEpoch: currentEpoch,
            counterRevision: prior.counterRevision + (inspectedMessages ? 1 : 0),
        },
        inspectedMessages,
        rebased: false,
        reason: inspectedMessages ? 'append-delta' : 'counter-hit',
    };
}
