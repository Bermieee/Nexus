import { ProductPresentationState } from './wave5-product-model.js';
import { ProductDataMode, Wave6Health, createProductSourceStatus, deepFreeze, clone, normalizeWave6Health, assertFixtureNotLive } from './wave6-contracts.js';
import { buildGenerationExplainability, normalizeContextReceiptReadModel, normalizePromptPlanReadModel } from './wave7-explainability.js';
import { ForensicMetadataIndex, LazyForensicDetailCache, buildForensicTimeline, normalizeForensicReadModel } from './wave7-forensics.js';

const required=(fn,name)=>{if(typeof fn!=='function')throw new TypeError(`${name} is required`);return fn;};
const optional=(fn)=>typeof fn==='function'?fn:null;
const valueOfField=(field)=>field&&typeof field==='object'&&'value'in field?field.value:field;
const idOf=(x,...keys)=>{for(const key of keys){const value=x?.[key];if(typeof value==='string'&&value)return value;}return null;};

export class SceneProductionUIAdapter{
  constructor({readModel,subscribe=null,selectionProvider=null}={}){this.readModel=required(readModel,'SceneProductionUIAdapter.readModel');this.subscribeFn=optional(subscribe);this.selectionProvider=optional(selectionProvider);this.kind='SceneProductionUIAdapter';}
  read(selection={}){
    selection=Object.keys(selection??{}).length?selection:(this.selectionProvider?.()??{});let model=null;
    try{model=this.readModel(selection);}
    catch(error){return degraded('Scene','Scene read failed; the selected live context was not filled from another turn.',{error:String(error?.message??error),code:error?.code??null});}
    if(!model&&selection?.chatId&&!selection?.turnId)return deepFreeze({source:createProductSourceStatus({mode:ProductDataMode.LIVE,health:Wave6Health.IDLE,label:'Scene',operationalState:'WAITING_FOR_TURN',impact:'Selected chat is current; Scene will bind when an active turn/observation is published.',reason:'No selected-turn Scene receipt yet.',producer:'SceneUiReadModel',connected:true,selection}),data:null});
    if(!model)return unavailable('Scene','Scene read model is not connected.');
    if(model.kind!=='SceneUiReadModel')return degraded('Scene','Scene producer returned an unsupported read-model shape.',{rawKind:model.kind??null});
    const location=valueOfField(model.location),time=valueOfField(model.narrativeTime),atmosphere=model.atmosphere;
    const health=normalizeWave6Health(model.health?.state??model.health?.productHealth??model.health?.generalStatus,{fallback:Wave6Health.READY});
    const mode=health===Wave6Health.UNAVAILABLE?ProductDataMode.UNAVAILABLE:[Wave6Health.DEGRADED,Wave6Health.STALE,Wave6Health.BLOCKED].includes(health)?ProductDataMode.DEGRADED:ProductDataMode.LIVE;
    return deepFreeze({
      source:createProductSourceStatus({mode,health,label:'Scene',impact:impactForScene(health),reason:(model.health?.reasons??[]).join(', '),producer:'SceneUiReadModel',revision:model.revision}),
      data:{
        id:model.sceneId,revision:model.revision,lifecycle:model.lifecycle,title:sceneTitle(location,model.sceneId),
        location:normalizeLocation(location),narrativeTime:normalizeTime(time),cast:(model.activeCast??[]).map(character),
        objects:(model.objects??[]).map(objectState),activeThreads:(model.activeThreads??[]).map(threadLabel),
        atmosphere:atmosphere?{label:atmosphereLabel(atmosphere),authority:atmosphere.authority??'INFERRED',inferred:Boolean(atmosphere.inferred),canonical:Boolean(atmosphere.canonical),evidenceRefs:[...(atmosphere.evidenceRefs??[])]}:null,
        boundary:normalizeBoundary(model.boundaryState),relationshipToPrior:model.relationshipToPrior??null,
        latestEpisodeRef:clone(model.latestEpisodeRef),latestDeltaSummary:clone(model.latestDeltaSummary),
        prefetchState:clone(model.prefetchState??{active:[],count:0}),uncertainFields:[...(model.uncertainFields??[])],
        provenanceRefs:[...(model.provenanceRefs??[])],diagnosticRefs:clone(model.diagnosticRefs??{}),
      },
    });
  }
  subscribe(handler){return this.subscribeFn?this.subscribeFn(handler):()=>{};}
}

