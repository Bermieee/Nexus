import { mountWave12SillyTavernInterface } from './src/ui-core/wave12-sillytavern-host.js';
import { createNexusUiHostBindings } from './nexus-ui-bindings.js';
import { getSettings } from './core/settings.js';
import { getJobQueue } from './core/job-queue.js';
import { snapshotMainBridgeStatus } from './nexus/main-bridge-status.js';
import { getTelemetrySnapshot } from './observability/telemetry.js';
import { getDecisionTelemetrySnapshot } from './decision/telemetry.js';
import { getRetrievalDiagnosticsSnapshot } from './retrieval/diagnostics.js';
import { getGenerationFrameDiagnostics } from './nexus/generation-frame.js';
import { readNexusWorldTreeUiModel, readNexusWorldTree } from './world-tree/index.js';
import { legacyWorldTreeBridgeStatus } from './world-tree/legacy-world-bridge.js';
import { legacyLoreWorldTreeBridgeStatus } from './world-tree/legacy-lore-bridge.js';
import { getSceneScannerSnapshot } from './scene/scanner.js';
import { listSillyTavernCharacters, getCurrentSillyTavernCharacter, inspectSillyTavernCharacter } from './character-cards/io.js';

let activeNexusUi=null;

function readCharacterCardMetadata(){
  const rows=listSillyTavernCharacters().map(row=>{
    let card=null;
    try{card=inspectSillyTavernCharacter(row.character);}catch{}
    return{
      index:row.index,
      avatar:row.avatar??card?.avatar??null,
      name:row.name??card?.name??null,
      tags:Array.isArray(card?.tags)?card.tags:[],
      characterVersion:card?.characterVersion??null,
      fingerprint:card?.fingerprint??null,
    };
  });
  let currentIndex=null;
  try{currentIndex=getCurrentSillyTavernCharacter().index;}catch{}
  return{rows,currentIndex};
}

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
    readSceneSnapshot:(selection={})=>getSceneScannerSnapshot({chatId:selection?.chatId??null}),
    readCharacterCards:()=>readCharacterCardMetadata(),
    readTelemetry:()=>getTelemetrySnapshot(),
    readDecisionTelemetry:()=>getDecisionTelemetrySnapshot(),
    readRetrievalDiagnostics:(selection={})=>getRetrievalDiagnosticsSnapshot({chatId:selection?.chatId??null}),
    readGenerationFrameDiagnostics:()=>getGenerationFrameDiagnostics(),
    readWorldTree:()=>readNexusWorldTreeUiModel({chatId:getContext?.()?.chatId??null}),
    readWorldTreeDiagnostics:()=>{
      const chatId=getContext?.()?.chatId??null;
      const snapshot=readNexusWorldTree({chatId,includeOverlays:true,limit:5000});
      return{
        kind:'NexusWorldTreeDiagnostics',
        chatId:chatId==null?null:String(chatId),
        worldRevision:snapshot.worldRevision,
        overlayRevision:snapshot.overlayRevision,
        counts:snapshot.counts,
        legacyWorldBridge:legacyWorldTreeBridgeStatus(),
        legacyLoreBridge:legacyLoreWorldTreeBridgeStatus(),
      };
    },
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
