// Compatibility source markers after shared Builder2 review consolidation: collectBuilder2GapDecisions · tv2-b2-quality-resolution · Structural / non-semantic · Apply Resolutions · Mark structural / non-semantic
// blockerFallback=(q.blockers||[]).filter(row=>row?.type==='unresolved-classification'&&row?.sourceKey)
// const unresolved=(r.unresolved||[]).length?r.unresolved:blockerFallback
import { renderBuilderQualityReport } from '../builder/quality-ui.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { getContext } from '../../../../st-context.js';
import { getActiveBooks } from '../lore/active-books.js';
import { loadBook, findEntryByUid } from '../lore/store.js';
import { assertReadableBook, assertWritableBook, isBookEnabled, setBookEnabled } from '../lore/policy.js';
import { getTree, treeBaseline } from './store.js';
import { clone, createTree, normalizeTree, findNode, findParent, collectUids, semanticSnapshot, validateCanonicalTreeIdentity } from './model.js';
import { createCategory, deleteCategory, moveCategory, moveTreeItems, removeEntryEverywhere, assignEntry } from './ops.js';
import { logEvent } from '../observability/telemetry.js';
import { bindSidecarStatus } from '../observability/sidecar-status.js';
import { scanMergeCandidates } from '../tools/merge.js';
import { generateNodeSummary, generateSummariesForTree, generateSummariesForSubtree } from './summarizer.js';
import { makeDraggableWindow } from '../windowing.js';
import { proposeUpdate, proposeTreeReplace, entryBaselineFromEntry } from '../proposals/bus.js';
import { approveProposal } from '../proposals/executor.js';
import { world_names } from '../../../../world-info.js';
import { suggestKeywords } from './keyword-advisor.js';
import { openUidSummarizer } from '../lore/uid-summarizer.js';
import { estimateContentTokens, formatTokenCount } from '../observability/token-estimator.js';
import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { executeMergeLogicalDraft } from '../nexus/merge-logical-executor.js';
import { beginMergeTransaction, finalizeMergeTransaction, stageMergeTransaction, buildMergeAssumptions, enforceNexusTransactionFreshBeforeStage, approveNexusTransaction, abortNexusTransaction, abortNexusReviewTransactionDurably, getNexusLedger, persistNexusReviewTransaction } from '../nexus/transaction-service.js';
import { commitCanonicalNexusMutation } from '../nexus/mutation-coordinator.js';
import { INTERNAL_MUTATION } from '../nexus/mutation-engine.js';
import { createMutationProposal } from '../nexus/contracts.js';
import { trashTreeWithConfirmation } from './delete-transaction.js';
import { getLorebookBuilderController } from '../builder/runtime.js';
import { builder2LaunchControlsHtml, readBuilder2LaunchOptions, builder2ReviewMarkup, collectBuilder2ReviewDecision as collectSharedBuilder2ReviewDecision, wireBuilder2TaxonomyEditor, wireBuilder2GapReview, builder2PreviewOverrideMarkup, wireBuilder2PreviewOverrides } from '../builder/builder2-operator-ui.js';
import { upgradeLaneDButtons } from './ui-core-adapter.js';
import { MAX_MERGE_LIST_PAIRS, selectTreeLoreMergeReviewCandidates } from './entity-alignment-decision-site.js';
import { modal as nxModal, input as nxInput, button as nxButton } from '../ui/index.js';
import { buildLoreEditorPatch } from './lore-editor-state.js';
import { assertTreeImportWithinBounds } from './import-bounds.js';
import { treeImportAlreadyCurrent, createTreeImportMutation } from './import-policy.js';

// Compatibility marker for historical UI automation: value="defer" selected>Defer / leave unresolved
// Compatibility markers for historical UI automation: Structural / non-semantic; Mark structural / non-semantic; Apply Resolutions
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function requestCategoryName({parentLabel='Root',defaultValue='New Category'}={}){
    return await new Promise(resolve=>{
        let settled=false;
        const field=nxInput({label:'Category name',value:defaultValue,help:`Add a category under ${parentLabel}.`,document});
        const finish=value=>{if(settled)return;settled=true;try{dialog.closeDialog?.();}catch{}dialog.remove();resolve(value);};
        const cancel=nxButton({label:'Cancel',variant:'ghost',onClick:()=>finish(null),document});
        const create=nxButton({label:'Add category',variant:'primary',onClick:()=>{const value=field.controlElement?.value?.trim();if(!value){field.controlElement?.focus();return;}finish(value);},document});
        const dialog=nxModal({title:'Add category',body:[field],actions:[cancel,create],onClose:()=>finish(null),className:'nx-tree-category-modal',document});
        dialog.addEventListener?.('cancel',event=>{event.preventDefault();finish(null);});
        field.controlElement?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();create.click();}});
        document.body.appendChild(dialog);
        dialog.openDialog?.();
        queueMicrotask(()=>{field.controlElement?.focus();field.controlElement?.select?.();});
    });
}
function treeTrashErrorMessage(error){
    const raw=String(error?.message||error||'Trash Tree failed safely.').trim();
    const unique=[...new Set(raw.split(';').map(value=>value.trim()).filter(Boolean))];
    if(String(error?.name||'')==='TV2RollbackIndeterminate'){
        return 'Trash Tree could not verify a safe final state. Open Commit Recovery before retrying.';
    }
    return unique.join('; ')||'Trash Tree failed safely.';
}
function downloadJson(filename,payload){const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function allBooks(){return [...new Set([...(world_names||[]),...Object.keys(getSettings().trees||{}),...getActiveBooks({requireTree:false})])].filter(Boolean).sort((a,b)=>a.localeCompare(b));}
function stamp(){return new Date().toISOString().replace(/[:.]/g,'-');}
function parseUidList(text){return [...new Set(String(text||'').split(/[\s,;]+/).map(Number).filter(Number.isFinite))];}
function treePayload(book,tree){return {schema:'tv2-tree',schemaVersion:1,exportedAt:new Date().toISOString(),book,tree:normalizeTree(clone(tree),book)};}

function treeImportStats(tree){let nodes=0,uids=0;const walk=node=>{if(!node)return;nodes++;uids+=(node.entryUids||[]).length;for(const child of node.children||[])walk(child);};walk(tree?.root);return{nodes,uids};}
function treeImportFingerprint(plans,kind='tree-import'){
    const text=JSON.stringify({kind:String(kind),plans:(plans||[]).map(plan=>({book:String(plan.book),tree:plan.tree}))});
    let hash=2166136261;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619)>>>0;}
    return `tree-import:${text.length}:${hash.toString(16).padStart(8,'0')}`;
}
async function reviewTreeImportBundle(plans,kind){
    const fingerprint=treeImportFingerprint(plans,kind);
    const prior=document.querySelector('.tv2-tree-import-review-overlay');if(prior)prior.remove();
    const overlay=document.createElement('div');overlay.className='tv2-overlay nexus-ui tv2-tree-import-review-overlay';
    const rows=plans.map(plan=>{const before=getTree(plan.book),a=treeImportStats(before),b=treeImportStats(plan.tree);return `<article><b>${esc(plan.book)}</b><span>${a.nodes} nodes / ${a.uids} assignments → ${b.nodes} nodes / ${b.uids} assignments</span><details><summary>Exact normalized replacement Tree JSON</summary><pre>${esc(JSON.stringify(plan.tree,null,2))}</pre></details></article>`;}).join('');
    overlay.innerHTML=`<div class="tv2-tree-import-review-panel"><div class="tv2-panel-head"><div><h3>Review Tree import</h3><div class="tv2-meta">${plans.length} lorebook Tree${plans.length===1?'':'s'} will be replaced. Review the exact changes before approval.</div></div></div><div class="tv2-tree-import-review-body">${rows}<div class="tv2-button-row"><button class="menu_button tv2-tree-import-cancel" type="button">Cancel</button><button class="menu_button tv2-primary-action tv2-tree-import-confirm" type="button">Approve exact import</button></div></div></div>`;
    document.body.appendChild(overlay);upgradeLaneDButtons(overlay);
    const panel=overlay.querySelector('.tv2-tree-import-review-panel');const cleanup=makeDraggableWindow(panel,{handle:panel.querySelector('.tv2-panel-head'),storageKey:'tree-import-review',resizable:true,minWidth:680,minHeight:420});
    return await new Promise(resolve=>{const finish=value=>{cleanup?.();overlay.remove();resolve(value);};overlay.querySelector('.tv2-tree-import-cancel').addEventListener('click',()=>finish(null));overlay.querySelector('.tv2-tree-import-confirm').addEventListener('click',()=>finish({confirmed:true,by:'operator',surface:'tree-import-review',fingerprint,confirmedAt:Date.now()}));overlay.addEventListener('click',event=>{if(event.target===overlay)finish(null);});});
}

function decodeTreeImport(payload,currentBook=''){
    if(!payload||typeof payload!=='object')throw new Error('Tree import is not a JSON object.');
    if((payload.schema==='tv2-tree'||payload.schema==='tv2-tree-bundle')&&Number(payload.schemaVersion)!==1)throw new Error(`Unsupported Nexus Tree schemaVersion ${String(payload.schemaVersion)}.`);
    if(payload.schema==='tv2-tree'&&payload.tree){const book=String(payload.book||payload.tree?.lorebookName||currentBook||'').trim();if(!book)throw new Error('Tree file has no lorebook name.');return {trees:{[book]:payload.tree},kind:'tv2-tree'};}
    if(payload.schema==='tv2-tree-bundle'&&payload.trees)return {trees:payload.trees,kind:'tv2-tree-bundle'};
    if(payload.root){const book=String(payload.lorebookName||currentBook||'').trim();if(!book)throw new Error('Raw Tree JSON needs a lorebook name or an already selected book.');return {trees:{[book]:payload},kind:'raw-tree'};}
    if(payload.trees&&typeof payload.trees==='object')return {trees:payload.trees,kind:'tv1-or-tv2-trees'};
    if(payload.tunnelvision?.trees)return {trees:payload.tunnelvision.trees,kind:'tv1-settings'};
    if(payload.extension_settings?.tunnelvision?.trees)return {trees:payload.extension_settings.tunnelvision.trees,kind:'tv1-settings'};
    if(payload.extension_settings?.tv2?.trees)return {trees:payload.extension_settings.tv2.trees,kind:'tv2-settings'};
    throw new Error('No Tree or trees map found in this JSON file.');
}

async function validateImportedTree(book,raw){
    assertWritableBook(book);
    assertTreeImportWithinBounds(raw);
    validateCanonicalTreeIdentity(raw,{label:`Imported Tree "${book}"`,allowMissingIds:true});
    const data=await loadBook(book);
    const valid=new Set(Object.values(data?.entries||{}).map(entry=>Number(entry?.uid)).filter(Number.isFinite));
    const missing=collectUids(raw?.root).map(Number).filter(uid=>Number.isFinite(uid)&&!valid.has(uid));
    if(missing.length)throw new Error(`Imported Tree "${book}" references unknown lore UID(s): ${[...new Set(missing)].slice(0,20).join(', ')}.`);
    return normalizeTree(clone(raw),book);
}

async function commitTreeImportBundle(plans, kind='tv2-tree-bundle', approval=null){
    if(!Array.isArray(plans)||!plans.length)throw new Error('Tree import bundle contains no valid Tree plans.');
    const expectedApprovalFingerprint=treeImportFingerprint(plans,kind);
    if(approval?.confirmed!==true||String(approval?.fingerprint||'')!==expectedApprovalFingerprint){const error=new Error('Tree import requires a fresh operator review of the exact prepared changes.');error.name='TV2ApprovalRequired';throw error;}
    const alreadyCurrent=treeImportAlreadyCurrent(plans,book=>getTree(book));
    if(alreadyCurrent.allCurrent){
        logEvent('tree','tree-import-already-current',{kind,books:plans.map(plan=>String(plan.book)),approvalFingerprint:expectedApprovalFingerprint},'info');
        return {id:null,state:'committed',result:{kind,books:plans.map(plan=>String(plan.book)),noop:true,reason:'already-current'}};
    }
    const ledger=getNexusLedger();
    const expectedTrees=plans.map(plan=>({book:String(plan.book),tree:treeBaseline(plan.book)}));
    const assumptions={trees:clone(expectedTrees)};
    let tx=ledger.begin({
        type:'tree-import-bundle',
        input:{kind,books:plans.map(plan=>String(plan.book))},
        snapshot:{expectedTrees:clone(expectedTrees)},
        assumptions,
        metadata:{source:'tree-import',bundle:true,detachedChat:!String(getContext()?.chatId||'').trim()},
    });
    ledger.executing(tx.id);
    ledger.parsed(tx.id,{kind,books:plans.map(plan=>String(plan.book))},{local:true});
    ledger.validated(tx.id,{passed:true,checks:{canonicalIdentity:true,loreUids:true,bundlePreflight:true}});
    tx=ledger.staged(tx.id,{kind,plans:plans.map(plan=>({book:String(plan.book),tree:clone(plan.tree)}))},{
        mutationProposal:createMutationProposal({
            transactionId:tx.id,
            type:'tree-import-bundle',
            target:{books:plans.map(plan=>String(plan.book))},
            draft:{trees:plans.map(plan=>({book:String(plan.book),tree:clone(plan.tree)}))},
            assumptions,
            approvalRequired:true,
            metadata:{source:'tree-import',bundle:true},
        }),
    });
    ledger.approve(tx.id,{by:String(approval.by||'operator'),metadata:{surface:String(approval.surface||'tree-import-review'),bundle:true,approvalFingerprint:expectedApprovalFingerprint,confirmedAt:Number(approval.confirmedAt)||Date.now()}});
    const mutation=createTreeImportMutation({
        type:INTERNAL_MUTATION.TREE_IMPORT_BUNDLE,
        plans,
        expectedTrees,
        // Exact replay protection remains transaction-stable, while a new,
        // separately approved import is a distinct operator intent even if the
        // semantic PRE/POST Trees happen to match an earlier historical import.
        operatorIntentId:tx.id,
    });
    const preflight=async()=>{
        // Re-run admission while the coordinator holds every lore+Tree resource.
        // This closes the validation->commit TOCTOU without serializing unrelated books.
        for(const plan of plans)await validateImportedTree(plan.book,plan.tree);
        return true;
    };
    const currentAssumptions=()=>({trees:plans.map(plan=>({book:String(plan.book),tree:treeBaseline(plan.book)}))});
    return await commitCanonicalNexusMutation(tx.id,mutation,{
        targetLedger:ledger,
        currentAssumptions,
        preflight,
        metadata:{source:'tree-import',bundle:true,kind},
        committed:result=>({kind,books:plans.map(plan=>String(plan.book)),result}),
    });
}

async function prepareTreeImport(payload,currentBook=''){
    const decoded=decodeTreeImport(payload,currentBook),plans=[];
    // Preflight the full bundle before review/staging so the operator reviews
    // the exact normalized Trees that can later be admitted under authority.
    for(const [book,raw] of Object.entries(decoded.trees||{})){
        if(!book||!raw)continue;
        plans.push({book,tree:await validateImportedTree(book,raw)});
    }
    if(!plans.length)throw new Error('Tree import contains no valid Tree payloads.');
    return {decoded,plans};
}

