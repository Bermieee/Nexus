import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { bindVectorPagingUI } from './paging/ui.js';
import { mountRetrievalSettingsUI } from './retrieval/settings-ui.js';
import { getSettings, updateSettings, updateAuthoritySettingsDurably, getAuthoritySettingsStatus } from './core/settings.js';
import { openProposalPanel } from './proposals/ui.js';
import { registerTools } from './tools/registry.js';
import { getTunnelVisionMigrationPreview, previewTunnelVisionBaseline, importTunnelVisionBaseline, createTv2Backup, previewTv2OrTv1Import, importTv2OrTv1Payload, inspectImportRecoveryState, reconcileActiveImportRecovery, abandonImportRecoveryFence } from './migration.js';
import { refreshSidecarBus, testSidecar } from './sidecar/bus.js';
import { getSidecarRuntimeHealth } from './sidecar/router.js';
import { listSidecarModels } from './sidecar/client.js';
import { checkSidecarProvider, sameProviderCapacity } from './sidecar/provider-check.js';
import { configureTelemetry, logEvent, getTelemetrySnapshot, onTelemetryChange } from './observability/telemetry.js';
import { openDiagnosticsPanel, bindTelemetryCards, renderSidecarTelemetryCards, renderLogLauncher } from './observability/ui.js';
import { openTreeWorkspace } from './tree/ui.js';
import { openUidSummarizer } from './lore/uid-summarizer.js';
import { openSmartContextPanel, renderSmartContextBadges } from './smart-context/ui.js';
import { openMemoryBank } from './memory/ui.js';
import { characterBankSummary } from './memory/character-banks.js';
import { runLifecycleTask, getSchedulerState, invalidateLifecycleScheduler } from './lifecycle/scheduler.js';
import { inspectPostTurnBacklogForAdmission } from './postturn/pipeline.js';
import { memoryStats } from './memory/store.js';
import { getProposalCounts, getProposals, getProposalChangeEventName } from './proposals/store.js';
import { acknowledgePendingProposals, getUnseenPendingProposalCount, getProposalAttentionChangeEventName } from './proposals/attention.js';
import { TV2_THEME_PRESETS, getPresetTheme, normalizeTheme, applyTv2Theme } from './theme.js';
import { world_names, selected_world_info, updateWorldInfoList } from '../../../world-info.js';
import { getTree } from './tree/store.js';
import { getActiveBooks, getManagedBooks, getStoryScopeStatus } from './lore/active-books.js';
import { getBookPermission, setBookPermission, getBookInjectionMode, setBookInjectionMode, isBookEnabled, setBookEnabled, setBookPolicyDurably, bookPolicyLabel, canReadBook, canWriteBook } from './lore/policy.js';
import { setBookInCurrentStory, removeBookFromCurrentStory, clearCurrentStoryScope } from './lore/story-scope.js';
import { createCallCenterTestHarness } from './nexus/call-center-test-harness.js';
import { getNexusBatchStatus } from './nexus/batch-layer.js';
import { bindSidecarStatus } from './observability/sidecar-status.js';
import { getActiveNexusToolGateway } from './nexus/tool-gateway.js';
import { NEXUS_COORDINATION_MODE, NEXUS_DIRECTOR_LIFECYCLE_WORKLOADS, inferNexusCoordinationMode, applyNexusCoordinationMode } from './nexus/coordination-profile.js';
import { getNexusRuntime } from './nexus/runtime.js';
import { dispatchManualMainDraft } from './nexus/outbound-main.js';
import { bindNexusTestingTools } from './testing/ui.js';
import { resetNexusLifecycleBridge } from './nexus/lifecycle-bridge.js';
import { reconcileNexusLorebookInventory } from './lore/inventory.js';
import { mountDecisionCoreSettings } from './decision/settings-ui.js';
import { openActivityFeed } from './activity-feed.js';
import { closeNexusControlPanel, toggleNexusPanelCollapsed } from './standalone-ui.js';

function $id(id){return document.getElementById(id);}
function set(id,value,type='value'){const el=$id(id);if(!el)return;if(type==='checked')el.checked=!!value;else el.value=value??'';}
function number(id,fallback,min=-Infinity,max=Infinity){const raw=$id(id)?.value;if(raw===undefined||raw===null||String(raw).trim()==='')return fallback;const n=Number(raw);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;}
function optionalPositive(id){const raw=$id(id)?.value;const n=Number(raw);return raw!==''&&Number.isFinite(n)&&n>0?Math.floor(n):null;}

let currentLorebook=null;
let callCenterHarness=null;
let callCenterHarnessSignature='';
let lorebookInventoryRefreshPromise=null;
let lorebookInventoryRefreshTimer=null;
let lorebookInventoryObserver=null;
let callReviewBoundaryOffset=0;
let lorebookSelectionSerial=0;


