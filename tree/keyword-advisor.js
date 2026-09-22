import { loadBook, findEntryByUid } from '../lore/store.js';
import { getTree } from './store.js';
import { findNode, collectUids } from './model.js';
import { assertReadableBook } from '../lore/policy.js';
import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { NEXUS_BATCH_DOMAIN, structuredSidecarOptions } from '../nexus/batch-layer.js';
import { enqueueNexusModelWorkerJob } from '../nexus/model-worker-bus.js';
import { logEvent } from '../observability/telemetry.js';
import { TREE_KEYWORD_SAFETY_SITE_ID } from './keyword-decision-site.js';
import { startDecisionSiteThroughDirector } from '../decision/work-director-bridge.js';
import { currentNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function key(value) { return clean(value).toLowerCase(); }
function clamp(value, low = 0, high = 100) { return Math.max(low, Math.min(high, Math.round(Number(value) || 0))); }
function parseJson(text) {
    const raw = String(text || '').trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '');
    try { return JSON.parse(raw); } catch {}
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error('Keyword advisor did not return JSON.');
}

function keywordRate(keyword, entries = []) {
    const term = key(keyword);
    if (!term) return 100;
    const active = entries.filter(entry => entry?.disable !== true);
    if (!active.length) return 0;
    const hits = active.filter(entry => {
        const hay = [entry.comment, entry.content, ...(Array.isArray(entry.key) ? entry.key : [])].map(key).join('\n');
        return hay.includes(term);
    }).length;
    return clamp((hits / active.length) * 100);
}

function commonKeywordStats(entries = [], limit = 70) {
    const counts = new Map();
    for (const entry of entries.filter(entry => entry?.disable !== true)) {
        for (const raw of Array.isArray(entry.key) ? entry.key : []) {
            const keyword = clean(raw);
            const normalized = key(keyword);
            if (!normalized) continue;
            counts.set(normalized, { keyword, count: (counts.get(normalized)?.count || 0) + 1 });
        }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword)).slice(0, limit);
}

function normalizeSuggestions(rows, entries, existing = []) {
    const seen = new Set(existing.map(key));
    const output = [];
    for (const raw of Array.isArray(rows) ? rows : []) {
        const keyword = clean(raw?.keyword || raw?.term || raw);
        const normalized = key(keyword);
        if (!normalized || seen.has(normalized) || keyword.length > 120) continue;
        seen.add(normalized);
        output.push({
            keyword,
            confidence: clamp(raw?.confidence ?? raw?.confidencePercent ?? 65, 1, 99),
            accidentalFireRisk: keywordRate(keyword, entries),
            reason: clean(raw?.reason || raw?.why || 'Specific to this Tree scope.').slice(0, 240),
        });
        if (output.length >= 8) break;
    }
    return output;
}

/**
 * Model Worker-assisted keyword advice. The returned suggestions are deliberately
 * inert: the caller must explicitly copy a suggestion into a lore entry or
 * node and then save that object.
 */
