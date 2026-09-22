/**
 * Nexus Generation Frame physical authority.
 *
 * HARD BOUNDARY: this is the only production module allowed to call
 * SillyTavern setExtensionPrompt for Nexus-owned Main context. Subsystems publish
 * only to the host-free generation-frame-bus.js.
 */
import { extension_prompt_types, extension_prompt_roles, setExtensionPrompt } from '../../../../../script.js';
import { getContext } from '../../../../st-context.js';
import { logEvent } from '../observability/telemetry.js';
import { estimateContentTokens, resolveMainModelHint, resolveMainProviderHint } from '../observability/token-estimator.js';
import { currentNexusChatEpoch } from './work-scope.js';
import { promptLoaderAdapterSignature, promptLoaderPresentationsCompatible, resolvePromptLoaderAdapter } from './prompt-loader-adapters.js';
import { NEXUS_GENERATION_OUTLET_STATUS, analyzeGenerationFrameSectionCacheImpact, compareGenerationFrameManifests, compareGenerationFramePrompts, composeGenerationFrame, resetGenerationFrameCompiledSectionCache } from './generation-frame-contract.js';
import {
    activeGenerationFrameId,
    beginGenerationFrameState,
    getGenerationFrameSnapshot,
    markGenerationFrameApplied,
    resetGenerationFrameState,
    retireGenerationFrameState,
    sealGenerationFrameState,
} from './generation-frame-bus.js';

const PROMPT_KEY='nexus_generation_frame_v1';
const LEGACY_PROMPT_KEYS=Object.freeze(['tv2_tree_retrieval','tv2_bootstrap_lore_admission','tv2_memory_bank_recall','tv2_rolling_notebook']);
let lastAppliedManifest=null;
let lastAppliedPrompt=null;
let lastDiagnostics=null;
let lastPromptLoaderAdapterSignature=null;
let lastPromptLoaderAdapter=null;

function clone(value){if(value===undefined)return undefined;try{return typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value));}catch{return null;}}
function physicalClearKey(key){setExtensionPrompt(key,'',extension_prompt_types.IN_CHAT,1,false,extension_prompt_roles.SYSTEM);}
function clearPhysicalPrompt({includeLegacy=false}={}){physicalClearKey(PROMPT_KEY);if(includeLegacy)for(const key of LEGACY_PROMPT_KEYS)physicalClearKey(key);}
function authoritySnapshot(){const context=getContext();return{chatId:context?.chatId??context?.chat_id??null,chatEpoch:currentNexusChatEpoch()};}
function authorityFresh(frame){const live=authoritySnapshot();return!!frame&&String(frame.chatId??'')===String(live.chatId??'')&&Number(frame.chatEpoch)===Number(live.chatEpoch);}

export function resetGenerationFrameAuthority(reason='reset',{clearComparison=true}={}){
    clearPhysicalPrompt({includeLegacy:true});const prior=resetGenerationFrameState();
    if(prior)logEvent('generation-frame','retired',{generationId:prior.generationId,reason,state:prior.state},'debug');
    if(clearComparison){lastAppliedManifest=null;lastAppliedPrompt=null;resetGenerationFrameCompiledSectionCache();}lastDiagnostics={reason,resetAt:Date.now(),active:false};return true;
}

export function beginGenerationFrame({generationId,chatId=null,chatEpoch=null}={}){
    const live=authoritySnapshot();clearPhysicalPrompt({includeLegacy:true});
    const frame=beginGenerationFrameState({generationId,chatId:chatId??live.chatId,chatEpoch:chatEpoch??live.chatEpoch});
    logEvent('generation-frame','opened',{generationId:frame.generationId,chatId:frame.chatId,chatEpoch:frame.chatEpoch,outlets:Object.keys(frame.outlets)},'debug');return frame;
}

export { getGenerationFrameSnapshot } from './generation-frame-bus.js';
export function getGenerationFrameDiagnostics(){return clone(lastDiagnostics);}

