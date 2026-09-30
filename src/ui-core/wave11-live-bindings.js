import { clone, deepFreeze } from './wave6-contracts.js';

export const WAVE11_LIVE_BINDING_VERSION='1.0.0';

const optional=(fn)=>typeof fn==='function'?fn:null;
const text=(v)=>v==null||v===''?null:String(v);
const number=(v)=>v==null||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const uniq=(values)=>[...new Set((values??[]).filter(x=>x!=null&&String(x).length).map(String))].sort();

export class LiveReceiptBindingError extends Error{
  constructor(code,message,{stage=null,expected=null,actual=null}={}){
    super(message);this.name='LiveReceiptBindingError';this.code=code;this.stage=stage;this.expected=clone(expected);this.actual=clone(actual);
  }
}

export function normalizeLiveSelection(input={}){
  const x=input?.selection??input?.context??input??{};
  return deepFreeze({
    chatId:text(x.chatId??x.chatNamespace??x.conversationId),
    turnId:text(x.turnId),
    generationId:text(x.generationId),
    correlationId:text(x.correlationId),
    worldRevision:number(x.worldRevision??x.revisionFence?.worldRevision),
    sceneRevision:number(x.sceneRevision??x.revisionFence?.sceneRevision),
    sourceRevisionRefs:uniq(x.sourceRevisionRefs??x.sourceRevisionIds??x.sourceRevisionSet??x.revisionFence?.sourceRevisionSet??[]),
  });
}

export class Wave11LiveReceiptBinding{
  constructor(input={}){
    if(!input||typeof input!=='object')throw new TypeError('Wave 11 live binding requires a host reader bundle');
    this.input=input;this.destroyed=false;this.releases=new Set();this.sequence=0;
    this.readSelectionFn=optional(input.readSelection??input.readCurrentSelection??input.readCurrentTurn);
    this.subscribeFn=optional(input.subscribe??input.subscribeReceipts??input.subscribeHost);
    this.current=normalizeLiveSelection(input.initialSelection??this.readSelectionFn?.()??{});
    this.diagnosticsState={reads:0,rejected:0,stale:0,future:0,switches:0,lastError:null};
    this.bridges=this.#buildBridges();
  }

  selection(explicit={}){
    const q=normalizeLiveSelection(explicit);
    const historicalGeneration=Boolean(q.generationId&&this.current.generationId&&q.generationId!==this.current.generationId);
    const historicalTurn=Boolean(q.turnId&&this.current.turnId&&q.turnId!==this.current.turnId);
    const detached=historicalGeneration||historicalTurn;
    return deepFreeze({
      chatId:q.chatId??this.current.chatId,
      turnId:q.turnId??(detached?null:this.current.turnId),
      generationId:q.generationId??(historicalTurn?null:this.current.generationId),
      correlationId:q.correlationId??(detached?null:this.current.correlationId),
      worldRevision:q.worldRevision??(detached?null:this.current.worldRevision),
      sceneRevision:q.sceneRevision??(detached?null:this.current.sceneRevision),
      sourceRevisionRefs:q.sourceRevisionRefs.length?q.sourceRevisionRefs:(detached?[]:this.current.sourceRevisionRefs),
    });
  }

  refreshSelection(candidate=null){
    if(this.destroyed)return this.current;
    const next=normalizeLiveSelection(candidate??this.readSelectionFn?.()??this.current);
    if(selectionKey(next)!==selectionKey(this.current)){this.current=next;this.sequence+=1;this.diagnosticsState.switches+=1;}
    return this.current;
  }

  subscribe(listener){
    if(typeof listener!=='function')throw new TypeError('live binding listener must be a function');
    if(!this.subscribeFn||this.destroyed)return()=>{};
    const release=this.subscribeFn((event)=>{
      if(this.destroyed)return;
      const eventSelection=event?.selection??event?.context??null;
      this.refreshSelection(eventSelection??this.readSelectionFn?.()??this.current);
      listener(deepFreeze({kind:'Wave11LiveReceiptUpdate',sequence:++this.sequence,selection:this.selection(),event:clone(event??null)}));
    });
    const safe=typeof release==='function'?release:()=>{};this.releases.add(safe);
    return()=>{if(this.releases.delete(safe))safe();};
  }

  diagnostics(){return deepFreeze({kind:'Wave11LiveBindingDiagnostics',contractVersion:WAVE11_LIVE_BINDING_VERSION,selection:this.selection(),...this.diagnosticsState,readOnly:true,mutationAuthority:false});}

  destroy(){if(this.destroyed)return;this.destroyed=true;for(const release of [...this.releases])try{release();}catch{}this.releases.clear();}

