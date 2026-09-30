import { ProductDataMode, Wave6Health, clone, createProductSourceStatus, deepFreeze } from './wave6-contracts.js';
import { normalizeContextSealReceipt } from './wave7-explainability.js';
import {
  buildLiveCognitionPath, normalizeCognitiveChoiceReceipt, normalizeCorrectiveRetrievalReceipt, normalizeGatherFromChoiceReceipt, normalizeGatherReceipt,
  normalizeJevDecisionReceipt, normalizeLoreStatus, normalizePrecisionReceipt, normalizeScatterReceipt, normalizeSealFromChoiceReceipt,
  normalizeSensoryFromChoiceReceipt, normalizeSensoryReceipt, normalizeTruthFromChoiceReceipt, normalizeTruthAssessment,
} from './wave8-cognition.js';

const optional=(fn)=>typeof fn==='function'?fn:null;

export class Wave8CognitionProductionAdapter{
  constructor({
    scene=null,promptPlan=null,readHotCognitionReadModel=null,readCognitiveChoiceReceipt=null,readScatterReceipt=null,
    readSensoryTrace=null,readCandidateBusEnvelope=null,readCandidateFusionReceipt=null,readTruthAssessment=null,
    readCorrectiveRetrievalReceipt=null,readJevDecisionReceipt=null,readPrecisionReceipt=null,readGatherReceipt=null,
    readContextSealReceipt=null,readLoreStatus=null,subscribe=null,fixture=null,strictReceiptCoherence=false,selectionProvider=null,
  }={}){
    this.scene=scene;this.promptPlan=promptPlan;this.readHotCognitionReadModel=optional(readHotCognitionReadModel);
    this.readCognitiveChoiceReceipt=optional(readCognitiveChoiceReceipt);this.readScatterReceipt=optional(readScatterReceipt);
    this.readSensoryTrace=optional(readSensoryTrace);this.readCandidateBusEnvelope=optional(readCandidateBusEnvelope);this.readCandidateFusionReceipt=optional(readCandidateFusionReceipt);
    this.readTruthAssessment=optional(readTruthAssessment);this.readCorrectiveRetrievalReceipt=optional(readCorrectiveRetrievalReceipt);
    this.readJevDecisionReceipt=optional(readJevDecisionReceipt);this.readPrecisionReceipt=optional(readPrecisionReceipt);this.readGatherReceipt=optional(readGatherReceipt);
    this.readContextSealReceipt=optional(readContextSealReceipt);this.readLoreStatus=optional(readLoreStatus);this.subscribeFn=optional(subscribe);
    this.fixture=fixture;this.strictReceiptCoherence=Boolean(strictReceiptCoherence);this.selectionProvider=optional(selectionProvider);this.kind='Wave8CognitionProductionAdapter';
  }

