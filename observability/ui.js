import { getTelemetrySnapshot, onTelemetryChange, clearTelemetry, downloadTelemetryExport, downloadSidecarTelemetryExport, logEvent } from './telemetry.js';
import { formatTokenCount } from './token-estimator.js';
import { makeDraggableWindow } from '../windowing.js';
import { getNexusRuntime } from '../nexus/runtime.js';
import { getActiveNexusToolGateway } from '../nexus/tool-gateway.js';
import { inspectNexusCommitRecovery, reconcileNexusCommitRecovery } from '../nexus/transaction-service.js';
import { getSettings } from '../core/settings.js';
import { getJobQueue } from '../core/job-queue.js';
import { isNexusDevelopmentBuild } from '../core/build-info.js';
import { renderHousekeeperDiagnostics } from '../maintenance/housekeeper-diagnostics.js';
import { getRetrievalDiagnosticsSnapshot } from '../retrieval/diagnostics.js';
import { itemRow } from '../ui/data/item-row.js';
import { badge } from '../ui/primitives/badge.js';
import { notice } from '../ui/data/notice.js';
import { collapsible } from '../ui/layout/collapsible.js';
import { provenanceRow } from '../ui/nexus/provenance-row.js';

let overlay = null;
let housekeeperOverlay = null;
let unsubscribe = null;
let housekeeperUpdateHandler = null;
let filterState = { category: 'all', level: 'all', search: '' };
const SHOW_RECOVERY_CONTROLS = isNexusDevelopmentBuild();

const DIAG_COLLAPSE_KEY = 'tv2:diagnostics:collapse-state:v2';
let collapseState = loadCollapseState();

function loadCollapseState() {
    try {
        const saved = JSON.parse(sessionStorage.getItem(DIAG_COLLAPSE_KEY) || 'null');
        if (saved && typeof saved === 'object') return { coordination: !!saved.coordination, retrieval: !!saved.retrieval, A: !!saved.A, B: !!saved.B, recovery: !!saved.recovery };
    } catch {}
    return { coordination: true, retrieval: true, A: true, B: true, recovery: true };
}

function persistCollapseState() {
    try { sessionStorage.setItem(DIAG_COLLAPSE_KEY, JSON.stringify(collapseState)); } catch {}
}

function setCollapsed(key, collapsed) {
    collapseState = { ...collapseState, [key]: !!collapsed };
    persistCollapseState();
    if (!overlay) return;
    const button = overlay.querySelector(`[data-tv2-diag-toggle="${key}"]`);
    const body = overlay.querySelector(`[data-tv2-diag-body="${key}"]`);
    const section = button?.closest('.tv2-diag-collapsible');
    if (button) {
        button.setAttribute('aria-expanded', String(!collapsed));
        button.title = collapsed ? 'Expand section' : 'Collapse section';
        const indicator = button.querySelector('i');
        if (indicator) indicator.className = `fa-solid ${collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}`;
    }
    if (body) body.hidden = !!collapsed;
    section?.classList.toggle('is-collapsed', !!collapsed);
}

function applyCollapseState() {
    for (const key of ['coordination', 'retrieval', 'A', 'B', 'recovery']) setCollapsed(key, !!collapseState[key]);
}

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function time(ts) { try { return new Date(ts).toLocaleTimeString(); } catch { return ''; } }
function token(value, approximate = false) { return formatTokenCount(value, { approximate }); }
function ms(value) { return Number.isFinite(Number(value)) ? `${Math.round(Number(value))} ms` : '—'; }

