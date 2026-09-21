import { getActiveBooks } from '../lore/active-books.js';
import { loadBook, findEntryByUid, buildEntryUidMap } from '../lore/store.js';
import { getTree } from '../tree/store.js';
import { collectUids, findNode } from '../tree/model.js';
import { logEvent } from '../observability/telemetry.js';
import { cleanTreeRef, dedupeTreeRefs } from './state.js';
import { getCachedSearchIndex, setCachedSearchIndex, getSearchIndexRevision } from './search-index-cache.js';

function normalize(text) { return String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim(); }
const STOPWORDS = new Set(`the a an and or but if then else of to in on at by for from with without into onto over under is are was were be been being am do does did doing have has had having can could would should will shall may might must not no yes this that these those it its they them their he him his she her hers we us our you your i me my as about after before during while when where why how what which who whom whose than too very just still again already also only even much many more most less least some any all each every both either neither such because so yet though although through across around between within out up down off back there here now later earlier today tomorrow yesterday said says say told tell asked ask looked looks look looking moved moves move moving particular beat pause paused voice eyes hand hands room table turn turns response scene current recent assistant user`.split(/\s+/));
function representativeTrigrams(chars, limit = 96) {
    const maxStart = chars.length - 3;
    if (maxStart < 0) return chars.length ? [chars.join('')] : [];
    const count = Math.min(Math.max(1, Number(limit) || 96), maxStart + 1);
    const out = [];
    for (let n = 0; n < count; n++) {
        const i = count === 1 ? 0 : Math.round((n * maxStart) / (count - 1));
        out.push(chars.slice(i, i + 3).join(''));
    }
    return out;
}
function terms(text) {
    const value=normalize(text).toLowerCase();
    const raw=value.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)||[];
    const out=[];
    for(const token of raw){
        if(/^[a-z0-9'_-]+$/.test(token)){if(!STOPWORDS.has(token))out.push(token);continue;}
        const chars=[...token].filter(ch=>/[\p{L}\p{N}]/u.test(ch));
        if(chars.length<=4){if(chars.length)out.push(chars.join(''));continue;}
        out.push(...representativeTrigrams(chars));
    }
    // Foreground search cost must be bounded independently of arbitrary chat
    // length. Representative Unicode trigrams can multiply one token into many
    // terms, so cap the deduplicated query vocabulary deterministically.
    return [...new Set(out)].slice(0,96);
}
function entryKey(book, uid) { return JSON.stringify([String(book), Number(uid)]); }
function nodeKey(book, nodeId) { return JSON.stringify([String(book), String(nodeId)]); }
function entryTitle(entry, uid = null) { return String(entry?.comment || entry?.title || (uid == null ? '' : `UID ${uid}`)); }
function selectedBooksOrActive(books){ return Array.isArray(books) ? [...new Set(books.map(String))] : getActiveBooks({ requireTree: true, access: 'read' }); }

function containsBoundedPhrase(haystack, rawNeedle) {
    const needle = normalize(rawNeedle).toLowerCase();
    const source = String(haystack || '').toLowerCase();
    if (!needle) return false;
    let from = 0;
    while (from <= source.length - needle.length) {
        const at = source.indexOf(needle, from);
        if (at < 0) return false;
        const before = at > 0 ? source[at - 1] : '';
        const afterAt = at + needle.length;
        const after = afterAt < source.length ? source[afterAt] : '';
        if ((!before || !/[\p{L}\p{N}]/u.test(before)) && (!after || !/[\p{L}\p{N}]/u.test(after))) return true;
        from = at + Math.max(1, needle.length);
    }
    return false;
}
function tokenSet(value) { return new Set(terms(value)); }
function canonicalSearchOrder(a,b) {
    return Number(b.score||0)-Number(a.score||0)
        || String(a.title||'').localeCompare(String(b.title||''))
        || String(a.book||'').localeCompare(String(b.book||''))
        || Number(a.uid||0)-Number(b.uid||0)
        || String(a.nodeId||'').localeCompare(String(b.nodeId||''));
}
function codepointClip(value, maxChars=180) {
    const chars=Array.from(String(value||''));
    return chars.length>maxChars?`${chars.slice(0,maxChars).join('')}…`:chars.join('');
}

function walkPaths(node, parentPath = [], out = []) {
    if (!node) return out;
    const path = [...parentPath, node.label || 'Unnamed'];
    out.push({ node, path });
    for (const child of node.children || []) walkPaths(child, path, out);
    return out;
}

function treeMetrics(tree) {
    const rows = walkPaths(tree?.root);
    const pathById = new Map(rows.map(({node,path}) => [String(node.id), path]));
    const countById = new Map();
    const uidsById = new Map();
    const parentById = new Map();
    for (const { node } of rows) {
        for (const child of node.children || []) parentById.set(String(child.id), String(node.id));
    }
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const node = rows[index].node;
        const uids = new Set((node.entryUids || []).map(Number).filter(Number.isFinite));
        let count = uids.size;
        for (const child of node.children || []) {
            const childUids = uidsById.get(String(child.id)) || new Set();
            for (const uid of childUids) uids.add(uid);
            count += Number(countById.get(String(child.id)) || 0);
        }
        uidsById.set(String(node.id), uids);
        // Canonical Trees place each UID once; use the set size defensively if
        // malformed legacy data slips through a read boundary.
        countById.set(String(node.id), uids.size || count);
    }
    return { rows, pathById, countById, uidsById, parentById };
}