  read(selection={}){
    if(this.fixture)return this.#readFixture(selection);
    const errors={};
    const rawChoice=this.#safe('choice',this.readCognitiveChoiceReceipt,selection,errors);
    const choice=normalizeCognitiveChoiceReceipt(rawChoice);
    const rawScatter=this.#safe('scatter',this.readScatterReceipt,selection,errors);
    const scatter=normalizeScatterReceipt(rawScatter,choice);

    const sensoryInput=this.#sensoryInput(selection,errors);
    const choiceSensory=normalizeSensoryFromChoiceReceipt(choice);
    const sensory=normalizeSensoryReceipt(sensoryInput)??(this.strictReceiptCoherence&&choiceSensory?.state!=='SKIPPED'?null:choiceSensory);
    const rawTruth=this.#safe('truth',this.readTruthAssessment,selection,errors);
    const truth=normalizeTruthAssessment(rawTruth)??(this.strictReceiptCoherence?null:normalizeTruthFromChoiceReceipt(choice));
    const rawCorrection=this.#safe('corrective',this.readCorrectiveRetrievalReceipt,selection,errors);
    const corrective=normalizeCorrectiveRetrievalReceipt(rawCorrection??(this.strictReceiptCoherence?null:choice?.correctiveRetrieval),truth);
    const rawJev=this.#safe('jev',this.readJevDecisionReceipt,selection,errors);
    const jev=normalizeJevDecisionReceipt(rawJev,this.strictReceiptCoherence?strictJevChoice(choice):choice);
    const rawPrecision=this.#safe('precision',this.readPrecisionReceipt,selection,errors);
    const precision=normalizePrecisionReceipt(rawPrecision,this.strictReceiptCoherence?strictPrecisionChoice(choice):choice);
    const rawGather=this.#safe('gather',this.readGatherReceipt,selection,errors);
    const gather=normalizeGatherReceipt(rawGather)??(this.strictReceiptCoherence?null:normalizeGatherFromChoiceReceipt(choice));
    const rawSeal=this.#safe('seal',this.readContextSealReceipt,selection,errors);
    const sceneResult=this.scene?.read?.(selection)??null;
    const scene=sceneResult?.data??null;
    const promptResult=this.promptPlan?.read?.(selection)??null;
    const promptPlan=promptResult?.data??null;
    let seal=normalizeContextSealReceipt(rawSeal??promptPlan?.seal??null,{lateResultRefs:gather?.results?.filter(x=>x.status==='LATE').map(x=>x.resultId).filter(Boolean)??[]})??(this.strictReceiptCoherence?null:normalizeSealFromChoiceReceipt(choice));
    if(this.strictReceiptCoherence&&seal&&gather){
      const blocked=new Set(gather.results.filter(x=>['LATE','STALE','INVALID','REJECTED'].includes(x.status)).map(x=>x.resultId).filter(Boolean));
      const conflicts=seal.admittedResultIds.filter(id=>blocked.has(id));
      if(conflicts.length){
        errors.seal={code:'LIVE_RECEIPT_SEAL_CONFLICT',message:'Context Seal admitted result(s) that Gather marked late/stale/invalid/rejected: '+conflicts.join(', ')};
        seal=deepFreeze({...seal,coherenceConflictIds:conflicts,effectiveAdmittedResultIds:seal.admittedResultIds.filter(id=>!blocked.has(id))});
      }
    }
    const hotCognition=clone(this.#safe('hotCognition',this.readHotCognitionReadModel,selection,errors));
    const lore=normalizeLoreStatus(this.#safe('lore',this.readLoreStatus,selection,errors));

    const sensoryEvidence=sensoryInput??(sensory?.sourceReceipt==='CognitiveChoiceReceipt'?rawChoice:null),truthEvidence=rawTruth??(truth?.sourceReceipt==='CognitiveChoiceReceipt'?rawChoice:null);
    const jevEvidence=rawJev??(jev&&choice?.jevDecision?rawChoice:null),precisionEvidence=rawPrecision??(precision?.sourceReceipt==='CognitiveChoiceReceipt'?rawChoice:null);
    const gatherEvidence=rawGather??(gather?.sourceReceipt==='CognitiveChoiceReceipt'?rawChoice:null),sealEvidence=rawSeal??promptPlan?.seal??(seal?.sourceReceipt==='CognitiveChoiceReceipt'?rawChoice:null);
    const correctiveEvidence=rawCorrection??(choice?.correctiveRetrieval?rawChoice:null);
    const modes={
      scene:sceneResult?.source?.mode??ProductDataMode.UNAVAILABLE,
      choice:modeFor(rawChoice,errors.choice),scatter:modeFor(rawScatter,errors.scatter),sensory:modeFor(sensoryEvidence,errors.sensory),
      truth:modeFor(truthEvidence,errors.truth),jev:modeFor(jevEvidence,errors.jev),precision:modeFor(precisionEvidence,errors.precision),
      gather:modeFor(gatherEvidence,errors.gather),seal:modeFor(sealEvidence,errors.seal),promptPlan:promptResult?.source?.mode??ProductDataMode.UNAVAILABLE,
      hotCognition:modeFor(hotCognition,errors.hotCognition),lore:modeFor(lore,errors.lore),
    };
    const basePath=buildLiveCognitionPath({scene,hotCognition,choice,scatter,sensory,truth,corrective,jev,precision,gather,seal,promptPlan,lore,modes});
    const path=deepFreeze({...basePath,bindingSelection:clone(this.selectionProvider?.()??selection??{})});
    const sources=sourceMap({sceneResult,rawChoice,rawScatter,sensoryInput:sensoryEvidence,rawTruth:truthEvidence,rawCorrection:correctiveEvidence,rawJev:jevEvidence,rawPrecision:precisionEvidence,rawGather:gatherEvidence,rawSeal:sealEvidence,promptResult,hotCognition,lore,errors,modes});
    const failed=Object.keys(errors).length;
    return deepFreeze({
      source:createProductSourceStatus({mode:failed?ProductDataMode.DEGRADED:path.source.mode,health:failed?Wave6Health.DEGRADED:path.source.health,label:'Live Brain Cognition',impact:failed?`${failed} cognitive producer read${failed===1?'':'s'} failed; remaining receipts are still shown truthfully.`:path.source.impact,producer:'Wave8CognitionProductionAdapter'}),
      data:path,sources,errors:clone(errors),
    });
  }

  subscribe(listener){return this.subscribeFn?this.subscribeFn(listener):()=>{};}
  destroy(){}

  #safe(name,fn,selection,errors){
    if(!fn)return null;
    try{return fn(selection??{});}
    catch(error){errors[name]=safeCognitionReadError(error,name,selection);return null;}
  }

  #sensoryInput(selection,errors){
    const explicit=this.#safe('sensory',this.readSensoryTrace,selection,errors);
    if(explicit)return explicit;
    const envelope=this.#safe('candidateBus',this.readCandidateBusEnvelope,selection,errors);
    const fusion=this.#safe('candidateFusion',this.readCandidateFusionReceipt,selection,errors);
    if(!envelope&&!fusion)return null;
    return {envelope,fusionReceipt:fusion??envelope?.fusionReceipt??null};
  }