function metricHtml(slot, snapshot) {
    const s = snapshot.sidecars?.[slot] || {};
    const plan = s.active || s.currentPlan;
    const last = s.last;
    const usage = last?.usage || {};
    const usageEstimated = last?.usageEstimated || {};
    const compliance = last?.resourceCompliance || {};
    const avg = s.calls ? s.latencyMs / s.calls : null;
    const planEstimate = plan?.estimate || {};
    const lastInput=Number(usage.inputTokens||0),lastCached=Math.min(lastInput,Number(usage.cachedInputTokens||0)),lastMiss=Math.max(0,lastInput-lastCached);
    const sessionInput=Number(s.actualInputTokens||0),sessionCached=Math.min(sessionInput,Number(s.cachedInputTokens||0)),sessionMiss=Math.max(0,sessionInput-sessionCached);
    const cachePct=sessionInput?Math.round((sessionCached/sessionInput)*100):0;
    const health=getSettings().sidecars?.[slot]?.lastHealth||null,healthAge=health?.checkedAt?Math.max(0,Date.now()-Number(health.checkedAt)):null;
    const healthAgeText=healthAge==null?'never':healthAge<60000?`${Math.max(1,Math.round(healthAge/1000))}s ago`:healthAge<3600000?`${Math.round(healthAge/60000)}m ago`:`${Math.round(healthAge/3600000)}h ago`;
    const healthChecks=(health?.checks||[]).map(row=>`${row.ok?'✓':'✕'} ${row.name}`).join(' · ');
    return `
      <div class="tv2-sidecar-metric-grid">
        <div><span>Provider check</span><b>${health?.checkedAt?`${health.usable?'Usable':'Not usable'} · ${esc(healthAgeText)}`:'Not run'}</b><small>${healthChecks?esc(healthChecks):'Connection/auth/model/text/structured JSON diagnostics are retained here after a check.'}</small></div>
        <div><span>Next / active</span><b>${plan ? `${esc(plan.role || plan.bus || 'job')}${plan.executionMode ? ` · ${esc(plan.executionMode)}` : ''}${plan.phase ? ` · ${esc(plan.phase)}` : ''} · ${token(planEstimate.inputTokens, true)} input` : 'Idle'}</b></div>
        <div><span>Input packing target</span><b>${plan ? (plan.softInputTargetTokens == null ? 'Unset' : token(plan.softInputTargetTokens)) : '—'}</b></div>
        <div><span>Output planning target</span><b>${plan ? (plan.softOutputTargetTokens == null ? 'Unset' : token(plan.softOutputTargetTokens)) : '—'}</b></div>
        <div><span>Physical request max</span><b>${plan ? (plan.physicalRequestMaxTokens == null ? 'Provider/default pending' : token(plan.physicalRequestMaxTokens)) : '—'}</b></div>
        <div><span>User cost cap</span><b>${plan ? (plan.userOutputCostLimitTokens == null && plan.userTotalCostLimitTokens == null ? 'None' : `${plan.userOutputCostLimitTokens ? `${token(plan.userOutputCostLimitTokens)} out` : ''}${plan.userOutputCostLimitTokens && plan.userTotalCostLimitTokens ? ' · ' : ''}${plan.userTotalCostLimitTokens ? `${token(plan.userTotalCostLimitTokens)} total` : ''}`) : '—'}</b></div>
        <div><span>Provider capacity</span><b>${plan ? `${plan.providerContextTokens == null ? 'context unknown' : `${token(plan.providerContextTokens)} ctx`} · ${plan.providerMaxTokens == null ? 'output unknown' : `${token(plan.providerMaxTokens)} out`}` : '—'}</b></div>
        <div><span>Last input</span><b>${last ? (usage.inputTokens != null ? token(usage.inputTokens) : token(usageEstimated.inputTokens ?? last?.estimate?.inputTokens, true)) : '—'}</b></div>
        <div><span>Last cache hit / miss</span><b>${last&&usage.inputTokens!=null?`${token(lastCached)} hit · ${token(lastMiss)} miss`:'—'}</b></div>
        <div><span>Last output</span><b>${last ? (usage.outputTokens != null ? token(usage.outputTokens) : token(usageEstimated.outputTokens, true)) : '—'}</b></div>
        <div><span>Last reasoning</span><b>${last ? (usage.reasoningTokens != null ? token(usage.reasoningTokens) : token(usageEstimated.reasoningTokens, true)) : '—'}</b></div>
        <div><span>Last total</span><b>${last ? (usage.totalTokens != null ? token(usage.totalTokens) : token(usageEstimated.totalTokens, true)) : '—'}</b></div>
        <div><span>Last latency</span><b>${last ? ms(last.latencyMs) : '—'}</b></div>
        <div><span>Finish</span><b>${last ? esc(last.ok ? (last.finishReason || 'completed') : `FAILED${last.finishReason ? ` · ${last.finishReason}` : ''}`) : '—'}</b></div>
        <div><span>Resource boundary</span><b>${last ? (compliance.userCostOverrun ? 'USER COST CAP EXCEEDED' : compliance.softTargetExceeded ? `Accepted above soft target · ${token(compliance.softOutputTargetTokens)}` : compliance.physicalRequestMaxTokens ? `Physical max · ${token(compliance.physicalRequestMaxTokens)}` : 'Provider-managed') : '—'}</b></div>
        <div><span>Session calls</span><b>${Number(s.calls || 0)} (${Number(s.failures || 0)} failed)</b></div>
        <div><span>Work assigned</span><b>${Number(s.assignedJobs || 0)} jobs</b></div>
        <div><span>Load offloads</span><b>${Number(s.offloadsReceived || 0)} in · ${Number(s.offloadsSent || 0)} out</b></div>
        <div><span>Failure fallbacks</span><b>${Number(s.fallbacksReceived || 0)} in · ${Number(s.fallbacksSent || 0)} out</b></div>
        <div><span>Multi-bus work</span><b>${Number(s.multiAssignments || 0)} calls · ${Number(s.reviewAssignments || 0)} review · ${Number(s.cascadeAssignments || 0)} cascade</b></div>
        <div><span>Session provider tokens</span><b>${token(s.totalTokens || 0)}</b></div>
        <div><span>Session est. observed</span><b>${token(s.estimatedObservedTokens || 0, true)}</b></div>
        <div><span>Session est. input</span><b>${token(s.estimatedInputTokens || 0, true)}</b></div>
        <div><span>Session reasoning</span><b>${token(s.reasoningTokens || 0)}</b></div>
        <div><span>Session cache</span><b>${sessionInput?`${cachePct}% · ${token(sessionCached)} hit · ${token(sessionMiss)} miss`:'—'}</b></div>
        <div><span>Cache write</span><b>${token(s.cacheWriteTokens || 0)}</b></div>
        <div><span>Average latency</span><b>${avg ? ms(avg) : '—'}</b></div>
      </div>`;
}

export function renderSidecarTelemetryCards(snapshot = getTelemetrySnapshot()) {
    for (const slot of ['A', 'B']) {
        const target = document.getElementById(`tv2_sidecar_${slot.toLowerCase()}_telemetry`);
        if (target) target.innerHTML = metricHtml(slot, snapshot);
    }
}

function eventMatches(evt) {
    if (filterState.category !== 'all' && evt.category !== filterState.category) return false;
    if (filterState.level !== 'all' && evt.level !== filterState.level) return false;
    if (filterState.search) {
        const hay = `${evt.category} ${evt.name} ${JSON.stringify(evt.data || {})}`.toLowerCase();
        if (!hay.includes(filterState.search.toLowerCase())) return false;
    }
    return true;
}

