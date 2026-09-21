const PLACEHOLDER_PATTERNS = [
    /^\s*(?:\.\.\.|…|n\/?a|null|none|unknown|example|sample|placeholder|string|number|boolean)\s*$/i,
    /^\s*(?:exact\s+)?(?:node|node_id|node id|uid|book|book name|lorebook|summary|content|title|reason|text)\s*$/i,
    /^\s*<[^>]+>\s*$/,
    /^\s*\[[^\]]*(?:example|placeholder|node id|book name|uid)[^\]]*\]\s*$/i,
    /^\s*\{[^}]*\}\s*$/,
    /^\s*(?:complete bounded lore draft|grounded(?: consolidated)? contribution|durable event(?:\/fact| cluster)?|supported(?: consolidated)? state delta|complete revised single notebook document|compact narrative memory|higher-level narrative memory|merged title|complete merged lore|short(?: rationale)?|a fact|b fact|new durable fact)\s*$/i,
];

export function isSchemaPlaceholder(value) {
    if (value == null) return true;
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!text) return true;
    return PLACEHOLDER_PATTERNS.some(pattern => pattern.test(text));
}

function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function arr(value) { return Array.isArray(value); }
function text(value) { return String(value ?? '').trim(); }
function validReason(value) { return typeof value === 'string' && !!value.trim() && !isSchemaPlaceholder(value); }
function normalizeRetrievalReasoning(value) {
    if (validReason(value)) return value.trim();
    if (Array.isArray(value)) {
        const rows=value.map(item=>text(item)).filter(item=>validReason(item));
        return rows.length ? rows.join(' | ') : '';
    }
    if (object(value)) {
        const rows=Object.entries(value)
            .map(([key,reason])=>[text(key),text(reason)])
            .filter(([,reason])=>validReason(reason))
            .sort((a,b)=>a[0].localeCompare(b[0]))
            .map(([key,reason])=>key?`${key}: ${reason}`:reason);
        return rows.join(' | ');
    }
    return '';
}
function normalizeRetrievalPerRefReasoning(refs = []) {
    if (!Array.isArray(refs)) return '';
    const rows=[];
    refs.forEach((ref,index)=>{
        if (!object(ref)) return;
        const reason=normalizeRetrievalReasoning(ref.reason ?? ref.reasoning);
        if (!validReason(reason)) return;
        const book=text(ref.book);
        const node=text(ref.nodeId ?? ref.node_id ?? ref.node ?? ref.id);
        const key=[book,node].filter(Boolean).join(':') || `ref-${index+1}`;
        rows.push([key,reason]);
    });
    rows.sort((a,b)=>a[0].localeCompare(b[0]));
    return rows.map(([key,reason])=>`${key}: ${reason}`).join(' | ');
}
function uid(value) { const n = Number(value); return Number.isInteger(n) && n >= 0 ? n : null; }
function uniqueStrings(values = []) { return [...new Set(values.map(value => String(value)).filter(Boolean))]; }
function sameStringArray(a = [], b = []) { const left = (Array.isArray(a) ? a : []).map(value => String(value)); const right = (Array.isArray(b) ? b : []).map(value => String(value)); return left.length === right.length && left.every((value, index) => value === right[index]); }
function subsetOfExactStrings(values = [], allowedValues = []) { const allowed = exactStringSet(allowedValues); return Array.isArray(values) && values.every(value => allowed.has(text(value))); }
function evidenceOrdinal(values = [], fallback = 0) { const ordinals=(Array.isArray(values)?values:[]).map(value=>String(value).match(/^M(\d+)$/i)).filter(Boolean).map(match=>Number(match[1])).filter(Number.isFinite); return ordinals.length ? Math.min(...ordinals) : fallback; }

function verdict(errors = [], score = 0, value = undefined, details = undefined) {
    return {
        valid: errors.length === 0,
        score,
        reason: errors.length ? errors.join('; ') : null,
        value,
        details,
    };
}

