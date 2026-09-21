const WORLD_INFO_GROUPS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];

function nativeWorldInfoIdentity(item, groupKey = '') {
    if (!item || typeof item !== 'object') return `primitive:${groupKey}:${String(item)}`;
    const stableId = item.uid ?? item.id ?? item.worldInfoUid ?? item.world_info_uid;
    if (stableId !== undefined && stableId !== null && String(stableId) !== '') return `id:${groupKey}:${String(item.world ?? item.book ?? '')}:${String(stableId)}`;
    return `content:${groupKey}:${String(item.world ?? item.book ?? '')}:${String(item.comment ?? item.title ?? '')}:${String(item.content ?? item.mes ?? '')}`;
}
function restoreNativeWorldInfoRows(transaction, group, rows) {
    const array = transaction?.data?.[group?.key];
    if (!Array.isArray(array) || !Array.isArray(rows) || !rows.length) return 0;
    const original = Array.isArray(group.original) ? group.original : [];
    const indexOfIdentity = identity => array.findIndex(item => nativeWorldInfoIdentity(item, group.key) === identity);
    const present = new Set(array.map(item => nativeWorldInfoIdentity(item, group.key)));
    let restored = 0;
    for (const row of [...rows].sort((a, b) => a.index - b.index)) {
        const identity = row.identity || nativeWorldInfoIdentity(row.item, group.key);
        if (present.has(identity)) continue;
        const originalIndex = original.indexOf(row.item);
        let insertAt = -1;
        if (originalIndex >= 0) {
            for (let i = originalIndex + 1; i < original.length; i += 1) {
                const at = indexOfIdentity(nativeWorldInfoIdentity(original[i], group.key));
                if (at >= 0) { insertAt = at; break; }
            }
            if (insertAt < 0) {
                for (let i = originalIndex - 1; i >= 0; i -= 1) {
                    const at = indexOfIdentity(nativeWorldInfoIdentity(original[i], group.key));
                    if (at >= 0) { insertAt = at + 1; break; }
                }
            }
        }
        if (insertAt < 0) insertAt = array.length;
        array.splice(insertAt, 0, row.item);
        present.add(identity);
        restored += 1;
    }
    return restored;
}


export function beginNativeWorldInfoSuppression({ data, replacementReady = false, shouldSuppress = null, generationId = null, chatEpoch = null, invocationId = null } = {}) {
    const transaction = {
        state: 'retained',
        replacementReady: replacementReady === true,
        removedCount: 0,
        groups: [],
        data,
        startedAt: Date.now(),
        generationId: generationId == null ? null : String(generationId),
        chatEpoch: Number.isFinite(Number(chatEpoch)) ? Number(chatEpoch) : null,
        invocationId: invocationId == null ? null : String(invocationId),
    };
    if (!data || replacementReady !== true || typeof shouldSuppress !== 'function') return transaction;

    // C11-100: evaluate all caller policy before mutating any host-owned prompt
    // array. A throwing predicate must leave every group byte-for-byte intact.
    const plan=[];
    for (const key of WORLD_INFO_GROUPS) {
        const array=data[key];
        if (!Array.isArray(array)) continue;
        const removed=[];
        const original=array.slice();
        for (let index=array.length-1; index>=0; index-=1) {
            if (shouldSuppress(array[index], key)) removed.push({ index, item:array[index] });
        }
        if (removed.length) {
            removed.sort((a,b)=>a.index-b.index);
            plan.push({key,array,original,removed:removed.map(row=>({...row,identity:nativeWorldInfoIdentity(row.item,key)}))});
        }
    }
    const applied=[];
    try {
        for (const group of plan) {
            for (let i=group.removed.length-1;i>=0;i-=1) group.array.splice(group.removed[i].index,1);
            transaction.groups.push({key:group.key,original:group.original,removed:group.removed});
            transaction.removedCount+=group.removed.length;
            applied.push(group);
        }
    } catch (error) {
        for (const group of [...applied].reverse()) {
            for (const row of group.removed) group.array.splice(row.index,0,row.item);
        }
        transaction.groups=[];transaction.removedCount=0;transaction.state='retained';
        throw error;
    }
    if (transaction.removedCount > 0) transaction.state = 'pending';
    return transaction;
}

