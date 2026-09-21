import { getSettings } from '../core/settings.js';
import { getWarmCandidates, getLastWarmStats, getActivePinnedRefs, getManualPinnedRefs, getEarnedPinnedRefs, pinManualRef, unpinManualRef, clearPins, invalidateSmartContext } from './warmer.js';
import { getTree } from '../tree/store.js';
import { findNodeContainingUid } from '../tree/model.js';
import { loadBook, findEntryByUid } from '../lore/store.js';
import { logEvent } from '../observability/telemetry.js';
import {
    badge as nxBadge,
    button as nxButton,
    collapsible as nxCollapsible,
    el as nxEl,
    emptyState as nxEmptyState,
    ensureUiRoot,
    input as nxInput,
    itemRow as nxItemRow,
    list as nxList,
    modal as nxModal,
    notice as nxNotice,
    panel as nxPanel,
    provenanceRow as nxProvenanceRow,
    toolbar as nxToolbar,
} from '../ui/index.js';

function $id(id){return document.getElementById(id);}
let smartDialog=null;
let smartDialogRoot=null;

function nodePath(root,targetId,path=[]){
    if(!root)return [];
    const next=[...path,root.label||'Root'];
    if(root.id===targetId)return next;
    for(const child of root.children||[]){const found=nodePath(child,targetId,next);if(found.length)return found;}
    return [];
}

export function smartContextSummary(){
    const warm=getWarmCandidates();
    const active=getActivePinnedRefs();
    const manual=getManualPinnedRefs();
    const earned=getEarnedPinnedRefs();
    return {warm:warm.length,active:active.length,manual:manual.length,earned:earned.length,enabled:getSettings().smartContext?.enabled!==false};
}

export function renderSmartContextBadges(){
    const s=smartContextSummary();
    for(const slot of ['a','b']){
        const el=$id(`tv2_sidecar_${slot}_smart_status`);
        if(!el)continue;
        el.textContent=`Shared Smart Context · ${s.enabled?'on':'off'} · ${s.warm} warm · ${s.active} continuity · ${s.earned} earned · ${s.manual} manual pin${s.manual===1?'':'s'}`;
    }
}

async function resolveManualPin(book,uid){
    const tree=getTree(book);
    if(!tree)throw new Error(`No Nexus Tree exists for "${book}".`);
    const node=findNodeContainingUid(tree.root,Number(uid));
    if(!node)throw new Error(`UID ${uid} is not assigned anywhere in the ${book} Tree.`);
    let title='';
    try{const data=await loadBook(book);title=findEntryByUid(data.entries,Number(uid))?.comment||'';}catch{}
    return {book,uid:Number(uid),title,nodeId:node.id,nodeLabel:node.label,path:nodePath(tree.root,node.id)};
}

