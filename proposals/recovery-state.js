// Compatibility facade. Durable mutation recovery is owned by Nexus, not Lore Proposals.
export {
    captureMutationRecoveryState,
    finalizeMutationRecoveryState,
    inspectMutationRecoveryState,
    applyMutationRecoveryPreStateUnsafe,
    buildRecoveryInverseOperation,
} from '../nexus/mutation-recovery.js';