function eventRow(evt) {
    const data = evt.data || {};
    const headline = [data.slot ? `Sidecar ${data.slot}` : '', data.role || data.label || '', data.executionMode || data.mode || '', data.phase || '', data.model || '', data.state || ''].filter(Boolean).join(' · ');
    const usage = data.usage || {};
    const usageEstimated = data.usageEstimated || {};
    const tokenBits = [];
    if (usage.inputTokens != null) tokenBits.push(`${token(usage.inputTokens)} in`);
    else if (usageEstimated.inputTokens != null || data.estimate?.inputTokens != null) tokenBits.push(`${token(usageEstimated.inputTokens ?? data.estimate.inputTokens, true)} in`);
    if (usage.outputTokens != null) tokenBits.push(`${token(usage.outputTokens)} out`);
    else if (usageEstimated.outputTokens != null) tokenBits.push(`${token(usageEstimated.outputTokens, true)} out`);
    if (usage.reasoningTokens != null) tokenBits.push(`${token(usage.reasoningTokens)} reason`);
    else if (usageEstimated.reasoningTokens != null) tokenBits.push(`${token(usageEstimated.reasoningTokens, true)} reason`);
    if (data.latencyMs != null) tokenBits.push(ms(data.latencyMs));
    const detail = esc(JSON.stringify(data, null, 2));
    return `<details class="tv2-log-row tv2-level-${esc(evt.level)}">
      <summary><span class="tv2-log-time">${esc(time(evt.ts))}</span><span class="tv2-log-level">${esc(evt.level.toUpperCase())}</span><span class="tv2-log-category">${esc(evt.category)}</span><b>${esc(evt.name)}</b>${headline ? `<span class="tv2-log-headline">${esc(headline)}</span>` : ''}${tokenBits.length ? `<span class="tv2-log-tokens">${esc(tokenBits.join(' · '))}</span>` : ''}</summary>
      <pre>${detail}</pre>
    </details>`;
}


function countByState(rows = []) {
    const out = {};
    for (const row of rows || []) {
        const key = String(row?.state || 'unknown');
        out[key] = (out[key] || 0) + 1;
    }
    return out;
}

