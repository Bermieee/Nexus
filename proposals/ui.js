import { getProposalById, getProposalPage, getProposals, rejectProposal, clearResolved, getProposalChangeEventName, updateProposal, getProposalRecoveryPage, reconcileProposal } from './store.js';
import { approveProposal, restoreProposalPreMutationState } from './executor.js';
import { loadBook, findEntryByUid, clone } from '../lore/store.js';
import { getTree } from '../tree/store.js';
import { currentNodeForUid } from '../tree/ops.js';
import { rankProposalTargets } from '../tools/merge-similarity.js';
import { makeDraggableWindow } from '../windowing.js';
import { acknowledgePendingProposals, getProposalAttentionChangeEventName } from './attention.js';
import { bindSidecarStatus } from '../observability/sidecar-status.js';
import { PROPOSAL_REVIEW_TRIAGE_SITE_ID } from './decision-site.js';
import { startDecisionSiteThroughDirector } from '../decision/work-director-bridge.js';

function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function titleOf(expected,fallback='Untitled'){return String(expected?.comment||fallback||'Untitled').trim()||'Untitled';}
function kind(op){const map={'entry.create':'CREATE','entry.update':'UPDATE','entry.delete':'DELETE','entry.merge':'MERGE','entry.split':'SPLIT','entry.move':'MOVE','tree.node.create':'NEW CATEGORY','tree.node.rename':'RENAME CATEGORY','tree.node.move':'MOVE CATEGORY','tree.node.delete':'DELETE CATEGORY','tree.entry.assign':'ASSIGN','tree.entry.unassign':'UNASSIGN','tree.replace':'REPLACE TREE'};return map[op?.type]||String(op?.type||'PROPOSAL').toUpperCase();}
function operationClass(op){return String(op?.type||'proposal').split('.')[1]||'proposal';}
function operationLabel(op){const area=String(op?.type||'proposal').startsWith('entry.')?'LORE ENTRY':String(op?.type||'').startsWith('tree.')?'TREE':'OPERATION';return `${kind(op)} · ${area}`;}
function headline(op){
    switch(op?.type){
        case'entry.create':return `New entry — ${op.title||'Untitled'}`;
        case'entry.update':return `UID ${op.uid} — ${titleOf(op.expected)}`;
        case'entry.delete':return `${op.hardDelete?'Delete':'Disable'} UID ${op.uid} — ${titleOf(op.expected)}`;
        case'entry.merge':return `UID ${op.removeUid} → UID ${op.keepUid}`;
        case'entry.split':return `Split UID ${op.uid} — ${titleOf(op.expected)}`;
        case'entry.move':return `Move UID ${op.uid} — ${titleOf(op.expected)}`;
        case'tree.node.create':return `New category — ${op.label||'Unnamed'}`;
        case'tree.node.rename':return `Rename category — ${op.label||op.nodeId}`;
        default:return kind(op);
    }
}
function field(label,value,cls=''){if(value===undefined||value===null||value==='')return'';return `<section class="tv2-proposal-field ${cls}"><div class="tv2-proposal-field-label">${esc(label)}</div><div class="tv2-proposal-field-value">${esc(value)}</div></section>`;}
function treeEffectSummary(tree){
    if(!tree?.root)return 'Replacement Tree payload';
    let nodes=0,assigned=0;const walk=node=>{if(!node)return;nodes++;assigned+=(node.entryUids||[]).length;for(const child of node.children||[])walk(child);};walk(tree.root);
    return `${nodes} node${nodes===1?'':'s'} · ${assigned} UID assignment${assigned===1?'':'s'}`;
}
function operationBody(op){
    if(!op)return'';
    switch(op.type){
        case'entry.create':return `${field('Lorebook',op.book)}${field('New lore content',op.content,'content')}${field('Activation keywords',(op.keys||[]).join(', ')||'(none)')}${field('Tree destination',op.targetNodeId||'Root')}`;
        case'entry.update':{
            const patch=op.patch||{};let html=field('Lorebook',op.book)+field('Entry',`UID ${op.uid} — ${titleOf(op.expected)}`);
            if(patch.title!==undefined)html+=field('New title',patch.title);
            if(patch.content!==undefined)html+=field('Content after approval',patch.content,'content');
            if(patch.keys!==undefined)html+=field('Activation keywords',(patch.keys||[]).join(', ')||'(none)');
            if(patch.constant!==undefined)html+=field('Constant',patch.constant?'Yes':'No');
            if(patch.disable!==undefined)html+=field('Disabled',patch.disable?'Yes':'No');
            if(op.targetNodeId!==undefined)html+=field('Tree placement',`${op.expectedNodeId||'Unassigned'} → ${op.targetNodeId||'Unassigned'}`);
            return html||field('Change','Metadata-only update');
        }
        case'entry.delete':return `${field('Lorebook',op.book)}${field('Entry',`UID ${op.uid} — ${titleOf(op.expected)}`)}${field('Action',op.hardDelete?'Hard delete':'Disable')}${field('Reason',op.reason)}`;
        case'entry.merge':return `${field('Lorebook',op.book)}${field('Keep',`UID ${op.keepUid} — ${titleOf(op.expectedKeep)}`)}${field('Merge into it',`UID ${op.removeUid} — ${titleOf(op.expectedRemove)}`)}${op.content?field('Merged content',op.content,'content'):field('Merged content','Existing contents will be combined deterministically.')}${field('Tree policy',op.treePolicy||'keep')}`;
        case'entry.split':return `${field('Lorebook',op.book)}${field('Original',`UID ${op.uid} — ${titleOf(op.expected)}`)}${field('New entry',op.newTitle||'Untitled')}${field('New entry content',op.newContent,'content')}${field('New Tree destination',op.newTargetNodeId||op.expectedNodeId||'Unassigned')}`;
        case'entry.move':return `${field('Lorebook',op.book)}${field('Entry',`UID ${op.uid} — ${titleOf(op.expected)}`)}${field('Tree placement',`${op.expectedNodeId||'Unassigned'} → ${op.targetNodeId||'Unassigned'}`)}`;
        case'tree.node.create':return `${field('Lorebook',op.book)}${field('Category',op.label)}${field('Parent category ID',op.parentNodeId||'Root')}${field('Summary',op.summary,'content')}`;
        case'tree.node.rename':return `${field('Lorebook',op.book)}${field('Category ID',op.nodeId)}${field('New label',op.label)}${field('Summary',op.summary,'content')}`;
        case'tree.node.move':return `${field('Lorebook',op.book)}${field('Category ID',op.nodeId)}${field('Move under',op.newParentNodeId||'Root')}`;
        case'tree.node.delete':return `${field('Lorebook',op.book)}${field('Category ID',op.nodeId)}${field('Delete policy',op.mode||'promote_children')}${field('Effect','Category topology will change; child/UID handling follows the displayed delete policy.')}`;
        case'tree.entry.assign':return `${field('Lorebook',op.book)}${field('UID',op.uid)}${field('Assign to category ID',op.nodeId)}`;
        case'tree.entry.unassign':return `${field('Lorebook',op.book)}${field('UID',op.uid)}${field('Effect','Remove this UID from its current Tree category.')}`;
        case'tree.replace':return `${field('Lorebook',op.book)}${field('Effect','Replace the complete Tree topology for this lorebook.')}${field('Replacement summary',treeEffectSummary(op.tree))}${field('Mutation kind',op.mutationKind||'semantic')}`;
        case'tree.delete':return `${field('Lorebook',op.book)}${field('Effect','Delete the complete Nexus Tree for this lorebook. Lore entries themselves are not represented as deleted by this operation.')}`;
        case'scene.archive':return `${field('Lorebook',op.book)}${field('Scene',op.sceneId||op.id||'current/declared scene')}${field('Effect','Archive the declared scene state.')}`;
        case'metadata.set':return `${field('Chat',op.chatId||'current')}${field('Metadata key',op.key)}${field('Action',op.delete?'Delete metadata key':'Replace metadata value')}${op.delete?'':field('Value after approval',JSON.stringify(op.value??null,null,2),'content')}`;
        default:return `${field('Operation',kind(op))}${field('Lorebook',op.book)}`;
    }
}

