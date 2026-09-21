const revisions=new Map();
const cache=new Map();

export function getSearchIndexRevision(book=''){return Number(revisions.get(String(book))||0);}
export function invalidateSearchIndex(book=''){
    const key=String(book||'');
    if(!key){cache.clear();revisions.clear();return 0;}
    const next=getSearchIndexRevision(key)+1;revisions.set(key,next);cache.delete(key);return next;
}
export function getCachedSearchIndex(book=''){
    const key=String(book||''),row=cache.get(key);if(!row)return null;
    return row.revision===getSearchIndexRevision(key)?row.value:null;
}
export function setCachedSearchIndex(book='',value=null){
    const key=String(book||'');cache.set(key,{revision:getSearchIndexRevision(key),value});return value;
}
export function clearSearchIndexCache(){cache.clear();}
