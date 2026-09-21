/**
 * Wiring layer from Nexus subsystem-owned state into the Generation Frame.
 * This module does not own any semantic state; it only projects already-owned
 * snapshots into their typed frame outlets.
 */
import { getContext } from '../../../../st-context.js';
import { getStoryScopeStatus } from '../lore/active-books.js';
import { getSceneAuthority } from '../scene/runtime.js';
import { getCharacterBankSceneSnapshot } from '../memory/character-banks.js';
import { memoryStats } from '../memory/store.js';
import { getPinnedRefs, getWarmCandidates, getLastWarmStats } from '../smart-context/warmer.js';
import { getNexusLedger } from './transaction-service.js';
import { NEXUS_GENERATION_OUTLET_STATUS } from './generation-frame-contract.js';
import {
    publishStoryScopeOutlet, publishSummaryBankOutlet, publishLedgerOutlet, publishSmartContextOutlet,
    publishCharacterBanksOutlet, publishSceneOutlet, publishChangeGateOutlet,
} from './generation-frame-ports.js';

function clean(value){return String(value??'').replace(/\s+/g,' ').trim();}
function stableNames(values=[]){return [...new Set((Array.isArray(values)?values:[]).map(clean).filter(Boolean))].sort((a,b)=>a.localeCompare(b));}
function stableRefs(refs=[]){
    return (Array.isArray(refs)?refs:[]).map(ref=>({book:clean(ref?.book),uid:Number(ref?.uid),nodeId:clean(ref?.nodeId),title:clean(ref?.title)})).filter(ref=>ref.book&&Number.isFinite(ref.uid)).sort((a,b)=>a.book.localeCompare(b.book)||a.uid-b.uid||a.nodeId.localeCompare(b.nodeId)||a.title.localeCompare(b.title));
}

function renderScene(scene={}){
    const lines=[];
    const participants=stableNames(scene?.participants);if(participants.length)lines.push(`Participants: ${participants.join(', ')}`);
    for(const [label,key] of [['Location','location'],['Activity','activity'],['Objective','objective'],['Focus','focus'],['Time','timeContext']]){const value=clean(scene?.[key]);if(value)lines.push(`${label}: ${value}`);}
    if(scene?.relationshipFocus===true)lines.push('Relationship focus: yes');
    return lines.join('\n');
}
function renderGate(gate={},scan={}){
    const lines=[];if(clean(gate?.mode))lines.push(`Change: ${clean(gate.mode)}`);if(clean(gate?.reason))lines.push(`Reason: ${clean(gate.reason)}`);
    const delta=scan?.delta||scan?.sceneDelta||{};
    const added=stableNames(delta?.participants?.added),removed=stableNames(delta?.participants?.removed);
    if(added.length)lines.push(`Arrived/present: ${added.join(', ')}`);if(removed.length)lines.push(`Departed/absent: ${removed.join(', ')}`);
    for(const [label,key] of [['Location','location'],['Activity','activity'],['Objective','objective'],['Focus','focus'],['Time','timeContext']]){
        const row=delta?.[key];if(row?.changed===true){const before=clean(row.previous),after=clean(row.current);lines.push(`${label}: ${before||'(unset)'} -> ${after||'(unset)'}`);}
    }
    return lines.join('\n');
}
function renderCharacterBanks(snapshot={}){
    const rows=(snapshot?.bankStates||[]).filter(row=>row?.enabled&& (row?.present||row?.warm)).sort((a,b)=>clean(a.character).localeCompare(clean(b.character))||clean(a.id).localeCompare(clean(b.id)));
    return rows.map(row=>`- ${clean(row.character)} | role=${clean(row.role)||'unspecified'} | present=${row.present===true?'yes':'no'} | warm=${row.warm===true?'yes':'no'}`).join('\n');
}
function ledgerAudit(chatId){
    const rows=getNexusLedger().list();
    const scoped=rows.filter(row=>{
        const candidate=row?.assumptions?.chatId??row?.metadata?.chatId??row?.input?.chatId??null;
        return candidate==null||String(candidate)===String(chatId??'');
    });
    const committed=scoped.filter(row=>String(row?.state)==='committed').sort((a,b)=>(Number(a.updatedAt)||0)-(Number(b.updatedAt)||0));
    return {total:scoped.length,committed:committed.length,active:scoped.filter(row=>!['committed','failed','aborted','cancelled','stale'].includes(String(row?.state))).length,recentCommitted:committed.slice(-8).map(row=>({id:String(row.id),type:String(row.type||''),updatedAt:Number(row.updatedAt)||0}))};
}