function coordinationSnapshotHtml() {
    let diag;
    try { diag = getNexusRuntime().diagnosticSnapshot(); }
    catch (error) { return `<div class="tv2-status">Nexus coordination snapshot unavailable: ${esc(error?.message || String(error))}</div>`; }
    const plans = Array.isArray(diag?.plans) ? diag.plans : [];
    const latest = plans.at(-1) || null;
    const jobs = latest?.jobs || [];
    const transactions = Array.isArray(diag?.transactions) ? diag.transactions : [];
    const operatorDiag = getActiveNexusToolGateway()?.diagnosticSnapshot?.() || null;
    const calls = Array.isArray(operatorDiag?.calls) ? operatorDiag.calls : (Array.isArray(diag?.calls) ? diag.calls : []);
    const txStates = countByState(transactions);
    const callStates = countByState(calls);
    const profile = diag?.executionProfile || {};
    const batch = diag?.batch || {};
    const gateway = diag?.generationGateway || {};
    const telemetry = getTelemetrySnapshot();
    // Prefer the retained latest critical snapshot; the bounded event ring may
    // legitimately evict generation-time evidence during noisy post-turn work.
    const frameEvent = telemetry?.latest?.generationFrameApplied || [...(telemetry?.events || [])].reverse().find(evt => evt?.category === 'generation-frame' && evt?.name === 'applied') || null;
    const frame = frameEvent?.data || null;
    const promptEvent = telemetry?.latest?.promptLoader?.chatCompletion || [...(telemetry?.events || [])].reverse().find(evt => evt?.category === 'prompt-loader' && evt?.name === 'chat-completion-ready' && evt?.data?.dryRun !== true) || null;
    const prompt = promptEvent?.data || null;
    const loreCacheShadow=telemetry?.latest?.retrievalPresentationCache?.data||null;
    const mainContext=telemetry?.latest?.mainContext||null;
    const frameStablePct = frame && frame.hasPriorComparison===true && Number.isFinite(Number(frame.stablePrefixRatioPct)) ? Number(frame.stablePrefixRatioPct) : null;
    const frameHeadline = frame ? `${formatTokenCount(frame.promptTokens || 0)} tokens · ${frameStablePct == null ? 'no prior-prefix sample' : `${frameStablePct}% stable prefix`}` : 'No sealed frame applied yet';
    const compileHits=Number(frame?.compileCache?.hits)||0,compileMisses=Number(frame?.compileCache?.misses)||0,compileTotal=compileHits+compileMisses;
    const compileText=compileTotal?`compiled reuse ${compileHits}/${compileTotal}`:'no compiled Main sections';
    const stranded=Number(frame?.cacheImpact?.strandedStableTokens)||0;
    const frameDetail = frame ? `First change ${frame.hasPriorComparison===true?(frame.firstChangedSection || 'none'):'n/a'} · ${stranded?`${formatTokenCount(stranded)} stable tokens stranded behind break`:'no stable suffix stranded'} · ${compileText} · ${Array.isArray(frame.failedOutlets) && frame.failedOutlets.length ? `failed outlets ${frame.failedOutlets.join(', ')}` : 'all reported outlets settled'} · ${Array.isArray(frame.publicationRejections) ? frame.publicationRejections.length : 0} rejected publications` : 'A normal foreground generation will populate this after Nexus seals its context frame.';
    const promptHeadline = prompt ? `${formatTokenCount(prompt.estimatedContentTokens || 0)} total · ${formatTokenCount(prompt.nexusFrameTokens || 0)} Nexus` : 'No real Main prompt observed yet';
    const prefixTokens=Number(prompt?.stability?.stablePrefixTokens)||0,breakScope=prompt?.stability?.messagePrefix?.breakScope||null;
    const loreGain=Number(loreCacheShadow?.potentialGainTokens)||0,epochName=mainContext?.name||null,epoch=mainContext?.data||null;
    const promptDetail = prompt ? `${prompt.messageCount ?? 0} messages · ${Number(prompt.nexusFrameSharePct || 0).toFixed(1)}% Nexus frame · ${prompt.generationId || 'unidentified generation'} · ${prompt.stability?.identicalToPrevious===true?'identical to prior real prompt':(prompt.stability?.stablePrefixRatioPct!=null?`${prompt.stability.stablePrefixRatioPct}% / ${formatTokenCount(prefixTokens)} stable prefix${breakScope?` · break ${breakScope}`:''}`:'first real prompt sample')} · ${loreGain?`lore-order shadow +${formatTokenCount(loreGain)} potential hit tokens`:'lore-order shadow no gain yet'}${epochName?` · ${epochName.replace('cache-epoch-','epoch ')} ${epoch?.rawAssistantTurns??'?'} / ${epoch?.maxRawAssistantTurns??'?'} raw turns`:''}` : 'Dry-run observations do not replace this retained real-request snapshot.';
    const coordinator = diag?.coordinator || {};
    const coordinatorActive = Array.isArray(coordinator.active) ? coordinator.active : [];
    let physicalQueue = null;
    try { physicalQueue = getJobQueue(getSettings().jobs || {}).healthSnapshot(); } catch {}
    const jobText = jobs.length ? jobs.map(job => {
        const intent = job?.metadata?.resourceIntent;
        const resource = intent ? ` · ${intent.role}/${intent.stage}/${intent.domain}` : '';
        return `${job.type} [${job.route}${resource}]`;
    }).join(' · ') : 'No jobs in latest plan';
    const txText = Object.keys(txStates).length ? Object.entries(txStates).map(([state,count]) => `${state} ${count}`).join(' · ') : 'none';
    const callText = Object.keys(callStates).length ? Object.entries(callStates).map(([state,count]) => `${state} ${count}`).join(' · ') : 'none';
    const latestPlan = latest
        ? `${latest.source || 'unknown'} · ${jobs.length} job${jobs.length===1?'':'s'} · ${esc(jobText)}`
        : 'No Director plan has been recorded yet.';
    return `<div class="tv2-nexus-diag-grid">
      <div><span>Execution profile</span><b>${esc(profile.kind || profile.profile || profile.mode || 'unknown')}</b><small>Main ${gateway.connected?'connected':'disconnected'} · A ${profile.sidecars?.A?'available':'off'} · B ${profile.sidecars?.B?'available':'off'}</small></div>
      <div><span>Generation Frame</span><b>${esc(frameHeadline)}</b><small>${esc(frameDetail)}</small></div>
      <div><span>Prompt Loader observation</span><b>${esc(promptHeadline)}</b><small>${esc(promptDetail)}</small></div>
      <div><span>Latest Director plan</span><b>${esc(latestPlan)}</b><small>${plans.length} plan${plans.length===1?'':'s'} retained</small></div>
      <div><span>Transaction Ledger</span><b>${esc(txText)}</b><small>${transactions.length} transaction${transactions.length===1?'':'s'} retained</small></div>
      <div><span>Call Center</span><b>${esc(callText)}</b><small>${calls.length} boundary record${calls.length===1?'':'s'} retained</small></div>
      <div><span>Coordinator execution</span><b>${coordinatorActive.length} active plan${coordinatorActive.length===1?'':'s'}</b><small>${coordinatorActive.length?esc(coordinatorActive.map(run=>`${run.planId||'unidentified'} · ${(run.jobs||[]).filter(job=>job.state==='running').length} running`).join(' · ')):(coordinator.last?`Last ${esc(coordinator.last.planId||'plan')} finished`:'No active Coordinator work')}</small></div>
      <div><span>Physical JobQueue</span><b>${physicalQueue?`${physicalQueue.queued.length} queued · ${physicalQueue.running.length} running`:'unavailable'}</b><small>${physicalQueue?`Locks ${Object.keys(physicalQueue.locks||{}).length} · foreground pause ${physicalQueue.pausedForForeground?'ON':'off'}`:'Physical queue snapshot failed'}</small></div>
      <div><span>Nexus Sidecar coalescer</span><b>${batch.queuedUnits ?? 0} queued · ${batch.activeUnits ?? 0} active</b><small>${batch.totalOutstandingUnits ?? ((batch.queuedUnits??0)+(batch.activeUnits??0))} outstanding · ${batch.lastOutcome ? esc(`${batch.lastOutcome.state || 'unknown'} · ${batch.lastOutcome.domain || 'worker'} · ${batch.lastOutcome.itemCount ?? 0} item(s)`) : 'No batch outcome yet'}</small></div>
    </div>`;
}

