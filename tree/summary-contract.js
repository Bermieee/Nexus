import { isSchemaPlaceholder } from '../sidecar/semantic-validation.js';

function text(value){return String(value??'').trim();}
function object(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}

export function createTreeSummaryRefContract(batch=[]){
    const refs=(Array.isArray(batch)?batch:[]).map((row,index)=>({
        ref:`N${index+1}`,
        nodeId:text(row?.node?.id),
    }));
    const byRef=new Map(refs.map(row=>[row.ref,row.nodeId]));
    return Object.freeze({refs:Object.freeze(refs.map(Object.freeze)),byRef});
}

export function validateTreeSummaryRefPayload(value,contract){
    const requested=(contract?.refs||[]).map(row=>String(row.ref));
    const expected=new Set(requested),errors=[],seen=new Set(),normalized=[];
    let score=0;
    if(!object(value))return {valid:false,score,reason:'Tree summary payload must be a top-level object.',value:null,details:{requested,seen:[]}};
    if(!Array.isArray(value.summaries))return {valid:false,score:10,reason:'Tree summary payload requires summaries array.',value:null,details:{requested,seen:[]}};
    score+=20;
    value.summaries.forEach((row,index)=>{
        if(!object(row)){errors.push(`Tree summary ${index} is not an object.`);return;}
        const ref=text(row.ref),summary=text(row.summary);
        if(!ref||isSchemaPlaceholder(ref))errors.push(`Tree summary ${index} has placeholder/empty ref.`);
        else if(!expected.has(ref))errors.push(`Tree summary ${index} contains unknown ref ${ref}.`);
        else if(seen.has(ref))errors.push(`Tree summary contains duplicate ref ${ref}.`);
        else{seen.add(ref);score+=10;}
        if(!summary||isSchemaPlaceholder(summary))errors.push(`Tree summary ${ref||index} has placeholder/empty summary.`);
        else score+=5;
        normalized.push({ref,summary});
    });
    for(const ref of requested)if(!seen.has(ref))errors.push(`Tree summary is missing requested ref ${ref}.`);
    if(seen.size===expected.size&&seen.size===requested.length)score+=30;
    return {valid:errors.length===0,score,reason:errors.length?errors.join('; '):null,value:{...value,summaries:normalized},details:{requested,seen:[...seen]}};
}

export function mapTreeSummaryRefsToNodeIds(value,contract){
    const out=new Map();
    for(const row of value?.summaries||[]){
        const nodeId=contract?.byRef?.get(text(row?.ref));
        if(nodeId)out.set(nodeId,text(row?.summary));
    }
    return out;
}

export async function settleTreeSummaryBatches(batches=[],resolveBatch,{isGlobalAbort=()=>false}={}){
    const outputs=Array.from({length:batches.length},()=>null);
    for(let index=0;index<batches.length;index++){
        try{outputs[index]=await resolveBatch(batches[index],index);}
        catch(error){
            if(isGlobalAbort(error))throw error;
            outputs[index]={error};
        }
    }
    return outputs;
}

export function partitionTreeSummaryDependencies(layer=[],{eligibleIds=new Set(),succeededIds=new Set()}={}){
    const eligible=eligibleIds instanceof Set?eligibleIds:new Set(eligibleIds||[]);
    const succeeded=succeededIds instanceof Set?succeededIds:new Set(succeededIds||[]);
    const ready=[],blocked=[];
    for(const row of layer||[]){
        const blockedBy=(row?.node?.children||[]).map(child=>String(child?.id||'')).filter(id=>eligible.has(id)&&!succeeded.has(id));
        if(blockedBy.length)blocked.push({row,blockedBy});
        else ready.push(row);
    }
    return {ready,blocked};
}

export function combineTreeSummaryRecoveryResults(...results){
    return {
        outputs:results.flatMap(result=>result?.outputs||[]),
        failed:results.flatMap(result=>result?.failed||[]),
    };
}
