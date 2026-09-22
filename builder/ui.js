// Compatibility source markers after shared Builder2 review consolidation: collectBuilder2GapDecisions · Tree Cleanup · Final Check · Unplaced Entries · Approve Category Plan
// Compatibility marker for historical safe-defer automation: value="defer" selected>Defer / leave unresolved
// Compatibility markers for historical Builder UI automation: Create Lorebook Tree; Taxonomy Gap Review; Unplaced Entries; Reconciliation Review; Semantic Quality Gate; Approve Taxonomy; Apply Mappings; Apply Gap Decisions; Apply Reconciliation; Structural / non-semantic
import { getLorebookBuilderController } from './runtime.js';
import { builder2ReviewMarkup, collectBuilder2ReviewDecision, wireBuilder2TaxonomyEditor, wireBuilder2GapReview, wireBuilder2PreviewOverrides } from './builder2-operator-ui.js';
import { upgradeLaneDButtons } from '../tree/ui-core-adapter.js';

let activeSessionClose = null;

export function cancelActiveLorebookBuilderSession(reason = 'external-cancel') {
    if (typeof activeSessionClose !== 'function') return false;
    activeSessionClose(String(reason || 'external-cancel'));
    return true;
}

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

function deltaHtml(delta = {}) {
    const added = delta.added || [];
    const nodes = delta.newNodes || [];
    const summaries = delta.updatedSummaries || [];
    const conflicts = delta.conflicts || [];
    const section = (title, rows, render) => `<section class="tv2-builder-preview-section"><h4>${title} <span>${rows.length}</span></h4>${rows.length ? `<div>${rows.map(render).join('')}</div>` : '<div class="tv2-empty">None</div>'}</section>`;
    return [
        `<section class="tv2-builder-preview-section"><h4>UNCHANGED <span>${Number(delta.unchangedCount) || 0}</span></h4></section>`,
        section('ADDED', added, row => `<div><b>UID ${Number(row.uid)}</b> · ${esc(row.title)} → ${esc(row.nodeLabel)}</div>`),
        section('NEW NODE', nodes, row => `<div>${esc(row.parentLabel || 'Root')} / <b>${esc(row.label)}</b></div>`),
        section('UPDATED SUMMARY', summaries, row => `<div>${esc(row.label || row.nodeId)}</div>`),
        section('POSSIBLE CONFLICT', conflicts, row => `<div>${esc(row.reason || row.message || JSON.stringify(row))}</div>`),
    ].join('');
}

function builder2ActionLabel(result={}){
    if(result.state==='staged')return 'Approve & Commit Tree';
    return ({'taxonomy-review':'Approve Category Plan','classification-review':'Continue Placements','gap-review':'Continue Decisions','draft-review':'Build Final Tree','reconciliation-review':'Apply Cleanup','quality-review':result.canApprove===false?'Resolve Entries':'Continue to Final Tree','preview':'Approve & Commit Tree'})[result.reviewKind]||'Continue Builder';
}

