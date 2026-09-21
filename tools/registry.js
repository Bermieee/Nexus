import { ToolManager } from '../../../../tool-calling.js';
import { getSettings } from '../core/settings.js';
import { getDefinition as search, TOOL_NAME as SEARCH } from './search.js';
import { getDefinition as remember, TOOL_NAME as REMEMBER } from './remember.js';
import { getDefinition as update, TOOL_NAME as UPDATE } from './update.js';
import { getDefinition as del, TOOL_NAME as DELETE } from './delete.js';
import { getDefinition as merge, TOOL_NAME as MERGE } from './merge.js';
import { getDefinition as split, TOOL_NAME as SPLIT } from './split.js';
import { getDefinition as organize, TOOL_NAME as ORGANIZE } from './organize.js';
import { logEvent } from '../observability/telemetry.js';
import { estimateContentTokens } from '../observability/token-estimator.js';
import { createToolGatewayDefinition, NEXUS_TOOL_GATEWAY_NAME, clearActiveNexusToolGateway } from '../nexus/tool-gateway.js';
import { summarizeUid } from '../lore/uid-summarizer.js';
import { createNexusToolMutationAdapters } from './nexus-mutation-adapters.js';
import { getLorebookBuilderController } from '../builder/runtime.js';
import { currentNexusForegroundGenerationId } from '../nexus/work-scope.js';

const SUMMARIZE='TV2_Summarize';
let hostToolAuthorityGeneration=1;
const NAMES=[SEARCH,REMEMBER,UPDATE,DELETE,MERGE,SPLIT,ORGANIZE,SUMMARIZE,NEXUS_TOOL_GATEWAY_NAME];

function summarizeDefinition(){
    return {
        name:SUMMARIZE,
        displayName:'Nexus Summarize UID',
        description:'Stage one or more summary drafts for an existing lorebook UID. The result remains review-gated in UID Summarizer.',
        parameters:{type:'object',properties:{lorebook:{type:'string'},uid:{type:'integer'},detail:{type:'string',enum:['compact','balanced','detailed']},token_cap:{type:'integer'},draft_count:{type:'integer'},include_keywords:{type:'boolean'}},required:['lorebook','uid']},
        action:async args=>{const out=await summarizeUid({book:args?.lorebook,uid:args?.uid,detail:args?.detail||'balanced',targetTokens:args?.token_cap||args?.target_tokens||320,draftCount:args?.draft_count||1,includeKeywords:args?.include_keywords!==false});return `Nexus staged ${out.options?.length||0} UID summary draft(s) for ${out.book} #${out.uid}. Open UID Summarizer to approve, edit, or reject.`;}
    };
}

function instrumentDefinition(def){
    const original=def.action;
    const authorityGeneration=hostToolAuthorityGeneration;
    if(typeof original!=='function')return def;
    def.action=async args=>{
        if(authorityGeneration!==hostToolAuthorityGeneration){const error=new Error(`Nexus host tool ${def.name} belongs to a revoked registration generation.`);error.name='TV2HostToolAuthorityRevoked';throw error;}
        const started=globalThis.performance?.now?.()??Date.now();
        const serialized=JSON.stringify(args||{});
        const estimatedArgumentTokens=estimateContentTokens(serialized);
        logEvent('tools','invocation-start',{name:def.name,args,estimatedArgumentTokens},'info');
        try{
            const result=await original(args);
            const elapsed=(globalThis.performance?.now?.()??Date.now())-started;
            const estimatedResultTokens=estimateContentTokens(String(result??''));
            logEvent('tools','invocation-success',{name:def.name,args,estimatedArgumentTokens,result,estimatedResultTokens,latencyMs:elapsed},'info');
            return result;
        }catch(err){
            const elapsed=(globalThis.performance?.now?.()??Date.now())-started;
            logEvent('tools','invocation-failure',{name:def.name,args,estimatedArgumentTokens,error:err,latencyMs:elapsed},'error');
            throw err;
        }
    };
    return def;
}