  #readFixture(selection){
    const f=typeof this.fixture==='function'?this.fixture(selection):this.fixture??{};
    const choice=normalizeCognitiveChoiceReceipt(f.choice??f.cognitiveChoiceReceipt);
    const scatter=normalizeScatterReceipt(f.scatter??f.scatterReceipt,choice);
    const sensory=normalizeSensoryReceipt(f.sensory??f.sensoryTrace??f.candidateBusEnvelope??(f.fusionReceipt?{fusionReceipt:f.fusionReceipt}:null));
    const truth=normalizeTruthAssessment(f.truth??f.truthAssessment);
    const corrective=normalizeCorrectiveRetrievalReceipt(f.corrective??f.correctiveRetrievalReceipt,truth);
    const jev=normalizeJevDecisionReceipt(f.jev??f.jevDecisionReceipt,choice);
    const precision=normalizePrecisionReceipt(f.precision??f.precisionReceipt,choice);
    const gather=normalizeGatherReceipt(f.gather??f.gatherReceipt);
    const seal=normalizeContextSealReceipt(f.seal??f.contextSealReceipt,{lateResultRefs:gather?.results?.filter(x=>x.status==='LATE').map(x=>x.resultId).filter(Boolean)??[]});
    const promptPlan=clone(f.promptPlan??null),scene=clone(f.scene??null),hotCognition=clone(f.hotCognition??null),lore=normalizeLoreStatus(f.lore??null);
    const modes=Object.fromEntries(['scene','choice','scatter','sensory','truth','jev','precision','gather','seal','promptPlan','hotCognition','lore'].map(k=>[k,(f[k]??(k==='choice'?f.cognitiveChoiceReceipt:k==='jev'?f.jevDecisionReceipt:k==='gather'?f.gatherReceipt:k==='seal'?f.contextSealReceipt:null))!=null?ProductDataMode.FIXTURE:ProductDataMode.UNAVAILABLE]));
    const path=buildLiveCognitionPath({scene,hotCognition,choice,scatter,sensory,truth,corrective,jev,precision,gather,seal,promptPlan,lore,modes});
    const fixtureSource=(label,present)=>createProductSourceStatus({mode:present?ProductDataMode.FIXTURE:ProductDataMode.UNAVAILABLE,health:present?Wave6Health.READY:Wave6Health.UNAVAILABLE,label,impact:present?'Deterministic Wave 8 fixture — not live cognition.':`${label} fixture is unavailable.`,producer:present?'Wave8 fixture':null,connected:false});
    return deepFreeze({
      source:fixtureSource('Live Brain Cognition fixture',true),
      data:path,
      sources:{
        scene:fixtureSource('Scene',Boolean(scene)),choice:fixtureSource('Cognitive Choice',Boolean(choice)),scatter:fixtureSource('Scatter',Boolean(scatter)),
        sensory:fixtureSource('Sensory',Boolean(sensory)),truth:fixtureSource('Truth',Boolean(truth)),jev:fixtureSource('Jev',Boolean(jev)),
        precision:fixtureSource('Precision',Boolean(precision)),gather:fixtureSource('Gather',Boolean(gather)),seal:fixtureSource('Context Seal',Boolean(seal)),
        promptPlan:fixtureSource('PromptPlan',Boolean(promptPlan)),hotCognition:fixtureSource('Hot Cognition',Boolean(hotCognition)),lore:fixtureSource('Lore',Boolean(lore)),
      },
      errors:{},
    });
  }
}

