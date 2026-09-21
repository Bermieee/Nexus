import { getSettings } from '../core/settings.js';
import { DECISION_MODE } from './constants.js';

export function getDecisionCoreRuntimeMode(){
    const config=getSettings()?.decisionCore||{};
    if(config.enabled!==true)return DECISION_MODE.OFF;
    const mode=String(config.mode||DECISION_MODE.OFF).toLowerCase();
    if(mode===DECISION_MODE.ASSIST)return DECISION_MODE.ASSIST;
    if(mode===DECISION_MODE.SHADOW)return DECISION_MODE.SHADOW;
    return DECISION_MODE.OFF;
}
export function decisionAssistEnabled(){return getDecisionCoreRuntimeMode()===DECISION_MODE.ASSIST;}
export function decisionShadowEnabled(){return getDecisionCoreRuntimeMode()===DECISION_MODE.SHADOW;}
export function decisionCoreEnabled(){return getDecisionCoreRuntimeMode()!==DECISION_MODE.OFF;}
