const DB_NAME='nexus-builder2-plans-v2';
const STORE_NAME='plans';
const DB_VERSION=1;
const OPEN_TIMEOUT_MS=2500;
const TX_TIMEOUT_MS=5000;

function unavailable(message,cause=null){
    const error=new Error(message);error.name='TV2Builder2PlanDurabilityUnavailable';if(cause)error.cause=cause;return error;
}

function openDb(indexedDB=globalThis?.indexedDB){
    if(!indexedDB||typeof indexedDB.open!=='function')return Promise.resolve(null);
    return new Promise((resolve,reject)=>{
        let settled=false;let request;
        const finishError=(message,cause=null)=>{if(settled)return;settled=true;clearTimeout(timer);reject(unavailable(message,cause));};
        const timer=setTimeout(()=>finishError('Builder 2 IndexedDB PlanStore open timed out.'),OPEN_TIMEOUT_MS);
        try{request=indexedDB.open(DB_NAME,DB_VERSION);}catch(error){finishError('Builder 2 IndexedDB PlanStore could not be opened.',error);return;}
        request.onupgradeneeded=()=>{try{if(!request.result.objectStoreNames.contains(STORE_NAME))request.result.createObjectStore(STORE_NAME);}catch(error){finishError('Builder 2 IndexedDB PlanStore schema upgrade failed.',error);}};
        request.onerror=()=>finishError('Builder 2 IndexedDB PlanStore open failed.',request.error);
        request.onblocked=()=>finishError('Builder 2 IndexedDB PlanStore open was blocked.');
        request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();if(settled){db.close();return;}settled=true;clearTimeout(timer);resolve(db);};
    });
}

async function transaction(mode,run,{indexedDB=globalThis?.indexedDB}={}){
    const db=await openDb(indexedDB);if(!db)return null;
    try{return await new Promise((resolve,reject)=>{
        let result=null;let settled=false;let tx;
        const fail=(message,cause=null)=>{if(settled)return;settled=true;clearTimeout(timer);try{tx?.abort();}catch{}reject(unavailable(message,cause));};
        const timer=setTimeout(()=>fail('Builder 2 IndexedDB PlanStore transaction timed out.'),TX_TIMEOUT_MS);
        try{tx=db.transaction(STORE_NAME,mode);}catch(error){fail('Builder 2 IndexedDB PlanStore transaction could not start.',error);return;}
        tx.oncomplete=()=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
        tx.onerror=()=>fail('Builder 2 IndexedDB PlanStore transaction failed.',tx.error);
        tx.onabort=()=>fail('Builder 2 IndexedDB PlanStore transaction aborted.',tx.error);
        try{run(tx.objectStore(STORE_NAME),value=>{result=value;},fail);}catch(error){fail('Builder 2 IndexedDB PlanStore operation failed.',error);}
    });}finally{db.close();}
}

export function createBuilder2IndexedDbRecordStore({indexedDB=globalThis?.indexedDB}={}){
    return {
        kind:'indexeddb',
        durable:true,
        available:!!indexedDB&&typeof indexedDB.open==='function',
        async read(runId){
            return transaction('readonly',(store,done,fail)=>{const r=store.get(String(runId));r.onsuccess=()=>done(r.result?.value??null);r.onerror=()=>fail('Builder 2 IndexedDB PlanStore read failed.',r.error);},{indexedDB});
        },
        async write(runId,value){
            const id=String(runId),text=String(value);
            await transaction('readwrite',(store,done,fail)=>{const r=store.put({runId:id,value:text,updatedAt:Date.now()},id);r.onsuccess=()=>done(true);r.onerror=()=>fail('Builder 2 IndexedDB PlanStore write failed.',r.error);},{indexedDB});
            const verify=await this.read(id);if(verify!==text)throw unavailable('Builder 2 IndexedDB PlanStore write could not be verified.');return true;
        },
        async remove(runId){
            const id=String(runId);await transaction('readwrite',(store,done,fail)=>{const r=store.delete(id);r.onsuccess=()=>done(true);r.onerror=()=>fail('Builder 2 IndexedDB PlanStore removal failed.',r.error);},{indexedDB});
            const verify=await this.read(id);if(verify!=null)throw unavailable('Builder 2 IndexedDB PlanStore removal could not be verified.');return true;
        },
        async listRunIds(){
            const rows=await transaction('readonly',(store,done,fail)=>{const out=[];const r=store.openCursor();r.onsuccess=()=>{const cursor=r.result;if(!cursor){done(out);return;}out.push(String(cursor.key));cursor.continue();};r.onerror=()=>fail('Builder 2 IndexedDB PlanStore enumeration failed.',r.error);},{indexedDB});
            return Array.isArray(rows)?rows:[];
        },
    };
}

export const NEXUS_BUILDER2_PLAN_DB_NAME=DB_NAME;
export const NEXUS_BUILDER2_PLAN_DB_STORE=STORE_NAME;