function routeMaterial(op){
    if(!op)return null;
    if(op.type==='entry.create')return{title:op.title||'Untitled',content:String(op.content||''),nodeId:op.targetNodeId||null};
    if(op.type==='entry.update'&&op.patch?.content!==undefined)return{title:op.patch?.title||titleOf(op.expected),content:String(op.patch.content||''),nodeId:op.targetNodeId||op.expectedNodeId||null};
    if(op.type==='entry.split'&&op.newContent)return{title:op.newTitle||'Split entry',content:String(op.newContent||''),nodeId:op.newTargetNodeId||op.expectedNodeId||null};
    return null;
}
function routePanel(p){
    if(!routeMaterial(p?.op))return'';
    return `<details class="tv2-proposal-merge-route"><summary><i class="fa-solid fa-code-merge"></i> Merge / route into existing UID</summary><div class="tv2-proposal-route-body"><div class="tv2-proposal-route-controls"><label>Target UID <input class="text_pole tv2-proposal-route-uid" type="number" min="0" placeholder="UID"></label><button class="menu_button" data-action="route-manual" type="button">Merge Into UID</button><button class="menu_button" data-action="scan-targets" type="button">Scan likely UIDs</button></div><div class="tv2-proposal-route-note">Routing converts this staged content into a baseline-protected UPDATE of the destination UID. The destination keeps its existing activation keywords.</div><div class="tv2-proposal-targets"></div></div></details>`;
}
function baseline(entry,uid){return clone({uid:Number(uid),content:entry?.content||'',comment:entry?.comment||'',key:Array.isArray(entry?.key)?entry.key:[],disable:entry?.disable===true,constant:entry?.constant===true});}
async function findProposalTargets(proposal){
    const material=routeMaterial(proposal?.op);if(!material)throw new Error('This proposal has no routable lore content.');
    const book=proposal.op.book;if(!book)throw new Error('Proposal has no lorebook.');
    const data=await loadBook(book),tree=getTree(book);
    const sourceUid=['entry.update','entry.split'].includes(proposal.op.type)?Number(proposal.op.uid):null;
    const entries=Object.values(data?.entries||{}).filter(entry=>!Number.isFinite(sourceUid)||Number(entry?.uid)!==sourceUid);
    const nodeForUid=uid=>currentNodeForUid(tree,uid)?.id||null;
    return rankProposalTargets(material,{entries,thresholdPercent:16,limit:6,nodeForUid,proposedNodeId:material.nodeId});
}
async function routeProposalIntoUid(proposal,targetUid){
    const material=routeMaterial(proposal?.op);if(!material)throw new Error('This proposal has no routable lore content.');
    const uid=Number(targetUid);if(!Number.isFinite(uid))throw new Error('Enter a valid destination UID.');
    const sourceUid=['entry.update','entry.split'].includes(proposal.op.type)?Number(proposal.op.uid):null;
    if(Number.isFinite(sourceUid)&&uid===sourceUid)throw new Error(`This proposal already targets UID ${sourceUid}. Choose a different UID to merge into.`);
    const book=proposal.op.book,data=await loadBook(book),target=findEntryByUid(data.entries,uid);
    if(!target)throw new Error(`UID ${uid} was not found in "${book}".`);
    if(target.disable===true)throw new Error(`UID ${uid} is disabled.`);
    const incoming=String(material.content||'').trim();if(!incoming)throw new Error('The staged proposal content is empty.');
    const existing=String(target.content||'').trim();
    const merged=!existing?incoming:existing.includes(incoming)?existing:`${existing}\n\n${incoming}`;
    const tree=getTree(book),expectedNodeId=currentNodeForUid(tree,uid)?.id||null;
    const routed={type:'entry.update',book,uid,patch:{content:merged},expected:baseline(target,uid),expectedNodeId};
    await updateProposal(proposal.id,{op:routed,reasoning:`${proposal.reasoning||''}${proposal.reasoning?'\n\n':''}Operator routed the staged lore material into existing UID ${uid}; destination keywords are preserved.`});
    return {uid,title:target.comment||target.key?.[0]||`UID ${uid}`};
}

