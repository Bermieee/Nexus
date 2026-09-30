import { deepFreeze } from './wave6-contracts.js';

const optionalFn=(value,name)=>{if(value==null)return null;if(typeof value!=='function')throw new TypeError(`${name} must be a function when provided`);return value;};

export function createWave7ProductionBindings({
  scene=null,runtimeAdapter=null,coprocessorTelemetry=null,
  readPromptPlanReadModel=null,readContextReceiptReadModel=null,readContextSealReceipt=null,readIntegrityReceipt=null,listGenerations=null,readGeneration=null,
  listForensicReadModels=null,readForensicReadModel=null,listCognitiveTransactions=null,readCognitiveTransaction=null,
  reconstructGeneration=null,reconstructTransaction=null,readRuntimeWork=null,readKnowledgeTrace=null,readLazyForensicPayload=null,searchForensics=null,
  story=null,characters=null,lore=null,memory=null,world=null,fixture=false,fixtureLabel='DEMO / FIXTURE DATA',
}={}){
  return deepFreeze({
    scene,
    runtimeAdapter,
    coprocessorTelemetry,
    promptPlan:{
      fixture:Boolean(fixture),fixtureLabel:String(fixtureLabel||'DEMO / FIXTURE DATA'),
      readPromptPlanReadModel:optionalFn(readPromptPlanReadModel,'readPromptPlanReadModel'),
      readContextReceiptReadModel:optionalFn(readContextReceiptReadModel,'readContextReceiptReadModel'),
      readSealReceipt:optionalFn(readContextSealReceipt,'readContextSealReceipt'),
      readIntegrityReceipt:optionalFn(readIntegrityReceipt,'readIntegrityReceipt'),
      listGenerations:optionalFn(listGenerations,'listGenerations'),
      readGeneration:optionalFn(readGeneration,'readGeneration'),
    },
    forensics:{
      fixture:Boolean(fixture),fixtureLabel:String(fixtureLabel||'DEMO / FIXTURE DATA'),
      listForensicReadModels:optionalFn(listForensicReadModels,'listForensicReadModels'),
      readForensicReadModel:optionalFn(readForensicReadModel,'readForensicReadModel'),
      listTransactions:optionalFn(listCognitiveTransactions,'listCognitiveTransactions'),
      readTransaction:optionalFn(readCognitiveTransaction,'readCognitiveTransaction'),
      reconstructGeneration:optionalFn(reconstructGeneration,'reconstructGeneration'),
      reconstructTransaction:optionalFn(reconstructTransaction,'reconstructTransaction'),
      readRuntimeWork:optionalFn(readRuntimeWork,'readRuntimeWork'),
      readKnowledgeTrace:optionalFn(readKnowledgeTrace,'readKnowledgeTrace'),
      readLazyPayload:optionalFn(readLazyForensicPayload,'readLazyForensicPayload'),
      search:optionalFn(searchForensics,'searchForensics'),
    },
    story,characters,lore,memory,world,
  });
}

export function describeWave7BindingAvailability(bindings={}){
  const p=bindings.promptPlan??{},f=bindings.forensics??{};
  return deepFreeze({
    promptPlan:Boolean(p.readPromptPlanReadModel),
    contextReceipt:Boolean(p.readContextReceiptReadModel),
    contextSeal:Boolean(p.readSealReceipt),
    generationHistory:Boolean(p.listGenerations||p.readGeneration),
    forensics:Boolean(f.readForensicReadModel||f.listForensicReadModels),
    cognitiveTransactions:Boolean(f.listTransactions),
    reconstruction:Boolean(f.reconstructGeneration||f.reconstructTransaction),
    runtimeWork:Boolean(bindings.runtimeAdapter||f.readRuntimeWork),
    lazyPayload:Boolean(f.readLazyPayload),
  });
}