  #read(stage,fn,explicit={}){
    if(!fn)return null;const selection=this.selection(explicit);this.diagnosticsState.reads+=1;
    try{
      const request=explicit&&typeof explicit==='object'&&!Array.isArray(explicit)?{...clone(explicit),...selection}:selection;
      const raw=fn(request);if(raw==null)return null;assertCoherent(stage,raw,selection);return raw;
    }catch(error){
      this.diagnosticsState.rejected+=1;if(error?.code==='LIVE_RECEIPT_STALE')this.diagnosticsState.stale+=1;if(error?.code==='LIVE_RECEIPT_FUTURE')this.diagnosticsState.future+=1;
      this.diagnosticsState.lastError={stage,code:error?.code??'LIVE_RECEIPT_READ_FAILED',message:String(error?.message??error)};throw error;
    }
  }

  #list(stage,fn,explicit={}){
    if(!fn)return[];const selection=this.selection(explicit);this.diagnosticsState.reads+=1;
    try{
      const request=explicit&&typeof explicit==='object'&&!Array.isArray(explicit)?{...clone(explicit),...selection}:selection;
      const rows=fn(request)??[];if(!Array.isArray(rows))throw new LiveReceiptBindingError('LIVE_RECEIPT_LIST_INVALID',stage+' reader did not return an array',{stage});
      return rows.filter(row=>matchesSelection(row,selection,{allowUnknown:false}));
    }catch(error){this.diagnosticsState.rejected+=1;this.diagnosticsState.lastError={stage,code:error?.code??'LIVE_RECEIPT_READ_FAILED',message:String(error?.message??error)};throw error;}
  }

  #buildBridges(){
    const x=this.input,read=(name,...aliases)=>optional(x[name]??aliases.map(k=>x[k]).find(v=>typeof v==='function'));
    const scene=read('readScene','readSceneModel','readSceneUiReadModel');
    const prompt=read('readPromptPlan','readPromptPlanReadModel'),context=read('readContextReceipt','readContextReceiptReadModel'),seal=read('readContextSeal','readContextSealReceipt','readSealReceipt');
    const forensic=read('readForensic','readForensicReadModel'),forensicList=read('listForensics','listForensicReadModels','listBundles'),transactions=read('listTransactions','listCognitiveTransactions');
    const txRead=read('readTransaction','readCognitiveTransaction'),integrity=read('readIntegrityReceipt'),generationRead=read('readGeneration'),generations=read('listGenerations');
    const selectedTurn=read('readSelectedTurnReceipt','readCausalTurnReceipt','readOwnerTurnReceipt');
    const binding=this;
    return deepFreeze({
      selectedTurn:selectedTurn?{readReceipt:(selection)=>binding.#read('SelectedTurnReceipt',selectedTurn,selection)}:null,
      scene:scene?{readModel:()=>binding.#read('Scene',scene),subscribe:null}:null,
      runtimeAdapter:x.runtimeAdapter??null,coprocessorTelemetry:x.coprocessorTelemetry??x.coprocessorAdapter??null,
      promptPlan:{
        readPromptPlanReadModel:prompt?(selection)=>binding.#read('PromptPlan',prompt,selection):null,
        readContextReceiptReadModel:context?(selection)=>binding.#read('ContextReceipt',context,selection):null,
        readSealReceipt:seal?(selection)=>binding.#read('ContextSeal',seal,selection):null,
        readIntegrityReceipt:integrity?(selection)=>binding.#read('ContextIntegrity',integrity,selection):null,
        listGenerations:generations?({limit=50}={})=>(generations({limit,selection:binding.selection()})??[]).slice(-Math.max(1,limit)):null,
        readGeneration:generationRead?(generationId)=>binding.#read('Generation',generationRead,{generationId}):null,
      },
      forensics:{
        listTransactions:transactions?(selection)=>binding.#list('CognitiveTransaction',transactions,selection):null,
        listForensicReadModels:forensicList?(selection)=>binding.#list('ForensicReadModel',forensicList,selection):null,
        readForensicReadModel:forensic?(selection)=>binding.#read('ForensicReadModel',forensic,selection):null,
        readTransaction:txRead?(id)=>{const raw=txRead(id);if(raw!=null)assertCoherent('CognitiveTransaction',raw,binding.selection());return raw;}:null,
        reconstructGeneration:read('reconstructGeneration')??null,reconstructTransaction:read('reconstructTransaction')??null,
        readRuntimeWork:read('readRuntimeWork')??null,readKnowledgeTrace:read('readKnowledgeTrace')??null,readLazyPayload:read('readLazyForensicPayload','readLazyPayload')??null,search:read('searchForensics','search')??null,
      },
      cognition:{
        strictReceiptCoherence:true,selectionProvider:()=>binding.selection(),
        readHotCognitionReadModel:read('readHotCognition','readHotCognitionReadModel')?(selection)=>binding.#read('HotCognition',read('readHotCognition','readHotCognitionReadModel'),selection):null,
        readCognitiveChoiceReceipt:read('readCognitiveChoice','readCognitiveChoiceReceipt')?(selection)=>binding.#read('CognitiveChoice',read('readCognitiveChoice','readCognitiveChoiceReceipt'),selection):null,
        readScatterReceipt:read('readScatter','readScatterReceipt','readRuntimeTurn')?(selection)=>binding.#read('Scatter',read('readScatter','readScatterReceipt','readRuntimeTurn'),selection):null,
        readSensoryTrace:read('readSensoryTrace')?(selection)=>binding.#read('Sensory',read('readSensoryTrace'),selection):null,
        readCandidateBusEnvelope:read('readCandidateBusEnvelope')?(selection)=>binding.#read('CandidateBus',read('readCandidateBusEnvelope'),selection):null,
        readCandidateFusionReceipt:read('readCandidateFusionReceipt')?(selection)=>binding.#read('CandidateFusion',read('readCandidateFusionReceipt'),selection):null,
        readTruthAssessment:read('readTruth','readTruthAssessment')?(selection)=>binding.#read('Truth',read('readTruth','readTruthAssessment'),selection):null,
        readCorrectiveRetrievalReceipt:read('readCorrectiveRetrieval','readCorrectiveRetrievalReceipt')?(selection)=>binding.#read('CorrectiveRetrieval',read('readCorrectiveRetrieval','readCorrectiveRetrievalReceipt'),selection):null,
        readJevDecisionReceipt:read('readJev','readJevDecisionReceipt')?(selection)=>binding.#read('Jev',read('readJev','readJevDecisionReceipt'),selection):null,
        readPrecisionReceipt:read('readPrecision','readPrecisionReceipt')?(selection)=>binding.#read('Precision',read('readPrecision','readPrecisionReceipt'),selection):null,
        readGatherReceipt:read('readGather','readGatherReceipt')?(selection)=>binding.#read('Gather',read('readGather','readGatherReceipt'),selection):null,
        readContextSealReceipt:seal?(selection)=>binding.#read('ContextSeal',seal,selection):null,
        readLoreStatus:read('readLoreStatus')?(selection)=>binding.#read('LoreStatus',read('readLoreStatus'),selection):null,
        subscribe:(listener)=>binding.subscribe(listener),
      },
      story:x.story??null,characters:x.characters??null,lore:x.lore??null,memory:x.memory??null,world:x.world??null,knowledgeAdapter:x.knowledgeAdapter??null,
    });
  }
}

