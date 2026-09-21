// A configured embedding endpoint is independent of Main and Sidecar generation.
// No endpoint or key is inferred from the user's model profiles.
//
// Live acceptance showed that sessionStorage is too fragile for the embedding
// credential: a refresh/tab lifecycle can discard a key that is deliberately
// difficult for the operator to replace. Keep one browser-local credential
// owner instead. It is still NOT project/chat/settings data and is never
// exported with Nexus settings/backups. Blank settings saves do not touch it;
// only setPagingSessionKey('') / the explicit UI removal action clears it.
const DURABLE_STORAGE_KEY='nexus.vectorPaging.embeddingApiKey.v2';
const LEGACY_SESSION_STORAGE_KEY='nexus.vectorPaging.embeddingApiKey.v1';
const MEMORY_KEY=Symbol.for('nexus.vectorPaging.embeddingApiKey.v2');
let sessionKey='';

function safeStorage(name){try{return globalThis?.[name]||null;}catch{return null;}}
function safeGet(storage,key){try{return String(storage?.getItem?.(key)||'');}catch{return '';}}
function safeSet(storage,key,value){try{if(!storage)return false;if(value)storage.setItem(key,value);else storage.removeItem(key);return true;}catch{return false;}}

function readStoredKey(){
    const durable=safeGet(safeStorage('localStorage'),DURABLE_STORAGE_KEY);
    if(durable){globalThis[MEMORY_KEY]=durable;return durable;}
    // One-time compatibility migration: preserve a key already loaded by the
    // 0.6.5 session-scoped implementation when the livefix is installed.
    const legacy=safeGet(safeStorage('sessionStorage'),LEGACY_SESSION_STORAGE_KEY);
    if(legacy){
        globalThis[MEMORY_KEY]=legacy;
        const migrated=safeSet(safeStorage('localStorage'),DURABLE_STORAGE_KEY,legacy);
        if(migrated)safeSet(safeStorage('sessionStorage'),LEGACY_SESSION_STORAGE_KEY,'');
        return legacy;
    }
    return String(globalThis[MEMORY_KEY]||'');
}

function writeStoredKey(value){
    const next=String(value||'').trim();
    if(next)globalThis[MEMORY_KEY]=next;else delete globalThis[MEMORY_KEY];
    const durableWritten=safeSet(safeStorage('localStorage'),DURABLE_STORAGE_KEY,next);
    // If localStorage is unavailable, preserve the old per-tab fallback rather
    // than losing the credential immediately. localStorage remains authoritative
    // whenever it is usable.
    if(!durableWritten)safeSet(safeStorage('sessionStorage'),LEGACY_SESSION_STORAGE_KEY,next);
    else safeSet(safeStorage('sessionStorage'),LEGACY_SESSION_STORAGE_KEY,'');
}
function currentSessionKey(){
    if(!sessionKey)sessionKey=readStoredKey();
    return sessionKey;
}

sessionKey=readStoredKey();
export function setPagingSessionKey(value){sessionKey=String(value||'').trim();writeStoredKey(sessionKey);return !!sessionKey;}
export function getPagingSessionKey(){return currentSessionKey();}
export function hasPagingSessionKey(){return !!currentSessionKey();}
export function embedWithSession(texts,config,options={}){return embedTexts(texts,config,{...options,apiKey:currentSessionKey()});}
export function embeddingProfile(config){return JSON.stringify([config.endpoint,config.model,config.maxTextChars,1]);}
export function normalizedVector(values){
    if(!Array.isArray(values)||!values.length||values.length>8192||values.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new Error('Invalid embedding vector.');
    const norm=Math.sqrt(values.reduce((n,v)=>n+v*v,0));
    if(!Number.isFinite(norm)||norm===0)throw new Error('Empty embedding vector.');
    return values.map(v=>v/norm);
}
export async function embedTexts(texts,config,{signal,apiKey='',fetchImpl=globalThis.fetch}={}){
    if(!config.endpoint||!config.model)throw new Error('Select an embedding endpoint and model first.');
    const url=new URL(config.endpoint);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Use an HTTP(S) embeddings URL without embedded credentials.');
    if(!Array.isArray(texts)||!texts.length||texts.some(t=>typeof t!=='string'||t.length>config.maxTextChars))throw new Error('Embedding input exceeds the configured per-record bound.');
    const response=await fetchImpl(url.href,{method:'POST',credentials:'omit',redirect:'error',signal,headers:{'Content-Type':'application/json',...(apiKey?{Authorization:`Bearer ${apiKey}`}:{})},body:JSON.stringify({model:config.model,input:texts})});
    if(!response.ok)throw new Error(`Embedding request failed (${response.status}).`);
    const data=await response.json();
    if(!Array.isArray(data.data)||data.data.length!==texts.length)throw new Error('Embedding response count mismatch.');
    const rows=[...data.data].sort((a,b)=>a.index-b.index);
    if(rows.some((r,i)=>r.index!==i))throw new Error('Embedding response indices are invalid.');
    const vectors=rows.map(r=>normalizedVector(r.embedding));
    if(vectors.some(v=>v.length!==vectors[0].length))throw new Error('Embedding dimensions differ.');
    return vectors;
}