export function composeNotebookSplitPayload(candidates = []) {
    const roots=(Array.isArray(candidates)?candidates:[]).filter(object);
    if (roots.length !== 2) return null;
    const header=roots.find(value=>typeof value.changed==='boolean' && !Object.prototype.hasOwnProperty.call(value,'notebook'));
    const body=roots.find(value=>typeof value.notebook==='string' && value.notebook.trim() && !Object.prototype.hasOwnProperty.call(value,'changed'));
    if (!header || !body || header===body || header.changed !== true) return null;
    const reason=validReason(body.reason) ? body.reason : header.reason;
    const evidence=Array.isArray(body.evidence) ? body.evidence : header.evidence;
    if (!validReason(reason) || !Array.isArray(evidence)) return null;
    return { ...body, changed:true, reason, evidence };
}

export function validateNotebookPayload(value, allowedEvidenceIds = []) {
    const errors = [];
    let score = 0;
    const allowed = exactStringSet(allowedEvidenceIds);
    if (!object(value)) return verdict(['Notebook payload must be a top-level object.']);
    if (!Object.prototype.hasOwnProperty.call(value, 'changed') || typeof value.changed !== 'boolean') errors.push('Notebook payload requires boolean changed.'); else score += 20;
    if (!Object.prototype.hasOwnProperty.call(value, 'reason') || !validReason(value.reason)) errors.push('Notebook payload requires non-placeholder reason.'); else score += 20;
    if (!Object.prototype.hasOwnProperty.call(value, 'evidence') || !arr(value.evidence)) errors.push('Notebook payload requires evidence array.'); else score += 20;
    if (arr(value.evidence)) {
        if (value.evidence.some(item => typeof item !== 'string' || isSchemaPlaceholder(item))) errors.push('Notebook evidence contains a placeholder/non-string value.');
        else if (allowed.size && value.evidence.some(item=>!allowed.has(text(item)))) errors.push('Notebook evidence references IDs outside validated source evidence.');
        else score += 10;
    }
    if (value.changed === true) {
        if (!arr(value.evidence) || value.evidence.length===0) errors.push('Changed Notebook payload requires at least one validated evidence ID.');
        if (!Object.prototype.hasOwnProperty.call(value, 'notebook') || typeof value.notebook !== 'string' || !value.notebook.trim()) errors.push('Changed Notebook payload requires complete notebook text.');
        else if (isSchemaPlaceholder(value.notebook)) errors.push('Notebook text is a schema placeholder.');
        else score += 30;
    } else if (Object.prototype.hasOwnProperty.call(value, 'notebook') && value.notebook != null && typeof value.notebook !== 'string') {
        errors.push('Notebook notebook field must be text when supplied.');
    }
    return verdict(errors, score, value);
}

export function validateTreeSummaryPayload(value, requestedNodeIds = []) {
    const requested = requestedNodeIds.map(String);
    const expected = new Set(requested);
    const errors = [];
    let score = 0;
    if (!object(value)) return verdict(['Tree summary payload must be a top-level object.']);
    if (!arr(value.summaries)) return verdict(['Tree summary payload requires summaries array.'], 10);
    score += 20;
    const seen = new Set();
    const normalized = [];
    value.summaries.forEach((row, index) => {
        if (!object(row)) { errors.push(`Tree summary ${index} is not an object.`); return; }
        const nodeId = text(row.nodeId);
        const summary = text(row.summary);
        if (!nodeId || isSchemaPlaceholder(nodeId)) errors.push(`Tree summary ${index} has placeholder/empty nodeId.`);
        else if (!expected.has(nodeId)) errors.push(`Tree summary ${index} contains unknown nodeId ${nodeId}.`);
        else if (seen.has(nodeId)) errors.push(`Tree summary contains duplicate nodeId ${nodeId}.`);
        else { seen.add(nodeId); score += 10; }
        if (!summary || isSchemaPlaceholder(summary)) errors.push(`Tree summary ${nodeId || index} has placeholder/empty summary.`);
        else score += 5;
        normalized.push({ nodeId, summary });
    });
    for (const id of requested) if (!seen.has(id)) errors.push(`Tree summary is missing requested nodeId ${id}.`);
    if (seen.size === expected.size && seen.size === requested.length) score += 30;
    return verdict(errors, score, { ...value, summaries: normalized }, { requested, seen: [...seen] });
}