export function createWave11LiveReceiptBinding(input){return new Wave11LiveReceiptBinding(input);}

export function mergeWave11Bridges(base={},live={}){
  const out={...base,...live};
  for(const key of ['selectedTurn','scene','promptPlan','forensics','cognition'])out[key]={...(base?.[key]??{}),...(live?.[key]??{})};
  return out;
}

function assertCoherent(stage,raw,selection){
  const actual=identity(raw);
  for(const key of ['chatId','turnId','generationId','correlationId']){
    const expected=selection[key],seen=actual[key];if(expected!=null&&seen!=null&&String(expected)!==String(seen))throw new LiveReceiptBindingError('LIVE_RECEIPT_IDENTITY_MISMATCH',stage+' belongs to '+key+' '+seen+', not selected '+expected,{stage,expected:selection,actual});
  }
  for(const key of ['worldRevision','sceneRevision']){
    const expected=selection[key],seen=actual[key];if(expected==null||seen==null||Number(expected)===Number(seen))continue;
    const code=Number(seen)<Number(expected)?'LIVE_RECEIPT_STALE':'LIVE_RECEIPT_FUTURE';
    throw new LiveReceiptBindingError(code,stage+' '+key+' '+seen+' does not match selected revision '+expected,{stage,expected:selection,actual});
  }
  if(selection.sourceRevisionRefs.length&&actual.sourceRevisionRefs.length){
    const expected=new Set(selection.sourceRevisionRefs),foreign=actual.sourceRevisionRefs.filter(ref=>!expected.has(ref));
    if(foreign.length)throw new LiveReceiptBindingError('LIVE_RECEIPT_STALE',stage+' references source revisions outside the selected source fence: '+foreign.join(', '),{stage,expected:selection,actual});
  }
  return true;
}

function matchesSelection(raw,selection,{allowUnknown=true}={}){
  const actual=identity(raw),pairs=['chatId','turnId','generationId','correlationId'];let compared=0;
  for(const key of pairs){if(selection[key]==null||actual[key]==null)continue;compared+=1;if(String(selection[key])!==String(actual[key]))return false;}
  if(compared)return true;
  return allowUnknown||(!selection.turnId&&!selection.generationId&&!selection.correlationId);
}

function identity(raw={}){
  const x=raw?.data??raw??{},fence=x.revisionFence??x.revisions??x.inputRevisionSet??{},meta=x.metadata??{};
  return{
    chatId:text(x.chatId??x.chatNamespace??x.conversationId??meta.chatId??meta.chatNamespace),
    turnId:text(x.turnId??x.turn?.turnId??meta.turnId),
    generationId:text(x.generationId??meta.generationId),
    correlationId:text(x.correlationId??x.turn?.correlationId??meta.correlationId),
    worldRevision:number(x.worldRevision??fence.worldRevision),
    sceneRevision:number(x.sceneRevision??x.revision??fence.sceneRevision),
    sourceRevisionRefs:uniq(x.sourceRevisionRefs??x.sourceRevisionIds??x.sourceRevisionSet??fence.sourceRevisionRefs??fence.sourceRevisionSet??[]),
  };
}

function selectionKey(x){return JSON.stringify([x.chatId,x.turnId,x.generationId,x.correlationId,x.worldRevision,x.sceneRevision,x.sourceRevisionRefs]);}
