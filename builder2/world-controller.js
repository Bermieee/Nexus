import {createWorldBuildPlan,worldBuildFingerprint,validateWorldBuildPlan} from './world-plan.js';
import {materializeWorldBuildPlan} from './world-materializer.js';
import {planWorldTreeLayout} from '../world-tree/layout.js';

function previewLayout(plan,preview,previousLayout){
  const parents=new Map(preview.edges.filter(e=>e.data?.primaryPlacement).map(e=>[e.to,e.from]));
  plan.layout.proposed=planWorldTreeLayout({nodes:preview.nodes.map(n=>({...n,parentId:parents.get(n.id)??n.parentId})),previousLayout,
    pins:plan.layout.pins,seed:plan.layout.seed,mode:plan.mode});
}

export class WorldTreeBuilderController {
  constructor({context,store,analysis,mutation,layout,currentChatId,readCommitted=null}={}){
    if(!context||!store||!analysis||!mutation||!layout)throw new TypeError('World Tree Builder requires its owner adapters');
    Object.assign(this,{context,store,analysis,mutation,layout,currentChatId,readCommitted});this.executions=new Map();this.cancellations=new Map();this.serial=0;
  }
  async #save(record,expectedRevision=null){
    if(record.preview)record.preview={...record.preview,nodes:record.preview.nodes.map(n=>({...n,data:{label:n.data?.label??n.label??n.id,book:n.data?.book,uid:n.data?.uid}}))};
    if(expectedRevision!=null&&this.store.writeIfRevision){if(!await this.store.writeIfRevision(record,expectedRevision))throw Error('World build review revision conflict');}
    else await this.store.write(record);
    return this.#view(record);
  }
  #view(record){return structuredClone({...record,plan:record.plan,fingerprint:record.plan?worldBuildFingerprint(record.plan):null});}
  async #record(id){const record=await this.store.read(id);if(!record)throw Error('World build not found');return record;}
  #chat(record){if(this.currentChatId&&String(this.currentChatId())!==String(record.chatId))throw Error('World build chat changed');}
  async #fresh(record){
    this.#chat(record);const context=await this.context({sourceIds:record.sourceIds,chatId:record.chatId});
    if(context.worldRevision!==record.plan.worldRevision||context.sourceFence!==record.plan.sourceFence)throw Error('World build stale authority; reanalyze before applying');
    const latest=await this.#record(record.runId);
    if(latest.phase!==record.phase||latest.planRevision!==record.planRevision||worldBuildFingerprint(latest.plan)!==worldBuildFingerprint(record.plan))throw Error('World build stale review');
    return context;
  }
  async start({sourceIds,chatId,mode='EXTEND'}={}){
    if(!['EXTEND','REORGANIZE'].includes(mode))throw Error('Invalid build mode');
    const runId=`world-build-${Date.now().toString(36)}-${++this.serial}-${globalThis.crypto?.randomUUID?.()??Math.random().toString(36).slice(2)}`;
    const record={runId,planRevision:0,sourceIds:[...new Set(sourceIds??[])],chatId,mode,phase:'ANALYZING',plan:null,outcome:null};
    this.#chat(record);await this.#save(record);
    try{return await this.resume(runId);}catch(error){const latest=await this.#record(runId);if(latest.phase!=='CANCELLED'){latest.phase='ANALYSIS_PAUSED';latest.error=error.message;await this.#save(latest);}return this.read(runId);}
  }
  async read(runId){return this.#view(await this.#record(runId));}
  async resume(runId){
    if(this.executions.has(runId))return this.executions.get(runId);
    const execute=async()=>{
      const record=await this.#record(runId);this.#chat(record);
      if(record.plan||record.phase==='CANCELLED')return this.#view(record);
      const context=await this.context({sourceIds:record.sourceIds,chatId:record.chatId});
      const lifetime=new AbortController();this.cancellations.set(runId,lifetime);
      let output;try{output=await this.analysis(context,{runId,mode:record.mode,signal:lifetime.signal});}finally{this.cancellations.delete(runId);}
      this.#chat(record);const latest=await this.#record(runId);if(latest.phase==='CANCELLED')return this.#view(latest);
      const plan=createWorldBuildPlan({...output,runId,planRevision:1,scope:context.scope,mode:record.mode,worldRevision:context.worldRevision,sourceFence:context.sourceFence,sources:context.sources,identityMatches:output.identityMatches??context.identityMatches,layoutRevision:(await this.layout.read(context.scope))?.revision??0});
      const result=materializeWorldBuildPlan(plan,context);
      previewLayout(plan,result.preview,(await this.layout.read(plan.scope))?.layout);
      return this.#save({...record,planRevision:1,plan,phase:'REVIEW',preview:result.preview,coverage:result.coverage},record.planRevision);
    };
    const pending=execute().finally(()=>this.executions.delete(runId));this.executions.set(runId,pending);return pending;
  }
  async revise(runId,{planRevision,changes}={}){
    const record=await this.#record(runId);this.#chat(record);
    if(!['REVIEW','APPROVED'].includes(record.phase)||record.planRevision!==planRevision)throw Error('World build review revision conflict');
    const context=await this.#fresh(record),allowed=['organization','identityMatches','relationshipProposals','layout','coverage'];
    for(const key of Object.keys(changes??{}))if(!allowed.includes(key))throw Error(`Cannot revise build authority ${key}`);
    const plan=createWorldBuildPlan({...record.plan,...structuredClone(changes),planRevision:planRevision+1,review:null});
    const result=materializeWorldBuildPlan(plan,context);
    previewLayout(plan,result.preview,(await this.layout.read(plan.scope))?.layout);
    return this.#save({...record,planRevision:plan.planRevision,plan,phase:'REVIEW',preview:result.preview,coverage:result.coverage},planRevision);
  }
  async approve(runId,{fingerprint,by}={}){
    const record=await this.#record(runId);await this.#fresh(record);
    if(record.phase!=='REVIEW'||!String(by??'').trim())throw Error('Build approval requires reviewed plan and operator identity');
    if(fingerprint!==worldBuildFingerprint(record.plan))throw Error('Reviewed fingerprint mismatch');
    record.plan.review={approvedFingerprint:fingerprint,by};record.phase='APPROVED';return this.#save(record,record.planRevision);
  }
  async apply(runId){
    if(this.executions.has(runId))return this.executions.get(runId);
    const execute=async()=>{
      const record=await this.#record(runId);this.#chat(record);
      if(record.outcome?.state==='committed')return record.phase==='LAYOUT_PENDING'?this.retryLayout(runId):this.#view(record);
      if(record.phase!=='APPROVED'||record.plan.review?.approvedFingerprint!==worldBuildFingerprint(record.plan))throw Error('World build approval required');
      const recovered=await this.readCommitted?.(record.plan);
      if(recovered?.state==='committed'){record.outcome=recovered;record.phase='LAYOUT_PENDING';await this.#save(record);return this.retryLayout(runId);}
      const context=await this.#fresh(record),materialization=materializeWorldBuildPlan(record.plan,context);
      const checked=validateWorldBuildPlan(record.plan);if(!checked.valid)throw Error(checked.errors.join('; '));
      const outcome=await this.mutation({runId,plan:record.plan,materialization,assertFresh:()=>this.#fresh(record)});
      if(outcome.state!=='committed')throw Error(`World build was not committed: ${outcome.state}`);
      record.outcome=outcome;record.phase='LAYOUT_PENDING';await this.#save(record);
      return this.retryLayout(runId);
    };
    const pending=execute().finally(()=>this.executions.delete(runId));this.executions.set(runId,pending);return pending;
  }
  async retryLayout(runId){
    const record=await this.#record(runId);this.#chat(record);
    if(record.phase==='COMMITTED')return this.#view(record);
    if(record.outcome?.state!=='committed')throw Error('Layout requires committed world');
    try{
      record.layoutOutcome=await this.layout.publish({scope:record.plan.scope,worldRevision:record.outcome.worldRevision,expectedLayoutRevision:record.plan.layoutRevision,plan:record.plan,preview:record.preview});
      record.phase='COMMITTED';record.error=null;
    }catch(error){record.phase='LAYOUT_PENDING';record.error=error.message;}
    return this.#save(record);
  }
  async cancel(runId){const record=await this.#record(runId);if(record.outcome?.state==='committed')throw Error('Committed world cannot be cancelled');record.phase='CANCELLED';const saved=await this.#save(record);this.cancellations.get(runId)?.abort(new DOMException('Builder cancelled','AbortError'));return saved;}
}