function commitRecoveryRows() {
    try { return { status:'ok', rows:inspectNexusCommitRecovery(), error:null }; }
    catch (error) { return { status:'error', rows:[], error }; }
}
function recoveryEvidence(row){
    return {
        id:row?.id||null,type:row?.type||null,state:row?.state||null,chatId:row?.chatId??null,
        mutationTarget:row?.mutationTarget??null,canonicalMutation:row?.canonicalMutation??null,
        recovery:row?.recovery??null,recoveryFingerprint:row?.recoveryFingerprint||null,
        commitPhase:row?.commitPhase||null,physicalPersistenceBegun:row?.physicalPersistenceBegun===true,
        subwrites:Array.isArray(row?.subwrites)?row.subwrites:[],resources:Array.isArray(row?.resources)?row.resources:[],
        error:row?.error||'',createdAt:row?.createdAt||null,updatedAt:row?.updatedAt||null,
    };
}
function commitRecoveryHtml(load = commitRecoveryRows()) {
    if(load?.status==='error')return `<div class="tv2-commit-recovery-empty"><b>Commit recovery authority unavailable.</b><br>Durable journal inspection failed: ${esc(load.error?.message||String(load.error))}. Nexus cannot safely conclude that no unresolved commit intents exist.</div>`;
    const rows=Array.isArray(load?.rows)?load.rows:[];
    if (!rows.length) return '<div class="tv2-commit-recovery-empty">No unresolved durable commit intents.</div>';
    return rows.map(row => {
        const state = String(row?.state || 'unknown');
        const when = row?.createdAt ? new Date(row.createdAt).toLocaleString() : 'unknown time';
        const appliedKnown = state === 'applied';
        let evidence='';try{evidence=JSON.stringify(recoveryEvidence(row),null,2);}catch{evidence='[evidence unavailable]';}
        return `<article class="tv2-commit-recovery-row" data-tv2-recovery-row="${esc(row.id)}">
          <div class="tv2-commit-recovery-copy"><div class="tv2-commit-recovery-title"><span>${esc(row.type || 'mutation')} · ${esc(state)}</span><b>${esc(row.id)}</b></div><small>Chat ${esc(row.chatId ?? 'none')} · ${esc(when)}${row.error ? ` · ${esc(row.error)}` : ''}</small><details><summary>Inspect canonical target / PRE-POST recovery evidence</summary><pre>${esc(evidence)}</pre></details></div>
          <div class="tv2-commit-recovery-actions">
            <button class="menu_button" type="button" data-tv2-recovery-id="${esc(row.id)}" data-tv2-recovery-disposition="confirmed-applied">Confirm applied</button>
            ${appliedKnown ? '' : `<button class="menu_button" type="button" data-tv2-recovery-id="${esc(row.id)}" data-tv2-recovery-disposition="confirmed-not-applied">Not applied — unblock retry</button>`}
            <button class="menu_button" type="button" data-tv2-recovery-id="${esc(row.id)}" data-tv2-recovery-disposition="abandoned">Abandon unknown outcome</button>
            ${appliedKnown ? '' : `<button class="menu_button" type="button" data-tv2-recovery-id="${esc(row.id)}" data-tv2-recovery-disposition="diverged">Archive diverged state</button>`}
          </div>
        </article>`;
    }).join('');
}

function renderRetrievalDiagnostics() {
    if (!overlay) return;
    const target = overlay.querySelector('[data-tv2-diag-retrieval]');
    if (!target) return;
    const snapshot = getRetrievalDiagnosticsSnapshot();
    const doc = target.ownerDocument || document;
    const children = [];
    if (!snapshot?.updatedAt) {
        children.push(notice({ title: 'No Retrieval diagnostics yet', message: 'Run a foreground Retrieval cycle to populate candidate, Change Gate Shadow, residency, and Generation Frame publication evidence.', tone: 'neutral', document: doc }));
        target.replaceChildren(...children);
        return;
    }
    const gate = snapshot.gateShadow;
    if (gate) {
        const shadow = gate.shadow || {};
        const gateBadges = [
            badge({ label: `Authoritative ${gate.current || 'unknown'}`, tone: 'info', document: doc }),
            badge({ label: `Shadow ${shadow.classification || gate.status || 'unavailable'}`, tone: shadow.stale ? 'warning' : 'neutral', document: doc }),
        ];
        if (gate.agreement === true) gateBadges.push(badge({ label: 'Agreement', tone: 'success', document: doc }));
        else if (gate.agreement === false) gateBadges.push(badge({ label: 'Disagreement', tone: 'warning', document: doc }));
        children.push(itemRow({
            title: 'Change Gate semantic comparison',
            meta: 'Shadow only. The existing Change Gate remains authoritative; this result cannot reroute Retrieval.',
            leading: gateBadges,
            body: [provenanceRow({ source: shadow.provider || 'Decision Core', id: gate.sourceFingerprint || '', note: shadow.latencyMs ? `${shadow.latencyMs} ms` : '', document: doc })],
            document: doc,
        }));
    }
    const publication = snapshot.publication;
    if (publication) {
        children.push(notice({
            title: 'Generation Frame publication authority',
            message: `${publication.selectedCount} selected · ${publication.publishedCount} published · ${formatTokenCount(publication.estimatedInjectionTokens || 0)} estimated tokens. Prompt Loader observes the final prompt; it is not publication authority.`,
            tone: publication.degraded ? 'warning' : 'info', document: doc,
        }));
    }
    const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
    const candidateRows = candidates.map(candidate => {
        const leading = [];
        if (candidate.warm) leading.push(badge({ label: 'warm', tone: 'info', document: doc }));
        if (candidate.pinned) leading.push(badge({ label: 'pinned', tone: 'success', document: doc }));
        if (candidate.residency && candidate.residency !== 'UNKNOWN') leading.push(badge({ label: String(candidate.residency).toLowerCase(), tone: candidate.residency === 'SLEEPING' ? 'neutral' : 'info', document: doc }));
        if (candidate.selected) leading.push(badge({ label: 'selected', tone: 'warning', document: doc }));
        if (candidate.published) leading.push(badge({ label: 'published', tone: 'success', document: doc }));
        const shadow = candidate.shadow || {};
        if (shadow.stale) leading.push(badge({ label: 'shadow stale', tone: 'warning', document: doc }));
        const meta = [
            (candidate.discoverySources || []).length ? `via ${(candidate.discoverySources || []).join(' + ')}` : null,
            `baseline #${candidate.baselineRank ?? '—'}`,
            shadow.shadowRank ? `shadow #${shadow.shadowRank}` : 'shadow —',
            Number.isFinite(Number(shadow.score)) ? `score ${Number(shadow.score).toFixed(3)}` : null,
            Number.isFinite(Number(shadow.necessaryEvidence)) ? `necessary ${Number(shadow.necessaryEvidence).toFixed(3)}` : null,
        ].filter(Boolean).join(' · ');
        return itemRow({
            title: candidate.title || `UID ${candidate.uid}`,
            meta,
            leading,
            body: [provenanceRow({ source: candidate.book || 'Lore', id: `UID ${candidate.uid}${candidate.nodeId ? ` · node ${candidate.nodeId}` : ''}`, note: shadow.error?.category || '', document: doc })],
            document: doc,
        });
    });
    children.push(collapsible({ title: 'Retrieval candidates', subtitle: `${candidates.length} bounded candidate${candidates.length === 1 ? '' : 's'} · shadow rerank`, body: candidateRows.length ? candidateRows : [notice({ message: 'No candidate rows were recorded for the latest Retrieval cycle.', document: doc })], open: true, document: doc }));
    target.replaceChildren(...children);
}