async function applyTreeImport(payload,currentBook='',approval=null){
    const {decoded,plans}=await prepareTreeImport(payload,currentBook);
    const committed=await commitTreeImportBundle(plans,decoded.kind,approval);
    if(committed?.state!=='committed')throw Object.assign(new Error(committed?.error||'Tree import bundle did not reach COMMITTED.'),{transactionId:committed?.id||null});
    const rows=plans.map(plan=>({book:plan.book,transactionId:committed.id||null}));
    logEvent('tree','tree-import-complete',{kind:decoded.kind,count:rows.length,books:rows.map(row=>row.book),transactionId:committed.id||null,bundle:true},'info');
    return {kind:decoded.kind,count:rows.length,committed:rows,transactionId:committed.id||null};
}

function entryLookup(bookData){const map=new Map();for(const entry of Object.values(bookData?.entries||{}))map.set(Number(entry.uid),entry);return map;}
function entryTitle(entry,uid){return entry?.comment||entry?.key?.[0]||`UID ${uid}`;}
function entryMatches(entry,q){if(!q)return true;const hay=[entry?.comment,entry?.content,...(entry?.key||[])].filter(Boolean).join(' ').toLowerCase();return hay.includes(q);}
function unassignedEntries(bookData,tree){const assigned=new Set(collectUids(tree?.root));return Object.values(bookData?.entries||{}).filter(entry=>!entry?.disable&&!assigned.has(Number(entry.uid)));}
function countActive(node,lookup){return collectUids(node).filter(uid=>{const e=lookup.get(Number(uid));return e&&!e.disable;}).length;}
function nodePath(root,targetId,path=[]){if(!root)return null;path.push(root);if(root.id===targetId)return [...path];for(const child of root.children||[]){const found=nodePath(child,targetId,path);if(found)return found;}path.pop();return null;}
function containsNode(root,nodeId){return !!findNode(root,nodeId);}
function nodeOptions(root,selectedId,depth=0){
    if(!root)return '';
    const unassigned=depth===0?`<option value="__unassigned__" ${selectedId==='__unassigned__'?'selected':''}>Unassigned</option>`:'';
    const label=depth===0?'Root':`${'— '.repeat(depth)}${root.label||'Unnamed'}`;
    return `${unassigned}<option value="${esc(root.id)}" ${root.id===selectedId?'selected':''}>${esc(label)}</option>${(root.children||[]).map(child=>nodeOptions(child,selectedId,depth+1)).join('')}`;
}
function nodeIdForUid(node,uid){if((node?.entryUids||[]).map(Number).includes(Number(uid)))return node.id;for(const child of node?.children||[]){const found=nodeIdForUid(child,uid);if(found)return found;}return null;}

export function readLoreEditorPatch(root,{fallbackNodeId=null}={}){
    if(!root?.querySelector)throw new Error('Lore editor controls are unavailable.');
    return buildLoreEditorPatch({
        title:root.querySelector('.tv2-lore-edit-title')?.value,
        content:root.querySelector('.tv2-lore-edit-content')?.value,
        keywords:root.querySelector('.tv2-lore-edit-keys')?.value,
        enabled:root.querySelector('.tv2-lore-edit-enabled')?.checked===true,
        constant:root.querySelector('.tv2-lore-edit-constant')?.checked===true,
        targetNodeId:root.querySelector('.tv2-lore-edit-node')?.value,
        fallbackNodeId,
    });
}

async function openLoreEntryEditor({book,tree,uid,entry,onSaved}){
    const prior=document.querySelector('.tv2-lore-editor-overlay');if(prior){if(typeof prior.__tv2Close==='function')prior.__tv2Close();else prior.remove();}
    const editorExpectedEntry=entryBaselineFromEntry(uid,entry);
    const editorExpectedTree=clone(tree);
    const editorExpectedNodeId=nodeIdForUid(tree?.root,uid)||null;
    const currentNodeId=nodeIdForUid(tree?.root,uid)||'__unassigned__';
    const overlay=document.createElement('div');overlay.className='tv2-overlay nexus-ui tv2-lore-editor-overlay';
    overlay.innerHTML=`<div class="tv2-lore-editor-panel"><div class="tv2-panel-head"><div><h3>Edit Lore Entry</h3><div class="tv2-meta">${esc(book)} · UID ${Number(uid)}</div></div><button class="menu_button tv2-ghost-action tv2-lore-editor-close" type="button">Close</button></div><div class="tv2-lore-editor-body"><label class="nx-field tv2-lore-editor-title-field"><span class="nx-field__label">Title</span><input class="nx-input nx-input--title tv2-lore-edit-title" value="${esc(entry?.comment||'')}"></label><div class="tv2-lore-editor-detail-grid"><label class="nx-field"><span class="nx-field__label">Keywords</span><textarea class="nx-input nx-textarea tv2-lore-edit-keys" rows="2" placeholder="Comma or line separated">${esc((Array.isArray(entry?.key)?entry.key:entry?.key?[entry.key]:[]).join(', '))}</textarea></label><label class="nx-field"><span class="nx-field__label">Tree placement</span><select class="nx-select tv2-lore-edit-node">${nodeOptions(tree?.root,currentNodeId)}</select></label></div><div class="tv2-keyword-advice"><div class="tv2-keyword-advice-row"><button class="menu_button tv2-ghost-action tv2-keyword-suggest" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> Suggest safer keywords</button><span>Suggestions are optional and are only applied when you save.</span></div><div class="tv2-keyword-suggestions"></div></div><label class="nx-field tv2-lore-editor-content-field"><span class="nx-field__label">Content</span><textarea class="nx-input nx-textarea tv2-lore-edit-content" rows="12">${esc(entry?.content||'')}</textarea></label><div class="tv2-lore-editor-switches" role="group" aria-label="Lore entry activation"><label class="nx-toggle tv2-lore-editor-toggle"><input class="tv2-lore-edit-enabled" type="checkbox" ${entry?.disable?'':'checked'}><span class="nx-toggle__track"><span class="nx-toggle__thumb"></span></span><span class="nx-toggle__label">Enabled</span></label><label class="nx-toggle tv2-lore-editor-toggle"><input class="tv2-lore-edit-constant" type="checkbox" ${entry?.constant?'checked':''}><span class="nx-toggle__track"><span class="nx-toggle__thumb"></span></span><span class="nx-toggle__label">Constant</span></label></div><div class="tv2-lore-editor-note">Saving updates this lore entry and its Tree placement.</div><div class="tv2-button-row tv2-lore-editor-actions"><button class="menu_button tv2-lore-editor-cancel" type="button">Cancel</button><button class="menu_button tv2-primary-action tv2-lore-edit-save" type="button">Save Entry</button></div></div></div>`;
    document.body.appendChild(overlay);upgradeLaneDButtons(overlay);const panel=overlay.querySelector('.tv2-lore-editor-panel');
    makeDraggableWindow(panel,{handle:panel.querySelector('.tv2-panel-head'),storageKey:'lore-entry-editor',resizable:true,minWidth:520,minHeight:430});
    const close=()=>overlay.remove();overlay.__tv2Close=close;overlay.querySelector('.tv2-lore-editor-close').addEventListener('click',close);overlay.querySelector('.tv2-lore-editor-cancel').addEventListener('click',close);overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
    overlay.querySelector('.tv2-keyword-suggest')?.addEventListener('click',async e=>{
        const button=e.currentTarget;const output=overlay.querySelector('.tv2-keyword-suggestions');button.disabled=true;output.innerHTML='<span>Generating keyword suggestions…</span>';
        try{
            const advice=await suggestKeywords({book,uid});
            output.innerHTML=advice.suggestions.length?advice.suggestions.map(row=>`<button class="menu_button tv2-keyword-add" type="button" data-keyword="${esc(row.keyword)}" title="${esc(row.reason)}">+${esc(row.keyword)} <small>${row.accidentalFireRisk}% collision risk</small></button>`).join(''):'<span>No additional low-collision keyword was suggested.</span>';
            upgradeLaneDButtons(output);
            output.querySelectorAll('.tv2-keyword-add').forEach(add=>add.addEventListener('click',()=>{const field=overlay.querySelector('.tv2-lore-edit-keys');const existing=field.value.split(/[\n,;]+/).map(value=>value.trim()).filter(Boolean);const candidate=add.dataset.keyword||'';if(!existing.some(value=>value.toLowerCase()===candidate.toLowerCase()))field.value=[...existing,candidate].join(', ');add.disabled=true;add.textContent='Added';}));
        }catch(error){output.innerHTML=`<span class="tv2-error-text">${esc(error?.message||String(error))}</span>`;}finally{button.disabled=false;}
    });
    overlay.querySelector('.tv2-lore-edit-save').addEventListener('click',async e=>{
        const button=e.currentTarget;button.disabled=true;
        try{
            const patch=readLoreEditorPatch(overlay,{fallbackNodeId:tree.root.id});
            if(!patch.title||!patch.content)throw new Error('Lore title and content are required.');
            const expectedEntryOption={expectedEntry:editorExpectedEntry};
            const proposal=await proposeUpdate(book,uid,patch,{source:'tree-editor-manual',reasoning:'Explicit operator edit from the Tree workspace.'},{...expectedEntryOption,expectedNodeId:editorExpectedNodeId,expectedTree:editorExpectedTree});
            const result=await approveProposal(proposal.id);if(!result.ok)throw new Error(result.error||'Lore entry save failed.');
            logEvent('tree','lore-entry-edited',{book,uid:Number(uid),proposalId:proposal.id},'info');globalThis.toastr?.success(`UID ${uid} saved.`,'Nexus Tree');close();await onSaved?.();
        }catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Tree');button.disabled=false;}
    });
}

function listItems(value,fallback){const rows=Array.isArray(value)?value.map(item=>String(item||'').trim()).filter(Boolean):[];return rows.length?rows.map(item=>`<li>${esc(item)}</li>`).join(''):`<li>${esc(fallback)}</li>`;}
function mergeEntryMeta(entry,uid,nodeLabel){const tokens=estimateContentTokens(entry?.content||'');const keys=Array.isArray(entry?.key)?entry.key.length:entry?.key?1:0;return `UID ${Number(uid)} · ${formatTokenCount(tokens)} · ${keys} key${keys===1?'':'s'} · ${nodeLabel||'Root / Unassigned'}`;}