function refsAndAncestors(book, refs = [], metrics) {
    const covered = new Set();
    const known = new Set(metrics.rows.map(({ node }) => String(node.id)));
    for (const ref of refs || []) {
        if (String(ref?.book || '') !== String(book)) continue;
        let id = String(ref?.nodeId || '');
        if (!known.has(id)) continue;
        while (id && !covered.has(id)) {
            covered.add(id);
            id = metrics.parentById.get(id) || '';
        }
    }
    return covered;
}

function collapseOverlappingTreeRefs(refs = [], treeCache = new Map()) {
    const selectedByBook = new Map();
    for (const ref of refs) {
        if (!selectedByBook.has(ref.book)) selectedByBook.set(ref.book, new Set());
        selectedByBook.get(ref.book).add(String(ref.nodeId));
    }
    return refs.filter(ref => {
        const tree = treeCache.get(ref.book);
        const selected = selectedByBook.get(ref.book) || new Set();
        if (!tree?.root || selected.size < 2) return true;
        const path = [];
        const findPath = node => {
            if (!node) return false;
            path.push(String(node.id));
            if (String(node.id) === String(ref.nodeId)) return true;
            for (const child of node.children || []) if (findPath(child)) return true;
            path.pop();
            return false;
        };
        if (!findPath(tree.root)) return true;
        return !path.slice(0,-1).some(id => selected.has(id));
    });
}

function subtreeContainsNode(node, targetId) {
    if (!node || !targetId) return false;
    if (String(node.id) === String(targetId)) return true;
    return (node.children || []).some(child => subtreeContainsNode(child, targetId));
}

export function nodePath(tree, nodeId) {
    return treeMetrics(tree).pathById.get(String(nodeId)) || [];
}

export function topRegionForNode(tree, nodeId) {
    if (!tree?.root || !nodeId) return null;
    if (String(tree.root.id) === String(nodeId)) return tree.root.id;
    for (const child of tree.root.children || []) {
        if (subtreeContainsNode(child, nodeId)) return child.id;
    }
    return null;
}

export function topRegionRefForNode(book, tree, nodeId) {
    const id = topRegionForNode(tree, nodeId);
    return id ? { book: String(book), nodeId: String(id) } : null;
}

export function validateTreeRefs(refs = [], books = null) {
    const allowedBooks = new Set(selectedBooksOrActive(books));
    const treeCache = new Map();
    const nodeIdsByBook = new Map();
    const out = [];
    for (const ref of dedupeTreeRefs(refs)) {
        if (!allowedBooks.has(ref.book)) continue;
        if (!treeCache.has(ref.book)) {
            const tree = getTree(ref.book);
            treeCache.set(ref.book, tree);
            nodeIdsByBook.set(ref.book, new Set(treeMetrics(tree).rows.map(({node})=>String(node.id))));
        }
        if (!treeCache.get(ref.book)?.root || !nodeIdsByBook.get(ref.book)?.has(String(ref.nodeId))) continue;
        out.push(ref);
    }
    return out;
}


/** Structured, bounded region candidates for Decision Core. No model work. */
export function listRegionDecisionCandidates(books, { eligibleRegions = null, warmNodeRefs = [], pinnedNodeRefs = [] } = {}) {
    const out=[];
    for(const book of selectedBooksOrActive(books)){
        const tree=getTree(book);if(!tree?.root)continue;
        const metrics=treeMetrics(tree),warmCovered=refsAndAncestors(book,warmNodeRefs,metrics),pinnedCovered=refsAndAncestors(book,pinnedNodeRefs,metrics);
        if((tree.root.entryUids||[]).length){out.push({book:String(book),nodeId:String(tree.root.id),label:String(tree.root.label||'ROOT'),summary:normalize(tree.root.summary||''),keywords:[...(tree.root.keywords||[])].map(normalize).filter(Boolean),entryCount:Number(metrics.countById.get(String(tree.root.id))||0),rootDirect:true,warm:warmCovered.has(String(tree.root.id)),pinned:pinnedCovered.has(String(tree.root.id))});}
        for(const region of tree.root.children||[]){
            const key=JSON.stringify([String(book),String(region.id)]),warm=warmCovered.has(String(region.id)),pinned=pinnedCovered.has(String(region.id));
            if(eligibleRegions && !eligibleRegions.has(key) && !warm && !pinned)continue;
            out.push({book:String(book),nodeId:String(region.id),label:String(region.label||'Unnamed'),summary:normalize(region.summary||''),keywords:[...(region.keywords||[])].map(normalize).filter(Boolean),entryCount:Number(metrics.countById.get(String(region.id))||0),rootDirect:false,warm,pinned});
        }
    }
    return out;
}