function renderPanel() {
    if (!overlay) return;
    const snapshot = getTelemetrySnapshot();
    renderSidecarTelemetryCards(snapshot);
    const categorySelect = overlay.querySelector('.tv2_diag_category');
    if (categorySelect) {
        const categories = [...new Set(snapshot.events.map(e => e.category))].sort();
        const current = filterState.category;
        categorySelect.innerHTML = '<option value="all">All categories</option>' + categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
        categorySelect.value = categories.includes(current) || current === 'all' ? current : 'all';
        if (categorySelect.value !== current) filterState.category = categorySelect.value;
    }
    const coordination = overlay.querySelector('[data-tv2-diag-nexus]');
    if (coordination) coordination.innerHTML = coordinationSnapshotHtml();
    renderRetrievalDiagnostics();
    if (SHOW_RECOVERY_CONTROLS) {
        const recoveryLoad = commitRecoveryRows();
        const recovery = overlay.querySelector('[data-tv2-diag-recovery]');
        if (recovery) recovery.innerHTML = commitRecoveryHtml(recoveryLoad);
        const recoveryCount = overlay.querySelector('[data-tv2-diag-recovery-count]');
        if (recoveryCount) recoveryCount.textContent = recoveryLoad.status==='error'?'!':String(recoveryLoad.rows.length);
    }
    const events = snapshot.events.filter(eventMatches).slice().reverse();
    const list = overlay.querySelector('.tv2-log-list');
    if (list) list.innerHTML = events.length ? events.map(eventRow).join('') : '<p class="tv2-status">No matching events.</p>';
    const counts = overlay.querySelector('.tv2-log-count');
    if (counts) counts.textContent = `${events.length} shown / ${snapshot.events.length} captured`;
    for (const slot of ['A', 'B']) {
        const target = overlay.querySelector(`[data-tv2-diag-sidecar="${slot}"]`);
        if (target) target.innerHTML = metricHtml(slot, snapshot);
    }
}

function renderHousekeeperWorkspace() {
    const host = housekeeperOverlay?.querySelector?.('[data-tv2-housekeeper-workspace]');
    if (host) renderHousekeeperDiagnostics(host, { document: host.ownerDocument || document });
}
function closeHousekeeperDiagnostics() {
    housekeeperOverlay?.remove();
    housekeeperOverlay = null;
}
function openHousekeeperDiagnostics() {
    if (!SHOW_RECOVERY_CONTROLS) return;
    if (housekeeperOverlay) { renderHousekeeperWorkspace(); return; }
    housekeeperOverlay = document.createElement('div');
    housekeeperOverlay.className = 'tv2-overlay';
    housekeeperOverlay.innerHTML = `<div class="tv2-diagnostics-panel tv2-housekeeper-workspace"><div class="tv2-panel-head"><div><h3>Housekeeper</h3></div><button class="menu_button tv2_housekeeper_diag_close" type="button">Close</button></div><div class="nexus-ui tv2-housekeeper-workspace-body" data-tv2-housekeeper-workspace></div></div>`;
    document.body.appendChild(housekeeperOverlay);
    const panel = housekeeperOverlay.querySelector('.tv2-housekeeper-workspace');
    makeDraggableWindow(panel, { handle: panel?.querySelector('.tv2-panel-head'), storageKey: 'housekeeper-diagnostics' });
    housekeeperOverlay.querySelector('.tv2_housekeeper_diag_close')?.addEventListener('click', closeHousekeeperDiagnostics);
    housekeeperOverlay.addEventListener('click', event => { if (event.target === housekeeperOverlay) closeHousekeeperDiagnostics(); });
    renderHousekeeperWorkspace();
}