function operationType(op) { return text(op?.type).toLowerCase(); }
function bookAllowed(book, writableBooks, enforce = false) { return enforce ? writableBooks.includes(book) : (writableBooks.length === 0 || writableBooks.includes(book)); }
function nodeSetForBook(contract, book) { return contract?.nodeIdsByBook?.[book] instanceof Set ? contract.nodeIdsByBook[book] : new Set(contract?.nodeIdsByBook?.[book] || []); }
function uidSetForBook(contract, book) { return contract?.uidsByBook?.[book] instanceof Set ? contract.uidsByBook[book] : new Set((contract?.uidsByBook?.[book] || []).map(Number)); }
function replaceableUidSetForBook(contract, book) { return contract?.replaceableUidsByBook?.[book] instanceof Set ? contract.replaceableUidsByBook[book] : new Set((contract?.replaceableUidsByBook?.[book] || []).map(Number)); }

export function validateMutationEnvelope(value, contract = {}) {
    const errors = [];
    let score = 0;
    const writableBooks = uniqueStrings(contract.writableBooks || []);
    const enforceWritableBooks = Object.prototype.hasOwnProperty.call(contract, 'writableBooks');
    if (!object(value)) return verdict(['Mutation payload must be a top-level object.']);
    if (!arr(value.operations)) return verdict(['Mutation payload requires operations array.'], 10);
    score += 20;
    if (Object.prototype.hasOwnProperty.call(value, 'reasoning') && typeof value.reasoning !== 'string') errors.push('Mutation payload reasoning must be text.');
    const allowedTypes = new Set(['remember','create','create_entry','update','delete','merge','split','move_entry','create_category','rename_category','move_category','delete_category']);
    const contractAllowedTypes = Object.prototype.hasOwnProperty.call(contract, 'allowedOperationTypes') ? new Set(uniqueStrings(contract.allowedOperationTypes || []).map(value => value.toLowerCase())) : null;
    const completeUidSetForBook = book => contract?.completeUidsByBook?.[book] instanceof Set ? contract.completeUidsByBook[book] : new Set((contract?.completeUidsByBook?.[book] || []).map(Number));
    value.operations.forEach((op, index) => {
        if (!object(op)) { errors.push(`operation ${index} is not an object`); return; }
        const type = operationType(op);
        if (!allowedTypes.has(type) || isSchemaPlaceholder(type)) errors.push(`operation ${index} has invalid type`); else if (contractAllowedTypes && !contractAllowedTypes.has(type)) errors.push(`operation ${index} type ${type} is not authorized for this analyzed slice`); else score += 4;
        const book = text(op.book);
        if (!book || isSchemaPlaceholder(book)) errors.push(`operation ${index} requires exact book`);
        else if (!bookAllowed(book, writableBooks, enforceWritableBooks)) errors.push(`operation ${index} targets non-writable book ${book}`);
        else score += 4;
        const uids = uidSetForBook(contract, book);
        const nodes = nodeSetForBook(contract, book);
        const requireUid = (field) => {
            const id = uid(op[field]);
            if (id === null) errors.push(`operation ${index} requires exact ${field}`);
            else if (contract.requireCandidateIds === true && !uids.has(id)) errors.push(`operation ${index} references unknown ${field} ${id} for ${book}`);
            else score += 3;
        };
        const requireNode = (field, allowNull = false) => {
            const raw = op[field];
            if (allowNull && (raw == null || raw === '')) return;
            const id = text(raw);
            if (!id || isSchemaPlaceholder(id)) errors.push(`operation ${index} requires exact ${field}`);
            else if (contract.requireCandidateIds === true && !nodes.has(id)) errors.push(`operation ${index} references unknown ${field} ${id} for ${book}`);
            else score += 3;
        };
        if (type === 'update') {
            requireUid(op.uid !== undefined ? 'uid' : 'target_uid');
            const mode = text(op.mode || 'append').toLowerCase();
            if (!['append','replace'].includes(mode)) errors.push(`operation ${index} update mode must be append or replace`); else score += 3;
            if (mode === 'replace' && Object.prototype.hasOwnProperty.call(contract, 'replaceableUidsByBook')) {
                const targetId = uid(op.uid !== undefined ? op.uid : op.target_uid);
                if (targetId !== null && !replaceableUidSetForBook(contract, book).has(targetId)) errors.push(`operation ${index} cannot replace UID ${targetId} because the model did not receive its complete canonical content`);
            }
            const mutableFields=['content','title','constant','disable','node_id','target_node_id'];
            if (!mutableFields.some(field=>Object.prototype.hasOwnProperty.call(op,field))) errors.push(`operation ${index} update has no mutation fields`);
            if (op.content !== undefined && (typeof op.content !== 'string' || !text(op.content) || isSchemaPlaceholder(op.content))) errors.push(`operation ${index} update content is placeholder/invalid`);
            if (op.title !== undefined && (typeof op.title !== 'string' || !text(op.title) || isSchemaPlaceholder(op.title))) errors.push(`operation ${index} update title is placeholder/invalid`);
            if (op.constant !== undefined && typeof op.constant !== 'boolean') errors.push(`operation ${index} update constant must be boolean`);
            if (op.disable !== undefined && typeof op.disable !== 'boolean') errors.push(`operation ${index} update disable must be boolean`);
            if (op.node_id !== undefined || op.target_node_id !== undefined) requireNode(op.node_id !== undefined ? 'node_id' : 'target_node_id', true);
        } else if (type === 'delete') { requireUid('uid'); if (Object.prototype.hasOwnProperty.call(contract,'completeUidsByBook')) { const id=uid(op.uid); if(id!==null&&!completeUidSetForBook(book).has(id))errors.push(`operation ${index} cannot delete UID ${id} because complete canonical content was not supplied`); } }
        else if (type === 'merge') {
            requireUid('keep_uid'); requireUid('remove_uid');
            if (Object.prototype.hasOwnProperty.call(contract,'completeUidsByBook')) { const complete=completeUidSetForBook(book),keep=uid(op.keep_uid),remove=uid(op.remove_uid); if(keep!==null&&!complete.has(keep))errors.push(`operation ${index} cannot merge UID ${keep} because complete canonical content was not supplied`); if(remove!==null&&!complete.has(remove))errors.push(`operation ${index} cannot merge UID ${remove} because complete canonical content was not supplied`); }
            if (uid(op.keep_uid)!==null && uid(op.remove_uid)!==null && uid(op.keep_uid)===uid(op.remove_uid)) errors.push(`operation ${index} merge cannot target the same UID twice`);
            if (!text(op.content) || isSchemaPlaceholder(op.content)) errors.push(`operation ${index} merge requires explicit merged content`);
        }
        else if (type === 'split') {
            requireUid('uid');
            if (Object.prototype.hasOwnProperty.call(contract,'completeUidsByBook')) { const id=uid(op.uid); if(id!==null&&!completeUidSetForBook(book).has(id))errors.push(`operation ${index} cannot split UID ${id} because complete canonical content was not supplied`); }
            if (!text(op.keep_content) || isSchemaPlaceholder(op.keep_content)) errors.push(`operation ${index} split requires keep_content`);
            if (!text(op.new_content) || isSchemaPlaceholder(op.new_content)) errors.push(`operation ${index} split requires new_content`);
            if (!text(op.new_title) || isSchemaPlaceholder(op.new_title)) errors.push(`operation ${index} split requires new_title`);
            if (op.new_node_id !== undefined) requireNode('new_node_id', true);
        }
        else if (type === 'move_entry') { requireUid('uid'); requireNode(op.node_id !== undefined ? 'node_id' : 'target_node_id'); }
        else if (type === 'remember' || type === 'create' || type === 'create_entry') {
            if (op.node_id !== undefined || op.target_node_id !== undefined) requireNode(op.node_id !== undefined ? 'node_id' : 'target_node_id', true);
            if (!text(op.content) || isSchemaPlaceholder(op.content)) errors.push(`operation ${index} remember content is placeholder/empty`);
            if (op.keys !== undefined) {
                if (!arr(op.keys)) errors.push(`operation ${index} create keys must be an array`);
                else if (op.keys.some(key => !text(key) || isSchemaPlaceholder(key))) errors.push(`operation ${index} create keys contain placeholder/empty values`);
            }
        } else if (type === 'create_category') {
            requireNode(op.parent_node_id !== undefined ? 'parent_node_id' : 'parent_id', true);
            if (!text(op.label || op.name) || isSchemaPlaceholder(op.label || op.name)) errors.push(`operation ${index} create_category requires label`);
        }
        else if (['rename_category','move_category','delete_category'].includes(type)) {
            requireNode(op.node_id !== undefined ? 'node_id' : 'target_id');
            if (type === 'rename_category' && ![op.label,op.name,op.summary].some(value=>text(value) && !isSchemaPlaceholder(value))) errors.push(`operation ${index} rename_category has no changed label/summary`);
            if (type === 'move_category') requireNode(op.parent_node_id !== undefined ? 'parent_node_id' : 'parent_id');
            if (type === 'delete_category') { const mode=text(op.mode || 'promote_children').toLowerCase(); if(!['promote_children','move_entries_to_parent','delete_subtree'].includes(mode)) errors.push(`operation ${index} delete_category mode is invalid`); }
        }
    });
    if (!errors.length) score += 30;
    return verdict(errors, score, value);
}

