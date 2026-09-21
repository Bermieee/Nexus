import { lorePagingStatus, maintainLorePaging, coolLorePaging, invalidateLorePaging, retryLorePagingProvider } from './lore-runtime.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { pagingConfig } from './policy.js';
import { embedWithSession } from './embeddings.js';
import { setEmbeddingSessionKey, embeddingSessionKeyLoaded, invalidateVectorPaging, maintainVectorIndex, clearVectorPagingCache, vectorPagingStatus } from './runtime.js';
import {
    button as nxButton,
    collapsible as nxCollapsible,
    el as nxEl,
    ensureUiRoot,
    input as nxInput,
    notice as nxNotice,
    progressRow as nxProgressRow,
    select as nxSelect,
    toggle as nxToggle,
    toolbar as nxToolbar,
} from '../ui/index.js';

let vectorPagingRefreshListener=null;

const PRESETS=Object.freeze({
    economy:{batchSize:4,wakeLimit:4,indexLimit:2000,loreCacheMiB:128,foregroundBudgetMs:80,similarityThreshold:.62},
    balanced:{batchSize:8,wakeLimit:8,indexLimit:4000,loreCacheMiB:256,foregroundBudgetMs:150,similarityThreshold:.55},
    quality:{batchSize:16,wakeLimit:12,indexLimit:7000,loreCacheMiB:512,foregroundBudgetMs:250,similarityThreshold:.48},
});
function stateLabel(l,m,c){
    if(c.mode==='off')return 'Paused';
    if(l.busy||m.busy)return 'Indexing';
    if(l.providerError)return 'Provider error';
    if(l.retrying)return 'Retrying';
    const reason=String(l.reason||m.error||'').toLowerCase();
    if(reason.includes('retry'))return 'Retrying';
    if(reason.includes('error')||reason.includes('unavailable')||reason.includes('failed')||reason.includes('configure'))return 'Provider error';
    const useLore=['shadow','enabled'].includes(c.mode);
    const useMemory=['shadow','enabled','memory-pilot'].includes(c.mode);
    const loreTotal=Math.max(0,Number(l.total)||0),memoryTotal=Math.max(0,Number(m.total)||0);
    const loreIncomplete=useLore&&loreTotal>0&&(Number(l.indexed)||0)<loreTotal;
    // Memory paging deliberately remains inactive below its activation threshold.
    // Do not call that healthy standby state "stale" merely because no vectors
    // are being built yet.
    const memoryIncomplete=useMemory&&m.active===true&&memoryTotal>0&&(Number(m.indexed)||0)<memoryTotal;
    if(reason.includes('source-changed')||reason.includes('stale')||loreIncomplete||memoryIncomplete||Number(l.failedBooks||0)>0)return 'Stale';
    const memoryStandby=useMemory&&memoryTotal>0&&m.active!==true;
    const loreStandby=useLore&&loreTotal>0&&l.indexReady!==true;
    if(memoryStandby||loreStandby)return 'Standby';
    const relevantTotal=(useLore?loreTotal:0)+(useMemory?memoryTotal:0);
    if(relevantTotal===0)return 'Ready · no eligible records';
    const loreReady=!useLore||loreTotal===0||l.indexReady===true;
    const memoryReady=!useMemory||memoryTotal===0||m.indexReady===true;
    if(loreReady&&memoryReady)return 'Ready · completed';
    return 'Ready';
}
function toneForState(label){
    const value=String(label||'').toLowerCase();
    if(value.includes('error')||value.includes('stale'))return 'warning';
    if(value.includes('ready'))return 'success';
    if(value.includes('index')||value.includes('retry'))return 'info';
    return 'neutral';
}
function controlId(wrapper,key,attrs={}){
    const control=wrapper?.controlElement;
    if(!control)return wrapper;
    control.dataset.pagingKey=key;
    for(const [name,value] of Object.entries(attrs)){
        if(value===undefined||value===null)continue;
        if(name==='inputMode')control.inputMode=value;
        else control.setAttribute(name,String(value));
    }
    return wrapper;
}
function numberControl(key,label,{min,max,step,help=''}={}){
    return controlId(nxInput({label,type:'number',help}),key,{min,max,step,inputMode:'numeric'});
}
function selectControl(key,label,options){
    return controlId(nxSelect({label,options:options.map(([value,text])=>({value,label:text}))}),key);
}
function formGrid(children,className=''){
    return nxEl('div',{className:`nx-form-grid ${className}`.trim()},children);
}