/** Structured node candidates under exact selected regions for Decision Core. */
export function listNodeDecisionCandidates(regionRefs, { warmNodeRefs = [], pinnedNodeRefs = [] } = {}) {
    const validated=validateTreeRefs(regionRefs),treeCache=new Map([...new Set(validated.map(ref=>ref.book))].map(book=>[book,getTree(book)]));
    const roots=collapseOverlappingTreeRefs(validated,treeCache),out=[],seen=new Set();
    for(const ref of roots){
        const tree=treeCache.get(ref.book),metrics=treeMetrics(tree),warmCovered=refsAndAncestors(ref.book,warmNodeRefs,metrics),pinnedCovered=refsAndAncestors(ref.book,pinnedNodeRefs,metrics),node=tree?findNode(tree.root,ref.nodeId):null;
        if(!node)continue;
        const walk=(current,path=[])=>{
            const key=JSON.stringify([String(ref.book),String(current.id)]);if(seen.has(key))return;seen.add(key);
            const next=[...path,String(current.label||'Unnamed')];
            out.push({book:String(ref.book),nodeId:String(current.id),label:String(current.label||'Unnamed'),summary:normalize(current.summary||''),keywords:[...(current.keywords||[])].map(normalize).filter(Boolean),entryCount:Number(metrics.countById.get(String(current.id))||0),path:next,warm:warmCovered.has(String(current.id)),pinned:pinnedCovered.has(String(current.id)),leaf:(current.children||[]).length===0});
            for(const child of current.children||[])walk(child,next);
        };
        walk(node,[]);
    }
    return out;
}

/**
 * Compact first-pass routing view. Top-level Tree children are the canonical
 * regions; we expose a shallow preview of their descendants so the Sidecar can
 * route precisely without seeing the whole Tree at once.
 */
export function formatRegionOverview(books, { previewDepth = 2, warmNodeRefs = [], pinnedNodeRefs = [], eligibleRegions = null, rootDirectEntries = [] } = {}) {
    const depthLimit = Math.max(0, Number(previewDepth) || 0);
    const lines = [];
    for (const book of books || []) {
        const tree = getTree(book);
        if (!tree?.root) continue;
        lines.push(`Lorebook: ${book}`);
        const metrics = treeMetrics(tree);
        const warmCovered = refsAndAncestors(book, warmNodeRefs, metrics);
        const pinnedCovered = refsAndAncestors(book, pinnedNodeRefs, metrics);
        if ((tree.root.entryUids || []).length) {
            const exact = (rootDirectEntries || []).filter(row => String(row?.book || '') === String(book) && (tree.root.entryUids || []).some(uid => Number(uid) === Number(row?.uid)));
            const descriptors = exact.slice(0, 8).map(row => {
                const keys = (row?.keys || []).slice(0, 3).map(value => codepointClip(value)).filter(Boolean);
                return `${codepointClip(row?.title || `UID ${row?.uid}`, 120)}${keys.length ? ` [${keys.join(', ')}]` : ''}`;
            });
            lines.push(`  [book=${JSON.stringify(book)} node=${JSON.stringify(tree.root.id)}] ROOT (${tree.root.entryUids.length} direct entries${descriptors.length ? `; ${descriptors.join(' | ')}` : ''})`);
        }
        const render = (node, depth, topRegionId) => {
            const pad = '  '.repeat(depth + 1);
            const total = metrics.countById.get(String(node.id)) || 0;
            const direct = (node.entryUids || []).length;
            const flags = [];
            if (depth === 0) flags.push('REGION'); else flags.push('SUBREGION');
            if (warmCovered.has(String(node.id))) flags.push('WARM');
            if (pinnedCovered.has(String(node.id))) flags.push('PINNED');
            lines.push(`${pad}[book=${JSON.stringify(book)} node=${JSON.stringify(node.id)} region=${JSON.stringify(topRegionId)}] ${node.label || 'Unnamed'} (${direct} direct / ${total} total; ${flags.join(', ')})`);
            if (node.summary) lines.push(`${pad}  ${normalize(node.summary)}`);
            if (node.keywords?.length) lines.push(`${pad}  Keywords: ${node.keywords.map(normalize).filter(Boolean).join(', ')}`);
            if (depth >= depthLimit) return;
            for (const child of node.children || []) render(child, depth + 1, topRegionId);
        };
        for (const region of tree.root.children || []) {
            if (eligibleRegions && !eligibleRegions.has(JSON.stringify([String(book),String(region.id)])) && !warmCovered.has(String(region.id)) && !pinnedCovered.has(String(region.id))) continue;
            render(region, 0, region.id);
        }
        lines.push('');
    }
    return lines.join('\n').trim();
}