export class RuntimeProductionUIAdapter{
  constructor(adapter=null){this.adapter=adapter;this.kind='RuntimeProductionUIAdapter';}
  read(){
    if(!this.adapter?.getTelemetrySummary)return unavailable('Runtime','Runtime telemetry producer is not connected.');
    try{
      const x=this.adapter.getTelemetrySummary();
      const health=x.blockedRecoveringWork>0?Wave6Health.DEGRADED:x.hotActivity+x.deepActivity>0?Wave6Health.WORKING:Wave6Health.READY;
      return deepFreeze({source:createProductSourceStatus({mode:health===Wave6Health.DEGRADED?ProductDataMode.DEGRADED:ProductDataMode.LIVE,health,label:'Runtime',impact:health===Wave6Health.DEGRADED?'Some cognition is blocked or recovering; generation may continue with reduced assistance.':'Runtime work is available.',producer:'RuntimeUIAdapter'}),data:clone(x)});
    }catch(error){return degraded('Runtime','Runtime telemetry could not be read.',{error:String(error?.message??error)});}
  }
  subscribe(handler){return this.adapter?.subscribeRuntime?.(handler)??(()=>{});}
  getLedgerPage(options){return this.adapter?.getLedgerPage?.(options)??{items:[],total:0};}
  getLedgerTaskDetail(id){return this.adapter?.getLedgerTaskDetail?.(id)??null;}
  getRecoveryPage(options){return this.adapter?.getRecoveryPage?.(options)??{items:[],total:0};}
}

export class CoprocessorProductionUIAdapter{
  constructor(bridge=null){this.bridge=bridge;this.kind='CoprocessorProductionUIAdapter';}
  read(){
    if(!this.bridge)return unavailable('Coprocessor','Coprocessor telemetry producer is not connected.');
    try{
      if(typeof this.bridge.snapshot==='function'){
        const x=this.bridge.snapshot();
        const stale=Number(x.staleDrop??0),fallback=Number(x.fallback??0),health=stale||fallback?Wave6Health.DEGRADED:Wave6Health.READY;
        return deepFreeze({source:createProductSourceStatus({mode:health===Wave6Health.DEGRADED?ProductDataMode.DEGRADED:ProductDataMode.LIVE,health,label:'Coprocessor',impact:health===Wave6Health.DEGRADED?'Generation continues; some cognitive assistance used fallback or was dropped stale.':'Cognitive specialists are available.',producer:'CoprocessorTelemetry'}),data:clone(x)});
      }
      if(typeof this.bridge.getCoprocessorTelemetry==='function'){
        const x=this.bridge.getCoprocessorTelemetry();
        if(!x)return deepFreeze({source:createProductSourceStatus({mode:ProductDataMode.LIVE,health:Wave6Health.IDLE,label:'Coprocessor',impact:'No active cognitive swarm.',producer:'CoprocessorUIAdapter'}),data:null});
        const workers=x.workers??[],degraded=workers.some(w=>w.fallbackUsed||w.freshness==='STALE'||w.validationResult==='FAILED');
        return deepFreeze({source:createProductSourceStatus({mode:degraded?ProductDataMode.DEGRADED:ProductDataMode.LIVE,health:degraded?Wave6Health.DEGRADED:Wave6Health.WORKING,label:'Coprocessor',impact:degraded?'Generation continues with contained fallback/stale work.':'Cognitive specialists are active.',producer:'CoprocessorUIAdapter'}),data:clone(x)});
      }
      return unavailable('Coprocessor','No supported Coprocessor telemetry read method is connected.');
    }catch(error){return degraded('Coprocessor','Coprocessor telemetry could not be read.',{error:String(error?.message??error)});}
  }
  subscribe(handler){
    if(typeof this.bridge?.subscribe==='function')return this.bridge.subscribe(handler);
    if(typeof this.bridge?.subscribeCoprocessor==='function')return this.bridge.subscribeCoprocessor(handler);
    return ()=>{};
  }
}

