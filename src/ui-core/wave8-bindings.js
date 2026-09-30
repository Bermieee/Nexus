import { deepFreeze } from './wave6-contracts.js';
import { createWave7ProductionBindings } from './wave7-bindings.js';

const optional=(value,name)=>{if(value==null)return null;if(typeof value!=='function')throw new TypeError(`${name} must be a function when provided`);return value;};

export function createWave8ProductionBindings(input={}){
  const wave7=createWave7ProductionBindings(input);
  return deepFreeze({
    ...wave7,
    cognition:{
      readHotCognitionReadModel:optional(input.readHotCognitionReadModel,'readHotCognitionReadModel'),
      readCognitiveChoiceReceipt:optional(input.readCognitiveChoiceReceipt,'readCognitiveChoiceReceipt'),
      readScatterReceipt:optional(input.readScatterReceipt,'readScatterReceipt'),
      readSensoryTrace:optional(input.readSensoryTrace,'readSensoryTrace'),
      readCandidateBusEnvelope:optional(input.readCandidateBusEnvelope,'readCandidateBusEnvelope'),
      readCandidateFusionReceipt:optional(input.readCandidateFusionReceipt,'readCandidateFusionReceipt'),
      readTruthAssessment:optional(input.readTruthAssessment,'readTruthAssessment'),
      readCorrectiveRetrievalReceipt:optional(input.readCorrectiveRetrievalReceipt,'readCorrectiveRetrievalReceipt'),
      readJevDecisionReceipt:optional(input.readJevDecisionReceipt,'readJevDecisionReceipt'),
      readPrecisionReceipt:optional(input.readPrecisionReceipt,'readPrecisionReceipt'),
      readGatherReceipt:optional(input.readGatherReceipt,'readGatherReceipt'),
      readContextSealReceipt:optional(input.readContextSealReceipt??input.readContextSealReceipt,'readContextSealReceipt'),
      readLoreStatus:optional(input.readLoreStatus,'readLoreStatus'),
      subscribe:optional(input.subscribeCognition,'subscribeCognition'),
    },
  });
}

export function describeWave8BindingAvailability(bindings={}){
  const c=bindings.cognition??{},p=bindings.promptPlan??{},f=bindings.forensics??{};
  return deepFreeze({
    hotCognition:Boolean(c.readHotCognitionReadModel),choice:Boolean(c.readCognitiveChoiceReceipt),scatter:Boolean(c.readScatterReceipt),
    sensory:Boolean(c.readSensoryTrace||c.readCandidateBusEnvelope||c.readCandidateFusionReceipt),truth:Boolean(c.readTruthAssessment),
    corrective:Boolean(c.readCorrectiveRetrievalReceipt),jev:Boolean(c.readJevDecisionReceipt),precision:Boolean(c.readPrecisionReceipt),
    gather:Boolean(c.readGatherReceipt),contextSeal:Boolean(c.readContextSealReceipt||p.readSealReceipt),promptPlan:Boolean(p.readPromptPlanReadModel),
    forensics:Boolean(f.readForensicReadModel||f.listForensicReadModels),scene:Boolean(bindings.scene?.readModel),lore:Boolean(c.readLoreStatus),
    liveSubscription:Boolean(c.subscribe),
  });
}