export function validateRetrievalRefPayload(value, {
    field = 'nodes',
    allowedKeys = new Set(),
    normalizeRef = ref => ({ ...ref, book: text(ref?.book), nodeId: text(ref?.nodeId ?? ref?.node_id ?? ref?.node ?? ref?.id) }),
    keyOf = ref => `${String(ref?.book || '')}:${String(ref?.nodeId || '')}`,
    requireReasoning = false,
    enforceAllowedKeys = true,
} = {}) {
    const errors = [];
    let score = 0;
    if (!object(value)) return verdict(['Retrieval payload must be a top-level object.']);
    const refs = value[field];
    const normalizedReasoning = requireReasoning
        ? (normalizeRetrievalReasoning(value.reasoning) || normalizeRetrievalPerRefReasoning(refs))
        : (typeof value.reasoning === 'string' ? value.reasoning.trim() : value.reasoning);
    if (requireReasoning) {
        if (!validReason(normalizedReasoning)) errors.push('Retrieval payload requires non-placeholder reasoning.');
        else score += 10;
    }
    const normalizedValue = requireReasoning ? { ...value, reasoning: normalizedReasoning } : value;
    if (!arr(refs)) return verdict([...errors, `Retrieval payload requires ${field} array.`], 10);
    score += 20;
    const seen = new Set();
    for (let index = 0; index < refs.length; index += 1) {
        const raw = refs[index];
        let ref;
        try { ref = normalizeRef(raw); } catch { ref = null; }
        if (!object(ref)) { errors.push(`${field}[${index}] could not be normalized`); continue; }
        const stringValues = Object.values(ref).filter(item => typeof item === 'string');
        if (stringValues.some(item => isSchemaPlaceholder(item))) { errors.push(`${field}[${index}] contains a schema placeholder`); continue; }
        const key = keyOf(ref);
        if (!key || isSchemaPlaceholder(key)) { errors.push(`${field}[${index}] has an empty/placeholder identity`); continue; }
        if (enforceAllowedKeys && !allowedKeys.has(key)) errors.push(`${field}[${index}] references a ref outside the supplied candidate set`);
        else score += 4;
        if (seen.has(key)) errors.push(`${field}[${index}] duplicates ${key}`); else seen.add(key);
    }
    if (!errors.length) score += 20;
    return verdict(errors, score, normalizedValue);
}

