import { mountWave12SillyTavernInterface } from './src/ui-core/wave12-sillytavern-host.js';
import { createNexusUiHostBindings } from './nexus-ui-bindings.js';
import { getSettings } from './core/settings.js';
import { getJobQueue } from './core/job-queue.js';
import { snapshotMainBridgeStatus } from './nexus/main-bridge-status.js';

let activeNexusUi=null;

/**
 * Nexus owns the product name and host lifecycle. Nexus UI.Core owns presentation.
 * Only clean read-only seams are exposed here. Nexus subsystem contracts are not
 * force-matched to Nexus. Unsupported owners remain unavailable until later
 * World Tree/runtime integration iterations.
 */
export function mountNexusUi({getContext,runtime=null}={}){
  if(activeNexusUi)return activeNexusUi;
  const hostBindings=createNexusUiHostBindings({
    readSettings:()=>getSettings(),
    readQueueHealth:()=>getJobQueue(getSettings().jobs).healthSnapshot(),
    readRuntimeDiagnostic:()=>runtime?.diagnosticSnapshot?.()??{},
    readMainBridge:()=>snapshotMainBridgeStatus(),
  });
  activeNexusUi=mountWave12SillyTavernInterface({
    getContext,
    hostBindings,
    productName:'Nexus',
    productTagline:'Cognitive Story System',
    rootId:'nexus-ui-core-host',
    floatingNavigation:true,
  });
  return activeNexusUi;
}

export function destroyNexusUi(){
  if(!activeNexusUi)return;
  try{activeNexusUi.destroy?.();}finally{activeNexusUi=null;}
}

export function nexusUiDiagnostics(){return activeNexusUi?.diagnostics?.()??null;}