export class PromptPlanProductionUIAdapter{
  constructor({
    readPlan=null,readPromptPlanReadModel=null,readSealReceipt=null,readContextReceipt=null,readContextReceiptReadModel=null,
    readIntegrityReceipt=null,readHostDeliveryReceipt=null,listGenerations=null,readGeneration=null,fixture=false,fixtureLabel='DEMO / FIXTURE DATA',selectionProvider=null,
  }={}){
    this.readPlan=optional(readPlan);this.readPromptPlanReadModel=optional(readPromptPlanReadModel);this.readSealReceipt=optional(readSealReceipt);
    this.readContextReceipt=optional(readContextReceipt);this.readContextReceiptReadModel=optional(readContextReceiptReadModel);this.readIntegrityReceipt=optional(readIntegrityReceipt);this.readHostDeliveryReceipt=optional(readHostDeliveryReceipt);
    this.listGenerationsFn=optional(listGenerations);this.readGenerationFn=optional(readGeneration);this.selectionProvider=optional(selectionProvider);this.fixture=Boolean(fixture);this.fixtureLabel=String(fixtureLabel||'DEMO / FIXTURE DATA');this.kind='PromptPlanProductionUIAdapter';
  }
  #plan(selection){
    if(this.readPromptPlanReadModel)return this.readPromptPlanReadModel(selection??{});
    if(this.readGenerationFn&&selection?.generationId)return this.readGenerationFn(selection.generationId)?.promptPlan??this.readGenerationFn(selection.generationId)?.plan??null;
    return this.readPlan?.(selection??{});
  }
  #context(selection){
    if(this.readContextReceiptReadModel)return this.readContextReceiptReadModel(selection??{});
    if(this.readGenerationFn&&selection?.generationId)return this.readGenerationFn(selection.generationId)?.contextReceipt??null;
    return this.readContextReceipt?.(selection??{});
  }
  #seal(selection){
    if(this.readGenerationFn&&selection?.generationId)return this.readGenerationFn(selection.generationId)?.sealReceipt??null;
    return this.readSealReceipt?.(selection??{});
  }
  #hostDelivery(selection){
    if(this.readHostDeliveryReceipt)return this.readHostDeliveryReceipt(selection??{});
    if(this.readGenerationFn&&selection?.generationId)return this.readGenerationFn(selection.generationId)?.hostDeliveryReceipt??null;
    return null;
  }
  read(selection={}){
    selection=Object.keys(selection??{}).length?selection:(this.selectionProvider?.()??{});
    if(!this.readPlan&&!this.readPromptPlanReadModel&&!this.readGenerationFn)return unavailable('PromptPlan','Adaptive Context / PromptPlan read producer is not connected.');
    if(selection?.chatId&&!selection?.turnId)return deepFreeze({source:createProductSourceStatus({mode:ProductDataMode.LIVE,health:Wave6Health.IDLE,label:'Context Delivery',operationalState:'WAITING_FOR_TURN',impact:'Selected chat is current; PromptPlan will appear after a generation turn is published.',producer:'PromptPlan/ContextSeal',connected:true,selection}),data:null});
    try{
      const raw=this.#plan(selection);if(!raw)return deepFreeze({source:createProductSourceStatus({mode:ProductDataMode.LIVE,health:Wave6Health.IDLE,label:'Context Delivery',operationalState:'IDLE',impact:'No completed PromptPlan exists for the selected turn.',reason:'The producer is connected but has not published context delivery for this turn.',producer:'PromptPlan/ContextSeal',connected:true,selection}),data:null});
      const plan=normalizePromptPlanReadModel(raw);if(!plan)return degraded('PromptPlan','PromptPlan producer returned an unsupported contract.',{kind:raw.kind??null});
      const rawContext=this.#context(selection),receipt=normalizeContextReceiptReadModel(rawContext),seal=this.#seal(selection),integrity=this.readIntegrityReceipt?.(selection??{})??null,hostDelivery=this.#hostDelivery(selection);
      const explain=buildGenerationExplainability({promptPlan:raw,contextReceipt:rawContext,sealReceipt:seal,hostDeliveryReceipt:hostDelivery});
      const allocated=finiteNumber(plan.budget?.allocated??plan.budget?.usedTokens??plan.estimatedTokens),total=finiteNumber(plan.budget?.total??plan.budget?.available??plan.budget?.contextWindow);
      const reused=plan.sections.filter(x=>x.state==='REUSED').length,updated=plan.sections.filter(x=>['UPDATED','REBUILT'].includes(x.state)).length;
      const health=normalizeWave6Health(raw.health?.state??plan.health?.state??(raw.status==='READY'?'READY':raw.integrityStatus==='ERROR'?'BLOCKED':'READY'),{fallback:Wave6Health.READY});
      const degradedHealth=[Wave6Health.DEGRADED,Wave6Health.STALE,Wave6Health.BLOCKED].includes(health)||Boolean(receipt?.fallbackState&&receipt.fallbackState!=='NONE');
      const displayHealth=degradedHealth&&health===Wave6Health.READY?Wave6Health.DEGRADED:health;
      const mode=this.fixture?ProductDataMode.FIXTURE:degradedHealth?ProductDataMode.DEGRADED:ProductDataMode.LIVE;
      const baseImpact=degradedHealth?'Context was delivered with omissions, deferrals, fallback, stale evidence, or degraded integrity.':health===Wave6Health.WORKING?'Context delivery is still being assembled.':'Generation context is prepared and revision-fenced.';
      return deepFreeze({
        source:createProductSourceStatus({mode,health:displayHealth,label:'Context Delivery',impact:this.fixture?`${this.fixtureLabel}. ${baseImpact}`:baseImpact,producer:raw.kind==='PromptPlanReadModel'?'PromptPlanReadModel':'PromptPlan/ContextSeal',revision:plan.promptPlanId}),
        data:{
          promptPlanId:plan.promptPlanId,generationId:plan.generationId??receipt?.generationId??null,turnId:plan.turnId??seal?.turnId??receipt?.turnId??null,
          totalTokens:allocated,budgetTotal:total,budgetUsage:total!=null&&allocated!=null&&total>0?allocated/total:null,reusedSegments:reused,updatedSegments:updated,
          dropped:clone(plan.dropped),deferred:clone(plan.deferred),segments:clone(raw.segments??[]),sections:clone(plan.sections),
          modelProfileId:plan.modelProfileId??null,ordering:[...(plan.sectionOrder??[])],cacheDecisions:clone(raw.cacheDecisions??[]),
          reuseDecisions:clone(raw.reuseDecisions??[]),fallbackDecisions:clone(plan.fallbackDecisions??[]),integrityReceipt:clone(integrity),
          seal:clone(seal),contextReceipt:clone(receipt),sourceRevisionDependencies:[...(plan.sourceRevisionRefs??[])],
          worldRevision:plan.worldRevision??null,sceneRevision:plan.sceneRevision??null,status:raw.status??raw.integrityStatus??null,explainability:explain,
          readModelKind:raw.kind??null,
        },
      });
    }catch(error){return degraded('PromptPlan','Context delivery read failed.',{error:String(error?.message??error)});}
  }
  explain(selection={}){const r=this.read(selection);return r.data?.explainability??null;}
  listGenerations({limit=50}={}){
    try{
      if(this.listGenerationsFn)return (this.listGenerationsFn({limit})??[]).slice(-Math.max(1,limit)).map(x=>clone(x));
      const current=this.read();return current.data?.generationId?[{generationId:current.data.generationId,turnId:current.data.turnId,promptPlanId:current.data.promptPlanId,current:true}]:[];
    }catch{return[];}
  }
  readPrevious(current){
    const rows=this.listGenerations({limit:100});const id=typeof current==='string'?current:current?.generationId;const i=rows.findIndex(x=>x.generationId===id);if(i<=0)return null;return this.explain({generationId:rows[i-1].generationId});
  }
}

