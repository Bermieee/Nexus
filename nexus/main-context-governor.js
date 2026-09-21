import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { getEffectiveSummarizedUpTo } from '../memory/store.js';
import { logEvent } from '../observability/telemetry.js';
import { planMainContextWindow } from './main-context-governor-contract.js';

const epochByChat=new Map();
const ALLOWED_TYPES=new Set(['normal','regenerate','swipe']);
function clampInt(value,min,max,fallback){const n=Math.floor(Number(value));return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;}
function epochKey(context){return String(context?.chatId??context?.chat_id??'');}
function config(){
    const settings=getSettings(),memory=settings.memoryBank||{},cfg=memory.mainContext||{};
    const verbatim=clampInt(memory.verbatimTurns,1,100,10);
    const highWater=Math.max(verbatim+2,clampInt(cfg.maxRawAssistantTurns,verbatim+2,200,18));
    return {settings,memory,cfg,verbatim,highWater};
}

export function resetMainContextGovernor(reason='reset'){
    const count=epochByChat.size;epochByChat.clear();
    if(count)logEvent('main-context','governor-reset',{reason,count},'debug');
}

export function applyMainContextGovernor(chat,contextSize,_abort,type='normal'){
    try{
        const rows=Array.isArray(chat)?chat:null;if(!rows)return;
        const normalizedType=String(type||'normal').toLowerCase();
        if(!ALLOWED_TYPES.has(normalizedType))return;
        const {settings,memory,cfg,verbatim,highWater}=config();
        if(settings.enabled!==true||memory.enabled!==true||cfg.enabled===false)return;
        const context=getContext(),chatId=epochKey(context);if(!chatId)return;
        const summarizedUpTo=getEffectiveSummarizedUpTo(),previous=epochByChat.get(chatId)||null;
        const plan=planMainContextWindow({chat:rows,summarizedUpTo,previous,verbatimTurns:verbatim,maxRawAssistantTurns:highWater});
        if(!plan.active){
            if(plan.reason==='summary-coverage-regressed')epochByChat.delete(chatId);
            logEvent('main-context','governor-bypassed',{type:normalizedType,chatId,reason:plan.reason,chatMessages:rows.length,assistantTurns:plan.assistantTurns??0,summarizedUpTo,contextSize:Number(contextSize)||null},plan.reason==='summary-coverage-regressed'?'warn':'debug');
            return;
        }
        const before=rows.length,start=plan.startIndex,preserve=new Set(plan.preservedOldIndices||[]),next=[],removed=[];
        for(let i=0;i<rows.length;i++){if(i>=start||preserve.has(i))next.push(rows[i]);else removed.push(rows[i]);}
        const removedChars=removed.reduce((sum,row)=>sum+String(row?.mes??'').length,0),retainedChars=next.reduce((sum,row)=>sum+String(row?.mes??'').length,0);
        rows.splice(0,rows.length,...next);
        epochByChat.set(chatId,{startIndex:start,assistantTurns:plan.assistantTurns,updatedAt:Date.now()});
        logEvent('main-context',plan.rolled?'cache-epoch-rolled':plan.initialized?'cache-epoch-initialized':'cache-epoch-reused',{
            type:normalizedType,chatId,contextSize:Number(contextSize)||null,beforeMessages:before,afterMessages:rows.length,removedMessages:before-rows.length,
            startIndex:start,summarizedUpTo,assistantTurns:plan.assistantTurns,rawAssistantTurns:plan.rawAssistantTurns,rawAssistantTurnsBeforeRoll:plan.rawAssistantTurnsBeforeRoll??plan.rawAssistantTurns,verbatimTurns:plan.verbatimTurns,maxRawAssistantTurns:plan.maxRawAssistantTurns,
            removedChars,retainedChars,epochHeadroomAssistantTurns:Math.max(0,(plan.maxRawAssistantTurns||0)-(plan.rawAssistantTurns||0)),
            preservedOldMessages:preserve.size,cacheStable:plan.initialized!==true&&plan.rolled!==true,
        },'info');
    }catch(error){
        logEvent('main-context','governor-failed',{type:String(type||''),error:error?.message||String(error)},'error');
    }
}

export function installMainContextGovernor(){globalThis.Nexus_interceptGeneration=applyMainContextGovernor;return true;}
