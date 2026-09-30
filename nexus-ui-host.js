import { mountWave12SillyTavernInterface } from './src/ui-core/wave12-sillytavern-host.js';

let activeNexusUi=null;

/**
 * Nexus owns the product name and host lifecycle. Area 52 UI.Core owns presentation.
 * Subsystem bindings are intentionally empty during the first transplant pass: the
 * Area 52 and Nexus subsystem contracts are not being force-matched. Missing owners
 * render as unavailable until later World Tree/runtime integration iterations.
 */
export function mountNexusUi({getContext}={}){
  if(activeNexusUi)return activeNexusUi;
  activeNexusUi=mountWave12SillyTavernInterface({
    getContext,
    hostBindings:{},
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
