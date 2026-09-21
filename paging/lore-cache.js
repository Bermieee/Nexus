// Rebuildable vectors, keyed by book and embedding profile. No prompt authority,
// canonical content, credentials or chat residency is persisted here.
const DB='nexus-lore-vector-books-v1';
const LIMIT_MS=2000;
async function open(){
    if(!globalThis.indexedDB)return null;
    return new Promise((resolve,reject)=>{
        let settled=false;const request=indexedDB.open(DB,1);
        const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);reject(new Error('Lore vector cache unavailable.'));};
        const timer=setTimeout(fail,LIMIT_MS);
        request.onupgradeneeded=()=>{for(const name of ['books','metadata'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name);};
        request.onerror=request.onblocked=fail;
        request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();if(settled){db.close();return;}settled=true;clearTimeout(timer);resolve(db);};
    });
}
async function transaction(mode,run){
    const db=await open();if(!db)return null;
    try{return await new Promise((resolve,reject)=>{
        const tx=db.transaction(['books','metadata'],mode);let result=null;
        const timer=setTimeout(()=>{try{tx.abort();}catch{}reject(new Error('Lore vector cache timed out.'));},LIMIT_MS);
        tx.oncomplete=()=>{clearTimeout(timer);resolve(result);};
        tx.onerror=tx.onabort=()=>{clearTimeout(timer);reject(tx.error||new Error('Lore vector cache transaction failed.'));};
        try{run(tx,value=>{result=value;});}catch(error){clearTimeout(timer);try{tx.abort();}catch{}reject(error);}
    });}finally{db.close();}
}
function validRow(row){return typeof row?.id==='string'&&typeof row.version==='string'&&Array.isArray(row.vector)&&row.vector.length>0&&row.vector.length<=8192&&row.vector.every(v=>typeof v==='number'&&Number.isFinite(v));}
function rowBytes(row){return 128+2*(row.id.length+row.version.length)+row.vector.length*8;}
function entryId(id){try{const [book,uid]=JSON.parse(id);return JSON.stringify([String(book),Number(uid)]);}catch{return '';}}

export async function readLoreVectorCache(key){
    return transaction('readwrite',(tx,done)=>{
        const books=tx.objectStore('books'),meta=tx.objectStore('metadata');
        const request=books.get(key);
        request.onsuccess=()=>{
            const record=request.result;if(!Array.isArray(record?.rows)){done(null);return;}
            const metadata=meta.get(key);metadata.onsuccess=()=>{if(metadata.result)meta.put({...metadata.result,touched:Date.now()},key);};
            done(record.rows);
        };
    });
}

export async function writeLoreVectorCache(key,rows,{budgetMiB=256,liveEntryIds=null}={}){
    // The budget covers cached vectors across all books/profiles. Actual browser
    // storage overhead varies; a quota failure is an ordinary cache miss.
    const budget=Math.max(1,Number(budgetMiB)||256)*1024*1024;
    const incoming=(Array.isArray(rows)?rows:[]).filter(validRow);
    const live=liveEntryIds?new Set(liveEntryIds):null;
    return transaction('readwrite',(tx,done)=>{
        const books=tx.objectStore('books'),metadata=tx.objectStore('metadata');
        const request=books.get(key);
        request.onsuccess=()=>{
            // Merge partial working-set coverage. Switching to A+B must not
            // overwrite A's reusable cache with only A's currently loaded slice.
            const merged=new Map();
            for(const row of request.result?.rows||[])if(validRow(row)&&(!live||live.has(entryId(row.id))))merged.set(row.id,row);
            for(const row of incoming){merged.delete(row.id);merged.set(row.id,row);}
            let size=256+String(key).length*2;
            for(const row of merged.values())size+=rowBytes(row);
            for(const [id,row] of merged){if(size<=budget)break;merged.delete(id);size-=rowBytes(row);}
            const all=metadata.getAll();
            all.onsuccess=()=>{
                const others=(all.result||[]).filter(m=>m?.key!==key).sort((a,b)=>a.touched-b.touched||String(a.key).localeCompare(String(b.key)));
                let total=size+others.reduce((sum,m)=>sum+(Number(m.bytes)||0),0);
                const evicted=[];
                for(const m of others){if(total<=budget)break;books.delete(m.key);metadata.delete(m.key);total-=Number(m.bytes)||0;evicted.push(m.key);}
                books.put({rows:[...merged.values()]},key);
                metadata.put({key,bytes:size,touched:Date.now(),rows:merged.size},key);
                done({stored:merged.size,estimatedBytes:total,evicted});
            };
        };
    });
}

export async function clearLoreVectorCache(){return transaction('readwrite',(tx,done)=>{tx.objectStore('books').clear();tx.objectStore('metadata').clear();done(true);});}