/** Full drill-down view restricted to region/subregion refs selected in pass 1. */
export function formatSelectedRegionOverview(regionRefs, { warmNodeRefs = [], pinnedNodeRefs = [], includeSummaries = true } = {}) {
    const validated = validateTreeRefs(regionRefs);
    const treeCache = new Map([...new Set(validated.map(ref=>ref.book))].map(book=>[book,getTree(book)]));
    const refs = collapseOverlappingTreeRefs(validated, treeCache);
    const lines = [];
    for (const ref of refs) {
        const tree = treeCache.get(ref.book);
        const metrics = treeMetrics(tree);
        const warmCovered = refsAndAncestors(ref.book, warmNodeRefs, metrics);
        const pinnedCovered = refsAndAncestors(ref.book, pinnedNodeRefs, metrics);
        const node = tree ? findNode(tree.root, ref.nodeId) : null;
        if (!node) continue;
        lines.push(`Lorebook: ${ref.book}`);
        const render = (current, depth = 0) => {
            const pad = '  '.repeat(depth);
            const total = metrics.countById.get(String(current.id)) || 0;
            const direct = (current.entryUids || []).length;
            const flags = [];
            if ((current.children || []).length) flags.push('branch'); else flags.push('leaf');
            if (warmCovered.has(String(current.id))) flags.push('WARM');
            if (pinnedCovered.has(String(current.id))) flags.push('PINNED');
            lines.push(`${pad}[book=${JSON.stringify(ref.book)} node=${JSON.stringify(current.id)}] ${current.label || 'Unnamed'} (${direct} direct / ${total} total; ${flags.join(', ')})`);
            if (includeSummaries && current.summary) lines.push(`${pad}  ${normalize(current.summary)}`);
            if (current.keywords?.length) lines.push(`${pad}  Keywords: ${current.keywords.map(normalize).filter(Boolean).join(', ')}`);
            for (const child of current.children || []) render(child, depth + 1);
        };
        if (String(node.id) === String(tree.root.id)) {
            const direct = (node.entryUids || []).length;
            lines.push(`  [book=${JSON.stringify(ref.book)} node=${JSON.stringify(node.id)}] ${node.label || 'ROOT'} (${direct} direct; ROOT direct-only)`);
            if (includeSummaries && node.summary) lines.push(`    ${normalize(node.summary)}`);
            if (node.keywords?.length) lines.push(`    Keywords: ${node.keywords.map(normalize).filter(Boolean).join(', ')}`);
        } else {
            render(node, 1);
        }
        lines.push('');
    }
    return lines.join('\n').trim();
}

/** Backward-compatible full Tree view used by the read-only Search tool. */
export function formatTreeOverview(books, { restrictRegionIds = [], warmNodeIds = [], includeSummaries = true, maxDepth = Infinity, maxNodes = Infinity, maxChars = Infinity } = {}) {
    const restrict = new Set((restrictRegionIds || []).map(String));
    const warm = new Set((warmNodeIds || []).map(String));
    const lines = [];
    let renderedNodes = 0;
    let truncated = false;
    const push = line => {
        const text=String(line||'');
        if (lines.join('\n').length + text.length + 1 > maxChars) { truncated=true; return false; }
        lines.push(text); return true;
    };
    for (const book of books || []) {
        const tree = getTree(book);
        if (!tree?.root) continue;
        if (!push(`Lorebook: ${book}`)) break;
        const roots = restrict.size ? (tree.root.children || []).filter(child => restrict.has(String(child.id))) : (tree.root.children || []);
        const render = (node, depth = 0) => {
            if (truncated || depth > maxDepth || renderedNodes >= maxNodes) { truncated=true; return; }
            const pad='  '.repeat(depth), total=collectUids(node).length, direct=(node.entryUids||[]).length;
            const flags=[warm.has(String(node.id))?'WARM':'',(node.children||[]).length?'branch':'leaf'].filter(Boolean).join(', ');
            if (!push(`${pad}[${node.id}] ${node.label || 'Unnamed'} (${direct} direct / ${total} total${flags?`; ${flags}`:''})`)) return;
            renderedNodes += 1;
            if (includeSummaries && node.summary && !push(`${pad}  ${normalize(node.summary)}`)) return;
            if (node.keywords?.length && !push(`${pad}  Keywords: ${node.keywords.map(normalize).filter(Boolean).join(', ')}`)) return;
            for (const child of node.children || []) render(child, depth + 1);
        };
        if ((tree.root.entryUids || []).length) {
            if (renderedNodes >= maxNodes) truncated=true;
            else if (push(`  [${tree.root.id}] Root (${tree.root.entryUids.length} direct)`)) renderedNodes += 1;
        }
        for (const child of roots) render(child, 1);
        if (!truncated) push('');
        if (truncated) break;
    }
    if (truncated) push('… [Tree overview truncated by Search safety bound]');
    return lines.join('\n').trim();
}