function finiteNumber(value){if(value==null||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;}

export class ForensicsProductionUIAdapter{
  constructor({
    listTransactions=null,listBundles=null,listForensicReadModels=null,readForensicReadModel=null,readTransaction=null,
    reconstructGeneration=null,reconstructTransaction=null,readRuntimeWork=null,readKnowledgeTrace=null,readLazyPayload=null,search=null,fixture=false,fixtureLabel='DEMO / FIXTURE DATA',
  }={}){
    this.listTransactions=optional(listTransactions);this.listBundles=optional(listBundles);this.listForensicReadModels=optional(listForensicReadModels);this.readForensicReadModel=optional(readForensicReadModel);
    this.readTransaction=optional(readTransaction);this.reconstructGeneration=optional(reconstructGeneration);this.reconstructTransaction=optional(reconstructTransaction);
    this.readRuntimeWork=optional(readRuntimeWork);this.readKnowledgeTrace=optional(readKnowledgeTrace);this.searchFn=optional(search);this.fixture=Boolean(fixture);this.fixtureLabel=String(fixtureLabel||'DEMO / FIXTURE DATA');
    this.detailCache=new LazyForensicDetailCache({loader:optional(readLazyPayload),maxEntries:32});this.indexCache=new Map();this.kind='ForensicsProductionUIAdapter';
  }
  read({limit=100}={}){
    if(!this.listTransactions&&!this.listBundles&&!this.listForensicReadModels&&!this.readForensicReadModel)return unavailable('Forensics','Cognitive transaction / forensic read producer is not connected.');
    try{
      const transactions=(this.listTransactions?.({limit})??this.listTransactions?.()??[]).slice(-Math.max(1,limit));
      const models=(this.listForensicReadModels?.({limit})??[]).slice(-Math.max(1,limit));
      const bundles=models.length?models:(this.listBundles?.({limit})??this.listBundles?.()??[]).slice(-Math.max(1,limit));
      const degradedRows=bundles.some(x=>x.health?.state==='DEGRADED'||x.complete===false);
      const mode=this.fixture?ProductDataMode.FIXTURE:degradedRows?ProductDataMode.DEGRADED:ProductDataMode.LIVE;
      const health=degradedRows?Wave6Health.DEGRADED:Wave6Health.READY;const impact=degradedRows?'Forensic reconstruction is partial; missing stages are shown rather than inferred.':'Decision and context trails are available for inspection.';
      return deepFreeze({source:createProductSourceStatus({mode,health,label:'Forensics',impact:this.fixture?`${this.fixtureLabel}. ${impact}`:impact,producer:'ForensicReadModel/CognitiveTransactionLedger'}),data:{transactions:clone(transactions),bundles:clone(bundles)}});
    }catch(error){return degraded('Forensics','Forensic read failed.',{error:String(error?.message??error)});}
  }
  readGeneration(generationId,{limit=10000}={}){
    if(!generationId)return unavailable('Forensics','Select a generation to reconstruct.');
    try{
      let forensic=this.readForensicReadModel?.({generationId})??this.readForensicReadModel?.(generationId)??null;
      if(!forensic){
        const rows=this.listForensicReadModels?.({generationId,limit})??this.listBundles?.({generationId})??this.listBundles?.()??[];
        forensic=rows.find(x=>x.generationId===generationId)??null;
      }
      if(!forensic)return unavailable('Forensics',`No forensic read model is available for ${generationId}.`);
      const model=normalizeForensicReadModel(forensic);
      let transactions=this.listTransactions?.({generationId,limit})??this.listTransactions?.()??[];
      transactions=transactions.filter(x=>!x.generationId||x.generationId===generationId).slice(-Math.max(1,limit));
      const timeline=buildForensicTimeline({forensic:model,transactions});
      const health=model.complete?Wave6Health.READY:Wave6Health.DEGRADED;const mode=this.fixture?ProductDataMode.FIXTURE:model.complete?ProductDataMode.LIVE:ProductDataMode.DEGRADED;const impact=model.complete?'Generation reconstruction references are available.':'Reconstruction is partial; missing references remain explicit.';
      return deepFreeze({source:createProductSourceStatus({mode,health,label:'Forensics',impact:this.fixture?`${this.fixtureLabel}. ${impact}`:impact,producer:'ForensicReadModel',revision:model.bundleId}),data:{forensic:model,transactions:clone(transactions),timeline}});
    }catch(error){return degraded('Forensics','Generation reconstruction failed.',{error:String(error?.message??error)});}
  }
  queryTimeline(filters={},options={}){
    if(this.searchFn)return clone(this.searchFn(filters,options)??[]);
    const generationId=options.generationId??filters.generationId??null,r=this.readGeneration(generationId,{limit:options.limit??10000});
    if(!r.data)return[];
    const key=generationId??r.data.forensic.bundleId;let index=this.indexCache.get(key);
    if(!index){index=new ForensicMetadataIndex(r.data.timeline.rows);this.indexCache.set(key,index);while(this.indexCache.size>8)this.indexCache.delete(this.indexCache.keys().next().value);}
    return clone(index.query(filters));
  }
  getTransaction(id){return clone(this.readTransaction?.(id)??this.listTransactions?.().find(x=>(x.transactionId??x.id)===id)??null);}
  getRuntimeWork(id){return clone(this.readRuntimeWork?.(id)??null);}
  getKnowledgeTrace(ref){return clone(this.readKnowledgeTrace?.(ref)??null);}
  getReconstruction(target,{maxTransactions=128}={}){
    if(target?.transactionId&&this.reconstructTransaction)return clone(this.reconstructTransaction(target.transactionId,{maxTransactions}));
    if(target?.generationId&&this.reconstructGeneration)return clone(this.reconstructGeneration(target.generationId,{maxTransactions}));
    return null;
  }
  loadDetail(ref){return this.detailCache.load(ref);}
  destroy(){this.detailCache.destroy();this.indexCache.clear();}
}

export class Wave6ProductAdapter{
  constructor({scene=null,runtime=null,coprocessor=null,promptPlan=null,forensics=null,story=null,characters=null,lore=null,memory=null,world=null,presentationState=null,fixture=null}={}){
    this.sources={scene,runtime,coprocessor,promptPlan,forensics,story,characters,lore,memory,world};this.presentationState=presentationState??new ProductPresentationState();this.fixture=fixture;
  }
  getDetailLevel(){return this.presentationState.get();}
  setDetailLevel(level){return this.presentationState.set(level);}
  subscribeDetailLevel(listener){return this.presentationState.subscribe(listener);}
  getSnapshot(){
    if(this.fixture){
      const snapshot=clone(this.fixture),names=['story','scene','characters','lore','memory','world','runtime','coprocessor','promptPlan','forensics'],sources={};
      for(const name of names){
        const present=snapshot[name]!=null;
        sources[name]=present
          ? createProductSourceStatus({mode:ProductDataMode.FIXTURE,health:Wave6Health.READY,label:fixtureLabel(name),impact:'Deterministic test/demo data only — not live cognitive state.',producer:'Wave6 fixture'})
          : createProductSourceStatus({mode:ProductDataMode.UNAVAILABLE,health:Wave6Health.UNAVAILABLE,label:fixtureLabel(name),impact:`${fixtureLabel(name)} is not included in this fixture.`,producer:null,connected:false});
        assertFixtureNotLive(sources[name]);
      }
      return deepFreeze({...snapshot,wave6:{mode:ProductDataMode.FIXTURE,sources,attention:[]}});
    }
    const scene=read(this.sources.scene),runtime=read(this.sources.runtime),coprocessor=read(this.sources.coprocessor),promptPlan=read(this.sources.promptPlan),forensics=read(this.sources.forensics);
    const story=readGeneric('Story',this.sources.story),characters=readGeneric('Characters',this.sources.characters),lore=readGeneric('Lore',this.sources.lore),memory=readGeneric('Memory',this.sources.memory),world=readGeneric('World',this.sources.world);
    const sources={scene:scene.source,runtime:runtime.source,coprocessor:coprocessor.source,promptPlan:promptPlan.source,forensics:forensics.source,story:story.source,characters:characters.source,lore:lore.source,memory:memory.source,world:world.source};
    for(const x of Object.values(sources))assertFixtureNotLive(x);
    const attention=Object.entries(sources).filter(([name,s])=>['scene','runtime','coprocessor','promptPlan'].includes(name)&&[Wave6Health.DEGRADED,Wave6Health.STALE,Wave6Health.BLOCKED,Wave6Health.UNAVAILABLE].includes(s.health)).map(([name,s])=>({id:`source:${name}`,source:name,status:s.statusToken,title:s.label,message:s.impact||s.reason}));
    const overall=aggregateHealth([scene.source,runtime.source,coprocessor.source,promptPlan.source]);
    return deepFreeze({
      wave6:{mode:aggregateMode(Object.values(sources)),sources,attention},
      story:story.data,scene:scene.data,characters:characters.data,lore:lore.data,memory:memory.data,world:world.data,
      runtime:runtime.data,coprocessor:coprocessor.data,promptPlan:promptPlan.data,forensics:forensics.data,
      brain:{overall,components:Object.entries(sources).filter(([n])=>['scene','runtime','coprocessor','promptPlan'].includes(n)).map(([id,s])=>({id,label:s.label,status:s.health,detail:s.impact||s.reason,mode:s.mode}))},
    });
  }
}

function fixtureLabel(name){return({story:'Story',scene:'Scene',characters:'Characters',lore:'Lore',memory:'Memory',world:'World',runtime:'Runtime',coprocessor:'Coprocessor',promptPlan:'Context Delivery',forensics:'Forensics'})[name]??name;}
function read(source){
  if(!source)return unavailable('Subsystem','Producer is not connected.');
  if(typeof source.read==='function')return source.read();
  return unavailable('Subsystem','Producer does not expose read().');
}
function readGeneric(label,source){
  if(!source)return unavailable(label,`${label} producer is not connected.`);
  try{
    const data=typeof source==='function'?source():typeof source.read==='function'?source.read():null;
    if(data?.source&&'data'in data)return data;
    if(data==null)return unavailable(label,`No ${label} read model is available.`);
    return deepFreeze({source:createProductSourceStatus({mode:ProductDataMode.LIVE,health:Wave6Health.READY,label,impact:`${label} state is available.`,producer:`${label} read model`}),data:clone(data)});
  }catch(error){return degraded(label,`${label} read failed.`,{error:String(error?.message??error)});}
}
function unavailable(label,reason){return deepFreeze({source:createProductSourceStatus({mode:ProductDataMode.UNAVAILABLE,health:Wave6Health.UNAVAILABLE,label,impact:`${label} is unavailable.`,reason,connected:false}),data:null});}
function degraded(label,impact,extra={}){return deepFreeze({source:createProductSourceStatus({mode:ProductDataMode.DEGRADED,health:Wave6Health.DEGRADED,label,impact,reason:extra.error??'',connected:true}),data:extra.raw??null});}
function aggregateHealth(statuses){if(statuses.length&&statuses.every(x=>x.health===Wave6Health.UNAVAILABLE))return'UNAVAILABLE';if(statuses.some(x=>x.health===Wave6Health.BLOCKED))return'BLOCKED';if(statuses.some(x=>x.health===Wave6Health.UNAVAILABLE))return'DEGRADED';if(statuses.some(x=>[Wave6Health.DEGRADED,Wave6Health.STALE].includes(x.health)))return'DEGRADED';if(statuses.some(x=>x.health===Wave6Health.WORKING))return'STUDYING';return'READY';}
function aggregateMode(statuses){if(statuses.length&&statuses.every(x=>x.mode===ProductDataMode.UNAVAILABLE))return ProductDataMode.UNAVAILABLE;if(statuses.some(x=>x.mode===ProductDataMode.DEGRADED))return ProductDataMode.DEGRADED;return ProductDataMode.LIVE;}
function sceneTitle(location,sceneId){const name=normalizeLocation(location);return name&&name!=='—'?name:`Scene ${sceneId}`;}
function normalizeLocation(x){if(x==null)return'—';if(typeof x==='string')return x;return x.name??x.location??x.label??x.id??'—';}
function normalizeTime(x){if(x==null)return'—';if(typeof x==='string')return x;return x.label??x.anchor??x.display??x.mode??'—';}
function character(x){if(typeof x==='string')return{id:x,name:x,state:'PRESENT'};const id=idOf(x,'characterId','characterRef','ref','id')??'unknown';return{id,name:x.name??id,state:x.state??x.presence??'PRESENT',authority:x.authority??x.observationClass??'OBSERVED'};}
function objectState(x){if(typeof x==='string')return{id:x,name:x,state:'PRESENT'};const id=idOf(x,'objectId','objectRef','ref','id')??'unknown';return{id,name:x.name??id,state:x.state??'PRESENT',holderId:x.holderId??null,authority:x.authority??x.observationClass??'OBSERVED'};}
function threadLabel(x){return typeof x==='string'?x:x?.label??x?.objective??x?.threadId??x?.id??'Thread';}
function atmosphereLabel(a){const v=valueOfField(a);if(v==null)return'No inferred atmosphere';if(typeof v==='string')return v;if(v.label)return v.label;const dims=Object.entries(v).filter(([,x])=>x&&typeof x==='object'&&Number.isFinite(Number(x.score))).sort((a,b)=>Number(b[1].score)-Number(a[1].score));return dims.length?dims.slice(0,2).map(([k])=>k.replace(/_/g,' ')).join(' · '):'Inferred atmosphere';}
function normalizeBoundary(x){const v=valueOfField(x);if(v==null)return{state:'STABLE',confidence:null,supportingSignals:[],contradictoryEvidence:[]};if(typeof v==='string')return{state:v,confidence:null,supportingSignals:[],contradictoryEvidence:[]};return{state:v.state??v.status??v.type??'STABLE',confidence:v.confidence??null,supportingSignals:[...(v.supportingSignals??[])],contradictoryEvidence:[...(v.contradictoryEvidence??[])]};}
function impactForScene(health){if(health===Wave6Health.DEGRADED)return'Scene state is usable with unresolved or degraded fields.';if(health===Wave6Health.STALE)return'Scene state is stale; generation should rely on fresh context fences.';if(health===Wave6Health.BLOCKED)return'Scene cognition requires rebuild before it is trustworthy.';if(health===Wave6Health.UNAVAILABLE)return'Scene cognition is unavailable.';return'Current Scene state is available.';}
function sum(rows,key){return rows.reduce((n,x)=>n+Number(x?.[key]??0),0);}