function exactStringSet(values = []) { return new Set((Array.isArray(values) ? values : []).map(value => String(value))); }
function stringArray(value) { return Array.isArray(value) && value.every(item => typeof item === 'string' && !isSchemaPlaceholder(item)); }

export function validateSummaryEvidencePayload(value, allowedEvidenceIds = []) {
    const errors = [];
    let score = 0;
    const allowed = exactStringSet(allowedEvidenceIds);
    if (!object(value)) return verdict(['Summary evidence payload must be a top-level object.']);
    if (!arr(value.events)) return verdict(['Summary evidence payload requires events array.'], 10);
    score += 20;
    const normalized = [];
    value.events.forEach((row, index) => {
        if (!object(row)) { errors.push(`summary event ${index} is not an object`); return; }
        const eventText = text(row.text ?? row.event ?? row.fact);
        const evidence = arr(row.evidence) ? row.evidence.map(item => text(item)).filter(Boolean) : [];
        if (!eventText || isSchemaPlaceholder(eventText)) errors.push(`summary event ${index} has placeholder/empty text`); else score += 5;
        if (!evidence.length) errors.push(`summary event ${index} requires source evidence IDs`);
        else if (evidence.some(id => isSchemaPlaceholder(id) || (allowed.size && !allowed.has(id)))) errors.push(`summary event ${index} references evidence outside its supplied slice`);
        else score += 5;
        normalized.push({ text: eventText, evidence, order: evidenceOrdinal(evidence, index) });
    });
    for (const field of ['characters','locations','dates','topics','threads']) {
        if (value[field] !== undefined && !stringArray(value[field])) errors.push(`Summary evidence ${field} must be a non-placeholder string array.`);
    }
    if (!errors.length) score += 30;
    return verdict(errors, score, {
        events: normalized,
        characters: uniqueStrings(value.characters || []),
        locations: uniqueStrings(value.locations || []),
        dates: uniqueStrings(value.dates || []),
        topics: uniqueStrings(value.topics || []),
        threads: uniqueStrings(value.threads || []),
    });
}

