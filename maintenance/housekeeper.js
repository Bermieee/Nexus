import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { getActiveBooks } from '../lore/active-books.js';
import { captureLoreCorpus } from '../lore/corpus-authority.js';
import { loadBook } from '../lore/store.js';
import { getTree, hasTree } from '../tree/store.js';
import { collectUids } from '../tree/model.js';
import { currentNodeForUid } from '../tree/ops.js';
import { scanMergeCandidates } from '../tools/merge.js';
import { scanMemoryBank, exportMemoryBank, getEffectiveSummarizedUpTo, currentMemoryBankRevision } from '../memory/store.js';
import { enqueueBusJob, BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { structuredSidecarOptions } from '../nexus/batch-layer.js';
import { logEvent } from '../observability/telemetry.js';
import { isIntentionalCancellation } from '../core/cancellation.js';
import { housekeeperPairFingerprint, housekeeperSemanticOverloadFingerprint, housekeeperSemanticOverloadEligibility } from './housekeeper-decision-site.js';
import { getHousekeeperDiagnosticState, recordHousekeeperRun, recordHousekeeperFindingFreshness } from './housekeeper-state.js';
import { MAINTENANCE_FINDING_TRIAGE_SITE_ID, MAINTENANCE_DECISION_MAX, interpretMaintenanceFindingTriage } from './decision-site.js';
import { runDecisionSiteThroughDirector } from '../decision/work-director-bridge.js';
import { currentNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';

export const HOUSEKEEPER_FINDING_CATEGORY = Object.freeze({
    MISSING_NODE_SUMMARY: 'MISSING_NODE_SUMMARY',
    UNASSIGNED: 'UNASSIGNED',
    KEYWORD_REVIEW: 'KEYWORD_REVIEW',
    OVERSIZED: 'OVERSIZED',
    MERGE_CANDIDATE: 'MERGE_CANDIDATE',
    SUMMARY_COVERAGE_REVIEW: 'SUMMARY_COVERAGE_REVIEW',
    MEMORY_REPAIR_REVIEW: 'MEMORY_REPAIR_REVIEW',
});
export const HOUSEKEEPER_FRESHNESS = Object.freeze({ CURRENT: 'CURRENT', STALE: 'STALE' });

let automaticBookCursor = 0;
let automaticBookSignature = '';
let lastAttemptAt = 0;
let lastSuccessfulRunAt = 0;
let lastReport = null;

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function stableObject(value) {
    if (Array.isArray(value)) return value.map(stableObject);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
    return value;
}
function hashValue(prefix, value) {
    const text = JSON.stringify(stableObject(value ?? null));
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return `${prefix}-${hash.toString(16).padStart(8, '0')}-${text.length}`;
}
function findingFingerprint(value) { return hashValue('hk', value); }
function housekeeperAuditConfig(settings) {
    return {
        oversizedEntryChars: Math.max(1200, Number(settings?.housekeeper?.oversizedEntryChars) || 7000),
        mergeThresholdPercent: Math.max(10, Number(settings?.housekeeper?.mergeThresholdPercent) || 65),
        maxMergeSuggestions: Math.max(1, Number(settings?.housekeeper?.maxMergeSuggestions) || 12),
    };
}
function housekeeperSourceSignature(targets, settings) {
    const books=(Array.isArray(targets)?targets:[]).map(book=>String(book||'')).filter(Boolean);
    return hashValue('hk-src',{
        books,
        loreTreeRevision:currentNexusLoreSourceRevision(books),
        memoryRevision:currentMemoryBankRevision(),
        audit:housekeeperAuditConfig(settings),
    });
}
function stableFindingId(category, locator = {}) { return hashValue('hkf', { category, locator }); }
function walk(node, out = []) {
    if (!node) return out;
    out.push(node);
    for (const child of node.children || []) walk(child, out);
    return out;
}
function parseJson(text) {
    const raw = String(text || '').trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '');
    try { return JSON.parse(raw); } catch {}
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    return {};
}
function currentTreeNode(tree, nodeId) { return walk(tree?.root, []).find(node => String(node?.id || '') === String(nodeId || '')) || null; }
function entryCanonicalFingerprint(book, entry, nodeId = null) { return hashValue('hk-entry', { book: String(book || ''), nodeId: nodeId || null, canonicalEntry: entry || null }); }
function treeNodeCanonicalFingerprint(book, node) { return hashValue('hk-node', { book: String(book || ''), canonicalNode: node || null }); }
function findingBase({ category, locator, title, book = null, provenance = null, sourceFingerprint, deterministicEvidence = null, detectedAt = Date.now() } = {}) {
    return {
        id: stableFindingId(category, locator),
        category,
        title: String(title || category),
        book: book == null ? null : String(book),
        provenance: clone(provenance),
        sourceFingerprint: String(sourceFingerprint || ''),
        freshness: HOUSEKEEPER_FRESHNESS.CURRENT,
        deterministicEvidence: clone(deterministicEvidence),
        decisionShadow: null,
        detectedAt,
    };
}

export function getLastHousekeeperReport() { return lastReport ? clone(lastReport) : null; }
export function getHousekeeperRuntimeStatus() { return { lastAttemptAt, lastSuccessfulRunAt, lastStatus: lastReport?.status || null, lastSuccessful: lastReport?.successful === true }; }
/** Lifecycle/Director cadence is the only scheduling authority. */
export function housekeeperIsDue({ force = false, cadenceDue = false } = {}) { return force === true || cadenceDue === true; }
export function isHousekeeperSuccessfulRun(result) { return result?.successful === true && result?.status === 'COMPLETE' && !result?.failed && !result?.deferred && !result?.skipped && !result?.stale && !result?.incomplete && !result?.adviceError; }

export function inspectHousekeeperSummaryCoverage({ memoryReport = null, memoryStore = null, effectiveSummarizedUpTo = null } = {}) {
    const report = memoryReport || scanMemoryBank();
    const store = memoryStore || exportMemoryBank();
    const effective = Number.isFinite(Number(effectiveSummarizedUpTo)) ? Number(effectiveSummarizedUpTo) : getEffectiveSummarizedUpTo();
    const staleCoverageIds = new Set((report?.issues || []).filter(issue => issue?.kind === 'stale-coverage').map(issue => String(issue.coverageId || '')));
    const receipts = (store?.coverageReceipts || []).filter(receipt => receipt?.turnRange && !staleCoverageIds.has(String(receipt.id || ''))).sort((a, b) => Number(a.turnRange?.[0]) - Number(b.turnRange?.[0]) || Number(a.turnRange?.[1]) - Number(b.turnRange?.[1]));
    const gaps = [];
    let priorEnd = -1;
    for (const receipt of receipts) {
        const start = Number(receipt.turnRange?.[0]), end = Number(receipt.turnRange?.[1]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) continue;
        if (start > priorEnd + 1) gaps.push({ start: priorEnd + 1, end: start - 1, beforeCoverageId: String(receipt.id || '') });
        priorEnd = Math.max(priorEnd, end);
    }
    return {
        authority: 'coverageReceipts',
        effectiveSummarizedUpTo: effective,
        validReceiptCount: receipts.length,
        staleReceiptCount: staleCoverageIds.size,
        durableGaps: gaps,
        receiptRanges: receipts.map(receipt => ({ id: String(receipt.id || ''), turnRange: [Number(receipt.turnRange[0]), Number(receipt.turnRange[1])] })),
    };
}
function scanHousekeeperMemory() {
    const raw = scanMemoryBank();
    const store = exportMemoryBank();
    const coverage = inspectHousekeeperSummaryCoverage({ memoryReport: raw, memoryStore: store, effectiveSummarizedUpTo: getEffectiveSummarizedUpTo() });
    // Legacy active-card gaps are topology observations, not durable source
    // coverage. Housekeeper deliberately replaces only those findings with the
    // coverageReceipts authority above; all other Memory Bank diagnostics stay.
    const issues = (raw.issues || []).filter(issue => issue?.kind !== 'gap').map(issue => ({ ...issue }));
    for (const gap of coverage.durableGaps) issues.push({ kind: 'coverage-gap', coverageRange: [gap.start, gap.end], detail: `Durable Summary coverage has a gap between messages ${gap.start} and ${gap.end}.` });
    for (const issue of issues) {
        const record = issue.memoryId ? store.records?.[String(issue.memoryId)] || null : null;
        const receipt = issue.coverageId ? (store.coverageReceipts || []).find(row => String(row?.id || '') === String(issue.coverageId)) || null : null;
        issue.sourceFingerprint = hashValue('hk-memory', { issue: { kind: issue.kind, memoryId: issue.memoryId || null, coverageId: issue.coverageId || null, coverageRange: issue.coverageRange || null }, record, receipt, coverage: issue.kind === 'coverage-gap' ? coverage : null });
    }
    return { ...raw, ok: issues.length === 0, issues, coverageAuthority: coverage };
}

async function scanBook(book, settings, { sourceData = undefined, sourceTree = undefined } = {}) {
    const data = sourceData===undefined ? await loadBook(book) : sourceData;
    const entries = Object.values(data?.entries || {});
    const active = entries.filter(entry => entry?.disable !== true);
    const tree = sourceTree===undefined ? getTree(book) : sourceTree;
    const assigned = new Set(collectUids(tree?.root));
    const nodes = walk(tree?.root).filter(node => node !== tree?.root);
    const oversizedEntryChars = Math.max(1200, Number(settings?.housekeeper?.oversizedEntryChars) || 7000);
    const byUid = new Map(active.map(entry => [Number(entry?.uid), entry]));
    const result = { book, entries: active.length, missingNodeSummaries: [], unassignedEntries: [], missingKeywords: [], oversizedEntries: [], mergeCandidates: [] };

    for (const node of nodes.filter(node => (node.entryUids?.length || node.children?.length) && !clean(node.summary))) {
        const base = findingBase({
            category: HOUSEKEEPER_FINDING_CATEGORY.MISSING_NODE_SUMMARY,
            locator: { book, nodeId: node.id },
            title: node.label || 'Unnamed Tree node',
            book,
            provenance: { scope: 'tree-node', book, nodeId: node.id },
            sourceFingerprint: treeNodeCanonicalFingerprint(book, node),
            deterministicEvidence: { reason: 'Tree node contains assigned entries or children but has no node summary.', nodeId: node.id, label: node.label || 'Unnamed', entryCount: node.entryUids?.length || 0, childCount: node.children?.length || 0 },
        });
        result.missingNodeSummaries.push({ nodeId: node.id, label: node.label || 'Unnamed', ...base });
    }
    for (const entry of active.filter(entry => !assigned.has(Number(entry.uid)))) {
        const nodeId = currentNodeForUid(tree, Number(entry.uid))?.id || null;
        const base = findingBase({
            category: HOUSEKEEPER_FINDING_CATEGORY.UNASSIGNED,
            locator: { book, uid: Number(entry.uid) },
            title: entry.comment || `UID ${entry.uid}`,
            book,
            provenance: { scope: 'lore-entry', book, uid: Number(entry.uid), nodeId },
            sourceFingerprint: entryCanonicalFingerprint(book, entry, nodeId),
            deterministicEvidence: { reason: 'Active lore entry is not assigned to a Tree node.', uid: Number(entry.uid), title: entry.comment || `UID ${entry.uid}` },
        });
        result.unassignedEntries.push({ uid: Number(entry.uid), title: entry.comment || `UID ${entry.uid}`, ...base });
    }
    for (const entry of active.filter(entry => !(entry.key || []).map(clean).filter(Boolean).length)) {
        const nodeId = currentNodeForUid(tree, Number(entry.uid))?.id || null;
        const base = findingBase({
            category: HOUSEKEEPER_FINDING_CATEGORY.KEYWORD_REVIEW,
            locator: { book, uid: Number(entry.uid) },
            title: entry.comment || `UID ${entry.uid}`,
            book,
            provenance: { scope: 'lore-entry', book, uid: Number(entry.uid), nodeId },
            sourceFingerprint: entryCanonicalFingerprint(book, entry, nodeId),
            deterministicEvidence: { reason: 'Active lore entry has no usable keywords.', uid: Number(entry.uid), title: entry.comment || `UID ${entry.uid}` },
        });
        result.missingKeywords.push({ uid: Number(entry.uid), title: entry.comment || `UID ${entry.uid}`, ...base });
    }
    const overloadCandidates = [];
    for (const entry of active.filter(entry => String(entry.content || '').length >= oversizedEntryChars)) {
        const nodeId = currentNodeForUid(tree, Number(entry.uid))?.id || null;
        const chars = String(entry.content || '').length;
        const canonicalEntry = clone(entry);
        const overloadContext = { book, entry: { uid: Number(entry.uid), title: entry.comment || `UID ${entry.uid}`, content: String(entry.content || ''), nodeId }, canonicalEntry, nodeId };
        const eligibility = housekeeperSemanticOverloadEligibility(overloadContext);
        const sourceFingerprint = housekeeperSemanticOverloadFingerprint(overloadContext);
        const base = findingBase({
            category: HOUSEKEEPER_FINDING_CATEGORY.OVERSIZED,
            locator: { book, uid: Number(entry.uid) },
            title: entry.comment || `UID ${entry.uid}`,
            book,
            provenance: { scope: 'semantic-overload-entry', book, uid: Number(entry.uid), nodeId },
            sourceFingerprint,
            deterministicEvidence: { reason: 'Entry exceeds the configured deterministic size threshold.', uid: Number(entry.uid), chars, thresholdChars: oversizedEntryChars, semanticShadowEligible: eligibility.eligible, semanticShadowReason: eligibility.reason },
        });
        result.oversizedEntries.push({ uid: Number(entry.uid), title: entry.comment || `UID ${entry.uid}`, chars, ...base, decisionEvidence: { entry: { uid: Number(entry.uid), title: entry.comment || `UID ${entry.uid}`, nodeId, content: String(entry.content || '') } } });
        overloadCandidates.push({ ...overloadContext, findingId: base.id, sourceFingerprint });
    }

    try {
        const mergeRows = await scanMergeCandidates(book, { thresholdPercent: Math.max(10, Number(settings?.housekeeper?.mergeThresholdPercent) || 65), limit: Math.max(1, Number(settings?.housekeeper?.maxMergeSuggestions) || 12), sourceData: data, sourceTree: tree });
        const assistPairs = [];
        for (const row of mergeRows) {
            const left = byUid.get(Number(row.uidA)), right = byUid.get(Number(row.uidB));
            if (!left || !right) continue;
            const pair = {
                book,
                similarity: { percent: row.percent, titlePercent: row.titlePercent, contentPercent: row.contentPercent, sameNode: row.sameNode === true },
                left: { uid: Number(left.uid), title: left.comment || row.titleA || '', content: String(left.content || ''), nodeId: row.nodeA || currentNodeForUid(tree, Number(left.uid))?.id || null },
                right: { uid: Number(right.uid), title: right.comment || row.titleB || '', content: String(right.content || ''), nodeId: row.nodeB || currentNodeForUid(tree, Number(right.uid))?.id || null },
            };
            const ordered = [Number(row.uidA), Number(row.uidB)].sort((a, b) => a - b);
            const sourceFingerprint = housekeeperPairFingerprint(pair);
            const base = findingBase({
                category: HOUSEKEEPER_FINDING_CATEGORY.MERGE_CANDIDATE,
                locator: { book, uidA: ordered[0], uidB: ordered[1] },
                title: `UID ${row.uidA} ↔ UID ${row.uidB}`,
                book,
                provenance: { scope: 'merge-pair', book, uidA: Number(row.uidA), uidB: Number(row.uidB), nodeA: pair.left.nodeId, nodeB: pair.right.nodeId },
                sourceFingerprint,
                deterministicEvidence: { reason: 'Pair met Housekeeper deterministic merge-similarity threshold.', percent: row.percent, titlePercent: row.titlePercent, contentPercent: row.contentPercent, sameNode: row.sameNode === true, uidA: row.uidA, titleA: row.titleA, uidB: row.uidB, titleB: row.titleB, nodeA: pair.left.nodeId, nodeB: pair.right.nodeId, nodeLabelA: row.nodeLabelA || null, nodeLabelB: row.nodeLabelB || null },
            });
            result.mergeCandidates.push({ ...row, ...base, decisionEvidence: { pair: { similarity: pair.similarity, left: pair.left, right: pair.right } } });
            assistPairs.push({ ...pair, findingId: base.id, sourceFingerprint });
        }
        // Internal-only evidence for bounded Decision Core Assist. Non-enumerable keeps
        // canonical source bodies out of reports, Sidecar prompts and snapshots.
        Object.defineProperty(result, '_decisionAssistPairs', { value: assistPairs, enumerable: false, configurable: false });
        Object.defineProperty(result, '_decisionOverloadCandidates', { value: overloadCandidates, enumerable: false, configurable: false });
    } catch (error) {
        result.mergeError = error?.message || String(error);
        Object.defineProperty(result, '_decisionAssistPairs', { value: [], enumerable: false, configurable: false });
        Object.defineProperty(result, '_decisionOverloadCandidates', { value: overloadCandidates, enumerable: false, configurable: false });
    }
    return result;
}

function memoryFindings(memory) {
    return (memory?.issues || []).map(issue => {
        const coverage = issue.kind === 'coverage-gap';
        const category = coverage ? HOUSEKEEPER_FINDING_CATEGORY.SUMMARY_COVERAGE_REVIEW : HOUSEKEEPER_FINDING_CATEGORY.MEMORY_REPAIR_REVIEW;
        const locator = coverage ? { range: issue.coverageRange || null } : { kind: issue.kind, memoryId: issue.memoryId || null, coverageId: issue.coverageId || null, fallback: issue.memoryId || issue.coverageId ? null : (issue.detail || '') };
        return findingBase({
            category,
            locator,
            title: coverage ? `Summary coverage ${issue.coverageRange?.[0]}–${issue.coverageRange?.[1]}` : `Memory ${issue.kind || 'review'}`,
            provenance: { scope: 'memory', kind: issue.kind, memoryId: issue.memoryId || null, coverageId: issue.coverageId || null, coverageRange: issue.coverageRange || null },
            sourceFingerprint: issue.sourceFingerprint || findingFingerprint({ issue, coverage: memory.coverageAuthority || null }),
            deterministicEvidence: { reason: issue.detail || 'Memory Bank reported a maintenance condition.', ...clone(issue) },
        });
    });
}
function flattenFindings(report) {
    return [
        ...report.books.flatMap(book => [book.missingNodeSummaries, book.unassignedEntries, book.missingKeywords, book.oversizedEntries, book.mergeCandidates].flat()),
        ...memoryFindings(report.memory),
    ].map(row => ({ id: row.id, category: row.category, title: row.title, book: row.book ?? null, provenance: row.provenance, sourceFingerprint: row.sourceFingerprint, freshness: row.freshness || HOUSEKEEPER_FRESHNESS.CURRENT, deterministicEvidence: row.deterministicEvidence, decisionEvidence: row.decisionEvidence || null, decisionTriage: row.decisionTriage || null, decisionShadow: row.decisionShadow || null, detectedAt: row.detectedAt || report.startedAt }));
}

function compactForSidecar(report) {
    const compact = row => ({ findingId: row.id, category: row.category, uid: row.uid ?? null, nodeId: row.nodeId ?? null, title: row.title || row.label || '', chars: row.chars ?? null, percent: row.percent ?? null, uidA: row.uidA ?? null, titleA: row.titleA ?? null, uidB: row.uidB ?? null, titleB: row.titleB ?? null, detail: row.deterministicEvidence?.reason || null });
    return {
        books: report.books.map(book => ({
            book: book.book,
            entries: book.entries,
            missingNodeSummaries: book.missingNodeSummaries.slice(0, 12).map(compact),
            unassignedEntries: book.unassignedEntries.slice(0, 12).map(compact),
            missingKeywords: book.missingKeywords.slice(0, 12).map(compact),
            oversizedEntries: book.oversizedEntries.slice(0, 12).map(compact),
            mergeCandidates: book.mergeCandidates.slice(0, 12).map(compact),
        })),
        memory: {
            ok: report.memory.ok,
            issueCount: report.memory.issues?.length || 0,
            coverageAuthority: report.memory.coverageAuthority,
            issues: (report.memory.issues || []).slice(0, 12).map(issue => ({ kind: issue.kind, memoryId: issue.memoryId || null, coverageId: issue.coverageId || null, coverageRange: issue.coverageRange || null, detail: issue.detail || '' })),
        },
    };
}

async function refreshHousekeeperFindingFreshness(findings = []) {
    const bookCache = new Map();
    async function bookState(book) {
        if (!bookCache.has(book)) bookCache.set(book, Promise.all([loadBook(book), Promise.resolve(getTree(book))]).then(([data, tree]) => ({ data, tree, byUid: new Map(Object.values(data?.entries || {}).map(entry => [Number(entry?.uid), entry])) })));
        return bookCache.get(book);
    }
    let currentMemoryMap = null;
    async function memoryMap() {
        if (!currentMemoryMap) {
            const memory = scanHousekeeperMemory();
            currentMemoryMap = new Map(memoryFindings(memory).map(row => [row.id, row.sourceFingerprint]));
        }
        return currentMemoryMap;
    }
    await Promise.all((Array.isArray(findings) ? findings : []).map(async finding => {
        let currentFingerprint = null;
        try {
            const p = finding.provenance || {};
            if (p.scope === 'tree-node') {
                const { tree } = await bookState(p.book);
                const node = currentTreeNode(tree, p.nodeId);
                currentFingerprint = node ? treeNodeCanonicalFingerprint(p.book, node) : `missing:${p.book}:${p.nodeId}`;
            } else if (p.scope === 'lore-entry') {
                const { tree, byUid } = await bookState(p.book);
                const entry = byUid.get(Number(p.uid));
                currentFingerprint = entry ? entryCanonicalFingerprint(p.book, entry, currentNodeForUid(tree, Number(p.uid))?.id || null) : `missing:${p.book}:${p.uid}`;
            } else if (p.scope === 'semantic-overload-entry') {
                const { tree, byUid } = await bookState(p.book);
                const entry = byUid.get(Number(p.uid));
                currentFingerprint = entry ? housekeeperSemanticOverloadFingerprint({ book: p.book, canonicalEntry: entry, nodeId: currentNodeForUid(tree, Number(p.uid))?.id || null }) : `missing:${p.book}:${p.uid}`;
            } else if (p.scope === 'merge-pair') {
                const { tree, byUid } = await bookState(p.book);
                const left = byUid.get(Number(p.uidA)), right = byUid.get(Number(p.uidB));
                currentFingerprint = left && right ? housekeeperPairFingerprint({ book: p.book, left: { uid: Number(left.uid), title: left.comment || '', content: left.content || '', nodeId: currentNodeForUid(tree, Number(left.uid))?.id || null }, right: { uid: Number(right.uid), title: right.comment || '', content: right.content || '', nodeId: currentNodeForUid(tree, Number(right.uid))?.id || null } }) : `missing:${p.book}:${p.uidA}:${p.uidB}`;
            } else if (p.scope === 'memory') currentFingerprint = (await memoryMap()).get(finding.id) || `resolved:${finding.id}`;
        } catch { currentFingerprint = `unavailable:${finding.id}`; }
        finding.currentSourceFingerprint = currentFingerprint;
        finding.freshness = String(currentFingerprint || '') === String(finding.sourceFingerprint || '') ? HOUSEKEEPER_FRESHNESS.CURRENT : HOUSEKEEPER_FRESHNESS.STALE;
    }));
    return findings;
}


/** Recheck one persisted diagnostic finding against current canonical sources. */
export async function recheckHousekeeperFinding(findingId) {
    const state = getHousekeeperDiagnosticState();
    const finding = state.latestFindings?.[String(findingId || '')];
    if (!finding) return { ok: false, reason: 'finding-not-current' };
    const rows = await refreshHousekeeperFindingFreshness([finding]);
    const current = rows[0];
    recordHousekeeperFindingFreshness({ findingId: current.id, freshness: current.freshness, currentSourceFingerprint: current.currentSourceFingerprint });
    return { ok: current.freshness === HOUSEKEEPER_FRESHNESS.CURRENT, reason: current.freshness === HOUSEKEEPER_FRESHNESS.CURRENT ? null : 'finding-stale', finding: clone(current) };
}

function applyFreshnessToBookRows(report) {
    const byId = new Map((report.findings || []).map(row => [row.id, row]));
    for (const book of report.books || []) for (const list of [book.missingNodeSummaries, book.unassignedEntries, book.missingKeywords, book.oversizedEntries, book.mergeCandidates]) for (const row of list || []) {
        const live = byId.get(row.id); if (!live) continue; row.freshness = live.freshness; row.currentSourceFingerprint = live.currentSourceFingerprint;
    }
}
function finalizeReport(report, status) {
    report.finishedAt = report.finishedAt || Date.now();
    report.status = status;
    report.successful = status === 'COMPLETE' && !report.failed && !report.deferred && !report.skipped && !report.stale && !report.incomplete && !report.adviceError;
    lastAttemptAt = report.finishedAt;
    if (report.successful) lastSuccessfulRunAt = report.finishedAt;
    lastReport = report;
    recordHousekeeperRun(report);
    return report;
}

const HOUSEKEEPER_TRIAGE_CONCURRENCY = 4;
function decisionTriageSnapshot(row, result = null) {
    return { route:row?.route||'DEFER', priority:Number.isFinite(Number(row?.priority))?Number(row.priority):null, semanticReview:Number.isFinite(Number(row?.semanticReview))?Number(row.semanticReview):null, confidence:Number.isFinite(Number(row?.confidence))?Number(row.confidence):null, uncertain:row?.uncertain!==false, sidecarRequired:row?.sidecarRequired!==false, reason:row?.reason||'unresolved', provider:result?.provider||null, providerClass:result?.providerClass||null, providerModel:result?.providerModel||null, sourceFingerprint:result?.sourceFingerprint||null, stale:result?.stale===true };
}
function sidecarFindingPacket(row = {}) {
    return { findingId:row.id, category:row.category, book:row.book??null, title:row.title||'', provenance:row.provenance||null, deterministicEvidence:row.deterministicEvidence||null, semanticEvidence:row.decisionEvidence||null, triage:row.decisionTriage||null };
}
async function runHousekeeperDecisionTriage({ report, targets, settings } = {}) {
    const findings=Array.isArray(report?.findings)?report.findings:[],chunks=[];
    for(let offset=0;offset<findings.length;offset+=MAINTENANCE_DECISION_MAX)chunks.push(findings.slice(offset,offset+MAINTENANCE_DECISION_MAX));
    const outcomes=new Array(chunks.length);let cursor=0;
    const workers=Array.from({length:Math.max(1,Math.min(HOUSEKEEPER_TRIAGE_CONCURRENCY,chunks.length||1))},async()=>{
        while(cursor<chunks.length){const index=cursor++,chunk=chunks[index],context={sourceSignature:report.sourceSignature,maintenanceScope:{runId:report.runId,books:targets,chunkIndex:index},findings:chunk};context.readCurrentFreshnessContext=()=>({...context,sourceSignature:housekeeperSourceSignature(targets,settings)});
            try{const run=await runDecisionSiteThroughDirector(MAINTENANCE_FINDING_TRIAGE_SITE_ID,context,{source:'housekeeper-finding-triage',mode:'assist'}),result=run?.decision||null;outcomes[index]={chunk,result,interpreted:interpretMaintenanceFindingTriage(result,chunk),error:null};}
            catch(error){outcomes[index]={chunk,result:null,interpreted:null,error};}
        }
    });
    await Promise.all(workers);
    const sidecarIds=new Set();let handledCount=0,deterministicOnlyCount=0,operatorOnlyCount=0,unresolvedCount=0,staleCount=0;
    for(const outcome of outcomes){const interpreted=outcome?.interpreted;if(!interpreted?.handled){unresolvedCount+=outcome?.chunk?.length||0;if(outcome?.result?.stale)staleCount+=outcome?.chunk?.length||0;for(const finding of outcome?.chunk||[]){finding.decisionTriage=decisionTriageSnapshot({route:'DEFER',uncertain:true,sidecarRequired:true,reason:interpreted?.reason||(outcome?.error?'decision-error':'decision-unavailable')},outcome?.result);sidecarIds.add(finding.id);}continue;}
        handledCount+=outcome.chunk.length;for(const row of interpreted.rows||[]){const finding=row.finding;finding.decisionTriage=decisionTriageSnapshot(row,outcome.result);if(row.sidecarRequired)sidecarIds.add(finding.id);else if(row.route==='DETERMINISTIC')deterministicOnlyCount+=1;else if(row.route==='OPERATOR')operatorOnlyCount+=1;}
    }
    const sidecarFindings=findings.filter(row=>sidecarIds.has(row.id)),summary={offeredCount:findings.length,chunkCount:chunks.length,handledCount,deterministicOnlyCount,operatorOnlyCount,sidecarCandidateCount:sidecarFindings.length,unresolvedCount,staleCount,concurrency:HOUSEKEEPER_TRIAGE_CONCURRENCY};
    logEvent('maintenance','housekeeper-triage-complete',{...summary,skippedSidecarCount:Math.max(0,findings.length-sidecarFindings.length),canonicalReadCounts:report.canonicalReadCounts,routes:findings.map(row=>({findingId:row.id,category:row.category,route:row.decisionTriage?.route||'DEFER',sidecarRequired:row.decisionTriage?.sidecarRequired!==false,uncertain:row.decisionTriage?.uncertain!==false}))},unresolvedCount||staleCount?'warn':'info');
    return{sidecarFindings,outcomes,summary};
}

/**
 * Proposal-first maintenance. It only reports potentially useful review work;
 * it neither modifies lore nor automatically stages a destructive operation.
 */
export async function runHousekeeper({ force = false, cadenceDue = false, books = null, enqueueSidecar = null, directorMeta = null } = {}) {
    const settings = getSettings();
    if (!settings.enabled) return { skipped: true, successful: false, status: 'SKIPPED', reason: 'disabled' };
    if (settings.housekeeper?.enabled === false) return { skipped: true, successful: false, status: 'SKIPPED', reason: 'housekeeper-disabled' };
    if (!housekeeperIsDue({ force, cadenceDue })) return { skipped: true, successful: false, status: 'SKIPPED', reason: 'lifecycle-cadence-required' };

    const corpus=captureLoreCorpus({books:Array.isArray(books)?books:null,purpose:getContext()?.chatId!=null||getContext()?.chat_id!=null?'story':'maintenance',requireTree:false,access:'read',injection:'any'});
    const selected=[...corpus.books].filter(book=>hasTree(book));
    const maxBooks = Math.max(1, Number(settings.housekeeper?.maxBooksPerRun) || 4);
    let targets;
    if (Array.isArray(books)) targets = selected.slice(0, maxBooks);
    else {
        const signature = selected.join('\u0000');
        if (signature !== automaticBookSignature) { automaticBookSignature = signature; automaticBookCursor = 0; }
        const count = Math.min(maxBooks, selected.length);
        targets = Array.from({ length: count }, (_, offset) => selected[(automaticBookCursor + offset) % selected.length]);
        if (selected.length) automaticBookCursor = (automaticBookCursor + count) % selected.length;
    }
    if (!targets.length) return { skipped: true, successful: false, status: 'SKIPPED', reason: 'no-readable-tree-books' };

    // This is the only automatic reuse gate. A matching finding list is not
    // sufficient: canonical lore/Tree + Memory evidence revisions and the
    // deterministic audit configuration must all still be identical.
    const sourceSignature=housekeeperSourceSignature(targets,settings);
    if (!force && lastReport?.successful === true && lastReport?.sourceSignature === sourceSignature && !lastReport?.adviceError) {
        const validatedSignature=housekeeperSourceSignature(targets,settings);
        if (validatedSignature === sourceSignature) {
            const reused={
                runId:`hk-run-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
                startedAt:Date.now(),
                books:clone(lastReport.books||[]),
                memory:clone(lastReport.memory||{}),
                findings:clone(lastReport.findings||[]),
                findingCount:Number(lastReport.findingCount)||0,
                findingFingerprint:lastReport.findingFingerprint||null,
                advice:Array.isArray(lastReport.advice)?clone(lastReport.advice):[],
                sidecarSlot:null,
                reusedAdviceSlot:lastReport.sidecarSlot||lastReport.reusedAdviceSlot||null,
                adviceFreshness:'CURRENT',
                adviceReused:true,
                earlyReuse:true,
                sidecarSkipped:true,
                sidecarSkipReason:'canonical-evidence-unchanged',
                sourceSignature,
                currentSourceSignature:validatedSignature,
                canonicalReadCounts:{lore:0,tree:0,memory:0},
            };
            logEvent('maintenance','housekeeper-early-reuse-hit',{
                books:targets,
                sourceSignature,
                priorRunId:lastReport.runId||null,
                findingCount:reused.findingCount,
                adviceCount:reused.advice.length,
                canonicalReadCounts:reused.canonicalReadCounts,
            },'info');
            return finalizeReport(reused,'COMPLETE');
        }
    }
    logEvent('maintenance','housekeeper-early-reuse-miss',{
        books:targets,
        sourceSignature,
        reason:force?'force-scan':lastReport?.successful===true?'canonical-evidence-changed':'no-successful-prior-run',
    },'debug');

    const report={
        runId:`hk-run-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
        startedAt:Date.now(),
        books:[],
        memory:null,
        findings:[],
        advice:[],
        sidecarSlot:null,
        adviceFreshness:null,
        sourceSignature,
        currentSourceSignature:sourceSignature,
        earlyReuse:false,
        canonicalReadCounts:{lore:0,tree:0,memory:0},
    };
    report.canonicalReadCounts.memory+=1;
    report.memory=scanHousekeeperMemory();

    for (const book of targets) {
        try {
            report.canonicalReadCounts.lore+=1;
            const data=await loadBook(book);
            report.canonicalReadCounts.tree+=1;
            const tree=getTree(book);
            if(!tree?.root)throw new Error(`Housekeeper Tree source disappeared for "${book}".`);
            report.books.push(await scanBook(book,settings,{sourceData:data,sourceTree:tree}));
        } catch (error) {
            report.books.push({ book, error: error?.message || String(error), entries: 0, missingNodeSummaries: [], unassignedEntries: [], missingKeywords: [], oversizedEntries: [], mergeCandidates: [] });
        }
    }

    // Deterministic scans are the canonical finding authority. Semantic triage
    // runs exactly once per finding after the canonical set is complete.

    report.findings = flattenFindings(report);
    report.findingCount = report.findings.length;
    const compactAudit = compactForSidecar(report);
    report.findingFingerprint = findingFingerprint(compactAudit);

    const markSourceStale=(reason)=>{
        const current=housekeeperSourceSignature(targets,settings);
        report.currentSourceSignature=current;
        if(current===report.sourceSignature)return false;
        report.stale=true;
        report.failed=true;
        report.reason=String(reason||'housekeeper-source-changed');
        for(const finding of report.findings||[]){
            finding.freshness=HOUSEKEEPER_FRESHNESS.STALE;
            finding.currentSourceFingerprint=`source-signature:${current}`;
        }
        applyFreshnessToBookRows(report);
        report.staleFindingCount=(report.findings||[]).length;
        return true;
    };

    const scanErrors = report.books.filter(book => book?.error || book?.mergeError);
    if (scanErrors.length) {
        report.incomplete = true;
        report.failed = true;
        report.reason = 'housekeeper-scan-incomplete';
        report.scanErrors = scanErrors.map(row => ({ book: row.book, error: row.error || row.mergeError }));
        report.adviceFreshness = 'NOT_RUN';
        logEvent('maintenance', 'housekeeper-incomplete', {
            books:targets,
            scanErrors:report.scanErrors,
            findingCount:report.findingCount,
            canonicalReadCounts:report.canonicalReadCounts,
        }, 'warn');
        return finalizeReport(report, 'FAILED');
    }

    // A source change during deterministic/Jev inspection invalidates the pass
    // before any downstream review worker can publish advice.
    if(markSourceStale('source-changed-during-housekeeper-scan')){
        report.adviceFreshness='STALE';
        logEvent('maintenance','housekeeper-source-stale',{
            books:targets,
            phase:'post-scan',
            sourceSignature:report.sourceSignature,
            currentSourceSignature:report.currentSourceSignature,
            canonicalReadCounts:report.canonicalReadCounts,
        },'warn');
        return finalizeReport(report,'STALE');
    }

    if (report.findingCount === 0) {
        report.advice=[];report.sidecarSkipped=true;report.sidecarSkipReason='no-deterministic-findings';report.adviceFreshness='CURRENT';
        report.triage={offeredCount:0,chunkCount:0,handledCount:0,deterministicOnlyCount:0,operatorOnlyCount:0,sidecarCandidateCount:0,unresolvedCount:0,staleCount:0,concurrency:HOUSEKEEPER_TRIAGE_CONCURRENCY};
        logEvent('maintenance','housekeeper-no-findings',{books:targets,findingFingerprint:report.findingFingerprint,sourceSignature:report.sourceSignature,canonicalReadCounts:report.canonicalReadCounts},'info');
        return finalizeReport(report,'COMPLETE');
    }
    const triage=await runHousekeeperDecisionTriage({report,targets,settings});report.triage=triage.summary;
    if(markSourceStale('source-changed-during-housekeeper-triage')){report.adviceFreshness='STALE';logEvent('maintenance','housekeeper-source-stale',{books:targets,phase:'post-triage',sourceSignature:report.sourceSignature,currentSourceSignature:report.currentSourceSignature,canonicalReadCounts:report.canonicalReadCounts},'warn');return finalizeReport(report,'STALE');}
    const sidecarFindings=triage.sidecarFindings;
    if(!sidecarFindings.length){report.advice=[];report.sidecarSkipped=true;report.sidecarSkipReason='decision-triage-resolved-without-sidecar';report.adviceFreshness='CURRENT';logEvent('maintenance','housekeeper-sidecar-skipped',{books:targets,findingCount:report.findingCount,triage:report.triage,canonicalReadCounts:report.canonicalReadCounts},'info');return finalizeReport(report,'COMPLETE');}

    const sidecarAudit={findings:sidecarFindings.map(sidecarFindingPacket)};
    const prompt = `Nexus HOUSEKEEPER REVIEW\n\nThis is a read-only, proposal-first maintenance review. Review ONLY the supplied finding IDs that Decision Core left unresolved or routed for generative explanation. Do not apply edits, approve changes, invent findings, or invent UIDs. Prefer a small set of actionable checks over a long recap.\n\nADMITTED FINDINGS\n${JSON.stringify(sidecarAudit)}\n\nReturn ONLY JSON: {"actions":[{"findingId":"exact supplied id","kind":"missing-summary|unassigned|merge-review|keyword-review|oversized-entry|memory-repair","book":"...","target":"UID/node label","priority":"high|medium|low","reason":"brief"}]}`;
    try {
        const enqueue = typeof enqueueSidecar === 'function' ? enqueueSidecar : (stage, options) => enqueueBusJob(stage, options);
        const job = enqueue(BUS_STAGE.MAINTENANCE, structuredSidecarOptions({
            prompt,
            systemPrompt: 'You are Nexus Housekeeper. Read the supplied audit and return a concise, non-mutating review queue as JSON only.',
            reasoningEffort: 'medium',
            maxTokens: 2048,
            priority: BUS_PRIORITY.MAINTENANCE,
            preemptible: true,
            maxAttempts: 1,
            dedupKey: force ? null : `housekeeper:${targets.join('|')}`,
            label: 'Housekeeper review',
            telemetry: { housekeeper: true, sourceSignature:report.sourceSignature, ...(directorMeta || {}) },
        }));
        const response = await job.promise;
        const parsed = parseJson(response.text);
        if (!Array.isArray(parsed?.actions)) throw new Error('Housekeeper review returned no valid actions array.');
        const allowedFindingIds=new Set(sidecarFindings.map(row=>String(row.id)));report.advice=parsed.actions.filter(action=>allowedFindingIds.has(String(action?.findingId||''))).slice(0,20);
        report.sidecarSlot = response?.tv2?.slot || null;
    } catch (error) {
        if (isIntentionalCancellation(error)) {
            report.deferred = true;
            report.reason = 'foreground-preempted';
            report.cancellation = error?.name || 'AbortError';
            logEvent('maintenance', 'housekeeper-deferred', { books: targets, reason: report.reason }, 'debug');
            return finalizeReport(report, 'DEFERRED');
        }
        report.adviceError = error?.message || String(error);
        report.failed = true;
    }

    const stale=markSourceStale('source-changed-during-housekeeper-review');
    if(!stale){
        report.staleFindingCount=0;
        report.adviceFreshness=report.adviceError?'FAILED':'CURRENT';
    }else report.adviceFreshness='STALE';

    report.finishedAt = Date.now();
    logEvent('maintenance', report.adviceError || report.stale ? 'housekeeper-incomplete' : 'housekeeper-complete', {
        books: targets,
        findingCount: report.findingCount,
        adviceCount: report.advice.length,
        memoryIssueCount: report.memory.issues?.length || 0,
        sidecarSlot: report.sidecarSlot,
        staleFindingCount: report.staleFindingCount||0,
        successful: !report.adviceError && !report.stale,
        sourceSignature:report.sourceSignature,
        currentSourceSignature:report.currentSourceSignature,
        canonicalReadCounts:report.canonicalReadCounts,
    }, report.adviceError || report.stale ? 'warn' : (report.findingCount ? 'warn' : 'info'));
    return finalizeReport(report, report.adviceError ? 'FAILED' : report.stale ? 'STALE' : 'COMPLETE');
}