export function announcePromptLoaderStartup(){
    const liveContext=getContext();
    const mainModel=String(resolveMainModelHint(liveContext)||'').trim();
    const mainProvider=String(resolveMainProviderHint(liveContext)||'').trim();
    const adapter=resolvePromptLoaderAdapter({model:mainModel,provider:mainProvider});
    const signature=promptLoaderAdapterSignature(adapter);
    if(lastPromptLoaderAdapterSignature===signature)return false;
    const previous=clone(lastPromptLoaderAdapter);
    const changed=lastPromptLoaderAdapterSignature!=null;
    lastPromptLoaderAdapterSignature=signature;
    lastPromptLoaderAdapter=clone(adapter);
    logEvent('prompt-loader','adapter-selected',{
        generationId:null,adapterId:adapter.id,family:adapter.family,model:adapter.model,provider:adapter.provider,
        matchedBy:adapter.matchedBy,layout:adapter.presentation?.layout||null,wrapperStyle:adapter.presentation?.wrapperStyle||null,
        cachePolicy:adapter.presentation?.cachePolicy||null,providerTemplateOwnership:'host',
        adapterFirstSeen:!changed,adapterChanged:changed,announcementReason:'startup',
        previousAdapter:previous?{adapterId:previous.id||null,family:previous.family||null,model:previous.model||null,provider:previous.provider||null}:null,
    },'info');
    logEvent('prompt-loader','frame-active',{
        generationId:null,adapterId:adapter.id,family:adapter.family,model:adapter.model,provider:adapter.provider,
        matchedBy:adapter.matchedBy,layout:adapter.presentation?.layout||null,wrapperStyle:adapter.presentation?.wrapperStyle||null,
        cachePolicy:adapter.presentation?.cachePolicy||null,adapterState:changed?'changed':'initial',adapterChanged:changed,
        previousAdapter:changed&&previous?{adapterId:previous.id||null,family:previous.family||null,model:previous.model||null,provider:previous.provider||null}:null,
        statusOnly:true,announcementReason:'startup',promptTokens:null,stablePrefixTokens:null,stablePrefixRatioPct:null,
        firstChangedSection:null,identicalToPrevious:false,comparisonResetReason:null,loadedSectionCount:0,reusedSectionCount:0,
        loadedSections:[],changedSectionIds:[],unchangedSectionIds:[],outletStatuses:null,failedOutlets:[],
    },'info');
    return true;
}