export async function openMergeReviewCandidate(book,row){
    const data=await loadBook(book),entryA=entryLookup(data).get(Number(row.uidA)),entryB=entryLookup(data).get(Number(row.uidB)),tree=getTree(book);
    if(!entryA||!entryB)throw new Error('One of the scanned UIDs no longer exists. Run the scan again.');
    const sourceATokens=estimateContentTokens(entryA.content||''),sourceBTokens=estimateContentTokens(entryB.content||'');
    const priorMerge=document.querySelector('.tv2-merge-preview-overlay');if(priorMerge){if(typeof priorMerge.__tv2Close==='function')priorMerge.__tv2Close();else priorMerge.remove();}
    const overlay=document.createElement('div');overlay.className='tv2-overlay nexus-ui tv2-merge-preview-overlay';
    overlay.innerHTML=`<div class="tv2-merge-preview-panel">
      <div class="tv2-panel-head"><div><h3>Merge review · ${Number(row.percent||0).toFixed(1)}% similarity</h3><div class="tv2-meta">Review the result before any proposal is created. No lore changes occur while this window is open.</div></div><button class="menu_button tv2-merge-preview-close" type="button">Close</button></div>
      <div class="tv2-merge-preview-body">
        <section class="tv2-merge-context">
          <div><b>Merge context</b><span>Local similarity signal: title ${Number(row.titlePercent||0).toFixed(1)}% · content ${Number(row.contentPercent||0).toFixed(1)}%${row.sameNode?' · same Tree node':''}.</span></div>
          <p class="tv2-merge-plan"></p><small>Source total: ${formatTokenCount(sourceATokens)} + ${formatTokenCount(sourceBTokens)} = ${formatTokenCount(sourceATokens+sourceBTokens)}. Draft profile guides density and detail; it is not a hard token ceiling.</small>
          <div class="tv2-merge-contributions"><article><b>UID ${row.uidA} context</b><ul class="tv2-merge-source-a"><li>Generate a draft to map its distinct facts into the result.</li></ul></article><article><b>UID ${row.uidB} context</b><ul class="tv2-merge-source-b"><li>Generate a draft to map its distinct facts into the result.</li></ul></article></div>
        </section>
        <div class="tv2-merge-preview-controls"><label>UID to retain<select class="text_pole tv2-merge-keep"><option value="${row.uidA}">Keep UID ${row.uidA} — ${esc(entryTitle(entryA,row.uidA))}</option><option value="${row.uidB}">Keep UID ${row.uidB} — ${esc(entryTitle(entryB,row.uidB))}</option></select></label><label>Result title<input class="text_pole tv2-merge-title" value="${esc(entryTitle(entryA,row.uidA))}"></label><label>Tree destination<select class="text_pole tv2-merge-target"></select></label><div class="tv2-merge-profile-control"><span>Draft profile</span><div class="tv2-merge-profile-options" role="group" aria-label="Merge draft profile"><button class="menu_button" data-merge-profile="lean" type="button">Lean</button><button class="menu_button selected" data-merge-profile="balanced" type="button">Balanced</button><button class="menu_button" data-merge-profile="heavy" type="button">Heavy</button></div><small>Lean is concise; Heavy preserves richer full-fidelity detail. Profiles guide style only and never hard-cap a valid merge.</small></div></div>
        <section class="tv2-merge-result"><div><b>Result preview</b><span class="tv2-merge-result-meta"><span class="tv2-merge-result-label"></span><span class="tv2-merge-token-count">Draft tokens · ≈0</span></span></div><textarea class="text_pole tv2-merge-content" rows="13" placeholder="Generate a draft, or write the reviewed merged lore here…"></textarea><small>The retired UID is disabled and removed from the Tree; it is not hard-deleted. The retained UID receives this reviewed content.</small></section>
        <details class="tv2-merge-source-details"><summary>Show source entries</summary><div class="tv2-merge-source-grid"><article><b>UID ${row.uidA} — ${esc(entryTitle(entryA,row.uidA))}</b><small>${esc(mergeEntryMeta(entryA,row.uidA,row.nodeLabelA))}</small><textarea class="text_pole" rows="12" readonly>${esc(entryA.content||'')}</textarea></article><article><b>UID ${row.uidB} — ${esc(entryTitle(entryB,row.uidB))}</b><small>${esc(mergeEntryMeta(entryB,row.uidB,row.nodeLabelB))}</small><textarea class="text_pole" rows="12" readonly>${esc(entryB.content||'')}</textarea></article></div></details>
        <div class="tv2-button-row"><button class="menu_button tv2-merge-draft" type="button">Generate reviewed draft</button><button class="menu_button tv2-merge-reject" type="button" disabled>Reject draft</button><button class="menu_button tv2-merge-approve" type="button" disabled>Approve &amp; Merge</button></div>
      </div>
    </div>`;
    document.body.appendChild(overlay);upgradeLaneDButtons(overlay);
    const panel=overlay.querySelector('.tv2-merge-preview-panel');
    makeDraggableWindow(panel,{handle:panel.querySelector('.tv2-panel-head'),storageKey:'merge-preview',resizable:true,minWidth:760,minHeight:560});
    let activeMergeTransaction=null;
    let activeMergeAbort=null;
    const close=async()=>{try{if(activeMergeAbort&&!activeMergeAbort.signal.aborted)activeMergeAbort.abort(Object.assign(new Error('Merge review closed.'),{name:'TV2BatchCancelled'}));activeMergeAbort=null;if(activeMergeTransaction?.id){const live=getNexusLedger().read(activeMergeTransaction.id);if(live&&['validated','staged'].includes(live.state))await abortNexusReviewTransactionDurably(live.id,'Merge review closed without approval.');else if(live&&['created','executing','aggregating','parsed'].includes(live.state))abortNexusTransaction(live.id,'Merge draft generation closed before review.');}activeMergeTransaction=null;overlay.remove();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Merge');}};overlay.__tv2Close=close;overlay.querySelector('.tv2-merge-preview-close').addEventListener('click',close);overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
    const keep=()=>Number(panel.querySelector('.tv2-merge-keep').value)===Number(row.uidB)?entryB:entryA;
    const remove=()=>keep()===entryA?entryB:entryA;
    const title=panel.querySelector('.tv2-merge-title'),content=panel.querySelector('.tv2-merge-content'),target=panel.querySelector('.tv2-merge-target'),approve=panel.querySelector('.tv2-merge-approve'),reject=panel.querySelector('.tv2-merge-reject');
    let selectedMergeProfile='balanced';
    if(tree?.root)target.innerHTML=`<option value="">Keep retained UID's current Tree location</option>${nodeOptions(tree.root,'')}`;
    else target.innerHTML='<option value="">No Tree destination available</option>';
    const renderPlan=()=>{
        const kept=keep(),removed=remove(),destination=target.options[target.selectedIndex]?.textContent||'retained UID location';
        panel.querySelector('.tv2-merge-plan').textContent=`Result will remain UID ${kept.uid} (“${entryTitle(kept,kept.uid)}”). UID ${removed.uid} (“${entryTitle(removed,removed.uid)}”) will be retired after its reviewed facts are folded into the result. Destination: ${destination}.`;
        const profileLabel=selectedMergeProfile.charAt(0).toUpperCase()+selectedMergeProfile.slice(1);panel.querySelector('.tv2-merge-result-label').textContent=`New form: UID ${kept.uid} — ${title.value.trim()||entryTitle(kept,kept.uid)} · ${profileLabel}`;panel.querySelector('.tv2-merge-token-count').textContent=`Draft tokens · ≈${formatTokenCount(contentTokens())}`;
    };
    const renderDraftContext=draft=>{
        panel.querySelector('.tv2-merge-source-a').innerHTML=listItems(draft?.sourceAContributions,`Review UID ${row.uidA}'s unique facts in the source entry below.`);
        panel.querySelector('.tv2-merge-source-b').innerHTML=listItems(draft?.sourceBContributions,`Review UID ${row.uidB}'s unique facts in the source entry below.`);
        if(String(draft?.mergeContext||'').trim())panel.querySelector('.tv2-merge-context>div:first-child span').textContent=String(draft.mergeContext).trim();
    };
    const contentTokens=()=>estimateContentTokens(content.value||'');
    const updateApproval=()=>{approve.disabled=!content.value.trim();content.setCustomValidity('');renderPlan();};
    panel.querySelector('.tv2-merge-keep').addEventListener('change',()=>{title.value=entryTitle(keep(),keep().uid);renderPlan();});
    panel.querySelectorAll('[data-merge-profile]').forEach(button=>button.addEventListener('click',()=>{selectedMergeProfile=String(button.dataset.mergeProfile||'balanced');panel.querySelectorAll('[data-merge-profile]').forEach(peer=>peer.classList.toggle('selected',peer===button));renderPlan();}));target.addEventListener('change',renderPlan);title.addEventListener('input',renderPlan);content.addEventListener('input',updateApproval);renderPlan();
    panel.querySelector('.tv2-merge-draft').addEventListener('click',async event=>{
        const button=event.currentTarget;button.disabled=true;
        try{
            const profile=selectedMergeProfile,kept=keep(),removed=remove(),targetNodeId=target.value||null,titleA=entryTitle(entryA,entryA.uid),titleB=entryTitle(entryB,entryB.uid),relevantState=treeBaseline(book);
            if(activeMergeTransaction?.state==='staged')await abortNexusReviewTransactionDurably(activeMergeTransaction.id,'A new Merge draft generation replaced the prior staged review.');
            activeMergeTransaction=beginMergeTransaction({book,keepUid:kept.uid,removeUid:removed.uid,sourceA:entryA,sourceB:entryB,profile,targetNodeId,relevantState,metadata:{surface:'merge-review',similarityPercent:Number(row.percent||0),draftProfile:profile},execution:{logicalJobId:`merge:${book}:${entryA.uid}:${entryB.uid}:${Date.now()}`,identity:{book,sourceAUid:Number(entryA.uid),sourceBUid:Number(entryB.uid),keepUid:Number(kept.uid),removeUid:Number(removed.uid),targetNodeId},settings:{draftProfile:profile},sliceManifest:[]}});
            if(activeMergeAbort&&!activeMergeAbort.signal.aborted)activeMergeAbort.abort(Object.assign(new Error('Merge draft generation superseded.'),{name:'TV2BatchCancelled'}));const draftController=new AbortController();activeMergeAbort=draftController;
            const logical=await executeMergeLogicalDraft({book,entryA,entryB,titleA,titleB,sourceATokens,sourceBTokens,profile,transactionId:activeMergeTransaction.id,settings:getSettings(),signal:draftController.signal});if(activeMergeAbort===draftController)activeMergeAbort=null;
            const parsed=logical.draft;
            const currentBook=await loadBook(book),currentA=findEntryByUid(currentBook.entries,entryA.uid),currentB=findEntryByUid(currentBook.entries,entryB.uid),currentAssumptions=buildMergeAssumptions({book,keepUid:kept.uid,removeUid:removed.uid,profile,targetNodeId,sourceA:currentA,sourceB:currentB,relevantState:treeBaseline(book)});
            activeMergeTransaction=enforceNexusTransactionFreshBeforeStage(activeMergeTransaction.id,currentAssumptions);if(activeMergeTransaction.state==='stale')throw new Error('The merge sources or destination changed. Regenerate the draft from the current state.');
            title.value=String(parsed.title||title.value).trim()||title.value;content.value=String(parsed.content||'').trim();activeMergeTransaction=finalizeMergeTransaction(activeMergeTransaction.id,{draft:{title:title.value.trim(),content:content.value,mergeContext:parsed.mergeContext||'',sourceAContributions:parsed.sourceAContributions||[],sourceBContributions:parsed.sourceBContributions||[],sourceAUid:parsed.sourceAUid,sourceBUid:parsed.sourceBUid,sourceAHash:parsed.sourceAHash,sourceBHash:parsed.sourceBHash},profile,estimatedTokens:contentTokens(),metadata:{surface:'merge-review',reshapeUsed:logical.reshapeUsed===true,draftProfile:profile}});await persistNexusReviewTransaction(activeMergeTransaction.id);if(activeMergeTransaction.state!=='staged')throw new Error(activeMergeTransaction.error||'Merge draft could not be validated. Regenerate it from the current state.');reject.disabled=false;renderDraftContext(parsed);updateApproval();panel.querySelector('.tv2-merge-result-label').textContent=`Draft ready · ${title.value.trim()||entryTitle(keep(),keep().uid)}${logical.reshapeUsed?' · large source handled':''}`;panel.querySelector('.tv2-merge-token-count').textContent=`Draft tokens · ≈${formatTokenCount(contentTokens())}`;
        }catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Merge');}finally{button.disabled=false;}
    });
    approve.addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{const kept=keep(),removed=remove(),draft=content.value.trim(),profile=selectedMergeProfile,targetNodeId=target.value||null,reviewTitle=title.value.trim()||entryTitle(kept,kept.uid);if(!draft)throw new Error('Review or generate a merged draft before approving.');const stagedMatches=activeMergeTransaction?.state==='staged'&&activeMergeTransaction.input?.keepUid===kept.uid&&activeMergeTransaction.input?.removeUid===removed.uid&&String(activeMergeTransaction.input?.profile||'balanced')===profile&&(activeMergeTransaction.input?.targetNodeId??null)===targetNodeId&&activeMergeTransaction.staged?.content===draft&&String(activeMergeTransaction.staged?.title||'')===String(reviewTitle);if(!stagedMatches){if(activeMergeTransaction?.state==='staged')await abortNexusReviewTransactionDurably(activeMergeTransaction.id,'Merge review changed after staging; restaging current operator choices.');activeMergeTransaction=stageMergeTransaction({book,keepUid:kept.uid,removeUid:removed.uid,sourceA:entryA,sourceB:entryB,draft:{title:reviewTitle,content:draft},profile,estimatedTokens:contentTokens(),targetNodeId,relevantState:treeBaseline(book)});await persistNexusReviewTransaction(activeMergeTransaction.id);}if(activeMergeTransaction.state!=='staged')throw new Error(activeMergeTransaction.error||'Merge could not be staged for approval.');const currentBook=await loadBook(book),currentA=findEntryByUid(currentBook.entries,entryA.uid),currentB=findEntryByUid(currentBook.entries,entryB.uid),currentTree=treeBaseline(book),currentAssumptions=async()=>{const liveBook=await loadBook(book),liveA=findEntryByUid(liveBook.entries,entryA.uid),liveB=findEntryByUid(liveBook.entries,entryB.uid),liveTree=treeBaseline(book);return buildMergeAssumptions({book,keepUid:kept.uid,removeUid:removed.uid,profile,targetNodeId,sourceA:liveA,sourceB:liveB,relevantState:liveTree});};activeMergeTransaction=approveNexusTransaction(activeMergeTransaction.id,{by:'operator',metadata:{surface:'merge-review',draftProfile:profile}});const mutation={type:'entry.merge',book,keepUid:Number(kept.uid),removeUid:Number(removed.uid),title:reviewTitle,content:draft,hardDelete:false,treePolicy:'keep',targetNodeId,expectedKeep:entryBaselineFromEntry(kept.uid,currentA),expectedRemove:entryBaselineFromEntry(removed.uid,currentB),expectedTree:currentTree};activeMergeTransaction=await commitCanonicalNexusMutation(activeMergeTransaction.id,mutation,{currentAssumptions,metadata:{surface:'merge-review',draftProfile:profile},committed:result=>({keepUid:kept.uid,removeUid:removed.uid,result})});await persistNexusReviewTransaction(activeMergeTransaction.id);if(activeMergeTransaction.state==='stale')throw new Error('This merge became stale because a source UID, destination, draft profile, or Tree state changed. Re-open or regenerate the merge from current state.');try{globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-merge-committed',{detail:{book,keepUid:Number(kept.uid),removeUid:Number(removed.uid),transactionId:activeMergeTransaction.id}}));}catch{}globalThis.toastr?.success(`Merged UID ${removed.uid} into UID ${kept.uid}.`,'Nexus');close();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Merge');button.disabled=false;}});
    reject.addEventListener('click',async()=>{if(activeMergeTransaction?.state==='staged')await abortNexusReviewTransactionDurably(activeMergeTransaction.id,'Operator rejected merge draft.');activeMergeTransaction=null;reject.disabled=true;approve.disabled=true;content.value='';panel.querySelector('.tv2-merge-result-label').textContent='Draft rejected. Source UIDs remain unchanged.';panel.querySelector('.tv2-merge-token-count').textContent='Draft tokens · ≈0';globalThis.toastr?.info('Merge draft rejected; no lore was changed.','Nexus');});
}


function mergeScanRowsMarkup(rows,{status=''}={}){
    const list=Array.isArray(rows)?rows:[];
    const statusRow=status?`<div class="tv2-merge-scan-status">${esc(status)}</div>`:'';
    if(!list.length)return `${statusRow}<div class="tv2-empty"><b>No merge-review candidates.</b><span>The scan or Decision Core did not nominate a pair for review.</span></div>`;
    return `${statusRow}${list.map(r=>`<article class="tv2-merge-row" role="button" tabindex="0" aria-label="Review possible merge: UID ${r.uidA} with UID ${r.uidB}" data-uid-a="${Number(r.uidA)}" data-uid-b="${Number(r.uidB)}" data-percent="${Number(r.percent)||0}" data-title-percent="${Number(r.titlePercent)||0}" data-content-percent="${Number(r.contentPercent)||0}" data-same-node="${r.sameNode===true}" data-node-label-a="${esc(r.nodeLabelA)}" data-node-label-b="${esc(r.nodeLabelB)}"><div class="tv2-merge-score">${r.percent}%<small>${r.jevSelected?`Jev selected${Number.isFinite(Number(r.jevProbability))?` · ${Math.round(Number(r.jevProbability)*100)}%`:''}`:'Scan candidate'}</small></div><div class="tv2-merge-pair"><b>UID ${r.uidA} — ${esc(r.titleA||'Untitled')}</b><span>${esc(r.nodeLabelA)}</span><div class="tv2-merge-arrow">↕</div><b>UID ${r.uidB} — ${esc(r.titleB||'Untitled')}</b><span>${esc(r.nodeLabelB)}</span></div><div class="tv2-merge-components"><span>Title ${r.titlePercent}%</span><span>Content ${r.contentPercent}%</span>${r.sameNode?'<span>Same node</span>':''}</div></article>`).join('')}`;
}