function renderUiPresentation(){
    const root=$id('tv2_settings');if(!root)return;
    root.classList.remove('tv2-ui-simple');
    root.classList.add('tv2-ui-technical');
    root.dataset.presentationMode='technical';
    const ui=getSettings().ui||{};
    const sidecarsCollapsed=ui.sidecarsCollapsed!==false,sidecarsBody=$id('tv2_sidecars_body'),sidecarsHeader=$id('tv2_sidecars_header');
    if(sidecarsBody)sidecarsBody.style.display=sidecarsCollapsed?'none':'block';
    sidecarsHeader?.classList.toggle('expanded',!sidecarsCollapsed);
    const lifecycleCollapsed=ui.lifecycleCollapsed!==false,lifecycleBody=$id('tv2_lifecycle_body'),lifecycleHeader=$id('tv2_lifecycle_header');
    if(lifecycleBody)lifecycleBody.style.display=lifecycleCollapsed?'none':'block';
    lifecycleHeader?.classList.toggle('expanded',!lifecycleCollapsed);
    renderUiSectionSummaries();
}
function setUiCollapsed(key,collapsed){
    updateSettings(settings=>{settings.ui={...(settings.ui||{}),[key]:collapsed===true};});
    renderUiPresentation();
}
function renderUiSectionSummaries(){
    const settings=getSettings();
    const sidecars=$id('tv2_sidecars_summary');
    if(sidecars){
        const state=slot=>$id(`tv2_sidecar_${slot.toLowerCase()}_live`)?.dataset?.state||'warning';
        const display=value=>({ready:'ready',running:'working',warning:'attention',failed:'failed',disabled:'off'}[value]||value);
        const enabled=['A','B'].filter(slot=>settings.sidecars?.[slot]?.enabled!==false).length;
        const pills=[['A',state('A')],['B',state('B')]].map(([slot,value])=>`<span class="tv2-count-pill tv2-header-state-pill" data-state="${esc(value)}">${slot} ${esc(display(value))}</span>`);
        pills.push(`<span class="tv2-count-pill tv2-header-state-pill">${enabled} enabled</span>`);
        sidecars.innerHTML=pills.join('');
    }
    const lifecycle=$id('tv2_lifecycle_summary');
    if(lifecycle){
        const scheduler=settings.scheduler||{};
        const mode=scheduler.enabled===false?'Off':scheduler.automatic===false?'Manual':'Intelligence';
        lifecycle.innerHTML=`<span class="tv2-count-pill tv2-header-state-pill">${mode}</span>`;
    }
}
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function lorebookNames(){return [...new Set((world_names||[]).map(name=>String(name||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));}
function normalizeLorebookSelection(names){
    const available=Array.isArray(names)?names:lorebookNames();
    const stored=String(getSettings().selectedLorebook||'').trim();
    const next=available.includes(currentLorebook)?currentLorebook:available.includes(stored)?stored:(available[0]||null);
    currentLorebook=next;
    if(stored&&!available.includes(stored))updateSettings(settings=>{settings.selectedLorebook=next;});
    return next;
}
async function refreshLorebookInventory({refreshHost=true,reason='ui-refresh'}={}){
    if(lorebookInventoryRefreshPromise)return lorebookInventoryRefreshPromise;
    lorebookInventoryRefreshPromise=(async()=>{
        const before=lorebookNames();
        if(refreshHost&&typeof updateWorldInfoList==='function')await updateWorldInfoList();
        const reconciliation=await reconcileNexusLorebookInventory({reason});
        const after=lorebookNames();
        normalizeLorebookSelection(after);
        renderLorebookList();
        renderSelectedLorebook();
        renderOperatorLaunchers();
        logEvent('ui','world-info-inventory-refreshed',{reason,refreshHost,beforeCount:before.length,afterCount:after.length,added:after.filter(name=>!before.includes(name)),removed:before.filter(name=>!after.includes(name)),pruned:reconciliation?.removed||[]},'debug');
        globalThis.dispatchEvent?.(new CustomEvent('nexus-world-info-inventory-refreshed',{detail:{reason,names:[...after]}}));
        return after;
    })().catch(error=>{
        logEvent('ui','world-info-inventory-refresh-failed',{reason,refreshHost,error},'warn');
        console.warn('[Nexus] World Info inventory refresh failed.',error);
        return lorebookNames();
    }).finally(()=>{lorebookInventoryRefreshPromise=null;});
    return lorebookInventoryRefreshPromise;
}
function scheduleLorebookInventoryRefresh(reason='host-world-info-change',{refreshHost=true,delay=40}={}){
    if(lorebookInventoryRefreshTimer!==null)clearTimeout(lorebookInventoryRefreshTimer);
    lorebookInventoryRefreshTimer=setTimeout(()=>{lorebookInventoryRefreshTimer=null;void refreshLorebookInventory({refreshHost,reason});},Math.max(0,Number(delay)||0));
}
function bindStoryScopeChatRefresh(){
    const eventType=event_types?.CHAT_CHANGED;
    if(eventType&&eventSource?.on)eventSource.on(eventType,()=>renderStoryScope());
}
function bindLorebookInventoryRefresh(){
    for(const name of ['WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED']){
        const eventType=event_types?.[name];
        if(eventType&&eventSource?.on)eventSource.on(eventType,()=>scheduleLorebookInventoryRefresh(name,{refreshHost:true}));
    }
    const attachObserver=()=>{
        if(lorebookInventoryObserver||typeof MutationObserver!=='function')return;
        const targets=['world_info','world_editor_select','world_info_select'].map(id=>document.getElementById(id)).filter(Boolean);
        if(!targets.length)return;
        lorebookInventoryObserver=new MutationObserver(()=>scheduleLorebookInventoryRefresh('host-world-info-dom-change',{refreshHost:false,delay:0}));
        for(const target of targets)lorebookInventoryObserver.observe(target,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','selected']});
    };
    attachObserver();
    setTimeout(attachObserver,500);
    for(const id of ['tv2_lorebook_default_select','tv2_lorebook_filter']){
        $id(id)?.addEventListener('focus',()=>scheduleLorebookInventoryRefresh('nexus-lorebook-ui-focus',{refreshHost:true,delay:0}));
    }
}
function stActiveBook(name){return Array.isArray(selected_world_info)&&selected_world_info.includes(name);}
function treeCount(name){const tree=getTree(name);if(!tree?.root)return 0;let n=0;const walk=node=>{n+=(node.entryUids||[]).length;for(const c of node.children||[])walk(c);};walk(tree.root);return n;}
function renderLorebookDefaultSelect(){
    const select=$id('tv2_lorebook_default_select');if(!select)return;
    const names=lorebookNames();
    select.innerHTML=names.length?names.map(name=>`<option value="${esc(name)}">${esc(name)}${isBookEnabled(name)?' · Nexus enabled':''}</option>`).join(''):'<option value="">No lorebooks found</option>';
    select.value=names.includes(currentLorebook)?currentLorebook:(names[0]||'');
}
function renderLorebookList(){
    renderLorebookDefaultSelect();
    const host=$id('tv2_lorebook_list');if(!host)return;
    const q=String($id('tv2_lorebook_filter')?.value||'').trim().toLowerCase();
    const names=lorebookNames().filter(name=>!q||name.toLowerCase().includes(q));
    const sorted=[...names].sort((a,b)=>{const ae=isBookEnabled(a)?1:0,be=isBookEnabled(b)?1:0;if(ae!==be)return be-ae;const aa=stActiveBook(a)?1:0,ba=stActiveBook(b)?1:0;if(aa!==ba)return ba-aa;return a.localeCompare(b);});
    host.innerHTML=sorted.length?sorted.map(name=>{const enabled=isBookEnabled(name),active=stActiveBook(name),tree=treeCount(name),perm=getBookPermission(name),inj=getBookInjectionMode(name);const p=perm==='read_write'?'Read + write':perm==='read_only'?'Read only':'Write only';const meta=[active?'ST active':'',p,inj==='tv2'?'Nexus injection':'ST injection',tree?`${tree} indexed`:''].filter(Boolean).join(' · ');return `<button type="button" class="tv2-lorebook-card${name===currentLorebook?' selected':''}${enabled?' enabled':''}" data-book="${esc(name)}"><span class="tv2-lorebook-dot"></span><span class="tv2-lorebook-card-info"><b>${esc(name)}</b><span class="tv2-lorebook-card-meta">${esc(meta)}</span></span></button>`;}).join(''):'<div class="tv2-help tv2-empty-book-list">No lorebooks found.</div>';
    host.querySelectorAll('.tv2-lorebook-card').forEach(card=>card.addEventListener('click',()=>selectLorebook(card.dataset.book)));
}
function hasActiveStoryScopeChat(){
    const context=getContext();
    return !!String(context?.chatId || context?.chat_id || '').trim();
}
function storyScopeSummary(){
    const scope=getStoryScopeStatus();
    if(!hasActiveStoryScopeChat())return {scope,text:'Select a chat to configure story access.',detail:'Story access is stored per chat and is unavailable until a chat is selected.'};
    const read=scope.readBooks||[],write=scope.writeBooks||[];
    const currentRead=currentLorebook&&read.includes(currentLorebook);
    const currentWrite=currentLorebook&&write.includes(currentLorebook);
    const text=currentWrite?'Read + write for this story':currentRead?'Read only for this story':'Not in this story scope';
    return {scope,text,detail:`${read.length} readable · ${write.length} writable`};
}
function renderStoryScope(){
    const activeChat=hasActiveStoryScopeChat();
    const {scope,text,detail}=storyScopeSummary();
    const status=$id('tv2_story_scope_status');if(status){status.textContent=text;status.title=detail;}
    if(!currentLorebook)return;
    const attached=activeChat&&((scope.readBooks||[]).includes(currentLorebook)||(scope.writeBooks||[]).includes(currentLorebook));
    const writable=activeChat&&(scope.writeBooks||[]).includes(currentLorebook);
    set('tv2_story_scope_attached',attached,'checked');
    set('tv2_story_scope_write',writable,'checked');
    const writeToggle=$id('tv2_story_scope_write');if(writeToggle)writeToggle.disabled=!activeChat||!isBookEnabled(currentLorebook)||!canWriteBook(currentLorebook);
    const attachToggle=$id('tv2_story_scope_attached');if(attachToggle)attachToggle.disabled=!activeChat||!isBookEnabled(currentLorebook);
}
async function saveStoryScopeForSelectedBook(){
    if(!hasActiveStoryScopeChat())return renderStoryScope();
    if(!currentLorebook||!isBookEnabled(currentLorebook))return renderStoryScope();
    const attached=$id('tv2_story_scope_attached')?.checked===true;
    const allowWrite=$id('tv2_story_scope_write')?.checked===true&&canWriteBook(currentLorebook);
    const managedBooks=getManagedBooks({requireTree:false,access:'any',injection:'any'});
    try{if(!attached)await removeBookFromCurrentStory(currentLorebook,{managedBooks,reason:'operator-detached-book'});
    else await setBookInCurrentStory(currentLorebook,{read:canReadBook(currentLorebook),write:allowWrite,reason:'operator-attached-book'},{managedBooks});}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Story Scope');}
    renderStoryScope();renderOperatorLaunchers();
}
function renderSelectedLorebook(){
    const controls=$id('tv2_lorebook_controls');if(!controls)return;
    if(!currentLorebook){controls.style.display='none';return;}
    controls.style.display='grid';
    set('tv2_selected_book_name',currentLorebook,'textContent');
    const nameEl=$id('tv2_selected_book_name');if(nameEl)nameEl.textContent=currentLorebook;
    const policy=bookPolicyLabel(currentLorebook);const policyEl=$id('tv2_selected_book_policy');if(policyEl)policyEl.textContent=policy;
    set('tv2_lorebook_enabled',isBookEnabled(currentLorebook),'checked');
    set('tv2_book_permission',getBookPermission(currentLorebook));
    set('tv2_book_injection_mode',getBookInjectionMode(currentLorebook));
    renderStoryScope();
}
async function selectLorebook(name){
    const serial=++lorebookSelectionSerial;
    const next=String(name||'').trim()||null;
    const previous=currentLorebook;
    currentLorebook=next;
    if(currentLorebook)updateSettings(s=>{s.selectedLorebook=currentLorebook;});
    renderLorebookDefaultSelect();renderLorebookList();renderSelectedLorebook();renderOperatorLaunchers();
    if(previous&&next&&previous!==next&&hasActiveStoryScopeChat()){
        const managedBooks=getManagedBooks({requireTree:false,access:'any',injection:'any'});
        try{await clearCurrentStoryScope({managedBooks,reason:'operator-lorebook-swap-auto-reset'});}
        catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Story Scope');}
        if(serial===lorebookSelectionSerial){renderStoryScope();renderOperatorLaunchers();}
    }
}
async function saveSelectedLorebookPolicy(){
    if(!currentLorebook)return;
    const book=currentLorebook;
    try{
        await setBookPolicyDurably(book,{
            enabled:$id('tv2_lorebook_enabled')?.checked===true,
            permission:$id('tv2_book_permission')?.value||'read_write',
            injectionMode:$id('tv2_book_injection_mode')?.value||'tv2',
        });
        renderLorebookList();renderSelectedLorebook();registerTools();
    }catch(error){
        logEvent('settings','lorebook-authority-persistence-failed',{book,error},'error');
        globalThis.toastr?.error(`Lorebook authority was not activated: ${error?.message||error}`,'Nexus');
        renderLorebookList();renderSelectedLorebook();
    }
}

function setModeGroup(group,value='adaptive'){
    const boxes=[...document.querySelectorAll(`.tv2-mode-check[data-mode-group="${group}"]`)];
    const desired=boxes.some(b=>b.value===value)?value:'adaptive';
    boxes.forEach(box=>box.checked=box.value===desired);
}
function getModeGroup(group,fallback='adaptive'){
    return document.querySelector(`.tv2-mode-check[data-mode-group="${group}"]:checked`)?.value||fallback;
}


function renderOperatorLaunchers(){
    const pendingRows=getProposals('pending'),pending=getProposalCounts().pending;
    if(document.getElementById('tv2-proposal-overlay'))acknowledgePendingProposals(pendingRows);
    const unseen=getUnseenPendingProposalCount(pendingRows);
    const proposalBadge=$id('tv2_proposal_launcher_count');const proposalButton=$id('tv2_open_proposals');
    if(proposalBadge){proposalBadge.textContent=String(pending);proposalBadge.hidden=false;proposalBadge.setAttribute('aria-label',`${pending} pending Lore Proposal${pending===1?'':'s'}`);}
    proposalButton?.classList.toggle('has-pending',unseen>0);
    if(proposalButton)proposalButton.title=unseen?`${unseen} new Lore Proposal${unseen===1?'':'s'} · ${pending} pending total`:pending?`${pending} pending Lore Proposal${pending===1?'':'s'} · all viewed`:'No pending Lore Proposals';
    const stats=memoryStats(),enabled=getSettings().memoryBank?.enabled===true;
    const memoryBadge=$id('tv2_memory_launcher_status'),memoryButton=$id('tv2_open_memory');
    if(memoryBadge){memoryBadge.textContent=String(enabled?stats.active:0);memoryBadge.setAttribute('aria-label',enabled?`${stats.active} active recursive memories`:'Memory Bank is off');}
    memoryButton?.classList.toggle('is-active',enabled);
    if(memoryButton)memoryButton.title=enabled?`${stats.active} active recursive memories`:'Recursive Memory Bank is off';
    const cb=characterBankSummary();
    const cbStatus=$id('tv2_character_bank_launcher_status');
    if(cbStatus)cbStatus.textContent=cb.count?`Character Banks: ${cb.count} configured · ${cb.leadCount} Lead · ${cb.warmCount} warm · ${cb.linkedRefs} linked lore`: 'Character Banks: none configured';
}

function updateMainControlsVisibility(){const main=$id('tv2_main_controls');if(main)main.style.display=$id('tv2_enabled')?.checked===true?'block':'none';}


function exactReviewPayload(label,value){
    let json='';try{json=JSON.stringify(value??{},null,2);}catch{json='[unavailable]';}
    return `<details class="tv2-review-details"><summary>${esc(label)}</summary><pre>${esc(json)}</pre></details>`;
}
function renderCallCenterReviewQueue(){
    const host=$id('tv2_nexus_call_review_list'),count=$id('tv2_nexus_call_review_count');if(!host)return;
    const settings=getSettings().nexus?.callCenter||{};
    const policyEnabled=settings.enabled===true&&settings.mainModelAccess===true;
    const gateway=getActiveNexusToolGateway();
    if(!gateway){if(count)count.textContent='';host.innerHTML='<div class="tv2-help">Function Gateway is unavailable. Pending reviews may still exist.</div>';return;}
    let pending;try{pending=gateway.pendingReviews({boundaryOffset:callReviewBoundaryOffset,boundaryLimit:100});}catch(error){if(count)count.textContent='';host.innerHTML=`<div class="tv2-help">Review queue unavailable: ${esc(error?.message||String(error))}. Pending reviews may still exist.</div>`;return;}
    const boundary=pending?.boundaryRequests||[],transactions=pending?.transactions||[],page=pending?.boundaryPage||{total:boundary.length,offset:0,limit:100};
    const total=Number(pending?.total??(page.total+transactions.length));if(count)count.textContent=String(total);
    const rows=[];
    if(!policyEnabled)rows.push(`<div class="tv2-help"><b>Main-model Function Gateway is disabled for new calls.</b> ${total} pending review row(s) still need attention.</div>`);
    if(!total){rows.push('<div class="tv2-help">No pending Main requests or staged external mutations.</div>');host.innerHTML=rows.join('');return;}
    if(page.total){rows.push(`<div class="tv2-call-review-page"><span>Boundary approvals ${page.offset+1}-${Math.min(page.total,page.offset+boundary.length)} of ${page.total}</span><button class="menu_button tv2-call-review-page-prev" type="button" ${page.hasPrevious?'':'disabled'}>Previous</button><button class="menu_button tv2-call-review-page-next" type="button" ${page.hasNext?'':'disabled'}>Next</button></div>`);}
    for(const request of boundary){rows.push(`<div class="tv2-call-review-row" data-review-kind="boundary" data-review-id="${esc(request.ticketId)}"><div class="tv2-call-review-main"><b>${esc(request.capability)}</b><span>Policy approval required · Ticket ${esc(request.ticketId)} · ${request.automatic?'automatic':'manual'} · ${esc(request.source||'unknown source')}</span>${exactReviewPayload('Review exact arguments',request.arguments)}${exactReviewPayload('Canonical target',request.target)}</div><div class="tv2-call-review-actions"><button class="menu_button tv2-call-review-approve" type="button">Approve request</button><button class="menu_button tv2-call-review-reject" type="button">Reject</button></div></div>`);}
    for(const tx of transactions){rows.push(`<div class="tv2-call-review-row" data-review-kind="transaction" data-review-id="${esc(tx.transactionId)}"><div class="tv2-call-review-main"><b>${esc(tx.capability)}</b><span>Mutation review · Request ${esc(tx.transactionId)}</span>${exactReviewPayload('Review exact arguments',tx.arguments)}${exactReviewPayload('Proposed change',tx.mutationProposal)}${exactReviewPayload('Safety checks',tx.assumptions)}</div><div class="tv2-call-review-actions"><button class="menu_button tv2-primary-action tv2-call-review-approve" type="button">Approve & Commit</button><button class="menu_button tv2-call-review-reject" type="button">Reject</button></div></div>`);}
    host.innerHTML=rows.join('');
}
async function handleCallCenterReviewAction(event){
    const pageButton=event.target.closest?.('.tv2-call-review-page-prev,.tv2-call-review-page-next');
    if(pageButton){const delta=pageButton.classList.contains('tv2-call-review-page-next')?100:-100;callReviewBoundaryOffset=Math.max(0,callReviewBoundaryOffset+delta);renderCallCenterReviewQueue();return;}
    const button=event.target.closest?.('.tv2-call-review-approve,.tv2-call-review-reject');if(!button)return;
    const row=button.closest('.tv2-call-review-row'),gateway=getActiveNexusToolGateway();if(!row||!gateway)return;
    const kind=row.dataset.reviewKind,id=row.dataset.reviewId,approve=button.classList.contains('tv2-call-review-approve');button.disabled=true;
    try{
        let result;
        if(kind==='boundary')result=approve?await gateway.approveBoundaryRequest(id,{logic:{targetHealth:'healthy'}}):await gateway.rejectBoundaryRequest(id,'Rejected by operator from Tool-call Switchboard.');
        else result=approve?await gateway.approveTransaction(id,{by:'operator',metadata:{surface:'tool-call-switchboard'}}):await gateway.rejectTransaction(id,'Rejected by operator from Tool-call Switchboard.');
        if(['completed','committed'].includes(result?.state)){globalThis.toastr?.success(kind==='boundary'?'Main request approved and moved to mutation review.':'External change committed successfully.','Nexus');}
        else if(result?.state==='stale'){globalThis.toastr?.warning('The staged external mutation became stale. Re-request it from current state.','Nexus');}
        else if(['rejected','aborted'].includes(result?.state)){globalThis.toastr?.info('External request rejected.','Nexus');}
        else if(result?.state==='blocked'||result?.state==='failed')globalThis.toastr?.warning(result?.error||'External review action was blocked.','Nexus');
        renderCallCenterReviewQueue();renderOperatorLaunchers();
    }catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus');renderCallCenterReviewQueue();}
    finally{button.disabled=false;}
}

function renderNexusCoordinationStatus(){
    const el=$id('tv2_nexus_coordination_status');if(!el)return;
    const nexus=getSettings().nexus||{};
    const mode=inferNexusCoordinationMode(nexus);
    const selected=[...new Set((Array.isArray(nexus.migration?.migratedWorkloads)?nexus.migration.migratedWorkloads:[]).map(value=>String(value||'').trim()).filter(Boolean))];
    const known=selected.filter(value=>NEXUS_DIRECTOR_LIFECYCLE_WORKLOADS.includes(value));
    const fallback=nexus.useLegacyFallback!==false?'legacy fallback ON':'legacy fallback OFF';
    if(mode===NEXUS_COORDINATION_MODE.LEGACY){el.textContent='Legacy lifecycle · Director OFF · legacy lifecycle remains authoritative.';el.dataset.state='idle';return;}
    if(mode===NEXUS_COORDINATION_MODE.SHADOW){el.textContent='Shadow Director · deterministic plans only · no migrated workload executes.';el.dataset.state='idle';return;}
    if(mode===NEXUS_COORDINATION_MODE.FULL){el.textContent=`Full Director · ${known.length}/${NEXUS_DIRECTOR_LIFECYCLE_WORKLOADS.length} lifecycle workloads selected · runtime executor coverage is verified before execution · ${fallback}.`;el.dataset.state='busy';return;}
    el.textContent=`Custom / hybrid migration preserved · ${known.length}/${NEXUS_DIRECTOR_LIFECYCLE_WORKLOADS.length} known lifecycle workloads selected · ${fallback}.`;
    el.dataset.state='busy';
}

function renderNexusBatchLayerStatus(){
    const el=$id('tv2_nexus_batch_layer_status');if(!el)return;
    const status=getNexusBatchStatus();
    const enabled=(status.domains||[]).filter(row=>row.enabled).map(row=>row.label).join(', ')||'none';
    const last=status.lastOutcome;
    const lastText=last?`${last.state} · ${last.domain||'worker'} · ${last.itemCount??0} item${Number(last.itemCount)===1?'':'s'} · ${last.waveCount??0} wave${Number(last.waveCount)===1?'':'s'}${Number(last.recoveredCount)>0?` · ${last.recoveredCount} recovered`:''}`:'no batch wave yet';
    el.textContent=`Batching · enabled domains: ${enabled} · coalesce ${status.coalesceMs} ms · max ${status.maxBatchItems} jobs/wave · wave target ${status.targetInputTokens} tokens · queued ${status.queuedUnits} · last: ${lastText}`;
    el.dataset.state=Number(status.queuedUnits)>0?'busy':'idle';
}
function renderCallCenterStatus(message=null,state=null){
    const el=$id('tv2_nexus_call_center_status');if(!el)return;
    if(message){el.textContent=message;el.dataset.state=state||'idle';return;}
    const settings=getSettings(),c=settings.nexus?.callCenter||{},mainWorker=settings.nexus?.modelWorker?.useMain===true;
    const mainAccess=c.enabled===true&&c.mainModelAccess===true&&mainWorker;
    if(!mainAccess){el.textContent='Main access is OFF. Nexus background work and Main-boundary tool access cannot use Main.';el.dataset.state='idle';return;}
    if(c.testHarnessEnabled===false){el.textContent='Main access is ON. Developer loopback testing is disabled; normal gateway policy remains active.';el.dataset.state='idle';return;}
    el.textContent=`Main access ON · Function Gateway ready · ${Number(c.cooldownMs)||0} ms advanced tool-ticket cooldown.`;
    el.dataset.state='idle';
}

async function runCallCenterTest(){
    if(!(await save()))return;const button=$id('tv2_nexus_call_center_test');if(button)button.disabled=true;
    try{
        const c=getSettings().nexus?.callCenter||{};
        const capability=$id('tv2_nexus_call_center_test_capability')?.value||'search';
        const approved=$id('tv2_nexus_call_center_test_approval')?.checked===true;
        const signature=JSON.stringify(c);
        if(!callCenterHarness||callCenterHarnessSignature!==signature){callCenterHarness=createCallCenterTestHarness(c);callCenterHarnessSignature=signature;}
        const harness=callCenterHarness;
        const result=await harness.test({capability,approved});
        if(result.state==='completed'){
            renderCallCenterStatus(`✓ Loopback complete · ${result.ticket.capability} passed policy + Logic Gate + adapter. No model or ST request was made.`,'success');
            globalThis.toastr?.success(`Call Center loopback passed for ${result.ticket.capability}.`,'Nexus');
        }else if(result.state==='awaiting-approval'){
            renderCallCenterStatus(`Approval gate is working · ${result.ticket.capability} is staged for approval, not dispatched.`,'idle');
            globalThis.toastr?.info(`Approval is required for ${result.ticket.capability}.`,'Nexus');
        }else{
            const reason=result.error||result.gate?.reason||result.decision?.reason||'blocked';
            renderCallCenterStatus(`Gate blocked ${result.ticket.capability}: ${reason}`,'failed');
            globalThis.toastr?.warning(`Call Center test blocked: ${reason}`,'Nexus');
        }
    }catch(error){renderCallCenterStatus(`Call Center test failed: ${error?.message||String(error)}`,'failed');globalThis.toastr?.error(error?.message||String(error),'Nexus');}
    finally{if(button)button.disabled=false;}
}


async function runMainColdOpenProof(){
    if(!(await save()))return;
    const button=$id('tv2_nexus_main_draft_test'),resultEl=$id('tv2_nexus_main_draft_result');
    if(button)button.disabled=true;
    if(resultEl)resultEl.value='';
    try{
        const settings=getSettings().nexus?.callCenter||{};
        if(settings.enabled!==true||settings.mainModelAccess!==true)throw new Error('Enable Call Center and Main-model Function Gateway first.');
        const prompt=String($id('tv2_nexus_main_draft_prompt')?.value||'').trim();
        const runtime=getNexusRuntime();
        runtime.configureCallCenter(settings);
        const result=await dispatchManualMainDraft(runtime,{prompt,responseLength:320,contextPolicy:{mode:'minimal'},metadata:{surface:'settings-main-proof'}});
        if(result.state==='completed'){
            const text=typeof result.result==='string'?result.result:JSON.stringify(result.result,null,2);
            if(resultEl)resultEl.value=text||'';
            globalThis.toastr?.success('Main cold-open proof completed through the typed Call Center boundary.','Nexus');
        }else{
            const reason=result.error||result.gate?.reason||result.decision?.reason||result.state;
            if(resultEl)resultEl.value=`Blocked: ${reason}`;
            globalThis.toastr?.warning(`Main cold-open proof ${result.state}: ${reason}`,'Nexus');
        }
    }catch(error){
        if(resultEl)resultEl.value=`Failed: ${error?.message||String(error)}`;
        globalThis.toastr?.error(error?.message||String(error),'Nexus Main proof failed');
    }finally{if(button)button.disabled=false;}
}

function updateRoutingLockUI(){
    const retrievalLock=$id('tv2_lock_retrieval')?.value||'';
    if($id('tv2_route_retrieval'))$id('tv2_route_retrieval').disabled=!!retrievalLock;
    document.querySelectorAll('.tv2-mode-check[data-mode-group="retrieval"]').forEach(el=>el.disabled=!!retrievalLock);
    const injectionLock=$id('tv2_lock_lore_injection')?.value||'';
    if($id('tv2_route_lore_injection'))$id('tv2_route_lore_injection').disabled=!!injectionLock;
    if($id('tv2_mode_lore_injection'))$id('tv2_mode_lore_injection').disabled=!!injectionLock;
}


function compactTokenLimit(value){const n=Number(value);if(!Number.isFinite(n)||n<=0)return null;if(n>=1_000_000)return `${(n/1_000_000).toFixed(n%1_000_000?1:0)}M`;if(n>=1000)return `${(n/1000).toFixed(n%1000?1:0)}K`;return String(Math.floor(n));}
function renderTokenLimitSummary(slot,profile=null){
    const p=profile||getSettings().sidecars?.[slot]||{};
    const bits=[];
    const input=compactTokenLimit(p.inputBudgetTokens);if(input)bits.push(`${input} soft in`);
    const output=compactTokenLimit(p.outputCeilingTokens);if(output)bits.push(`${output} out cost cap`);
    const total=compactTokenLimit(p.totalBudgetTokens);if(total)bits.push(`${total} total cost cap`);
    const el=$id(`tv2_sidecar_${slot.toLowerCase()}_token_summary`);if(el)el.textContent=bits.length?bits.join(' · '):'No cost cap';
}

function updateProviderCapVisibility(){
    // Provider context/output capacities are physical-boundary metadata for all
    // formats. Leave both fields visible; blank means capability unknown and
    // Nexus uses the generous emergency circuit breaker.
    for(const slot of ['a','b']){
        const row=$id(`tv2_sidecar_${slot}_provider_cap_row`);
        if(row)row.style.display='';
    }
}

function capValue(slot,key,defaultValue=true){
    const idMap={region:'region',node:'node',search:'search',injection:'injection',smart:'smart',postturn:'postturn',summary:'summary'};
    const el=$id(`tv2_sidecar_${slot.toLowerCase()}_cap_${idMap[key]}`);
    return el?el.checked===true:defaultValue;
}

function readProfile(slot){
    const x=slot.toLowerCase();
    const old=getSettings().sidecars?.[slot]||{};
    const model=$id(`tv2_sidecar_${x}_model`)?.value?.trim()||'';
    const modelChanged=String(model)!==String(old.model||'');
    return {
        ...old,
        enabled:$id(`tv2_sidecar_${x}_enabled`)?.checked===true,
        format:$id(`tv2_sidecar_${x}_format`)?.value||'openai',
        endpoint:$id(`tv2_sidecar_${x}_endpoint`)?.value?.trim()||'',
        apiKey:$id(`tv2_sidecar_${x}_key`)?.value||'',
        model,
        providerMaxTokens:modelChanged?null:optionalPositive(`tv2_sidecar_${x}_provider_tokens`),
        providerContextTokens:modelChanged?null:optionalPositive(`tv2_sidecar_${x}_provider_context_tokens`),
        inputBudgetTokens:optionalPositive(`tv2_sidecar_${x}_input_budget`),
        outputCeilingTokens:optionalPositive(`tv2_sidecar_${x}_output_budget`),
        totalBudgetTokens:optionalPositive(`tv2_sidecar_${x}_total_budget`),
        temperature:number(`tv2_sidecar_${x}_temp`,0.3,0,2),
        reasoningEffort:$id(`tv2_sidecar_${x}_reasoning`)?.value||'auto',
        timeoutMs:Math.max(1000,number(`tv2_sidecar_${x}_timeout`,120000,1000)),
        capabilities:{
            ...(old.capabilities||{}),
            regionScan:capValue(slot,'region'),
            nodeScan:capValue(slot,'node'),
            search:capValue(slot,'search'),
            loreInjection:capValue(slot,'injection'),
            smartContext:capValue(slot,'smart'),
            postTurn:capValue(slot,'postturn'),
            summaries:capValue(slot,'summary'),
        },
    };
}

function hydrateProfile(slot,p){
    const x=slot.toLowerCase(),caps=p.capabilities||{};
    set(`tv2_sidecar_${x}_enabled`,p.enabled,'checked');
    set(`tv2_sidecar_${x}_format`,p.format);
    set(`tv2_sidecar_${x}_endpoint`,p.endpoint);
    set(`tv2_sidecar_${x}_key`,p.apiKey);
    set(`tv2_sidecar_${x}_model`,p.model);
    set(`tv2_sidecar_${x}_provider_tokens`,p.providerMaxTokens??'');
    set(`tv2_sidecar_${x}_provider_context_tokens`,p.providerContextTokens??'');
    set(`tv2_sidecar_${x}_input_budget`,p.inputBudgetTokens??'');
    set(`tv2_sidecar_${x}_output_budget`,p.outputCeilingTokens??'');
    set(`tv2_sidecar_${x}_total_budget`,p.totalBudgetTokens??'');
    set(`tv2_sidecar_${x}_temp`,p.temperature??0.3);
    set(`tv2_sidecar_${x}_reasoning`,p.reasoningEffort||'auto');
    set(`tv2_sidecar_${x}_timeout`,p.timeoutMs||120000);
    set(`tv2_sidecar_${x}_cap_region`,caps.regionScan!==false,'checked');
    set(`tv2_sidecar_${x}_cap_node`,caps.nodeScan!==false,'checked');
    set(`tv2_sidecar_${x}_cap_search`,caps.search!==false,'checked');
    set(`tv2_sidecar_${x}_cap_injection`,caps.loreInjection!==false,'checked');
    set(`tv2_sidecar_${x}_cap_smart`,caps.smartContext!==false,'checked');
    set(`tv2_sidecar_${x}_cap_postturn`,caps.postTurn!==false,'checked');
    set(`tv2_sidecar_${x}_cap_summary`,caps.summaries!==false,'checked');
    const health=p.lastHealth,$health=$id(`tv2_sidecar_${x}_check_status`);
    if($health&&health?.checkedAt){const ageMs=Math.max(0,Date.now()-Number(health.checkedAt));const age=ageMs<60000?`${Math.max(1,Math.round(ageMs/1000))}s`:ageMs<3600000?`${Math.round(ageMs/60000)}m`:`${Math.round(ageMs/3600000)}h`;$health.textContent=`Last check ${health.usable?'usable':'not usable'} · ${age} ago · ${health.model||p.model||'model'}. Recheck before relying on it.`;}
    renderTokenLimitSummary(slot,p);
}

export function hydrateUI(){
    const s=getSettings();
    try { mountDecisionCoreSettings($id('tv2_decision_core_settings_mount')); } catch (error) { logEvent('decision-core','settings-render-failed',{error},'error'); }
    if(!currentLorebook){const preferred=String(s.selectedLorebook||'');currentLorebook=lorebookNames().includes(preferred)?preferred:(lorebookNames()[0]||null);}
    set('tv2_enabled',s.enabled,'checked');
    set('tv2_nexus_coordination_mode',inferNexusCoordinationMode(s.nexus||{}));
    set('tv2_nexus_resource_enabled',s.nexus?.resourcePolicy?.enabled!==false,'checked');
    set('tv2_nexus_input_retrieval',s.nexus?.resourcePolicy?.roleInputTargets?.retrieval??24000);
    set('tv2_nexus_input_lore',s.nexus?.resourcePolicy?.roleInputTargets?.loreInjection??20000);
    set('tv2_nexus_input_postturn',s.nexus?.resourcePolicy?.roleInputTargets?.postTurn??16000);
    set('tv2_nexus_input_summaries',s.nexus?.resourcePolicy?.roleInputTargets?.summaries??20000);
    set('tv2_nexus_input_maintenance',s.nexus?.resourcePolicy?.roleInputTargets?.maintenance??12000);
    set('tv2_nexus_input_treebuild',s.nexus?.resourcePolicy?.roleInputTargets?.treeBuild??24000);
    set('tv2_nexus_input_notebook',s.nexus?.resourcePolicy?.domainInputTargets?.notebook??12000);
    set('tv2_nexus_cap_retrieval',s.nexus?.resourcePolicy?.roleOutputTargets?.retrieval??4096);
    set('tv2_nexus_cap_lore',s.nexus?.resourcePolicy?.roleOutputTargets?.loreInjection??3072);
    set('tv2_nexus_cap_postturn',s.nexus?.resourcePolicy?.roleOutputTargets?.postTurn??3072);
    set('tv2_nexus_cap_summaries',s.nexus?.resourcePolicy?.roleOutputTargets?.summaries??3072);
    set('tv2_nexus_cap_maintenance',s.nexus?.resourcePolicy?.roleOutputTargets?.maintenance??2048);
    set('tv2_nexus_cap_treebuild',s.nexus?.resourcePolicy?.roleOutputTargets?.treeBuild??4096);
    set('tv2_nexus_cap_notebook',s.nexus?.resourcePolicy?.domainOutputTargets?.notebook??2400);
    set('tv2_nexus_cap_synthesis',s.nexus?.resourcePolicy?.phaseOutputTargets?.['parallel-synthesis']??2048);
    set('tv2_nexus_synthesis_input',s.nexus?.resourcePolicy?.synthesis?.promptTargetTokens??12000);
    set('tv2_nexus_call_center_enabled',s.nexus?.callCenter?.enabled===true,'checked');
    set('tv2_nexus_call_center_main_access',s.nexus?.callCenter?.mainModelAccess===true,'checked');
    set('tv2_nexus_main_worker_enabled',s.nexus?.modelWorker?.useMain===true,'checked');
    set('tv2_nexus_call_center_test_harness',s.nexus?.callCenter?.testHarnessEnabled!==false,'checked');
    set('tv2_nexus_call_center_automatic',s.nexus?.callCenter?.allowAutomatic===true,'checked');
    set('tv2_nexus_call_center_cooldown',s.nexus?.callCenter?.cooldownMs??1500);
    set('tv2_nexus_policy_search',s.nexus?.callCenter?.policy?.search||'allow');
    set('tv2_nexus_policy_cold_open',s.nexus?.callCenter?.policy?.['cold-open']||'ask');
    const mutationPolicyValues=['remember','update','delete','summarize','organize','merge','split'].map(key=>s.nexus?.callCenter?.policy?.[key]||'ask');
    set('tv2_nexus_policy_mutations',mutationPolicyValues.every(value=>value===mutationPolicyValues[0])?mutationPolicyValues[0]:'mixed');
    set('tv2_nexus_batch_enabled',s.nexus?.batchLayer?.enabled!==false,'checked');
    set('tv2_nexus_batch_coalesce',s.nexus?.batchLayer?.coalesceMs??45);
    set('tv2_nexus_batch_max_items',s.nexus?.batchLayer?.maxBatchItems??10);
    set('tv2_nexus_batch_target_tokens',s.nexus?.batchLayer?.targetInputTokens??7000);
    set('tv2_lorebook_builder_entries',s.nexus?.lorebookBuilder?.semanticPacking?.maxEntriesPerRequest??12);
    set('tv2_lorebook_builder_tokens',s.nexus?.lorebookBuilder?.semanticPacking?.targetInputTokens??3500);
    set('tv2_nexus_batch_domain_uid',s.nexus?.batchLayer?.domains?.['uid-summarizer']!==false,'checked');
    set('tv2_nexus_batch_domain_merge',s.nexus?.batchLayer?.domains?.merge!==false,'checked');
    set('tv2_nexus_batch_domain_tree',s.nexus?.batchLayer?.domains?.tree!==false,'checked');
    set('tv2_nexus_batch_domain_notebook',s.nexus?.batchLayer?.domains?.notebook!==false,'checked');
    set('tv2_nexus_batch_domain_memory',s.nexus?.batchLayer?.domains?.['memory-bank']!==false,'checked');
    set('tv2_nexus_batch_domain_lorebook',s.nexus?.batchLayer?.domains?.lorebook!==false,'checked');
    set('tv2_nexus_batch_domain_reasoning',s.nexus?.batchLayer?.domains?.reasoning!==false,'checked');
    set('tv2_retrieval_enabled',s.retrieval.enabled,'checked');
    set('tv2_postturn_enabled',s.postTurn.enabled,'checked');
    set('tv2_memory_enabled',s.memoryBank?.enabled===true,'checked');
    set('tv2_memory_enabled_settings',s.memoryBank?.enabled===true,'checked');
    set('tv2_character_banks_enabled_front',s.memoryBank?.characterBanks?.enabled!==false,'checked');
    set('tv2_scheduler_enabled',s.scheduler?.enabled!==false,'checked');
    set('tv2_scheduler_automatic',s.scheduler?.automatic!==false,'checked');
    set('tv2_scheduler_task_postturn',s.scheduler?.tasks?.postTurn!==false,'checked');
    set('tv2_scheduler_task_summary',s.scheduler?.tasks?.summary!==false,'checked');
    set('tv2_scheduler_task_promotion',s.scheduler?.tasks?.promotion!==false,'checked');
    set('tv2_scheduler_task_lore',s.scheduler?.tasks?.loreRouting!==false,'checked');
    set('tv2_scheduler_task_warm',s.scheduler?.tasks?.smartWarm!==false,'checked');
    set('tv2_scheduler_task_housekeeper',s.scheduler?.tasks?.housekeeper!==false,'checked');
    set('tv2_scheduler_interval_postturn',s.scheduler?.intervals?.postTurn??0);
    set('tv2_scheduler_interval_summary',s.scheduler?.intervals?.summary??0);
    set('tv2_scheduler_interval_promotion',s.scheduler?.intervals?.promotion??0);
    set('tv2_scheduler_interval_lore',s.scheduler?.intervals?.loreRouting??0);
    set('tv2_scheduler_interval_warm',s.scheduler?.intervals?.smartWarm??0);
    set('tv2_scheduler_interval_housekeeper',s.scheduler?.intervals?.housekeeper??0);
    set('tv2_memory_verbatim',s.memoryBank?.verbatimTurns??10);
    set('tv2_memory_turns_batch',s.memoryBank?.turnsPerSummary??3);
    set('tv2_main_context_governor_enabled',s.memoryBank?.mainContext?.enabled!==false,'checked');
    set('tv2_main_context_max_turns',s.memoryBank?.mainContext?.maxRawAssistantTurns??18);
    set('tv2_memory_layer_size',s.memoryBank?.snippetsPerLayer??20);
    set('tv2_memory_promotion_size',s.memoryBank?.snippetsPerPromotion??3);
    set('tv2_memory_max_layers',s.memoryBank?.maxLayers??5);
    set('tv2_memory_timeout',s.memoryBank?.timeoutMs??240000);
    set('tv2_memory_recall_enabled',s.memoryBank?.recall?.enabled!==false,'checked');
    set('tv2_memory_recall_rerank',s.memoryBank?.recall?.sidecarRerank!==false,'checked');
    set('tv2_memory_recall_messages',s.memoryBank?.recall?.contextMessages??8);
    set('tv2_memory_recall_budget',s.memoryBank?.recall?.maxInjectionTokens??'');
    set('tv2_memory_lore_enabled',s.memoryBank?.loreRouting?.enabled!==false,'checked');
    set('tv2_memory_lore_mode',s.memoryBank?.loreRouting?.mode||'balanced');
    set('tv2_memory_lore_per_cycle',s.memoryBank?.loreRouting?.maxPerCycle??1);
    set('tv2_lore_write_valve',s.loreWriteValve?.mode||'review');
    const importRecovery=inspectImportRecoveryState();
    const importRecoveryStatus=$id('tv2_import_recovery_status');
    if(importRecoveryStatus){
        const active=importRecovery.active;
        const state=importRecovery.activeClassification?.state||'none';
        importRecoveryStatus.textContent=active
            ? `Active recovery: ${active.id||'(unknown)'} · ${state} · deferred ${importRecovery.deferredCount}`
            : `No active recovery fence · deferred ${importRecovery.deferredCount}${importRecovery.currentChatDeferred?.length?` · ${importRecovery.currentChatDeferred.length} for this chat`:''}`;
    }
    set('tv2_notebook_enabled',s.notebook?.enabled!==false,'checked');
    set('tv2_notebook_automatic',s.notebook?.automatic!==false,'checked');
    set('tv2_notebook_cold_start',s.notebook?.coldStart?.enabled!==false,'checked');
    set('tv2_notebook_cold_start_cap',s.notebook?.coldStart?.maxTokens??700);
    set('tv2_change_gate_enabled',s.retrieval.changeGateEnabled!==false,'checked');
    set('tv2_retrieval_messages',s.retrieval.contextMessages??10);
    set('tv2_nochange_refresh',s.retrieval.refreshAfterNoChangeTurns??3);
    set('tv2_region_preview_depth',s.retrieval.regionPreviewDepth??2);
    set('tv2_injection_budget',s.retrieval.maxInjectionTokens??'');
    set('tv2_bootstrap_admission_enabled',s.retrieval?.bootstrapAdmission?.enabled!==false,'checked');
    set('tv2_bootstrap_admission_tokens',s.retrieval?.bootstrapAdmission?.targetTokens??3500);
    set('tv2_bootstrap_admission_entries',s.retrieval?.bootstrapAdmission?.maxEntries??24);
    set('tv2_batch_fire_enabled',s.retrieval.batchFireEnabled!==false,'checked');
    set('tv2_batch_activation_tokens',s.retrieval.batchActivationInputTokens??9000);
    set('tv2_batch_target_tokens',s.retrieval.batchTargetInputTokens??6000);
    set('tv2_batch_condense',s.retrieval.batchCondense!==false,'checked');
    set('tv2_batch_condense_min',s.retrieval.batchCondenseMinCandidates??5);
    set('tv2_batch_reroute_failure',s.retrieval.batchRerouteOnFailure!==false,'checked');
    set('tv2_batch_lore_injection',s.retrieval.batchLoreInjectionEnabled!==false,'checked');
    set('tv2_batch_allow_partial',s.retrieval.batchAllowPartial!==false,'checked');
    set('tv2_smart_context_enabled',s.smartContext?.enabled!==false,'checked');
    set('tv2_smart_context_rerank',s.smartContext?.sidecarRerank!==false,'checked');
    set('tv2_smart_context_messages',s.smartContext?.contextMessages??8);
    set('tv2_smart_context_pool',s.smartContext?.candidatePoolSize??'');
    set('tv2_smart_context_cache_age',s.smartContext?.cacheMaxAgeMs??300000);
    set('tv2_smart_context_decay',s.smartContext?.decay?.enabled!==false,'checked');
    set('tv2_smart_context_decay_misses',s.smartContext?.decay?.maxMisses??3);
    hydrateProfile('A',s.sidecars.A);hydrateProfile('B',s.sidecars.B);
    set('tv2_route_retrieval',s.routing.retrieval||'A');
    set('tv2_route_lore_injection',s.routing.loreInjection||s.routing.retrieval||'A');
    set('tv2_lock_retrieval',s.routing.locks?.retrieval||'');
    set('tv2_lock_lore_injection',s.routing.locks?.loreInjection||'');
    set('tv2_route_postturn',s.routing.postTurn||'B');
    set('tv2_route_summaries',s.routing.summaries||'B');
    set('tv2_route_maintenance',s.routing.maintenance||'B');
    set('tv2_route_treebuild',s.routing.treeBuild||'B');
    setModeGroup('retrieval',s.routing.modes?.retrieval||'adaptive');
    set('tv2_mode_lore_injection',s.routing.modes?.loreInjection||'adaptive');
    set('tv2_mode_postturn',s.routing.modes?.postTurn||'adaptive');
    set('tv2_mode_summaries',s.routing.modes?.summaries||'adaptive');
    set('tv2_route_fallback',s.routing.fallback,'checked');
    set('tv2_route_load_balance',s.routing.loadBalance!==false,'checked');
    set('tv2_obs_persist',s.observability?.persistSession!==false,'checked');
    set('tv2_obs_payloads',s.observability?.capturePayloads!==false,'checked');
    set('tv2_obs_max_events',s.observability?.maxEvents||500);
    set('tv2_obs_capture_chars',s.observability?.captureChars??4000);
    const theme=normalizeTheme(s.appearance||{});
    set('tv2_theme_preset',theme.preset);
    set('tv2_theme_font',theme.font);
    set('tv2_theme_shape',theme.shape);
    set('tv2_theme_background',theme.background);
    set('tv2_theme_surface',theme.surface);
    set('tv2_theme_surface_alt',theme.surfaceAlt);
    set('tv2_theme_accent',theme.accent);
    set('tv2_theme_accent2',theme.accent2);
    set('tv2_theme_text',theme.text);
    set('tv2_theme_muted',theme.muted);
    set('tv2_theme_border',theme.border);
    applyTv2Theme(theme);
    renderLogLauncher();renderSmartContextBadges();renderSchedulerStatus();renderCallCenterStatus();renderNexusCoordinationStatus();renderNexusBatchLayerStatus();updateProviderCapVisibility();updateRoutingLockUI();renderLorebookList();renderSelectedLorebook();updateMainControlsVisibility();renderUiPresentation();
}

async function save(){
    const current=getSettings();
    // The SillyTavern Extensions drawer may be dismissed/rebuilt while a UI
    // change is still settling. Never let a detached/partial settings DOM turn
    // missing controls into authority changes (especially tv2_enabled -> false).
    const settingsRoot=$id('tv2_settings');
    const enabledControl=$id('tv2_enabled');
    if(!settingsRoot?.isConnected||!enabledControl||!settingsRoot.contains(enabledControl)){
        logEvent('settings','save-skipped',{reason:'settings-ui-detached-or-incomplete'},'debug');
        return current;
    }
    const previousCoordinationMode=inferNexusCoordinationMode(current.nexus||{});
    const previousMainWorkerEnabled=current.enabled===true&&current.nexus?.modelWorker?.useMain===true;
    const coordinationMode=$id('tv2_nexus_coordination_mode')?.value||NEXUS_COORDINATION_MODE.HYBRID;
    const mutationPolicy=$id('tv2_nexus_policy_mutations')?.value||'mixed';
    const existingMutationPolicy={...(current.nexus?.callCenter?.policy||{})};
    const mutationPolicyPatch=mutationPolicy==='mixed'?{}:{remember:mutationPolicy,update:mutationPolicy,delete:mutationPolicy,summarize:mutationPolicy,organize:mutationPolicy,merge:mutationPolicy,split:mutationPolicy};
    const testHarnessControl=$id('tv2_nexus_call_center_test_harness');
    const desiredCallCenter={...(current.nexus?.callCenter||{}),enabled:$id('tv2_nexus_call_center_enabled')?.checked===true,testHarnessEnabled:testHarnessControl?testHarnessControl.checked===true:current.nexus?.callCenter?.testHarnessEnabled===true,allowAutomatic:$id('tv2_nexus_call_center_automatic')?.checked===true,mainModelAccess:$id('tv2_nexus_call_center_main_access')?.checked===true,cooldownMs:Math.max(0,number('tv2_nexus_call_center_cooldown',1500,0,600000)),policy:{...existingMutationPolicy,search:$id('tv2_nexus_policy_search')?.value||'allow','cold-open':$id('tv2_nexus_policy_cold_open')?.value||'ask',...mutationPolicyPatch}};
    const rawWriteValveMode=String($id('tv2_lore_write_valve')?.value||'review');
    const desiredWriteValveMode=['review','direct','disabled'].includes(rawWriteValveMode)?rawWriteValveMode:'disabled';
    const settings=updateSettings(s=>{
        s.enabled=$id('tv2_enabled')?.checked===true;
        if(coordinationMode!==NEXUS_COORDINATION_MODE.HYBRID)s.nexus=applyNexusCoordinationMode(s.nexus||{},coordinationMode);
        s.nexus={...(s.nexus||{}),modelWorker:{...(s.nexus?.modelWorker||{}),useMain:$id('tv2_nexus_main_worker_enabled')?.checked===true},resourcePolicy:{...(s.nexus?.resourcePolicy||{}),enabled:$id('tv2_nexus_resource_enabled')?.checked!==false,roleInputTargets:{...(s.nexus?.resourcePolicy?.roleInputTargets||{}),retrieval:Math.floor(number('tv2_nexus_input_retrieval',24000,1000,128000)),loreInjection:Math.floor(number('tv2_nexus_input_lore',20000,1000,128000)),postTurn:Math.floor(number('tv2_nexus_input_postturn',16000,1000,128000)),summaries:Math.floor(number('tv2_nexus_input_summaries',20000,1000,128000)),maintenance:Math.floor(number('tv2_nexus_input_maintenance',12000,1000,128000)),treeBuild:Math.floor(number('tv2_nexus_input_treebuild',24000,1000,128000))},domainInputTargets:{...(s.nexus?.resourcePolicy?.domainInputTargets||{}),notebook:Math.floor(number('tv2_nexus_input_notebook',12000,1000,128000))},roleOutputTargets:{...(s.nexus?.resourcePolicy?.roleOutputTargets||{}),retrieval:Math.floor(number('tv2_nexus_cap_retrieval',4096,128,32768)),loreInjection:Math.floor(number('tv2_nexus_cap_lore',3072,128,32768)),postTurn:Math.floor(number('tv2_nexus_cap_postturn',3072,128,32768)),summaries:Math.floor(number('tv2_nexus_cap_summaries',3072,128,32768)),maintenance:Math.floor(number('tv2_nexus_cap_maintenance',2048,128,32768)),treeBuild:Math.floor(number('tv2_nexus_cap_treebuild',4096,128,32768))},domainOutputTargets:{...(s.nexus?.resourcePolicy?.domainOutputTargets||{}),notebook:Math.floor(number('tv2_nexus_cap_notebook',2400,128,32768))},phaseOutputTargets:{...(s.nexus?.resourcePolicy?.phaseOutputTargets||{}),'parallel-synthesis':Math.floor(number('tv2_nexus_cap_synthesis',2048,128,32768)),'consensus-review':Math.floor(number('tv2_nexus_cap_synthesis',2048,128,32768))},synthesis:{...(s.nexus?.resourcePolicy?.synthesis||{}),promptTargetTokens:Math.floor(number('tv2_nexus_synthesis_input',12000,1000,64000))}},callCenter:s.nexus?.callCenter||{}};
        s.nexus.batchLayer={...(s.nexus?.batchLayer||{}),enabled:$id('tv2_nexus_batch_enabled')?.checked!==false,coalesceMs:Math.max(0,number('tv2_nexus_batch_coalesce',45,0,5000)),maxBatchItems:Math.floor(number('tv2_nexus_batch_max_items',10,1,50)),targetInputTokens:Math.floor(number('tv2_nexus_batch_target_tokens',7000,1000,64000)),domains:{...(s.nexus?.batchLayer?.domains||{}),'uid-summarizer':$id('tv2_nexus_batch_domain_uid')?.checked!==false,merge:$id('tv2_nexus_batch_domain_merge')?.checked!==false,tree:$id('tv2_nexus_batch_domain_tree')?.checked!==false,notebook:$id('tv2_nexus_batch_domain_notebook')?.checked!==false,'memory-bank':$id('tv2_nexus_batch_domain_memory')?.checked!==false,lorebook:$id('tv2_nexus_batch_domain_lorebook')?.checked!==false,reasoning:$id('tv2_nexus_batch_domain_reasoning')?.checked!==false}};
        s.nexus.lorebookBuilder={...(s.nexus?.lorebookBuilder||{}),configVersion:1,semanticPacking:{...(s.nexus?.lorebookBuilder?.semanticPacking||{}),maxEntriesPerRequest:Math.floor(number('tv2_lorebook_builder_entries',12,1,50)),targetInputTokens:Math.floor(number('tv2_lorebook_builder_tokens',3500,1000,64000))}};
        s.retrieval.enabled=$id('tv2_retrieval_enabled')?.checked===true;
        s.postTurn.enabled=$id('tv2_postturn_enabled')?.checked===true;
        const memoryEnabled=($id('tv2_memory_enabled_settings')?.checked??$id('tv2_memory_enabled')?.checked)===true;
        s.memoryBank={...(s.memoryBank||{}),enabled:memoryEnabled,verbatimTurns:Math.max(0,number('tv2_memory_verbatim',10,0,500)),turnsPerSummary:Math.max(1,number('tv2_memory_turns_batch',3,1,100)),snippetsPerLayer:Math.max(2,number('tv2_memory_layer_size',20,2,500)),snippetsPerPromotion:Math.max(2,number('tv2_memory_promotion_size',3,2,100)),maxLayers:Math.max(1,number('tv2_memory_max_layers',5,1,12)),timeoutMs:Math.max(1000,number('tv2_memory_timeout',240000,1000))};
        s.memoryBank.mainContext={...(s.memoryBank.mainContext||{}),enabled:$id('tv2_main_context_governor_enabled')?.checked!==false,maxRawAssistantTurns:Math.max(Math.max(3,(s.memoryBank.verbatimTurns||10)+2),Math.floor(number('tv2_main_context_max_turns',18,3,200)))};
        s.memoryBank.characterBanks={...(s.memoryBank.characterBanks||{}),enabled:$id('tv2_character_banks_enabled_front')?.checked!==false};
        s.memoryBank.recall={...(s.memoryBank.recall||{}),enabled:$id('tv2_memory_recall_enabled')?.checked!==false,sidecarRerank:$id('tv2_memory_recall_rerank')?.checked!==false,contextMessages:Math.max(1,number('tv2_memory_recall_messages',8,1,200)),maxInjectionTokens:optionalPositive('tv2_memory_recall_budget')};
        s.memoryBank.loreRouting={...(s.memoryBank.loreRouting||{}),enabled:$id('tv2_memory_lore_enabled')?.checked!==false,mode:$id('tv2_memory_lore_mode')?.value||'balanced',maxPerCycle:Math.max(1,number('tv2_memory_lore_per_cycle',1,1,50))};
        // loreWriteValve.mode is authority-bearing and is committed below only through an awaited durability barrier.
        s.notebook={...(s.notebook||{}),enabled:$id('tv2_notebook_enabled')?.checked!==false,automatic:$id('tv2_notebook_automatic')?.checked!==false,coldStart:{...(s.notebook?.coldStart||{}),enabled:$id('tv2_notebook_cold_start')?.checked!==false,maxTokens:Math.max(100,number('tv2_notebook_cold_start_cap',700,100,4000))}};
        s.scheduler={...(s.scheduler||{}),enabled:$id('tv2_scheduler_enabled')?.checked!==false,automatic:$id('tv2_scheduler_automatic')?.checked!==false,tasks:{...(s.scheduler?.tasks||{}),postTurn:$id('tv2_scheduler_task_postturn')?.checked!==false,summary:$id('tv2_scheduler_task_summary')?.checked!==false,promotion:$id('tv2_scheduler_task_promotion')?.checked!==false,loreRouting:$id('tv2_scheduler_task_lore')?.checked!==false,smartWarm:$id('tv2_scheduler_task_warm')?.checked!==false,housekeeper:$id('tv2_scheduler_task_housekeeper')?.checked!==false},intervals:{...(s.scheduler?.intervals||{}),postTurn:Math.floor(number('tv2_scheduler_interval_postturn',0,0,100)),summary:Math.floor(number('tv2_scheduler_interval_summary',0,0,100)),promotion:Math.floor(number('tv2_scheduler_interval_promotion',0,0,100)),loreRouting:Math.floor(number('tv2_scheduler_interval_lore',0,0,100)),smartWarm:Math.floor(number('tv2_scheduler_interval_warm',0,0,100)),housekeeper:Math.floor(number('tv2_scheduler_interval_housekeeper',0,0,100))}};
        s.retrieval.changeGateEnabled=$id('tv2_change_gate_enabled')?.checked!==false;
        s.retrieval.contextMessages=Math.max(1,number('tv2_retrieval_messages',10,1,200));
        s.retrieval.refreshAfterNoChangeTurns=Math.max(0,number('tv2_nochange_refresh',3,0,100));
        s.retrieval.regionPreviewDepth=Math.max(0,number('tv2_region_preview_depth',2,0,4));
        s.retrieval.maxInjectionTokens=(()=>{const n=Number($id('tv2_injection_budget')?.value);return Number.isFinite(n)&&n>0?n:0;})();
        s.retrieval.bootstrapAdmission={...(s.retrieval.bootstrapAdmission||{}),enabled:$id('tv2_bootstrap_admission_enabled')?.checked!==false,targetTokens:Math.floor(number('tv2_bootstrap_admission_tokens',3500,500,16000)),maxEntries:Math.floor(number('tv2_bootstrap_admission_entries',24,1,100))};
        s.retrieval.batchFireEnabled=$id('tv2_batch_fire_enabled')?.checked!==false;
        s.retrieval.batchActivationInputTokens=Math.max(1200,number('tv2_batch_activation_tokens',9000,1200,128000));
        s.retrieval.batchTargetInputTokens=Math.max(1200,number('tv2_batch_target_tokens',6000,1200,64000));
        s.retrieval.batchCondense=$id('tv2_batch_condense')?.checked!==false;
        s.retrieval.batchCondenseMinCandidates=Math.max(2,number('tv2_batch_condense_min',5,2,100));
        s.retrieval.batchRerouteOnFailure=$id('tv2_batch_reroute_failure')?.checked!==false;
        s.retrieval.batchLoreInjectionEnabled=$id('tv2_batch_lore_injection')?.checked!==false;
        s.retrieval.batchLoreInjectionThresholdTokens=s.retrieval.batchActivationInputTokens;
        s.retrieval.batchAllowPartial=$id('tv2_batch_allow_partial')?.checked!==false;
        s.smartContext={...(s.smartContext||{}),enabled:$id('tv2_smart_context_enabled')?.checked!==false,sidecarRerank:$id('tv2_smart_context_rerank')?.checked!==false,contextMessages:Math.max(1,number('tv2_smart_context_messages',8,1,200)),candidatePoolSize:(()=>{const n=Number($id('tv2_smart_context_pool')?.value);return Number.isFinite(n)&&n>0?n:0;})(),cacheMaxAgeMs:Math.max(1000,number('tv2_smart_context_cache_age',300000,1000)),decay:{...(s.smartContext?.decay||{}),enabled:$id('tv2_smart_context_decay')?.checked!==false,maxMisses:Math.max(1,number('tv2_smart_context_decay_misses',3,1,20))}};
        s.sidecars.A=readProfile('A');s.sidecars.B=readProfile('B');
        s.routing.retrieval=$id('tv2_route_retrieval')?.value||s.routing.retrieval||'A';
        s.routing.loreInjection=$id('tv2_route_lore_injection')?.value||s.routing.loreInjection||s.routing.retrieval||'A';
        s.routing.locks={...(s.routing.locks||{}),retrieval:$id('tv2_lock_retrieval')?.value||null,loreInjection:$id('tv2_lock_lore_injection')?.value||null};
        s.routing.postTurn=$id('tv2_route_postturn')?.value||s.routing.postTurn||'B';
        s.routing.summaries=$id('tv2_route_summaries')?.value||s.routing.summaries||'B';
        s.routing.maintenance=$id('tv2_route_maintenance')?.value||s.routing.maintenance||'B';
        s.routing.treeBuild=$id('tv2_route_treebuild')?.value||s.routing.treeBuild||'B';
        s.routing.modes={...(s.routing.modes||{}),retrieval:getModeGroup('retrieval',s.routing.modes?.retrieval||'adaptive'),loreInjection:$id('tv2_mode_lore_injection')?.value||s.routing.modes?.loreInjection||'adaptive',postTurn:$id('tv2_mode_postturn')?.value||s.routing.modes?.postTurn||'adaptive',summaries:$id('tv2_mode_summaries')?.value||s.routing.modes?.summaries||'adaptive'};
        s.routing.fallback=$id('tv2_route_fallback')?.checked!==false;
        s.routing.loadBalance=$id('tv2_route_load_balance')?.checked!==false;
        s.appearance=normalizeTheme({
            ...(s.appearance||{}),
            preset:$id('tv2_theme_preset')?.value||'black-gold',
            font:$id('tv2_theme_font')?.value||'inherit',
            shape:$id('tv2_theme_shape')?.value||'soft',
            background:$id('tv2_theme_background')?.value,
            surface:$id('tv2_theme_surface')?.value,
            surfaceAlt:$id('tv2_theme_surface_alt')?.value,
            accent:$id('tv2_theme_accent')?.value,
            accent2:$id('tv2_theme_accent2')?.value,
            text:$id('tv2_theme_text')?.value,
            muted:$id('tv2_theme_muted')?.value,
            border:$id('tv2_theme_border')?.value,
        });
        s.observability={...(s.observability||{}),enabled:true,persistSession:$id('tv2_obs_persist')?.checked!==false,capturePayloads:$id('tv2_obs_payloads')?.checked!==false,maxEvents:Math.max(50,number('tv2_obs_max_events',500,50,5000)),captureChars:Math.max(0,number('tv2_obs_capture_chars',4000,0,50000))};
    });
    try{
        await updateAuthoritySettingsDurably('Nexus operator authority settings', [['nexus','callCenter'],['loreWriteValve']], s=>{
            s.nexus=s.nexus||{};s.nexus.callCenter=desiredCallCenter;
            s.loreWriteValve={...(s.loreWriteValve||{}),mode:desiredWriteValveMode};
        });
    }catch(error){
        logEvent('settings','authority-persistence-failed',{error,status:getAuthoritySettingsStatus()},'error');
        globalThis.toastr?.error(`Authority settings were not activated: ${error?.message||error}`,'Nexus');
        hydrateUI();renderCallCenterStatus('Authority settings require recovery before mutation can continue.','failed');
        return null;
    }
    set('tv2_memory_enabled',settings.memoryBank?.enabled===true,'checked');set('tv2_memory_enabled_settings',settings.memoryBank?.enabled===true,'checked');set('tv2_character_banks_enabled_front',settings.memoryBank?.characterBanks?.enabled!==false,'checked');
    try{getNexusRuntime().configureCallCenter(settings.nexus?.callCenter||{});}catch(error){logEvent('call-center','runtime-config-sync-failed',{error},'error');}
    const liveSettings=getSettings();
    const nextCoordinationMode=inferNexusCoordinationMode(liveSettings.nexus||{});
    const nextMainWorkerEnabled=liveSettings.enabled===true&&liveSettings.nexus?.modelWorker?.useMain===true;
    if(nextMainWorkerEnabled!==previousMainWorkerEnabled){
        invalidateLifecycleScheduler(`main-worker-participation:${previousMainWorkerEnabled?'on':'off'}->${nextMainWorkerEnabled?'on':'off'}`);
        resetNexusLifecycleBridge(`main-worker-participation:${previousMainWorkerEnabled?'on':'off'}->${nextMainWorkerEnabled?'on':'off'}`);
        logEvent('model-worker','participation-changed',{previous:previousMainWorkerEnabled,next:nextMainWorkerEnabled},'info');
    }
    if(nextCoordinationMode!==previousCoordinationMode){
        // Coordination mode is execution authority, not presentation state.
        // Revoke any in-flight/pending lifecycle attempt so SHADOW cannot
        // consume a revision before FULL, and FULL work cannot outlive a switch
        // away from FULL/HYBRID authority.
        invalidateLifecycleScheduler(`coordination-mode-changed:${previousCoordinationMode}->${nextCoordinationMode}`);
        resetNexusLifecycleBridge(`coordination-mode-changed:${previousCoordinationMode}->${nextCoordinationMode}`);
        logEvent('nexus-director','coordination-mode-revoked',{previousCoordinationMode,nextCoordinationMode},'info');
    }
    applyTv2Theme(settings.appearance||{});updateMainControlsVisibility();configureTelemetry(settings.observability||{});refreshSidecarBus();registerTools();renderSmartContextBadges();renderCallCenterStatus();renderCallCenterReviewQueue();renderNexusCoordinationStatus();renderNexusBatchLayerStatus();renderTokenLimitSummary('A',settings.sidecars.A);renderTokenLimitSummary('B',settings.sidecars.B);renderOperatorLaunchers();
    try{globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-main-bridge-status'));}catch{}
    logEvent('settings','updated',{enabled:settings.enabled,retrievalEnabled:settings.retrieval.enabled,postTurnEnabled:settings.postTurn.enabled,sidecars:{A:{enabled:settings.sidecars.A.enabled,format:settings.sidecars.A.format,model:settings.sidecars.A.model,capabilities:settings.sidecars.A.capabilities},B:{enabled:settings.sidecars.B.enabled,format:settings.sidecars.B.format,model:settings.sidecars.B.model,capabilities:settings.sidecars.B.capabilities}},routing:settings.routing,scheduler:settings.scheduler,memoryBank:{enabled:settings.memoryBank?.enabled,verbatimTurns:settings.memoryBank?.verbatimTurns,turnsPerSummary:settings.memoryBank?.turnsPerSummary,snippetsPerLayer:settings.memoryBank?.snippetsPerLayer,maxLayers:settings.memoryBank?.maxLayers,characterBanks:characterBankSummary()}},'debug');    return settings;
}


async function runSidecarTest(slot){
    if(!(await save()))return;const x=slot.toLowerCase(),button=$id(`tv2_test_sidecar_${x}`),status=$id(`tv2_sidecar_${x}_check_status`);if(button)button.disabled=true;if(status)status.textContent='Checking connection, authentication, model, text and structured JSON…';
    try{
        const profile=readProfile(slot),report=await checkSidecarProvider(profile);
        const lightweight={usable:report.usable,checkedAt:report.checkedAt,durationMs:report.durationMs,model:report.model,format:report.format,checks:report.checks.map(row=>({name:row.name,ok:row.ok,detail:row.detail,latencyMs:row.latencyMs??null,status:row.status??null,effectiveReasoning:row.effectiveReasoning??null}))};
        updateSettings(s=>{s.sidecars[slot]={...(s.sidecars[slot]||{}),lastHealth:lightweight};});
        const otherSlot=slot==='A'?'B':'A',otherProfile=getSettings().sidecars?.[otherSlot]||{};const duplicate=sameProviderCapacity(profile,otherProfile);
        const summary=report.checks.map(row=>`${row.ok?'✓':'✕'} ${row.name}`).join(' · ');if(status)status.textContent=`${report.usable?'Usable':'Not usable'} · ${summary}${duplicate?` · Warning: Sidecar ${otherSlot} shares this endpoint/account/model capacity.`:''}`;
        if(duplicate)globalThis.toastr?.warning(`Sidecars ${slot} and ${otherSlot} share the same endpoint/account/model. Treat them as shared capacity, not independent fallback.`, 'Nexus provider check');
        if(report.usable)globalThis.toastr?.success(`Sidecar ${slot} provider check passed in ${report.durationMs} ms.`, 'Nexus');else globalThis.toastr?.error(`Sidecar ${slot} provider check failed. ${report.checks.filter(x=>!x.ok).map(x=>x.name+': '+x.detail).join(' · ')}`, 'Nexus');
    }catch(err){if(status)status.textContent=`Provider check failed · ${err?.message||err}`;globalThis.toastr?.error(`Sidecar ${slot} failed: ${err?.message||err}`,'Nexus');}
    finally{if(button)button.disabled=false;renderSidecarLive();renderUiSectionSummaries();renderLogLauncher();}
}

async function loadSidecarModels(slot){
    const x=slot.toLowerCase(),button=$id(`tv2_load_sidecar_${x}_models`);if(button)button.disabled=true;
    try{
        const models=await listSidecarModels(readProfile(slot));const list=$id(`tv2_sidecar_${x}_models`);
        if(list)list.innerHTML=models.map(id=>`<option value="${esc(id)}"></option>`).join('');
        if(!models.length)globalThis.toastr?.warning('The endpoint responded but did not return a recognized model list. You can still type the model ID.','Nexus Sidecar');
        else globalThis.toastr?.success(`Loaded ${models.length} model IDs for Sidecar ${slot}.`,'Nexus Sidecar');
    }catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus model discovery failed');}
    finally{if(button)button.disabled=false;}
}

function downloadJson(filename,payload){const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function importFromFile(file){if(!file)return;const text=await file.text();let payload;try{payload=JSON.parse(text);}catch{throw new Error('Import file is not valid JSON.');}const mode=$id('tv2_import_mode')?.value||'merge';if(mode==='replace'){const preview=await previewTv2OrTv1Import(payload,{mode,importSidecar:true,importChatPins:true});const exact=JSON.stringify(preview,null,2);if(globalThis.confirm?.(`Replace Nexus configuration with this reviewed import? This can remove settings, Trees, routing state, and other configuration not present in the incoming file. Secret values are deliberately hidden, but all other before/after values are shown.\n\n${exact}`)===false)return null;}const result=await importTv2OrTv1Payload(payload,{mode,importSidecar:true,importChatPins:true});const importedSettings=getSettings();configureTelemetry(importedSettings.observability||{});try{getNexusRuntime().configureCallCenter(importedSettings.nexus?.callCenter||{});}catch(error){logEvent('call-center','runtime-config-import-sync-failed',{error},'error');}hydrateUI();refreshSidecarBus();registerTools();return result;}

function renderSidecarLive(){
    const snap=getTelemetrySnapshot(),settings=getSettings(),runtimeHealth=getSidecarRuntimeHealth();
    for(const slot of ['A','B']){
        const el=$id(`tv2_sidecar_${slot.toLowerCase()}_live`);if(!el)continue;
        const stats=snap.sidecars?.[slot]||{},active=stats.active,last=stats.last,profile=settings.sidecars?.[slot]||{},health=profile.lastHealth||null,runtime=runtimeHealth?.[slot]||{};
        const otherSlot=slot==='A'?'B':'A',otherProfile=settings.sidecars?.[otherSlot]||{};
        const duplicate=profile.enabled!==false&&otherProfile.enabled!==false&&sameProviderCapacity(profile,otherProfile);
        const checkedAt=Number(health?.checkedAt||0),ageMs=checkedAt?Math.max(0,Date.now()-checkedAt):Infinity,staleHealth=Number.isFinite(ageMs)&&ageMs>6*60*60*1000;
        const lastEndedAt=Number(last?.endedAt||0),recentRuntimeSuccess=last?.ok===true&&lastEndedAt>0&&(Date.now()-lastEndedAt)<=6*60*60*1000;
        let state='warning',label='check recommended',title='No recent successful provider check or runtime job is recorded.';
        if(profile.enabled===false){state='disabled';label='disabled';title='This Sidecar is disabled.';}
        else if(runtime.eligible===false){const seconds=Math.max(1,Math.ceil(Number(runtime.cooldownMs||0)/1000));state='warning';label=`enabled · cooldown ${seconds}s`;title=`Sidecar ${slot} is enabled by the operator but temporarily unavailable after ${runtime.lastFailure||'a provider/transport failure'}. Nexus will admit it again when the cooldown expires.`;}
        else if(active){state='running';label=`working · ${String(active.label||active.bus||active.role||'job').replace(/^(?:Nexus)\s*/,'')}`;title='Sidecar work is active.';}
        else if(last?.cancelled===true||last?.error?.name==='TV2ForegroundAbort'){state=health?.usable===true&&!staleHealth?'ready':'warning';label=state==='ready'?'ready':'idle · check recommended';title='The last job yielded safely to foreground work.';}
        else if(last?.ok===false){state='failed';label=`failed · ${last.label||last.bus||last.role||'job'}`;title=String(last?.error?.message||last?.finishReason||'The last Sidecar job failed.');}
        else if(health?.usable===false){state='failed';label='provider check failed';title=(health.checks||[]).filter(row=>row?.ok===false).map(row=>`${row.name}: ${row.detail}`).join(' · ')||'The last provider check was not usable.';}
        else if(duplicate){state='warning';label=`ready · shared with ${otherSlot}`;title=`Sidecars ${slot} and ${otherSlot} share the same endpoint/account/model capacity.`;}
        else if(recentRuntimeSuccess){state='ready';label='ready';title='A recent Sidecar job completed successfully.';}
        else if(health?.usable===true&&!staleHealth){state='ready';label='ready';title=`Last provider check passed${checkedAt?` ${Math.max(1,Math.round(ageMs/60000))}m ago`:''}.`;}
        else if(health?.usable===true&&staleHealth){state='warning';label='ready · recheck due';title='The last provider check passed but is older than 6 hours.';}
        const card=el.closest('.tv2-sidecar-card');if(card)card.dataset.healthState=state;
        el.dataset.state=state;el.title=title;el.setAttribute('aria-label',`Sidecar ${slot}: ${label}`);el.innerHTML=`<i></i> ${esc(label)}`;
    }
}

function renderSchedulerStatus(){
    const el=$id('tv2_scheduler_status');if(!el)return;const state=getSchedulerState();const stats=memoryStats();const postTurn=inspectPostTurnBacklogForAdmission();const backlogLabel=postTurn.pendingCount>0?` · Post-turn ${postTurn.pendingCount} pending${postTurn.ageAssistantTurns?` / ~${postTurn.ageAssistantTurns} turns old`:''}`:'';
    if(state.active){
        const running=state.active.steps.filter(s=>s.status==='running').map(s=>s.name).join(', ')||'lifecycle work';
        el.textContent=`Running: ${running} · ${state.active.id}${backlogLabel}`;
        el.dataset.state='running';
    }else if(state.last){
        const failed=state.last.steps?.find(s=>s.status==='failed');
        const skipped=state.last.steps?.filter(s=>s.status==='skipped').length||0;
        const deferred=state.last.steps?.filter(s=>s.status==='deferred').length||0;
        const intelligence=[...(state.last.steps||[])].reverse().find(step=>['post-turn','lore-routing'].includes(step?.name)&&step?.classification);
        const intelligenceLabel=intelligence?` · Intelligence: ${intelligence.classification}${intelligence.reason?` (${intelligence.reason})`:''}`:'';
        el.textContent=`Last: ${state.last.status}${intelligenceLabel}${failed?` · failed: ${failed.name}`:''}${deferred?` · ${deferred} deferred`:''}${skipped?` · ${skipped} skipped`:''} · ${(Number(state.last.durationMs||0)/1000).toFixed(1)}s · ${stats.active} memories${backlogLabel}`;
        el.title=intelligence?`Last Lifecycle Intelligence classification: ${intelligence.classification}${intelligence.reason?`. ${intelligence.reason}`:''}`:'';
        el.dataset.state=state.last.status==='failed'||state.last.status==='partial'?'failed':'idle';
    }else{el.textContent=`Scheduler idle · ${stats.active} active memories${backlogLabel}`;el.dataset.state='idle';}
}

async function manualLifecycle(task,opts={}){
    const btnMap={'post-turn':'tv2_run_postturn','post-turn-flush':'tv2_flush_postturn','summary-check':'tv2_run_summary_check','summary-create':'tv2_run_summary','summary-backlog':'tv2_run_summary_backlog','summary-promote':'tv2_run_promotion','lore-route':'tv2_run_lore_route','smart-warm':'tv2_run_smart_warm','full-cycle':'tv2_run_full_cycle'};
    const btn=$id(btnMap[task]);if(btn)btn.disabled=true;
    try{
        if(!(await save()))return;renderSchedulerStatus();globalThis.toastr?.info(`${task.replaceAll('-',' ')} starting…`,'Nexus Scheduler',{timeOut:1200});
        const result=await runLifecycleTask(task,opts);renderSchedulerStatus();renderSidecarLive();
        if(result?.failed||result?.cycleStatus==='failed')globalThis.toastr?.error(result.error||'Task failed','Nexus Scheduler',{timeOut:4000});
        else if(task==='summary-check')globalThis.toastr?.info(result?.due?`Summary due: messages ${result.start}-${result.end}`:`No summary due: ${result?.reason||'not due'}`,'Nexus Scheduler',{timeOut:3500});
        else if(result?.skipped)globalThis.toastr?.warning(`${task.replaceAll('-',' ')} skipped: ${result.reason||'nothing to process'}`,'Nexus Scheduler',{timeOut:3500});
        else if(task==='summary-backlog'&&!(result?.createdCount>0))globalThis.toastr?.warning(`Summary backlog: ${result?.last?.reason||'nothing to process'}`,'Nexus Scheduler',{timeOut:3500});
        else if(task==='summary-promote'&&!(result?.promotions>0))globalThis.toastr?.warning('No summary promotion is due.','Nexus Scheduler',{timeOut:3000});
        else if(task==='lore-route'&&!(result?.count>0))globalThis.toastr?.warning('No unrouted memories are waiting.','Nexus Scheduler',{timeOut:3000});
        else globalThis.toastr?.success(`${task.replaceAll('-',' ')} complete${result?.slot?` on SC-${result.slot}`:''}.`,'Nexus Scheduler',{timeOut:2200});
        return result;
    }catch(err){logEvent('scheduler-cycle','manual-ui-failed',{task,error:err},'error');globalThis.toastr?.error(err?.message||String(err),'Nexus Scheduler');}
    finally{if(btn)btn.disabled=false;renderSchedulerStatus();renderSidecarLive();}
}

function bindModeChecks(){
    document.querySelectorAll('.tv2-mode-check').forEach(box=>box.addEventListener('change',()=>{
        const group=box.dataset.modeGroup;const peers=[...document.querySelectorAll(`.tv2-mode-check[data-mode-group="${group}"]`)];
        if(box.checked)peers.forEach(peer=>{if(peer!==box)peer.checked=false;});
        if(!peers.some(peer=>peer.checked))box.checked=true;
        save();updateRoutingLockUI();
    }));
}

export function bindUI(){
    mountRetrievalSettingsUI();
    bindVectorPagingUI();
    bindLorebookInventoryRefresh();bindStoryScopeChatRefresh();
    hydrateUI();scheduleLorebookInventoryRefresh('nexus-ui-initial-inventory',{refreshHost:true,delay:0});bindTelemetryCards();bindModeChecks();bindNexusTestingTools(document);
    bindSidecarStatus($id('tv2_top_runtime_status'),{includeQueue:false,includeMain:true});
    const header=$id('tv2_header_toggle');
    $id('tv2_toggle_nexus_panel_body')?.addEventListener('click',e=>{e.stopPropagation();toggleNexusPanelCollapsed();});
    $id('tv2_open_activity_feed')?.addEventListener('click',e=>{e.stopPropagation();openActivityFeed();});
    $id('tv2_close_nexus_panel')?.addEventListener('click',e=>{e.stopPropagation();closeNexusControlPanel();});
    const adv=$id('tv2_advanced_header'),advBody=adv?.nextElementSibling;adv?.addEventListener('click',()=>{adv.classList.toggle('expanded');if(advBody)advBody.style.display=advBody.style.display==='none'?'block':'none';});
    $id('tv2_sidecars_header')?.addEventListener('click',()=>setUiCollapsed('sidecarsCollapsed',!(getSettings().ui?.sidecarsCollapsed!==false)));
    $id('tv2_lifecycle_header')?.addEventListener('click',()=>setUiCollapsed('lifecycleCollapsed',!(getSettings().ui?.lifecycleCollapsed!==false)));
    document.querySelectorAll('#tv2_settings .tv2-card-toggle:not(.tv2-ui-persist-collapse)').forEach(toggle=>toggle.addEventListener('click',()=>{toggle.classList.toggle('expanded');const section=toggle.nextElementSibling;if(section)section.style.display=section.style.display==='none'?'block':'none';}));
    for(const id of ['tv2_lorebook_enabled','tv2_book_permission','tv2_book_injection_mode'])$id(id)?.addEventListener('change',saveSelectedLorebookPolicy);
    $id('tv2_open_selected_tree')?.addEventListener('click',async()=>{await refreshLorebookInventory({refreshHost:true,reason:'open-tree'});if(currentLorebook)updateSettings(s=>{s.selectedLorebook=currentLorebook;});openTreeWorkspace();});
    $id('tv2_lorebook_default_select')?.addEventListener('change',event=>selectLorebook(event.currentTarget.value));
    $id('tv2_story_scope_attached')?.addEventListener('change',saveStoryScopeForSelectedBook);
    $id('tv2_story_scope_write')?.addEventListener('change',()=>{if($id('tv2_story_scope_write')?.checked)$id('tv2_story_scope_attached').checked=true;saveStoryScopeForSelectedBook();});
    $id('tv2_open_uid_summarizer')?.addEventListener('click',()=>{if(currentLorebook)openUidSummarizer({book:currentLorebook});});
    const syncMemory=(source,target)=>$id(source)?.addEventListener('change',()=>{set(target,$id(source)?.checked,'checked');});syncMemory('tv2_memory_enabled','tv2_memory_enabled_settings');syncMemory('tv2_memory_enabled_settings','tv2_memory_enabled');
    document.querySelectorAll('#tv2_settings input:not(.tv2-mode-check):not(#tv2_lorebook_enabled):not(#tv2_story_scope_attached):not(#tv2_story_scope_write):not(.tv2-test-control),#tv2_settings select:not(#tv2_book_permission):not(#tv2_book_injection_mode):not(.tv2-test-control)').forEach(el=>el.addEventListener('change',()=>{if(el.closest?.('#tv2_decision_core_settings_mount'))return;save();updateProviderCapVisibility();updateRoutingLockUI();}));
    $id('tv2_open_tree')?.addEventListener('click',openTreeWorkspace);
    $id('tv2_open_memory')?.addEventListener('click',openMemoryBank);
    $id('tv2_open_proposals')?.addEventListener('click',()=>{const pendingRows=getProposals('pending');acknowledgePendingProposals(pendingRows);renderOperatorLaunchers();openProposalPanel();});
    $id('tv2_open_diagnostics')?.addEventListener('click',openDiagnosticsPanel);
    $id('tv2_nexus_call_center_test')?.addEventListener('click',runCallCenterTest);
    $id('tv2_nexus_main_draft_test')?.addEventListener('click',runMainColdOpenProof);
    $id('tv2_nexus_call_review_refresh')?.addEventListener('click',renderCallCenterReviewQueue);
    $id('tv2_nexus_call_review_list')?.addEventListener('click',handleCallCenterReviewAction);
    const applyPresetInputs=(name)=>{const preset=getPresetTheme(name);set('tv2_theme_background',preset.background);set('tv2_theme_surface',preset.surface);set('tv2_theme_surface_alt',preset.surfaceAlt);set('tv2_theme_accent',preset.accent);set('tv2_theme_accent2',preset.accent2);set('tv2_theme_text',preset.text);set('tv2_theme_muted',preset.muted);set('tv2_theme_border',preset.border);};
    $id('tv2_theme_preset')?.addEventListener('change',()=>{applyPresetInputs($id('tv2_theme_preset')?.value||'black-gold');save();});
    $id('tv2_theme_reset_preset')?.addEventListener('click',()=>{applyPresetInputs($id('tv2_theme_preset')?.value||'black-gold');save();globalThis.toastr?.success('Nexus colors reset to the selected preset.','Nexus');});
    $id('tv2_test_sidecar_a')?.addEventListener('click',()=>runSidecarTest('A'));
    $id('tv2_test_sidecar_b')?.addEventListener('click',()=>runSidecarTest('B'));
    $id('tv2_load_sidecar_a_models')?.addEventListener('click',()=>loadSidecarModels('A'));
    $id('tv2_load_sidecar_b_models')?.addEventListener('click',()=>loadSidecarModels('B'));
    $id('tv2_inspect_smart_a')?.addEventListener('click',()=>openSmartContextPanel('A'));
    $id('tv2_inspect_smart_b')?.addEventListener('click',()=>openSmartContextPanel('B'));
    window.addEventListener('tv2-smart-context-updated',renderSmartContextBadges);
    window.addEventListener('tv2-scheduler-updated',renderSchedulerStatus);
    window.addEventListener('tv2-memory-bank-updated',()=>{renderSchedulerStatus();renderOperatorLaunchers();});
    window.addEventListener('tv2-character-banks-updated',renderOperatorLaunchers);
    window.addEventListener(getProposalChangeEventName(),renderOperatorLaunchers);
    window.addEventListener(getProposalAttentionChangeEventName(),renderOperatorLaunchers);
    onTelemetryChange(()=>{renderSidecarLive();renderSchedulerStatus();renderUiSectionSummaries();});
    renderOperatorLaunchers();renderCallCenterReviewQueue();renderSidecarLive();renderSchedulerStatus();renderUiPresentation();
    $id('tv2_run_postturn')?.addEventListener('click',()=>manualLifecycle('post-turn'));
    $id('tv2_flush_postturn')?.addEventListener('click',()=>{if(globalThis.confirm&&!globalThis.confirm('Discard the entire pending Post-turn catch-up backlog and reject unapproved Post-turn proposals tied to that historical range? Approved/applied lore is not removed.'))return;manualLifecycle('post-turn-flush');});
        $id('tv2_run_summary_check')?.addEventListener('click',()=>manualLifecycle('summary-check'));
    $id('tv2_run_summary')?.addEventListener('click',()=>manualLifecycle('summary-create'));
    $id('tv2_run_summary_backlog')?.addEventListener('click',()=>manualLifecycle('summary-backlog'));
    $id('tv2_run_promotion')?.addEventListener('click',()=>manualLifecycle('summary-promote'));
    $id('tv2_run_lore_route')?.addEventListener('click',()=>manualLifecycle('lore-route'));
    $id('tv2_run_smart_warm')?.addEventListener('click',()=>manualLifecycle('smart-warm'));
    $id('tv2_run_housekeeper')?.addEventListener('click',()=>manualLifecycle('housekeeper'));
    $id('tv2_run_full_cycle')?.addEventListener('click',()=>manualLifecycle('full-cycle'));
    $id('tv2_import_tunnelvision')?.addEventListener('click',async()=>{
        const summary=getTunnelVisionMigrationPreview();if(!summary.available){globalThis.toastr?.warning('No compatible installed legacy configuration was found.','Nexus');return;}
        const preview=await previewTunnelVisionBaseline({importSidecar:true,overwrite:false});
        if(globalThis.confirm?.(`Import the installed TunnelVision configuration into Nexus? Review the exact before/after projection below. Existing populated Nexus fields are preserved because overwrite is off; secret values are hidden.\n\n${JSON.stringify(preview,null,2)}`)===false)return;
        const result=await importTunnelVisionBaseline({importSidecar:true,overwrite:false});hydrateUI();refreshSidecarBus();registerTools();const skipped=result.skipped?.length?` · ${result.skipped.length} unsupported subsystem(s) skipped`:'';globalThis.toastr?.success(`Migrated ${result.trees} Tree(s)${result.sidecarImported?' and Sidecar A settings':''}${skipped}. Existing source configuration was not modified.`,'Nexus');
    });
    $id('tv2_export_config')?.addEventListener('click',()=>{const includeSecrets=$id('tv2_export_secrets')?.checked===true;const payload=createTv2Backup({includeSecrets,includeCurrentChatPins:true});downloadJson(`Nexus-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,payload);globalThis.toastr?.success(`Nexus backup exported${includeSecrets?' with API keys':' without API keys'}.`,'Nexus');});
    $id('tv2_import_file')?.addEventListener('click',()=>$id('tv2_import_file_input')?.click());
    $id('tv2_import_file_input')?.addEventListener('change',async event=>{const input=event.currentTarget;const file=input?.files?.[0];if(!file)return;try{const result=await importFromFile(file);if(result)globalThis.toastr?.success(`Imported ${result.kind||'Nexus'} data (${result.mode||'merge'} mode).`,'Nexus');}catch(err){logEvent('migration','file-import-failed',{fileName:file.name,error:err},'error');globalThis.toastr?.error(err?.message||String(err),'Nexus import failed');}finally{if(input)input.value='';}});
    $id('tv2_import_recovery_reconcile')?.addEventListener('click',async()=>{try{const result=await reconcileActiveImportRecovery();hydrateUI();globalThis.toastr?.success(`Import recovery: ${result?.status||'checked'}.`,'Nexus');}catch(err){logEvent('migration','manual-import-recovery-failed',{error:err},'error');hydrateUI();globalThis.toastr?.error(err?.message||String(err),'Nexus import recovery');}});
    $id('tv2_import_recovery_abandon')?.addEventListener('click',async()=>{const state=inspectImportRecoveryState();if(!state.active){globalThis.toastr?.info('No import recovery is pending.','Nexus');return;}const invalid=state.activeClassification?.state==='invalid';const warning=invalid?'Clear this invalid import recovery record?':'Abandon this import recovery? The imported settings/chat state will be left exactly as it is now.';if(globalThis.confirm&&!globalThis.confirm(warning))return;try{const result=await abandonImportRecoveryFence({force:!invalid});hydrateUI();globalThis.toastr?.warning(`Import recovery ${result?.status||'abandoned'}.`,'Nexus');}catch(err){logEvent('migration','manual-import-recovery-abandon-failed',{error:err},'error');globalThis.toastr?.error(err?.message||String(err),'Nexus import recovery');}});
}
