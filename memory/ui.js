import { getContext } from '../../../../st-context.js';
import { getActiveLayerRecords, getPermanentMemoryRecords, getAllMemoryRecords, getMemoryStore, getEffectiveSummarizedUpTo, memoryStats, memoryRecordVersion, memoryRecordValidity, toggleMemoryPermanentProtected, deleteMemoryRecord, scanMemoryBank, rollbackMemoryRevision, hasActiveMemoryStory } from './store.js';
import { regenerateMemoryRecord } from './summarizer.js';
import { queueLoreReviewMemories, getLoreReviewQueueEntry, getLoreReviewQueueChangeEventName, isLoreReviewableMemory } from './lore-review-queue.js';
import { hasUnresolvedLoreRoutingSaga } from './lore-routing-saga.js';
import { getNotebook, saveNotebook, rollbackNotebook, refreshNotebookFromScene, digestMemoryToNotebook } from './notebook.js';
import { getLoreWriteLedger, getLoreWriteReceipts, rollbackDirectWrite, isDirectWriteRollbackAvailable } from '../lore/write-valve.js';
import { runLifecycleTask, getSchedulerState } from '../lifecycle/scheduler.js';
import { inspectSummaryEligibility, inspectManualNextSummary, inspectManualSummaryRange } from './summarizer.js';
import { getSettings } from '../core/settings.js';
import { snapshotLaneAModelWorkers } from './model-worker.js';
import { getMainBridgeStatusEventName } from '../nexus/main-bridge-status.js';
import { getSummaryDurableRoutingEventName } from './decision-sites.js';
import { logEvent } from '../observability/telemetry.js';
import { bindSidecarStatus } from '../observability/sidecar-status.js';
import { centerDraggableWindow, makeDraggableWindow } from '../windowing.js';
import { getActiveBooks } from '../lore/active-books.js';
import {
    getCharacterBanks,
    addCharacterBank,
    updateCharacterBank,
    removeCharacterBank,
    setCharacterBanksEnabled,
    getCharacterBankRuntime,
    getCharacterBankMemories,
    characterBankSummary,
    scanCharacterLore,
    resolveCharacterLoreRef,
    linkCharacterLore,
    unlinkCharacterLore,
    linkCharacterMemory,
    unlinkCharacterMemory,
    unlinkCharacterMemoryEverywhere,
    isCharacterMemoryExplicitlyLinked,
    findCharacterBankByCardAvatar,
    characterBankCardStatus,
    bindCharacterBankCard,
} from './character-banks.js';
import {
    importCharacterCard,
    exportCharacterCard,
    downloadCharacterCard,
    listSillyTavernCharacters,
    inspectSillyTavernCharacter,
} from '../character-cards/io.js';
import { scanCharacterCardDeterministically, buildCardBinding } from '../character-cards/scanner.js';
import { openProposalPanel } from '../proposals/ui.js';
import {
    reviewSummaryForCharacterState,
    reviewRecentChatForCharacterState,
    getCharacterStateReviewSnapshot,
    approveCharacterStateProposal,
    rejectCharacterStateProposal,
    applySelectedCharacterStateProposals,
    buildCharacterCardSyncDraft,
    reconcileCharacterCardBinding,
    commitCharacterCardSync,
} from './character-state-review.js';
import { CHARACTER_STATE_FIELDS, CHARACTER_TRACKING_POLICY, characterStateFieldTrackingDomain, getCharacterStateField, setCharacterStateField } from './character-state-contract.js';
import {
    el as nxEl,
    workspace as nxWorkspace,
    rail as nxRail,
    panel as nxPanel,
    tabs as nxTabs,
    button as nxButton,
    badge as nxBadge,
    toggle as nxToggle,
    select as nxSelect,
    searchField as nxSearchField,
    emptyState as nxEmptyState,
    proposalCard as nxProposalCard,
    evidenceBlock as nxEvidenceBlock,
    collapsible as nxCollapsible,
    toolbar as nxToolbar,
    textarea as nxTextarea,
    input as nxInput,
    checkbox as nxCheckbox,
    list as nxList,
    itemRow as nxItemRow,
    notice as nxNotice,
    diffView as nxDiffView,
    uidChip as nxUidChip,
    provenanceRow as nxProvenanceRow,
    historyRow as nxHistoryRow,
} from '../ui/index.js';

function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
let overlay=null;
let activeTab='narrative';
const scanResults=new Map();
const characterScanGeneration=new Map();
const bankLorebookSelections=new Map();
let summarizePanelOpen=false;
let bankScanReport=null;
let selectedCharacterBankId=null;
let cardImportPreview=null;
let cardToolStatus={message:'Ready.',state:'idle'};
let notebookDraft=null;
let notebookDirty=false;
let lastNotebookDigestPreview=null;
let characterBankViewTab='profile';
let characterBankSearch='';
let characterReviewBusy=false;
const selectedLoreReviewIds=new Set();
let characterUiCoreFallbackNotified=false;
let memoryWindowListenersBound=false;

export function resetMemoryBankUiState({ closeOverlay = false } = {}) {
    bankScanReport = null;
    scanResults.clear();
    bankLorebookSelections.clear();
    selectedCharacterBankId = null;
    characterBankSearch = '';
    cardImportPreview = null;
    cardToolStatus = {message:'Ready.',state:'idle'};
    characterUiCoreFallbackNotified = false;
    selectedLoreReviewIds.clear();
    if (closeOverlay && overlay) {
        try { overlay.remove(); } catch {}
        overlay = null;
    }
    return true;
}
function layerName(i){return i===0?'Recent Narrative':i===1?'Consolidated Events':i===2?'Long-Term Story':`Deep Memory L${i}`;}
function badge(text,kind=''){return `<span class="tv2-memory-badge ${kind}">${esc(text)}</span>`;}
function summaryWorkerState(){return snapshotLaneAModelWorkers('summary',{role:'summaries'});}
function statusModel(){
    const s=getSettings(),stats=memoryStats(),scheduler=getSchedulerState(),workerState=summaryWorkerState(),workers=workerState.labels;
    if(!s.enabled)return {kind:'bad',title:'Nexus is disabled',detail:'The Memory Bank cannot run until Nexus is enabled.',stats,scheduler,workers};
    if(s.memoryBank?.enabled!==true)return {kind:'warn',title:'Memory Bank is OFF',detail:'Enable Recursive Memory Bank from the Nexus front panel or Settings. Existing chat history will not be summarized while it is off.',stats,scheduler,workers};
    if(!workerState.available)return {kind:'bad',title:'Summary generation is unavailable',detail:'Configure an available background helper or allow Main model access in Settings.',stats,scheduler,workers,workerState};
    if(scheduler.active){const running=scheduler.active.steps?.filter(x=>x.status==='running').map(x=>x.name).join(', ')||'lifecycle work';return {kind:'good',title:'Lifecycle is running',detail:running,stats,scheduler,workers};}
    let eligibility;try{eligibility=inspectSummaryEligibility();}catch(error){return {kind:'bad',title:'Summary status could not be evaluated',detail:error?.message||String(error),stats,scheduler,workers};}
    if(eligibility.due){
        const catchUp=eligibility.reason==='backlog-catch-up'||eligibility.catchUp===true;
        const range=eligibility.assistantTurnRange?` · assistant turns ${eligibility.assistantTurnRange[0]}–${eligibility.assistantTurnRange[1]}`:'';
        const messageRange=Number.isFinite(eligibility.start)&&Number.isFinite(eligibility.end)?` · messages ${eligibility.start+1}–${eligibility.end+1}`:'';
        const remaining=Number.isFinite(eligibility.remainingAfterBatch)?eligibility.remainingAfterBatch:eligibility.remainingSummarizable||0;
        return {kind:'good',title:`${catchUp?'Backlog catch-up':'Summary ready'}${range}`,detail:`${eligibility.batchAssistantTurns||0} assistant turn(s) in next Summary${messageRange} · ${remaining} eligible turn(s) remain after it · recent ${eligibility.protectedAssistantTurns??eligibility.verbatimTurns??0} assistant turn(s) stay verbatim`,stats,scheduler,workers,eligibility};
    }
    const reason=eligibility.reason==='within-verbatim-window'?`Waiting normally: unsummarized turns are still inside the protected ${eligibility.verbatimTurns||0}-assistant-turn verbatim window.`:eligibility.reason==='no-assistant-turns'?'No assistant turns exist in this chat yet.':eligibility.reason==='nothing-unsummarized'?'Everything eligible has already been summarized.':`Not due yet: ${eligibility.reason||'waiting for more turns'}.`;
    return {kind:'neutral',title:'Memory Bank is ready',detail:reason,stats,scheduler,workers,eligibility};
}
function statusHtml(){
    const m=statusModel(),last=m.scheduler?.last;
    const meta=last?`Last run ${last.status}`:'';
    return `<section class="tv2-memory-status tv2-memory-status-slim ${esc(m.kind)}"><span class="tv2-memory-status-dot"></span><div><b>${esc(m.title)}</b><span>${esc(m.detail)}</span></div>${meta?`<small>${esc(meta)}</small>`:''}</section>`;
}
function recordCard(r){
    const queued=getLoreReviewQueueEntry(r.id),queueActive=['queued','reviewing'].includes(String(queued?.state||'')),reviewable=isLoreReviewableMemory(r);
    let unresolvedSaga=false;try{unresolvedSaga=hasUnresolvedLoreRoutingSaga(r.id,{chatId:getContext?.()?.chatId});}catch{}
    const tags=[];if(r.permanent===true)tags.push(badge('PERMANENT','good'));if(r.locked===true&&r.permanent!==true)tags.push(badge('LOCKED','good'));if(queueActive)tags.push(badge(queued.state==='reviewing'?'REVIEWING':'QUEUED',queued.state==='reviewing'?'good':'warn'));else if(queued?.state==='failed'&&reviewable)tags.push(badge('REVIEW FAILED','bad'));else if(queued?.state==='stale'&&reviewable)tags.push(badge('REVIEW STALE','warn'));if(r.routeState==='unrouted')tags.push(badge('UNROUTED','warn'));else if(r.routeState==='proposed')tags.push(badge('PROPOSED','good'));else if(r.routeState==='direct-written')tags.push(badge('DIRECT WRITE','warn'));else if(r.routeState==='routed-noop')tags.push(badge('LORE CHECKED','good'));else if(r.routeState==='failed')tags.push(badge('ROUTE FAILED','bad'));else if(r.routeState==='partial')tags.push(badge('PARTIAL','warn'));
    if(unresolvedSaga)tags.push(badge('RECOVERY PENDING','warn'));
    const meta=[r.assistantTurnRange?`Assistant turns ${r.assistantTurnRange[0]}–${r.assistantTurnRange[1]}`:r.turnRange?`Messages ${Number(r.turnRange[0])+1}–${Number(r.turnRange[1])+1}`:'',...(r.characters||[]).slice(0,4)].filter(Boolean).join(' · ');
    const selector=(reviewable&&!queueActive&&r.permanent!==true)?`<label class="tv2-memory-lore-selector tv2-switch"><input class="tv2-memory-lore-select" type="checkbox" ${selectedLoreReviewIds.has(String(r.id))?'checked':''}><span>Lore</span></label>`:'';
    const digestDisabled=queueActive||r.permanent===true||r.locked===true;
    const digest=!digestDisabled?`<div class="tv2-memory-digest-controls"><select class="text_pole tv2-memory-digest-destination"><option value="">Digest…</option><option value="lore">Digest → Lore Proposals</option><option value="notebook">Digest to Notebook</option></select><label class="tv2-memory-delete-after-digest-wrap"><span>Delete after digest</span><select class="text_pole tv2-memory-delete-after-digest"><option value="no" selected>No</option><option value="yes">Yes</option></select></label></div>`:'';
    const banks=getCharacterBanks();
    const explicitBanks=banks.filter(bank=>isCharacterMemoryExplicitlyLinked(bank,r.id));
    const inferredBanks=banks.filter(bank=>!isCharacterMemoryExplicitlyLinked(bank,r.id)&&getCharacterBankMemories(bank).some(memory=>String(memory.id)===String(r.id)));
    const characterLinks=(explicitBanks.length||inferredBanks.length)?`<div class="tv2-memory-character-links tv2-character-meta-text">${[...explicitBanks.map(bank=>`${bank.character} · linked`),...inferredBanks.map(bank=>`${bank.character} · inferred`)].map(esc).join(' · ')}</div>`:'';
    const characterLink=banks.length?`<button class="menu_button tv2-memory-character-review" type="button"><i class="fa-solid fa-user-check"></i> Review for Character Bank…</button>`:'';
    const permanentLabel=r.permanent===true?'Make Temporary':'Make Permanent';
    const deleteDisabled=queueActive||unresolvedSaga;
    return `<article class="tv2-bank-card" data-memory-id="${esc(r.id)}"><div class="tv2-bank-card-head"><div class="tv2-memory-card-heading">${selector}<div><b>${esc(r.topics?.[0]||`Memory ${r.id.slice(-8)}`)}</b><div class="tv2-meta">${esc(meta)}</div></div></div><div class="tv2-bank-badges">${tags.join('')}</div></div>${characterLinks}<div class="tv2-bank-text">${esc(r.text)}</div>${(r.threads||[]).length?`<div class="tv2-bank-threads"><b>Threads:</b> ${esc(r.threads.join(' · '))}</div>`:''}<div class="tv2-bank-actions tv2-memory-destination-actions">${digest}${characterLink}<button class="menu_button tv2-memory-permanent" type="button">${permanentLabel}</button><button class="menu_button tv2-memory-delete" type="button" ${deleteDisabled?'disabled':''}>Delete</button></div><details class="tv2-summary-more"><summary>More</summary><div class="tv2-bank-actions"><button class="menu_button tv2-memory-regenerate" type="button" ${r.locked?'disabled':''}>Regenerate</button>${r.revisions?.length?'<button class="menu_button tv2-memory-revision-rollback" type="button">Undo Revision</button>':''}</div></details></article>`;
}

function summaryFormHtml(){
    let plan=null,next=1,total=0,nextMessage=1;try{plan=inspectManualNextSummary();next=plan?.assistantTurnRange?.[0]||plan?.nextAssistantTurn||1;total=plan?.assistantTurns||0;nextMessage=(plan?.start??0)+1;}catch{}
    const chatMessages=getContext()?.chat?.length||0;const rangeEnd=Math.min(chatMessages||nextMessage+49,nextMessage+49);
    const planned=plan?.due?`${plan.reason==='manual-backlog-catch-up'?'Backlog catch-up':'Next chronological Summary'} · assistant turns ${plan.assistantTurnRange?.[0]||'?'}–${plan.assistantTurnRange?.[1]||'?'} · messages ${(plan.start??0)+1}–${(plan.end??0)+1}`:'No unsummarized turns are currently available.';
    return `<form class="tv2-summary-range-form"><div><b>Summarize Chat</b></div><label>Mode<select class="text_pole tv2-summary-mode"><option value="next">Next planned Summary</option><option value="range">Custom chat-message range</option></select></label><label class="tv2-summary-count-wrap">Planned span<small>${esc(planned)}</small></label><div class="tv2-summary-custom" hidden><label>From message<input class="text_pole tv2-summary-from" type="number" min="1" ${chatMessages?`max="${chatMessages}"`:''} value="${nextMessage}"></label><label>To message<input class="text_pole tv2-summary-to" type="number" min="1" ${chatMessages?`max="${chatMessages}"`:''} value="${Math.max(nextMessage,rangeEnd)}"></label></div><button class="menu_button tv2-primary-action" type="submit">Create Summary</button><small>Next: ${next}${total?` · ${total} assistant turns`:''}${chatMessages?` · ${chatMessages} chat messages`:''}.</small></form>`;
}