function card(p){
    const reason=p.reasoning?`<details class="tv2-proposal-reason"><summary><span class="tv2-proposal-field-label">Why this was proposed</span></summary><div class="tv2-proposal-reason-body">${esc(p.reasoning)}</div></details>`:'';
    const source=p.sourceExcerpt?`<details class="tv2-proposal-source"><summary>Source context</summary><div>${esc(p.sourceExcerpt)}</div></details>`:'';
    return `<details class="tv2-proposal-card tv2-proposal-disclosure" data-id="${esc(p.id)}">
      <summary class="tv2-proposal-summary"><i class="fa-solid fa-chevron-right tv2-proposal-disclosure-icon" aria-hidden="true"></i><div class="tv2-proposal-card-head"><div class="tv2-proposal-title-wrap"><span class="tv2-proposal-kind tv2-proposal-kind-${esc(operationClass(p.op))}">${esc(operationLabel(p.op))}</span><h4>${esc(headline(p.op))}</h4></div><div class="tv2-proposal-time">${esc(new Date(p.createdAt).toLocaleString())}</div></div></summary>
      <div class="tv2-proposal-card-body">
        <div class="tv2-proposal-change">${operationBody(p.op)}</div>
        ${reason}${source}${routePanel(p)}
        <div class="tv2-proposal-actions"><button class="menu_button tv2-proposal-approve" data-action="approve" type="button">Approve</button><button class="menu_button tv2-proposal-reject" data-action="reject" type="button">Reject</button></div>
      </div>
    </details>`;
}
function recoveryCard(p){
    const recoverable=String(p.status||'')==='recovery-required';
    const actions=recoverable?`${p.recovery?'<button class="menu_button" data-action="recover-restore" type="button">Restore Pre-Mutation</button>':''}<button class="menu_button" data-action="recover-applied" type="button">Confirm Applied</button><button class="menu_button" data-action="recover-not-applied" type="button">Confirm Not Applied</button><button class="menu_button" data-action="recover-abandon" type="button">Abandon</button>`:'<span class="tv2-meta">A save is still in progress. Recovery actions appear only if intervention is needed.</span>';
    return `<article class="tv2-proposal-card tv2-proposal-recovery" data-id="${esc(p.id)}">
      <div class="tv2-proposal-card-head"><div class="tv2-proposal-title-wrap"><span class="tv2-proposal-kind">RECOVERY · ${esc(String(p.status||'unknown').toUpperCase())}</span><h4>${esc(headline(p.op))}</h4></div><div class="tv2-proposal-time">${esc(new Date(p.updatedAt||p.createdAt).toLocaleString())}</div></div>
      <div class="tv2-proposal-change">${operationBody(p.op)}</div>
      ${p.error?`<details class="tv2-proposal-reason"><summary><span class="tv2-proposal-field-label">Why recovery is required</span></summary><div class="tv2-proposal-reason-body">${esc(p.error)}</div></details>`:''}
      <div class="tv2-proposal-actions">${actions}</div>
    </article>`;
}
export function openProposalPanel(){
    const prior=document.getElementById('tv2-proposal-overlay');if(prior){if(typeof prior.__tv2Close==='function')prior.__tv2Close();else prior.remove();}
    const overlay=document.createElement('div');overlay.id='tv2-proposal-overlay';overlay.className='tv2-overlay';
    const panel=document.createElement('div');panel.className='tv2-proposal-panel';overlay.appendChild(panel);document.body.appendChild(overlay);
    const pageSize=250;let pendingOffset=0,recoveryOffset=0;let dragCleanup=null,bulkRunning=false;
    const initialPendingPage=()=>getProposalPage('pending',{limit:250});
    const pendingForDecision=getProposals('pending');
    acknowledgePendingProposals(pendingForDecision);
    if(pendingForDecision.length){try{const proposalFingerprint=rows=>JSON.stringify((rows||[]).slice(0,8).map(row=>[String(row.id||''),Number(row.revision)||0,String(row.status||''),String(row.op?.type||'')]));const handle=startDecisionSiteThroughDirector(PROPOSAL_REVIEW_TRIAGE_SITE_ID,{proposals:pendingForDecision.slice(0,8),scope:{surface:'lore-proposals'},sourceFingerprint:proposalFingerprint(pendingForDecision),getCurrentFingerprint:()=>proposalFingerprint(getProposals('pending'))},{source:'proposal-review-triage-shadow',mode:'shadow'});handle?.promise?.catch?.(()=>{});}catch{}}
    const pager=(name,page,offset)=>{if(page.total<=pageSize)return'';const start=page.total?offset+1:0,end=Math.min(page.total,offset+page.rows.length);return `<div class="tv2-proposal-pager"><span>${esc(name)} ${start}–${end} of ${page.total}</span><button class="menu_button" data-action="page-${name.toLowerCase()}-prev" type="button" ${offset<=0?'disabled':''}>Previous</button><button class="menu_button" data-action="page-${name.toLowerCase()}-next" type="button" ${offset+pageSize>=page.total?'disabled':''}>Next</button></div>`;};
    const render=()=>{
        let pendingPage=pendingOffset===0?initialPendingPage():getProposalPage('pending',{offset:pendingOffset,limit:pageSize}),recoveryPage=getProposalRecoveryPage({offset:recoveryOffset,limit:pageSize});
        if(pendingOffset>0&&!pendingPage.rows.length){pendingOffset=Math.max(0,pendingOffset-pageSize);pendingPage=getProposalPage('pending',{offset:pendingOffset,limit:pageSize});}
        if(recoveryOffset>0&&!recoveryPage.rows.length){recoveryOffset=Math.max(0,recoveryOffset-pageSize);recoveryPage=getProposalRecoveryPage({offset:recoveryOffset,limit:pageSize});}
        const pending=pendingPage.rows,recovery=recoveryPage.rows;
        panel.innerHTML=`<div class="tv2-panel-head"><div><h3>Nexus Lore Proposals <span class="tv2-panel-count">${pendingPage.total}${recoveryPage.total?` + ${recoveryPage.total} recovery`:''}</span></h3></div><div class="tv2-shared-sidecar-status" aria-label="Main and Sidecar runtime status"></div><div class="tv2-panel-actions">${pendingPage.total?`<button class="menu_button tv2-proposal-approve-all" data-action="approve-all" type="button" ${bulkRunning?'disabled':''}>Approve All (${pendingPage.total})</button><button class="menu_button tv2-proposal-reject-all" data-action="reject-all" type="button" ${bulkRunning?'disabled':''}>Reject All (${pendingPage.total})</button>`:''}<button class="menu_button" data-action="clear" type="button" ${bulkRunning?'disabled':''}>Clear resolved</button><button class="menu_button" data-action="close" type="button">Close</button></div></div>${bulkRunning?'<div class="tv2-status-strip warn">Bulk proposal action is running. Each proposal is validated independently.</div>':''}${recovery.length?`<div class="tv2-proposal-list"><div class="tv2-meta"><b>Recovery required</b> — review the current lore/Tree state before choosing an action.</div>${pager('Recovery',recoveryPage,recoveryOffset)}${recovery.map(recoveryCard).join('')}${pager('Recovery',recoveryPage,recoveryOffset)}</div>`:''}<div class="tv2-proposal-list">${pager('Pending',pendingPage,pendingOffset)}${pending.length?pending.map(card).join(''):'<div class="tv2-empty tv2-proposal-empty"><b>No pending Lore Proposals on this page.</b><span>New proposals will appear here and the launcher will show their count.</span></div>'}${pager('Pending',pendingPage,pendingOffset)}</div>`;
        dragCleanup?.();dragCleanup=makeDraggableWindow(panel,{handle:panel.querySelector('.tv2-panel-head'),storageKey:'lore-proposals'});
        bindSidecarStatus(panel.querySelector('.tv2-shared-sidecar-status'),{includeQueue:false,includeMain:true});
    };
    const close=()=>{window.removeEventListener(getProposalChangeEventName(),render);dragCleanup?.();overlay.remove();};overlay.__tv2Close=close;
    panel.addEventListener('click',async e=>{const btn=e.target.closest('button');if(!btn)return;const action=btn.dataset.action;
        if(action==='close'){close();return;}
        if(action==='page-pending-prev'){pendingOffset=Math.max(0,pendingOffset-pageSize);render();return;}
        if(action==='page-pending-next'){pendingOffset+=pageSize;render();return;}
        if(action==='page-recovery-prev'){recoveryOffset=Math.max(0,recoveryOffset-pageSize);render();return;}
        if(action==='page-recovery-next'){recoveryOffset+=pageSize;render();return;}
        if(action==='clear'){if(globalThis.confirm?.('Clear resolved Proposal rows from the hot review list? Durable receipt/audit history remains subject to the Proposal store retention policy, but these resolved rows will no longer be visible here.')===false)return;await clearResolved();render();return;}
        if(action==='approve-all'||action==='reject-all'){
            const rows=getProposals('pending');if(!rows.length){render();return;}
            const approving=action==='approve-all';
            const verb=approving?'Approve':'Reject';
            const detail=approving
                ?`Approve all ${rows.length} currently pending Lore Proposals? Each proposal is validated independently; stale or failed items remain unresolved.`
                :`Reject all ${rows.length} currently pending Lore Proposals? This affects pending proposals only; committing/recovery-required rows are not touched.`;
            if(globalThis.confirm?.(detail)===false)return;
            bulkRunning=true;render();
            let succeeded=0;const failures=[];
            try{
                for(const row of rows){
                    const current=getProposalById(row.id);if(!current||current.status!=='pending')continue;
                    try{
                        if(approving){
                            const result=await approveProposal(current.id,{actor:'operator',surface:'lore-proposals-bulk'});
                            if(!result?.ok){const error=new Error(result?.error||'Proposal did not commit.');error.name=result?.stale?'TV2MutationStale':'TV2ProposalApprovalFailed';throw error;}
                        }else await rejectProposal(current.id,'Bulk rejected by operator from Lore Proposals.');
                        succeeded++;
                    }catch(error){failures.push({id:current.id,message:error?.message||String(error)});}
                }
                if(failures.length){
                    const sample=failures.slice(0,3).map(row=>`${row.id}: ${row.message}`).join(' | ');
                    globalThis.toastr?.warning(`${verb} All completed ${succeeded}/${rows.length}. ${failures.length} proposal(s) remained unresolved. ${sample}`,'Nexus Lore Proposals',{timeOut:7000});
                }else globalThis.toastr?.success(`${verb} All completed for ${succeeded} proposal${succeeded===1?'':'s'}.`,'Nexus Lore Proposals');
            }finally{bulkRunning=false;render();}
            return;
        }
        const el=btn.closest('[data-id]');if(!el)return;
        if(action?.startsWith('recover-')){
            const id=el.dataset.id;
            const prompts={
                'recover-restore':`Restore Proposal ${id} to the state from before this change? This will modify lore/Tree data.`,
                'recover-applied':`Confirm Proposal ${id} was applied? Nexus will verify the saved result before finishing recovery.`,
                'recover-not-applied':`Confirm Proposal ${id} was not applied? Nexus will verify the original state before allowing a retry.`,
                'recover-abandon':`Abandon recovery for Proposal ${id}? Use this only when the saved state has been checked manually.`,
            };
            if(globalThis.confirm?.(prompts[action]||`Apply recovery disposition to Proposal ${id}?`)===false)return;
            btn.disabled=true;try{if(action==='recover-restore'){await restoreProposalPreMutationState(id,{actor:'operator-recovery',surface:'lore-proposals-recovery'});globalThis.toastr?.success('Previous lore/Tree state restored.','Nexus');}else{const disposition=action==='recover-applied'?'confirmed-applied':action==='recover-not-applied'?'confirmed-not-applied':'abandoned';await reconcileProposal(id,{disposition,note:'Operator reconciled from Nexus Lore Proposals recovery surface after explicit confirmation.'});globalThis.toastr?.success(`Proposal recovery marked ${disposition.replaceAll('-',' ')}.`,'Nexus');}}catch(err){globalThis.toastr?.error(err?.message||String(err),'Nexus proposal recovery');}finally{render();}return;
        }
        const proposal=getProposalById(el.dataset.id);if(!proposal||proposal.status!=='pending')return;
        if(action==='scan-targets'){btn.disabled=true;const host=el.querySelector('.tv2-proposal-targets');if(host)host.innerHTML='<div class="tv2-empty">Scanning existing UIDs…</div>';try{const rows=await findProposalTargets(proposal);if(host)host.innerHTML=rows.length?rows.map(r=>`<div class="tv2-proposal-target-row"><div class="tv2-proposal-target-score">${r.percent}%</div><div><b>UID ${r.uid} — ${esc(r.title||'Untitled')}</b><small>title ${r.titlePercent}% · content ${r.contentPercent}%</small></div><button class="menu_button" data-action="route-target" data-target-uid="${r.uid}" type="button">Merge Here</button></div>`).join(''):'<div class="tv2-empty">No plausible UID matches found.</div>';}catch(err){if(host)host.innerHTML=`<div class="tv2-empty">${esc(err?.message||String(err))}</div>`;}finally{btn.disabled=false;}return;}
        if(action==='route-manual'||action==='route-target'){const uid=action==='route-target'?btn.dataset.targetUid:el.querySelector('.tv2-proposal-route-uid')?.value;btn.disabled=true;try{const out=await routeProposalIntoUid(proposal,uid);globalThis.toastr?.success(`Proposal routed into UID ${out.uid} — ${out.title}. Review the merged body before approval.`,'Nexus');render();}catch(err){globalThis.toastr?.error(err?.message||String(err),'Nexus proposal routing failed');btn.disabled=false;}return;}
        btn.disabled=true;try{if(action==='approve'){const result=await approveProposal(el.dataset.id,{actor:'operator',surface:'lore-proposals'});if(!result?.ok){const error=new Error(result?.error||'Proposal did not commit.');error.name=result?.stale?'TV2MutationStale':'TV2ProposalApprovalFailed';throw error;}}if(action==='reject')await rejectProposal(el.dataset.id);}catch(err){globalThis.toastr?.error(err?.message||String(err),'Nexus proposal action failed');}finally{render();}
    });
    overlay.addEventListener('click',e=>{if(e.target===overlay)close();});window.addEventListener(getProposalChangeEventName(),render);render();
}