export function rollbackNativeWorldInfoSuppression(transaction, reason = 'replacement-not-ready') {
    if (!transaction || transaction.state !== 'pending') return transaction || null;
    for (const group of transaction.groups || []) {
        // Resolve the current host-owned array at rollback time: SillyTavern may
        // replace prompt arrays while a generation is in flight. Restore relative
        // to surviving identities so concurrent host-side reordering remains intact.
        restoreNativeWorldInfoRows(transaction, group, group.removed || []);
    }
    transaction.state = 'rolled-back';
    transaction.endedAt = Date.now();
    transaction.reason = String(reason || 'replacement-not-ready');
    return transaction;
}

/** Restore any suppressed native-WI rows that are not covered by the validated
 * Nexus replacement, while keeping covered rows pending for final commit. */
export function narrowNativeWorldInfoSuppression(transaction, shouldRemainSuppressed = null, reason = 'partial-replacement') {
    if (!transaction || transaction.state !== 'pending' || typeof shouldRemainSuppressed !== 'function') return transaction || null;
    let kept = 0;
    const nextGroups = [];
    for (const group of transaction.groups || []) {
        const retain = [], restore = [];
        for (const row of group.removed || []) {
            if (shouldRemainSuppressed(row.item, group.key, row) === true) retain.push(row);
            else restore.push(row);
        }
        restoreNativeWorldInfoRows(transaction, group, restore);
        if (retain.length) nextGroups.push({ ...group, removed:retain });
        kept += retain.length;
    }
    transaction.groups = nextGroups;
    transaction.removedCount = kept;
    transaction.partialReason = String(reason || 'partial-replacement');
    if (!kept) {
        transaction.state = 'rolled-back';
        transaction.endedAt = Date.now();
        transaction.reason = String(reason || 'partial-replacement');
    }
    return transaction;
}

export function commitNativeWorldInfoSuppression(transaction, reason = 'validated-nexus-replacement') {
    if (!transaction || transaction.state !== 'pending') return transaction || null;
    transaction.state = 'committed';
    transaction.endedAt = Date.now();
    transaction.reason = String(reason || 'validated-nexus-replacement');
    transaction.groups = [];
    transaction.data = null;
    return transaction;
}

/** Remove prompt-only World Info entries that are forbidden by Story Scope.
 * Unlike transactional Nexus replacement suppression, these entries must never
 * be restored into this generation because they belong to another story. */
export function removeNativeWorldInfoEntries(data, shouldRemove = null) {
    if(!data||typeof shouldRemove!=='function')return {removedCount:0,groups:[]};
    // C11-104: plan the entire callback decision set before any permanent host
    // mutation, matching transactional suppression's fail-closed behavior.
    const plan=[];
    for(const key of WORLD_INFO_GROUPS){
        const array=data[key];if(!Array.isArray(array))continue;
        const removed=[];
        for(let index=array.length-1;index>=0;index-=1){if(shouldRemove(array[index],key))removed.push({index,item:array[index]});}
        if(removed.length){removed.sort((a,b)=>a.index-b.index);plan.push({key,array,removed});}
    }
    const applied=[];
    try{
        for(const group of plan){for(let i=group.removed.length-1;i>=0;i-=1)group.array.splice(group.removed[i].index,1);applied.push(group);}
    }catch(error){for(const group of [...applied].reverse())for(const row of group.removed)group.array.splice(row.index,0,row.item);throw error;}
    return {removedCount:plan.reduce((n,g)=>n+g.removed.length,0),groups:plan.map(g=>({key:g.key,count:g.removed.length}))};
}