function refKey(ref){return `${String(ref?.book||'')}:${Number(ref?.uid)}`;}
function pathText(ref){
    const path=Array.isArray(ref?.path)&&ref.path.length?ref.path.filter(Boolean):[];
    if(path.length)return path.join(' › ');
    return ref?.nodeLabel||'Unassigned Tree location';
}
function badgeTone(kind){
    if(kind==='PINNED')return 'warning';
    if(kind==='WARM')return 'info';
    if(kind==='EARNED')return 'success';
    if(kind==='MANUAL')return 'neutral';
    return 'neutral';
}
function renderRefRow(ref,{manual=false,warm=false,pinned=false,earned=false}={},refresh){
    const labels=[];
    if(pinned)labels.push('PINNED');
    if(warm)labels.push('WARM');
    if(earned)labels.push('EARNED');
    if(manual)labels.push('MANUAL');
    const badges=labels.map(label=>nxBadge({label,tone:badgeTone(label)}));
    const trailing=[];
    if(manual){
        trailing.push(nxButton({label:'Unpin',size:'sm',variant:'ghost',onClick:()=>{
            unpinManualRef(ref.book,Number(ref.uid));
            refresh?.();
            renderSmartContextBadges();
        }}));
    }
    return nxItemRow({
        title:ref.title||`UID ${ref.uid}`,
        meta:`${pathText(ref)} · ${ref.book} · UID ${Number(ref.uid)}${Number.isFinite(ref.score)?` · relevance ${Number(ref.score).toFixed(1)}`:''}`,
        leading:badges,
        trailing,
        body:[],
        className:'nx-smart-ref-row',
    });
}
function groupedPanels(refs,optionsForRef,refresh,{emptyTitle='Nothing here yet',emptyMessage=''}={}){
    if(!refs.length)return [nxEmptyState({title:emptyTitle,message:emptyMessage})];
    const groups=new Map();
    for(const ref of refs){const key=ref.nodeLabel||'Other';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(ref);}
    return [...groups.entries()].map(([label,items])=>nxEl('section',{className:'nx-smart-group-flat'},[
        nxEl('div',{className:'nx-smart-group-head'},[
            nxEl('strong',{text:label}),
            nxEl('span',{className:'nx-text-muted',text:`${items.length} ${items.length===1?'entry':'entries'}`}),
        ]),
        nxList({items,renderItem:ref=>renderRefRow(ref,optionsForRef(ref),refresh)}),
    ]));
}
function statNotice(stats){
    if(!stats)return nxNotice({tone:'neutral',title:'No warm pass recorded',message:'This runtime has not completed a Smart Context warm pass yet.'});
    const worker=stats.sidecarSlot?`Worker SC-${stats.sidecarSlot}`:'Available model-worker capacity';
    const tier=stats.sceneTier?`${stats.sceneTier} · budget ${Number(stats.warmBudget||0)} (policy floors 1 / 2 / 6)`:'warm policy';
    const rotation=`earned rotation ${Number(stats.earnedPinsPromoted||0)} promoted / ${Number(stats.earnedPinsDemoted||0)} expired`;
    const message=`${Number(stats.searchedCount||0)} searched → ${Number(stats.shortlistedCount||0)} shortlisted → ${Number(stats.finalCount||0)} warm · ${tier} · ${worker} · ${rotation}${stats.prunedCount?` · ${Number(stats.prunedCount)} low-signal pruned`:''}.`;
    const actions=[];
    if(stats.reasoning)actions.push(nxCollapsible({title:'Why these were warmed',body:[nxEl('p',{text:String(stats.reasoning)})],className:'nx-smart-reasoning'}));
    return nxNotice({tone:'info',title:'Last warm pass',message,actions});
}