export function unregisterTools({preserveGatewayState=false,throwOnFailure=true}={}){
    hostToolAuthorityGeneration+=1;
    clearActiveNexusToolGateway({preserveContinuity:preserveGatewayState});
    const failures=[];
    for(const name of NAMES){
        try{ToolManager.unregisterFunctionTool(name);logEvent('tools','unregistered',{name},'debug');}
        catch(error){failures.push({name,error});logEvent('tools','unregistration-failed',{name,error},'error');}
    }
    if(failures.length&&throwOnFailure){
        const error=new AggregateError(failures.map(row=>row.error),`Nexus could not unregister ${failures.length} host tool registration(s): ${failures.map(row=>row.name).join(', ')}`);
        error.name='TV2ToolUnregistrationFailed';error.failures=failures;
        throw error;
    }
    return {removed:NAMES.length-failures.length,failures};
}
export function registerTools(){
    // Reconfiguration is transactional. Old gateway authority is revoked before
    // host registration changes, and a host cleanup failure aborts publication
    // instead of allowing a stale callable entry point to be treated as ready.
    unregisterTools({preserveGatewayState:true,throwOnFailure:true});
    const settings=getSettings();
    if(!settings.enabled){logEvent('tools','registration-skipped',{reason:'runtime-disabled'},'debug');return 0;}
    const legacy=[search(),remember(),update(),del(),merge(),split(),organize(),summarizeDefinition()];
    const services=Object.fromEntries(legacy.map(def=>[String(def.name||'').replace(/^TV2_/,'').toLowerCase(),def]));
    const mutationAdapters=createNexusToolMutationAdapters();
    for(const [name,adapter] of Object.entries(mutationAdapters)){if(services[name])services[name].nexusMutation=adapter;}
    // UID summarization already has its own interactive Ledger/review surface.
    // Until it gets a dedicated boundary adapter, do not wrap that flow in a
    // second generic Function Gateway mutation transaction.
    services.summarize=summarizeDefinition();
    // Lorebook Builder is a proposal-staging capability. Main may request it
    // through Function Gateway / Call Center, but the handler cannot approve or
    // commit its own Tree transaction.
    services['build-tree']={name:'Nexus_BuildTree',action:async args=>{
        const book=String(args?.lorebook||args?.book||'').trim();if(!book)throw new Error('Lorebook Builder requires lorebook/book.');
        const semanticResource=String(args?.semantic_resource||args?.semanticResource||'auto').trim().toLowerCase();
        const requestedMode=String(args?.requested_mode||args?.requestedMode||args?.mode||'auto').trim().toLowerCase();
        const validateOnly=args?.validate_only===true||args?.validateOnly===true;
        const foregroundGenerationId=currentNexusForegroundGenerationId();
        const out=await getLorebookBuilderController().start({book,source:'main-function-gateway',requestedMode,validateOnly,metadata:{semanticResource,automatic:true,foregroundDependency:true,foregroundAdjacent:true,foregroundGenerationId}});
        return {engine:out.engine||'legacy',runId:out.runId||null,transactionId:out.transactionId||null,mode:out.mode,validateOnly:out.validateOnly===true,state:out.state,book:out.book,reviewKind:out.reviewKind||null,requiresOperatorReview:out.engine==='builder2'&&out.state==='review',preview:{unchangedCount:Number(out.preview?.unchangedCount)||0,addedCount:out.preview?.added?.length||0,newNodeCount:out.preview?.newNodes?.length||0,conflictCount:out.preview?.conflicts?.length||0}};
    }};
    const gatewayEnabled=settings.nexus?.callCenter?.enabled===true&&settings.nexus?.callCenter?.mainModelAccess===true;
    const definitions=gatewayEnabled?[createToolGatewayDefinition(services)] : [search()];
    const registered=[];
    try{
        for(const raw of definitions){
            const def=instrumentDefinition(raw);
            ToolManager.registerFunctionTool(def);registered.push(def.name);logEvent('tools','registered',{name:def.name},'debug');
        }
    }catch(error){
        // Revoke every definition from this attempted generation before host
        // rollback. Even if SillyTavern refuses an unregister, the stale action
        // fails closed rather than retaining Nexus mutation authority.
        hostToolAuthorityGeneration+=1;
        logEvent('tools','registration-failed',{registered:[...registered],error},'error');
        console.error('[Nexus] Tool registration failed; unwinding partial host authority:',error);
        const rollbackFailures=[];
        for(const name of [...registered].reverse()){
            try{ToolManager.unregisterFunctionTool(name);logEvent('tools','registration-rollback-unregistered',{name},'warn');}
            catch(rollbackError){rollbackFailures.push({name,error:rollbackError});logEvent('tools','registration-rollback-failed',{name,error:rollbackError},'error');}
        }
        clearActiveNexusToolGateway();
        const wrapped=new AggregateError([error,...rollbackFailures.map(row=>row.error)],`Nexus tool registration failed${rollbackFailures.length?` and ${rollbackFailures.length} rollback unregister(s) also failed`:''}.`);
        wrapped.name='TV2ToolRegistrationFailed';wrapped.cause=error;wrapped.rollbackFailures=rollbackFailures;
        throw wrapped;
    }
    const count=registered.length;
    logEvent('tools','registration-complete',{count,names:definitions.map(def=>def.name),gatewayEnabled},'info');
    console.log(`[Nexus] Registered ${count} ${gatewayEnabled?'Function Gateway':'legacy'} tool${count===1?'':'s'}`);return count;
}