function bankScanHtml(){
    if(!bankScanReport)return '';
    const issues=bankScanReport.issues||[];
    if(!issues.length)return `<section class="tv2-bank-scan-result good"><b>Memory Bank looks consistent</b><span>${bankScanReport.stats.records} records checked; chronology and lineage are consistent.</span></section>`;
    const rows=issues.slice(0,12).map((issue,index)=>{
        const range=Array.isArray(issue.range)&&issue.range.length===2?issue.range:null;
        const action=issue.kind==='gap'&&range?`<button class="menu_button tv2-memory-scan-gap" data-gap-start="${Number(range[0])}" data-gap-end="${Number(range[1])}" type="button">Summarize this gap</button>`:'';
        const guidance=issue.kind==='gap'?'This range is not covered by a Summary.':issue.kind==='routing'?'Open the affected Summary and retry its Lore review.':issue.kind==='stale-source'?'The source chat changed; review or regenerate the affected Summary before relying on it.':issue.kind==='pointer'?'Coverage metadata disagrees with valid contiguous summaries; review Diagnostics before any repair.':'Review the affected Summary before changing durable memory.';
        return `<div class="tv2-bank-scan-issue" data-scan-issue="${index}"><div><b>${esc(issue.kind.replaceAll('-',' '))}</b><span>${esc(issue.detail)}</span><small>${esc(guidance)}</small></div>${action}</div>`;
    }).join('');
    return `<section class="tv2-bank-scan-result warn"><div class="tv2-bank-scan-head"><b>${issues.length} issue${issues.length===1?'':'s'} found</b><span>Choose an available action below; Scan itself never mutates memory.</span></div>${rows}</section>`;
}
function narrativeHtml(){
    const stats=memoryStats(),layers=[];let visibleCount=0;
    for(let i=0;i<Math.max(stats.layers,1);i++){
        const records=getActiveLayerRecords(i).filter(record=>record.permanent!==true);if(!records.length&&i>0)continue;visibleCount+=records.length;
        layers.push(`<details class="tv2-memory-layer" ${i===0?'open':''}><summary><b>${layerName(i)}</b><span>${records.length}</span></summary><div class="tv2-memory-layer-body">${records.length?records.map(recordCard).join(''):'<div class="tv2-empty"><b>No summaries stored yet.</b><span>Create a Summary when the status above says the bank is ready.</span></div>'}</div></details>`);
    }
    const selectedAction=selectedLoreReviewIds.size?`<button class="menu_button tv2-send-selected-lore" type="button">Send ${selectedLoreReviewIds.size} Selected to Lore Review</button>`:'';
    return `<div class="tv2-summary-bank-head"><b>Summary Bank</b><span>${visibleCount} summar${visibleCount===1?'y':'ies'}</span></div><div class="tv2-memory-action-grid tv2-memory-action-grid-compact"><button id="tv2_memory_run_summary" class="tv2-memory-action" type="button"><i class="fa-solid fa-compress"></i><span><b>Summarize Chat</b></span></button><button id="tv2_memory_promote" class="tv2-memory-action" type="button"><i class="fa-solid fa-layer-group"></i><span><b>Condense Older Memories</b></span></button><button id="tv2_memory_scan" class="tv2-memory-action" type="button"><i class="fa-solid fa-magnifying-glass"></i><span><b>Scan Memory Bank</b></span></button>${selectedAction}</div>${summarizePanelOpen?summaryFormHtml():''}${bankScanHtml()}${layers.join('')}`;
}
function permanentHtml(){
    const records=getPermanentMemoryRecords().sort((a,b)=>(b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0));
    return `<section class="tv2-character-bank-intro"><div><b>Permanent Memory Tank</b><span>Durable narrative memories remain recall-eligible even after normal layer promotion. Permanent does not mean always injected; relevance still decides recall.</span></div></section>${records.length?`<div class="tv2-memory-layer-body">${records.map(recordCard).join('')}</div>`:'<div class="tv2-empty compact tv2-permanent-empty"><b>No permanent memories yet.</b><span>Use Make Permanent on any Narrative memory card.</span></div>'}`;
}
function cardStatus(message,state='idle'){cardToolStatus={message:String(message||''),state};}
function cardOptionsHtml(selected=''){
    const chosen=String(selected||'');
    let rows=[];try{rows=listSillyTavernCharacters();}catch{}
    return rows.map(row=>`<option value="${esc(row.avatar)}" ${row.avatar===chosen?'selected':''}>${esc(row.name||row.avatar)}</option>`).join('');
}
function importTargetOptions(preview){
    const banks=getCharacterBanks();
    const bound=preview?.exactBankId||'';
    const sameName=new Set(preview?.sameNameBankIds||[]);
    const options=[`<option value="new" ${!bound?'selected':''}>Create new Character Bank</option>`];
    for(const bank of banks){
        if(bank.id!==bound&&!sameName.has(bank.id))continue;
        const binding=characterBankCardStatus(bank);
        if(binding.bound&&bank.id!==bound)continue;
        options.push(`<option value="${esc(bank.id)}" ${bank.id===bound?'selected':''}>${bank.id===bound?'Update bound bank':'Bind existing'} · ${esc(bank.character||'Unnamed bank')}</option>`);
    }
    return options.join('');
}
function fieldRow(key,label,proposed,current,source,checked){
    const changed=String(proposed||'')!==String(current||'');
    return `<label class="tv2-card-import-field ${changed?'changed':'same'}"><input class="tv2-card-import-accept" data-field="${esc(key)}" type="checkbox" ${checked?'checked':''} ${!proposed?'disabled':''}><span><b>${esc(label)}</b><small>${source?`Source: ${esc(source)}`:'No safe card mapping'}</small></span><div><em>Current</em><textarea class="text_pole tv2-card-current" rows="2" readonly>${esc(current||'')}</textarea></div><div><em>Card proposal</em><textarea class="text_pole tv2-card-proposed" data-proposal="${esc(key)}" rows="2" ${!proposed?'placeholder="No deterministic value found"':''}>${esc(proposed||'')}</textarea></div></label>`;
}
function rebuildCardPreviewTarget(target){
    if(!cardImportPreview)return;
    const bank=target&&target!=='new'?getCharacterBanks().find(row=>row.id===target)||null:null;
    cardImportPreview.targetBankId=bank?.id||'new';
    cardImportPreview.currentBank=bank;
}
function cardImportPreviewHtml(){
    const preview=cardImportPreview;if(!preview)return '';
    const bank=preview.currentBank||null,scan=preview.scan,card=preview.card;
    const currentProfile=bank?.profile||{};
    const proposed=scan.proposals||{profile:{}};
    const exact=bank?.cardBinding?.avatar===card.avatar;
    const unchanged=exact&&bank?.cardBinding?.fingerprint===card.fingerprint&&String(bank.character||'')===String(proposed.character||'')&&String(currentProfile.personality||'')===String(proposed.profile?.personality||'')&&String(currentProfile.appearance||'')===String(proposed.profile?.appearance||'')&&String(currentProfile.clothingArmor||'')===String(proposed.profile?.clothingArmor||'');
    const collisionNote=preview.sameNameBankIds?.length&&!preview.exactBankId?`<div class="tv2-status-strip warn">A same-name Character Bank already exists. Nexus will not overwrite or bind it automatically; choose it explicitly or create a new bank.</div>`:'';
    const excluded=scan.excludedInstructionFields?.length?`<div class="tv2-help">Excluded from character facts: ${esc(scan.excludedInstructionFields.join(', '))}. Instruction fields are never copied into Character Bank canon.</div>`:'';
    const rows=[
        fieldRow('character','Character name',proposed.character,bank?.character||'',scan.provenance?.character?.join(' + '),!bank||!bank.character||bank.character===proposed.character),
        fieldRow('profile.personality','Personality / temperament',proposed.profile?.personality,currentProfile.personality||'',scan.provenance?.['profile.personality']?.join(' + '),!currentProfile.personality||currentProfile.personality===proposed.profile?.personality),
        fieldRow('profile.appearance','Appearance / identifying details',proposed.profile?.appearance,currentProfile.appearance||'',scan.provenance?.['profile.appearance']?.join(' + '),!currentProfile.appearance||currentProfile.appearance===proposed.profile?.appearance),
        fieldRow('profile.clothingArmor','Clothing / armor / carried gear',proposed.profile?.clothingArmor,currentProfile.clothingArmor||'',scan.provenance?.['profile.clothingArmor']?.join(' + '),!currentProfile.clothingArmor||currentProfile.clothingArmor===proposed.profile?.clothingArmor),
    ].join('');
    const rawContext=[scan.unmappedContext?.description?`<details><summary>Description</summary><pre>${esc(scan.unmappedContext.description)}</pre></details>`:'',scan.unmappedContext?.scenario?`<details><summary>Scenario</summary><pre>${esc(scan.unmappedContext.scenario)}</pre></details>`:'',scan.unmappedContext?.creatorNotes?`<details><summary>Creator notes</summary><pre>${esc(scan.unmappedContext.creatorNotes)}</pre></details>`:''].filter(Boolean).join('');
    return `<section class="tv2-card-import-preview" data-avatar="${esc(card.avatar)}"><div class="tv2-card-import-preview-head"><div><b>${esc(card.name||'Current SillyTavern Character')}</b><span>${esc(card.avatar)}</span></div><button class="menu_button tv2-card-preview-dismiss" type="button">Dismiss</button></div>${collisionNote}<label class="tv2-card-import-target">Character Bank target<select class="text_pole tv2-card-import-target-select">${importTargetOptions(preview)}</select></label>${unchanged?'<div class="tv2-status-strip complete">This bound card is unchanged. No Character Bank mutation is required.</div>':''}<div class="tv2-card-import-fields">${rows}</div>${excluded}${rawContext?`<details class="tv2-card-source-context"><summary>Unmapped card context</summary>${rawContext}</details>`:''}<div class="tv2-card-import-actions"><button class="menu_button tv2-primary-action tv2-card-preview-apply" type="button" ${unchanged?'disabled':''}>${bank?'Apply Reviewed Delta':'Create & Bind Character Bank'}</button></div></section>`;
}
function characterCardToolsHtml(){
    let current=null;try{current=inspectSillyTavernCharacter();}catch{}
    const selected=current?.avatar||'';
    return `<details class="tv2-character-card-tools"><summary><span><b>SillyTavern Character Cards</b><small>Optional card bind / import / export</small></span><span class="tv2-meta">${current?`Current: ${esc(current.name||current.avatar)}`:'No active card'}</span></summary><div class="tv2-character-card-tools-body"><input id="tv2_character_card_import_file" type="file" accept=".png,.json,image/png,application/json" hidden><div class="tv2-character-card-actions"><button id="tv2_character_card_import_current" class="menu_button tv2-primary-action" type="button"><i class="fa-solid fa-link"></i> Bind Current ST Character</button><button id="tv2_character_card_import" class="menu_button" type="button"><i class="fa-solid fa-file-import"></i> Import Character Card</button><label>Export character<select id="tv2_character_card_export_character" class="text_pole"><option value="">Choose character…</option>${cardOptionsHtml(selected)}</select></label><label>Format<select id="tv2_character_card_export_format" class="text_pole"><option value="png">PNG</option><option value="json">JSON</option></select></label><button id="tv2_character_card_export" class="menu_button" type="button"><i class="fa-solid fa-file-export"></i> Export Character Card</button></div><div id="tv2_character_card_status" class="tv2-status-strip" data-state="${esc(cardToolStatus.state)}">${esc(cardToolStatus.message)}</div>${cardImportPreviewHtml()}</div></details>`;
}
function bookOptions(selected=''){const chosen=String(selected||'');return getActiveBooks({requireTree:true,access:'read',injection:'tv2'}).map(book=>`<option value="${esc(book)}" ${String(book)===chosen?'selected':''}>${esc(book)}</option>`).join('');}
function linkedLoreHtml(bank){
    if(!bank.linkedRefs?.length)return '<div class="tv2-empty compact"><b>No linked lore yet.</b><span>Scan the Tree or add an exact UID.</span></div>';
    return `<div class="tv2-character-linked-list">${bank.linkedRefs.map(ref=>`<div class="tv2-character-linked-row"><div><b>${esc(ref.title||`UID ${ref.uid}`)}</b><span>${esc(ref.book)} · UID ${Number(ref.uid)}${ref.nodeLabel?` · ${esc(ref.nodeLabel)}`:''}</span></div><button class="menu_button tv2-char-unlink" data-book="${esc(ref.book)}" data-uid="${Number(ref.uid)}" type="button">Unlink</button></div>`).join('')}</div>`;
}
function scanHtml(bank){
    const rows=scanResults.get(bank.id)||[];
    if(!rows.length)return '';
    const linked=new Set((bank.linkedRefs||[]).map(ref=>`${ref.book}:${Number(ref.uid)}`));
    const candidates=rows.filter(row=>!linked.has(`${row.book}:${Number(row.uid)}`));
    if(!candidates.length)return '';
    return `<div class="tv2-character-scan-results"><div class="tv2-subhead">Suggested lore links</div>${candidates.slice(0,30).map(row=>`<div class="tv2-character-scan-row"><div class="tv2-character-scan-score">${Math.round(row.percent||0)}%</div><div><b>${esc(row.title||`UID ${row.uid}`)}</b><span>${esc(row.book)} · UID ${Number(row.uid)}${row.nodeLabel?` · ${esc(row.nodeLabel)}`:''}</span></div><button class="menu_button tv2-char-link-result" data-book="${esc(row.book)}" data-uid="${Number(row.uid)}" type="button">Link</button></div>`).join('')}</div>`;
}
const CHARACTER_DETAIL_FIELDS=[
    ['baseline.personality',3],
    ['baseline.appearance',3],
    ['baseline.clothingGear',3],
    ['baseline.identityBackground',3],
    ['persistent.relationships',2],
    ['persistent.goalsMotivations',2],
    ['persistent.behaviorPatterns',2],
    ['persistent.abilitiesCombat',2],
    ['persistent.equipment',2],
    ['persistent.backgroundDevelopments',2],
    ['persistent.conditions',2],
    ['persistent.titlesStatusAffiliations',2],
    ['persistent.physicalChanges',2],
    ['temporary.currentOutfit',2],
    ['temporary.injuries',2],
    ['temporary.mood',2],
    ['temporary.magicalEffects',2],
    ['temporary.carriedItems',2],
    ['temporary.physicalCondition',2],
    ['temporary.sceneNotes',2],
]