export function openDiagnosticsPanel() {
    if (overlay) { renderPanel(); return; }
    overlay = document.createElement('div');
    overlay.className = 'tv2-overlay';
    overlay.innerHTML = `<div class="tv2-diagnostics-panel">
      <div class="tv2-panel-head"><div><h3>Nexus Diagnostics & Token Log</h3><div class="tv2-log-count"></div></div><div class="tv2-diag-header-actions">${SHOW_RECOVERY_CONTROLS ? `<button class="menu_button tv2_diag_housekeeper" type="button">Housekeeper</button>` : ''}<button class="menu_button tv2_diag_refresh_nexus" type="button"><i class="fa-solid fa-rotate"></i> Refresh</button><button class="menu_button tv2_diag_close">Close</button></div></div>
      <section class="tv2-nexus-diag-section tv2-diag-collapsible"><div class="tv2-nexus-diag-head"><button class="tv2-diag-disclosure" type="button" data-tv2-diag-toggle="coordination" aria-expanded="${String(!collapseState.coordination)}"><i class="fa-solid ${collapseState.coordination?'fa-chevron-right':'fa-chevron-down'}"></i><h4>Coordination snapshot</h4></button></div><div data-tv2-diag-body="coordination"${collapseState.coordination?' hidden':''}><div data-tv2-diag-nexus></div></div></section>
      <section class="tv2-nexus-diag-section tv2-diag-collapsible"><div class="tv2-nexus-diag-head"><button class="tv2-diag-disclosure" type="button" data-tv2-diag-toggle="retrieval" aria-expanded="${String(!collapseState.retrieval)}"><i class="fa-solid ${collapseState.retrieval?'fa-chevron-right':'fa-chevron-down'}"></i><h4>Retrieval / Context</h4></button></div><div data-tv2-diag-body="retrieval"${collapseState.retrieval?' hidden':''}><div class="nexus-ui" data-tv2-diag-retrieval></div></div></section>
      ${SHOW_RECOVERY_CONTROLS ? `<section class="tv2-commit-recovery-section tv2-diag-collapsible"><div class="tv2-commit-recovery-head"><button class="tv2-diag-disclosure" type="button" data-tv2-diag-toggle="recovery" aria-expanded="${String(!collapseState.recovery)}"><i class="fa-solid ${collapseState.recovery?'fa-chevron-right':'fa-chevron-down'}"></i><h4>Commit recovery</h4><span class="tv2-diag-count" data-tv2-diag-recovery-count>0</span></button></div><div data-tv2-diag-body="recovery"${collapseState.recovery?' hidden':''}><div class="tv2-commit-recovery-list" data-tv2-diag-recovery data-tv2-commit-recovery></div></div></section>` : ''}
      <div class="tv2-diag-sidecars"><section class="tv2-diag-collapsible"><div class="tv2-diag-sidecar-head"><button class="tv2-diag-disclosure" type="button" data-tv2-diag-toggle="A" aria-expanded="${String(!collapseState.A)}"><i class="fa-solid ${collapseState.A?'fa-chevron-right':'fa-chevron-down'}"></i><h4>Sidecar A</h4></button><button class="menu_button tv2_diag_export_sidecar" type="button" data-tv2-export-sidecar="A" title="Export Sidecar A request telemetry"><i class="fa-solid fa-file-export"></i> Export A</button></div><div data-tv2-diag-body="A"${collapseState.A?' hidden':''}><div data-tv2-diag-sidecar="A"></div></div></section><section class="tv2-diag-collapsible"><div class="tv2-diag-sidecar-head"><button class="tv2-diag-disclosure" type="button" data-tv2-diag-toggle="B" aria-expanded="${String(!collapseState.B)}"><i class="fa-solid ${collapseState.B?'fa-chevron-right':'fa-chevron-down'}"></i><h4>Sidecar B</h4></button><button class="menu_button tv2_diag_export_sidecar" type="button" data-tv2-export-sidecar="B" title="Export Sidecar B request telemetry"><i class="fa-solid fa-file-export"></i> Export B</button></div><div data-tv2-diag-body="B"${collapseState.B?' hidden':''}><div data-tv2-diag-sidecar="B"></div></div></section></div>
      <div class="tv2-log-toolbar">
        <select class="text_pole tv2_diag_category"><option value="all">All categories</option></select>
        <select class="text_pole tv2_diag_level"><option value="all">All levels</option><option>debug</option><option>info</option><option>warn</option><option>error</option></select>
        <input class="text_pole tv2_diag_search" placeholder="Search logs, job IDs, models, errors…">
        <button class="menu_button tv2_diag_export">Export JSON</button>
        <button class="menu_button tv2_diag_clear">Clear log</button>
      </div>
      <div class="tv2-log-list"></div>
    </div>`;
    document.body.appendChild(overlay);
    const diagPanel=overlay.querySelector('.tv2-diagnostics-panel');
    makeDraggableWindow(diagPanel,{handle:diagPanel?.querySelector('.tv2-panel-head'),storageKey:'diagnostics'});
    const snapshot = getTelemetrySnapshot();
    const categories = [...new Set(snapshot.events.map(e => e.category))].sort();
    const categorySelect = overlay.querySelector('.tv2_diag_category');
    categorySelect.innerHTML = '<option value="all">All categories</option>' + categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    categorySelect.value = filterState.category;
    overlay.querySelector('.tv2_diag_level').value = filterState.level;
    overlay.querySelector('.tv2_diag_search').value = filterState.search;
    overlay.querySelector('.tv2_diag_close').addEventListener('click', closeDiagnosticsPanel);
    overlay.querySelector('.tv2_diag_housekeeper')?.addEventListener('click', openHousekeeperDiagnostics);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeDiagnosticsPanel(); });
    categorySelect.addEventListener('change', e => { filterState.category = e.target.value; renderPanel(); });
    overlay.querySelector('.tv2_diag_level').addEventListener('change', e => { filterState.level = e.target.value; renderPanel(); });
    overlay.querySelector('.tv2_diag_search').addEventListener('input', e => { filterState.search = e.target.value; renderPanel(); });
    overlay.querySelector('.tv2_diag_export').addEventListener('click', () => downloadTelemetryExport());
    for(const button of overlay.querySelectorAll('[data-tv2-export-sidecar]'))button.addEventListener('click',event=>{event.stopPropagation();downloadSidecarTelemetryExport(button.dataset.tv2ExportSidecar);});
    overlay.querySelector('.tv2_diag_clear').addEventListener('click', () => { clearTelemetry(); renderPanel(); });
    overlay.addEventListener('click', async event => {
        if (!SHOW_RECOVERY_CONTROLS) return;
        const button = event.target.closest?.('[data-tv2-recovery-id][data-tv2-recovery-disposition]');
        if (!button) return;
        const id = String(button.dataset.tv2RecoveryId || '');
        const disposition = String(button.dataset.tv2RecoveryDisposition || '');
        const load=commitRecoveryRows();
        if(load.status!=='ok'){globalThis.toastr?.error('Commit recovery authority is unavailable; no disposition is safe.','Nexus commit recovery');return;}
        const current=load.rows.find(row=>String(row?.id||'')===id);
        if(!current){globalThis.toastr?.warning('This recovery record is no longer unresolved. Refresh diagnostics.','Nexus commit recovery');return;}
        const target=current.mutationTarget??current.canonicalMutation??current.recovery??{};
        let targetText='';try{targetText=JSON.stringify(target,null,2);}catch{targetText='[target unavailable]';}
        const consequence=disposition==='confirmed-applied'
            ?'assert that canonical POST state is physically present and create durable applied settlement authority'
            :disposition==='confirmed-not-applied'
                ?'assert canonical PRE state is present and remove the replay barrier so the mutation may be retried'
                :disposition==='diverged'
                    ?'prove canonical state matches neither PRE nor POST, archive this unresolved ownership as an unknown/diverged outcome, and permanently fence exact replay of the old mutation identity'
                    :'record the physical outcome as unknown, close this recovery record, and permanently fence exact replay without asserting PRE or POST';
        const confirmationQuestion=disposition==='abandoned'?'Abandon this recovery as an unknown outcome?':`Confirm recovery disposition for ${id}?`;
        if(globalThis.confirm?.(`${confirmationQuestion}\n\nAction: ${disposition}\nConsequence: ${consequence}.\n\nTarget / mutation evidence:\n${targetText}`)===false)return;
        button.disabled = true;
        try {
            const row = await reconcileNexusCommitRecovery(id, { disposition, note: 'Operator reconciled from Nexus Diagnostics.' });
            logEvent('transaction', 'commit-recovery-reconciled', { id, disposition, previousState: row?.state || null }, 'warn');
            globalThis.toastr?.success(`Commit recovery ${id} marked ${disposition.replaceAll('-', ' ')}.`, 'Nexus');
        } catch (error) {
            logEvent('transaction', 'commit-recovery-reconcile-failed', { id, disposition, error }, 'error');
            globalThis.toastr?.error(error?.message || String(error), 'Nexus commit recovery');
        } finally {
            renderPanel();
        }
    });
    overlay.querySelector('.tv2_diag_refresh_nexus')?.addEventListener('click', renderPanel);
    overlay.querySelectorAll('[data-tv2-diag-toggle]').forEach(button => button.addEventListener('click', () => {
        const key = button.dataset.tv2DiagToggle;
        setCollapsed(key, !collapseState[key]);
    }));
    applyCollapseState();
    unsubscribe = onTelemetryChange(() => renderPanel());
    if (SHOW_RECOVERY_CONTROLS && globalThis.window?.addEventListener) {
        housekeeperUpdateHandler = () => renderHousekeeperWorkspace();
        globalThis.window.addEventListener('tv2-housekeeper-updated', housekeeperUpdateHandler);
    }
    renderPanel();
}

