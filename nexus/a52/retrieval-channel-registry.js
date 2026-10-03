import {
  RETRIEVAL_CHANNEL_CONTRACT_VERSION,RetrievalChannelHealth,
  CandidateBusContractError,createRetrievalChannelDescriptor,compatibleContractVersion,
} from './candidate-bus-contracts.js';

const clone=(v)=>v==null?v:structuredClone(v);
const uniq=(xs)=>[...new Set((xs??[]).filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()))].sort();
function freezeDeep(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const x of Object.values(v))freezeDeep(x);Object.freeze(v);}return v;}
const frozen=(v)=>freezeDeep(clone(v));
const now=()=>globalThis.performance?.now?.()??Date.now();
const latencyBudget=(context)=>Number.isFinite(Number(context?.latencyBudgetMs))?Math.max(0,Number(context.latencyBudgetMs)):null;

export class RetrievalChannelRegistry{
  #channels=new Map();

  register(provider){
    if(!provider||typeof provider!=='object')throw new CandidateBusContractError('CHANNEL_PROVIDER_INVALID','retrieval channel provider must be an object');
    if(typeof provider.retrieve!=='function')throw new CandidateBusContractError('CHANNEL_PROVIDER_INVALID','retrieval channel provider requires retrieve(intent, context)');
    const descriptor=createRetrievalChannelDescriptor(provider.descriptor??provider);
    if(!compatibleContractVersion(descriptor.channelVersion,RETRIEVAL_CHANNEL_CONTRACT_VERSION))
      throw new CandidateBusContractError('CHANNEL_VERSION_INCOMPATIBLE','retrieval channel version is not compatible');
    if(this.#channels.has(descriptor.channelId))throw new CandidateBusContractError('CHANNEL_ALREADY_REGISTERED','retrieval channel already registered: '+descriptor.channelId);
    this.#channels.set(descriptor.channelId,{
      descriptor,provider,
      health:descriptor.health,available:descriptor.available,
      currentIndexRevision:provider.currentIndexRevision??null,
      stale:false,lastError:null,registrations:1,retrievals:0,failures:0,
    });
    return this.lookup(descriptor.channelId);
  }

  unregister(channelId){const id=String(channelId);const row=this.#channels.get(id);if(!row)return null;this.#channels.delete(id);return frozen({channelId:id,unregistered:true,descriptor:row.descriptor});}

  lookup(channelId){
    const row=this.#channels.get(String(channelId));if(!row)return null;
    return frozen({...row,provider:undefined});
  }

  provider(channelId){return this.#channels.get(String(channelId))?.provider??null;}

  setHealth(channelId,{health,available=null,currentIndexRevision=undefined,stale=null,reason=null}={}){
    const row=this.#channels.get(String(channelId));if(!row)throw new CandidateBusContractError('CHANNEL_UNKNOWN','unknown retrieval channel: '+channelId);
    if(!Object.values(RetrievalChannelHealth).includes(health))throw new CandidateBusContractError('CHANNEL_HEALTH_INVALID','unsupported channel health: '+health);
    row.health=health;if(available!=null)row.available=Boolean(available);if(currentIndexRevision!==undefined)row.currentIndexRevision=currentIndexRevision;
    if(stale!=null)row.stale=Boolean(stale);row.lastError=reason==null?null:String(reason);
    return this.lookup(channelId);
  }

  list({capability=null,intentKind=null,availableOnly=false}={}){
    const rows=[];
    for(const [id,row] of this.#channels){
      if(capability&&!row.descriptor.capabilities.includes(capability))continue;
      if(intentKind&&!this.supportsIntent(row.descriptor,intentKind))continue;
      if(availableOnly&&(!row.available||[RetrievalChannelHealth.UNAVAILABLE,RetrievalChannelHealth.ERROR].includes(row.health)))continue;
      rows.push({...row,provider:undefined,channelId:id});
    }
    return frozen(rows.sort((a,b)=>a.descriptor.channelId.localeCompare(b.descriptor.channelId)));
  }

  supportsIntent(descriptorOrId,intentKind){
    const descriptor=typeof descriptorOrId==='string'?this.#channels.get(descriptorOrId)?.descriptor:descriptorOrId;
    if(!descriptor)return false;const kinds=descriptor.supportedIntentKinds??[];
    return kinds.includes('*')||kinds.includes('GENERAL')||kinds.includes(String(intentKind));
  }

  discover({intentKind=null,capabilities=[]}={}){
    const required=uniq(capabilities);
    return this.list({intentKind}).filter(row=>required.every(cap=>row.descriptor.capabilities.includes(cap)));
  }

  async retrieveAll({intents=[],context={},channelIds=null}={}){
    const rows=channelIds?uniq(channelIds).map(id=>this.#channels.get(id)).filter(Boolean):[...this.#channels.values()];
    const nominations=[],deferredNominations=[],unavailableChannels=[],degradedChannels=[],errors=[],channelReceipts=[],skippedChannels=[],completedChannels=[...(context.continuation?.completedChannels??[])],providerContinuations={...(context.continuation?.providers??{})};
    const started=now(),budget=latencyBudget(context);
    for(const row of rows.sort((a,b)=>a.descriptor.channelId.localeCompare(b.descriptor.channelId))){
      if(completedChannels.includes(row.descriptor.channelId))continue;
      if(budget!==null&&now()-started>=budget){const id=row.descriptor.channelId;skippedChannels.push(id);degradedChannels.push(id);channelReceipts.push({channelId:id,status:'SKIPPED_LATENCY_BUDGET',nominationCount:0,health:row.health,elapsedMs:0,attemptedIntents:0,failedIntents:0});continue;}
      const id=row.descriptor.channelId;
      if(!row.available||[RetrievalChannelHealth.UNAVAILABLE,RetrievalChannelHealth.ERROR].includes(row.health)){
        unavailableChannels.push(id);channelReceipts.push({channelId:id,status:'UNAVAILABLE',nominationCount:0,reason:row.descriptor.metadata?.unavailableReason??row.lastError??'CHANNEL_UNAVAILABLE',fallbackChannelIds:uniq(row.descriptor.metadata?.fallbackChannelIds??[]),capabilities:[...(row.descriptor.capabilities??[])],elapsedMs:0,attemptedIntents:0,failedIntents:0});continue;
      }
      if([RetrievalChannelHealth.DEGRADED,RetrievalChannelHealth.STALE].includes(row.health))degradedChannels.push(id);
      let count=0,total=0,deferred=0,providerCoverages=[],status='OK',attemptedIntents=0,failedIntents=0;const channelStarted=now();
      for(const intent of intents){
        if(budget!==null&&now()-started>=budget){
          skippedChannels.push(id);degradedChannels.push(id);
          status=count>0?'PARTIAL_LATENCY_BUDGET':'SKIPPED_LATENCY_BUDGET';
          break;
        }
        if(!this.supportsIntent(row.descriptor,intent.intentKind??intent.kind??'GENERAL'))continue;
        attemptedIntents+=1;
        try{
          const value=await row.provider.retrieve(frozen(intent),frozen({...context,channelContinuation:context.continuation?.providers?.[id]??null}));
          const result=Array.isArray(value)?value:value?.nominations??[];
          if(!Array.isArray(result))throw new CandidateBusContractError('CHANNEL_OUTPUT_INVALID','channel '+id+' did not return nomination array');
          const grant=Number.isFinite(Number(context.channelCandidateLimits?.[id]??context.candidateLimit))?Math.max(0,Math.min(8192,Math.floor(Number(context.channelCandidateLimits?.[id]??context.candidateLimit)))):row.descriptor.maxCandidates;
          const limited=result.slice(0,grant);
          total+=Math.max(result.length,Number(value?.coverage?.total??result.length));deferred+=result.length-limited.length+Math.max(0,Number(value?.coverage?.deferred??0));if(value?.coverage)providerCoverages.push(clone(value.coverage));deferredNominations.push(...result.slice(limited.length));
          if(result.length>limited.length){status='PARTIAL_CANDIDATE_BUDGET';degradedChannels.push(id);}
          if(value?.coverage?.complete===false){status='PARTIAL_PROVIDER_COVERAGE';degradedChannels.push(id);providerContinuations[id]=clone(value.continuation);}else delete providerContinuations[id];
          nominations.push(...limited);count+=limited.length;row.retrievals+=1;
        }catch(error){
          row.failures+=1;failedIntents+=1;row.lastError=String(error?.message??error);status='ERROR';degradedChannels.push(id);
          errors.push({channelId:id,intentId:intent.intentId??null,code:error?.code??'CHANNEL_RETRIEVAL_FAILED',message:String(error?.message??error)});
        }
      }
      if(attemptedIntents===intents.length&&!failedIntents&&status!=='PARTIAL_PROVIDER_COVERAGE')completedChannels.push(id);
      channelReceipts.push({channelId:id,status,nominationCount:count,total,deferred,providerCoverages,coverage:{complete:status==='OK',examined:count,total,deferred},continuation:deferred?{channelId:id,deferred}:null,health:row.health,elapsedMs:Math.max(0,now()-channelStarted),attemptedIntents,failedIntents});
    }
    const elapsedMs=Math.max(0,now()-started);
    return frozen({nominations,deferredNominations,continuation:{completedChannels:uniq(completedChannels),providers:providerContinuations},unavailableChannels:uniq(unavailableChannels),degradedChannels:uniq(degradedChannels),errors,channelReceipts,budgetReceipt:{kind:'RetrievalLatencyBudgetReceipt',latencyBudgetMs:budget,elapsedMs,skippedChannels:uniq(skippedChannels),budgetExceeded:budget!==null&&elapsedMs>=budget}});
  }

  retrieveAllSync({intents=[],context={},channelIds=null}={}){
    const rows=channelIds?uniq(channelIds).map(id=>this.#channels.get(id)).filter(Boolean):[...this.#channels.values()];
    const nominations=[],deferredNominations=[],unavailableChannels=[],degradedChannels=[],errors=[],channelReceipts=[],skippedChannels=[],completedChannels=[...(context.continuation?.completedChannels??[])],providerContinuations={...(context.continuation?.providers??{})};
    const started=now(),budget=latencyBudget(context);
    for(const row of rows.sort((a,b)=>a.descriptor.channelId.localeCompare(b.descriptor.channelId))){
      if(completedChannels.includes(row.descriptor.channelId))continue;
      if(budget!==null&&now()-started>=budget){const id=row.descriptor.channelId;skippedChannels.push(id);degradedChannels.push(id);channelReceipts.push({channelId:id,status:'SKIPPED_LATENCY_BUDGET',nominationCount:0,health:row.health,elapsedMs:0,attemptedIntents:0,failedIntents:0});continue;}
      const id=row.descriptor.channelId;
      if(!row.available||[RetrievalChannelHealth.UNAVAILABLE,RetrievalChannelHealth.ERROR].includes(row.health)){
        unavailableChannels.push(id);channelReceipts.push({channelId:id,status:'UNAVAILABLE',nominationCount:0,reason:row.descriptor.metadata?.unavailableReason??row.lastError??'CHANNEL_UNAVAILABLE',fallbackChannelIds:uniq(row.descriptor.metadata?.fallbackChannelIds??[]),capabilities:[...(row.descriptor.capabilities??[])],elapsedMs:0,attemptedIntents:0,failedIntents:0});continue;
      }
      if([RetrievalChannelHealth.DEGRADED,RetrievalChannelHealth.STALE].includes(row.health))degradedChannels.push(id);
      let count=0,total=0,deferred=0,providerCoverages=[],status='OK',attemptedIntents=0,failedIntents=0;const channelStarted=now();
      for(const intent of intents){
        if(budget!==null&&now()-started>=budget){
          skippedChannels.push(id);degradedChannels.push(id);
          status=count>0?'PARTIAL_LATENCY_BUDGET':'SKIPPED_LATENCY_BUDGET';
          break;
        }
        if(!this.supportsIntent(row.descriptor,intent.intentKind??intent.kind??'GENERAL'))continue;
        attemptedIntents+=1;
        try{
          const value=row.provider.retrieve(frozen(intent),frozen({...context,channelContinuation:context.continuation?.providers?.[id]??null}));
          if(value&&typeof value.then==='function')throw new CandidateBusContractError('CHANNEL_ASYNC_IN_SYNC_PATH','channel '+id+' returned a Promise on sync retrieval path');
          const result=Array.isArray(value)?value:value?.nominations??[];
          if(!Array.isArray(result))throw new CandidateBusContractError('CHANNEL_OUTPUT_INVALID','channel '+id+' did not return nomination array');
          const grant=Number.isFinite(Number(context.channelCandidateLimits?.[id]??context.candidateLimit))?Math.max(0,Math.min(8192,Math.floor(Number(context.channelCandidateLimits?.[id]??context.candidateLimit)))):row.descriptor.maxCandidates;
          const limited=result.slice(0,grant);
          total+=Math.max(result.length,Number(value?.coverage?.total??result.length));deferred+=result.length-limited.length+Math.max(0,Number(value?.coverage?.deferred??0));if(value?.coverage)providerCoverages.push(clone(value.coverage));deferredNominations.push(...result.slice(limited.length));
          if(result.length>limited.length){status='PARTIAL_CANDIDATE_BUDGET';degradedChannels.push(id);}
          if(value?.coverage?.complete===false){status='PARTIAL_PROVIDER_COVERAGE';degradedChannels.push(id);providerContinuations[id]=clone(value.continuation);}else delete providerContinuations[id];
          nominations.push(...limited);count+=limited.length;row.retrievals+=1;
        }catch(error){
          row.failures+=1;failedIntents+=1;row.lastError=String(error?.message??error);status='ERROR';degradedChannels.push(id);
          errors.push({channelId:id,intentId:intent.intentId??null,code:error?.code??'CHANNEL_RETRIEVAL_FAILED',message:String(error?.message??error)});
        }
      }
      if(attemptedIntents===intents.length&&!failedIntents&&status!=='PARTIAL_PROVIDER_COVERAGE')completedChannels.push(id);
      channelReceipts.push({channelId:id,status,nominationCount:count,total,deferred,providerCoverages,coverage:{complete:status==='OK',examined:count,total,deferred},continuation:deferred?{channelId:id,deferred}:null,health:row.health,elapsedMs:Math.max(0,now()-channelStarted),attemptedIntents,failedIntents});
    }
    const elapsedMs=Math.max(0,now()-started);
    return frozen({nominations,deferredNominations,continuation:{completedChannels:uniq(completedChannels),providers:providerContinuations},unavailableChannels:uniq(unavailableChannels),degradedChannels:uniq(degradedChannels),errors,channelReceipts,budgetReceipt:{kind:'RetrievalLatencyBudgetReceipt',latencyBudgetMs:budget,elapsedMs,skippedChannels:uniq(skippedChannels),budgetExceeded:budget!==null&&elapsedMs>=budget}});
  }

  manifest(){
    return frozen({
      kind:'SensoryNetChannelManifest',contractVersion:RETRIEVAL_CHANNEL_CONTRACT_VERSION,
      channels:[...this.#channels.values()].map(row=>({
        channelId:row.descriptor.channelId,version:row.descriptor.channelVersion,capabilities:[...row.descriptor.capabilities],
        health:row.health,available:row.available,supportedIntents:[...row.descriptor.supportedIntentKinds],
        maxCandidates:row.descriptor.maxCandidates,currentIndexRevision:row.currentIndexRevision,stale:row.stale,
        retrievals:row.retrievals,failures:row.failures,lastError:row.lastError,metadata:clone(row.descriptor.metadata??{}),
      })).sort((a,b)=>a.channelId.localeCompare(b.channelId)),
      readOnly:true,mutationAuthority:false,
    });
  }
}