function sourceMap({sceneResult,rawChoice,rawScatter,sensoryInput,rawTruth,rawCorrection,rawJev,rawPrecision,rawGather,rawSeal,promptResult,hotCognition,lore,errors,modes}){
  return deepFreeze({
    scene:sceneResult?.source??status('Scene',null,errors.scene,modes.scene),
    choice:status('Cognitive Choice',rawChoice,errors.choice,modes.choice),
    scatter:status('Scatter',rawScatter,errors.scatter,modes.scatter),
    sensory:status('Sensory',sensoryInput,errors.sensory??errors.candidateBus??errors.candidateFusion,modes.sensory),
    truth:status('Truth / Retrieval Quality',rawTruth,errors.truth,modes.truth),
    corrective:status('Corrective Retrieval',rawCorrection,errors.corrective,modeFor(rawCorrection,errors.corrective)),
    jev:status('Jev',rawJev,errors.jev,modes.jev),
    precision:status('Precision',rawPrecision,errors.precision,modes.precision),
    gather:status('Gather',rawGather,errors.gather,modes.gather),
    seal:status('Context Seal',rawSeal??promptResult?.data?.seal,errors.seal,modes.seal),
    promptPlan:promptResult?.source??status('PromptPlan',null,null,modes.promptPlan),
    hotCognition:status('Hot Cognition',hotCognition,errors.hotCognition,modes.hotCognition),
    lore:status('Lore',lore,errors.lore,modes.lore),
  });
}
function status(label,value,error,mode){
  if(error){const stale=error.code==='LIVE_RECEIPT_STALE'||error.code==='LIVE_RECEIPT_FUTURE';return createProductSourceStatus({mode:ProductDataMode.DEGRADED,health:stale?Wave6Health.STALE:Wave6Health.DEGRADED,label,impact:stale?label+' receipt failed the selected revision fence and was not shown.':label+' producer read failed; dependent stages remain unavailable.',reason:error.message,connected:true});}
  if(value)return createProductSourceStatus({mode:mode??ProductDataMode.LIVE,health:Wave6Health.READY,label,impact:`${label} receipt/read model is available.`,producer:value.kind??label});
  return createProductSourceStatus({mode:ProductDataMode.UNAVAILABLE,health:Wave6Health.UNAVAILABLE,label,impact:`${label} producer is unavailable.`,connected:false});
}
function modeFor(value,error){return error?ProductDataMode.DEGRADED:value?ProductDataMode.LIVE:ProductDataMode.UNAVAILABLE;}
function safeCognitionReadError(error,stage,selection={}){
  const identity=(value)=>{
    if(!value||typeof value!=='object')return null;
    const refs=value.sourceRevisionRefs??value.sourceRevisionIds??value.sourceRevisionSet??value.revisionFence?.sourceRevisionSet??[];
    return{
      chatId:value.chatId??null,turnId:value.turnId??null,generationId:value.generationId??null,correlationId:value.correlationId??null,
      worldRevision:value.worldRevision??value.revisionFence?.worldRevision??null,sceneRevision:value.sceneRevision??value.revisionFence?.sceneRevision??null,
      sourceRevisionRefs:[...new Set((Array.isArray(refs)?refs:[]).map(String))].slice(0,16),
    };
  };
  const expected=identity(error?.expected??selection),actual=identity(error?.actual);
  const expectedRefs=new Set(expected?.sourceRevisionRefs??[]);
  const foreignSourceRevisionRefs=(actual?.sourceRevisionRefs??[]).filter(ref=>!expectedRefs.has(ref)).slice(0,16);
  return{
    message:String(error?.message??error),code:error?.code??null,stage:error?.stage??stage,
    expected,actual,foreignSourceRevisionRefs,
  };
}

function strictPrecisionChoice(choice){
  const decision=choice?.precisionDecision;
  if(!decision)return null;
  if(decision.invoked===false||decision.skipped===true||decision.available===false||decision.failed===true||decision.fallback===true)return choice;
  return null;
}

function strictJevChoice(choice){
  const decision=choice?.jevDecision;
  if(!decision)return null;
  if(decision.invoked===false||decision.skipped===true||decision.unavailable===true)return choice;
  return null;
}
