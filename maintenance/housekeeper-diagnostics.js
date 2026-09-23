import { clear, el } from '../ui/core/dom.js';
import { panel } from '../ui/layout/panel.js';
import { collapsible } from '../ui/layout/collapsible.js';
import { itemRow } from '../ui/data/item-row.js';
import { emptyState } from '../ui/data/empty-state.js';
import { notice } from '../ui/data/notice.js';
import { historyRow } from '../ui/data/history.js';
import { badge } from '../ui/primitives/badge.js';
import { button } from '../ui/primitives/button.js';
import { evidenceBlock } from '../ui/nexus/evidence-block.js';
import { provenanceRow } from '../ui/nexus/provenance-row.js';
import { getHousekeeperDiagnosticState, flushHousekeeperDiagnostics } from './housekeeper-state.js';
import { recheckHousekeeperFinding } from './housekeeper.js';
import { suggestKeywords } from '../tree/keyword-advisor.js';

function fmtTime(value) { const n = Number(value); return n ? new Date(n).toLocaleString() : '—'; }
function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function toneForCategory(category) {
    if (category === 'MERGE_CANDIDATE' || category === 'OVERSIZED') return 'warning';
    if (category === 'SUMMARY_COVERAGE_REVIEW' || category === 'MEMORY_REPAIR_REVIEW') return 'danger';
    if (category === 'UNASSIGNED') return 'info';
    return 'neutral';
}
function toneForFreshness(value) { return value === 'CURRENT' ? 'success' : 'danger'; }
function answerLabel(answer) {
    if (!answer) return '—';
    const value = answer.value ?? answer.choice ?? answer.score ?? answer.noul;
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
    return clean(value || '—');
}
function findingMeta(row) {
    const p = row.provenance || {};
    if (row.category === 'MERGE_CANDIDATE') return `${row.book || 'Lore'} · UID ${p.uidA} ↔ UID ${p.uidB}`;
    if (p.uid != null) return `${row.book || 'Lore'} · UID ${p.uid}`;
    if (p.nodeId) return `${row.book || 'Lore'} · ${p.nodeId}`;
    if (p.coverageRange) return `Messages ${p.coverageRange[0]}–${p.coverageRange[1]}`;
    return row.book || p.scope || 'Housekeeper';
}
function deterministicExcerpt(row) {
    const e = row.deterministicEvidence || {};
    if (row.category === 'MERGE_CANDIDATE') return `UID ${e.uidA} “${e.titleA || 'Untitled'}” ↔ UID ${e.uidB} “${e.titleB || 'Untitled'}” · similarity ${e.percent ?? '—'}% · title ${e.titlePercent ?? '—'}% · content ${e.contentPercent ?? '—'}% · Tree ${e.nodeLabelA || e.nodeA || 'Unassigned'} ↔ ${e.nodeLabelB || e.nodeB || 'Unassigned'}.`;
    if (row.category === 'OVERSIZED') return `${e.reason || ''} ${e.chars ?? '—'} chars against ${e.thresholdChars ?? '—'} threshold. Semantic shadow: ${e.semanticShadowEligible ? 'eligible' : `deferred (${e.semanticShadowReason || 'bounded evidence unavailable'})`}.`;
    return e.detail || e.reason || JSON.stringify(e);
}
function renderDecisionShadow(shadow, document) {
    if (!shadow) return notice({ title: 'Decision Core shadow', message: 'No semantic shadow result is recorded for this finding.', tone: 'neutral', document });
    const answers = Object.entries(shadow.answers || {}).map(([key, value]) => itemRow({ title: key.replaceAll('_', ' '), meta: [answerLabel(value), value?.confidence != null ? `confidence ${Number(value.confidence).toFixed(2)}` : ''].filter(Boolean).join(' · '), document }));
    return panel({
        title: 'Decision Core shadow evidence',
        subtitle: 'Developer diagnostic evidence only. It is never Housekeeper authority.',
        actions: [badge({ label: shadow.freshness || 'UNKNOWN', tone: toneForFreshness(shadow.freshness), document })],
        body: [
            provenanceRow({ source: shadow.siteId || 'Decision Site', id: shadow.provider || 'provider unavailable', time: fmtTime(shadow.observedAt), note: shadow.providerModel || '', document }),
            ...(answers.length ? answers : [notice({ title: 'No typed answers', message: shadow.error?.message || 'The shadow provider did not return a usable answer set.', tone: shadow.freshness === 'STALE' ? 'danger' : 'warning', document })]),
        ],
        density: 'compact',
        document,
    });
}
function renderDecisionTriage(row, document) {
    const triage=row?.decisionTriage||null;
    if(!triage)return renderDecisionShadow(row?.decisionShadow,document);
    const route=String(triage.route||'DEFER');
    return panel({title:'Decision Core triage',subtitle:'Admission/routing evidence only. Deterministic findings remain visible and operator/mutation authority is unchanged.',actions:[badge({label:triage.stale?'STALE':route,tone:triage.stale?'danger':triage.uncertain?'warning':'neutral',document})],body:[itemRow({title:'Route',meta:[route,triage.sidecarRequired?'Sidecar review retained':'Sidecar review skipped',triage.confidence!=null?`confidence ${Number(triage.confidence).toFixed(2)}`:''].filter(Boolean).join(' · '),document}),itemRow({title:'Semantic review',meta:triage.semanticReview==null?'—':String(triage.semanticReview),body:triage.reason?[el('div',{className:'nx-text-muted',text:triage.reason,document})]:[],document})],density:'compact',document});
}