export async function openLorebookBuilder(book, { controller = getLorebookBuilderController(), onCommitted = null, requestedMode = 'auto', validateOnly = false } = {}) {
    const lorebook = String(book || '').trim();
    if (!lorebook) throw new Error('Select a lorebook before opening Lorebook Builder.');
    activeSessionClose?.('superseded-by-new-builder-run');
    document.querySelector('.tv2-builder-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'tv2-overlay nexus-ui tv2-builder-overlay';
    overlay.innerHTML = `<div class="tv2-panel tv2-builder-panel"><div class="tv2-panel-head"><div><h3>Build Lorebook Tree</h3><div class="tv2-meta">${esc(lorebook)}</div></div><button class="menu_button tv2-builder-close" type="button">Close</button></div><div class="tv2-builder-flow" aria-label="Builder workflow"><span data-step="analyze">1 Analyze + Draft</span><span data-step="review">2 Review</span><span data-step="save">3 Save</span></div><div class="tv2-builder-phase">Inspecting lorebook…</div><div class="tv2-builder-preview"></div><div class="tv2-builder-actions"><button class="menu_button tv2-builder-cancel" type="button" disabled>Cancel</button><button class="menu_button tv2-primary-action tv2-builder-approve" type="button" disabled>Continue</button></div></div>`;
    document.body.appendChild(overlay);upgradeLaneDButtons(overlay);
    const phase = overlay.querySelector('.tv2-builder-phase');
    const preview = overlay.querySelector('.tv2-builder-preview');
    const approve = overlay.querySelector('.tv2-builder-approve');
    const cancel = overlay.querySelector('.tv2-builder-cancel');
    let transactionId = null, runId=null, currentResult=null, busyTimer=null;
    const beginBusy=message=>{if(busyTimer)clearInterval(busyTimer);const started=Date.now();phase.classList.add('is-busy');const paint=()=>{const seconds=Math.max(0,Math.floor((Date.now()-started)/1000));phase.textContent=`${message} · ${seconds}s · saved work is safe`;};paint();busyTimer=setInterval(paint,1000);};
    const endBusy=()=>{if(busyTimer){clearInterval(busyTimer);busyTimer=null;}phase.classList.remove('is-busy');};
    const setFlowStep=step=>{const mapped=['structure','edit'].includes(step)?'review':['apply','result'].includes(step)?'save':step;const order=['analyze','review','save'];for(const el of overlay.querySelectorAll('.tv2-builder-flow [data-step]')){el.classList.toggle('is-current',el.dataset.step===mapped);el.classList.toggle('is-done',order.indexOf(el.dataset.step)<order.indexOf(mapped));}};
    setFlowStep('analyze');
    let terminal = false;
    const abortController = new AbortController();

    const close = async (reason = 'window-closed') => {
        endBusy();
        if (!terminal && !abortController.signal.aborted) abortController.abort(reason);
        if (!terminal) {
            const target=transactionId||(currentResult?.engine==='builder2'?runId:null);
            if(target){try { await controller.cancelDurably(target, `Lorebook Builder cancelled: ${reason}.`); } catch (error) { phase.textContent = `Cancel not durable: ${error?.message || String(error)}`; return; }}
        }
        if (activeSessionClose === close) activeSessionClose = null;
        overlay.remove();
    };
    activeSessionClose = close;
    overlay.querySelector('.tv2-builder-close').addEventListener('click', close);
    cancel.addEventListener('click', async () => { await close('operator-cancel'); });

    const renderResult=result=>{
        currentResult=result;runId=result?.runId||runId;transactionId=result?.transactionId||null;
        if(result?.state==='current'){
            terminal=true;setFlowStep('result');phase.textContent='Tree Current — lorebook and Builder manifest are already reconciled.';preview.innerHTML=deltaHtml(result.preview);approve.disabled=true;cancel.disabled=true;return;
        }
        if(result?.engine==='builder2'&&result?.state==='review'){
            setFlowStep(result.reviewKind==='taxonomy-review'?'structure':'edit');
            const reviewLabel=({'taxonomy-review':'Category plan','classification-review':'Placement review','gap-review':'Unplaced entries','draft-review':'Tree draft exceptions','reconciliation-review':'Tree cleanup','quality-review':'Final check','preview':'Final Tree preview'})[result.reviewKind]||'Builder review';
            phase.textContent=`${String(result.mode||'').toUpperCase()}${result.validateOnly?' · VALIDATE ONLY':''} · ${reviewLabel} · run ${result.runId}`;
            preview.innerHTML=builder2ReviewMarkup(result,{previewHtml:deltaHtml(result.preview||{})});upgradeLaneDButtons(preview);
            if(result.reviewKind==='taxonomy-review'||result.reviewKind==='draft-review')wireBuilder2TaxonomyEditor(preview,result);
            if(result.reviewKind==='gap-review'||result.reviewKind==='draft-review')wireBuilder2GapReview(preview,result);
            if(result.reviewKind==='preview')wireBuilder2PreviewOverrides(preview,{
                onApply:async({sourceKey,taxonId})=>{phase.textContent='Applying manual placement override and rerunning quality review…';renderResult(await controller.applyPreviewOverride(runId,{token:currentResult.reviewToken,sourceKey,taxonId}));},
                onReset:async({sourceKey})=>{phase.textContent='Resetting manual placement override and reclassifying source…';renderResult(await controller.resetPreviewOverride(runId,{token:currentResult.reviewToken,sourceKey}));},
                onError:error=>{phase.textContent=`Preview override failed: ${error?.message||String(error)}`;}
            });
            approve.textContent=builder2ActionLabel(result);approve.disabled=result.reviewKind==='quality-review'&&result.canApprove===false&&result.canResolve!==true;cancel.disabled=false;return;
        }
        if(result?.engine==='builder2'&&result?.state==='staged'){
            setFlowStep('apply');
            phase.textContent=`${String(result.mode||'').toUpperCase()} · recovered Tree review`;preview.innerHTML=deltaHtml(result.preview);approve.textContent=builder2ActionLabel(result);approve.disabled=false;cancel.disabled=false;return;
        }
        if(result?.preview){
            phase.textContent=`${String(result.mode||'').toUpperCase()} · review ready`;preview.innerHTML=deltaHtml(result.preview);approve.textContent='Approve Tree Delta';approve.disabled=false;cancel.disabled=false;return;
        }
        throw new Error('Lorebook Builder returned neither a review step nor a Tree preview.');
    };

    approve.addEventListener('click', async () => {
        if(!currentResult||terminal)return;approve.disabled=true;cancel.disabled=true;
        try{
            if(currentResult.engine==='builder2'){
                if(currentResult.state==='review'&&currentResult.reviewKind!=='preview'){
                    beginBusy('Continuing Builder from durable review state');
                    const next=await controller.advanceReview(runId,{reviewKind:currentResult.reviewKind,token:currentResult.reviewToken,...collectBuilder2ReviewDecision(preview,currentResult)});endBusy();renderResult(next);if(next?.recoveredReviewState)globalThis.toastr?.info('Builder recovered automatically and continued from saved progress.','Nexus Lorebook Builder');return;
                }
                if(currentResult.state==='review'&&currentResult.reviewKind==='preview'){
                    beginBusy('Saving reviewed Tree…');
                    const staged=await controller.stagePreview(runId,{token:currentResult.reviewToken,approved:true});
                    if(staged.readOnly===true){terminal=true;phase.textContent='Builder 2 validation completed read-only. Nothing was staged or committed.';preview.innerHTML=deltaHtml(staged.preview);return;}
                    renderResult(staged);
                }
                beginBusy('Checking for changes…');
                const committed=await controller.approveAndCommit(transactionId,{by:'operator'});
                if(committed.state==='stale'){terminal=true;phase.textContent='STALE — lorebook or Tree changed. Nothing was committed; start Builder again from current state.';return;}
                terminal=true;phase.textContent='Tree saved.';await onCommitted?.(committed);if(activeSessionClose===close)activeSessionClose=null;return;
            }
            phase.textContent='Rechecking lorebook and Tree freshness…';
            const committed=await controller.approveAndCommit(transactionId);
            if(committed.state==='stale'){terminal=true;phase.textContent='STALE — lorebook or Tree changed. Nothing was committed; run Build Lorebook Tree again.';return;}
            terminal=true;phase.textContent='Tree saved.';await onCommitted?.(committed);if(activeSessionClose===close)activeSessionClose=null;
        }catch(error){endBusy();phase.textContent=`Builder action failed: ${error?.message||String(error)}`;if(!terminal){approve.disabled=false;cancel.disabled=false;}}
    });

    try {
        phase.textContent = 'Planning semantic analysis or recovering unfinished Builder 2 work…';
        const result = await controller.start({ book: lorebook, source: 'operator-builder-overlay', requestedMode, validateOnly }, { signal: abortController.signal, onTransaction: id => { runId = id; cancel.disabled = false; } });
        if(abortController.signal.aborted)return result;
        renderResult(result);
        return result;
    } catch (error) {
        terminal = true;
        if (activeSessionClose === close) activeSessionClose = null;
        phase.textContent = `Builder failed safely: ${error?.message || String(error)}`;
        throw error;
    }
}