export function closeDiagnosticsPanel() {
    closeHousekeeperDiagnostics();
    unsubscribe?.(); unsubscribe = null;
    if (housekeeperUpdateHandler && globalThis.window?.removeEventListener) globalThis.window.removeEventListener('tv2-housekeeper-updated', housekeeperUpdateHandler);
    housekeeperUpdateHandler = null;
    overlay?.remove(); overlay = null;
}

export function bindTelemetryCards() {
    const snapshot = getTelemetrySnapshot();
    renderSidecarTelemetryCards(snapshot);
    renderLogLauncher(snapshot);
    return onTelemetryChange((_record, next) => {
        renderSidecarTelemetryCards(next);
        renderLogLauncher(next);
    });
}


function compactRecentRow(evt) {
    const data = evt?.data || {};
    const who = data.slot ? `SC-${data.slot}` : (data.bus || data.role || evt.category);
    const usage = data.usage || {};
    const est = data.usageEstimated || data.estimate || {};
    const total = usage.totalTokens ?? est.totalTokens ?? null;
    return `<div class="tv2-recent-log-row tv2-level-${esc(evt.level)}"><span class="tv2-log-time">${esc(time(evt.ts))}</span><b>${esc(who)}</b><span>${esc(evt.name)}</span>${total != null ? `<span class="tv2-log-tokens">${token(total, usage.totalTokens == null)}</span>` : ''}</div>`;
}

export function renderLogLauncher(snapshot = getTelemetrySnapshot()) {
    const launcher = document.getElementById('tv2_log_launcher_status');
    const a = snapshot.sidecars?.A || {};
    const b = snapshot.sidecars?.B || {};
    if (launcher) launcher.textContent = `${snapshot.events.length} events · A ${token(a.totalTokens || a.estimatedObservedTokens || 0, !a.totalTokens)} · B ${token(b.totalTokens || b.estimatedObservedTokens || 0, !b.totalTokens)}`;
    const count = document.getElementById('tv2_recent_log_count');
    if (count) count.textContent = `${snapshot.events.length} captured`;
    const preview = document.getElementById('tv2_recent_log_preview');
    if (preview) {
        const recent = snapshot.events.slice(-8).reverse();
        preview.innerHTML = recent.length ? recent.map(compactRecentRow).join('') : '<p class="tv2-status">No events yet.</p>';
    }
}