export function bindVectorPagingUI(){
    const parent=document.querySelector('#tv2_advanced_settings_card .tv2-advanced-body');
    if(!parent||document.getElementById('nexus_vector_paging'))return;

    const fields=new Map();
    const register=(key,wrapper)=>{fields.set(key,wrapper.controlElement);return wrapper;};
    const mode=register('mode',selectControl('mode','Vector mode',[["off","Off"],["shadow","Observe only"],["enabled","Lorebooks + memories"],["memory-pilot","Memory only (legacy)"]]));
    const endpoint=register('endpoint',controlId(nxInput({label:'Embeddings endpoint',type:'url',placeholder:'https://…/embeddings'}),'endpoint'));
    const model=register('model',controlId(nxInput({label:'Embedding model',placeholder:'embedding model'}),'model'));
    const sessionKey=register('sessionKey',controlId(nxInput({label:'API key',type:'password',placeholder:'Stored until explicitly removed'}),'sessionKey',{autocomplete:'new-password'}));
    const preset=register('preset',selectControl('preset','Indexing preset',[["economy","Economy"],["balanced","Balanced"],["quality","Quality"]]));
    const memoryActivation=register('memoryActivation',selectControl('memoryActivation','Memory activation',[["automatic","Automatic"],["always","Whenever memories exist"]]));

    const expertControls=[];
    const addSelect=(key,label,choices)=>{const wrap=selectControl(key,label,choices);fields.set(key,wrap.controlElement);expertControls.push(wrap);};
    const addNumber=(key,label,opts={})=>{const wrap=numberControl(key,label,opts);fields.set(key,wrap.controlElement);expertControls.push(wrap);};
    const labels={loreCacheMiB:'Lore cache MiB',minTurns:'Minimum turns',minRecords:'Minimum memory records',pressureRecords:'Pressure records',residentLimit:'Resident target',residentChars:'Resident chars',minAgeTurns:'Protected age turns',warmTtlMs:'Warm TTL ms',wakeLimit:'Wake limit',similarityThreshold:'Similarity threshold',indexLimit:'Index limit',batchSize:'Batch size',maxTextChars:'Max embedding input chars',foregroundBudgetMs:'Foreground budget ms'};
    for(const [key,label] of Object.entries(labels))addNumber(key,label,{step:key==='similarityThreshold'?'0.05':'1'});
    const foregroundToggle=controlId(nxToggle({label:'Allow bounded foreground query embedding'}),'allowForegroundEmbedding');
    fields.set('allowForegroundEmbedding',foregroundToggle.controlElement);expertControls.push(foregroundToggle);

    const statusHost=nxEl('div',{className:'nx-vector-status'});
    let action='';
    const hydrate=()=>{
        const c=pagingConfig(getSettings().vectorPaging);
        for(const [k,el] of fields){
            if(k==='sessionKey')continue;
            if(el.type==='checkbox')el.checked=c[k]===true;else el.value=c[k]??'';
        }
        fields.get('sessionKey').placeholder=embeddingSessionKeyLoaded()?'Embedding key saved locally':'Stored until explicitly removed';
    };
    const friendlyReason=value=>String(value||'').replaceAll('-',' ');
    const refresh=()=>{
        const c=pagingConfig(getSettings().vectorPaging),l=lorePagingStatus(),m=vectorPagingStatus();
        const label=stateLabel(l,m,c);
        const memoryLabel=`Memory ${m.indexed||0}/${m.total||0}`;
        const memoryStandby=Number(m.total||0)>0&&m.active!==true
            ?`Memory standby: ${c.memoryActivation==='automatic'?'automatic threshold not reached':friendlyReason(m.reason||'inactive')}`
            :'';
        const providerProblem=l.providerError||m.error||'';
        const detail=[`Lore ${l.indexed||0}/${l.total||0}`,memoryLabel,memoryStandby,providerProblem?friendlyReason(providerProblem):'',action].filter(Boolean).join(' · ');
        const rows=[nxNotice({tone:toneForState(label),title:label,message:detail})];
        const loreTotal=Math.max(0,Number(l.total)||0),memoryTotal=Math.max(0,Number(m.total)||0);
        if(loreTotal>0)rows.push(nxProgressRow({label:'Lore vector index',value:Number(l.indexed)||0,max:loreTotal,detail:`${Number(l.indexed)||0}/${loreTotal}`}));
        if(memoryTotal>0)rows.push(nxProgressRow({label:'Memory vector index',value:Number(m.indexed)||0,max:memoryTotal,detail:`${Number(m.indexed)||0}/${memoryTotal}`}));
        statusHost.replaceChildren(...rows);
    };
    const read=()=>{
        const before=pagingConfig(getSettings().vectorPaging),raw={...before};
        for(const [k,el] of fields){if(k==='sessionKey')continue;raw[k]=el.type==='checkbox'?el.checked:el.type==='number'?Number(el.value):el.value;}
        return pagingConfig(raw);
    };
    const sameConfig=(left,right)=>JSON.stringify(pagingConfig(left))===JSON.stringify(pagingConfig(right));
    const applyPreset=name=>{
        const values=PRESETS[name]||PRESETS.balanced;
        for(const [k,v] of Object.entries(values)){const el=fields.get(k);if(!el)continue;if(el.type==='checkbox')el.checked=v===true;else el.value=v;}
        action=`${String(name||'balanced').replace(/^./,c=>c.toUpperCase())} preset loaded`;refresh();
    };
    const save=async()=>{
        const before=pagingConfig(getSettings().vectorPaging),next=read(),key=String(fields.get('sessionKey').value||'').trim();
        action='Saving paging settings…';refresh();
        updateSettings(s=>{s.vectorPaging={...next};});
        const saved=pagingConfig(getSettings().vectorPaging);
        if(!sameConfig(saved,next))throw new Error('Paging settings did not update in Nexus state.');
        if(key){setEmbeddingSessionKey(key);fields.get('sessionKey').value='';invalidateLorePaging('embedding-credentials-changed',{resetProvider:true});}
        if(!sameConfig(before,next)){invalidateVectorPaging('settings-changed');invalidateLorePaging('settings-changed',{resetProvider:true});}
        hydrate();action='Paging settings saved';refresh();
    };
    const test=async()=>{
        await save();action='Testing provider…';refresh();
        const c=pagingConfig(getSettings().vectorPaging),started=performance.now();
        const rows=await embedWithSession(['Nexus embedding provider check'],c);
        if(!rows?.[0]?.length)throw new Error('Embedding provider returned no usable vector.');
        action=`Connection usable · ${Math.round(performance.now()-started)} ms · ${rows[0].length} dimensions`;refresh();
    };
    const index=async()=>{
        await save();retryLorePagingProvider();action='Indexing / resuming…';refresh();
        await maintainLorePaging();const lore=lorePagingStatus();if(lore.providerError)throw new Error(lore.providerError);
        await maintainVectorIndex();const memory=vectorPagingStatus();if(memory.error)throw new Error(memory.error);
        action='Index pass completed';refresh();
    };
    const rebuild=async()=>{
        await save();retryLorePagingProvider();action='Rebuilding…';refresh();
        // Rebuild has one lifecycle owner. Do not broadcast/schedule an
        // independent lore+memory rebuild and then also run it directly here.
        await clearVectorPagingCache({broadcast:false,schedule:false});
        invalidateLorePaging('manual-rebuild',{resetProvider:true,schedule:false});
        await maintainLorePaging();const lore=lorePagingStatus();if(lore.providerError)throw new Error(lore.providerError);
        await maintainVectorIndex();const memory=vectorPagingStatus();if(memory.error)throw new Error(memory.error);
        action=`Rebuild pass completed · ${lore.bookCount||0} lorebook${Number(lore.bookCount||0)===1?'':'s'}`;refresh();
    };
    const runAction=handler=>async event=>{const button=event?.currentTarget;if(button)button.disabled=true;try{await handler();}catch(error){action=error?.message||String(error);refresh();}finally{if(button)button.disabled=false;}};

    const saveButton=nxButton({label:'Save setup',onClick:runAction(save)});
    const testButton=nxButton({label:'Test connection',onClick:runAction(test)});
    const indexButton=nxButton({label:'Index / resume',onClick:runAction(index)});
    const rebuildButton=nxButton({label:'Rebuild index',variant:'secondary',onClick:runAction(rebuild)});
    const coolButton=nxButton({label:'Cool idle lore now',variant:'secondary',onClick:()=>{
        const result=coolLorePaging()||{};
        const slept=Number(result.entriesSlept)||0,protectedCount=Number(result.protectedEntries)||0,budget=Number(result.budgetResidentEntries)||0,unindexed=Number(result.unindexedResidentEntries)||0;
        action=slept>0
            ?`Cooling: ${slept} slept · ${protectedCount} protected · ${budget} resident · ${unindexed} unindexed`
            :`Cooling: no new sleeps · ${protectedCount} protected · ${budget} resident · ${unindexed} unindexed`;
        refresh();
    }});
    const forgetButton=nxButton({label:'Remove embedding API key',size:'sm',variant:'danger',onClick:()=>{
        if(globalThis.confirm?.('Remove the saved embedding API key from this browser? Nexus will keep it across refreshes until you explicitly remove it.')===false)return;
        setEmbeddingSessionKey('');action='Embedding API key removed';hydrate();refresh();
    }});

    const advanced=nxCollapsible({
        title:'Advanced indexing controls',
        body:[formGrid(expertControls),nxToolbar({end:[forgetButton]})],
        className:'nx-vector-advanced',
    });
    const panel=nxCollapsible({
        title:'Vector retrieval & paging',
        open:false,
        body:[
            formGrid([mode,endpoint,model,sessionKey,preset,memoryActivation]),
            nxToolbar({end:[saveButton,testButton,indexButton,rebuildButton,coolButton],className:'nx-vector-actions'}),
            statusHost,
            advanced,
        ],
        className:'nx-vector-paging-panel nx-settings-category',
    });
    panel.id='nexus_vector_paging';
    const uiRoot=ensureUiRoot(nxEl('div',{className:'nx-vector-paging-root'},[panel]));

    fields.get('preset')?.addEventListener('change',event=>applyPreset(event.target.value));
    parent.append(uiRoot);hydrate();refresh();if(vectorPagingRefreshListener)window.removeEventListener('nexus-vector-paging-updated',vectorPagingRefreshListener);vectorPagingRefreshListener=refresh;window.addEventListener('nexus-vector-paging-updated',vectorPagingRefreshListener);
}