export function validateSummaryFinalPayload(value, allowedEvidenceIds = []) {
    const errors = [];
    let score = 0;
    const allowed = exactStringSet(allowedEvidenceIds);
    if (!object(value)) return verdict(['Summary final payload must be a top-level object.']);
    const summary = text(value.summary ?? value.text);
    if (!summary || isSchemaPlaceholder(summary)) errors.push('Summary final payload requires non-placeholder summary text.'); else score += 40;
    if (!arr(value.evidence) || !stringArray(value.evidence)) errors.push('Summary final payload requires non-placeholder evidence array.');
    else if (allowed.size && (!value.evidence.length || value.evidence.some(id=>!allowed.has(text(id))))) errors.push('Summary final payload references evidence outside validated source evidence.');
    else score += 12;
    for (const field of ['characters','locations','dates','topics','threads']) {
        if (!arr(value[field])) errors.push(`Summary final payload requires ${field} array.`);
        else if (!stringArray(value[field])) errors.push(`Summary final ${field} contains placeholder/non-string values.`);
        else score += 8;
    }
    return verdict(errors, score, {
        summary,
        evidence: uniqueStrings(value.evidence || []),
        characters: uniqueStrings(value.characters || []),
        locations: uniqueStrings(value.locations || []),
        dates: uniqueStrings(value.dates || []),
        topics: uniqueStrings(value.topics || []),
        threads: uniqueStrings(value.threads || []),
    });
}

export function validateNotebookDeltaPayload(value, allowedEvidenceIds = []) {
    const errors = [];
    let score = 0;
    const allowed = exactStringSet(allowedEvidenceIds);
    if (!object(value)) return verdict(['Notebook delta payload must be a top-level object.']);
    if (typeof value.changed !== 'boolean') errors.push('Notebook delta requires boolean changed.'); else score += 20;
    if (!validReason(value.reason)) errors.push('Notebook delta requires non-placeholder reason.'); else score += 20;
    if (!arr(value.evidence) || !stringArray(value.evidence)) errors.push('Notebook delta requires a non-placeholder evidence array.');
    else if (value.changed && value.evidence.length===0) errors.push('Changed Notebook delta requires at least one source evidence ID.');
    else if (value.evidence.some(id => allowed.size && !allowed.has(text(id)))) errors.push('Notebook delta references evidence outside its supplied scene slice.');
    else score += 20;
    if (!arr(value.deltas)) errors.push('Notebook delta requires deltas array.');
    else if (!stringArray(value.deltas)) errors.push('Notebook delta contains placeholder/non-string deltas.');
    else if (value.changed && value.deltas.length === 0) errors.push('Changed Notebook delta requires at least one state delta.');
    else score += 30;
    return verdict(errors, score, {
        changed: value.changed === true,
        reason: text(value.reason),
        evidence: uniqueStrings(value.evidence || []),
        deltas: uniqueStrings(value.deltas || []),
    });
}

