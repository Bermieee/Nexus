import { subscribeWorldTreeUi } from './core/world-tree-events.js';
import { mountWave12SillyTavernInterface } from './src/ui-core/wave12-sillytavern-host.js';
import {
  createNexusUiHostBindings,
  projectNexusSensoryTrace,
  projectNexusTruthAssessment,
  projectNexusScatterReceipt,
  projectNexusGatherReceipt,
} from './nexus-ui-bindings.js';
import { getSettings } from './core/settings.js';
import { getJobQueue } from './core/job-queue.js';
import { snapshotMainBridgeStatus } from './nexus/main-bridge-status.js';
import { getTelemetrySnapshot } from './observability/telemetry.js';
import { projectNexusDiagnosticTelemetryFromObservability } from './nexus/diagnostics-source.js';
import { getDecisionTelemetrySnapshot } from './decision/telemetry.js';
import { getRetrievalDiagnosticsSnapshot } from './retrieval/diagnostics.js';
import { getGenerationFrameDiagnostics } from './nexus/generation-frame.js';
import { currentNexusHotSnapshot } from './nexus/hot-cognition.js';
import { nexusForegroundScatterGatherDiagnostics } from './nexus/scatter-gather-runtime.js';
import { readNexusWorldTreeUiModel, readNexusWorldTree } from './world-tree/index.js';
import { legacyWorldTreeBridgeStatus } from './world-tree/legacy-world-bridge.js';
import { legacyLoreWorldTreeBridgeStatus } from './world-tree/legacy-lore-bridge.js';
import { getSceneScannerSnapshot } from './scene/scanner.js';
import { getNexusSceneIntelligenceView } from './nexus/scene-intelligence.js';
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
 * Only clean read-only seams are exposed here. Ported cognition systems are
 * projected into the finished UI through bounded read models; telemetry and
 * probes remain centralized in Diagnostics.
 */
export function mountNexusUi({getContext,runtime=null}={}){
  if(activeNexusUi)return activeNexusUi;
  const hostBindings=createNexusUiHostBindings({
    readSettings:()=>getSettings(),
    readQueueHealth:()=>getJobQueue(getSettings().jobs).healthSnapshot(),
    readRuntimeDiagnostic:()=>runtime?.diagnosticSnapshot?.()??{},
    readMainBridge:()=>snapshotMainBridgeStatus(),
    readSceneSnapshot:(selection={})=>{
      const chatId=selection?.chatId??getContext?.()?.chatId??null;
      return getNexusSceneIntelligenceView({chatId})??getSceneScannerSnapshot({chatId});
    },
    readCharacterCards:()=>readCharacterCardMetadata(),
    readTelemetry:()=>getTelemetrySnapshot(),
    readSystemDiagnostics:()=>projectNexusDiagnosticTelemetryFromObservability(getTelemetrySnapshot()),
    readHotCognition:(selection={})=>{
      const snapshot=currentNexusHotSnapshot({context:getContext?.()});
      if(!snapshot)return null;
      if(selection?.chatId!=null&&snapshot?.chatNamespace!=null&&String(selection.chatId)!==String(snapshot.chatNamespace))return null;
      return snapshot;
    },
    readScatter:(selection={})=>{
      const diagnostics=nexusForegroundScatterGatherDiagnostics();
      if(!diagnostics)return null;
      if(selection?.chatId!=null&&diagnostics.chatId!=null&&String(selection.chatId)!==String(diagnostics.chatId))return null;
      if(selection?.generationId!=null&&diagnostics.generationId!=null&&String(selection.generationId)!==String(diagnostics.generationId))return null;
      return projectNexusScatterReceipt(diagnostics);
    },
    readGather:(selection={})=>{
      const diagnostics=nexusForegroundScatterGatherDiagnostics();
      if(!diagnostics)return null;
      if(selection?.chatId!=null&&diagnostics.chatId!=null&&String(selection.chatId)!==String(diagnostics.chatId))return null;
      if(selection?.generationId!=null&&diagnostics.generationId!=null&&String(selection.generationId)!==String(diagnostics.generationId))return null;
      return projectNexusGatherReceipt(diagnostics);
    },
    readSensoryTrace:(selection={})=>projectNexusSensoryTrace(getTelemetrySnapshot(),selection),
    readTruthAssessment:(selection={})=>projectNexusTruthAssessment(getTelemetrySnapshot(),selection),
    readDecisionTelemetry:()=>getDecisionTelemetrySnapshot(),
    readRetrievalDiagnostics:(selection={})=>getRetrievalDiagnosticsSnapshot({chatId:selection?.chatId??null}),
    readGenerationFrameDiagnostics:()=>getGenerationFrameDiagnostics(),
    subscribeWorldTree:listener=>subscribeWorldTreeUi(listener,{getChatId:()=>getContext?.()?.chatId??null}),
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