function scoreEntry(entry, pathText, nodeSummary, qTerms, rawQuery, boosts = {}, termWeights = new Map()) {
    const normalized=entry?._searchNormalized||{};
    const title = normalized.title ?? normalize(entry.title ?? entry.comment).toLowerCase();
    const content = normalized.content ?? normalize(entry.content).toLowerCase();
    const keys = normalized.keys ?? (entry.keys || entry.key || []).map(x => normalize(x).toLowerCase()).filter(Boolean);
    const secondaryKeys = normalized.secondaryKeys ?? (entry.secondaryKeys || entry.keysecondary || []).map(x => normalize(x).toLowerCase()).filter(Boolean);
    const path = normalized.path ?? normalize(pathText).toLowerCase();
    const summary = normalized.summary ?? normalize(nodeSummary).toLowerCase();
    const nodeKeywords = normalized.nodeKeywords ?? (entry.nodeKeywords || []).map(x=>normalize(x).toLowerCase()).filter(Boolean);
    const q = normalize(rawQuery).toLowerCase();
    const sets = { title:tokenSet(title), content:tokenSet(content), path:tokenSet(path), summary:tokenSet(summary), keys:keys.map(tokenSet), secondaryKeys:secondaryKeys.map(tokenSet), nodeKeywords:nodeKeywords.map(tokenSet) };
    let score = 0;
    const matched = [];
    if (q && title === q) { score += 20; matched.push('title-exact'); }
    else if (q && q.length < 180 && containsBoundedPhrase(title,q)) { score += 12; matched.push('title-phrase'); }
    if (q && keys.some(k => k === q)) { score += 16; matched.push('key-exact'); }
    else if (q && q.length < 180 && keys.some(k => containsBoundedPhrase(k,q))) { score += 10; matched.push('key-phrase'); }
    if (q && secondaryKeys.some(k => k === q)) { score += 9; matched.push('secondary-key-exact'); }
    else if (q && q.length < 180 && secondaryKeys.some(k => containsBoundedPhrase(k,q))) { score += 6; matched.push('secondary-key-phrase'); }
    if (q && q.length < 180 && containsBoundedPhrase(path,q)) { score += 8; matched.push('tree-path-phrase'); }
    if (q && q.length < 180 && containsBoundedPhrase(summary,q)) { score += 5; matched.push('node-summary-phrase'); }
    if (q && q.length < 180 && nodeKeywords.some(k=>containsBoundedPhrase(k,q))) { score += 7; matched.push('node-keyword-phrase'); }
    if (q && q.length < 180 && containsBoundedPhrase(content,q)) { score += 4; matched.push('content-phrase'); }

    let termHits = 0;
    for (const term of qTerms) {
        const weight = Number(termWeights.get(term)) || 1;
        let hit = false;
        if (sets.title.has(term)) { score += 4 * weight; hit = true; }
        if (sets.keys.some(set => set.has(term))) { score += 3.5 * weight; hit = true; }
        if (sets.secondaryKeys.some(set => set.has(term))) { score += 2 * weight; hit = true; }
        if (sets.path.has(term)) { score += 3 * weight; hit = true; }
        if (sets.summary.has(term)) { score += 2 * weight; hit = true; }
        if (sets.nodeKeywords.some(set => set.has(term))) { score += 2.5 * weight; hit = true; }
        if (sets.content.has(term)) { score += 1 * weight; hit = true; }

        if (hit) termHits += 1;
    }
    if (termHits) matched.push(`term-hits:${termHits}`);
    if (boosts.pinned) { score += 8; matched.push('pinned-boost'); }
    if (boosts.warm) { score += 4; matched.push('warm-boost'); }
    return { score, matched, termHits };
}

function buildTermWeights(index, qTerms) {
    const weights = new Map();
    const count = Math.max(1, index.length);
    for (const term of qTerms) {
        let df = 0;
        for (const row of index) {
            const fields = row._searchTerms || new Set(terms(row._searchText || ''));
            if (fields.has(term)) df += 1;
        }
        const idf = Math.log((count + 1) / (df + 1)) + 0.35;
        const prevalence = df / count;
        const damp = prevalence > 0.65 ? 0.18 : prevalence > 0.4 ? 0.4 : prevalence > 0.25 ? 0.7 : 1;
        weights.set(term, Math.max(0.08, idf * damp));
    }
    return weights;
}

async function cooperativeYield(counter,{yieldEvery=256,yieldFn=null}={}){
    if(counter<=0||counter%Math.max(32,Number(yieldEvery)||256)!==0)return;
    const fn=typeof yieldFn==='function'?yieldFn:()=>new Promise(resolve=>setTimeout(resolve,0));
    await fn();
}

function bookSearchFingerprint(data){
    // Two independent 64-bit FNV-1a lanes over a canonical ordered source stream.
    // Include secondary keywords because they participate in current Search policy.
    const entries=Object.values(data?.entries||{}).slice().sort((a,b)=>Number(a?.uid||0)-Number(b?.uid||0)||String(a?.comment||'').localeCompare(String(b?.comment||'')));
    const mask=(1n<<64n)-1n, prime=1099511628211n;
    let h1=14695981039346656037n, h2=7809847782465536322n, length=0;
    for(const entry of entries){
        const text=`${entry?.uid??''}\u0000${entry?.disable===true?'1':'0'}\u0000${entry?.comment||''}\u0000${(entry?.key||[]).join('\u0001')}\u0000${(entry?.keysecondary||[]).join('\u0001')}\u0000${entry?.content||''}\u0002`;
        length+=text.length;
        for(const ch of text){const cp=BigInt(ch.codePointAt(0));h1=((h1^cp)*prime)&mask;h2=((h2^(cp+0x9e37n))*0x100000001b3n)&mask;}

    }
    return `${entries.length}:${length}:${h1.toString(16).padStart(16,'0')}:${h2.toString(16).padStart(16,'0')}`;
}