export function sealAndApplyGenerationFrame({generationId=null,model=null,provider=null}={}){
    const open=getGenerationFrameSnapshot();if(!open)throw new Error('No open Nexus Generation Frame exists.');
    const expected=generationId??open.generationId;if(String(expected)!==String(open.generationId))throw new Error(`Generation Frame seal rejected: expected ${open.generationId}, received ${String(expected)}.`);
    if(!authorityFresh(open)){const error=new Error('Generation Frame seal rejected because chat/epoch authority changed.');error.name='NexusGenerationFrameStale';throw error;}
    const liveContext=getContext();
    const mainModel=String(resolveMainModelHint(liveContext)||model||'').trim();
    const mainProvider=String(resolveMainProviderHint(liveContext)||provider||'').trim();
    const adapter=resolvePromptLoaderAdapter({model:mainModel,provider:mainProvider});
    const adapterSignature=promptLoaderAdapterSignature(adapter);
    const previousPromptLoaderAdapter=clone(lastPromptLoaderAdapter);
    const adapterFirstSeen=lastPromptLoaderAdapterSignature==null;
    const adapterChanged=!adapterFirstSeen&&adapterSignature!==lastPromptLoaderAdapterSignature;
    const sealed=sealGenerationFrameState({generationId:expected,promptLoader:adapter});
    if(!authorityFresh(sealed)){const error=new Error('Generation Frame authority changed during seal.');error.name='NexusGenerationFrameStale';throw error;}
    const failed=sealed.manifest.outlets.filter(row=>row.status===NEXUS_GENERATION_OUTLET_STATUS.FAILED).map(row=>row.name);
    const sameAuthority=lastAppliedManifest&&String(lastAppliedManifest.chatId??'')===String(sealed.chatId??'')&&Number(lastAppliedManifest.chatEpoch)===Number(sealed.chatEpoch);
    const samePresentation=!!sameAuthority&&promptLoaderPresentationsCompatible(lastAppliedManifest?.promptLoader,sealed.manifest?.promptLoader);
    const comparable=!!sameAuthority&&samePresentation;
    const comparisonResetReason=sameAuthority&&!samePresentation?'adapter-presentation-changed':null;
    const previous=comparable?lastAppliedManifest:null,previousPrompt=comparable?lastAppliedPrompt:null;
    const sectionComparison=compareGenerationFrameManifests(previous,sealed.manifest),exactComparison=compareGenerationFramePrompts(previousPrompt??'',sealed.serializedPrompt),composed=composeGenerationFrame(sealed);
    if(adapterSignature!==lastPromptLoaderAdapterSignature){
        lastPromptLoaderAdapterSignature=adapterSignature;
        logEvent('prompt-loader','adapter-selected',{generationId:sealed.generationId,adapterId:adapter.id,family:adapter.family,model:adapter.model,provider:adapter.provider,matchedBy:adapter.matchedBy,layout:adapter.presentation?.layout||null,wrapperStyle:adapter.presentation?.wrapperStyle||null,cachePolicy:adapter.presentation?.cachePolicy||null,providerTemplateOwnership:'host',adapterFirstSeen,adapterChanged,previousAdapter:previousPromptLoaderAdapter?{adapterId:previousPromptLoaderAdapter.id||null,family:previousPromptLoaderAdapter.family||null,model:previousPromptLoaderAdapter.model||null,provider:previousPromptLoaderAdapter.provider||null}:null},'info');
    }
    const promptTokens=estimateContentTokens(sealed.serializedPrompt,mainModel),stablePrefixTokens=estimateContentTokens(sealed.serializedPrompt.slice(0,exactComparison.stablePrefixChars),mainModel);
    const sections=composed.sections.map(section=>({id:section.id,label:section.label,hash:section.hash,chars:section.text.length,tokens:estimateContentTokens(section.text,mainModel),reused:sealed.manifest.sections?.find(row=>row.id===section.id)?.reused===true}));
    const cacheImpact=analyzeGenerationFrameSectionCacheImpact(previous,sealed.manifest,{tokensById:Object.fromEntries(sections.map(section=>[section.id,section.tokens]))});
    // ONE physical Main-context write for all Nexus information.
    setExtensionPrompt(PROMPT_KEY,sealed.serializedPrompt,extension_prompt_types.IN_CHAT,1,false,extension_prompt_roles.SYSTEM);
    const applied=markGenerationFrameApplied({generationId:expected});lastAppliedManifest=clone(applied.manifest);lastAppliedPrompt=String(applied.serializedPrompt||'');
    const compileCache=clone(applied.manifest.compileCache||{hits:0,misses:0,reusedSectionIds:[],compiledSectionIds:[]});
    lastDiagnostics={generationId:applied.generationId,chatId:applied.chatId,chatEpoch:applied.chatEpoch,promptHash:applied.promptHash,promptChars:applied.serializedPrompt.length,promptUtf8Bytes:exactComparison.totalUtf8Bytes,promptTokens,promptLoaderAdapter:clone(applied.promptLoader||applied.manifest?.promptLoader||null),failedOutlets:failed,outletStatuses:clone(applied.manifest.outletStatuses),publicationRejections:clone(applied.manifest.publicationRejections||[]),sections,compileCache,cacheImpact,hasPriorComparison:comparable,comparisonResetReason,firstChangedSection:sectionComparison.firstChangedSection,firstChangedChar:exactComparison.firstChangedChar,stablePrefixChars:exactComparison.stablePrefixChars,stablePrefixUtf8Bytes:exactComparison.stablePrefixUtf8Bytes,stablePrefixTokens,stablePrefixRatio:exactComparison.stablePrefixRatio,stablePrefixByteRatio:exactComparison.stablePrefixByteRatio,identicalToPrevious:exactComparison.identical,appliedAt:applied.appliedAt};
    logEvent('generation-frame','applied',{generationId:applied.generationId,promptHash:applied.promptHash,promptChars:applied.serializedPrompt.length,promptUtf8Bytes:exactComparison.totalUtf8Bytes,promptTokens,promptLoaderAdapter:lastDiagnostics.promptLoaderAdapter,failedOutlets:failed,outletStatuses:lastDiagnostics.outletStatuses,publicationRejections:lastDiagnostics.publicationRejections,sections,compileCache,cacheImpact,hasPriorComparison:comparable,comparisonResetReason,firstChangedSection:sectionComparison.firstChangedSection,firstChangedChar:exactComparison.firstChangedChar,stablePrefixChars:exactComparison.stablePrefixChars,stablePrefixUtf8Bytes:exactComparison.stablePrefixUtf8Bytes,stablePrefixTokens,stablePrefixRatioPct:Number((exactComparison.stablePrefixRatio*100).toFixed(1)),stablePrefixByteRatioPct:Number((exactComparison.stablePrefixByteRatio*100).toFixed(1)),identicalToPrevious:exactComparison.identical},failed.length?'warn':'info');
    const activeAdapter=clone(applied.promptLoader||applied.manifest?.promptLoader||adapter);
    const stablePrefixRatioPct=Number((exactComparison.stablePrefixRatio*100).toFixed(1));
    if(adapterFirstSeen||adapterChanged){
        logEvent('prompt-loader','frame-active',{
            generationId:applied.generationId,
            adapterId:activeAdapter?.id||activeAdapter?.adapterId||adapter.id,
            family:activeAdapter?.family||adapter.family,
            model:activeAdapter?.model||mainModel||null,
            provider:activeAdapter?.provider||mainProvider||null,
            matchedBy:activeAdapter?.matchedBy||adapter.matchedBy||null,
            layout:activeAdapter?.presentation?.layout||activeAdapter?.layout||adapter.presentation?.layout||null,
            wrapperStyle:activeAdapter?.presentation?.wrapperStyle||activeAdapter?.wrapperStyle||adapter.presentation?.wrapperStyle||null,
            cachePolicy:activeAdapter?.presentation?.cachePolicy||activeAdapter?.cachePolicy||adapter.presentation?.cachePolicy||null,
            adapterState:adapterFirstSeen?'initial':'changed',
            adapterChanged,
            previousAdapter:adapterChanged&&previousPromptLoaderAdapter?{
                adapterId:previousPromptLoaderAdapter.id||previousPromptLoaderAdapter.adapterId||null,
                family:previousPromptLoaderAdapter.family||null,
                model:previousPromptLoaderAdapter.model||null,
                provider:previousPromptLoaderAdapter.provider||null,
            }:null,
            promptTokens,
            stablePrefixTokens,
            stablePrefixRatioPct,
            firstChangedSection:sectionComparison.firstChangedSection,
            identicalToPrevious:exactComparison.identical,
            comparisonResetReason,
            loadedSectionCount:sections.length,
            reusedSectionCount:sections.filter(section=>section.reused===true).length,
            loadedSections:sections.map(section=>({id:section.id,label:section.label,tokens:section.tokens,reused:section.reused===true})),
            changedSectionIds:clone(cacheImpact.changedSectionIds||[]),
            unchangedSectionIds:clone(cacheImpact.unchangedSectionIds||[]),
            outletStatuses:clone(lastDiagnostics.outletStatuses),
            failedOutlets:clone(failed),
        },failed.length?'warn':'info');
    }
    lastPromptLoaderAdapter=clone(activeAdapter);
    return clone(lastDiagnostics);
}

export function retireGenerationFrame({generationId=null,reason='generation-retired',clearPrompt=true}={}){
    const activeId=activeGenerationFrameId();if(activeId==null){if(clearPrompt)physicalClearKey(PROMPT_KEY);return false;}
    if(generationId!=null&&String(generationId)!==String(activeId))return false;
    const prior=retireGenerationFrameState({generationId});if(clearPrompt)physicalClearKey(PROMPT_KEY);
    logEvent('generation-frame','retired',{generationId:prior?.generationId||activeId,reason,state:prior?.state||null,promptHash:prior?.promptHash||null},'debug');return true;
}
