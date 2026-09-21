/**
 * Host-free Generation Frame outlet bus.
 *
 * Subsystems publish here.  This module cannot write a SillyTavern prompt and
 * therefore cannot bypass the physical authority in generation-frame.js.
 */
import {
    NEXUS_GENERATION_OUTLET_SPEC,
    NEXUS_GENERATION_OUTLET_STATUS,
    createGenerationFrameRecord,
    sealGenerationFrameRecord,
    updateGenerationFrameOutlet,
} from './generation-frame-contract.js';

const GENERATION_FRAME_PORT_TOKEN = Symbol('nexus-generation-frame-port');
let activeFrame=null;
const orphanRejections=[];
const MAX_REJECTIONS=64;
function recordRejection({name=null,generationId=null,reason='rejected'}={}){
    const row={name:name==null?null:String(name),generationId:generationId==null?null:String(generationId),activeGenerationId:activeFrame?.generationId??null,reason:String(reason),at:Date.now()};
    const target=activeFrame?.publicationRejections||(orphanRejections);target.push(row);while(target.length>MAX_REJECTIONS)target.shift();return row;
}
function clone(value){if(value===undefined)return undefined;try{return typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value));}catch{return null;}}

export function beginGenerationFrameState({generationId,chatId=null,chatEpoch=null}={}){
    activeFrame=createGenerationFrameRecord({generationId,chatId,chatEpoch});
    return clone(activeFrame);
}
export function resetGenerationFrameState(){const prior=activeFrame;activeFrame=null;return clone(prior);}
export function getGenerationFrameSnapshot(){return clone(activeFrame);}
export function activeGenerationFrameId(){return activeFrame?.generationId??null;}

// Raw publication requires an unforgeable module-instance capability.  Only
// generation-frame-ports.js receives the capability via bindGenerationFramePort;
// normal subsystems never receive the generic publisher.
export function bindGenerationFramePort(name){
    if(!NEXUS_GENERATION_OUTLET_SPEC[name])throw new Error(`Unknown Generation Frame outlet: ${String(name)}`);
    const token=GENERATION_FRAME_PORT_TOKEN;
    return Object.freeze({
        publish(payload={}){return publishGenerationOutlet(name,payload,token);},
        clear(payload={}){return clearGenerationOutlet(name,payload,token);},
    });
}

function publishGenerationOutlet(name,{generationId=null,...payload}={},token=null){
    if(token!==GENERATION_FRAME_PORT_TOKEN)throw new Error('Generation Frame publication rejected: typed outlet port capability required.');
    if(!NEXUS_GENERATION_OUTLET_SPEC[name])throw new Error(`Unknown Generation Frame outlet: ${String(name)}`);
    if(!activeFrame){recordRejection({name,generationId,reason:'no-open-frame'});return {accepted:false,reason:'no-open-frame'};}
    const expected=generationId??activeFrame.generationId;
    if(String(expected??'')!==String(activeFrame.generationId)){recordRejection({name,generationId:expected,reason:'generation-mismatch'});return {accepted:false,reason:'generation-mismatch'};}
    if(activeFrame.state!=='open'){recordRejection({name,generationId:expected,reason:'frame-not-open'});return {accepted:false,reason:'frame-not-open'};}
    const row=updateGenerationFrameOutlet(activeFrame,name,payload);
    return {accepted:true,row};
}

function clearGenerationOutlet(name,{generationId=null,status=NEXUS_GENERATION_OUTLET_STATUS.EMPTY,reason='empty'}={},token=null){
    return publishGenerationOutlet(name,{generationId,status,data:{reason},error:status===NEXUS_GENERATION_OUTLET_STATUS.FAILED?reason:null},token);
}

export function getGenerationFramePublicationRejections(){
    const rows=[...orphanRejections,...(activeFrame?.publicationRejections||[])];
    return clone(rows.slice(-MAX_REJECTIONS));
}

export function sealGenerationFrameState({generationId=null}={}){
    if(!activeFrame)throw new Error('No open Nexus Generation Frame exists.');
    const expected=generationId??activeFrame.generationId;
    if(String(expected??'')!==String(activeFrame.generationId))throw new Error(`Generation Frame seal rejected: expected ${activeFrame.generationId}, received ${String(expected)}.`);
    const sealed=sealGenerationFrameRecord(activeFrame);
    activeFrame=clone(sealed);
    return clone(sealed);
}

export function markGenerationFrameApplied({generationId=null,appliedAt=Date.now()}={}){
    if(!activeFrame)return null;
    if(generationId!=null&&String(generationId)!==String(activeFrame.generationId))return null;
    if(activeFrame.state!=='sealed')throw new Error(`Generation Frame ${activeFrame.generationId} must be SEALED before APPLIED.`);
    activeFrame.state='applied';activeFrame.appliedAt=Number(appliedAt)||Date.now();
    return clone(activeFrame);
}

export function retireGenerationFrameState({generationId=null}={}){
    if(!activeFrame)return null;
    if(generationId!=null&&String(generationId)!==String(activeFrame.generationId))return null;
    const prior=activeFrame;activeFrame=null;return clone(prior);
}