export function settleGenerationFrameSubsystemOutlets({generationId}={}){
    const context=getContext(),chatId=context?.chatId??context?.chat_id??null;
    const results={};
    try{
        const story=getStoryScopeStatus();
        results.story=publishStoryScopeOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.READY,data:{mode:story?.mode||null,readBooks:[...(story?.readBooks||[])].sort(),writeBooks:[...(story?.writeBooks||[])].sort()}});
    }catch(error){results.story=publishStoryScopeOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.FAILED,error:error?.message||String(error)});}

    let authority=null;
    try{
        authority=getSceneAuthority({chatId});
        const scan=authority?.sceneScan||null,scene=scan?.acceptedScene||null;
        const content=scene?renderScene(scene):'';
        results.scene=publishSceneOutlet({generationId,status:content?NEXUS_GENERATION_OUTLET_STATUS.READY:NEXUS_GENERATION_OUTLET_STATUS.EMPTY,content,data:{scanRevision:scan?.scanRevision||null,degraded:scan?.degraded===true},sourceRevision:scan?.scanRevision||null});
        const gate=authority?.gate||null,deltaContent=gate?renderGate(gate,scan):'';
        results.gate=publishChangeGateOutlet({generationId,status:deltaContent?NEXUS_GENERATION_OUTLET_STATUS.READY:NEXUS_GENERATION_OUTLET_STATUS.EMPTY,content:deltaContent,data:gate?{mode:gate.mode||null,sceneRevision:gate.sceneRevision||null,reason:gate.reason||null}:null,sourceRevision:gate?.sceneRevision||null});
    }catch(error){
        results.scene=publishSceneOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.FAILED,error:error?.message||String(error)});
        results.gate=publishChangeGateOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.FAILED,error:error?.message||String(error)});
    }

    try{
        const snapshot=getCharacterBankSceneSnapshot({sceneSnapshot:authority?.sceneScan||null});
        const content=renderCharacterBanks(snapshot);
        results.characters=publishCharacterBanksOutlet({generationId,status:snapshot?.enabled===false?NEXUS_GENERATION_OUTLET_STATUS.DISABLED:(content?NEXUS_GENERATION_OUTLET_STATUS.READY:NEXUS_GENERATION_OUTLET_STATUS.EMPTY),content,data:{enabled:snapshot?.enabled!==false,activeActors:stableNames(snapshot?.activeActors),warmActors:stableNames(snapshot?.warmActors),bankCount:snapshot?.bankStates?.length||0},sourceRevision:snapshot?.fingerprint||null});
    }catch(error){results.characters=publishCharacterBanksOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.FAILED,error:error?.message||String(error)});}

    try{
        const warm=stableRefs(getWarmCandidates()),pins=stableRefs(getPinnedRefs()),stats=getLastWarmStats();
        results.smart=publishSmartContextOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.READY,data:{warmRefs:warm,pinnedRefs:pins,stats:stats||null},refs:[...warm,...pins],sourceRevision:JSON.stringify({warm:warm.map(r=>[r.book,r.uid]),pins:pins.map(r=>[r.book,r.uid])})});
    }catch(error){results.smart=publishSmartContextOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.FAILED,error:error?.message||String(error)});}

    try{
        const stats=memoryStats();
        results.summary=publishSummaryBankOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.READY,data:stats,sourceRevision:JSON.stringify({records:stats?.total||stats?.count||0,layers:stats?.layers||null,summarizedThrough:stats?.summarizedThrough??null})});
    }catch(error){results.summary=publishSummaryBankOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.FAILED,error:error?.message||String(error)});}

    try{
        const audit=ledgerAudit(chatId);
        results.ledger=publishLedgerOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.READY,data:audit,sourceRevision:JSON.stringify(audit.recentCommitted.map(row=>[row.id,row.updatedAt]))});
    }catch(error){results.ledger=publishLedgerOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.FAILED,error:error?.message||String(error)});}
    return results;
}