async function buildBookSearchIndex(book,{yieldEvery=256,yieldFn=null,_attempt=0}={}){
    const startingRevision=getSearchIndexRevision(book);
    const tree=getTree(book);
    if(!tree?.root)return setCachedSearchIndex(book,{book,rows:[],nodeUidScopes:{},revision:getSearchIndexRevision(book),cacheHit:false,bookFingerprint:'none',treeStamp:'none'});
    const cached=getCachedSearchIndex(book);
    const treeStamp=String(tree.lastBuilt||startingRevision);
    // Revision invalidation is authoritative. On a hit, avoid reloading and
    // hashing the whole lore corpus; the revision fence owns cache freshness.
    if(cached&&cached.treeStamp===treeStamp&&cached.revision===startingRevision)return {...cached,cacheHit:true};
    const data=await loadBook(book),bookFingerprint=bookSearchFingerprint(data);
    const uidMap=buildEntryUidMap(data.entries),metrics=treeMetrics(tree),allNodes=metrics.rows,rows=[],nodeUidScopes={};
    const linkedUids=new Set(allNodes.flatMap(({node})=>(node.entryUids||[]).map(Number)).filter(Number.isFinite));

    let work=0;
    for(const {node} of allNodes){nodeUidScopes[String(node.id)]=[...(metrics.uidsById.get(String(node.id))||[])].map(Number);if(++work%128===0)await cooperativeYield(work,{yieldEvery,yieldFn});}
    const attachments=new Map();

    for(const {node,path} of allNodes){
        for(const uid of node.entryUids||[]){
            const entry=uidMap.get(Number(uid));
            if(!entry||entry.disable||!String(entry.content||'').trim())continue;
            const key=Number(uid);
            if(!attachments.has(key))attachments.set(key,[]);
            attachments.get(key).push({node,path});
            if(++work%256===0)await cooperativeYield(work,{yieldEvery,yieldFn});
        }
    }
    for(const [uid,attached] of attachments){
        const entry=uidMap.get(Number(uid));
        attached.sort((a,b)=>a.path.length-b.path.length||a.path.join(' > ').localeCompare(b.path.join(' > '))||String(a.node.id).localeCompare(String(b.node.id)));
        const {node,path}=attached[0];
        const normalized={
            title:normalize(entryTitle(entry,uid)).toLowerCase(),
            content:normalize(entry.content||'').toLowerCase(),
            keys:(Array.isArray(entry.key)?entry.key:[]).map(x=>normalize(x).toLowerCase()).filter(Boolean),
            secondaryKeys:(Array.isArray(entry.keysecondary)?entry.keysecondary:[]).map(x=>normalize(x).toLowerCase()).filter(Boolean),
            path:normalize(path.join(' > ')).toLowerCase(),
            summary:normalize(node.summary||'').toLowerCase(),
            nodeKeywords:(Array.isArray(node.keywords)?node.keywords:[]).map(x=>normalize(x).toLowerCase()).filter(Boolean),
        };
        const searchText=`${normalized.title} ${normalized.keys.join(' ')} ${normalized.secondaryKeys.join(' ')} ${normalized.path} ${normalized.summary} ${normalized.nodeKeywords.join(' ')} ${normalized.content}`;
        rows.push({book,uid:Number(uid),title:entryTitle(entry,uid),content:String(entry.content||''),keys:Array.isArray(entry.key)?entry.key.map(String):[],secondaryKeys:Array.isArray(entry.keysecondary)?entry.keysecondary.map(String):[],nodeId:node.id,nodeLabel:node.label||'',nodeSummary:node.summary||'',nodeKeywords:Array.isArray(node.keywords)?node.keywords.map(String):[],path,pathText:path.join(' > '),attachments:attached.map(row=>({nodeId:String(row.node.id),nodeLabel:String(row.node.label||''),path:row.path})),_searchNormalized:normalized,_searchText:searchText,_searchTerms:new Set(terms(searchText))});
    }
    // Canonical lore may temporarily contain enabled entries that are not yet linked
    // into the Tree. Keep those entries reachable through a virtual root-direct
    // search row without mutating Tree organization.
    const rootPath=[tree.root.label||'Root'];
    const unlinked=[];
    for(const entry of Object.values(data.entries||{})){
        const uid=Number(entry?.uid);
        if(!Number.isFinite(uid)||linkedUids.has(uid)||entry?.disable===true||!String(entry?.content||'').trim())continue;
        if(uidMap.get(uid)!==entry) continue; // duplicate/ambiguous UID fails closed
        const title=entryTitle(entry,uid);
        const normalized={
            title:normalize(title).toLowerCase(),
            content:normalize(entry.content||'').toLowerCase(),
            keys:(Array.isArray(entry.key)?entry.key:[]).map(x=>normalize(x).toLowerCase()).filter(Boolean),
            secondaryKeys:(Array.isArray(entry.keysecondary)?entry.keysecondary:[]).map(x=>normalize(x).toLowerCase()).filter(Boolean),
            path:normalize(`${rootPath.join(' > ')} > Unlinked lore`).toLowerCase(),
            summary:normalize(tree.root.summary||'').toLowerCase(),
            nodeKeywords:(Array.isArray(tree.root.keywords)?tree.root.keywords:[]).map(x=>normalize(x).toLowerCase()).filter(Boolean),
        };
        const searchText=`${normalized.title} ${normalized.keys.join(' ')} ${normalized.secondaryKeys.join(' ')} ${normalized.path} ${normalized.summary} ${normalized.nodeKeywords.join(' ')} ${normalized.content}`;
        rows.push({book,uid,title,content:String(entry.content||''),keys:Array.isArray(entry.key)?entry.key.map(String):[],secondaryKeys:Array.isArray(entry.keysecondary)?entry.keysecondary.map(String):[],nodeId:tree.root.id,nodeLabel:'Unlinked lore',nodeSummary:tree.root.summary||'',nodeKeywords:Array.isArray(tree.root.keywords)?tree.root.keywords.map(String):[],path:[...rootPath,'Unlinked lore'],pathText:`${rootPath.join(' > ')} > Unlinked lore`,attachments:[],unlinked:true,_searchNormalized:normalized,_searchText:searchText,_searchTerms:new Set(terms(searchText))});
        unlinked.push(uid);
        if(++work%256===0)await cooperativeYield(work,{yieldEvery,yieldFn});
    }
    if(unlinked.length)nodeUidScopes[String(tree.root.id)]=[...new Set([...(nodeUidScopes[String(tree.root.id)]||[]),...unlinked])];
    if(getSearchIndexRevision(book)!==startingRevision){
        if(_attempt<2)return await buildBookSearchIndex(book,{yieldEvery,yieldFn,_attempt:_attempt+1});
        const error=new Error(`Lorebook "${book}" changed while Nexus was building its search index.`);error.name='TV2SearchIndexSourceChanged';throw error;
    }
    const record={book,rows,nodeUidScopes,revision:startingRevision,cacheHit:false,bookFingerprint,treeStamp};

    setCachedSearchIndex(book,record);
    return record;
}

