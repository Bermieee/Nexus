import {createWorldBuildPlan,worldBuildFingerprint,validateWorldBuildPlan} from './world-plan.js';
import {materializeWorldBuildPlan} from './world-materializer.js';
import {planWorldTreeLayout} from '../world-tree/layout.js';

function previewLayout(plan,preview,previousLayout){
  const parents=new Map(preview.edges.filter(e=>e.data?.primaryPlacement).map(e=>[e.to,e.from]));
  plan.layout.proposed=planWorldTreeLayout({nodes:preview.nodes.map(n=>({...n,parentId:parents.get(n.id)??n.parentId})),previousLayout,
    pins:plan.layout.pins,seed:plan.layout.seed,mode:plan.mode});
}

export class WorldTreeBuilderController {
  constructor({context,store,analysis,mutation,layout,currentChatId,readCommitted=null,recoverUnapplied=null,prepareRestart=null}={}){
    if(!context||!store||!analysis||!mutation||!layout)throw new TypeError('World Tree Builder requires its owner adapters');
    Object.assign(this,{context,store,analysis,mutation,layout,currentChatId,readCommitted,recoverUnapplied,prepareRestart});this.executions=new Map();this.cancellations=new Map();this.serial=0;
  }
  async #save(record,expectedRevision=null){
    const expectedRecordRevision=record.recordRevision;
    record.recordRevision=(record.recordRevision??0)+1;
    if(record.preview)record.preview={...record.preview,nodes:record.preview.nodes.map(n=>({...n,data:{label:n.data?.label??n.label??n.id,book:n.data?.book,uid:n.data?.uid}}))};
    if(expectedRecordRevision!=null&&this.store.writeIfRevision){if(!await this.store.writeIfRevision(record,expectedRecordRevision))throw Error('World build review revision conflict');}
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
    if(latest.phase!==record.phase||latest.recordRevision!==record.recordRevision||latest.planRevision!==record.planRevision||worldBuildFingerprint(latest.plan)!==worldBuildFingerprint(record.plan))throw Error('World build stale review');
    return context;
  }
  async start({sourceIds,chatId,mode='EXTEND',replaces=null,binding=null,afterStarted=null}={}){
    if(!['EXTEND','REORGANIZE'].includes(mode))throw Error('Invalid build mode');
    const runId=`world-build-${Date.now().toString(36)}-${++this.serial}-${globalThis.crypto?.randomUUID?.()??Math.random().toString(36).slice(2)}`;
    const record={runId,planRevision:0,analysisRevision:0,sourceIds:[...new Set(sourceIds??[])],chatId,mode,phase:'ANALYZING',plan:null,outcome:null,...(replaces?{replaces,binding}: {})};
    this.#chat(record);await this.#save(record);
    if(afterStarted)await afterStarted(record);
    try{return await this.resume(runId);}catch(error){const latest=await this.#record(runId);if(latest.phase!=='CANCELLED'){latest.phase='ANALYSIS_PAUSED';latest.error=error.message;await this.#save(latest);}return this.read(runId);}
  }
  async read(runId){return this.#view(await this.#record(runId));}
  async list(){const rows=await this.store.list?.()??[];return rows.filter(r=>String(r.chatId)===String(this.currentChatId?.()??r.chatId)&&!['COMMITTED','CANCELLED','SUPERSEDED'].includes(r.phase)&&(!r.replaces||rows.some(old=>old.runId===r.replaces&&old.phase==='SUPERSEDED'&&old.replacementRunId===r.runId))).map(r=>this.#view(r));}
  async restart(runId,{sourceIds,mode=null}={}){
    if(this.executions.has(runId))throw Error('Builder is still running; wait for it to finish before restarting');
    const record=await this.#record(runId);this.#chat(record);
    if(record.phase==='SUPERSEDED'&&record.replacementRunId)return this.read(record.replacementRunId);
    if(record.phase!=='COMMITTING'||record.outcome?.state==='committed')throw Error('Builder restart requires an interrupted publication');
    if(!sourceIds?.length)throw Error('Builder restart requires current Lore sources');
    const assertCurrent=async()=>{this.#chat(record);const current=await this.context({sourceIds,chatId:record.chatId});if(JSON.stringify(current.binding)!==JSON.stringify(record.plan.binding))throw Error('Builder restart binding changed');};
    const ready=await this.prepareRestart?.({plan:record.plan,assertCurrent});
    if(ready?.state!=='restartable')throw Error('Builder restart owner unavailable');
    return this.start({sourceIds,chatId:record.chatId,mode:mode??record.mode,replaces:runId,binding:record.plan.binding,afterStarted:async fresh=>{
      await assertCurrent();record.phase='SUPERSEDED';record.replacementRunId=fresh.runId;await this.#save(record);
    }});
  }
  async resume(runId,{review=null}={}){
    if(this.executions.has(runId))return this.executions.get(runId);
    const execute=async()=>{
      const record=await this.#record(runId);this.#chat(record);
      if(['CANCELLED','SUPERSEDED'].includes(record.phase)||record.outcome?.state==='committed')return this.#view(record);
      const context=await this.context({sourceIds:record.sourceIds,chatId:record.chatId});
      if(review&&(record.phase!=='PLACEMENT_REVIEW'||record.reviewAuthority?.sourceFence!==context.sourceFence||record.reviewAuthority?.worldRevision!==context.worldRevision))throw Error('Placement review is stale; refresh analysis before continuing');
      if(record.plan&&context.worldRevision===record.plan.worldRevision&&context.sourceFence===record.plan.sourceFence)return this.#view(record);
      const reviewed=record.plan;
      const priorAuthority=record.analysisAuthority??record.reviewAuthority??(record.plan?{sourceFence:record.plan.sourceFence,worldRevision:record.plan.worldRevision}:null);
      // Older paused records never captured analysis authority. Start a fresh
      // semantic revision rather than reopening a possibly stale saved run.
      record.analysisRevision??=record.plan?(record.planRevision??0)+1:2;
      if(record.analysisRevision===0)record.analysisRevision=1;
      if(priorAuthority&&(priorAuthority.sourceFence!==context.sourceFence||priorAuthority.worldRevision!==context.worldRevision))record.analysisRevision++;
      record.analysisAuthority={sourceFence:context.sourceFence,worldRevision:context.worldRevision};
      record.binding=context.binding;
      await this.#save(record);
      const lifetime=new AbortController();this.cancellations.set(runId,lifetime);
      let output;try{output=await this.analysis(context,{runId,analysisRevision:record.analysisRevision,mode:record.mode,signal:lifetime.signal,review});}finally{this.cancellations.delete(runId);}
      this.#chat(record);const latest=await this.#record(runId);if(latest.phase==='CANCELLED')return this.#view(latest);
      if(latest.recordRevision!==record.recordRevision)throw Error('World build review changed during analysis');
      const liveContext=await this.context({sourceIds:record.sourceIds,chatId:record.chatId});
      if(liveContext.sourceFence!==context.sourceFence||liveContext.worldRevision!==context.worldRevision)throw Error('World build authority changed during analysis');
      if(output.semanticReview)return this.#save({...record,binding:context.binding,phase:'PLACEMENT_REVIEW',error:null,semanticReview:output.semanticReview,reviewAuthority:{sourceFence:context.sourceFence,worldRevision:context.worldRevision},preview:null});
      if(reviewed){
        const labels=new Map(reviewed.organization.groups.map(g=>[g.id,g.label]));output.organization.groups=output.organization.groups.map(g=>({...g,label:labels.get(g.id)??g.label}));output.layout={...output.layout,pins:reviewed.layout.pins};
        const unchanged=new Set(context.sources.filter(s=>reviewed.sources.some(old=>old.sourceId===s.sourceId&&old.fingerprint===s.fingerprint)).map(s=>s.sourceId));
        const parents=new Set([...context.nodes.map(n=>n.id),...output.organization.groups.map(g=>g.id)]);
        for(const old of reviewed.coverage.filter(c=>unchanged.has(c.sourceId))){
          const placement=reviewed.organization.placements.find(p=>p.sourceId===old.sourceId);
          if(old.disposition==='PLACED'&&(!placement||!parents.has(placement.parentId)))continue;
          output.organization.placements=output.organization.placements.filter(p=>p.sourceId!==old.sourceId);
          if(placement&&old.disposition==='PLACED')output.organization.placements.push(placement);
          output.coverage=output.coverage.map(c=>c.sourceId===old.sourceId?old:c);
        }
      }
      const plan=createWorldBuildPlan({...output,runId,planRevision:(record.planRevision??0)+1,review:null,scope:context.scope,binding:context.binding,mode:record.mode,worldRevision:context.worldRevision,sourceFence:context.sourceFence,sources:context.sources,identityMatches:output.identityMatches??context.identityMatches,layoutRevision:(await this.layout.read(context.scope))?.revision??0});
      const result=materializeWorldBuildPlan(plan,context);
      previewLayout(plan,result.preview,(await this.layout.read(plan.scope))?.layout);
      return this.#save({...record,planRevision:plan.planRevision,plan,phase:'REVIEW',error:null,semanticReview:null,reviewAuthority:null,preview:result.preview,coverage:result.coverage},record.planRevision);
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
    const record=await this.#record(runId);
    if(record.phase==='LAYOUT_REVIEW')this.#chat(record);else await this.#fresh(record);
    if(!['REVIEW','LAYOUT_REVIEW'].includes(record.phase)||!String(by??'').trim())throw Error('Build approval requires reviewed plan and operator identity');
    if(fingerprint!==worldBuildFingerprint(record.plan))throw Error('Reviewed fingerprint mismatch');
    record.plan.review={approvedFingerprint:fingerprint,by};record.phase=record.outcome?.state==='committed'?'LAYOUT_PENDING':'APPROVED';return this.#save(record,record.planRevision);
  }
  async apply(runId){
    if(this.executions.has(runId))return this.executions.get(runId);
    const execute=async()=>{
      const record=await this.#record(runId);this.#chat(record);
      if(record.outcome?.state==='committed')return record.phase==='LAYOUT_PENDING'?this.retryLayout(runId):this.#view(record);
      if(!['APPROVED','COMMITTING'].includes(record.phase)||record.plan.review?.approvedFingerprint!==worldBuildFingerprint(record.plan))throw Error('World build approval required');
      const recovered=await this.readCommitted?.(record.plan);
      if(recovered?.state==='committed'){record.outcome=recovered;record.phase='LAYOUT_PENDING';await this.#save(record);return this.retryLayout(runId);}
      if(record.phase==='COMMITTING'){
        const recovery=await this.recoverUnapplied?.({plan:record.plan,assertFresh:()=>this.#fresh(record)});
        if(recovery?.state!=='not-applied')throw Error('Commit recovery is pending; reconcile the durable transaction before retrying');
        record.phase='APPROVED';record.error=null;record.commitRecovery=recovery;await this.#save(record);
      }
      const context=await this.#fresh(record),materialization=materializeWorldBuildPlan(record.plan,context);
      const checked=validateWorldBuildPlan(record.plan);if(!checked.valid)throw Error(checked.errors.join('; '));
      record.phase='COMMITTING';await this.#save(record);
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
    if(record.phase==='LAYOUT_REVIEW')throw Error('Review and approve the refreshed layout first');
    try{
      record.layoutOutcome=await this.layout.publish({scope:record.plan.scope,organizationFingerprint:record.organizationFingerprint??record.plan.review?.approvedFingerprint,worldRevision:record.outcome.worldRevision,expectedLayoutRevision:record.plan.layoutRevision,plan:record.plan,preview:record.preview});
      record.phase='COMMITTED';record.error=null;
    }catch(error){record.phase='LAYOUT_PENDING';record.error=error.message;}
    return this.#save(record);
  }
  async reviewLayout(runId){
    const record=await this.#record(runId);this.#chat(record);
    if(record.outcome?.state!=='committed')throw Error('Layout review requires committed organization');
    const context=await this.context({sourceIds:record.sourceIds,chatId:record.chatId});
    const current=await this.layout.read(record.plan.scope);
    record.organizationFingerprint??=record.plan.review?.approvedFingerprint;
    record.plan.layoutRevision=current.revision;record.plan.planRevision=++record.planRevision;
    previewLayout(record.plan,{nodes:context.nodes,edges:context.relationships},current.layout);
    record.plan.review=null;record.phase='LAYOUT_REVIEW';record.error=null;
    record.preview={nodes:context.nodes,edges:context.relationships,staged:true};
    return this.#save(record);
  }
  async cancel(runId){const record=await this.#record(runId);this.#chat(record);if(record.outcome?.state==='committed'||record.phase==='COMMITTING')throw Error('Committing or committed world cannot be cancelled');record.phase='CANCELLED';const saved=await this.#save(record);this.cancellations.get(runId)?.abort(new DOMException('Builder cancelled','AbortError'));return saved;}
}
