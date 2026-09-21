/**
 * Generation Frame typed publication ports.
 *
 * HARD INGRESS BOUNDARY: production subsystems publish only through these
 * outlet-specific functions.  The raw Generation Frame bus is private to this
 * ingress layer plus the physical Frame authority.  This keeps subsystem
 * ownership explicit and makes accidental cross-outlet publication visible to
 * static regression review.
 */
import { bindGenerationFramePort } from './generation-frame-bus.js';
import { NEXUS_GENERATION_OUTLET } from './generation-frame-contract.js';

const PORT = Object.freeze({
    storyScope: bindGenerationFramePort(NEXUS_GENERATION_OUTLET.STORY_SCOPE),
    summaryBank: bindGenerationFramePort(NEXUS_GENERATION_OUTLET.SUMMARY_BANK),
    ledger: bindGenerationFramePort(NEXUS_GENERATION_OUTLET.LEDGER),
    smartContext: bindGenerationFramePort(NEXUS_GENERATION_OUTLET.SMART_CONTEXT),
    characterBanks: bindGenerationFramePort(NEXUS_GENERATION_OUTLET.CHARACTER_BANKS),
    bootstrapLore: bindGenerationFramePort(NEXUS_GENERATION_OUTLET.BOOTSTRAP_LORE),
    retrievalLore: bindGenerationFramePort(NEXUS_GENERATION_OUTLET.RETRIEVAL_LORE),
    memoryRecall: bindGenerationFramePort(NEXUS_GENERATION_OUTLET.MEMORY_RECALL),
    notebook: bindGenerationFramePort(NEXUS_GENERATION_OUTLET.NOTEBOOK),
    scene: bindGenerationFramePort(NEXUS_GENERATION_OUTLET.SCENE),
    changeGate: bindGenerationFramePort(NEXUS_GENERATION_OUTLET.CHANGE_GATE),
});

export const publishStoryScopeOutlet = payload => PORT.storyScope.publish(payload);
export const publishSummaryBankOutlet = payload => PORT.summaryBank.publish(payload);
export const publishLedgerOutlet = payload => PORT.ledger.publish(payload);
export const publishSmartContextOutlet = payload => PORT.smartContext.publish(payload);
export const publishCharacterBanksOutlet = payload => PORT.characterBanks.publish(payload);
export const publishBootstrapLoreOutlet = payload => PORT.bootstrapLore.publish(payload);
export const publishRetrievalLoreOutlet = payload => PORT.retrievalLore.publish(payload);
export const publishMemoryRecallOutlet = payload => PORT.memoryRecall.publish(payload);
export const publishNotebookOutlet = payload => PORT.notebook.publish(payload);
export const publishSceneOutlet = payload => PORT.scene.publish(payload);
export const publishChangeGateOutlet = payload => PORT.changeGate.publish(payload);

export const clearBootstrapLoreOutlet = payload => PORT.bootstrapLore.clear(payload);
export const clearRetrievalLoreOutlet = payload => PORT.retrievalLore.clear(payload);
export const clearMemoryRecallOutlet = payload => PORT.memoryRecall.clear(payload);
export const clearNotebookOutlet = payload => PORT.notebook.clear(payload);