export async function buildTreeEntryIndex({ books = null, nodeIds = [], nodeRefs = [], yieldEvery=256, yieldFn=null } = {}) {
    const selectedBooks = selectedBooksOrActive(books);
    const requestedNodeRefScope = Array.isArray(nodeRefs) && nodeRefs.length > 0;
    // Validation is performed against the cached canonical index rather than by
    // repeatedly cloning/walking each Tree for every query term.
    const requestedRefs=dedupeTreeRefs(nodeRefs).filter(ref=>selectedBooks.includes(String(ref.book)));
    const nodeFilter = new Set((nodeIds || []).map(String));
    const scopedByBook = new Map();
    for (const ref of requestedRefs) {
        if (!scopedByBook.has(ref.book)) scopedByBook.set(ref.book, new Set());
        scopedByBook.get(ref.book).add(String(ref.nodeId));
    }
    const rows=[];
    const built = await Promise.allSettled(selectedBooks.map(book=>buildBookSearchIndex(book,{yieldEvery,yieldFn})));
    for(let bookIndex=0;bookIndex<selectedBooks.length;bookIndex+=1){
        const book=selectedBooks[bookIndex], settled=built[bookIndex];
        if(settled.status!=='fulfilled'){
            logEvent('search','book-index-load-failed',{book,error:settled.reason},'warn');
            continue;
        }
        const record=settled.value;
        let allowedUids=null;
        if(requestedNodeRefScope){
            const refs=scopedByBook.get(book)||new Set();allowedUids=new Set();
            for(const nodeId of refs)for(const uid of record.nodeUidScopes?.[nodeId]||[])allowedUids.add(Number(uid));
        }else if(nodeFilter.size){
            allowedUids=new Set();for(const nodeId of nodeFilter)for(const uid of record.nodeUidScopes?.[nodeId]||[])allowedUids.add(Number(uid));
        }
        for(const row of record.rows||[]){if(allowedUids&&!allowedUids.has(Number(row.uid)))continue;rows.push(row);}
    }
    return rows;
}

