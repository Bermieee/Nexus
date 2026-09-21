import { estimateContentTokens } from '../observability/token-estimator.js';

export const DEFAULT_BOOTSTRAP_TARGET_TOKENS = 3500;
export const DEFAULT_BOOTSTRAP_MAX_ENTRIES = 24;
export const DEFAULT_BOOTSTRAP_MIN_RELEVANCE_SCORE = 13;

function stableStringCompare(left, right) {
    const a=String(left ?? '').normalize('NFKC'), b=String(right ?? '').normalize('NFKC');
    return a < b ? -1 : a > b ? 1 : 0;
}

const STOPWORDS = new Set(`the a an and or but if then else of to in on at by for from with without into onto over under is are was were be been being am do does did doing have has had having can could would should will shall may might must not no yes this that these those it its they them their he him his she her hers we us our you your i me my as about after before during while when where why how what which who whom whose than too very just still again already also only even much many more most less least some any all each every both either neither such because so yet though although through across around between within out up down off back there here now later earlier today tomorrow yesterday said says say told tell asked ask looked looks look looking moved moves move moving scene current recent assistant user`.split(/\s+/));

function normalize(value='') { return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(); }
function representativeTrigrams(chars, limit = 64) {
    const maxStart = chars.length - 3;
    if (maxStart < 0) return chars.length ? [chars.join('')] : [];
    const count = Math.min(Math.max(1, Number(limit) || 64), maxStart + 1);
    const out = [];
    for (let n = 0; n < count; n++) {
        const i = count === 1 ? 0 : Math.round((n * maxStart) / (count - 1));
        out.push(chars.slice(i, i + 3).join(''));
    }
    return out;
}
function terms(value='') {
    const text = normalize(value);
    const raw = text.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) || [];
    const out = [];
    for (const token of raw) {
        if (/^[a-z0-9'_-]+$/.test(token)) {
            if (!STOPWORDS.has(token)) out.push(token);
            continue;
        }
        const chars = [...token].filter(ch => /[\p{L}\p{N}]/u.test(ch));
        if (chars.length <= 4) { if (chars.length) out.push(chars.join('')); continue; }
        out.push(...representativeTrigrams(chars));
    }
    return [...new Set(out)];
}
function containsBoundedPhrase(haystack, rawPhrase) {
    const phrase = normalize(rawPhrase);
    if (!phrase) return false;
    let from = 0;
    while (from <= haystack.length - phrase.length) {
        const at = haystack.indexOf(phrase, from);
        if (at < 0) return false;
        const before = at > 0 ? haystack[at - 1] : '';
        const afterAt = at + phrase.length;
        const after = afterAt < haystack.length ? haystack[afterAt] : '';
        if ((!before || !/[\p{L}\p{N}]/u.test(before)) && (!after || !/[\p{L}\p{N}]/u.test(after))) return true;
        from = at + Math.max(1, phrase.length);
    }
    return false;
}
function phraseHits(haystack, phrases = []) {
    let score = 0;
    for (const raw of phrases || []) {
        const phrase = normalize(raw);
        if (!phrase) continue;
        if (containsBoundedPhrase(haystack, phrase)) score += Math.min(120, 36 + phrase.length * 3);
    }
    return score;
}
function overlapScore(entryTerms, queryTerms, weight = 1, cap = 120) {
    if (!queryTerms.size || !entryTerms.length) return 0;
    let hits = 0;
    for (const term of entryTerms) if (queryTerms.has(term)) hits += 1;
    return Math.min(cap, hits * weight);
}
function relevanceScore(entry, sceneText, queryTerms) {
    const title = normalize(entry?.comment || entry?.title || '');
    const content = normalize(entry?.content || '');
    const primary = Array.isArray(entry?.key) ? entry.key : [];
    const secondary = Array.isArray(entry?.keysecondary) ? entry.keysecondary : [];
    let score = 0;
    if (title && containsBoundedPhrase(sceneText, title)) score += 100;
    score += phraseHits(sceneText, primary) * 1.6;
    score += phraseHits(sceneText, secondary) * 0.8;
    score += overlapScore(terms(title), queryTerms, 16, 96);
    score += overlapScore(terms(primary.join(' ')), queryTerms, 13, 104);
    score += overlapScore(terms(secondary.join(' ')), queryTerms, 7, 56);
    // Content overlap is intentionally weak. A stray prose word must not be
    // enough to suppress an entire native lorebook during bootstrap.
    score += overlapScore(terms(content), queryTerms, 2, 36);
    return score;
}
export function renderBootstrapEntry(row) {
    const title = String(row?.title || `UID ${row?.uid}`).trim();
    return `### ${row?.book} · ${title}\n${String(row?.content || '').trim()}`;
}
export function renderBootstrapPrompt(rows = []) {
    if (!rows.length) return '';
    return [
        '[NEXUS BOOTSTRAP LORE — deterministic pre-Tree admission]',
        'The following story-scoped lore was selected locally while the Nexus Tree is unavailable. Treat the included facts as authoritative lore context for this generation.',
        'This is a selective excerpt: absence of an entry is not evidence that the lore or fact does not exist.',
        '',
        ...[...rows].sort((a,b)=>stableStringCompare(a?.book,b?.book)||Number(a?.uid)-Number(b?.uid)||stableStringCompare(a?.title,b?.title)).map(renderBootstrapEntry),
    ].join('\n\n');
}
export function rankBootstrapEntries({ books = [], scene = '', bookData = new Map(), eligibleIds = null, model = '' } = {}) {
    const sceneText = normalize(scene);
    const queryTerms = new Set(terms(sceneText));
    const rows = [];
    let estimatedManagedCorpusTokens = 0;
    const bookStats = new Map();
    for (const book of books || []) {
        const data = bookData instanceof Map ? bookData.get(book) : bookData?.[book];
        const stats = { book:String(book), activeEntries:0, constantEntries:0, ambiguousUids:[], estimatedCorpusTokens:0, estimatedConstantTokens:0 };
        const activeEntries = Object.values(data?.entries || {}).filter(entry => entry?.disable !== true && String(entry?.content || '').trim() && Number.isFinite(Number(entry?.uid)));
        const uidCounts = new Map();
        for (const entry of activeEntries) uidCounts.set(Number(entry.uid), (uidCounts.get(Number(entry.uid)) || 0) + 1);
        stats.ambiguousUids = [...uidCounts.entries()].filter(([,count]) => count > 1).map(([uid]) => uid).sort((a,b)=>a-b);
        for (const entry of activeEntries) {
            const content = String(entry?.content || '').trim();
            const uid = Number(entry?.uid);
            const constant = entry?.constant === true;
            // Sleeping/non-eligible entries are outside this bootstrap candidate
            // corpus and must not consume foreground accounting work. Constants
            // remain eligible because native constant semantics must be preserved.
            if (eligibleIds && !constant && !eligibleIds.has(JSON.stringify([String(book),uid]))) continue;
            // Duplicate UIDs cannot form an unambiguous selective replacement.
            if ((uidCounts.get(uid) || 0) > 1) continue;
            const title = String(entry?.comment || entry?.title || `UID ${uid}`).trim();
            const rendered = renderBootstrapEntry({ book, uid, title, content });
            const tokenCost = estimateContentTokens(rendered, model);
            estimatedManagedCorpusTokens += tokenCost;
            stats.activeEntries += 1;
            stats.estimatedCorpusTokens += tokenCost;
            if (constant) { stats.constantEntries += 1; stats.estimatedConstantTokens += tokenCost; }
            const relevance = relevanceScore(entry, sceneText, queryTerms);
            // Constants are retained as mandatory context if this book becomes
            // bootstrap-covered, but constants alone never authorize suppression.
            if (relevance <= 0 && !constant) continue;
            const vectorPreferred=!!eligibleIds?.has?.(JSON.stringify([String(book),uid]));
            // Vector paging is a ranking hint, never an eligibility boundary.
            // A wrong-but-nonempty vector shortlist must not become authority
            // merely because it happens to include one row from every book.
            rows.push({ book:String(book), uid, title, content, constant, vectorPreferred, relevanceScore:relevance, score:relevance + (constant ? 12 : 0) + (vectorPreferred ? 8 : 0), tokenCost });
        }
        bookStats.set(String(book), stats);
    }
    rows.sort((a,b) => b.score - a.score || b.relevanceScore - a.relevanceScore || Number(b.constant) - Number(a.constant) || stableStringCompare(a.book,b.book) || a.uid - b.uid);
    return {
        rows,
        estimatedManagedCorpusTokens,
        // Compatibility alias for existing diagnostics/tests. This is corpus
        // size, not a promise that SillyTavern would have activated every token.
        estimatedNativeTokens:estimatedManagedCorpusTokens,
        queryTermCount:queryTerms.size,
        bookStats,
    };
}

