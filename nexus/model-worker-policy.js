const MAIN_PREFERRED_ROLES = new Set(['postTurn','maintenance','treeBuild']);
const MAIN_PREFERRED_STAGES = new Set(['postturn-memory','maintenance','tree-build']);
function clean(v){ return String(v ?? '').trim(); }

export function chooseNexusModelWorkerResource({
    mainConfigured=false, mainBusy=false, sidecarAvailable=false, preferMain=false,
    forcedSidecar=false, foregroundAdjacent=false,
}={}){
    if(forcedSidecar) return sidecarAvailable?'sidecar':'none';
    if(foregroundAdjacent && sidecarAvailable) return 'sidecar';
    if(preferMain && mainConfigured && !mainBusy) return 'main';
    if(sidecarAvailable) return 'sidecar';
    if(mainConfigured && !mainBusy) return 'main';
    return 'none';
}

export function isNexusMainPreferredWorker(stage, options={}){
    if(options.mainEligible===false) return false;
    if(options.mainPreferred===true) return true;
    const role=clean(options.role);
    return MAIN_PREFERRED_ROLES.has(role) || MAIN_PREFERRED_STAGES.has(clean(stage));
}