export async function searchTree({ query = '', books = null, nodeIds = [], nodeRefs = [], limit = 20, includeContent = false, pinnedRefs = [], warmRefs = [] } = {}) {
    const started = performance.now();
    const index = await buildTreeEntryIndex({ books, nodeIds, nodeRefs });
    const qTerms = terms(query);
    const termWeights = buildTermWeights(index, qTerms);
    const pinned = new Set((pinnedRefs || []).map(r => entryKey(r.book, r.uid)));
    const warm = new Set((warmRefs || []).map(r => entryKey(r.book, r.uid)));
    let results;
    if (!normalize(query)) {
        results = index.map(row => ({ ...row, score: (pinned.has(entryKey(row.book,row.uid)) ? 8 : 0) + (warm.has(entryKey(row.book,row.uid)) ? 4 : 0), matched: [] })).sort(canonicalSearchOrder);
    } else {
        results = index.map(row => ({
            ...row,
            ...scoreEntry(row, row.pathText, row.nodeSummary, qTerms, query, {
                pinned: pinned.has(entryKey(row.book, row.uid)),
                warm: warm.has(entryKey(row.book, row.uid)),
            }, termWeights),
        }))
            .filter(row => row.score > 0)
            .sort(canonicalSearchOrder);
    }
    const n = Number(limit);
    if (Number.isFinite(n) && n > 0) results = results.slice(0, n);
    results = results.map(({ _searchNormalized, _searchText, _searchTerms, ...rest }) => rest);
    if (!includeContent) results = results.map(({ content, ...rest }) => rest);
    logEvent('search', 'tree-search-complete', {
        query,
        books: selectedBooksOrActive(books),
        nodeIds,
        nodeRefs: dedupeTreeRefs(nodeRefs),
        indexedEntries: index.length,
        resultCount: results.length,
        informativeTerms: qTerms.length,
        limit: Number.isFinite(n) && n > 0 ? n : null,
        latencyMs: Math.round(performance.now() - started),
    }, 'info');
    return results;
}

export async function resolveNodeEntries({ books = null, nodeIds = [], nodeRefs = [], maxEntries = 0 } = {}) {
    const selectedBooks = selectedBooksOrActive(books);
    const refs = [];
    const seen = new Set();
    const bookData=new Map();
    const scoped = validateTreeRefs(nodeRefs, selectedBooks);
    const work = scoped.length
        ? scoped
        : selectedBooks.flatMap(book => (nodeIds || []).map(nodeId => ({ book, nodeId: String(nodeId) })));
    const byBook = new Map();
    for (const ref of work) { if (!byBook.has(ref.book)) byBook.set(ref.book, []); byBook.get(ref.book).push(ref); }
    const booksToLoad = [...byBook.keys()];
    const loaded = await Promise.allSettled(booksToLoad.map(book => loadBook(book)));
    for (let bookIndex=0; bookIndex<booksToLoad.length; bookIndex+=1) {
        const book = booksToLoad[bookIndex], settled = loaded[bookIndex];
        if (settled.status !== 'fulfilled') { logEvent('retrieval','selected-node-book-load-failed',{book,error:settled.reason},'warn'); continue; }
        const data = settled.value;
        const tree = getTree(book);
        if (!tree?.root) continue;
        const metrics = treeMetrics(tree);
        for (const ref of byBook.get(book) || []) {
            const node = findNode(tree.root, ref.nodeId);
            if (!node) continue;
            // Branch selections normally mean direct entries only; leaves mean
            // their complete scoped set. If a legal branch has no direct entries,
            // fall only to the nearest descendant level that owns entries.
            const nearestDescendantUids=(start,max=24)=>{
                let frontier=[...(start.children||[])];
                while(frontier.length){
                    const found=[]; const next=[];
                    for(const child of frontier){
                        for(const uid of child.entryUids||[]){const n=Number(uid);if(Number.isFinite(n)&&!found.includes(n))found.push(n);}
                        for(const grand of child.children||[])next.push(grand);
                    }
                    if(found.length)return found.slice(0,max);
                    frontier=next;
                }
                return [];
            };
            const direct=(node.entryUids||[]).map(Number).filter(Number.isFinite);
            const uids = (node.children || []).length ? (direct.length ? direct : nearestDescendantUids(node)) : [...(metrics.uidsById.get(String(node.id)) || [])];
            const path = metrics.pathById.get(String(node.id)) || [];
            for (const uid of uids) {
                const k = entryKey(book, uid);
                if (seen.has(k)) continue;
                const entry = findEntryByUid(data.entries, uid);
                if (!entry || entry.disable || !String(entry.content || '').trim()) continue;
                seen.add(k);
                refs.push({
                    book,
                    uid: Number(uid),
                    title: entryTitle(entry, uid),
                    content: String(entry.content || ''),
                    keys: Array.isArray(entry.key) ? entry.key.map(String) : [],
                    secondaryKeys:Array.isArray(entry.keysecondary)?entry.keysecondary.map(String):[],
                    nodeId: node.id,
                    nodeLabel: node.label || '',
                    path,
                });
                if (Number(maxEntries) > 0 && refs.length >= Number(maxEntries)) return refs;
            }
        }
    }
    return refs;
}

export function dedupeEntryRefs(refs = []) {
    const seen = new Set();
    return (refs || []).filter(ref => {
        const k = entryKey(ref.book, ref.uid);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

export { entryKey, nodeKey, walkPaths };