/**
 * Pack only books for which Nexus can form a safe per-book replacement.
 * A book needs at least one strong scene-relevant anchor. If the book contains
 * native constant entries, every active constant entry must be carried into the
 * bootstrap replacement before that book is eligible for suppression.
 */
export function packBootstrapEntries(rows = [], {
    targetTokens = DEFAULT_BOOTSTRAP_TARGET_TOKENS,
    maxEntries = DEFAULT_BOOTSTRAP_MAX_ENTRIES,
    minRelevanceScore = DEFAULT_BOOTSTRAP_MIN_RELEVANCE_SCORE,
    model = '',
} = {}) {
    const target = Math.max(500, Number(targetTokens) || DEFAULT_BOOTSTRAP_TARGET_TOKENS);
    const max = Math.max(1, Math.floor(Number(maxEntries) || DEFAULT_BOOTSTRAP_MAX_ENTRIES));
    const minScore = Math.max(1, Number(minRelevanceScore) || DEFAULT_BOOTSTRAP_MIN_RELEVANCE_SCORE);
    const groups = new Map();
    for (const row of rows || []) {
        const book=String(row?.book||'').trim();if(!book)continue;
        if(!groups.has(book))groups.set(book,[]);
        groups.get(book).push(row);
    }
    const candidates=[...groups.entries()].map(([book,bookRows])=>{
        const anchors=bookRows.filter(row=>Number(row?.relevanceScore||0)>=minScore).sort((a,b)=>b.relevanceScore-a.relevanceScore||b.score-a.score||a.uid-b.uid);
        const constants=bookRows.filter(row=>row?.constant===true).sort((a,b)=>a.uid-b.uid);
        const required=[];const seen=new Set();
        for(const row of [...constants,...anchors.slice(0,1)]){const key=`${row.book}:${row.uid}`;if(seen.has(key))continue;seen.add(key);required.push(row);}
        return {book,bookRows,anchors,constants,required,topScore:Number(anchors[0]?.relevanceScore||0)};
    }).filter(group=>group.anchors.length>0)
      .sort((a,b)=>b.topScore-a.topScore||stableStringCompare(a.book,b.book));

    const selected=[];const selectedKeys=new Set();const coveredBooks=[];const skippedBooks=[];
    let tokens=0;
    const add=(row)=>{const key=JSON.stringify([String(row.book),Number(row.uid)]);if(selectedKeys.has(key))return;selectedKeys.add(key);selected.push(row);tokens+=Math.max(1,Number(row?.tokenCost)||estimateContentTokens(renderBootstrapEntry(row),model));};
    for(const group of candidates){
        if(group.required.length>max-selected.length){skippedBooks.push({book:group.book,reason:'required-entry-count-exceeds-budget'});continue;}
        const requiredTokens=group.required.reduce((sum,row)=>sum+Math.max(1,Number(row?.tokenCost)||1),0);
        // Bootstrap admission is a hard physical prompt budget. If the
        // mandatory replacement set cannot fit, native World Info must remain
        // authoritative for that book rather than silently overflowing target.
        if(tokens+requiredTokens>target){skippedBooks.push({book:group.book,reason:'shared-token-target'});continue;}
        for(const row of group.required)add(row);
        coveredBooks.push(group.book);
        if(tokens>=target||selected.length>=max)break;
    }
    if(coveredBooks.length&&tokens<target&&selected.length<max){
        const covered=new Set(coveredBooks);
        for(const row of rows){
            if(!covered.has(String(row?.book||'')))continue;
            const key=`${row.book}:${row.uid}`;if(selectedKeys.has(key))continue;
            const cost=Math.max(1,Number(row?.tokenCost)||estimateContentTokens(renderBootstrapEntry(row),''));
            if(tokens+cost>target)continue;
            add(row);
            if(tokens>=target||selected.length>=max)break;
        }
    }
    return { selected, coveredBooks, skippedBooks, estimatedContentTokens:tokens, targetTokens:target, maxEntries:max, minRelevanceScore:minScore };
}