export function validateUidContributionPayload(value, contract = {}) {
    const errors = [];
    let score = 0;
    if (!object(value)) return verdict(['UID contribution payload must be a top-level object.']);
    if (Number(value.uid) !== Number(contract.uid)) errors.push('UID contribution returned the wrong source UID.'); else score += 15;
    if (text(value.sourceHash) !== text(contract.sourceHash) || isSchemaPlaceholder(value.sourceHash)) errors.push('UID contribution returned the wrong source hash.'); else score += 15;
    if (text(value.sourceRevision) !== text(contract.sourceRevision) || isSchemaPlaceholder(value.sourceRevision)) errors.push('UID contribution returned the wrong source revision.'); else score += 10;
    if (text(value.title) !== text(contract.title)) errors.push('UID contribution returned the wrong source title.'); else score += 10;
    if (!sameStringArray(value.sourceKeys, contract.sourceKeys)) errors.push('UID contribution returned the wrong source keys.'); else score += 10;
    if (text(value.sliceId) !== text(contract.sliceId) || isSchemaPlaceholder(value.sliceId)) errors.push('UID contribution returned the wrong slice identity.'); else score += 15;
    if (!arr(value.contributions) || !stringArray(value.contributions) || value.contributions.length===0) errors.push('UID contribution requires at least one non-placeholder contribution.'); else score += 15;
    if (!arr(value.keywordCandidates) || !stringArray(value.keywordCandidates)) errors.push('UID contribution requires keywordCandidates string array.'); else score += 5;
    return verdict(errors, score, {
        uid: Number(value.uid), sourceHash: text(value.sourceHash), sourceRevision: text(value.sourceRevision), title: text(value.title), sourceKeys: (value.sourceKeys || []).map(String), sliceId: text(value.sliceId), contributions: uniqueStrings(value.contributions || []), keywordCandidates: uniqueStrings(value.keywordCandidates || []),
    });
}

export function validateUidSummaryPayload(value, contract = {}) {
    const errors = [];
    let score = 0;
    if (!object(value)) return verdict(['UID summary payload must be a top-level object.']);
    if (Number(value.uid) !== Number(contract.uid)) errors.push('UID summary returned the wrong source UID.'); else score += 10;
    if (text(value.sourceHash) !== text(contract.sourceHash) || isSchemaPlaceholder(value.sourceHash)) errors.push('UID summary returned the wrong source hash.'); else score += 10;
    if (text(value.sourceRevision) !== text(contract.sourceRevision) || isSchemaPlaceholder(value.sourceRevision)) errors.push('UID summary returned the wrong source revision.'); else score += 10;
    if (text(value.title) !== text(contract.title)) errors.push('UID summary returned the wrong source title identity.'); else score += 10;
    if (!sameStringArray(value.sourceKeys, contract.sourceKeys)) errors.push('UID summary returned the wrong source keys identity.'); else score += 10;
    if (!arr(value.options)) return verdict([...errors, 'UID summary requires options array.'], score);
    const expectedCount = Number(contract.optionCount) || 0;
    if (expectedCount && value.options.length !== expectedCount) errors.push(`UID summary must return exactly ${expectedCount} option(s).`);
    const options = [];
    value.options.forEach((row, index) => {
        if (!object(row)) { errors.push(`UID summary option ${index} is not an object.`); return; }
        const label = text(row.label), summary = text(row.summary);
        if (!label || isSchemaPlaceholder(label)) errors.push(`UID summary option ${index} has placeholder/empty label.`); else score += 4;
        if (!summary || isSchemaPlaceholder(summary)) errors.push(`UID summary option ${index} has placeholder/empty summary.`); else score += 8;
        if (!arr(row.keywords) || !stringArray(row.keywords)) errors.push(`UID summary option ${index} keywords must be a string array.`); else score += 3;
        const refs=uniqueStrings(row.sourceContributionRefs || []), allowedRefs=contract.allowedContributionRefs || [];
        if (!refs.length || !subsetOfExactStrings(refs,allowedRefs)) errors.push(`UID summary option ${index} must cite only validated source contribution refs.`); else score += 6;
        if (row.notes !== undefined && typeof row.notes !== 'string') errors.push(`UID summary option ${index} notes must be text.`);
        options.push({ label, summary, keywords: uniqueStrings(row.keywords || []), notes: text(row.notes), sourceContributionRefs: refs });
    });
    return verdict(errors, score, { uid: Number(value.uid), sourceHash: text(value.sourceHash), sourceRevision: text(value.sourceRevision), title: text(value.title), sourceKeys: (value.sourceKeys || []).map(String), options });
}

