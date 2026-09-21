import { loadBook } from '../lore/store.js';
import { assertReadableBook, assertWritableBook } from '../lore/policy.js';
import { getTree } from '../tree/store.js';
import { logEvent } from '../observability/telemetry.js';
import { getNexusRuntime } from '../nexus/runtime.js';
import { LorebookBuilderController } from './controller.js';
import { SidecarLorebookBuilderExecutor } from './sidecar-executor.js';
import { MainLorebookBuilderExecutor } from './main-executor.js';
import { LorebookBuilderSemanticRouter } from './semantic-router.js';
import { getLorebookBuilderPlanningConfig } from './planning-config-runtime.js';
import { commitCanonicalNexusMutation } from '../nexus/mutation-coordinator.js';
import { persistNexusReviewTransaction, cancelNexusReviewTransactionDurably, staleNexusReviewTransactionDurably, supersedeNexusReviewTransactionDurably } from '../nexus/transaction-service.js';
import { NexusBuilder2Controller } from '../builder2/nexus-controller.js';
import { NexusBuilder2SemanticAdapter, resolveNexusBuilder2SemanticResource } from '../builder2/nexus-semantic.js';

let sharedController = null;

/**
 * Preserved v1 implementation for regression/rollback compatibility only.
 * Product runtime selection defaults to Builder 2 below.
 */
export function createLegacyLorebookBuilderController({ runtimeProvider = getNexusRuntime } = {}) {
    const runtime = runtimeProvider();
    if (!runtime?.director || !runtime?.ledger) throw new Error('Nexus coordination runtime is unavailable for Lorebook Builder.');
    const sidecarExecutor = new SidecarLorebookBuilderExecutor();
    const mainExecutor = new MainLorebookBuilderExecutor({ runtimeProvider });
    const semanticExecutor = new LorebookBuilderSemanticRouter({ runtimeProvider, sidecarExecutor, mainExecutor });
    return new LorebookBuilderController({
        loadBook,
        getTree,
        commitMutation: (transactionId, mutation, options = {}) => commitCanonicalNexusMutation(transactionId, mutation, { ...options, targetLedger: runtime.ledger }),
        assertReadableBook,
        assertWritableBook,
        director: runtime.director,
        ledger: runtime.ledger,
        semanticExecutor,
        planningConfigProvider: getLorebookBuilderPlanningConfig,
        persistReviewTransaction: (id) => persistNexusReviewTransaction(id, { targetLedger: runtime.ledger }),
        cancelReviewTransactionDurably: cancelNexusReviewTransactionDurably,
        supersedeReviewTransactionDurably: supersedeNexusReviewTransactionDurably,
        logEvent,
    });
}

/** Product Builder. Builder 2 owns semantics; Nexus keeps execution/Ledger/Tree authority. */
export function createLorebookBuilderController({ runtimeProvider = getNexusRuntime, engine = 'builder2' } = {}) {
    if (String(engine || 'builder2').toLowerCase() === 'legacy') return createLegacyLorebookBuilderController({ runtimeProvider });
    const runtime = runtimeProvider();
    if (!runtime?.director || !runtime?.coordinator || !runtime?.ledger) throw new Error('Nexus coordination runtime is unavailable for Lorebook Builder 2.');
    return new NexusBuilder2Controller({
        loadBook,
        getTree,
        assertReadableBook,
        assertWritableBook,
        runtime,
        commitMutation: (transactionId, mutation, options = {}) => commitCanonicalNexusMutation(transactionId, mutation, { ...options, targetLedger: runtime.ledger }),
        persistReviewTransaction: (id) => persistNexusReviewTransaction(id, { targetLedger: runtime.ledger }),
        cancelReviewTransactionDurably: cancelNexusReviewTransactionDurably,
        staleReviewTransactionDurably: staleNexusReviewTransactionDurably,
        semanticFactory: options => new NexusBuilder2SemanticAdapter(options),
        resolveSemanticResource: resolveNexusBuilder2SemanticResource,
        planningConfigProvider: getLorebookBuilderPlanningConfig,
        logEvent,
    });
}

export function getLorebookBuilderController() {
    if (!sharedController) sharedController = createLorebookBuilderController();
    return sharedController;
}

export function resetLorebookBuilderController() { sharedController = null; }
