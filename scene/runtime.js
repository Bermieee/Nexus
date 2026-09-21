import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { scanScene, reuseSceneObservation, getSceneScannerSnapshot } from './scanner.js';
import { applySceneChangeAssist, evaluateSceneChange, getCurrentSceneChangeGate } from '../retrieval/change-gate.js';
import { evaluateSceneScanPreflightAssist, currentScenePreflightEvidence, scenePreflightFingerprint } from './decision-site.js';

/**
 * Scene runtime is orchestration only. Scene Scanner owns observation and its
 * temporary scene snapshot; Change Gate owns delta classification. Consumers
 * call this helper to ensure both authorities are current for one chat revision
 * without acquiring semantic ownership themselves.
 */
export async function ensureSceneAuthority({
    context = getContext(),
    messages = null,
    source = 'scene-runtime',
    scope = null,
    enqueueSidecar = null,
    force = false,
} = {}) {
    const chatId=context?.chatId??context?.chat_id??null;
    const prior=getSceneScannerSnapshot({chatId});
    let preflight=null;
    if(!force&&prior?.acceptedScene&&getSettings()?.decisionCore?.enabled===true&&getSettings()?.retrieval?.changeGateEnabled!==false){
        const recentEvidence=currentScenePreflightEvidence();
        const sourceFingerprint=scenePreflightFingerprint({chatId,previousScene:prior.acceptedScene,recentEvidence});
        try{
            preflight=await evaluateSceneScanPreflightAssist({chatId,previousScene:prior.acceptedScene,recentEvidence,sourceFingerprint,readCurrentEvidence:()=>currentScenePreflightEvidence()});
        }catch{}
    }
    const scanRequired=preflight?.ok&&!preflight?.stale?Number(preflight.answers?.scan_required?.value)>=0.5:true;
    let sceneScan=null;
    if(preflight?.ok&&!preflight?.stale&&!scanRequired&&String(preflight.answers?.change_hint?.value||'')==='NO_CHANGE'){
        sceneScan=reuseSceneObservation({context,messages,source:'decision-preflight-reuse',reason:'Decision Core preflight classified stable scene; Scene Scanner worker skipped.'});
    }
    if(!sceneScan)sceneScan=await scanScene({ context, messages, source, scope, enqueueSidecar, force });
    let gate = evaluateSceneChange({
        sceneScan,
        disabled: getSettings()?.retrieval?.changeGateEnabled === false,
        source,
    });
    if(preflight?.ok&&!preflight?.stale&&prior?.acceptedScene&&getSettings()?.retrieval?.changeGateEnabled!==false){
        const classification=String(preflight.answers?.change_hint?.value||'');
        if(classification)gate=applySceneChangeAssist(gate,{mode:classification,provider:preflight.provider,latencyMs:preflight.latencyMs,sourceFingerprint:preflight.sourceFingerprint||null});
    }
    return { sceneScan, gate, preflight };
}

export function getSceneAuthority({ chatId = null } = {}) {
    const resolvedChatId = chatId ?? getContext()?.chatId ?? getContext()?.chat_id ?? null;
    return {
        sceneScan: getSceneScannerSnapshot({ chatId: resolvedChatId }),
        gate: getCurrentSceneChangeGate({ chatId: resolvedChatId }),
    };
}