function stateFieldEditor(bank,field,{rows=3,placeholder=''}={}){
    const descriptor=CHARACTER_STATE_FIELDS[field];if(!descriptor)return '';
    const value=getCharacterStateField(bank.state,field),provenance=(bank.fieldProvenance?.[field]||[]).slice(-1)[0];
    const source=provenance?.source?.label||provenance?.source?.id||'';
    return `<label class="tv2-character-state-field" data-layer="${esc(descriptor.layer)}"><span><b>${esc(descriptor.label)}</b></span><textarea class="text_pole tv2-char-state-field" data-state-field="${esc(field)}" rows="${Number(rows)||3}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>${source?`<small>Last source · ${esc(source)}</small>`:''}</label>`;
}
function characterProfileTab(bank){
    const tracking=bank.tracking||{};
    const fields=CHARACTER_DETAIL_FIELDS.map(([field,rows])=>stateFieldEditor(bank,field,{rows})).join('');
    const reviewTools=`<details class="tv2-character-bank-section"><summary><b>Review Character</b></summary><div class="tv2-character-tools"><label><span>Recent chat</span><select class="text_pole tv2-char-review-chat-count"><option value="10">Last 10 messages</option><option value="25" selected>Last 25 messages</option><option value="50">Last 50 messages</option><option value="100">Last 100 messages</option></select></label><button class="menu_button tv2-primary-action tv2-char-review-recent-chat" type="button">Review Recent Chat</button></div><small>Manual only. Review uses the enabled Tracking Policy, then Jev agreement, before anything reaches Character State Review.</small></details>`;
    return `<div class="tv2-character-state-profile"><details class="tv2-character-state-group tv2-character-collapsible"><summary class="tv2-character-state-group-head"><div><b>Character Details</b></div></summary><div class="tv2-character-state-group-actions"><button class="menu_button tv2-char-clear-temporary" type="button">Clear Temporary State</button></div><div class="tv2-character-state-grid">${fields}</div></details><details class="tv2-character-bank-section"><summary><b>Tracking policy</b></summary><div class="tv2-capability-grid"><label class="tv2-switch"><input class="tv2-char-track" data-track="personality" type="checkbox" ${tracking.personality!==false?'checked':''}><span>Personality</span></label><label class="tv2-switch"><input class="tv2-char-track" data-track="relationships" type="checkbox" ${tracking.relationships!==false?'checked':''}><span>Relationships</span></label><label class="tv2-switch"><input class="tv2-char-track" data-track="status" type="checkbox" ${tracking.status!==false?'checked':''}><span>Status / conditions / equipment</span></label><label class="tv2-switch"><input class="tv2-char-track" data-track="goals" type="checkbox" ${tracking.goals!==false?'checked':''}><span>Goals / unresolved threads</span></label><label class="tv2-switch"><input class="tv2-char-track" data-track="behavior" type="checkbox" ${tracking.behavior!==false?'checked':''}><span>Behavior changes</span></label></div></details>${reviewTools}</div>`;
}
function characterLinkedTab(bank){
    const memories=getCharacterBankMemories(bank);
    const summaryRows=memories.slice(0,20).map(m=>`<div class="tv2-character-memory-row" data-memory-id="${esc(m.id)}"><div><b>${esc(m.topics?.[0]||`Layer ${m.layer}`)}</b><span>${esc(String(m.text||'').slice(0,320))}${String(m.text||'').length>320?'…':''}</span></div><button class="menu_button tv2-char-summary-review" data-memory-id="${esc(m.id)}" type="button">Review</button></div>`).join('');
    return `<div class="tv2-character-linked-content"><details class="tv2-character-state-group tv2-character-collapsible" open><summary class="tv2-character-state-group-head"><div><b>Linked Lore</b><span>Exact references improve comparison and recall; they do not exclude generic lore.</span></div><span class="tv2-character-meta-text">${bank.linkedRefs?.length||0} lore</span></summary><div class="tv2-character-tools"><button class="menu_button tv2-char-scan" type="button">Scan Tree for Related UIDs</button><div class="tv2-character-manual-link"><select class="text_pole tv2-char-book"><option value="">Lorebook…</option>${bookOptions(bankLorebookSelections.get(bank.id)||'')}</select><input class="text_pole tv2-char-uid" type="number" min="0" placeholder="UID"><button class="menu_button tv2-char-add-uid" type="button">Add UID</button></div></div>${linkedLoreHtml(bank)}${scanHtml(bank)}</details>${memories.length?`<details class="tv2-character-state-group tv2-character-collapsible"><summary class="tv2-character-state-group-head"><div><b>Character-linked Summaries</b><span>Explicit or inferred narrative evidence available to this Bank. Review is always manual.</span></div><span class="tv2-character-meta-text">${memories.length} ${memories.length===1?'summary':'summaries'}</span></summary><div class="tv2-character-memory-list">${summaryRows}</div></details>`:''}</div>`;
}
function characterHistoryTab(bank){
    const history=[...(bank.changeHistory||[])].sort((a,b)=>Number(b.appliedAt||0)-Number(a.appliedAt||0));
    if(!history.length)return '<div class="tv2-empty compact"><b>No applied Character State changes yet.</b><span>Approved Character State changes will appear here.</span></div>';
    return `<div class="tv2-character-history-list">${history.map(row=>{const d=CHARACTER_STATE_FIELDS[row.field]||{};return `<article class="tv2-character-history-row"><div><span class="tv2-character-change-badge ${esc(String(row.classification||'').toLowerCase())}">${esc(row.classification||'UPDATE')}</span><b>${esc(d.label||row.field)}</b><small>${row.appliedAt?new Date(row.appliedAt).toLocaleString():''}${row.source?.label?` · ${esc(row.source.label)}`:''}${row.cardWrite?' · synced to ST Card':''}</small></div><div class="tv2-character-history-diff"><span><em>Before</em>${esc(row.oldValue||'(empty)')}</span><span><em>After</em>${esc(row.newValue||'(empty)')}</span></div></article>`;}).join('')}</div>`;
}
function characterCardSyncTab(bank){
    let draft;try{draft=buildCharacterCardSyncDraft(bank.id);}catch(error){return `<div class="tv2-status-strip failed">${esc(error?.message||String(error))}</div>`;}
    if(!draft.available)return `<div class="tv2-character-card-sync-stack"><div class="tv2-character-card-sync-empty"><b>SillyTavern Character Card Sync</b><span>${esc(draft.reason)}</span><span>Bind or import a SillyTavern card here when this Bank should participate in explicit Card Sync.</span></div>${characterCardToolsHtml()}</div>`;
    const mismatch=(draft.fingerprintMismatch||draft.requiresReconciliation)?`<div class="tv2-status-strip warn"><b>${draft.requiresReconciliation?'Card reconciliation required.':'Character Card changed.'}</b> ${esc(draft.reason)} <button class="menu_button tv2-char-card-reconcile" type="button">Accept Current Card as Baseline</button></div>`:'';
    const fields=draft.fields?.length?draft.fields.map(field=>`<span class="tv2-card-sync-field nx-text-muted">${esc(CHARACTER_STATE_FIELDS[field]?.label||field)}</span>`).join(''):'<span class="tv2-meta">No approved card-eligible fields are waiting.</span>';
    const diffs=draft.changes?.length?draft.changes.map(change=>`<article class="tv2-card-sync-diff"><div><b>${esc(change.field)}</b><small>${change.stateFields.map(field=>esc(CHARACTER_STATE_FIELDS[field]?.label||field)).join(' · ')}</small></div><div class="tv2-card-sync-columns"><label><span>Current Card</span><textarea class="text_pole" rows="8" readonly>${esc(change.current||'')}</textarea></label><label><span>Proposed Card</span><textarea class="text_pole" rows="8" readonly>${esc(change.proposed||'')}</textarea></label></div></article>`).join(''):'<div class="tv2-empty compact"><b>Nothing to write.</b><span>Approve Bank + Card eligible Character State changes first.</span></div>';
    return `<div class="tv2-character-card-sync-stack"><section class="tv2-character-card-sync"><div class="tv2-character-state-group-head"><div><b>SillyTavern Character Card Sync</b><span>${esc(bank.cardBinding?.name||bank.character)}${bank.cardBinding?.avatar?` · ${esc(bank.cardBinding.avatar)}`:''}</span></div><span class="tv2-character-meta-text">${draft.fields?.length||0} eligible fields</span></div>${mismatch}<div class="tv2-card-sync-fields">${fields}</div>${diffs}<div class="tv2-card-sync-actions"><button class="menu_button tv2-primary-action tv2-char-card-apply" data-expected-fingerprint="${esc(draft.card?.fingerprint||'')}" type="button" ${draft.canWrite?'':'disabled'}>Apply Reviewed Card Update</button><span>Only reviewed card-eligible changes are applied.</span></div></section>${characterCardToolsHtml()}</div>`;
}
function characterCard(bank){
    const runtime=getCharacterBankRuntime(bank),memories=getCharacterBankMemories(bank),review=getCharacterStateReviewSnapshot(bank.id),pending=review.pending.length;
    const tab=characterBankViewTab;
    const content=tab==='linked'?characterLinkedTab(bank):tab==='history'?characterHistoryTab(bank):tab==='sync'?characterCardSyncTab(bank):characterProfileTab(bank);
    return `<article class="tv2-character-bank-card tv2-character-continuity-card" data-bank-id="${esc(bank.id)}">
        <div class="tv2-character-bank-head tv2-character-continuity-head"><div><div class="tv2-character-title-row"><input class="text_pole tv2-char-name" value="${esc(bank.character)}" placeholder="Character name"></div><div class="tv2-character-status-line"><span class="tv2-character-meta-text">${esc(bank.role||'supporting')} · ${bank.linkedRefs?.length||0} lore · ${runtime.warm?'Warm':'Standby'} · ${memories.length} summaries</span> ${bank.cardBinding?.avatar?badge(runtime.cardActive?'CARD ACTIVE':runtime.cardBindingState==='bound'?'CARD BOUND':'CARD MISSING',runtime.cardActive||runtime.cardBindingState==='bound'?'good':'warn'):''} ${pending?badge('PENDING','warn'):badge('CLEAN','good')}</div></div><div class="tv2-character-bank-head-actions"><label class="tv2-inline-check tv2-switch"><input class="tv2-char-enabled" type="checkbox" ${bank.enabled?'checked':''}><span>Enabled</span></label><button class="menu_button tv2-char-remove" type="button">Remove</button></div></div>
        <div class="tv2-character-role-row"><label class="tv2-char-role-field"><span>Role</span><span class="tv2-select-shell"><select class="text_pole tv2-char-role"><option value="lead" ${bank.role==='lead'?'selected':''}>Lead</option><option value="supporting" ${bank.role==='supporting'?'selected':''}>Supporting</option><option value="background" ${bank.role==='background'?'selected':''}>Background</option></select></span></label><label class="tv2-char-scene-aware-wrap"><span>Scene behavior</span><label class="tv2-inline-check tv2-switch"><input class="tv2-char-scene-aware" type="checkbox" ${bank.sceneAware?'checked':''}><span>Scene-aware activation</span></label></label></div>
        <div class="tv2-character-view-tabs"><button class="menu_button tv2-character-view-tab ${tab==='profile'?'active':''}" data-view="profile" type="button">Profile</button><button class="menu_button tv2-character-view-tab ${tab==='linked'?'active':''}" data-view="linked" type="button">Linked Content</button><button class="menu_button tv2-character-view-tab ${tab==='history'?'active':''}" data-view="history" type="button">Change Log</button><button class="menu_button tv2-character-view-tab ${tab==='sync'?'active':''}" data-view="sync" type="button">Card Sync${bank.cardSync?.pendingEligibleFields?.length?` <span class="tv2-character-tab-count">${bank.cardSync.pendingEligibleFields.length}</span>`:''}</button></div>
        <div class="tv2-character-view-body">${content}</div>
    </article>`;
}
function groupCharacterReviewProposals(rows=[]){
    return Object.entries(CHARACTER_TRACKING_POLICY).map(([domain,spec])=>({
        domain,
        label:spec.label,
        rows:(rows||[]).filter(row=>characterStateFieldTrackingDomain(row.field)===domain),
    })).filter(group=>group.rows.length);
}
function characterDecisionReviewText(row){
    const status=String(row?.decisionReview?.status||'');
    if(status==='agreed')return 'Jev agreed';
    if(status==='uncertain')return 'Jev uncertain';
    if(status==='unavailable')return 'Jev unavailable';
    return '';
}
function legacyCharacterReviewField(row){
    const d=CHARACTER_STATE_FIELDS[row.field]||{},jev=characterDecisionReviewText(row),kind=String(row.classification||'update').toLowerCase();
    return `<div class="tv2-character-review-row ${esc(kind)}" data-proposal-id="${esc(row.id)}" data-ui-character-review-row="true"><div class="tv2-character-review-row-head"><label><input class="tv2-char-proposal-select" type="checkbox" checked><span class="tv2-character-change-badge ${esc(kind)}">${esc(row.classification||'UPDATE')}</span></label><b>${esc(d.label||row.field)}</b>${row.cardEligible?'<span class="tv2-character-card-eligible-pill">CARD ELIGIBLE</span>':''}<div class="tv2-character-review-row-actions"><button class="menu_button tv2-primary-action tv2-char-proposal-approve" type="button">Approve</button><button class="menu_button tv2-char-proposal-reject" type="button">Reject</button></div></div><small>${esc(row.reason||'Character State delta')} · ${esc(row.source?.type||'source')}${row.source?.label?` · ${esc(row.source.label)}`:''}${jev?` · ${esc(jev)}`:''}</small><div class="tv2-character-review-values"><div><em>Current</em><p>${esc(row.currentValue||'(empty)')}</p></div><div><em>Proposed</em><p>${esc(row.proposedValue||'(empty)')}</p></div></div>${row.evidence?.length?`<details><summary>Evidence</summary><ul>${row.evidence.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></details>`:''}</div>`;
}
function characterReviewPanel(bank){
    if(!bank)return '';
    const snapshot=getCharacterStateReviewSnapshot(bank.id),pending=snapshot.pending,groups=groupCharacterReviewProposals(pending);
    const body=groups.length?groups.map(group=>`<section class="tv2-character-review-policy-card" data-tracking-policy="${esc(group.domain)}"><div class="tv2-character-review-policy-head"><div><b>${esc(group.label)}</b><span>${group.rows.length} proposed change${group.rows.length===1?'':'s'}</span></div><span class="tv2-memory-badge warn">${group.rows.length}</span></div><div class="tv2-character-review-policy-body">${group.rows.map(legacyCharacterReviewField).join('')}</div></section>`).join(''):'<div class="tv2-character-review-empty"><i class="fa-solid fa-circle-check"></i><b>No pending Character State changes</b><span>Use Review Character or a linked Summary when you want Nexus to look for tracked changes.</span></div>';
    const subtitle=pending.length?`${pending.length} change${pending.length===1?'':'s'} across ${groups.length} tracking polic${groups.length===1?'y':'ies'}`:'Up to date';
    return `<aside class="tv2-character-review-panel"><div class="tv2-character-review-panel-head"><div><b>Character State Review</b><span>${subtitle}</span></div>${pending.length?'<span class="tv2-memory-badge warn">PENDING</span>':'<span class="tv2-memory-badge good">CLEAN</span>'}</div><div class="tv2-character-review-list">${body}</div>${pending.length?'<div class="tv2-character-review-footer"><button class="menu_button tv2-primary-action tv2-char-proposal-apply-selected" type="button">Apply Selected</button><span>Every applied field is freshness-checked and recorded with provenance.</span></div>':''}</aside>`;
}
function charactersHtml(){
    const cfg=getSettings().memoryBank?.characterBanks||{enabled:true,banks:[]},banks=getCharacterBanks();
    if(selectedCharacterBankId&&!banks.some(bank=>String(bank.id)===String(selectedCharacterBankId)))selectedCharacterBankId=null;
    if(!selectedCharacterBankId&&banks.length)selectedCharacterBankId=banks[0].id;
    const selected=banks.find(bank=>String(bank.id)===String(selectedCharacterBankId))||null;
    const visible=banks.slice(0,10),overflow=banks.slice(10);
    const search=String(characterBankSearch||'').trim().toLowerCase();
    const tabs=visible.map(bank=>{const pending=getCharacterStateReviewSnapshot(bank.id).pending.length,runtime=getCharacterBankRuntime(bank),searchText=`${bank.character||''} ${bank.role||''}`.toLowerCase(),hidden=search&&!searchText.includes(search);return `<button class="menu_button tv2-character-bank-tab ${String(bank.id)===String(selectedCharacterBankId)?'active':''}" data-bank-id="${esc(bank.id)}" data-character-search="${esc(searchText)}" type="button" ${hidden?'hidden':''}><span class="tv2-character-bank-tab-main"><b>${esc(bank.character||'Unnamed')}</b>${runtime.warm?'<i class="fa-solid fa-bolt" title="Scene-aware / warm"></i>':''}</span><small>${esc(bank.role||'supporting')} · ${bank.linkedRefs?.length||0} lore${pending?` · ${pending} review`:''}</small></button>`;}).join('');
    const overflowSelect=overflow.length?`<label class="tv2-character-bank-overflow"><span>More Character Banks</span><select class="text_pole" id="tv2_character_bank_overflow"><option value="">Choose…</option>${overflow.map(bank=>`<option value="${esc(bank.id)}" ${String(bank.id)===String(selectedCharacterBankId)?'selected':''}>${esc(bank.character||'Unnamed')} · ${esc(bank.role||'supporting')}</option>`).join('')}</select></label>`:'';
    const selector=`<aside class="tv2-character-bank-selector"><div class="tv2-character-bank-sidebar-head"><b>Character Banks</b><label class="tv2-inline-check tv2-switch"><input id="tv2_character_banks_enabled" type="checkbox" ${cfg.enabled!==false?'checked':''}><span>Enabled</span></label></div><label class="tv2-character-bank-search"><i class="fa-solid fa-magnifying-glass"></i><input class="text_pole" id="tv2_character_bank_search" value="${esc(characterBankSearch)}" placeholder="Search characters…" autocomplete="off"></label>${banks.length?`<div class="tv2-character-bank-tabs">${tabs}</div>${overflowSelect}`:'<div class="tv2-empty compact"><b>No Character Banks configured for this story.</b><span>Add one manually or bind the active SillyTavern character.</span></div>'}<button id="tv2_add_character_bank" class="menu_button tv2-character-bank-add" type="button"><i class="fa-solid fa-plus"></i> Add Character Bank</button></aside>`;
    const workspace=selected?`<div class="tv2-character-continuity-workspace"><div class="tv2-character-continuity-main">${characterCard(selected)}</div>${characterReviewPanel(selected)}</div>`:'<div class="tv2-empty compact tv2-character-workspace-empty"><b>No Character Bank selected.</b><span>Add or select a story-local Character Bank to manage continuity.</span></div>';
    return `<div class="tv2-character-bank-layout">${selector}<section class="tv2-character-bank-workspace">${workspace}</section></div>`;
}


function characterBankSelectorNode(cfg,banks){
    const visible=banks.slice(0,10),overflow=banks.slice(10),search=String(characterBankSearch||'').trim().toLowerCase();
    const enabled=nxToggle({label:'',checked:cfg.enabled!==false});
    enabled.title='Enable or disable Character Banks';
    enabled.controlElement.id='tv2_character_banks_enabled';
    enabled.controlElement.setAttribute('aria-label','Enable or disable Character Banks');
    const searchField=nxSearchField({value:characterBankSearch,placeholder:'Search characters…'});
    searchField.controlElement.id='tv2_character_bank_search';
    searchField.controlElement.autocomplete='off';
    const list=nxEl('div',{className:'nx-character-bank-list tv2-character-bank-tabs'});
    for(const bank of visible){
        const pending=getCharacterStateReviewSnapshot(bank.id).pending.length,runtime=getCharacterBankRuntime(bank),searchText=`${bank.character||''} ${bank.role||''}`.toLowerCase(),hidden=search&&!searchText.includes(search);
        const metaText=`${bank.role||'supporting'} · ${bank.linkedRefs?.length||0} lore${runtime.warm?' · Warm':''}`;
        const btn=nxItemRow({
            title:bank.character||'Unnamed',
            meta:metaText,
            trailing:pending?[nxBadge({label:'PENDING',tone:'warning'})]:[],
            interactive:true,
            selected:String(bank.id)===String(selectedCharacterBankId),
            className:'nx-character-bank-item',
            dataset:{bankId:bank.id,characterSearch:searchText,characterBankTab:'true'},
        });
        btn.hidden=hidden;
        list.append(btn);
    }
    const body=[searchField];
    if(banks.length)body.push(list);
    else body.push(nxEmptyState({title:'No Character Banks configured',message:'Add one manually or bind the active SillyTavern character.',icon:'+'}));
    if(overflow.length){
        const more=nxSelect({label:'More Character Banks',value:String(selectedCharacterBankId||''),options:[{value:'',label:'Choose…'},...overflow.map(bank=>({value:bank.id,label:`${bank.character||'Unnamed'} · ${bank.role||'supporting'}`}))]});
        more.controlElement.id='tv2_character_bank_overflow';body.push(more);
    }
    const add=nxButton({label:'Add Character Bank',variant:'secondary',iconClass:'fa-solid fa-plus',className:'tv2-character-bank-add'});add.id='tv2_add_character_bank';
    return nxRail({title:'Character Banks',actions:[enabled],body,footer:[add],side:'left',className:'nx-character-bank-rail'});
}

function characterStateFieldNode(bank,field,{rows=3,placeholder=''}={}){
    const descriptor=CHARACTER_STATE_FIELDS[field];if(!descriptor)return null;
    const value=getCharacterStateField(bank.state,field),provenance=(bank.fieldProvenance?.[field]||[]).slice(-1)[0];
    const source=provenance?.source?.label||provenance?.source?.id||'';
    const control=nxTextarea({label:descriptor.label,value,rows,placeholder,className:'nx-character-state-control'});
    control.controlElement.dataset.stateField=field;
    const node=nxEl('div',{className:'nx-character-state-field'},[control,source?nxProvenanceRow({source:'Last source',note:source}):null].filter(Boolean));
    node.dataset.layer=descriptor.layer;
    return node;
}
function characterTrackingNode(bank){
    const tracking=bank.tracking||{};
    const options=[
        ['personality','Personality'],['relationships','Relationships'],['status','Status / conditions / equipment'],['goals','Goals / unresolved threads'],['behavior','Behavior changes'],
    ].map(([key,label])=>{
        const control=nxToggle({label,checked:tracking[key]!==false,className:'nx-character-tracking-toggle'});
        control.controlElement.dataset.track=key;return control;
    });
    return nxCollapsible({title:'Tracking Policy',subtitle:'Character State intake filters',body:[nxEl('div',{className:'nx-toggle-grid'},options)],open:false,className:'nx-character-section nx-character-tracking'});
}
function characterManualReviewNode(){
    const count=nxSelect({label:'Recent chat',value:'25',options:[{value:'10',label:'Last 10 messages'},{value:'25',label:'Last 25 messages'},{value:'50',label:'Last 50 messages'},{value:'100',label:'Last 100 messages'}],className:'nx-character-review-count'});
    count.controlElement.classList.add('tv2-char-review-chat-count');
    const review=nxButton({label:'Review Recent Chat',variant:'primary',className:'tv2-char-review-recent-chat'});
    return nxCollapsible({title:'Review Character',subtitle:'Manual only · Tracking Policy → Sidecar draft → Jev agreement → Character State Review',body:[nxToolbar({start:[count],end:[review],className:'nx-character-review-toolbar'})],open:false,className:'nx-character-section nx-character-manual-review'});
}
function characterProfileNode(bank){
    const clear=nxButton({label:'Clear Temporary State',variant:'secondary',className:'tv2-char-clear-temporary'});
    const fields=CHARACTER_DETAIL_FIELDS.map(([field,rows])=>characterStateFieldNode(bank,field,{rows})).filter(Boolean);
    const grid=nxEl('div',{className:'nx-form-grid nx-character-state-grid'},fields);
    return nxEl('div',{className:'nx-stack nx-character-profile'},[
        nxCollapsible({title:'Character Details',body:[nxToolbar({end:[clear],className:'nx-character-layer-actions'}),grid],open:false,className:'nx-character-section nx-character-details'}),
        characterTrackingNode(bank),
        characterManualReviewNode(bank),
    ]);
}
function linkedLoreListNode(bank){
    const refs=bank.linkedRefs||[];
    if(!refs.length)return nxEmptyState({title:'No linked lore yet',message:'Scan the Tree or add an exact UID.',icon:'↗'});
    return nxList({items:refs,className:'nx-character-linked-list',renderItem:ref=>{
        const unlink=nxButton({label:'Unlink',variant:'ghost',size:'sm',className:'tv2-char-unlink'});unlink.dataset.book=ref.book;unlink.dataset.uid=String(Number(ref.uid));
        return nxItemRow({title:ref.title||`UID ${ref.uid}`,meta:[ref.nodeLabel||'',ref.book||''].filter(Boolean).join(' · '),leading:[nxUidChip({book:ref.book,uid:Number(ref.uid)})],trailing:[unlink],className:'nx-character-linked-row'});
    }});
}
function characterScanResultsNode(bank){
    const rows=scanResults.get(bank.id)||[];if(!rows.length)return null;
    const linked=new Set((bank.linkedRefs||[]).map(ref=>`${ref.book}:${Number(ref.uid)}`));
    const candidates=rows.filter(row=>!linked.has(`${row.book}:${Number(row.uid)}`));if(!candidates.length)return null;
    return nxPanel({title:'Suggested Lore Links',subtitle:'Tree scan candidates not already linked.',body:[nxList({items:candidates.slice(0,30),renderItem:row=>{
        const link=nxButton({label:'Link',variant:'secondary',size:'sm',className:'tv2-char-link-result'});link.dataset.book=row.book;link.dataset.uid=String(Number(row.uid));
        return nxItemRow({title:row.title||`UID ${row.uid}`,meta:[row.nodeLabel||'',row.book||''].filter(Boolean).join(' · '),leading:[nxEl('span',{className:'nx-text-muted',text:`${Math.round(row.percent||0)}%`}),nxUidChip({book:row.book,uid:Number(row.uid)})],trailing:[link]});
    }})],className:'nx-character-scan-panel'});
}
function characterSummaryListNode(bank){
    const memories=getCharacterBankMemories(bank);
    if(!memories.length)return nxEmptyState({title:'No Character-linked Summaries',message:'Explicit or inferred narrative evidence linked to this Bank will appear here.',icon:'≡'});
    return nxList({items:memories.slice(0,20),className:'nx-character-summary-list',renderItem:m=>{
        const explicit=isCharacterMemoryExplicitlyLinked(bank,m.id);
        const review=nxButton({label:'Review',variant:'secondary',size:'sm',className:'tv2-char-summary-review'});review.dataset.memoryId=String(m.id);
        const unlink=explicit?nxButton({label:'Unlink',variant:'ghost',size:'sm',className:'tv2-char-summary-unlink'}):null;
        if(unlink)unlink.dataset.memoryId=String(m.id);
        return nxItemRow({title:m.topics?.[0]||`Layer ${m.layer}`,meta:`Layer ${m.layer}${m.createdAt?` · ${new Date(m.createdAt).toLocaleString()}`:''}`,leading:[nxBadge({label:explicit?'Explicit':'Inferred',tone:explicit?'info':'neutral'})],trailing:[review,unlink].filter(Boolean),body:[nxEl('p',{className:'nx-text-muted nx-character-summary-excerpt',text:`${String(m.text||'').slice(0,320)}${String(m.text||'').length>320?'…':''}`})]});
    }});
}
function characterLinkedNode(bank){
    const scan=nxButton({label:'Scan Tree for Related UIDs',variant:'secondary'});scan.dataset.characterAction='scan';
    const books=getActiveBooks({requireTree:true,access:'read',injection:'tv2'}).map(book=>({value:book,label:book}));
    const selectedBook=bankLorebookSelections.get(bank.id)||'';
    const book=nxSelect({label:'Lorebook',value:selectedBook,options:[{value:'',label:'Choose lorebook…'},...books],className:'nx-character-lorebook-select'});book.controlElement.classList.add('tv2-char-book');
    const uid=nxInput({label:'UID',type:'number',placeholder:'Exact UID',className:'nx-character-uid-input'});uid.controlElement.classList.add('tv2-char-uid');uid.controlElement.min='0';
    const add=nxButton({label:'Add UID',variant:'secondary',className:'tv2-char-add-uid'});
    const manual=nxEl('div',{className:'nx-character-manual-link'},[book,uid,add]);
    const loreBody=[nxToolbar({start:[scan],end:[manual],className:'nx-character-linked-toolbar'}),linkedLoreListNode(bank),characterScanResultsNode(bank)].filter(Boolean);
    const memories=getCharacterBankMemories(bank);
    const explicitIds=new Set(getAllMemoryRecords().filter(record=>isCharacterMemoryExplicitlyLinked(bank,record.id)).map(record=>String(record.id)));
    const summaryCandidates=getAllMemoryRecords().filter(record=>!explicitIds.has(String(record.id)));
    const summarySelect=nxSelect({label:'Attach Summary',value:'',options:[{value:'',label:summaryCandidates.length?'Choose Summary…':'No additional Summaries'},...summaryCandidates.map(record=>({value:String(record.id),label:`L${record.layer} · ${record.topics?.[0]||record.id}`}))],className:'nx-character-summary-select'});
    summarySelect.controlElement.classList.add('tv2-char-summary-select');
    summarySelect.controlElement.disabled=summaryCandidates.length===0;
    const attachSummary=nxButton({label:'Attach',variant:'secondary',size:'sm',className:'tv2-char-summary-link',disabled:summaryCandidates.length===0});
    const summaryTools=nxToolbar({start:[summarySelect],end:[attachSummary],className:'nx-character-summary-toolbar'});
    return nxEl('div',{className:'nx-stack nx-character-linked'},[
        nxCollapsible({title:'Linked Lore',subtitle:'Exact references improve comparison and recall; they do not exclude generic lore.',summaryEnd:[nxEl('span',{className:'nx-text-muted',text:`${bank.linkedRefs?.length||0} lore`})],body:loreBody,open:true,className:'nx-character-section'}),
        nxCollapsible({title:'Character-linked Summaries',subtitle:'Attach an exact Summary explicitly, while inferred character evidence remains visible automatically.',summaryEnd:[nxEl('span',{className:'nx-text-muted',text:`${memories.length} ${memories.length===1?'summary':'summaries'}`})],body:[summaryTools,characterSummaryListNode(bank)],open:false,className:'nx-character-section'}),
    ]);
}
function characterHistoryNode(bank){
    const history=[...(bank.changeHistory||[])].sort((a,b)=>Number(b.appliedAt||0)-Number(a.appliedAt||0));
    if(!history.length)return nxEmptyState({title:'No applied Character State changes yet',message:'Approved Character State changes will appear here.',icon:'↺'});
    return nxList({items:history,className:'nx-character-history-list',renderItem:row=>{
        const d=CHARACTER_STATE_FIELDS[row.field]||{};
        const tone=String(row.classification||'').toUpperCase()==='CONFLICT'?'warning':String(row.classification||'').toUpperCase()==='NEW'?'success':'info';
        return nxItemRow({title:d.label||row.field,meta:[row.appliedAt?new Date(row.appliedAt).toLocaleString():'',row.source?.label||'',row.cardWrite?'Synced to ST Card':''].filter(Boolean).join(' · '),leading:[nxBadge({label:row.classification||'UPDATE',tone})],body:[nxDiffView({before:row.oldValue||'(empty)',after:row.newValue||'(empty)',beforeLabel:'Before',afterLabel:'After'})],className:'nx-character-history-row'});
    }});
}
function cardImportTargetOptionsNode(preview){
    const banks=getCharacterBanks(),bound=preview?.exactBankId||'',sameName=new Set(preview?.sameNameBankIds||[]),options=[{value:'new',label:'Create new Character Bank'}];
    for(const bank of banks){if(bank.id!==bound&&!sameName.has(bank.id))continue;const binding=characterBankCardStatus(bank);if(binding.bound&&bank.id!==bound)continue;options.push({value:bank.id,label:`${bank.id===bound?'Update bound bank':'Bind existing'} · ${bank.character||'Unnamed bank'}`});}
    return {options,value:bound||'new'};
}
function cardImportFieldNode(key,label,proposed,current,source,checked){
    const changed=String(proposed||'')!==String(current||'');
    const accept=nxCheckbox({label,checked:!!checked,disabled:!proposed,className:'nx-card-import-accept-wrap'});accept.controlElement.classList.add('tv2-card-import-accept');accept.controlElement.dataset.field=key;
    const before=nxTextarea({label:'Current',value:current||'',rows:3,className:'nx-card-import-current'});before.controlElement.classList.add('tv2-card-current');before.controlElement.readOnly=true;
    const after=nxTextarea({label:'Card proposal',value:proposed||'',rows:3,placeholder:proposed?'':'No deterministic value found',className:'nx-card-import-proposed'});after.controlElement.classList.add('tv2-card-proposed');after.controlElement.dataset.proposal=key;
    return nxItemRow({leading:[changed?nxBadge({label:'CHANGED',tone:'warning'}):nxBadge({label:'SAME'})],title:label,meta:source?`Source: ${source}`:'No safe card mapping',body:[nxEl('div',{className:'nx-card-import-field-grid'},[accept,before,after])],className:'nx-card-import-field'});
}
function cardImportPreviewNode(){
    const preview=cardImportPreview;if(!preview)return null;
    const bank=preview.currentBank||null,scan=preview.scan,card=preview.card,currentProfile=bank?.profile||{},proposed=scan.proposals||{profile:{}};
    const exact=bank?.cardBinding?.avatar===card.avatar;
    const unchanged=exact&&bank?.cardBinding?.fingerprint===card.fingerprint&&String(bank.character||'')===String(proposed.character||'')&&String(currentProfile.personality||'')===String(proposed.profile?.personality||'')&&String(currentProfile.appearance||'')===String(proposed.profile?.appearance||'')&&String(currentProfile.clothingArmor||'')===String(proposed.profile?.clothingArmor||'');
    const dismiss=nxButton({label:'Dismiss',variant:'ghost',size:'sm',className:'tv2-card-preview-dismiss'});
    const targetData=cardImportTargetOptionsNode(preview),target=nxSelect({label:'Character Bank target',value:targetData.value,options:targetData.options,className:'nx-card-import-target'});target.controlElement.classList.add('tv2-card-import-target-select');
    const fields=[
        cardImportFieldNode('character','Character name',proposed.character,bank?.character||'',scan.provenance?.character?.join(' + '),!bank||!bank.character||bank.character===proposed.character),
        cardImportFieldNode('profile.personality','Personality / temperament',proposed.profile?.personality,currentProfile.personality||'',scan.provenance?.['profile.personality']?.join(' + '),!currentProfile.personality||currentProfile.personality===proposed.profile?.personality),
        cardImportFieldNode('profile.appearance','Appearance / identifying details',proposed.profile?.appearance,currentProfile.appearance||'',scan.provenance?.['profile.appearance']?.join(' + '),!currentProfile.appearance||currentProfile.appearance===proposed.profile?.appearance),
        cardImportFieldNode('profile.clothingArmor','Clothing / armor / carried gear',proposed.profile?.clothingArmor,currentProfile.clothingArmor||'',scan.provenance?.['profile.clothingArmor']?.join(' + '),!currentProfile.clothingArmor||currentProfile.clothingArmor===proposed.profile?.clothingArmor),
    ];
    const notices=[];
    if(preview.sameNameBankIds?.length&&!preview.exactBankId)notices.push(nxNotice({title:'Same-name Character Bank detected',message:'Nexus will not overwrite or bind it automatically; choose it explicitly or create a new bank.',tone:'warning'}));
    if(unchanged)notices.push(nxNotice({title:'Bound card is unchanged',message:'No Character Bank mutation is required.',tone:'success'}));
    if(scan.excludedInstructionFields?.length)notices.push(nxNotice({title:'Instruction fields excluded',message:scan.excludedInstructionFields.join(', '),tone:'info'}));
    const raw=[['Description',scan.unmappedContext?.description],['Scenario',scan.unmappedContext?.scenario],['Creator notes',scan.unmappedContext?.creatorNotes]].filter(([,v])=>v).map(([title,value])=>nxItemRow({title,body:[nxEl('pre',{className:'nx-code-block',text:value})]}));
    const sourceContext=raw.length?nxCollapsible({title:'Unmapped Card Context',subtitle:'Reference-only card text that was not mapped into Character State.',body:raw,open:false}):null;
    const apply=nxButton({label:bank?'Apply Reviewed Delta':'Create & Bind Character Bank',variant:'primary',disabled:unchanged,className:'tv2-card-preview-apply'});
    return nxPanel({title:card.name||'Current SillyTavern Character',subtitle:card.avatar||'',actions:[dismiss],body:[...notices,target,nxEl('div',{className:'nx-stack nx-card-import-fields'},fields),sourceContext].filter(Boolean),footer:[apply],className:'nx-card-import-preview'});
}
function characterCardToolsNode(){
    let current=null;try{current=inspectSillyTavernCharacter();}catch{}
    let rows=[];try{rows=listSillyTavernCharacters();}catch{}
    const importFile=nxEl('input',{id:'tv2_character_card_import_file',type:'file',hidden:true,attrs:{accept:'.png,.json,image/png,application/json'}});
    const bind=nxButton({label:'Bind Current ST Character',variant:'primary',iconClass:'fa-solid fa-link'});bind.id='tv2_character_card_import_current';
    const importButton=nxButton({label:'Import Character Card',variant:'secondary',iconClass:'fa-solid fa-file-import'});importButton.id='tv2_character_card_import';
    const exportCharacter=nxSelect({label:'Export character',value:current?.avatar||'',options:[{value:'',label:'Choose character…'},...rows.map(row=>({value:row.avatar,label:row.name||row.avatar}))]});exportCharacter.controlElement.id='tv2_character_card_export_character';
    const format=nxSelect({label:'Format',value:'png',options:[{value:'png',label:'PNG'},{value:'json',label:'JSON'}]});format.controlElement.id='tv2_character_card_export_format';
    const exportButton=nxButton({label:'Export Character Card',variant:'secondary',iconClass:'fa-solid fa-file-export'});exportButton.id='tv2_character_card_export';
    const tone=cardToolStatus.state==='failed'?'danger':cardToolStatus.state==='complete'?'success':cardToolStatus.state==='working'?'info':'neutral';
    const status=nxNotice({title:cardToolStatus.state==='working'?'Working':cardToolStatus.state==='failed'?'Card operation failed':cardToolStatus.state==='complete'?'Card operation complete':'Card tools ready',message:cardToolStatus.message,tone,className:'nx-card-tool-status'});status.id='tv2_character_card_status';status.dataset.state=cardToolStatus.state;
    const controls=nxEl('div',{className:'nx-character-card-tools-grid'},[bind,importButton,exportCharacter,format,exportButton]);
    return nxCollapsible({title:'SillyTavern Character Cards',subtitle:'Optional card bind / import / export',summaryEnd:[nxEl('span',{className:'nx-text-muted',text:current?`Current: ${current.name||current.avatar}`:'No active card'})],body:[importFile,controls,status,cardImportPreviewNode()].filter(Boolean),open:false,className:'nx-character-card-tools'});
}
function characterCardSyncNode(bank){
    let draft;try{draft=buildCharacterCardSyncDraft(bank.id);}catch(error){return nxNotice({title:'Card Sync unavailable',message:error?.message||String(error),tone:'danger'});}
    if(!draft.available)return nxEl('div',{className:'nx-stack nx-character-card-sync-stack'},[
        nxPanel({title:'SillyTavern Character Card Sync',subtitle:draft.reason,body:[nxEmptyState({title:'No bound Character Card',message:'Bind or import a SillyTavern card below when this Bank should participate in explicit Card Sync.',icon:'↔'})]}),
        characterCardToolsNode(),
    ]);
    const actions=[];
    const body=[];
    if(draft.fingerprintMismatch||draft.requiresReconciliation){const reconcile=nxButton({label:'Accept Current Card as Baseline',variant:'secondary',className:'tv2-char-card-reconcile'});body.push(nxNotice({title:draft.requiresReconciliation?'Card reconciliation required':'Character Card changed',message:draft.reason,tone:'warning',actions:[reconcile]}));}
    body.push(nxEl('div',{className:'nx-card-sync-fields nx-text-muted'},draft.fields?.length?draft.fields.map(field=>nxEl('span',{className:'nx-text-muted',text:CHARACTER_STATE_FIELDS[field]?.label||field})):[nxEl('span',{className:'nx-text-muted',text:'No pending card-eligible fields'})]));
    if(draft.changes?.length){for(const change of draft.changes)body.push(nxPanel({title:change.field,subtitle:change.stateFields.map(field=>CHARACTER_STATE_FIELDS[field]?.label||field).join(' · '),body:[nxDiffView({before:change.current||'',after:change.proposed||'',beforeLabel:'Current Card',afterLabel:'Proposed Card'})],className:'nx-card-sync-diff'}));}
    else body.push(nxEmptyState({title:'Nothing to write',message:'Approve Bank + Card eligible Character State changes first.',icon:'✓'}));
    const apply=nxButton({label:'Apply Reviewed Card Update',variant:'primary',disabled:!draft.canWrite,className:'tv2-char-card-apply'});apply.dataset.expectedFingerprint=draft.card?.fingerprint||'';
    actions.push(apply,nxEl('small',{text:'Only reviewed card-eligible changes are applied.'}));
    return nxEl('div',{className:'nx-stack nx-character-card-sync-stack'},[
        nxPanel({title:'SillyTavern Character Card Sync',subtitle:`${bank.cardBinding?.name||bank.character}${bank.cardBinding?.avatar?` · ${bank.cardBinding.avatar}`:''}`,actions:[nxEl('span',{className:'nx-text-muted',text:`${draft.fields?.length||0} eligible fields`})],body,footer:actions,className:'nx-character-card-sync'}),
        characterCardToolsNode(),
    ]);
}
function characterCardNode(bank){
    const runtime=getCharacterBankRuntime(bank),memories=getCharacterBankMemories(bank),review=getCharacterStateReviewSnapshot(bank.id),pending=review.pending.length;
    const name=nxEl('input',{className:'nx-input nx-input--title',value:bank.character||'',dataset:{characterField:'name'},attrs:{placeholder:'Character name'}});
    const meta=nxEl('span',{className:'nx-text-muted',text:`${String(bank.role||'supporting').replace(/^./,c=>c.toUpperCase())} · ${bank.linkedRefs?.length||0} lore · ${runtime.warm?'Warm':'Standby'} · ${memories.length} summaries`});
    const status=nxEl('div',{className:'nx-character-bank-status'},[
        meta,
        bank.cardBinding?.avatar?nxBadge({label:runtime.cardActive?'CARD ACTIVE':runtime.cardBindingState==='bound'?'CARD BOUND':'CARD MISSING',tone:runtime.cardActive||runtime.cardBindingState==='bound'?'success':'warning'}):null,
        pending?nxBadge({label:'PENDING',tone:'warning'}):nxBadge({label:'CLEAN',tone:'success'}),
    ].filter(Boolean));
    const enabled=nxToggle({label:'Enabled',checked:bank.enabled!==false});enabled.controlElement.dataset.characterField='enabled';
    const remove=nxButton({label:'Remove',variant:'secondary',className:'tv2-char-remove'});
    const head=nxEl('div',{className:'nx-character-bank-head'},[
        nxEl('div',{className:'nx-character-bank-identity'},[
            nxEl('div',{className:'nx-character-bank-title-row'},[name]),status,
        ]),
        nxEl('div',{className:'nx-character-bank-head-actions'},[enabled,remove]),
    ]);
    const role=nxSelect({label:'Role',value:bank.role||'supporting',options:[{value:'lead',label:'Lead'},{value:'supporting',label:'Supporting'},{value:'background',label:'Background'}]});role.controlElement.dataset.characterField='role';
    const scene=nxToggle({label:'Scene-aware activation',checked:bank.sceneAware!==false});scene.controlElement.dataset.characterField='sceneAware';
    const roleRow=nxEl('div',{className:'nx-character-role-grid'},[role,scene]);
    const tabItems=[['profile','Profile'],['linked','Linked Content'],['history','Change Log'],['sync','Card Sync']].map(([id,label])=>{
        let content=[];
        if(id===characterBankViewTab){
            const node=id==='linked'?characterLinkedNode(bank):id==='history'?characterHistoryNode(bank):id==='sync'?characterCardSyncNode(bank):characterProfileNode(bank);
            content=[nxEl('div',{className:'nx-character-view-body'},[node])];
        }
        const pendingCard=bank.cardSync?.pendingEligibleFields?.length||0;
        return {id,label,end:id==='sync'&&pendingCard?[nxEl('span',{className:'nx-text-muted',text:String(pendingCard)})]:[],content};
    });
    const tabView=nxTabs({items:tabItems,active:characterBankViewTab,onChange:id=>{if(characterBankViewTab!==id){characterBankViewTab=id;render();}},className:'nx-character-tabs'});
    const card=nxPanel({body:[head,roleRow,tabView],className:'nx-character-bank-panel'});card.dataset.uiCoreCharacterCard='true';
    card.dataset.bankId=String(bank.id);return card;
}
function characterReviewFieldNode(row){
    const d=CHARACTER_STATE_FIELDS[row.field]||{},jev=characterDecisionReviewText(row),kind=String(row.classification||'update').toLowerCase();
    const tone=kind==='conflict'?'warning':kind==='new'?'success':kind==='redundant'?'neutral':'info';
    const select=nxEl('input',{type:'checkbox',className:'nx-character-review-select tv2-char-proposal-select',attrs:{'aria-label':`Select ${d.label||row.field}`}});select.checked=true;
    const actions=nxEl('div',{className:'nx-character-review-row__actions'},[
        nxButton({label:'Approve',variant:'success',size:'sm',className:'tv2-char-proposal-approve'}),
        nxButton({label:'Reject',variant:'danger',size:'sm',className:'tv2-char-proposal-reject'}),
    ]);
    const head=nxEl('div',{className:'nx-character-review-row__header'},[
        select,
        nxBadge({label:kind.toUpperCase(),tone}),
        nxEl('strong',{text:d.label||row.field}),
        row.cardEligible?nxBadge({label:'CARD ELIGIBLE',tone:'info'}):null,
        actions,
    ].filter(Boolean));
    const source=[row.reason||'Character State delta',row.source?.type||'source',row.source?.label||'',jev||''].filter(Boolean).join(' · ');
    const values=nxEl('div',{className:'nx-character-review-row__values'},[
        nxEl('div',{className:'nx-character-review-value'},[
            nxEl('span',{className:'nx-text-muted',text:'Current'}),
            nxEl('p',{text:row.currentValue||'(empty)'}),
        ]),
        nxEl('div',{className:'nx-character-review-value'},[
            nxEl('span',{className:'nx-text-muted',text:'Proposed'}),
            nxEl('p',{text:row.proposedValue||'(empty)'}),
        ]),
    ]);
    const evidence=row.evidence?.length?nxEl('details',{className:'nx-character-review-row__evidence'},[
        nxEl('summary',{text:`Evidence (${row.evidence.length})`}),
        nxEl('ul',{},row.evidence.slice(0,5).map(item=>nxEl('li',{text:item}))),
    ]):null;
    const field=nxEl('div',{className:`nx-character-review-row nx-character-review-row--${kind}`},[
        head,
        nxEl('small',{className:'nx-character-review-row__source',text:source}),
        values,
        evidence,
    ].filter(Boolean));
    field.dataset.proposalId=String(row.id);field.dataset.uiCharacterReviewRow='true';return field;
}
function characterReviewPolicyNode(group){
    return nxPanel({
        title:group.label,
        subtitle:`${group.rows.length} proposed change${group.rows.length===1?'':'s'}`,
        actions:[nxBadge({label:String(group.rows.length),tone:'warning'})],
        body:[nxEl('div',{className:'nx-character-review-policy-rows'},group.rows.map(characterReviewFieldNode))],
        className:`nx-character-review-policy-card nx-character-review-policy-card--${group.domain}`,
    });
}
function characterReviewNode(bank){
    if(!bank)return null;
    const snapshot=getCharacterStateReviewSnapshot(bank.id),pending=snapshot.pending,groups=groupCharacterReviewProposals(pending);
    const body=groups.length?groups.map(characterReviewPolicyNode):[
        nxEmptyState({title:'No pending Character State changes',message:'Use Review Character or a linked Summary when you want Nexus to look for tracked changes.',icon:'✓'})
    ];
    const actions=[pending.length?nxBadge({label:'PENDING',tone:'warning'}):nxBadge({label:'CLEAN',tone:'success'})];
    const footer=[];
    if(pending.length){const apply=nxButton({label:'Apply Selected',variant:'primary',className:'tv2-char-proposal-apply-selected'});footer.push(apply,nxEl('small',{text:'Every applied field is freshness-checked and recorded with provenance.'}));}
    const subtitle=pending.length?`${pending.length} change${pending.length===1?'':'s'} across ${groups.length} tracking polic${groups.length===1?'y':'ies'}`:'Up to date';
    return nxRail({title:'Character State Review',subtitle,actions,body,footer,side:'right',className:'nx-character-review-rail'});
}
function charactersNode(){
    const cfg=getSettings().memoryBank?.characterBanks||{enabled:true,banks:[]},banks=getCharacterBanks();
    if(selectedCharacterBankId&&!banks.some(bank=>String(bank.id)===String(selectedCharacterBankId)))selectedCharacterBankId=null;
    if(!selectedCharacterBankId&&banks.length)selectedCharacterBankId=banks[0].id;
    const selected=banks.find(bank=>String(bank.id)===String(selectedCharacterBankId))||null;
    const left=characterBankSelectorNode(cfg,banks);
    const center=selected?characterCardNode(selected):nxEl('div',{className:'nx-character-empty-center'},nxEmptyState({title:'No Character Bank selected',message:'Add or select a story-local Character Bank to manage continuity.',icon:'•'}));
    const right=selected?characterReviewNode(selected):null;
    return nxWorkspace({left:[left],center:[center],right:right?[right]:[],className:'nx-character-workspace'});
}


function summaryRecordNode(r,{archive=false}={}){
    const queued=getLoreReviewQueueEntry(r.id),queueActive=['queued','reviewing'].includes(String(queued?.state||'')),reviewable=isLoreReviewableMemory(r);
    let unresolvedSaga=false;try{unresolvedSaga=hasUnresolvedLoreRoutingSaga(r.id,{chatId:getContext?.()?.chatId});}catch{}
    if(!reviewable||queueActive)selectedLoreReviewIds.delete(String(r.id));
    const trailing=[];
    if(r.permanent===true)trailing.push(nxBadge({label:'PERMANENT',tone:'success'}));
    if(r.locked===true&&r.permanent!==true)trailing.push(nxBadge({label:'LOCKED',tone:'success'}));
    if(queueActive)trailing.push(nxBadge({label:queued.state==='reviewing'?'REVIEWING':'QUEUED',tone:queued.state==='reviewing'?'success':'warning'}));
    else if(queued?.state==='failed'&&reviewable)trailing.push(nxBadge({label:'REVIEW FAILED',tone:'danger'}));
    else if(queued?.state==='stale'&&reviewable)trailing.push(nxBadge({label:'REVIEW STALE',tone:'warning'}));
    if(r.routeState==='unrouted')trailing.push(nxBadge({label:'UNROUTED',tone:'warning'}));
    else if(r.routeState==='proposed')trailing.push(nxBadge({label:'PROPOSED',tone:'success'}));
    else if(r.routeState==='direct-written')trailing.push(nxBadge({label:'DIRECT WRITE',tone:'warning'}));
    else if(r.routeState==='routed-noop')trailing.push(nxBadge({label:'LORE CHECKED',tone:'success'}));
    else if(r.routeState==='failed')trailing.push(nxBadge({label:'ROUTE FAILED',tone:'danger'}));
    else if(r.routeState==='partial')trailing.push(nxBadge({label:'PARTIAL',tone:'warning'}));
    if(unresolvedSaga)trailing.push(nxBadge({label:'RECOVERY PENDING',tone:'warning'}));
    if(archive){const validity=memoryRecordValidity(r);if(validity.valid!==true)trailing.push(nxBadge({label:'STALE SOURCE',tone:'warning',title:`Archived provenance is stale: ${validity.reason||'source changed'}`}));}
    const meta=[r.assistantTurnRange?`Assistant turns ${r.assistantTurnRange[0]}–${r.assistantTurnRange[1]}`:r.turnRange?`Messages ${Number(r.turnRange[0])+1}–${Number(r.turnRange[1])+1}`:'',...(r.characters||[]).slice(0,4)].filter(Boolean).join(' · ');
    const leading=[];
    if(!archive&&reviewable&&!queueActive&&r.permanent!==true){
        const select=nxCheckbox({label:'Lore',checked:selectedLoreReviewIds.has(String(r.id)),className:'tv2-memory-lore-selector'});
        select.controlElement.classList.add('tv2-memory-lore-select');
        leading.push(select);
    }
    const characterLinks=getCharacterBanks().filter(bank=>isCharacterMemoryExplicitlyLinked(bank,r.id)||getCharacterBankMemories(bank).some(memory=>String(memory.id)===String(r.id))).slice(0,4);
    if(characterLinks.length)leading.push(nxEl('span',{className:'nx-text-muted',text:characterLinks.map(bank=>`${bank.character}${bank.cardBinding?.avatar?' · ST card':''}`).join(' · ')}));
    const body=[nxEl('p',{className:'nx-summary-text',text:r.text||''})];
    if((r.threads||[]).length)body.push(nxEl('small',{className:'nx-summary-threads',text:`Threads: ${(r.threads||[]).join(' · ')}`}));
    if(!archive){
        const actions=[];
        if(!queueActive&&r.permanent!==true&&r.locked!==true){const digest=nxSelect({value:'',options:[{value:'',label:'Digest…'},{value:'lore',label:'Digest → Lore Proposals'},{value:'notebook',label:'Digest → Notebook'}],className:'nx-summary-digest'});digest.controlElement.classList.add('tv2-memory-digest-destination');const deleteAfter=nxSelect({label:'Delete after digest',value:'no',options:[{value:'no',label:'No'},{value:'yes',label:'Yes'}],className:'nx-summary-delete-after-digest'});deleteAfter.controlElement.classList.add('tv2-memory-delete-after-digest');actions.push(digest,deleteAfter);}
        if(getCharacterBanks().length)actions.push(nxButton({label:'Review for Character Bank…',variant:'secondary',size:'sm',className:'tv2-memory-character-review'}));
        actions.push(nxButton({label:r.permanent===true?'Make Temporary':'Make Permanent',variant:'secondary',size:'sm',className:'tv2-memory-permanent'}));
        actions.push(nxButton({label:'Delete',variant:'danger',size:'sm',disabled:queueActive||unresolvedSaga,className:'tv2-memory-delete'}));
        body.push(nxToolbar({start:actions,className:'nx-summary-actions'}));
        const moreActions=[nxButton({label:'Regenerate',size:'sm',disabled:r.locked===true,className:'tv2-memory-regenerate'})];
        if(r.revisions?.length)moreActions.push(nxButton({label:'Undo Revision',size:'sm',className:'tv2-memory-revision-rollback'}));
        body.push(nxCollapsible({title:'More',body:[nxToolbar({start:moreActions})],open:false}));
    }
    return nxItemRow({title:r.topics?.[0]||`Memory ${String(r.id).slice(-8)}`,meta,leading,trailing,body,className:`nx-summary-row${archive?' nx-summary-row--archive':''}`,dataset:{memoryId:r.id}});
}
function permanentNode(){
    const records=getPermanentMemoryRecords().sort((a,b)=>(b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0));
    return nxWorkspace({center:[nxPanel({title:'Permanent Memory Tank',actions:[nxEl('span',{className:'nx-text-muted',text:`${records.length} permanent`})],body:records.length?records.map(r=>summaryRecordNode(r)): [nxEmptyState({title:'No permanent memories yet',message:'Use Make Permanent on an active Narrative Summary.',icon:'•'})]})],className:'nx-memory-permanent-workspace'});
}
function notebookNode(){
    const note=getNotebook(),writes=getLoreWriteLedger(),receipts=getLoreWriteReceipts(),updated=note.updatedAt?new Date(note.updatedAt).toLocaleString():'not created yet',displayText=notebookDirty&&notebookDraft!==null?notebookDraft:note.text;
    const field=nxTextarea({label:'Current State',value:displayText,rows:16,placeholder:'Current scene state, character goals/needs, user direction, commitments, unresolved questions…',help:`Last updated ${updated} by ${note.updatedBy||'none'}.`});field.controlElement.classList.add('tv2-notebook-text');
    const save=nxButton({label:'Save World State',variant:'primary'});save.type='submit';
    const refresh=nxButton({label:'Refresh From Recent Scene',className:'tv2-notebook-refresh'});
    const controls=[save,refresh];if(note.revisions?.length)controls.push(nxButton({label:'Undo Notebook Revision',className:'tv2-notebook-rollback'}));
    const form=nxEl('form',{className:'tv2-notebook-form nx-notebook-form'},[field,nxToolbar({start:controls,className:'nx-notebook-actions'})]);
    const sourceBadges=getCharacterBanks().filter(bank=>bank.enabled).map(bank=>nxEl('span',{className:'nx-text-muted',text:`${bank.character||'Unnamed'}${bank.cardBinding?.avatar?' · ST card':''}`}));
    const current=nxPanel({title:'Rolling World-State Notebook',actions:[nxEl('span',{className:'nx-text-muted',text:`${Math.min(note.revisions?.length||0,6)} shown · ${note.revisions?.length||0} stored`})],body:[sourceBadges.length?nxToolbar({start:sourceBadges,className:'nx-notebook-character-sources'}):null,form]});
    const history=[];const allRevisions=note.revisions||[],revisions=allRevisions.slice(-6),revisionOffset=Math.max(0,allRevisions.length-revisions.length);for(let i=revisions.length-1;i>=0;i--){const rev=revisions[i],after=i===revisions.length-1?note.text:revisions[i+1].text;history.push(nxCollapsible({title:`Revision ${revisionOffset+i+1}`,subtitle:`${rev.updatedAt?new Date(rev.updatedAt).toLocaleString():'unknown time'} · ${rev.updatedBy||'unknown source'}`,body:[nxHistoryRow({time:rev.updatedAt?new Date(rev.updatedAt).toLocaleString():'',type:'REVISION',title:rev.updatedBy||'Notebook revision',detail:'Recoverable historical current-state snapshot',status:'RECOVERABLE',tone:'info'}),nxDiffView({before:rev.text||'',after:after||'',beforeLabel:'Revision',afterLabel:i===revisions.length-1?'Current State':'Next Revision'})]}));}
    const historyPanel=nxCollapsible({title:'History / Diff',open:false,className:'nx-notebook-history',body:history.length?history:[nxEmptyState({title:'No Notebook revisions yet',message:'A revision is retained whenever the Notebook text changes.',icon:'•'})]});
    const digestPanel=lastNotebookDigestPreview?nxPanel({title:'Last Summary → Notebook Digest',subtitle:lastNotebookDigestPreview.reason||'Notebook updated',body:[nxDiffView({before:lastNotebookDigestPreview.before||'',after:lastNotebookDigestPreview.after||'',beforeLabel:'Before digest',afterLabel:'After digest'})]}):null;
    const recoveryRows=[];for(const w of writes.slice(0,20)){const actions=[];if(!w.undone&&isDirectWriteRollbackAvailable(w)){const b=nxButton({label:'Rollback',variant:'danger',size:'sm',className:'tv2-write-rollback'});actions.push(b);}recoveryRows.push(nxItemRow({title:`${w.book} · ${w.operation?.type||'write'}`,meta:`${new Date(w.at).toLocaleString()}${w.undone?' · rolled back':` · ${w.state||'recorded'}`}`,trailing:actions,dataset:{writeId:w.id}}));}
    const receiptRows=receipts.slice(0,100).map(r=>nxItemRow({title:`${r.book} · ${r.operationType||'write'}`,meta:`${new Date(r.at).toLocaleString()}${r.proposalId?` · Proposal ${r.proposalId}`:''}`}));
    const advanced=nxCollapsible({title:'Advanced / Recovery',subtitle:`${writes.filter(w=>!w.undone).length} reversible Direct Write${writes.filter(w=>!w.undone).length===1?'':'s'} · ${receipts.length} archived receipt${receipts.length===1?'':'s'}`,body:[nxPanel({title:'Direct write recovery',body:recoveryRows.length?recoveryRows:[nxEmptyState({title:'No direct writes in this chat',message:'Recovery entries appear only when the Write Valve has Direct Write history.',icon:'•'})]}),nxPanel({title:'Archived write receipts',body:receiptRows.length?receiptRows:[nxEmptyState({title:'No archived Direct Write receipts',message:'Completed direct writes appear here for recovery history.',icon:'•'})]})]});
    return nxWorkspace({center:[current,digestPanel,historyPanel,advanced].filter(Boolean),className:'nx-memory-notebook-workspace'});
}
function notebookHtml(){const note=getNotebook(),writes=getLoreWriteLedger(),receipts=getLoreWriteReceipts(),updated=note.updatedAt?new Date(note.updatedAt).toLocaleString():'not created yet',displayText=notebookDirty&&notebookDraft!==null?notebookDraft:note.text;const characterSources=getCharacterBanks().filter(bank=>bank.enabled);const characterSourceHtml=characterSources.length?`<section class="tv2-notebook-character-sources"><div><b>Character continuity sources</b><span>Characters currently available to the Notebook.</span></div><div>${characterSources.map(bank=>`<span class="tv2-character-meta-text">${esc(bank.character||'Unnamed')}${bank.cardBinding?.avatar?' · ST card':''}</span>`).join('')}</div></section>`:'';const digestPreview=lastNotebookDigestPreview?`<details class="tv2-notebook-digest-preview" open><summary><b>Last Summary → Notebook digest</b><span>${esc(lastNotebookDigestPreview.reason||'Notebook updated')}</span></summary><div class="tv2-notebook-digest-grid"><label>Before<textarea class="text_pole" rows="8" readonly>${esc(lastNotebookDigestPreview.before||'')}</textarea></label><label>After<textarea class="text_pole" rows="8" readonly>${esc(lastNotebookDigestPreview.after||'')}</textarea></label></div></details>`:'';return `<section class="tv2-notebook-intro"><b>Rolling World-State Notebook</b></section>${characterSourceHtml}${digestPreview}<form class="tv2-notebook-form"><textarea class="text_pole tv2-notebook-text" rows="16" placeholder="Current scene state, character goals/needs, user direction, commitments, unresolved questions…">${esc(displayText)}</textarea><small class="tv2-notebook-meta">Last updated ${esc(updated)} by ${esc(note.updatedBy||'none')} · ${note.revisions?.length||0} recoverable revision${(note.revisions?.length||0)===1?'':'s'}.</small><div><button class="menu_button tv2-primary-action" type="submit">Save World State</button><button class="menu_button tv2-notebook-refresh" type="button">Refresh From Recent Scene</button>${note.revisions?.length?'<button class="menu_button tv2-notebook-rollback" type="button">Undo Notebook Revision</button>':''}</div></form><details class="tv2-direct-ledger"><summary>Advanced / Recovery · ${writes.filter(w=>!w.undone).length} reversible writes</summary>${writes.length?writes.slice(0,20).map(w=>`<div data-write-id="${esc(w.id)}"><b>${esc(w.book)}</b> · ${esc(w.operation?.type||'write')} · ${new Date(w.at).toLocaleString()} ${w.undone?'<em>rolled back</em>':isDirectWriteRollbackAvailable(w)?'<button class="menu_button tv2-write-rollback" type="button">Rollback</button>':`<em>${esc(w.state||'not reversible')}</em>`}</div>`).join(''):'<span>No direct writes in this chat.</span>'}</details><details class="tv2-direct-ledger tv2-direct-receipts"><summary>Archived write receipts · ${receipts.length}</summary>${receipts.length?receipts.slice(0,100).map(r=>`<div><b>${esc(r.book)}</b> · ${esc(r.operationType||'write')} · ${new Date(r.at).toLocaleString()}${r.proposalId?` · Proposal ${esc(r.proposalId)}`:''}</div>`).join(''):'<span>No archived Direct Write receipts in this chat.</span>'}</details>`;}
function oldestManualPromotionLayer(){
    const maxLayers=Math.max(1,Number(getSettings().memoryBank?.maxLayers)||5);
    for(let layer=0;layer<maxLayers-1;layer++){
        const eligible=getActiveLayerRecords(layer).filter(record=>record.locked!==true&&record.permanent!==true);
        if(eligible.length>=2)return layer;
    }
    return null;
}
async function condenseOlderMemories(){
    const layer=oldestManualPromotionLayer();
    if(layer===null){
        globalThis.toastr?.info('At least two temporary, unlocked summaries are needed before anything can be condensed.','Nexus Memory Bank',{timeOut:3000});
        return {skipped:true,reason:'not-enough-memories'};
    }
    return await runAction('summary-promote',{fromLayer:layer});
}
function render(){
    if(!overlay)return;const body=overlay.querySelector('.tv2-memory-bank-body');if(!body)return;
    if(!hasActiveMemoryStory()){
        selectedCharacterBankId=null;
        body.innerHTML="<div class=\"tv2-empty tv2-memory-no-story\"><b>Select a chat to view this story's Memory Bank.</b><span>Summaries, Character Banks, permanent memory, and Notebook state are isolated to the active story.</span></div>";
        return;
    }
    if(activeTab==='notebook'&&notebookDirty){const existing=body.querySelector('.tv2-notebook-text');if(existing)notebookDraft=existing.value;}
    const content=activeTab==='permanent'?permanentHtml():activeTab==='notebook'?notebookHtml():activeTab==='narrative'?narrativeHtml():'';
    body.innerHTML=`${statusHtml()}<div class="tv2-memory-tabs"><button class="menu_button tv2-memory-tab ${activeTab==='narrative'?'active':''}" data-tab="narrative" type="button">Narrative</button><button class="menu_button tv2-memory-tab ${activeTab==='permanent'?'active':''}" data-tab="permanent" type="button">Permanent</button><button class="menu_button tv2-memory-tab ${activeTab==='characters'?'active':''}" data-tab="characters" type="button">Characters</button><button class="menu_button tv2-memory-tab ${activeTab==='notebook'?'active':''}" data-tab="notebook" type="button">Notebook</button></div><div class="tv2-memory-tab-content">${content}</div>`;
    const target=body.querySelector('.tv2-memory-tab-content');
    if(activeTab==='characters'){
        try{
            target?.replaceChildren(charactersNode());
        }catch(error){
            logEvent('ui-core','character-workspace-render-failed',{error,activeCharacterTab:characterBankViewTab,bankId:selectedCharacterBankId||null,fallback:'legacy-character-workspace'},'error');
            if(target)target.innerHTML=`<div class="tv2-status-strip warn tv2-ui-core-character-fallback"><b>Character workspace UI fallback active.</b> UI Core failed to mount this view; Character Bank behavior remains available through the previous renderer.</div>${charactersHtml()}`;
            if(!characterUiCoreFallbackNotified){
                characterUiCoreFallbackNotified=true;
                globalThis.toastr?.warning('The new Character workspace UI failed to mount, so Nexus restored the previous Character renderer. A diagnostic was recorded.','Nexus UI Core',{timeOut:5000});
            }
        }
    }else if(['permanent','notebook'].includes(activeTab)){
        try{
            const node=activeTab==='permanent'?permanentNode():notebookNode();
            target?.replaceChildren(node);
        }catch(error){
            logEvent('ui-core','memory-workspace-render-failed',{error,activeTab,fallback:'legacy-memory-renderer'},'error');
        }
    }
    bindRenderedBody(body);
}
function bindRenderedBody(body){
    body.querySelectorAll('.tv2-memory-tab').forEach(btn=>btn.addEventListener('click',()=>{activeTab=btn.dataset.tab||'narrative';render();}));
    if(activeTab==='notebook'){
        const form=body.querySelector('.tv2-notebook-form'),text=form?.querySelector('.tv2-notebook-text');
        text?.addEventListener('input',e=>{notebookDirty=true;notebookDraft=e.currentTarget.value;});
        form?.addEventListener('submit',async e=>{e.preventDefault();try{await saveNotebook(text?.value||'');notebookDirty=false;notebookDraft=null;render();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Notebook');}});
        body.querySelector('.tv2-notebook-refresh')?.addEventListener('click',async e=>{e.currentTarget.disabled=true;try{await refreshNotebookFromScene({manual:true});notebookDirty=false;notebookDraft=null;render();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Notebook refresh');e.currentTarget.disabled=false;}});
        body.querySelector('.tv2-notebook-rollback')?.addEventListener('click',async()=>{try{await rollbackNotebook();notebookDirty=false;notebookDraft=null;render();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Notebook rollback');}});
        body.querySelectorAll('.tv2-write-rollback').forEach(btn=>btn.addEventListener('click',async()=>{const id=btn.closest('[data-write-id]').dataset.writeId;if(globalThis.confirm?.(`Rollback this direct write? This will restore the previous lore/Tree state.`)===false)return;try{await rollbackDirectWrite(id,{actor:'operator-recovery'});render();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus write rollback');}}));return;
    }
    if(activeTab==='narrative'||activeTab==='permanent'){
        body.querySelectorAll('.tv2-memory-regenerate').forEach(btn=>btn.addEventListener('click',async e=>{e.currentTarget.disabled=true;try{await regenerateMemoryRecord(e.currentTarget.closest('[data-memory-id]').dataset.memoryId);render();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Memory regeneration');e.currentTarget.disabled=false;}}));
        body.querySelectorAll('.tv2-memory-revision-rollback').forEach(btn=>btn.addEventListener('click',async()=>{try{await rollbackMemoryRevision(btn.closest('[data-memory-id]').dataset.memoryId);render();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Memory rollback');}}));
        body.querySelector('#tv2_memory_run_summary,.tv2-memory-run-summary')?.addEventListener('click',()=>{summarizePanelOpen=!summarizePanelOpen;render();});body.querySelector('#tv2_memory_promote,.tv2-memory-promote')?.addEventListener('click',()=>condenseOlderMemories());body.querySelector('#tv2_memory_scan,.tv2-memory-scan')?.addEventListener('click',()=>{bankScanReport=scanMemoryBank();render();});body.querySelectorAll('.tv2-memory-scan-gap').forEach(btn=>btn.addEventListener('click',async()=>{const start=Number(btn.dataset.gapStart),end=Number(btn.dataset.gapEnd);if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return;btn.disabled=true;await runAction('summary-create',{range:{fromMessage:start+1,toMessage:end+1}});bankScanReport=scanMemoryBank();render();}));
        const form=body.querySelector('.tv2-summary-range-form');form?.querySelector('.tv2-summary-mode')?.addEventListener('change',e=>{const custom=e.currentTarget.value==='range';form.querySelector('.tv2-summary-custom').hidden=!custom;form.querySelector('.tv2-summary-count-wrap').hidden=custom;});form?.addEventListener('submit',async e=>{e.preventDefault();const mode=form.querySelector('.tv2-summary-mode').value;if(mode==='range')await runAction('summary-create',{range:{fromMessage:Number(form.querySelector('.tv2-summary-from').value),toMessage:Number(form.querySelector('.tv2-summary-to').value)}});else await runAction('summary-create',{});});
        body.querySelectorAll('.tv2-memory-lore-select').forEach(box=>box.addEventListener('change',()=>{const id=box.closest('[data-memory-id]')?.dataset.memoryId;if(!id)return;if(box.checked)selectedLoreReviewIds.add(String(id));else selectedLoreReviewIds.delete(String(id));render();}));body.querySelector('.tv2-send-selected-lore')?.addEventListener('click',()=>{const ids=[...selectedLoreReviewIds];selectedLoreReviewIds.clear();queueLoreReviewSelection(ids);});body.querySelectorAll('.tv2-memory-digest-destination').forEach(sel=>sel.addEventListener('change',async()=>{const card=sel.closest('[data-memory-id]'),memoryId=card?.dataset.memoryId,destination=sel.value,deleteAfterDigest=card?.querySelector('.tv2-memory-delete-after-digest')?.value==='yes';sel.value='';if(!memoryId||!destination)return;sel.disabled=true;try{if(destination==='lore'){const result=await runAction('lore-route',{memoryId,deleteAfterDigest});if(result&&!result.failed)openProposalPanel();render();return;}if(destination==='notebook'){const before=getNotebook().text||'';const result=await digestMemoryToNotebook(memoryId,{deleteAfterDigest});if(result?.digested){lastNotebookDigestPreview={memoryId,before,after:result.notebook?.text||'',reason:result.reason||'Summary digested into Notebook'};activeTab='notebook';const retained=result.deleted===true?'Summary digested into the Notebook and removed from the Summary Bank.':'Summary digested into the Notebook and kept in the Summary Bank.';globalThis.toastr?.success(retained,'Nexus Memory Bank',{timeOut:2600});}else globalThis.toastr?.info(result?.reason||'Notebook did not need this Summary; it was kept.','Nexus Memory Bank',{timeOut:2200});render();}}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Summary digest');render();}}));body.querySelectorAll('.tv2-memory-character-review').forEach(btn=>btn.addEventListener('click',async()=>{const memoryId=btn.closest('[data-memory-id]')?.dataset.memoryId;if(!memoryId||characterReviewBusy)return;characterReviewBusy=true;btn.disabled=true;try{globalThis.toastr?.info('Reviewing Summary for character-specific state changes…','Nexus Character State',{timeOut:1600});const result=await reviewSummaryForCharacterState(memoryId);if(result.proposals?.length){activeTab='characters';const first=result.proposals[0];selectedCharacterBankId=first.bankId||selectedCharacterBankId;globalThis.toastr?.success(result.reason,'Nexus Character State',{timeOut:2600});}else globalThis.toastr?.info(result.reason||'No Character Bank changes detected.','Nexus Character State',{timeOut:2600});render();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Character State');}finally{characterReviewBusy=false;}}));body.querySelectorAll('.tv2-memory-permanent').forEach(btn=>btn.addEventListener('click',async()=>{const id=btn.closest('[data-memory-id]')?.dataset.memoryId;try{const record=await toggleMemoryPermanentProtected(id);render();globalThis.toastr?.success(record?.permanent?'Summary moved to Permanent and protected.':'Summary returned to Narrative memory.','Nexus Memory Bank',{timeOut:1800});}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Memory Bank');return null;}}));body.querySelectorAll('.tv2-memory-delete').forEach(btn=>btn.addEventListener('click',async()=>{const id=btn.closest('[data-memory-id]')?.dataset.memoryId;if(!id)return;try{if(hasUnresolvedLoreRoutingSaga(id,{chatId:getContext?.()?.chatId}))throw new Error('This Summary has unresolved Lore recovery work. Reconcile recovery before deleting it.');if(globalThis.confirm?.('Delete this Summary? Its source range will become eligible to summarize again.')===false)return;await deleteMemoryRecord(id,{reason:'operator-delete'});unlinkCharacterMemoryEverywhere(id);render();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Memory delete');}}));return;
    }
    body.querySelector('#tv2_character_card_import_current')?.addEventListener('click',()=>{
        try{
            const card=inspectSillyTavernCharacter();
            const scan=scanCharacterCardDeterministically(card);
            const exact=findCharacterBankByCardAvatar(card.avatar);
            const sameName=getCharacterBanks().filter(bank=>bank.id!==exact?.id&&String(bank.character||'').trim().toLowerCase()===String(card.name||'').trim().toLowerCase()&&!bank.cardBinding?.avatar);
            cardImportPreview={card,scan,exactBankId:exact?.id||'',sameNameBankIds:sameName.map(bank=>bank.id),targetBankId:exact?.id||'new',currentBank:exact||null};
            cardStatus(`Scanned current SillyTavern character: ${card.name||card.avatar}.`,'complete');render();
        }catch(error){cardStatus(error?.message||String(error),'failed');render();globalThis.toastr?.error(error?.message||String(error),'Nexus Character Bank');}
    });
    const importButton=body.querySelector('#tv2_character_card_import'),importInput=body.querySelector('#tv2_character_card_import_file');
    importButton?.addEventListener('click',()=>importInput?.click());
    importInput?.addEventListener('change',async()=>{const file=importInput.files?.[0];if(!file)return;importButton.disabled=true;cardStatus(`Importing ${file.name}…`,'working');try{const out=await importCharacterCard(file);cardStatus(`Imported ${String(out.file_name||file.name).replace(/\.png$/i,'')}. Activate that SillyTavern character, then use Bind Current ST Character to bind it.`,'complete');globalThis.toastr?.success('Character card imported into SillyTavern.','Nexus');}catch(error){cardStatus(error?.message||String(error),'failed');globalThis.toastr?.error(error?.message||String(error),'Nexus character import failed');}finally{importInput.value='';render();}});
    body.querySelector('#tv2_character_card_export')?.addEventListener('click',async e=>{const btn=e.currentTarget,avatar=body.querySelector('#tv2_character_card_export_character')?.value||'',format=body.querySelector('#tv2_character_card_export_format')?.value||'png';btn.disabled=true;cardStatus('Exporting character card…','working');try{const out=await exportCharacterCard({avatarUrl:avatar,format});downloadCharacterCard(out);cardStatus(`Exported ${out.filename}.`,'complete');globalThis.toastr?.success(`Character exported: ${out.filename}`,'Nexus');}catch(error){cardStatus(error?.message||String(error),'failed');globalThis.toastr?.error(error?.message||String(error),'Nexus character export failed');}finally{render();}});
    body.querySelector('.tv2-card-preview-dismiss')?.addEventListener('click',()=>{cardImportPreview=null;cardStatus('Ready.','idle');render();});
    body.querySelector('.tv2-card-import-target-select')?.addEventListener('change',e=>{rebuildCardPreviewTarget(e.currentTarget.value);render();});
    body.querySelector('.tv2-card-preview-apply')?.addEventListener('click',()=>{
        if(!cardImportPreview)return;try{
            const preview=cardImportPreview,bank=preview.currentBank||null,card=preview.card;
            const accepted=new Set([...body.querySelectorAll('.tv2-card-import-accept:checked')].map(el=>el.dataset.field));
            const proposalValue=field=>body.querySelector(`.tv2-card-proposed[data-proposal="${CSS.escape(field)}"]`)?.value||'';
            const profile={...(bank?.profile||{})};
            if(accepted.has('profile.personality'))profile.personality=proposalValue('profile.personality');
            if(accepted.has('profile.appearance'))profile.appearance=proposalValue('profile.appearance');
            if(accepted.has('profile.clothingArmor'))profile.clothingArmor=proposalValue('profile.clothingArmor');
            const character=accepted.has('character')?proposalValue('character'):(bank?.character||card.name||'');
            const binding=buildCardBinding(card,Date.now(),bank?.cardBinding||null);
            let saved;
            if(bank){bindCharacterBankCard(bank.id,binding);saved=updateCharacterBank(bank.id,{character,profile,cardBinding:binding});}
            else saved=addCharacterBank({character,profile,cardBinding:binding,role:'supporting',enabled:true,sceneAware:true});
            cardImportPreview=null;cardStatus(`Bound ${saved?.character||card.name} to SillyTavern card ${card.avatar}.`,'complete');render();globalThis.toastr?.success(`Character Bank linked to ${card.name||card.avatar}.`,'Nexus Character Bank');
        }catch(error){cardStatus(error?.message||String(error),'failed');render();globalThis.toastr?.error(error?.message||String(error),'Nexus Character Bank');}
    });
    body.querySelector('#tv2_character_banks_enabled')?.addEventListener('change',e=>{setCharacterBanksEnabled(e.currentTarget.checked);render();});
    body.querySelector('#tv2_character_bank_search')?.addEventListener('input',e=>{characterBankSearch=e.currentTarget.value||'';const needle=characterBankSearch.trim().toLowerCase();body.querySelectorAll('[data-character-bank-tab="true"],.tv2-character-bank-tab').forEach(btn=>{const hay=String(btn.dataset.characterSearch||'').toLowerCase();btn.hidden=!!needle&&!hay.includes(needle);});});
    body.querySelectorAll('[data-character-bank-tab="true"],.tv2-character-bank-tab').forEach(btn=>btn.addEventListener('click',()=>{selectedCharacterBankId=btn.dataset.bankId||null;render();}));
    body.querySelector('#tv2_character_bank_overflow')?.addEventListener('change',e=>{if(e.currentTarget.value){selectedCharacterBankId=e.currentTarget.value;render();}});
    body.querySelector('#tv2_add_character_bank')?.addEventListener('click',()=>{const bank=addCharacterBank({character:'',role:'supporting',enabled:true,sceneAware:true});selectedCharacterBankId=bank.id;render();setTimeout(()=>overlay?.querySelector(`[data-bank-id="${CSS.escape(bank.id)}"] [data-character-field="name"], [data-bank-id="${CSS.escape(bank.id)}"] .tv2-char-name`)?.focus(),0);});
    body.querySelectorAll('[data-ui-core-character-card="true"],.tv2-character-bank-card').forEach(card=>bindCharacterCard(card));
    body.querySelectorAll('[data-ui-character-review-row="true"] .tv2-char-proposal-approve,.tv2-character-review-row .tv2-char-proposal-approve').forEach(btn=>btn.addEventListener('click',async()=>{
        const proposalId=btn.closest('[data-proposal-id]')?.dataset.proposalId;if(!proposalId)return;btn.disabled=true;
        try{await approveCharacterStateProposal(proposalId);render();globalThis.toastr?.success('Character State change applied.','Nexus Character State',{timeOut:1800});}catch(error){btn.disabled=false;globalThis.toastr?.error(error?.message||String(error),'Nexus Character State');}
    }));
    body.querySelectorAll('[data-ui-character-review-row="true"] .tv2-char-proposal-reject,.tv2-character-review-row .tv2-char-proposal-reject').forEach(btn=>btn.addEventListener('click',async()=>{
        const proposalId=btn.closest('[data-proposal-id]')?.dataset.proposalId;if(!proposalId)return;btn.disabled=true;
        try{await rejectCharacterStateProposal(proposalId,'operator-rejected');render();globalThis.toastr?.info('Character State proposal rejected.','Nexus Character State',{timeOut:1600});}catch(error){btn.disabled=false;globalThis.toastr?.error(error?.message||String(error),'Nexus Character State');}
    }));
    body.querySelector('.tv2-char-proposal-apply-selected')?.addEventListener('click',async e=>{
        const ids=[...body.querySelectorAll('[data-ui-character-review-row="true"] .tv2-char-proposal-select:checked,.tv2-character-review-row .tv2-char-proposal-select:checked')].map(el=>el.closest('[data-proposal-id]')?.dataset.proposalId).filter(Boolean);
        if(!ids.length){globalThis.toastr?.warning('Select at least one Character State proposal.','Nexus Character State');return;}
        const btn=e.currentTarget;btn.disabled=true;try{const result=await applySelectedCharacterStateProposals(ids);render();const applied=Array.isArray(result?.applied)?result.applied.length:ids.length;globalThis.toastr?.success(`${applied} Character State change${applied===1?'':'s'} applied.`,'Nexus Character State',{timeOut:2200});}catch(error){btn.disabled=false;globalThis.toastr?.error(error?.message||String(error),'Nexus Character State');}
    });
}
function patchBankFromCard(card,extra={}){
    const id=card.dataset.bankId;if(!id)return;
    const current=getCharacterBanks().find(bank=>String(bank.id)===String(id));if(!current)return;
    const tracking={};card.querySelectorAll('[data-track],.tv2-char-track').forEach(el=>tracking[el.dataset.track]=el.checked===true);
    let state=current.state;
    card.querySelectorAll('[data-state-field]').forEach(el=>{state=setCharacterStateField(state,el.dataset.stateField,el.value||'');});
    updateCharacterBank(id,{character:card.querySelector('[data-character-field="name"],.tv2-char-name')?.value||'',enabled:card.querySelector('[data-character-field="enabled"],.tv2-char-enabled')?.checked===true,role:card.querySelector('[data-character-field="role"],.tv2-char-role')?.value||'supporting',sceneAware:card.querySelector('[data-character-field="sceneAware"],.tv2-char-scene-aware')?.checked===true,tracking,state,...extra});
}
function bindCharacterCard(card){
    const id=card.dataset.bankId;
    const lorebookSelect=card.querySelector('.tv2-char-book');
    if(lorebookSelect?.value)bankLorebookSelections.set(id,lorebookSelect.value);
    lorebookSelect?.addEventListener('change',()=>{bankLorebookSelections.set(id,lorebookSelect.value||'');});
    card.querySelectorAll('[data-character-field],[data-track],[data-state-field],.tv2-char-name,.tv2-char-enabled,.tv2-char-role,.tv2-char-scene-aware,.tv2-char-track,.tv2-char-state-field').forEach(el=>el.addEventListener('change',()=>{patchBankFromCard(card);render();}));
    card.querySelectorAll('.tv2-character-view-tab').forEach(btn=>btn.addEventListener('click',()=>{characterBankViewTab=btn.dataset.view||'profile';render();}));
    card.querySelector('.tv2-char-review-recent-chat')?.addEventListener('click',async e=>{
        if(characterReviewBusy)return;
        const btn=e.currentTarget,count=Number(card.querySelector('.tv2-char-review-chat-count')?.value)||25;
        characterReviewBusy=true;btn.disabled=true;
        try{
            patchBankFromCard(card);
            globalThis.toastr?.info(`Reviewing the last ${count} chat messages for enabled Character Tracking Policy changes…`,'Nexus Character State',{timeOut:1600});
            const result=await reviewRecentChatForCharacterState(id,{messageCount:count});
            render();
            if(result.proposals?.length)globalThis.toastr?.success(result.reason,'Nexus Character State',{timeOut:2600});
            else globalThis.toastr?.info(result.reason||'No tracked Character State changes detected.','Nexus Character State',{timeOut:2600});
        }catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Character State');}
        finally{characterReviewBusy=false;}
    });
    card.querySelectorAll('.tv2-char-summary-review').forEach(btn=>btn.addEventListener('click',async e=>{
        if(characterReviewBusy)return;
        const memoryId=e.currentTarget.dataset.memoryId||e.currentTarget.closest('[data-memory-id]')?.dataset.memoryId;
        if(!memoryId)return;
        characterReviewBusy=true;e.currentTarget.disabled=true;
        try{
            patchBankFromCard(card);
            globalThis.toastr?.info('Reviewing this Summary against enabled Character Tracking Policy…','Nexus Character State',{timeOut:1600});
            const result=await reviewSummaryForCharacterState(memoryId,{bankIds:[id]});
            render();
            if(result.proposals?.length)globalThis.toastr?.success(result.reason,'Nexus Character State',{timeOut:2600});
            else globalThis.toastr?.info(result.reason||'No tracked Character State changes detected.','Nexus Character State',{timeOut:2600});
        }catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Character State');}
        finally{characterReviewBusy=false;}
    }));
    card.querySelector('.tv2-char-clear-temporary')?.addEventListener('click',()=>{
        const bank=getCharacterBanks().find(row=>String(row.id)===String(id));if(!bank)return;
        if(globalThis.confirm?.(`Clear current temporary state for "${bank.character||'this character'}"? Baseline and persistent state will be preserved.`)===false)return;
        let state=bank.state;
        Object.keys(CHARACTER_STATE_FIELDS).filter(field=>field.startsWith('temporary.')).forEach(field=>{state=setCharacterStateField(state,field,'');});
        state={...state,temporary:{...state.temporary,updatedAt:Date.now(),sceneId:'',sourceRevision:''}};
        updateCharacterBank(id,{state});render();
        globalThis.toastr?.success('Temporary Character State cleared.','Nexus Character State',{timeOut:1800});
    });
    card.querySelector('.tv2-char-card-reconcile')?.addEventListener('click',async e=>{
        const btn=e.currentTarget;if(globalThis.confirm?.('Accept the current SillyTavern Character Card as the new sync baseline? This does not change Character Bank state or write to the card.')===false)return;
        btn.disabled=true;try{await reconcileCharacterCardBinding(id);render();globalThis.toastr?.success('Current Character Card accepted as the reconciliation baseline.','Nexus Card Sync',{timeOut:2200});}catch(error){btn.disabled=false;globalThis.toastr?.error(error?.message||String(error),'Nexus Card Sync');}
    });
    card.querySelector('.tv2-char-card-apply')?.addEventListener('click',async e=>{
        const btn=e.currentTarget,expected=btn.dataset.expectedFingerprint||'';
        if(globalThis.confirm?.('Apply the reviewed Character State changes to the bound SillyTavern Character Card?')===false)return;
        btn.disabled=true;try{const result=await commitCharacterCardSync(id,{expectedFingerprint:expected});render();globalThis.toastr?.success(result?.reason||'Character Card sync complete.','Nexus Card Sync',{timeOut:2600});}catch(error){btn.disabled=false;globalThis.toastr?.error(error?.message||String(error),'Nexus Card Sync');}
    });
    card.querySelector('.tv2-char-remove')?.addEventListener('click',()=>{const name=card.querySelector('[data-character-field="name"],.tv2-char-name')?.value||'this bank';if(globalThis.confirm?.(`Remove Character Bank for "${name}"?`)===false)return;removeCharacterBank(id);scanResults.delete(id);characterScanGeneration.delete(id);bankLorebookSelections.delete(id);if(String(selectedCharacterBankId)===String(id))selectedCharacterBankId=null;render();});
    card.querySelector('[data-character-action="scan"],.tv2-char-scan')?.addEventListener('click',async e=>{const btn=e.currentTarget,character=card.querySelector('[data-character-field="name"],.tv2-char-name')?.value?.trim();bankLorebookSelections.set(id,card.querySelector('.tv2-char-book')?.value||'');if(!character){globalThis.toastr?.warning('Enter a character name first.','Nexus Character Bank');return;}patchBankFromCard(card);const generation=(characterScanGeneration.get(id)||0)+1;characterScanGeneration.set(id,generation);btn.disabled=true;try{globalThis.toastr?.info(`Scanning Tree for ${character}…`,'Nexus Character Bank',{timeOut:1200});const rows=await scanCharacterLore(character);const current=getCharacterBanks().find(bank=>String(bank.id)===String(id));if(characterScanGeneration.get(id)!==generation||!current||String(current.character||'').trim()!==character){logEvent('character-memory','lore-scan-stale-discarded',{bankId:id,character},'debug');return;}scanResults.set(id,rows);render();globalThis.toastr?.success(`${rows.length} related lore candidate${rows.length===1?'':'s'} found.`,'Nexus Character Bank');}catch(error){logEvent('character-memory','lore-scan-ui-failed',{bankId:id,character,error},'error');globalThis.toastr?.error(error?.message||String(error),'Nexus Character Bank');}finally{if(characterScanGeneration.get(id)===generation)btn.disabled=false;}});
    card.querySelector('.tv2-char-add-uid')?.addEventListener('click',async ()=>{const book=card.querySelector('.tv2-char-book')?.value||'',uid=card.querySelector('.tv2-char-uid')?.value;bankLorebookSelections.set(id,book);if(!book||uid===''){globalThis.toastr?.warning('Choose a Nexus lorebook and enter an exact UID.','Nexus Character Bank');return;}try{const ref=await resolveCharacterLoreRef(book,uid);linkCharacterLore(id,ref);render();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Character Bank');}});
    card.querySelectorAll('.tv2-char-unlink').forEach(btn=>btn.addEventListener('click',()=>{unlinkCharacterLore(id,btn.dataset.book,btn.dataset.uid);render();}));
    card.querySelectorAll('.tv2-char-link-result').forEach(btn=>btn.addEventListener('click',()=>{const row=(scanResults.get(id)||[]).find(r=>String(r.book)===String(btn.dataset.book)&&Number(r.uid)===Number(btn.dataset.uid));if(row)linkCharacterLore(id,row);render();}));
    card.querySelector('.tv2-char-summary-link')?.addEventListener('click',()=>{const memoryId=card.querySelector('.tv2-char-summary-select')?.value||'';if(!memoryId){globalThis.toastr?.warning('Choose a Summary to attach.','Nexus Character Bank');return;}try{linkCharacterMemory(id,memoryId);render();globalThis.toastr?.success('Summary attached to Character Bank.','Nexus Character Bank',{timeOut:1800});}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Character Bank');}});
    card.querySelectorAll('.tv2-char-summary-unlink').forEach(btn=>btn.addEventListener('click',()=>{unlinkCharacterMemory(id,btn.dataset.memoryId);render();}));
}
function queueLoreReviewSelection(ids=[]){
    try{const result=queueLoreReviewMemories(ids.filter(Boolean),{source:'memory-bank-ui'});render();if(result.queued>0)globalThis.toastr?.success(`${result.queued} Lore Review job${result.queued===1?'':'s'} queued. You can keep working while they run.`,'Nexus Memory Bank',{timeOut:2200});else if(result.duplicates?.length)globalThis.toastr?.info('Those summaries are already queued for Lore Review.','Nexus Memory Bank',{timeOut:2200});else globalThis.toastr?.warning('No selected summaries are currently eligible for Lore Review.','Nexus Memory Bank',{timeOut:2500});return result;}catch(error){logEvent('memory','lore-review-queue-ui-failed',{error},'error');globalThis.toastr?.error(error?.message||String(error),'Nexus Lore Review queue');return {queued:0,failed:true,error:error?.message||String(error)};}
}
async function runAction(task,opts={}){try{globalThis.toastr?.info(`${task.replaceAll('-',' ')} starting…`,'Nexus Memory Bank',{timeOut:1200});const r=await runLifecycleTask(task,opts);render();if(r?.failed||r?.status==='failed'||r?.status==='partial')globalThis.toastr?.error(r.error||`Lifecycle ended ${r.status||'failed'}`,'Nexus Memory Bank',{timeOut:4000});else if(r?.skipped)globalThis.toastr?.warning(`${task.replaceAll('-',' ')} skipped: ${r.reason||'nothing to process'}`,'Nexus Memory Bank',{timeOut:3500});else if(task==='summary-promote'&&!(r?.promotions>0))globalThis.toastr?.warning('No summary promotion is due.','Nexus Memory Bank',{timeOut:3000});else if(task==='lore-route'&&!(r?.count>0))globalThis.toastr?.warning('No unrouted memories are waiting.','Nexus Memory Bank',{timeOut:3000});else globalThis.toastr?.success(`${task.replaceAll('-',' ')} complete.`,'Nexus Memory Bank',{timeOut:2200});return r;}catch(error){logEvent('memory','manual-ui-task-failed',{task,error},'error');globalThis.toastr?.error(error?.message||String(error),'Nexus Memory Bank');}}
function onMemoryStoryScopeChanged(){scanResults.clear();bankLorebookSelections.clear();selectedLoreReviewIds.clear();render();}
function bindMemoryWindowListeners(){
    if(memoryWindowListenersBound)return;
    memoryWindowListenersBound=true;
    window.addEventListener('tv2-memory-bank-updated',render);
    window.addEventListener(getLoreReviewQueueChangeEventName(),render);
    window.addEventListener('tv2-character-banks-updated',render);
    window.addEventListener('tv2-scheduler-updated',render);
    window.addEventListener('tv2-notebook-updated',render);
    window.addEventListener('tv2-lore-write-ledger-updated',render);
    window.addEventListener(getSummaryDurableRoutingEventName(),render);
    window.addEventListener(getMainBridgeStatusEventName(),render);
    window.addEventListener('tv2-story-scope-changed',onMemoryStoryScopeChanged);
}
function ensureOverlay(){if(overlay?.isConnected)return overlay;overlay=document.createElement('div');overlay.className='tv2-overlay tv2-memory-bank-overlay';overlay.style.display='none';overlay.innerHTML=`<div class="tv2-memory-bank-panel"><div class="tv2-panel-head tv2-window-head"><div class="tv2-window-head-copy"><div class="tv2-window-head-title"><i class="fa-solid fa-brain"></i><div><h3 class="tv2-tv-header-title">Nexus Memory Bank</h3><div class="tv2-tv-header-subtitle">Summaries · Permanent · Characters · Notebook</div></div></div></div><div class="tv2-window-head-meta"><div class="tv2-shared-sidecar-status" aria-label="Main and Sidecar runtime status"></div><button class="menu_button tv2-memory-close tv2-window-head-close" type="button" title="Close Memory Bank"><i class="fa-solid fa-xmark"></i><span>Close</span></button></div></div><div class="tv2-memory-bank-body"></div></div>`;document.body.appendChild(overlay);const panel=overlay.querySelector('.tv2-memory-bank-panel');makeDraggableWindow(panel,{handle:panel?.querySelector('.tv2-panel-head'),storageKey:'memory-bank',resizable:true,minWidth:700,minHeight:480});bindSidecarStatus(panel?.querySelector('.tv2-shared-sidecar-status'),{includeQueue:false,includeMain:true});overlay.querySelector('.tv2-memory-close')?.addEventListener('click',()=>overlay.style.display='none');overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.style.display='none';});bindMemoryWindowListeners();return overlay;}
export function openMemoryBank(tab='narrative'){ensureOverlay();activeTab=['characters','permanent','notebook'].includes(tab)?tab:'narrative';const panel=overlay.querySelector('.tv2-memory-bank-panel');centerDraggableWindow(panel,{storageKey:'memory-bank',clearStored:true});render();overlay.style.display='flex';}