async function openExistingMergeReview(row) {
    const checked = await recheckHousekeeperFinding(row.id);
    if (!checked.ok) {
        globalThis.toastr?.warning('This Housekeeper finding is stale. Run Housekeeper again before opening merge review.', 'Housekeeper diagnostics');
        globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-housekeeper-updated'));
        return;
    }
    const live = checked.finding;
    const e = live.deterministicEvidence || {};
    const { openMergeReviewCandidate } = await import('../tree/ui.js');
    await openMergeReviewCandidate(live.book, {
        uidA: Number(e.uidA ?? live.provenance?.uidA),
        uidB: Number(e.uidB ?? live.provenance?.uidB),
        percent: Number(e.percent) || 0,
        titlePercent: Number(e.titlePercent) || 0,
        contentPercent: Number(e.contentPercent) || 0,
        sameNode: e.sameNode === true,
        nodeLabelA: e.nodeLabelA || e.nodeA || 'Root / Unassigned',
        nodeLabelB: e.nodeLabelB || e.nodeB || 'Root / Unassigned',
    });
}
function keywordSuggestionRows(result, document) {
    const rows = Array.isArray(result?.suggestions) ? result.suggestions : [];
    if (!rows.length) return [emptyState({ title: 'No safe keyword options found', message: 'The advisor did not find a sufficiently specific, low-collision keyword for this entry. Edit the lore entry manually or leave it keywordless until better evidence exists.', document })];
    return rows.map(row => itemRow({
        title: row.keyword,
        meta: [`confidence ${Math.round(Number(row.confidence) || 0)}%`, `collision risk ${Math.round(Number(row.accidentalFireRisk) || 0)}%`].join(' · '),
        body: row.reason ? [el('div', { className: 'nx-text-muted', text: row.reason, document })] : [],
        document,
    }));
}
function findingDetail(row, document) {
    const p = row.provenance || {};
    const sourceId = p.scope === 'merge-pair' ? `UID ${p.uidA} ↔ UID ${p.uidB}` : p.uid != null ? `UID ${p.uid}` : p.nodeId || p.memoryId || p.coverageId || row.id;
    const current = row.freshness === 'CURRENT';
    const actions = [];
    const keywordHost = row.category === 'KEYWORD_REVIEW' && p.uid != null ? el('div', { className: 'tv2-housekeeper-keyword-options', document }) : null;
    if (row.category === 'MERGE_CANDIDATE') actions.push(button({ label: 'Open existing Merge Review', variant: 'primary', size: 'sm', disabled: !current, title: current ? 'Recheck this finding and open the existing Tree/Ledger merge-review workflow.' : 'Stale findings cannot drive review actions.', onClick: async () => { try { await openExistingMergeReview(row); } catch (error) { globalThis.toastr?.error(error?.message || String(error), 'Nexus Merge'); } }, document }));
    if (keywordHost) actions.push(button({ label: 'Suggest keyword options', variant: 'secondary', size: 'sm', disabled: !current, title: current ? 'Generate operator-reviewed, low-collision keyword suggestions for this exact UID.' : 'Stale findings cannot drive keyword advice.', onClick: async event => {
        const control = event?.currentTarget;
        if (control) control.disabled = true;
        clear(keywordHost);
        keywordHost.append(notice({ title: 'Keyword advisor running', message: `Reviewing ${row.book} · UID ${p.uid} for precise, low-collision activation terms…`, tone: 'neutral', document }));
        try {
            const checked = await recheckHousekeeperFinding(row.id);
            if (!checked.ok) throw new Error('This keyword finding is stale. Run Housekeeper again before generating options.');
            const result = await suggestKeywords({ book: checked.finding.book, uid: Number(checked.finding.provenance?.uid ?? p.uid) });
            clear(keywordHost);
            keywordHost.append(panel({ title: `Keyword options · UID ${p.uid}`, subtitle: 'Suggestions are inert until you explicitly edit and save the lore entry.', body: keywordSuggestionRows(result, document), density: 'compact', document }));
        } catch (error) {
            clear(keywordHost);
            keywordHost.append(notice({ title: 'Keyword options unavailable', message: error?.message || String(error), tone: 'danger', document }));
        } finally {
            if (control) control.disabled = false;
        }
    }, document }));
    return el('div', { document }, [
        !current ? notice({ title: 'Stale finding', message: 'The canonical source changed after this finding was created. It cannot drive an operator action until Housekeeper recreates it from current sources.', tone: 'danger', document }) : null,
        evidenceBlock({ source: 'Deterministic Housekeeper', title: 'Why this was flagged', excerpt: deterministicExcerpt(row), refs: [row.book, sourceId].filter(Boolean), document }),
        panel({ title: 'Source provenance', actions, body: [provenanceRow({ source: p.scope || 'Housekeeper', id: row.sourceFingerprint || 'no fingerprint', time: fmtTime(row.detectedAt), note: findingMeta(row), document })], density: 'compact', document }),
        keywordHost,
        renderDecisionTriage(row, document),
    ]);
}
function findingNode(row, document) {
    return collapsible({
        title: row.title,
        subtitle: findingMeta(row),
        summaryEnd: [badge({ label: row.category, tone: toneForCategory(row.category), document }), badge({ label: row.freshness || 'CURRENT', tone: toneForFreshness(row.freshness), document })],
        body: [findingDetail(row, document)],
        document,
    });
}
function historyPanel(state, document) {
    const rows = [...(state.history || [])].reverse();
    return collapsible({
        title: 'Recent runs',
        open: false,
        body: rows.length ? rows.map(run => historyRow({
            time: fmtTime(run.finishedAt),
            type: run.status,
            title: `${run.findingCount} finding${run.findingCount === 1 ? '' : 's'} · ${run.adviceCount} semantic ranking${run.adviceCount === 1 ? '' : 's'}`,
            detail: `Added ${run.changes?.added?.length || 0} · resolved ${run.changes?.resolved?.length || 0} · source-changed ${run.changes?.changed?.length || 0}${run.changes?.evicted?.length ? ` · diagnostic-cap evicted ${run.changes.evicted.length}` : ''}${run.reason ? ` · ${run.reason}` : ''}`,
            status: run.successful ? 'SUCCESS' : 'NOT SUCCESSFUL',
            tone: run.successful ? 'success' : run.status === 'DEFERRED' || run.status === 'SKIPPED' ? 'neutral' : 'danger',
            document,
        })) : [emptyState({ title: 'No Housekeeper history yet', message: 'Recent bounded maintenance history appears here after Housekeeper runs.', document })],
        document,
    });
}

