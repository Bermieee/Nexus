export const LOREBOOK_BUILDER_CONFIG_MIGRATION_VERSION = 1;

const IMPORTED_BATCH_NUMERICS=Object.freeze({
    coalesceMs:{min:0,max:500,fallback:45},
    maxBatchItems:{min:1,max:50,fallback:10},
    targetInputTokens:{min:1000,max:100000,fallback:7000},
    summaryInputTokens:{min:1000,max:100000,fallback:7000},
    mergeInputTokens:{min:1000,max:100000,fallback:9000},
    recoveryAttempts:{min:0,max:3,fallback:1},
});

function finiteInteger(value,min,max){
    if(value===null||value===undefined)return null;
    if(typeof value==='string'&&value.trim()==='')return null;
    const parsed=Number(value);
    if(!Number.isFinite(parsed))return null;
    const integer=Math.floor(parsed);
    return integer>=min&&integer<=max?integer:null;
}

function hasOwn(object,key){return Object.prototype.hasOwnProperty.call(object||{},key);}
function removeLegacyTreePacking(batch){
    let changed=false;
    for(const key of ['treeEntriesPerSemanticSlice','treeSemanticInputTokens','treeSemanticPackingMigrated','treeSemanticPackingMigrationVersion']){
        if(hasOwn(batch,key)){delete batch[key];changed=true;}
    }
    return changed;
}

/**
 * One-way compatibility migration from the Dev 2 location where Tree semantic
 * packing lived under the shared Sidecar Batch Layer.
 */
export function migrateLorebookBuilderSettings(nexus){
    if(!nexus||typeof nexus!=='object'||Array.isArray(nexus))return false;
    const batch=nexus.batchLayer&&typeof nexus.batchLayer==='object'?nexus.batchLayer:{};
    const currentVersion=Number(nexus?.lorebookBuilder?.configVersion)||0;
    if(currentVersion>=LOREBOOK_BUILDER_CONFIG_MIGRATION_VERSION){
        // Current canonical settings win. Legacy duplicates are never allowed to
        // re-enter runtime authority through an imported/old backup.
        return removeLegacyTreePacking(batch);
    }

    const legacyMigrationVersion=Number(batch.treeSemanticPackingMigrationVersion)||0;
    let maxEntriesPerRequest=finiteInteger(batch.treeEntriesPerSemanticSlice,1,50);
    if(maxEntriesPerRequest===1&&legacyMigrationVersion<2)maxEntriesPerRequest=12;
    if(maxEntriesPerRequest==null)maxEntriesPerRequest=12;

    let targetInputTokens=finiteInteger(batch.treeSemanticInputTokens,1000,100000);
    if(targetInputTokens==null)targetInputTokens=3500;

    nexus.lorebookBuilder={
        ...(nexus.lorebookBuilder||{}),
        configVersion:LOREBOOK_BUILDER_CONFIG_MIGRATION_VERSION,
        semanticPacking:{
            ...(nexus.lorebookBuilder?.semanticPacking||{}),
            maxEntriesPerRequest,
            targetInputTokens,
        },
    };
    removeLegacyTreePacking(batch);
    return true;
}

/** Normalize only fields explicitly present in an imported payload. */
export function normalizeImportedNexusSettings(nexus){
    if(!nexus||typeof nexus!=='object'||Array.isArray(nexus))return false;
    let changed=false;
    const batch=nexus.batchLayer&&typeof nexus.batchLayer==='object'&&!Array.isArray(nexus.batchLayer)?nexus.batchLayer:null;
    if(batch){
        for(const [key,spec] of Object.entries(IMPORTED_BATCH_NUMERICS)){
            if(!hasOwn(batch,key))continue;
            const normalized=finiteInteger(batch[key],spec.min,spec.max);
            const next=normalized==null?spec.fallback:normalized;
            if(batch[key]!==next){batch[key]=next;changed=true;}
        }
    }
    if(migrateLorebookBuilderSettings(nexus))changed=true;
    return changed;
}