function renderInspector(host){
    const warm=getWarmCandidates();
    const active=getActivePinnedRefs();
    const manual=getManualPinnedRefs();
    const earned=getEarnedPinnedRefs();
    const pinned=new Set([...active,...manual,...earned].map(refKey));
    const manualKeys=new Set(manual.map(refKey));
    const earnedKeys=new Set(earned.map(refKey));
    const refresh=()=>renderInspector(host);

    const countReadout=nxEl('span',{className:'nx-readout nx-smart-counts',text:`${warm.length} warm · ${active.length} continuity · ${earned.length} earned · ${manual.length} manual`});
    const toolbar=nxToolbar({
        start:[countReadout],
        end:[
            nxButton({label:'Refresh view',size:'sm',onClick:refresh}),
            nxButton({label:'Clear continuity pins',size:'sm',variant:'secondary',onClick:()=>{clearPins('smart-context-panel',{includeManual:false});refresh();renderSmartContextBadges();}}),
            nxButton({label:'Clear all pins',size:'sm',variant:'danger',onClick:()=>{
                if(globalThis.confirm?.('Clear continuity pins and manual pins for this chat?')===false)return;
                clearPins('smart-context-panel',{includeManual:true});refresh();renderSmartContextBadges();
            }}),
        ],
        className:'nx-smart-toolbar',
    });

    const warmPanel=nxPanel({
        title:'Warm candidates',
        body:groupedPanels(warm,ref=>({warm:true,pinned:pinned.has(refKey(ref)),manual:manualKeys.has(refKey(ref)),earned:earnedKeys.has(refKey(ref))}),refresh,{emptyTitle:'No warm candidates cached',emptyMessage:'A warm pass has not nominated predictive candidates yet.'}),
        className:'nx-smart-column',
    });
    const activePanel=nxPanel({
        title:'Continuity pins',
        body:groupedPanels(active,()=>({pinned:true}),refresh,{emptyTitle:'No continuity pins',emptyMessage:'No published Retrieval refs are currently retained as continuity evidence.'}),
        className:'nx-smart-column',
    });
    const earnedPanel=nxPanel({
        title:'Earned pins',
        body:groupedPanels(earned,()=>({pinned:true,earned:true}),refresh,{emptyTitle:'No earned pins',emptyMessage:'Repeated warm selection has not promoted any temporary relevance hints.'}),
        className:'nx-smart-column',
    });

    const bookField=nxInput({label:'Lorebook',placeholder:'Lorebook name'});
    const uidField=nxInput({label:'UID',type:'number',placeholder:'UID'});
    const addPin=nxButton({label:'Add pin',variant:'primary',onClick:async()=>{
        const book=String(bookField.controlElement?.value||'').trim();
        const uid=Number(uidField.controlElement?.value);
        if(!book||!Number.isFinite(uid)){globalThis.toastr?.warning('Enter a lorebook and UID.','Nexus');return;}
        try{
            const ref=await resolveManualPin(book,uid);
            pinManualRef(ref);
            invalidateSmartContext('manual-pin-panel');
            uidField.controlElement.value='';
            refresh();renderSmartContextBadges();
        }catch(err){logEvent('smart-context','manual-pin-ui-failed',{book,uid,error:err},'error');globalThis.toastr?.error(err?.message||String(err),'Nexus');}
    }});
    const manualPanel=nxPanel({
        title:'Manual pins',
        body:[
            ...groupedPanels(manual,()=>({pinned:true,manual:true}),refresh,{emptyTitle:'No manual pins',emptyMessage:'Add an exact Tree-bound lore reference when you want a persistent relevance hint.'}),
            nxEl('div',{className:'nx-smart-manual-form'},[bookField,uidField,addPin]),
        ],
        className:'nx-smart-column',
    });

    host.replaceChildren(
        toolbar,
        statNotice(getLastWarmStats()),
        nxEl('div',{className:'nx-smart-grid'},[warmPanel,activePanel,earnedPanel,manualPanel]),
    );
}

function closeSmartDialog(){
    const dialog=smartDialog,root=smartDialogRoot;
    smartDialog=null;smartDialogRoot=null;
    try{dialog?.closeDialog?.();}catch{}
    try{root?.remove?.();}catch{}
}

export function openSmartContextPanel(_slot='A'){
    closeSmartDialog();
    const host=nxEl('div',{className:'nx-smart-inspector'});
    const dialog=nxModal({
        title:'Smart Context Inspector',
        body:[host],
        className:'nx-smart-context-modal',
        onClose:()=>{if(smartDialog===dialog){smartDialog=null;smartDialogRoot=null;}try{dialog.parentElement?.remove();}catch{}},
    });
    const root=ensureUiRoot(nxEl('div',{className:'nx-smart-dialog-root'},[dialog]));
    smartDialog=dialog;smartDialogRoot=root;
    document.body.append(root);
    const onSmartContextUpdated=()=>{if(dialog.isConnected)renderInspector(host);};
    window.addEventListener('tv2-smart-context-updated',onSmartContextUpdated);
    dialog.addEventListener('close',()=>{window.removeEventListener('tv2-smart-context-updated',onSmartContextUpdated);if(smartDialog===dialog){smartDialog=null;smartDialogRoot=null;}try{root.remove();}catch{}},{once:true});
    renderInspector(host);
    dialog.openDialog?.();
}