export function validateMergeContributionPayload(value, contract = {}) {
    const errors = [];
    let score = 0;
    if (!object(value)) return verdict(['Merge contribution payload must be a top-level object.']);
    if (text(value.sourceTag) !== text(contract.sourceTag)) errors.push('Merge contribution returned the wrong A/B source tag.'); else score += 20;
    if (Number(value.sourceUid) !== Number(contract.sourceUid)) errors.push('Merge contribution returned the wrong source UID.'); else score += 20;
    if (text(value.sourceHash) !== text(contract.sourceHash) || isSchemaPlaceholder(value.sourceHash)) errors.push('Merge contribution returned the wrong source hash.'); else score += 20;
    if (text(value.sliceId) !== text(contract.sliceId) || isSchemaPlaceholder(value.sliceId)) errors.push('Merge contribution returned the wrong slice identity.'); else score += 20;
    if (!arr(value.contributions) || !stringArray(value.contributions) || value.contributions.length===0) errors.push('Merge contribution requires at least one non-placeholder contribution.'); else score += 10;
    return verdict(errors, score, {
        sourceTag: text(value.sourceTag),
        sourceUid: Number(value.sourceUid),
        sourceHash: text(value.sourceHash),
        sliceId: text(value.sliceId),
        contributions: uniqueStrings(value.contributions || []),
    });
}

export function validateMergeFinalPayload(value, contract = {}) {
    const errors = [];
    let score = 0;
    if (!object(value)) return verdict(['Merge final payload must be a top-level object.']);
    const title = text(value.title);
    const content = text(value.content);
    if (!content || isSchemaPlaceholder(content)) errors.push('Merge final payload requires non-placeholder content.'); else score += 30;
    if (!arr(value.sourceAContributions) || !stringArray(value.sourceAContributions) || !value.sourceAContributions.length) errors.push('Merge final payload requires sourceAContributions array.');
    else if ((contract.allowedSourceAContributions||[]).length && !subsetOfExactStrings(value.sourceAContributions,contract.allowedSourceAContributions)) errors.push('Merge final source A provenance is not bound to validated A contributions.'); else score += 15;
    if (!arr(value.sourceBContributions) || !stringArray(value.sourceBContributions) || !value.sourceBContributions.length) errors.push('Merge final payload requires sourceBContributions array.');
    else if ((contract.allowedSourceBContributions||[]).length && !subsetOfExactStrings(value.sourceBContributions,contract.allowedSourceBContributions)) errors.push('Merge final source B provenance is not bound to validated B contributions.'); else score += 15;
    if (Number(value.sourceAUid) !== Number(contract.sourceAUid)) errors.push('Merge final payload returned wrong source A UID.'); else score += 10;
    if (Number(value.sourceBUid) !== Number(contract.sourceBUid)) errors.push('Merge final payload returned wrong source B UID.'); else score += 10;
    if (text(value.sourceAHash) !== text(contract.sourceAHash)) errors.push('Merge final payload returned wrong source A hash.'); else score += 5;
    if (text(value.sourceBHash) !== text(contract.sourceBHash)) errors.push('Merge final payload returned wrong source B hash.'); else score += 5;
    return verdict(errors, score, {
        title,
        content,
        mergeContext: text(value.mergeContext),
        sourceAUid: Number(value.sourceAUid),
        sourceBUid: Number(value.sourceBUid),
        sourceAHash: text(value.sourceAHash),
        sourceBHash: text(value.sourceBHash),
        sourceAContributions: uniqueStrings(value.sourceAContributions || []),
        sourceBContributions: uniqueStrings(value.sourceBContributions || []),
    });
}