/** Render Housekeeper internals inside the existing Developer Diagnostics surface. */
export function renderHousekeeperDiagnostics(container, { document = globalThis.document } = {}) {
    if (!container || !document) return;
    const state = getHousekeeperDiagnosticState();
    const retainedFindings = Object.values(state.latestFindings || {});
    const latestRun = [...(state.history || [])].sort((a, b) => Number(b.finishedAt || 0) - Number(a.finishedAt || 0))[0] || null;
    // `latestFindings` deliberately preserves unresolved findings from books
    // omitted by rotating Housekeeper scans. Presenting that retained map as
    // one flat "current" list makes a one-book run look like it scanned mixed
    // lorebooks. The latest run owns the current view; older unresolved rows
    // remain visible in a separate retained/history surface.
    const latestRunRows = Array.isArray(latestRun?.findings) ? latestRun.findings : null;
    const liveById = new Map(retainedFindings.map(row => [String(row?.id || ''), row]));
    const currentFindings = latestRunRows ? latestRunRows.map(row => liveById.get(String(row?.id || '')) || row) : retainedFindings;
    const currentIds = new Set(currentFindings.map(row => String(row?.id || '')).filter(Boolean));
    const olderRetained = retainedFindings.filter(row => !currentIds.has(String(row?.id || '')));
    const scopeLabel = Array.isArray(latestRun?.books) && latestRun.books.length ? latestRun.books.join(' · ') : 'scope unavailable';
    clear(container);
    const flushFindings=button({label:'Flush findings',variant:'secondary',size:'sm',title:'Clear retained Housekeeper findings for this chat. The next Housekeeper scan can rebuild anything still true.',onClick:()=>{const result=flushHousekeeperDiagnostics({scope:'findings'});globalThis.toastr?.success('Housekeeper findings flushed.','Nexus Housekeeper',{timeOut:1800});renderHousekeeperDiagnostics(container,{document});return result;},document});
    const flushAll=button({label:'Flush all logs',variant:'danger',size:'sm',title:'Clear Housekeeper findings and bounded run history for this chat. This does not mutate lore, Tree state, proposals, summaries, or Ledger data.',onClick:()=>{const result=flushHousekeeperDiagnostics({scope:'all'});globalThis.toastr?.success('Housekeeper logs flushed.','Nexus Housekeeper',{timeOut:1800});renderHousekeeperDiagnostics(container,{document});return result;},document});
    container.append(
        panel({title:'Housekeeper log controls',subtitle:'Diagnostic/maintenance state only. Flushing does not modify canonical lore.',actions:[flushFindings,flushAll],body:[notice({title:'Rebuildable diagnostics',message:'Any issue that still exists can be rediscovered on the next Housekeeper pass.',tone:'neutral',document})],density:'compact',document}),
        collapsible({
            title: `Current findings · ${currentFindings.length}`,
            subtitle: `Scanned: ${scopeLabel}`,
            open: false,
            body: currentFindings.length ? currentFindings.map(row => findingNode(row, document)) : [emptyState({ title: 'No current findings', message: 'Nothing needs review in the latest Housekeeper scope.', document })],
            document,
        }),
        olderRetained.length ? collapsible({
            title: `Retained unresolved findings · ${olderRetained.length}`,
            subtitle: 'Findings preserved from earlier/other lorebook scopes. They were not part of the latest scan.',
            open: false,
            body: olderRetained.map(row => findingNode(row, document)),
            document,
        }) : null,
        historyPanel(state, document),
    );
}