export async function suggestKeywords({ book, uid = null, nodeId = null } = {}) {
    const lorebook = String(book || '').trim();
    if (!lorebook) throw new Error('Keyword suggestions require a lorebook.');
    assertReadableBook(lorebook);
    const data = await loadBook(lorebook);
    const entries = Object.values(data?.entries || {});
    const tree = getTree(lorebook);
    const entry = Number.isFinite(Number(uid)) ? findEntryByUid(data.entries, Number(uid)) : null;
    const node = nodeId ? findNode(tree?.root, String(nodeId)) : null;
    if (!entry && !node) throw new Error('Select a lore entry or Tree node first.');

    const nodeEntries = node
        ? collectUids(node).map(id => findEntryByUid(data.entries, id)).filter(Boolean)
        : [];
    const scope = entry
        ? {
            kind: 'lore entry',
            label: entry.comment || `UID ${entry.uid}`,
            currentKeywords: Array.isArray(entry.key) ? entry.key : [],
            source: `TITLE: ${entry.comment || ''}\nCONTENT:\n${String(entry.content || '').slice(0, 12000)}`,
        }
        : {
            kind: 'Tree node',
            label: node.label || 'Unnamed node',
            currentKeywords: Array.isArray(node.keywords) ? node.keywords : [],
            source: `NODE SUMMARY: ${node.summary || '(none)'}\nDIRECT/CHILD LORE:\n${nodeEntries.slice(0, 18).map(row => `- ${row.comment || `UID ${row.uid}`}: ${String(row.content || '').slice(0, 750)}`).join('\n')}`,
        };
    const stats = commonKeywordStats(entries);
    const prompt = `Nexus KEYWORD ADVISOR\n\nSuggest a small set of precise retrieval keywords for this ${scope.kind}. These are operator-reviewed hints, not commands. Avoid generic names, broad setting terms, and words likely to activate unrelated lore. Prefer distinctive phrases, aliases, proper nouns, or concise combinations that appear in the source.\n\nSCOPE\n${scope.source}\n\nCURRENT KEYWORDS\n${JSON.stringify(scope.currentKeywords)}\n\nCOMMON EXISTING LOREBOOK KEYWORDS (high counts are collision-prone)\n${JSON.stringify(stats)}\n\nReturn ONLY JSON: {\"suggestions\":[{\"keyword\":\"...\",\"confidence\":0-100,\"reason\":\"brief reason\"}]}`;
    const job = enqueueNexusModelWorkerJob(NEXUS_BATCH_DOMAIN.REASONING, BUS_STAGE.MAINTENANCE, structuredSidecarOptions({
        prompt,
        systemPrompt: 'You are Nexus keyword advisor. Suggest only precise, low-collision terms grounded in the supplied scope. Return JSON only.',
        reasoningEffort: 'medium',
        maxTokens: 2048,
        priority: BUS_PRIORITY.MAINTENANCE,
        scopeKind: 'independent',
        preemptible: true,
        maxAttempts: 1,
        dedupKey: `keyword-advice:${lorebook}:${entry ? `uid-${entry.uid}` : `node-${node.id}`}`,
        label: `Keyword advice · ${scope.label}`,
    }));
    const response = await job.promise;
    const parsed = parseJson(response.text);
    const suggestions = normalizeSuggestions(parsed?.suggestions, entries, scope.currentKeywords);
    try{
        const handle=startDecisionSiteThroughDirector(TREE_KEYWORD_SAFETY_SITE_ID,{
            book:lorebook,uid:entry?Number(entry.uid):null,title:scope.label,content:scope.source,existingKeywords:scope.currentKeywords,
            candidates:suggestions.map(row=>({keyword:row.keyword,collisionCount:row.accidentalFireRisk,collisionExamples:[]})),
            sourceFingerprint:`keyword:${lorebook}:${entry?`uid-${entry.uid}`:`node-${node.id}`}:${currentNexusLoreSourceRevision()}`,
            getCurrentFingerprint:()=>`keyword:${lorebook}:${entry?`uid-${entry.uid}`:`node-${node.id}`}:${currentNexusLoreSourceRevision()}`,
        },{source:'tree-keyword-safety-shadow',mode:'shadow'});
        handle?.promise?.catch?.(()=>{});
    }catch{}
    const result = {
        book: lorebook,
        uid: entry ? Number(entry.uid) : null,
        nodeId: node ? String(node.id) : null,
        suggestions,
        reasoning: clean(parsed?.reasoning || ''),
        slot: response?.tv2?.slot || null,
    };
    logEvent('tree', 'keyword-suggestions-complete', {
        book: lorebook,
        uid: result.uid,
        nodeId: result.nodeId,
        slot: result.slot,
        suggestionCount: suggestions.length,
        suggestions: suggestions.map(({ keyword, confidence, accidentalFireRisk }) => ({ keyword, confidence, accidentalFireRisk })),
    }, 'info');
    return result;
}
