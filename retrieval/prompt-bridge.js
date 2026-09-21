import { clearRetrievalLoreOutlet, publishRetrievalLoreOutlet } from '../nexus/generation-frame-ports.js';
import { NEXUS_GENERATION_OUTLET_STATUS } from '../nexus/generation-frame-contract.js';

let promptGenerationId = null;

/**
 * Retrieval owns selection/reuse semantics; Generation Frame owns physical Main
 * prompt authority.  This bridge can only publish/revoke Retrieval's typed
 * outlet and can never address SillyTavern's prompt API directly.
 */
export function clearRetrievalPrompt({ generationId = null, force = false } = {}) {
    if (!force && generationId != null && promptGenerationId != null && String(generationId) !== String(promptGenerationId)) return false;
    const target=generationId??promptGenerationId;
    if(target!=null)clearRetrievalLoreOutlet({generationId:target,status:NEXUS_GENERATION_OUTLET_STATUS.EMPTY,reason:'retrieval-cleared'});
    promptGenerationId = null;
    return true;
}

export function applyRetrievalPrompt(text, generationId = null, { refs = [], sourceRevision = null, data = null } = {}) {
    const content=String(text || '').trim();
    const result=content
        ? publishRetrievalLoreOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.READY,content,refs,sourceRevision,data})
        : clearRetrievalLoreOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.EMPTY,reason:'retrieval-empty'});
    if(result?.accepted!==false)promptGenerationId = generationId == null ? null : String(generationId);
    return result?.accepted!==false;
}

export function getRetrievalPromptGenerationId() { return promptGenerationId; }