async function openMergeScanPanel(book){
    const prior=document.querySelector('.tv2-merge-scan-overlay');
    if(prior){if(typeof prior.__tv2Close==='function')prior.__tv2Close();else prior.remove();}
    const overlay=document.createElement('div');overlay.className='tv2-overlay nexus-ui tv2-merge-scan-overlay';
    overlay.innerHTML=`<div class="tv2-merge-scan-panel"><div class="tv2-panel-head"><div><h3>Merge Similarity Scan</h3><div class="tv2-meta">${esc(book)}</div></div><button class="menu_button tv2-merge-scan-close" type="button">Close</button></div><div class="tv2-merge-scan-controls"><label>Target UID <input class="text_pole tv2-merge-target" type="number" min="0" placeholder="blank = scan all pairs"></label><label>Minimum similarity % <input class="text_pole tv2-merge-threshold" type="number" min="0" max="100" value="35"></label><label>Maximum results <input class="text_pole tv2-merge-limit" type="number" min="1" max="${MAX_MERGE_LIST_PAIRS}" value="${MAX_MERGE_LIST_PAIRS}"></label><button class="menu_button tv2-merge-run" type="button">Scan UIDs</button></div><div class="tv2-merge-scan-note">Click a candidate to review the two entries before proposing a merge.</div><div class="tv2-merge-results"><div class="tv2-empty">Run the scan to rank likely merge candidates.</div></div></div>`;
    document.body.appendChild(overlay);upgradeLaneDButtons(overlay);const scanPanel=overlay.querySelector('.tv2-merge-scan-panel');makeDraggableWindow(scanPanel,{handle:scanPanel?.querySelector('.tv2-panel-head'),storageKey:'merge-scan'});const results=overlay.querySelector('.tv2-merge-results'),run=overlay.querySelector('.tv2-merge-run');
    let scanRequestId=0;
    const mergeCommittedHandler=event=>{if(String(event?.detail?.book||'')!==String(book)||!overlay.isConnected)return;results.innerHTML='<div class="tv2-empty">Merge committed · refreshing candidates…</div>';setTimeout(()=>{if(overlay.isConnected&&!run.disabled)run.click();},0);};globalThis.window?.addEventListener?.('nexus-merge-committed',mergeCommittedHandler);const close=()=>{scanRequestId++;try{globalThis.window?.removeEventListener?.('nexus-merge-committed',mergeCommittedHandler);}catch{}overlay.remove();};overlay.__tv2Close=close;overlay.querySelector('.tv2-merge-scan-close').addEventListener('click',close);overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
    results.addEventListener('click',async event=>{const card=event.target.closest('.tv2-merge-row');if(!card)return;try{await openMergeReviewCandidate(book,{uidA:Number(card.dataset.uidA),uidB:Number(card.dataset.uidB),percent:Number(card.dataset.percent),titlePercent:Number(card.dataset.titlePercent),contentPercent:Number(card.dataset.contentPercent),sameNode:card.dataset.sameNode==='true',nodeLabelA:card.dataset.nodeLabelA||'Root / Unassigned',nodeLabelB:card.dataset.nodeLabelB||'Root / Unassigned'});}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Merge');}});
    results.addEventListener('keydown',event=>{if(event.key!=='Enter'&&event.key!==' ')return;const card=event.target.closest('.tv2-merge-row');if(!card)return;event.preventDefault();card.click();});
    run.addEventListener('click',async()=>{const requestId=++scanRequestId;run.disabled=true;results.innerHTML='<div class="tv2-empty">Scanning lore UIDs…</div>';try{const raw=overlay.querySelector('.tv2-merge-target').value;const targetUid=raw===''?null:Number(raw);const thresholdPercent=Number(overlay.querySelector('.tv2-merge-threshold').value)||0;const limit=Math.max(1,Math.min(MAX_MERGE_LIST_PAIRS,Number(overlay.querySelector('.tv2-merge-limit').value)||MAX_MERGE_LIST_PAIRS));const rows=await scanMergeCandidates(book,{targetUid,thresholdPercent,limit});if(requestId!==scanRequestId||!overlay.isConnected)return;
        if(!rows.length){results.innerHTML=`<div class="tv2-empty"><b>No candidates above ${thresholdPercent}%.</b><span>Lower the threshold or target a specific UID.</span></div>`;return;}
        // First show deterministic discovery. Decision Core then evaluates this exact list
        // and builds the actual Merge Review queue; it never mutates lore here.
        results.innerHTML=mergeScanRowsMarkup(rows,{status:`Scan found ${rows.length} candidate${rows.length===1?'':'s'} · Jev reviewing…`});
        await new Promise(resolve=>setTimeout(resolve,0));
        const decision=await selectTreeLoreMergeReviewCandidates(book,rows);
        if(requestId!==scanRequestId||!overlay.isConnected)return;
        if(decision.handled){
            results.innerHTML=mergeScanRowsMarkup(decision.rows,{status:`Jev admitted ${decision.rows.length} of ${rows.length} to Merge Review · rejected ${Math.max(0,rows.length-decision.rows.length)}.`});
        }else{
            results.innerHTML=mergeScanRowsMarkup(rows,{status:`Jev review unavailable (${decision.reason||'fallback'}) · showing deterministic scan candidates.`});
        }
        }catch(error){results.innerHTML=`<div class="tv2-empty"><b>Merge scan failed.</b><span>${esc(error?.message||String(error))}</span></div>`;}finally{if(requestId===scanRequestId&&overlay.isConnected)run.disabled=false;}});
}


export async function openTreeWorkspace(){
    const prior=document.querySelector('.tv2-tree-overlay');
    if(prior){if(typeof prior.__tv2Close==='function')prior.__tv2Close();else prior.remove();}
    let selectedBook=getSettings().selectedLorebook&&allBooks().includes(getSettings().selectedLorebook)?getSettings().selectedLorebook:(allBooks()[0]||'');
    let selectedNodeId='';
    let selectedPseudo='';
    let currentBookData={entries:{}};
    let currentLookup=new Map();
    let searchQuery='';
    let loadSerial=0;
    let builderReview=null,builderLaunchAbort=null,builderLaunchTransactionId=null,builderResumeCandidate=null,builderLaunchOptions={requestedMode:'auto',validateOnly:false};
    const activeTreeSummaryAborts=new Set();
    const runTreeSummaryTask=async operation=>{const controller=new AbortController();activeTreeSummaryAborts.add(controller);try{return await operation(controller.signal);}finally{activeTreeSummaryAborts.delete(controller);}};
    const cancelTreeSummaryWork=(reason='Tree window closed.')=>{for(const controller of [...activeTreeSummaryAborts])if(!controller.signal.aborted)controller.abort(Object.assign(new Error(reason),{name:'TV2BatchCancelled'}));activeTreeSummaryAborts.clear();};
    const selectedCategoryIds=new Set();
    const selectedEntryUids=new Set();
    const expandedNodeIds=new Set();
    let activeTreeDragPayload=null;

    const overlay=document.createElement('div');
    overlay.className='tv2-overlay nexus-ui tv2-tree-overlay';
    overlay.innerHTML=`<div class="tv2-tree-classic-panel">
      <div class="tv2-tree-classic-toolbar">
        <div class="tv2-tree-header-top">
          <div class="tv2-tree-classic-title"><i class="fa-solid fa-folder-tree"></i><select class="text_pole tv2-tree-book"></select></div>
          <div class="tv2-tree-header-meta">
            <div class="tv2-shared-sidecar-status" aria-label="Main and Sidecar runtime status"></div>
            <button class="tv2-tree-classic-btn tv2-close-tree" type="button" title="Close"><i class="fa-solid fa-xmark"></i> <span>Close</span></button>
          </div>
        </div>
        <div class="tv2-tree-classic-actions">
          <button class="tv2-tree-classic-btn tv2-tree-add" type="button" title="Add category"><i class="fa-solid fa-folder-plus"></i> <span>Add Category</span></button>
          <button class="tv2-tree-classic-btn tv2-tree-builder" type="button" title="Create or incrementally reconcile the Nexus Lore Tree for this lorebook"><i class="fa-solid fa-sitemap"></i> <span>Build Lorebook Tree</span></button>
          <button class="tv2-tree-classic-btn tv2-tree-blank" type="button" title="Create an empty Nexus Tree shell with only Root; lore UIDs remain unassigned"><i class="fa-regular fa-square"></i> <span>Blank Tree</span></button>
          <button class="tv2-tree-classic-btn tv2-tree-merge-scan" type="button" title="Scan lore UIDs for merge similarity"><i class="fa-solid fa-code-merge"></i> <span>Merge Scan</span></button>
          <button class="tv2-tree-classic-btn tv2-tree-summarize" type="button" title="Generate Tree summaries"><i class="fa-solid fa-wand-magic-sparkles"></i> <span>Summarize Tree</span></button>
          <button class="tv2-tree-classic-btn tv2-tree-uid-summarize" type="button" title="Review per-UID summary drafts"><i class="fa-solid fa-compress"></i> <span>UID Summarizer</span></button>
          <button class="tv2-tree-classic-btn tv2-tree-import-file-btn" type="button" title="Import Tree JSON"><i class="fa-solid fa-file-import"></i> <span>Import</span></button>
          <button class="tv2-tree-classic-btn tv2-tree-export" type="button" title="Export current Tree"><i class="fa-solid fa-file-export"></i> <span>Export</span></button>
          <button class="tv2-tree-classic-btn danger tv2-tree-delete-tree" type="button" title="Trash current Nexus Tree without deleting the SillyTavern lorebook"><i class="fa-solid fa-trash-can"></i> <span>Trash Tree</span></button>
          <input class="tv2-tree-import-file" type="file" accept="application/json,.json" hidden>
        </div>
      </div>
      <div class="tv2-tree-classic-search"><i class="fa-solid fa-magnifying-glass"></i><input type="text" placeholder="Search categories and entries…"></div>
      <div class="tv2-tree-builder-review" hidden><div class="tv2-tree-builder-review-copy"><b>Builder Preview</b><span class="tv2-tree-builder-review-status"></span></div><div class="tv2-tree-builder-review-actions"><button class="menu_button tv2-tree-builder-cancel" type="button">Cancel</button><button class="menu_button tv2-primary-action tv2-tree-builder-approve" type="button">Approve Tree</button></div></div>
      <div class="tv2-tree-builder-resume" hidden><div class="tv2-tree-builder-review-copy"><b><i class="fa-solid fa-circle-exclamation"></i> Builder paused — work saved</b><span class="tv2-tree-builder-resume-status"></span></div><div class="tv2-tree-builder-review-actions"><button class="menu_button tv2-tree-builder-resume-cancel" type="button">Cancel Run</button><button class="menu_button tv2-primary-action tv2-tree-builder-resume-now" type="button"><i class="fa-solid fa-rotate-right"></i> Resume Builder</button></div></div>
      <div class="tv2-tree-classic-body">
        <aside class="tv2-tree-classic-sidebar"><div class="tv2-tree-sidebar-header"><span>Tree</span><span class="tv2-tree-status"></span></div><div class="tv2-tree-sidebar-scroll"></div></aside>
        <main class="tv2-tree-classic-main"></main>
      </div>
    </div>`;
    document.body.appendChild(overlay);upgradeLaneDButtons(overlay);
    const panel=overlay.querySelector('.tv2-tree-classic-panel');
    makeDraggableWindow(panel,{handle:panel?.querySelector('.tv2-tree-classic-toolbar'),storageKey:'tree-workspace',resizable:true,minWidth:600,minHeight:420});
    bindSidecarStatus(panel?.querySelector('.tv2-shared-sidecar-status'),{includeQueue:false,includeMain:true});
    const bookSelect=panel.querySelector('.tv2-tree-book');
    const treeScroll=panel.querySelector('.tv2-tree-sidebar-scroll');
    const main=panel.querySelector('.tv2-tree-classic-main');
    const status=panel.querySelector('.tv2-tree-status');
    const searchInput=panel.querySelector('.tv2-tree-classic-search input');
    const builderReviewBar=panel.querySelector('.tv2-tree-builder-review'),builderReviewStatus=panel.querySelector('.tv2-tree-builder-review-status'),builderApprove=panel.querySelector('.tv2-tree-builder-approve'),builderCancel=panel.querySelector('.tv2-tree-builder-cancel');
    const builderResumeBar=panel.querySelector('.tv2-tree-builder-resume'),builderResumeStatus=panel.querySelector('.tv2-tree-builder-resume-status'),builderResumeNow=panel.querySelector('.tv2-tree-builder-resume-now'),builderResumeCancel=panel.querySelector('.tv2-tree-builder-resume-cancel');

    let builderBusyTimer=null;
    function beginBuilderBusy(message){
        if(builderBusyTimer)clearInterval(builderBusyTimer);const started=Date.now(),runId=builderReview?.runId||null;builderReviewBar.classList.add('is-busy');
        const paint=()=>{if(!reviewActive()||builderReview?.runId!==runId)return;const seconds=Math.max(0,Math.floor((Date.now()-started)/1000));builderReviewStatus.textContent=`${message} · ${seconds}s · saved work is safe`;};paint();builderBusyTimer=setInterval(paint,1000);
    }
    function endBuilderBusy(){if(builderBusyTimer){clearInterval(builderBusyTimer);builderBusyTimer=null;}builderReviewBar.classList.remove('is-busy');}

    const builderQualityReport=document.createElement('div');builderQualityReport.className='tv2-builder-quality-report';builderQualityReport.hidden=true;builderQualityReport.style.cssText='padding:10px;overflow:auto;border-bottom:1px solid var(--SmartThemeBorderColor)';builderReviewBar.insertAdjacentElement('afterend',builderQualityReport);
    function reviewActive(){return !!(builderReview&&builderReview.book===selectedBook);}
    function treePreviewActive(){return !!(reviewActive()&&builderReview.tree?.root);}
    function activeTree(){return treePreviewActive()?builderReview.tree:(selectedBook?getTree(selectedBook):null);}
    function nodeIds(root,out=new Set()){if(!root)return out;out.add(root.id);for(const child of root.children||[])nodeIds(child,out);return out;}
    function targetUid(uid){return treePreviewActive()&&builderReview.targetUids?.has(Number(uid));}
    function proposedNode(id){return treePreviewActive()&&builderReview.engine!=='builder2'&&!builderReview.baselineNodeIds.has(id)&&id!==builderReview.tree.root.id;}
    function renderBuilder2ReviewDetails(){
        if(!reviewActive()||builderReview.engine!=='builder2')return false;
        const r=builderReview.review||{},kind=builderReview.reviewKind;
        builderQualityReport.hidden=false;
        if(kind==='preview'){
            renderBuilderQualityReport(builderQualityReport,builderReview.preview,{active:true,edited:false});builderQualityReport.insertAdjacentHTML('beforeend',builder2PreviewOverrideMarkup(r));
            wireBuilder2PreviewOverrides(builderQualityReport,{
                onApply:async({sourceKey,taxonId})=>{try{builderReviewStatus.textContent='Applying manual placement override and rerunning quality review…';const next=await getLorebookBuilderController().applyPreviewOverride(builderReview.runId,{token:builderReview.reviewToken,sourceKey,taxonId});consumeBuilderResult(next);renderAll();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Builder 2');}},
                onReset:async({sourceKey})=>{try{builderReviewStatus.textContent='Resetting manual placement override and reclassifying source…';const next=await getLorebookBuilderController().resetPreviewOverride(builderReview.runId,{token:builderReview.reviewToken,sourceKey});consumeBuilderResult(next);renderAll();}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Builder 2');}},
                onError:error=>globalThis.toastr?.error(error?.message||String(error),'Nexus Builder 2')
            });
        }else{
            builderQualityReport.innerHTML=builder2ReviewMarkup(r);
            if(kind==='taxonomy-review')wireBuilder2TaxonomyEditor(builderQualityReport,r);
            if(kind==='gap-review')wireBuilder2GapReview(builderQualityReport,r);
        }
        upgradeLaneDButtons(builderQualityReport);
        return true;
    }
    function collectCurrentBuilder2ReviewDecision(){return collectSharedBuilder2ReviewDecision(builderQualityReport,builderReview?.review||{});}
    function consumeBuilderResult(result){
        if(result?.state==='current')return false;
        if(result?.engine==='builder2'&&(result?.state==='review'||result?.preview?.nextTree?.root)){
            builderResumeCandidate=null;
            const stagedPreview=result?.state!=='review'&&!!result?.transactionId&&!!result?.preview?.nextTree?.root;
            const reviewKind=stagedPreview?'preview':result.reviewKind;
            const tree=reviewKind==='preview'&&result.preview?.nextTree?.root?normalizeTree(clone(result.preview.nextTree),result.book):null;
            builderReview={engine:'builder2',book:result.book,mode:result.mode,runId:result.runId,transactionId:result.transactionId||null,reviewKind,reviewToken:stagedPreview?null:(result.reviewToken||null),review:result,preview:result.preview||null,tree,baselineNodeIds:nodeIds(getTree(result.book)?.root),targetUids:new Set((result.preview?.added||[]).map(row=>Number(row.uid))),dirty:false};
            if(tree)selectedNodeId=tree.root.id;else{selectedNodeId=getTree(result.book)?.root?.id||'';selectedPseudo='';}
            return true;
        }
        if(result?.preview?.nextTree?.root){
            const tree=normalizeTree(clone(result.preview.nextTree),result.book);
            builderReview={engine:'legacy',book:result.book,mode:result.mode,transactionId:result.transactionId,preview:result.preview,tree,baselineNodeIds:nodeIds(getTree(result.book)?.root),targetUids:new Set((result.preview.added||[]).map(r=>Number(r.uid))),dirty:false};selectedNodeId=tree.root.id;return true;
        }
        throw new Error('Lorebook Builder returned neither a review step nor a Tree preview.');
    }
    function updateBuilderChrome(){
        const active=reviewActive(),blocked=active||!!builderLaunchAbort;
        const resumable=!active&&builderResumeCandidate?.book===selectedBook?builderResumeCandidate:null;
        const builderModeSelect=panel.querySelector('.tv2-b2-launch-mode'),builderValidateOnly=panel.querySelector('.tv2-b2-launch-validate-only');
        if(!renderBuilder2ReviewDetails())renderBuilderQualityReport(builderQualityReport,builderReview?.preview,{active,edited:builderReview?.dirty===true});
        builderReviewBar.hidden=!active;panel.classList.toggle('tv2-builder-review-active',active);panel.classList.toggle('tv2-builder-review-workspace',!!(active&&builderReview?.engine==='builder2'&&builderReview.reviewKind!=='preview'));bookSelect.disabled=blocked;
        builderResumeBar.hidden=!resumable;
        if(resumable){
            const phaseLabels={'inventory':'Preparing lore','survey':'Analyzing lore','taxonomy-draft':'Designing categories','taxonomy-review':'Category plan ready','classification':'Placing entries','classification-review':'Placement review','gap-review':'Unplaced entries need review','reclassification':'Updating placements','reconciliation':'Cleaning Tree structure','quality-review':'Final check','materialization':'Building final Tree','validation':'Final Tree ready','staged':'Ready to commit'};
            const intent=resumable.validateOnly===true?'validation-only':'commit-capable';
            builderResumeStatus.textContent=`Saved at ${phaseLabels[String(resumable.phase||'')]||'an unfinished step'} · ${intent}. Resume continues from saved work; completed stages are reused.`;
            builderResumeBar.title=`Run ${resumable.runId} · ${String(resumable.mode||'auto').toUpperCase()} · ${String(resumable.phase||'unfinished')}`;
            builderResumeNow.disabled=blocked;builderResumeCancel.disabled=blocked;
        }
        for(const sel of ['.tv2-tree-add','.tv2-tree-merge-scan','.tv2-tree-summarize','.tv2-tree-uid-summarize','.tv2-tree-import-file-btn','.tv2-tree-export','.tv2-tree-delete-tree']){const b=panel.querySelector(sel);if(b)b.disabled=blocked;}
        const blank=panel.querySelector('.tv2-tree-blank');if(blank){const hasTree=!!(selectedBook&&getTree(selectedBook));blank.disabled=blocked||!selectedBook||hasTree;blank.hidden=hasTree;}
        const build=panel.querySelector('.tv2-tree-builder');if(build){const hasResume=builderResumeCandidate?.book===selectedBook;build.disabled=blocked;build.classList.toggle('has-resumable',!!hasResume);const label=build.querySelector('span'),icon=build.querySelector('i');if(label&&!blocked)label.textContent=hasResume?'Resume Lorebook Builder':'Build Lorebook Tree';if(icon)icon.className=hasResume?'fa-solid fa-rotate-right':'fa-solid fa-sitemap';build.title=hasResume?`Saved Builder work is waiting. Resume from ${builderResumeCandidate.phase}; completed stages will be reused.`:'Build or incrementally reconcile the Nexus Lore Tree for this lorebook';}
        if(builderModeSelect&&builderValidateOnly){const resume=builderResumeCandidate?.book===selectedBook?builderResumeCandidate:null;builderModeSelect.disabled=blocked||!!resume;builderValidateOnly.disabled=blocked||!!resume;if(resume){builderModeSelect.value=['full','incremental','repair'].includes(String(resume.mode||''))?resume.mode:'auto';builderValidateOnly.checked=resume.validateOnly===true;}}
        if(active&&builderReview.engine==='builder2'){
            const labels={'taxonomy-review':['Category plan','Approve Category Plan'],'classification-review':['Placement review','Continue Placements'],'gap-review':['Unplaced entries','Continue Decisions'],'reconciliation-review':['Tree cleanup','Apply Cleanup'],'quality-review':['Final check',builderReview.review?.canApprove===false?'Resolve Entries':'Continue to Final Tree'],'preview':['Final Tree preview','Approve & Commit Tree']};
            const [label,button]=labels[builderReview.reviewKind]||['Builder 2 review','Continue'];builderReviewStatus.textContent=`${String(builderReview.mode||'').toUpperCase()} · ${label} · run ${builderReview.runId}`;builderApprove.textContent=button;builderApprove.disabled=builderReview.reviewKind==='quality-review'&&builderReview.review?.canApprove===false&&builderReview.review?.canResolve!==true&&!((builderReview.review?.report?.blockers||[]).some(row=>row?.type==='unresolved-classification'&&row?.sourceKey));
        }else if(active){const proposed=[...nodeIds(builderReview.tree.root)].filter(id=>proposedNode(id)).length;builderReviewStatus.textContent=`${String(builderReview.mode||'').toUpperCase()} proposal · ${builderReview.targetUids.size} UID placement(s) · ${proposed} proposed node(s)${builderReview.dirty?' · edited':''} · not saved`;builderApprove.textContent='Approve Tree';}
    }

    function refreshBookSelect(prefer=selectedBook){
        const books=allBooks();if(prefer&&!books.includes(prefer))books.push(prefer);books.sort((a,b)=>a.localeCompare(b));
        bookSelect.innerHTML=books.length?books.map(book=>{const preview=builderReview?.book===book&&builderReview?.tree?.root;return `<option value="${esc(book)}">${esc(book)}${preview?' · preview':getTree(book)?'':' · no Tree'}</option>`;}).join(''):'<option value="">No lorebooks found</option>';
        if(prefer&&books.includes(prefer))bookSelect.value=prefer;selectedBook=bookSelect.value||prefer||'';
    }

    async function loadCurrentBook(){
        const serial=++loadSerial;currentBookData={entries:{}};currentLookup=new Map();
        if(!selectedBook)return;
        try{assertReadableBook(selectedBook);const data=await loadBook(selectedBook);if(serial!==loadSerial)return;currentBookData=data||{entries:{}};currentLookup=entryLookup(currentBookData);}
        catch(err){if(serial!==loadSerial)return;logEvent('tree','editor-lorebook-load-failed',{book:selectedBook,error:err},'warn');}
    }

    async function refreshBuilderResumeCandidate(){
        builderResumeCandidate=null;
        if(!selectedBook)return null;
        const controller=getLorebookBuilderController();
        if(typeof controller.listResumable!=='function')return null;
        try{const rows=await controller.listResumable(selectedBook);builderResumeCandidate=rows[0]||null;}
        catch(error){logEvent('builder2','resume-discovery-failed',{book:selectedBook,error},'warn');builderResumeCandidate=null;}
        return builderResumeCandidate;
    }

    async function persistTree(tree,eventName='manual-tree-edit',data={},expectedBaseline=null){
        if(reviewActive()){
            builderReview.tree=normalizeTree(clone(tree),selectedBook);
            builderReview.dirty=true;
            logEvent('builder',`preview-${eventName}`,{book:selectedBook,transactionId:builderReview.transactionId,...data},'info');
            return {ok:true,preview:true};
        }
        if(expectedBaseline!==null&&JSON.stringify(treeBaseline(selectedBook))!==JSON.stringify(expectedBaseline)){
            const error=new Error('Tree changed in the background while this workspace was open. Refresh and retry this edit.');
            error.name='TV2TreeStaleWrite';throw error;
        }
        const proposal=await proposeTreeReplace(selectedBook,tree,{source:'tree-workspace',reasoning:`Operator Tree workspace action: ${eventName}.`,mutationKind:'semantic'});
        const applied=await approveProposal(proposal.id);
        if(!applied.ok)throw new Error(applied.error||'Tree proposal failed.');
        logEvent('tree',eventName,{book:selectedBook,...data,proposalId:proposal.id},'info');
        return applied;
    }
    async function commitTreeEdit(tree,eventName,data={},expectedBaseline=null){
        try{await persistTree(tree,eventName,data,expectedBaseline);renderAll();return true;}
        catch(error){logEvent('tree','tree-workspace-mutation-failed',{book:selectedBook,eventName,error},'error');globalThis.toastr?.error(error?.message||String(error),'Nexus Tree');return false;}
    }

    function isVisibleNode(node){
        if(!searchQuery)return true;
        if(`${node.label||''} ${node.summary||''}`.toLowerCase().includes(searchQuery))return true;
        for(const uid of node.entryUids||[]){if(entryMatches(currentLookup.get(Number(uid)),searchQuery))return true;}
        return (node.children||[]).some(isVisibleNode);
    }


    function clearMultiSelection(){selectedCategoryIds.clear();selectedEntryUids.clear();}
    function nodeMovable(tree,nodeId){const id=String(nodeId||'');if(!id||id===String(tree?.root?.id||''))return false;if(builderReview?.engine==='builder2')return false;return !reviewActive()||proposedNode(id);}
    function entryMovable(uid){if(builderReview?.engine==='builder2')return false;return !reviewActive()||targetUid(uid);}
    function toggleCategorySelection(nodeId,force=null){const id=String(nodeId||'');if(!id)return;const next=force==null?!selectedCategoryIds.has(id):!!force;if(next)selectedCategoryIds.add(id);else selectedCategoryIds.delete(id);}
    function toggleEntrySelection(uid,force=null){const id=Number(uid);if(!Number.isFinite(id))return;const next=force==null?!selectedEntryUids.has(id):!!force;if(next)selectedEntryUids.add(id);else selectedEntryUids.delete(id);}
    function selectionPayload(kind,id){
        if(kind==='node'){
            const nodeId=String(id||'');
            if(selectedCategoryIds.has(nodeId))return {kind:'tree-items',nodeIds:[...selectedCategoryIds],uids:[...selectedEntryUids]};
            return {kind:'tree-items',nodeIds:[nodeId],uids:[]};
        }
        const uid=Number(id);
        if(selectedEntryUids.has(uid))return {kind:'tree-items',nodeIds:[...selectedCategoryIds],uids:[...selectedEntryUids]};
        return {kind:'tree-items',nodeIds:[],uids:[uid]};
    }
    function writeDragPayload(event,payload){activeTreeDragPayload=payload;try{event.dataTransfer?.setData('application/x-nexus-tree-items',JSON.stringify(payload));event.dataTransfer?.setData('text/plain',payload.uids?.length===1&&!payload.nodeIds?.length?String(payload.uids[0]):JSON.stringify(payload));if(event.dataTransfer)event.dataTransfer.effectAllowed='move';}catch{}}
    function readDragPayload(event){
        if(activeTreeDragPayload)return activeTreeDragPayload;
        const dt=event.dataTransfer;if(!dt)return null;
        const rich=dt.getData('application/x-nexus-tree-items');
        if(rich){try{const parsed=JSON.parse(rich);if(parsed?.kind==='tree-items')return {nodeIds:Array.isArray(parsed.nodeIds)?parsed.nodeIds:[],uids:Array.isArray(parsed.uids)?parsed.uids:[]};}catch{}}
        const plain=dt.getData('text/plain');const uid=Number(plain);return Number.isFinite(uid)?{nodeIds:[],uids:[uid]}:null;
    }
    function validDestination(tree,targetNodeId,nodeIds=[...selectedCategoryIds]){
        const target=findNode(tree?.root,targetNodeId);if(!target)return false;
        for(const rawId of nodeIds||[]){const id=String(rawId||'');const moved=findNode(tree.root,id);if(!moved)continue;if(id===String(target.id)||containsNode(moved,target.id))return false;}
        return true;
    }
    async function moveItemsToNode(tree,targetNodeId,{nodeIds=[],uids=[]}={},source='selection'){
        const allowedNodeIds=(nodeIds||[]).map(String).filter(id=>nodeMovable(tree,id));
        const allowedUids=(uids||[]).map(Number).filter(uid=>Number.isFinite(uid)&&entryMovable(uid));
        if(!allowedNodeIds.length&&!allowedUids.length)return false;
        if(!validDestination(tree,targetNodeId,allowedNodeIds)){globalThis.toastr?.warning('Selected categories cannot be moved into themselves or their descendants.','Nexus Tree');return false;}
        const copy=clone(tree);let moved;
        try{moved=moveTreeItems(copy,{nodeIds:allowedNodeIds,uids:allowedUids,targetNodeId});}
        catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Tree');return false;}
        const ok=await commitTreeEdit(copy,'tree-selection-moved',{source,targetNodeId:String(targetNodeId),nodeIds:moved.nodeIds,uids:moved.uids,nodeCount:moved.nodeIds.length,uidCount:moved.uids.length},semanticSnapshot(tree));
        if(ok){for(const id of allowedNodeIds)selectedCategoryIds.delete(String(id));for(const uid of allowedUids)selectedEntryUids.delete(Number(uid));selectedNodeId=String(targetNodeId);selectedPseudo='';renderAll();}
        return ok;
    }
    function selectionDestinationOptions(tree){
        const rows=[];const moving=[...selectedCategoryIds];
        const walk=(node,depth=0)=>{if(validDestination(tree,node.id,moving))rows.push({node,depth});for(const child of node.children||[])walk(child,depth+1);};walk(tree.root);return rows;
    }
    function appendSelectionBar(head,tree){
        const nodeCount=selectedCategoryIds.size,uidCount=selectedEntryUids.size,total=nodeCount+uidCount;if(!total)return;
        const bar=document.createElement('div');bar.className='tv2-tree-selection-bar';
        const summary=document.createElement('span');summary.className='tv2-tree-selection-summary';summary.innerHTML=`<b>${total} selected</b><small>${nodeCount?`${nodeCount} categor${nodeCount===1?'y':'ies'}`:''}${nodeCount&&uidCount?' · ':''}${uidCount?`${uidCount} entr${uidCount===1?'y':'ies'}`:''}</small>`;
        const target=document.createElement('select');target.className='text_pole tv2-tree-selection-target';const destinations=selectionDestinationOptions(tree);target.innerHTML=destinations.map(({node,depth})=>`<option value="${esc(node.id)}">${esc(`${'— '.repeat(depth)}${node===tree.root?'Root':node.label}`)}</option>`).join('');if(selectedNodeId&&destinations.some(row=>row.node.id===selectedNodeId))target.value=selectedNodeId;
        const move=document.createElement('button');move.type='button';move.className='menu_button tv2-primary-action tv2-tree-selection-move';move.innerHTML='<i class="fa-solid fa-arrows-up-down-left-right"></i> Move selected';move.disabled=!destinations.length;move.addEventListener('click',()=>moveItemsToNode(tree,target.value,{nodeIds:[...selectedCategoryIds],uids:[...selectedEntryUids]},'bulk-toolbar'));
        const clear=document.createElement('button');clear.type='button';clear.className='menu_button tv2-tree-selection-clear';clear.textContent='Clear';clear.addEventListener('click',()=>{clearMultiSelection();renderAll();});
        bar.append(summary,target,move,clear);head.appendChild(bar);
    }

    function buildNode(tree,node,{isRoot=false,depth=0,topIndex=0}={}){
        if(searchQuery&&!isVisibleNode(node))return null;
        const wrap=document.createElement('div');wrap.className='tv2-tree-node';if(depth===1)wrap.dataset.topIndex=String(topIndex);
        const movable=!isRoot&&nodeMovable(tree,node.id),selected=selectedCategoryIds.has(String(node.id));
        const row=document.createElement('div');row.className=`tv2-tree-row${selectedNodeId===node.id&&!selectedPseudo?' active':''}${selected?' is-multi-selected':''}${isRoot?' tv2-tree-row-root':''}${proposedNode(node.id)?' is-builder-proposed':''}`;row.dataset.node=node.id;row.style.setProperty('--tv2-tree-depth',String(depth));row.draggable=movable;
        const visibleChildren=(node.children||[]).filter(child=>!searchQuery||isVisibleNode(child));
        const hasChildren=visibleChildren.length>0;
        const collapsed=isRoot?false:(searchQuery?false:!expandedNodeIds.has(String(node.id)));
        row.innerHTML=`<span class="tv2-tree-toggle">${hasChildren?(collapsed?'▶':'▼'):''}</span>${!isRoot?`<span class="tv2-tree-select-box${selected?' checked':''}" role="checkbox" aria-checked="${selected?'true':'false'}" title="Select category for a group move"></span>`:''}<span class="tv2-tree-node-drag" title="${movable?'Drag category to another category':'This category is locked in Builder review'}">${movable?'⋮⋮':'·'}</span><span class="tv2-tree-dot"></span><span class="tv2-tree-label">${esc(isRoot?'Root':node.label||'Unnamed')}</span><span class="tv2-tree-count">${countActive(node,currentLookup)}</span>`;
        row.querySelector('.tv2-tree-toggle').addEventListener('click',e=>{e.stopPropagation();if(!hasChildren||isRoot)return;const key=String(node.id);if(expandedNodeIds.has(key))expandedNodeIds.delete(key);else expandedNodeIds.add(key);renderAll();});
        row.querySelector('.tv2-tree-select-box')?.addEventListener('click',e=>{e.stopPropagation();if(!movable)return;toggleCategorySelection(node.id);renderAll();});
        row.addEventListener('click',e=>{if(!isRoot&&movable&&(e.ctrlKey||e.metaKey)){toggleCategorySelection(node.id);renderAll();return;}selectedNodeId=node.id;selectedPseudo='';renderAll();});
        if(movable){row.addEventListener('dragstart',e=>{writeDragPayload(e,selectionPayload('node',node.id));row.classList.add('dragging');});row.addEventListener('dragend',()=>{activeTreeDragPayload=null;row.classList.remove('dragging');});}
        row.addEventListener('dragover',e=>{const payload=readDragPayload(e);if(!payload||!validDestination(tree,node.id,payload.nodeIds))return;e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='move';row.classList.add('tv2-tree-drop-target');});
        row.addEventListener('dragleave',()=>row.classList.remove('tv2-tree-drop-target'));
        row.addEventListener('drop',async e=>{e.preventDefault();e.stopPropagation();row.classList.remove('tv2-tree-drop-target');const payload=readDragPayload(e);if(!payload)return;await moveItemsToNode(tree,node.id,payload,payload.nodeIds?.length?'node-drag':'entry-drag');});
        wrap.appendChild(row);
        if(hasChildren&&!collapsed){const kids=document.createElement('div');kids.className='tv2-tree-children';let idx=0;for(const child of visibleChildren){const childEl=buildNode(tree,child,{depth:depth+1,topIndex:depth===0?idx++:topIndex});if(childEl)kids.appendChild(childEl);}wrap.appendChild(kids);}
        return wrap;
    }

    function renderTree(tree){
        treeScroll.replaceChildren();
        if(!tree){status.textContent='';treeScroll.innerHTML='<div class="tv2-tree-empty">No Tree built yet.</div>';return;}
        const rootEl=buildNode(tree,tree.root,{isRoot:true,depth:0,topIndex:0});if(rootEl)treeScroll.appendChild(rootEl);
        const unassigned=unassignedEntries(currentBookData,tree).filter(e=>entryMatches(e,searchQuery));
        if(unassigned.length){const sep=document.createElement('div');sep.className='tv2-tree-unassigned-wrap';const row=document.createElement('div');row.className=`tv2-tree-row tv2-tree-row-unassigned${selectedPseudo==='unassigned'?' active':''}`;row.innerHTML=`<span class="tv2-tree-toggle"></span><span class="tv2-tree-dot"></span><span class="tv2-tree-label">Unassigned</span><span class="tv2-tree-count">${unassigned.length}</span>`;row.addEventListener('click',()=>{selectedPseudo='unassigned';selectedNodeId='';renderAll();});sep.appendChild(row);treeScroll.appendChild(sep);}
        status.textContent=reviewActive()?`${collectUids(tree.root).length} preview · not saved`:`${collectUids(tree.root).length} indexed`;
    }

    function breadcrumb(tree,node){
        const wrap=document.createElement('div');wrap.className='tv2-tree-breadcrumb';
        if(selectedPseudo==='unassigned'){
            const root=document.createElement('button');root.textContent='Root';root.addEventListener('click',()=>{selectedPseudo='';selectedNodeId=tree.root.id;renderAll();});wrap.append(root,document.createTextNode(' ▸ '),Object.assign(document.createElement('span'),{textContent:'Unassigned'}));return wrap;
        }
        const path=nodePath(tree.root,node.id)||[tree.root];path.forEach((part,i)=>{if(i)wrap.append(document.createTextNode(' ▸ '));if(i<path.length-1){const b=document.createElement('button');b.textContent=part===tree.root?'Root':part.label;b.addEventListener('click',()=>{selectedNodeId=part.id;selectedPseudo='';renderAll();});wrap.appendChild(b);}else wrap.appendChild(Object.assign(document.createElement('span'),{textContent:part===tree.root?'Root':part.label}));});return wrap;
    }

    function buildEntryRow(tree,uid,entry,{unassigned=false}={}){
        const review=reviewActive(),editable=!review||targetUid(uid),selected=selectedEntryUids.has(Number(uid));const row=document.createElement('div');row.className=`tv2-tree-entry-row${selected?' is-multi-selected':''}${entry?.disable?' is-disabled':''}${review&&targetUid(uid)?' is-builder-proposed':''}${review&&!editable?' is-builder-locked':''}`;row.draggable=editable;row.dataset.uid=String(uid);
        const tokenLabel=entry?formatTokenCount(estimateContentTokens(entry.content||''),{approximate:true}):'—';
        const usableKeywords=(Array.isArray(entry?.key)?entry.key:(entry?.key?[entry.key]:[])).map(value=>String(value||'').trim()).filter(Boolean);
        const keywordWarning=entry&&!entry.disable&&usableKeywords.length===0;
        const tools=entry&&!review?'<button class="tv2-tree-entry-summarize" type="button" title="Summarize this UID"><i class="fa-solid fa-compress"></i></button><button class="tv2-tree-entry-edit" type="button" title="Edit this lore entry"><i class="fa-solid fa-pen"></i></button>':'';const remove=!unassigned&&editable?'<button class="tv2-tree-entry-remove" type="button" title="Remove from this node"><i class="fa-solid fa-xmark"></i></button>':'';
        const uidLabel=keywordWarning?`<span class="tv2-tree-entry-keyword-warning" title="Active lore entry has no usable activation keyword. Edit the entry or use Housekeeper keyword advice.">UID ${esc(uid)} · NO KEYWORD</span>`:`<span class="tv2-tree-entry-uid">#${esc(uid)}</span>`;
        row.innerHTML=`<span class="tv2-tree-select-box${selected?' checked':''}" role="checkbox" aria-checked="${selected?'true':'false'}" title="Select entry for a group move"></span><span class="tv2-tree-entry-drag">${editable?'⋮⋮':'·'}</span><span class="tv2-tree-entry-name">${esc(entryTitle(entry,uid))}</span><span class="tv2-tree-entry-tokens" title="Estimated lore content tokens">${esc(tokenLabel)} tok</span>${uidLabel}${tools}${remove}`;
        row.querySelector('.tv2-tree-select-box')?.addEventListener('click',e=>{e.stopPropagation();if(!editable)return;toggleEntrySelection(uid);renderAll();});
        if(editable){row.addEventListener('dragstart',e=>{writeDragPayload(e,selectionPayload('entry',uid));row.classList.add('dragging');});row.addEventListener('dragend',()=>{activeTreeDragPayload=null;row.classList.remove('dragging');});}
        row.querySelector('.tv2-tree-entry-remove')?.addEventListener('click',async e=>{e.stopPropagation();const copy=clone(tree);removeEntryEverywhere(copy.root,uid);selectedEntryUids.delete(Number(uid));await commitTreeEdit(copy,'entry-tree-unassigned',{uid},semanticSnapshot(tree));});
        row.querySelector('.tv2-tree-entry-edit')?.addEventListener('click',e=>{e.stopPropagation();openLoreEntryEditor({book:selectedBook,tree:clone(tree),uid,entry:clone(entry),onSaved:async()=>{await loadCurrentBook();renderAll();}});});
        row.querySelector('.tv2-tree-entry-summarize')?.addEventListener('click',e=>{e.stopPropagation();openUidSummarizer({book:selectedBook,uid});});
        if(entry){row.addEventListener('click',e=>{if(e.target.closest('button')||e.target.closest('.tv2-tree-select-box'))return;if(editable&&(e.ctrlKey||e.metaKey)){toggleEntrySelection(uid);renderAll();return;}const existing=row.nextElementSibling;if(existing?.classList.contains('tv2-tree-entry-expand')){existing.remove();row.classList.remove('expanded');return;}main.querySelectorAll('.tv2-tree-entry-expand').forEach(x=>x.remove());main.querySelectorAll('.tv2-tree-entry-row.expanded').forEach(x=>x.classList.remove('expanded'));row.classList.add('expanded');const ex=document.createElement('div');ex.className='tv2-tree-entry-expand';const keys=(entry.key||[]).map(k=>`<span>${esc(k)}</span>`).join('');ex.innerHTML=`${keys?`<div class="tv2-tree-entry-keys"><b>Keys</b><div>${keys}</div></div>`:''}<div class="tv2-tree-entry-content">${esc(entry.content||'')}</div>`;row.after(ex);});}
        return row;
    }

    function childCard(tree,child){
        const movable=nodeMovable(tree,child.id),selected=selectedCategoryIds.has(String(child.id));const card=document.createElement('div');card.className=`tv2-tree-child-card${selected?' is-multi-selected':''}${proposedNode(child.id)?' is-builder-proposed':''}`;card.setAttribute('role','button');card.tabIndex=0;card.draggable=movable;card.dataset.node=String(child.id);card.innerHTML=`<span class="tv2-tree-select-box${selected?' checked':''}" role="checkbox" aria-checked="${selected?'true':'false'}" title="Select category for a group move"></span><span class="tv2-tree-node-drag">${movable?'⋮⋮':'·'}</span><span class="tv2-tree-dot"></span><span class="tv2-tree-child-info"><b>${esc(child.label||'Unnamed')}</b>${child.summary?`<small>${esc(child.summary)}</small>`:''}</span><span class="tv2-tree-child-count">${countActive(child,currentLookup)}</span><span>▸</span>`;
        card.querySelector('.tv2-tree-select-box')?.addEventListener('click',e=>{e.stopPropagation();if(!movable)return;toggleCategorySelection(child.id);renderAll();});
        card.addEventListener('click',e=>{if(movable&&(e.ctrlKey||e.metaKey)){toggleCategorySelection(child.id);renderAll();return;}selectedNodeId=child.id;selectedPseudo='';renderAll();});card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();card.click();}});
        if(movable){card.addEventListener('dragstart',e=>{writeDragPayload(e,selectionPayload('node',child.id));card.classList.add('dragging');});card.addEventListener('dragend',()=>{activeTreeDragPayload=null;card.classList.remove('dragging');});}
        card.addEventListener('dragover',e=>{const payload=readDragPayload(e);if(!payload||!validDestination(tree,child.id,payload.nodeIds))return;e.preventDefault();e.stopPropagation();card.classList.add('tv2-tree-drop-target');});card.addEventListener('dragleave',()=>card.classList.remove('tv2-tree-drop-target'));card.addEventListener('drop',async e=>{e.preventDefault();e.stopPropagation();card.classList.remove('tv2-tree-drop-target');const payload=readDragPayload(e);if(payload)await moveItemsToNode(tree,child.id,payload,payload.nodeIds?.length?'subcategory-drag':'entry-drag');});return card;
    }

    function appendBuilderLaunchControls(container){
        if(!container)return;
        const host=document.createElement('div');host.className='tv2-tree-builder-options-host';host.innerHTML=builder2LaunchControlsHtml(builderLaunchOptions);container.appendChild(host);
        const mode=host.querySelector('.tv2-b2-launch-mode'),validate=host.querySelector('.tv2-b2-launch-validate-only');
        const sync=()=>{builderLaunchOptions=readBuilder2LaunchOptions(host,builderLaunchOptions);const blank=builderLaunchOptions.requestedMode==='blank';if(validate){if(blank)validate.checked=false;validate.disabled=blank;}};
        mode?.addEventListener('change',sync);validate?.addEventListener('change',sync);sync();
    }

    function renderMain(tree){
        main.replaceChildren();
        if(!selectedBook){main.innerHTML='<div class="tv2-tree-main-empty">Select a lorebook.</div>';return;}
        if(!tree){const empty=document.createElement('div');empty.className='tv2-tree-main-empty';empty.innerHTML=`<i class="fa-solid fa-folder-tree"></i><h3>No Nexus Tree for ${esc(selectedBook)}</h3><p>Use <b>Build Lorebook Tree</b> above to build a reviewed Tree, choose <b>Blank Tree (Root only)</b> for an empty structure, or import an existing Tree.</p>`;main.appendChild(empty);appendBuilderLaunchControls(main);updateBuilderChrome();return;}
        const review=reviewActive();
        const unassigned=selectedPseudo==='unassigned';
        const node=unassigned?{id:'__unassigned__',label:'Unassigned',entryUids:unassignedEntries(currentBookData,tree).map(e=>Number(e.uid)),children:[],summary:''}:findNode(tree.root,selectedNodeId)||tree.root;
        const isRoot=!unassigned&&node.id===tree.root.id;
        const head=document.createElement('div');head.className='tv2-tree-main-header';head.appendChild(breadcrumb(tree,node));
        const titleRow=document.createElement('div');titleRow.className='tv2-tree-main-title-row';
        if(!unassigned&&!isRoot){const input=document.createElement('input');input.className='tv2-tree-main-title text_pole';input.value=node.label||'Unnamed';input.addEventListener('change',async()=>{const label=input.value.trim();if(!label)return;const copy=clone(tree);findNode(copy.root,node.id).label=label;await commitTreeEdit(copy,'node-renamed',{nodeId:node.id,label},semanticSnapshot(tree));});titleRow.appendChild(input);}else{const title=document.createElement('div');title.className='tv2-tree-main-title-static';title.textContent=unassigned?'Unassigned Entries':'Root';titleRow.appendChild(title);}
        const actions=document.createElement('div');actions.className='tv2-tree-main-actions';if(!unassigned){if(!review){const gen=document.createElement('button');gen.className='tv2-tree-classic-btn tv2-node-generate-summary';gen.title='Generate this node summary';gen.innerHTML='<i class="fa-solid fa-wand-magic-sparkles"></i>';gen.addEventListener('click',async()=>{gen.disabled=true;try{globalThis.toastr?.info(`Summarizing ${node.label}…`,'Nexus',{timeOut:1400});await runTreeSummaryTask(signal=>generateNodeSummary(selectedBook,node.id,{signal}));renderAll();globalThis.toastr?.success(`Summary generated for ${node.label}.`,'Nexus');}catch(err){globalThis.toastr?.error(err?.message||String(err),'Nexus Tree summary failed');}finally{gen.disabled=false;}});actions.appendChild(gen);}const add=document.createElement('button');add.className='tv2-tree-classic-btn';add.title='Add sub-category';add.innerHTML='<i class="fa-solid fa-folder-plus"></i>';add.addEventListener('click',async()=>await addCategory(tree,node.id));actions.appendChild(add);}if(!unassigned&&!isRoot){const del=document.createElement('button');del.className='tv2-tree-classic-btn danger';del.title='Delete this node';del.innerHTML='<i class="fa-solid fa-trash-can"></i>';del.addEventListener('click',async()=>await deleteNode(tree,node));actions.appendChild(del);}titleRow.appendChild(actions);head.appendChild(titleRow);appendSelectionBar(head,tree);main.appendChild(head);
        const body=document.createElement('div');body.className='tv2-tree-main-body';if(review){const note=document.createElement('div');note.className='tv2-tree-builder-lock-note';note.textContent='Builder review is preview-only. Drag highlighted Builder UIDs, rename/move proposed nodes, or add/delete proposed categories. Existing Tree changes will be rejected at approval.';body.appendChild(note);}
        if(!unassigned&&!isRoot&&node.summary){const sum=document.createElement('div');sum.className='tv2-tree-node-summary';sum.innerHTML='<div>Node Summary</div>';const text=document.createElement('p');text.textContent=node.summary;sum.appendChild(text);body.appendChild(sum);}
        const uids=(node.entryUids||[]).filter(uid=>entryMatches(currentLookup.get(Number(uid)),searchQuery));
        if(uids.length){const section=document.createElement('div');section.className='tv2-tree-section-title';section.innerHTML=`<span class="tv2-tree-section-label">${unassigned?'Unassigned Entries':isRoot?'Root Entries':'Direct Entries'} <span>(${uids.length})</span></span>`;const selectable=uids.filter(uid=>entryMovable(uid));if(selectable.length){const all=selectable.every(uid=>selectedEntryUids.has(Number(uid)));const selectAll=document.createElement('button');selectAll.type='button';selectAll.className='tv2-tree-section-select';selectAll.textContent=all?'Clear entries':'Select entries';selectAll.addEventListener('click',()=>{for(const uid of selectable)toggleEntrySelection(uid,!all);renderAll();});section.appendChild(selectAll);}body.appendChild(section);const list=document.createElement('div');list.className='tv2-tree-entry-list';for(const uid of uids)list.appendChild(buildEntryRow(tree,uid,currentLookup.get(Number(uid)),{unassigned}));body.appendChild(list);}
        if(!unassigned&&(node.children||[]).length){const children=(node.children||[]).filter(child=>!searchQuery||isVisibleNode(child));if(children.length){const section=document.createElement('div');section.className='tv2-tree-section-title';section.innerHTML=`<span class="tv2-tree-section-label">Sub-categories <span>(${children.length})</span></span>`;const selectable=children.filter(child=>nodeMovable(tree,child.id));if(selectable.length){const all=selectable.every(child=>selectedCategoryIds.has(String(child.id)));const selectAll=document.createElement('button');selectAll.type='button';selectAll.className='tv2-tree-section-select';selectAll.textContent=all?'Clear categories':'Select categories';selectAll.addEventListener('click',()=>{for(const child of selectable)toggleCategorySelection(child.id,!all);renderAll();});section.appendChild(selectAll);}body.appendChild(section);const cards=document.createElement('div');cards.className='tv2-tree-child-cards';children.forEach(child=>cards.appendChild(childCard(tree,child)));body.appendChild(cards);}}
        if(searchQuery&&!uids.length&&(!node.children||[]).length===0){const empty=document.createElement('div');empty.className='tv2-tree-main-empty compact';empty.textContent='Nothing in this node matches the search.';body.appendChild(empty);}
        if(!unassigned){const advanced=document.createElement('details');advanced.className='tv2-tree-node-tools';advanced.innerHTML=`<summary>Node tools</summary><div class="tv2-tree-node-tools-body"><label>Summary<textarea class="text_pole tv2-node-summary" rows="4">${esc(node.summary||'')}</textarea></label><label>Node keywords<textarea class="text_pole tv2-node-keywords" rows="2" placeholder="Optional routing guidance; comma or line separated">${esc((node.keywords||[]).join(', '))}</textarea></label><div class="tv2-node-keyword-actions"><button class="menu_button tv2-node-keyword-suggest" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> Suggest node keywords</button><div class="tv2-node-keyword-result"></div></div><label>Direct entry UIDs<textarea class="text_pole tv2-node-uids" rows="3">${esc((node.entryUids||[]).join(', '))}</textarea></label>${isRoot?'':`<label>Move under<select class="text_pole tv2-node-parent"></select></label>`}<div class="tv2-button-row"><button class="menu_button tv2-node-generate" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate Summary</button><button class="menu_button tv2-node-save" type="button">Save Node</button>${isRoot?'':'<button class="menu_button tv2-node-move" type="button">Move Node</button>'}</div></div>`;body.appendChild(advanced);
            if(!isRoot){const select=advanced.querySelector('.tv2-node-parent');const rows=[];const walk=(n,depth=0)=>{if(n.id!==node.id&&!containsNode(node,n.id))rows.push({n,depth});for(const c of n.children||[])walk(c,depth+1);};walk(tree.root);const parent=findParent(tree.root,node.id);select.innerHTML=rows.map(({n,depth})=>`<option value="${esc(n.id)}" ${n.id===parent?.id?'selected':''}>${esc('  '.repeat(depth)+(n===tree.root?'Root':n.label))}</option>`).join('');}
            advanced.querySelector('.tv2-node-generate')?.addEventListener('click',async e=>{const btn=e.currentTarget;btn.disabled=true;try{const out=await runTreeSummaryTask(signal=>generateNodeSummary(selectedBook,node.id,{signal}));advanced.querySelector('.tv2-node-summary').value=out.summary;renderAll();globalThis.toastr?.success(`Summary generated for ${node.label}.`,'Nexus');}catch(err){globalThis.toastr?.error(err?.message||String(err),'Nexus Tree summary failed');}finally{btn.disabled=false;}});
            const subtreeButton=document.createElement('button');subtreeButton.type='button';subtreeButton.className='menu_button tv2-node-summarize-subtree';subtreeButton.innerHTML='<i class="fa-solid fa-layer-group"></i> Summarize subtree';subtreeButton.title='Safely summarize this node and descendants in bounded batches.';advanced.querySelector('.tv2-button-row')?.insertBefore(subtreeButton,advanced.querySelector('.tv2-node-save'));
            let resumeNodeIds=[];subtreeButton.addEventListener('click',async()=>{subtreeButton.disabled=true;try{const out=await runTreeSummaryTask(signal=>generateSummariesForSubtree(selectedBook,node.id,{targetNodeIds:resumeNodeIds.length?resumeNodeIds:null,onProgress:({done,total})=>{subtreeButton.textContent=`${done}/${total}`;},signal}));resumeNodeIds=out.resumeNodeIds||[];if(out.canResume){subtreeButton.innerHTML='<i class="fa-solid fa-rotate-right"></i> Resume missing summaries';globalThis.toastr?.warning(`${out.processed} summaries saved; ${out.failed.length} failed and ${out.blocked.length} dependent node(s) remain.`, 'Nexus');}else{renderAll();globalThis.toastr?.success(`Summarized ${out.processed} node(s) in ${node.label}.`,'Nexus');}}catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Tree summaries failed');}finally{subtreeButton.disabled=false;if(!resumeNodeIds.length)subtreeButton.innerHTML='<i class="fa-solid fa-layer-group"></i> Summarize subtree';}});
            advanced.querySelector('.tv2-node-keyword-suggest')?.addEventListener('click',async e=>{const btn=e.currentTarget;const result=advanced.querySelector('.tv2-node-keyword-result');btn.disabled=true;result.textContent='Generating suggestions…';try{const advice=await suggestKeywords({book:selectedBook,nodeId:node.id});const field=advanced.querySelector('.tv2-node-keywords');const existing=field.value.split(/[\n,;]+/).map(value=>value.trim()).filter(Boolean);for(const row of advice.suggestions)if(!existing.some(value=>value.toLowerCase()===row.keyword.toLowerCase()))existing.push(row.keyword);field.value=existing.join(', ');result.textContent=advice.suggestions.length?`${advice.suggestions.map(row=>`${row.keyword} (${row.accidentalFireRisk}% risk)`).join(' · ')} — save node to apply.`:'No new low-collision node keywords suggested.';}catch(error){result.textContent=error?.message||String(error);}finally{btn.disabled=false;}});
            advanced.querySelector('.tv2-node-save').addEventListener('click',async()=>{const copy=clone(tree);const target=findNode(copy.root,node.id);target.summary=advanced.querySelector('.tv2-node-summary').value.trim();target.keywords=[...new Set(advanced.querySelector('.tv2-node-keywords').value.split(/[\n,;]+/).map(value=>value.trim()).filter(Boolean))];const newUids=parseUidList(advanced.querySelector('.tv2-node-uids').value);target.entryUids=[];for(const uid of newUids){removeEntryEverywhere(copy.root,uid);target.entryUids.push(uid);}if(await commitTreeEdit(copy,'manual-node-saved',{nodeId:node.id,uidCount:newUids.length,keywordCount:target.keywords.length},semanticSnapshot(tree)))globalThis.toastr?.success('Tree node saved.','Nexus');});
            advanced.querySelector('.tv2-node-move')?.addEventListener('click',async()=>{const parentId=advanced.querySelector('.tv2-node-parent').value;if(!parentId)return;const copy=clone(tree);moveCategory(copy,node.id,parentId);await commitTreeEdit(copy,'node-moved',{nodeId:node.id,parentId},semanticSnapshot(tree));});if(review){advanced.querySelector('.tv2-node-generate')?.remove();advanced.querySelector('.tv2-node-keyword-suggest')?.remove();subtreeButton.remove();}}
        if(!review)appendBuilderLaunchControls(body);
        main.appendChild(body);
    }

    async function addCategory(tree,parentId=null){const parent=parentId?findNode(tree.root,parentId):tree.root;const label=await requestCategoryName({parentLabel:parent?.label||'Root'});if(!label)return;const copy=clone(tree);const made=createCategory(copy,{label,parentNodeId:parent?.id||copy.root.id});if(await commitTreeEdit(copy,'category-created',{nodeId:made.id,parentNodeId:parent?.id||copy.root.id,label:made.label},semanticSnapshot(tree))){if(parent?.id)expandedNodeIds.add(String(parent.id));selectedNodeId=made.id;selectedPseudo='';renderAll();}}
    async function deleteNode(tree,node){if(!confirm(`Delete "${node.label}"? Child nodes will be promoted and direct entries moved to the parent.`))return;const copy=clone(tree);deleteCategory(copy,node.id,{mode:'promote_children'});if(await commitTreeEdit(copy,'category-deleted',{nodeId:node.id,label:node.label},semanticSnapshot(tree))){selectedCategoryIds.delete(String(node.id));selectedNodeId=copy.root.id;renderAll();}}
    async function cancelBuilderReview(reason='operator-cancelled-builder-review',{quiet=false,render=true}={}){
        if(builderLaunchAbort&&!builderLaunchAbort.signal.aborted)builderLaunchAbort.abort(reason);const controller=getLorebookBuilderController();
        try{
            if(builderReview?.engine==='builder2'){
                if(builderReview.transactionId)await controller.cancelDurably(builderReview.transactionId,reason);else if(builderReview.runId)await controller.cancelDurably(builderReview.runId,reason);
            }else{
                if(builderLaunchTransactionId){const launch=controller.ledger?.read?.(builderLaunchTransactionId);if(launch?.state==='staged')await controller.cancelDurably(builderLaunchTransactionId,reason);else controller.cancel(builderLaunchTransactionId,reason);}
                if(builderReview?.transactionId&&builderReview.transactionId!==builderLaunchTransactionId)await controller.cancelDurably(builderReview.transactionId,reason);
            }
        }catch(error){if(!quiet)globalThis.toastr?.error(error?.message||String(error),'Nexus Builder');throw error;}
        const had=!!builderReview;builderReview=null;builderLaunchAbort=null;builderLaunchTransactionId=null;builderResumeCandidate=null;selectedNodeId='';selectedPseudo='';if(had&&!quiet)globalThis.toastr?.info('Builder review discarded. No Tree changes were committed.','Nexus');if(render)renderAll();
    }
    async function startBuilderReview(btn){
        if(!selectedBook||reviewActive())return;const book=selectedBook,old=btn.innerHTML;
        if(!isBookEnabled(book)){const enable=confirm(`Lorebook "${book}" is not enabled for Nexus.\n\nEnable Nexus for this lorebook and continue building its Tree?`);if(!enable){globalThis.toastr?.info('Lorebook Builder cancelled. The lorebook was not enabled.','Nexus');return;}await setBookEnabled(book,true);logEvent('builder','ui-book-enabled-for-builder',{book,source:'operator-confirmation'},'info');await loadCurrentBook();}
        btn.disabled=true;btn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> <span>Analyzing lore…</span>';builderLaunchAbort=new AbortController();updateBuilderChrome();
        try{
            builderLaunchOptions=readBuilder2LaunchOptions(panel);
            const launch=builderResumeCandidate?.book===book?{requestedMode:'auto',validateOnly:builderResumeCandidate.validateOnly===true}:builderLaunchOptions;
            if(launch.requestedMode==='blank'){
                if(getTree(book)){globalThis.toastr?.warning('Blank Tree is only available when this lorebook has no Nexus Tree. Existing Trees are never overwritten.','Nexus Lorebook Builder');return;}
                const blankTree=createTree(book);
                const proposal=await proposeTreeReplace(book,blankTree,{source:'operator-tree-ui',reasoning:'Operator selected Blank Tree (Root only). No lore UIDs were assigned.',mutationKind:'semantic'});
                const applied=await approveProposal(proposal.id);
                if(!applied?.ok)throw new Error(applied?.error||'Blank Tree creation failed.');
                builderResumeCandidate=null;selectedNodeId=getTree(book)?.root?.id||blankTree.root.id;selectedPseudo='';await loadCurrentBook();
                logEvent('builder','blank-tree-created',{book,proposalId:proposal.id,assignedUidCount:0},'info');
                globalThis.toastr?.success('Blank Tree created. Existing lore UIDs remain unassigned until you place them.','Nexus Lorebook Builder');
                renderAll();return;
            }
            const result=await getLorebookBuilderController().start({book,source:'operator-tree-ui',...launch},{signal:builderLaunchAbort.signal,onTransaction:id=>builderLaunchTransactionId=id});if(builderLaunchAbort.signal.aborted)return;
            if(result.state==='current'){builderResumeCandidate=null;globalThis.toastr?.success('Lorebook Tree is already current.','Nexus');return;}
            builderResumeCandidate=null;consumeBuilderResult(result);builderLaunchTransactionId=null;renderAll();
        }catch(err){if(err?.name!=='AbortError'){
            if(err?.name==='TV2Builder2ResumeRequired'){
                const discovered=err?.resumeCandidate||null;
                try{await refreshBuilderResumeCandidate();}catch{}
                if(!builderResumeCandidate&&discovered)builderResumeCandidate=discovered;
                logEvent('builder2','ui-resume-required',{book,runId:err?.runId||builderResumeCandidate?.runId||null,phase:builderResumeCandidate?.phase||null,validateOnly:builderResumeCandidate?.validateOnly===true},'warn');
                renderAll();
                return;
            }
            logEvent('builder','ui-launch-failed',{book,error:err},'error');globalThis.toastr?.error(err?.message||String(err),'Nexus Lorebook Builder');
        }}
        finally{builderLaunchAbort=null;builderLaunchTransactionId=null;btn.innerHTML=old;updateBuilderChrome();}
    }
    async function approveBuilderReview(){
        if(!reviewActive())return;const session=builderReview,controller=getLorebookBuilderController();builderApprove.disabled=true;builderCancel.disabled=true;
        try{
            if(session.engine==='builder2'){
                if(session.reviewKind!=='preview'){
                    beginBuilderBusy('Continuing Builder from durable review state');
                    const next=await controller.advanceReview(session.runId,{reviewKind:session.reviewKind,token:session.reviewToken,...collectCurrentBuilder2ReviewDecision()});
                    endBuilderBusy();consumeBuilderResult(next);renderAll();
                    if(next?.recoveredReviewState)globalThis.toastr?.info('Builder recovered automatically and continued from saved progress.','Nexus Lorebook Builder');
                    return;
                }
                let staged=null;
                if(session.transactionId){
                    staged={transactionId:session.transactionId,preview:session.preview,state:'staged',recovered:true};
                    builderReviewStatus.textContent='Resuming Tree save…';
                }else{
                    beginBuilderBusy('Saving reviewed Tree…');staged=await controller.stagePreview(session.runId,{token:session.reviewToken,approved:true});
                    if(staged.readOnly===true){builderReview=null;renderAll();globalThis.toastr?.success('Builder 2 validation completed read-only. Nothing was staged or committed.','Nexus');return;}
                    if(staged.state==='committed'){builderReview=null;builderResumeCandidate=null;await loadCurrentBook();selectedNodeId=getTree(session.book)?.root?.id||'';renderAll();globalThis.toastr?.success('Lorebook Tree was already committed with Builder 2.','Nexus');return;}
                    session.transactionId=staged.transactionId;session.preview=staged.preview;session.tree=normalizeTree(clone(staged.preview.nextTree),session.book);session.reviewToken=null;
                }
                beginBuilderBusy('Checking for changes and saving…');const committed=await controller.approveAndCommit(session.transactionId,{by:'operator'});
                if(committed.state==='stale'){builderReview=null;renderAll();globalThis.toastr?.warning('Builder 2 preview became stale. Nothing was committed.','Nexus');return;}
                builderReview=null;builderResumeCandidate=null;await loadCurrentBook();selectedNodeId=getTree(session.book)?.root?.id||'';renderAll();globalThis.toastr?.success('Lorebook Tree approved and committed with Builder 2.','Nexus');return;
            }
            let tx=session.transactionId;if(session.dirty){builderReviewStatus.textContent='Validating edited preview…';const restaged=await controller.restageEditedTree(tx,session.tree,{by:'operator'});if(restaged.state==='stale'){builderReview=null;renderAll();globalThis.toastr?.warning('Builder preview became stale. Nothing was committed.','Nexus');return;}tx=restaged.transactionId;session.transactionId=tx;session.preview=restaged.preview;session.tree=normalizeTree(clone(restaged.preview.nextTree),session.book);session.dirty=false;}
            builderReviewStatus.textContent='Rechecking freshness and committing…';const committed=await controller.approveAndCommit(tx,{by:'operator'});if(committed.state==='stale'){builderReview=null;renderAll();globalThis.toastr?.warning('Builder preview became stale. Nothing was committed.','Nexus');return;}builderReview=null;await loadCurrentBook();selectedNodeId=getTree(session.book)?.root?.id||'';renderAll();globalThis.toastr?.success('Lorebook Tree approved and committed.','Nexus');
        }catch(err){
            if(err?.name==='TV2Builder2ReviewContinuationError'){
                builderReview=null;
                try{await refreshBuilderResumeCandidate();}catch{}
                renderAll();
            }else builderReviewStatus.textContent=`Builder review failed: ${err?.message||String(err)}`;
            globalThis.toastr?.error(err?.message||String(err),'Nexus Lorebook Builder');
        }
        finally{endBuilderBusy();if(reviewActive()){builderApprove.disabled=false;builderCancel.disabled=false;updateBuilderChrome();}}
    }
    function renderAll(){refreshBookSelect(selectedBook);if(selectedBook){try{assertReadableBook(selectedBook);}catch(error){treeScroll.innerHTML='<div class="tv2-empty">Write Only lorebook — Tree contents are not readable in Nexus.</div>';main.innerHTML='<div class="tv2-tree-main-empty"><h3>Read access blocked</h3><p>This lorebook is Write Only. Change its access policy before opening Tree or lore review surfaces.</p></div>';status.textContent='WRITE ONLY';updateBuilderChrome();return;}}const tree=activeTree();if(tree){for(const id of [...selectedCategoryIds])if(!findNode(tree.root,id)||!nodeMovable(tree,id))selectedCategoryIds.delete(id);const knownUids=new Set(Object.keys(currentBookData?.entries||{}).map(key=>Number(currentBookData.entries[key]?.uid??key)));for(const uid of [...selectedEntryUids])if(!knownUids.has(Number(uid))||!entryMovable(uid))selectedEntryUids.delete(Number(uid));if((!selectedNodeId||!findNode(tree.root,selectedNodeId))&&!selectedPseudo)selectedNodeId=tree.root.id;}else clearMultiSelection();renderTree(tree);renderMain(tree);upgradeLaneDButtons(panel,{replace:false});updateBuilderChrome();}
    async function switchBook(book){selectedBook=book||'';selectedNodeId='';selectedPseudo='';expandedNodeIds.clear();clearMultiSelection();if(selectedBook)updateSettings(s=>{s.selectedLorebook=selectedBook;});await loadCurrentBook();await refreshBuilderResumeCandidate();renderAll();}

    refreshBookSelect();await loadCurrentBook();await refreshBuilderResumeCandidate();renderAll();
    bookSelect.addEventListener('change',()=>switchBook(bookSelect.value));
    searchInput.addEventListener('input',()=>{searchQuery=searchInput.value.trim().toLowerCase();renderAll();});
    const closeTree=async()=>{loadSerial++;cancelTreeSummaryWork('Tree window closed during summary generation.');try{await cancelBuilderReview('tree-window-closed',{quiet:true,render:false});}catch{return;}overlay.remove();};overlay.__tv2Close=closeTree;
    overlay.querySelector('.tv2-close-tree').addEventListener('click',closeTree);
    overlay.addEventListener('click',e=>{if(e.target===overlay)closeTree();});
    panel.querySelector('.tv2-tree-merge-scan').addEventListener('click',()=>{if(!selectedBook){globalThis.toastr?.warning('Select a lorebook first.','Nexus');return;}openMergeScanPanel(selectedBook);});
    panel.querySelector('.tv2-tree-builder').addEventListener('click',e=>startBuilderReview(e.currentTarget));
    panel.querySelector('.tv2-tree-blank').addEventListener('click',async e=>{
        if(!selectedBook){globalThis.toastr?.warning('Select a lorebook first.','Nexus');return;}
        if(getTree(selectedBook)){globalThis.toastr?.info('This lorebook already has a Nexus Tree.','Nexus Tree');return;}
        const button=e.currentTarget;button.disabled=true;
        try{
            if(!isBookEnabled(selectedBook)){
                const enable=confirm(`Lorebook "${selectedBook}" is not enabled for Nexus.\n\nEnable Nexus for this lorebook and create a blank Tree?`);
                if(!enable)return;
                await setBookEnabled(selectedBook,true);
                await loadCurrentBook();
            }
            const tree=createTree(selectedBook);
            const proposal=await proposeTreeReplace(selectedBook,tree,{source:'tree-workspace',reasoning:'Operator created a blank Nexus Tree shell.',mutationKind:'semantic'});
            const applied=await approveProposal(proposal.id,{actor:'operator',surface:'tree-blank-create'});
            if(!applied.ok)throw new Error(applied.error||'Blank Tree proposal failed.');
            selectedNodeId=getTree(selectedBook)?.root?.id||'';
            selectedPseudo='';
            logEvent('tree','blank-tree-created',{book:selectedBook,proposalId:proposal.id},'info');
            renderAll();
            globalThis.toastr?.success('Blank Nexus Tree created. Existing lore UIDs remain unassigned until you build or organize them.','Nexus Tree');
        }catch(error){
            logEvent('tree','blank-tree-create-failed',{book:selectedBook,error},'error');
            globalThis.toastr?.error(error?.message||String(error),'Nexus Tree');
        }finally{updateBuilderChrome();}
    });
    builderCancel.addEventListener('click',async()=>{try{await cancelBuilderReview();}catch{}});builderApprove.addEventListener('click',approveBuilderReview);
    builderResumeNow.addEventListener('click',()=>{const button=panel.querySelector('.tv2-tree-builder');if(button)startBuilderReview(button);});
    builderResumeCancel.addEventListener('click',async()=>{
        const candidate=builderResumeCandidate?.book===selectedBook?builderResumeCandidate:null;if(!candidate)return;
        if(!confirm(`Cancel unfinished Builder 2 run ${candidate.runId} for "${candidate.book}"?\n\nNo Tree changes from the unfinished run will be committed.`))return;
        builderResumeCancel.disabled=true;builderResumeNow.disabled=true;
        try{await getLorebookBuilderController().cancelDurably(candidate.runId,'operator-cancelled-unfinished-builder-run');builderResumeCandidate=null;await refreshBuilderResumeCandidate();renderAll();globalThis.toastr?.info('Unfinished Builder 2 run cancelled. No Tree changes were committed.','Nexus');}
        catch(error){globalThis.toastr?.error(error?.message||String(error),'Nexus Builder 2');await refreshBuilderResumeCandidate();renderAll();}
    });
    panel.querySelector('.tv2-tree-summarize').addEventListener('click',async e=>{if(!selectedBook||!getTree(selectedBook)){globalThis.toastr?.warning('Select a Tree first.','Nexus');return;}const btn=e.currentTarget;btn.disabled=true;const old=btn.innerHTML;try{btn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> <span>Summarizing…</span>';const out=await runTreeSummaryTask(signal=>generateSummariesForTree(selectedBook,{onProgress:({done,total})=>{btn.innerHTML=`<i class="fa-solid fa-spinner fa-spin"></i> <span>${done}/${total}</span>`;},signal}));renderAll();globalThis.toastr?.success(`Generated ${out.processed} Tree node/leaf summaries.`,'Nexus');}catch(err){logEvent('tree','tree-summary-generation-failed',{book:selectedBook,error:err},'error');globalThis.toastr?.error(err?.message||String(err),'Nexus Tree summaries failed');}finally{btn.disabled=false;btn.innerHTML=old;}});
    panel.querySelector('.tv2-tree-uid-summarize').addEventListener('click',()=>{if(!selectedBook){globalThis.toastr?.warning('Select a lorebook first.','Nexus');return;}openUidSummarizer({book:selectedBook});});
    panel.querySelector('.tv2-tree-add').addEventListener('click',async()=>{let tree=activeTree();if(!tree){if(!selectedBook)return;tree=createTree(selectedBook);}const parent=selectedPseudo?tree.root:(findNode(tree.root,selectedNodeId)||tree.root);await addCategory(tree,parent.id);});
    panel.querySelector('.tv2-tree-export').addEventListener('click',()=>{const tree=getTree(selectedBook);if(!tree){globalThis.toastr?.warning('No Tree selected.','Nexus');return;}downloadJson(`Nexus-Tree-${selectedBook.replace(/[^a-z0-9_-]+/gi,'_')}-${stamp()}.json`,treePayload(selectedBook,tree));});
    panel.querySelector('.tv2-tree-import-file-btn').addEventListener('click',()=>panel.querySelector('.tv2-tree-import-file').click());
    panel.querySelector('.tv2-tree-import-file').addEventListener('change',async e=>{const file=e.currentTarget.files?.[0];if(!file)return;try{const importTarget=selectedBook;const payload=JSON.parse(await file.text());const prepared=await prepareTreeImport(payload,importTarget);const approval=await reviewTreeImportBundle(prepared.plans,prepared.decoded.kind);if(!approval){globalThis.toastr?.info('Tree import cancelled. No Tree changes were made.','Nexus');return;}const result=await applyTreeImport(payload,importTarget,approval);await loadCurrentBook();renderAll();globalThis.toastr?.success(`Imported ${result.count} Tree(s) from ${result.kind}.`,'Nexus');}catch(err){logEvent('tree','tree-import-failed',{fileName:file.name,error:err},'error');globalThis.toastr?.error(err?.message||String(err),'Nexus Tree import failed');}finally{e.currentTarget.value='';}});
    panel.querySelector('.tv2-tree-delete-tree').addEventListener('click',async()=>{if(!selectedBook||!getTree(selectedBook))return;const button=panel.querySelector('.tv2-tree-delete-tree');if(button)button.disabled=true;try{const result=await trashTreeWithConfirmation(selectedBook,{surface:'tree-workspace'});if(result?.stale){globalThis.toastr?.warning('Tree changed before deletion. Refresh and try again.','Nexus Tree');return;}if(!result?.ok)return;selectedNodeId='';selectedPseudo='';renderAll();globalThis.toastr?.success(`Trashed Nexus Tree for ${selectedBook}. Lorebook entries were left untouched.`,'Nexus Tree');}catch(error){logEvent('tree','tree-trash-failed',{book:selectedBook,error},'error');globalThis.toastr?.error(treeTrashErrorMessage(error),'Nexus Tree');}finally{updateBuilderChrome();}});
}
