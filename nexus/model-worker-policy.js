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
    if(options.mainPreferred===false) return false;
    const role=clean(options.role);
    return MAIN_PREFERRED_ROLES.has(role) || MAIN_PREFERRED_STAGES.has(clean(stage));
}


export function resolveNexusModelWorkerPoolPlan({
    unitCount=0, modelWorkerCount=1, sidecarCount=0,
    explicitMain=false, explicitSidecar=false, mainEligible=true,
}={}){
    const units=Math.max(0,Math.floor(Number(unitCount)||0));
    const sidecars=Math.max(0,Math.min(2,Math.floor(Number(sidecarCount)||0)));
    const workers=Math.max(1,Math.min(3,Math.floor(Number(modelWorkerCount)||1)));
    let width=1;
    if(explicitMain)width=1;
    else if(explicitSidecar)width=Math.max(1,sidecars||1);
    else width=workers;
    width=Math.max(1,Math.min(width,Math.max(1,units||1)));
    const hybridMainLane=!explicitMain&&!explicitSidecar&&mainEligible!==false&&sidecars>0&&workers>sidecars;
    return Object.freeze({width,hybridMainLane,sidecarCount:sidecars,modelWorkerCount:workers});
}

export function resolveNexusModelWorkerLanePreference(workerIndex,{hybridMainLane=false,explicitMainPreferred=undefined}={}){
    if(explicitMainPreferred===true||explicitMainPreferred===false)return explicitMainPreferred;
    if(!hybridMainLane)return undefined;
    return Number(workerIndex)===0;
}
