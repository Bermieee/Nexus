// The Notebook document: one rolling working-state text per chat, with a short revision trail.
// Pure functions. The host module owns chat metadata, durability and events.
export const NOTEBOOK_KEY='nexus_notebook_v1';
export const NOTEBOOK_REFRESH_STATUS_KEY='nexus_notebook_refresh_v1';
export const NOTEBOOK_REVISION_LIMIT=6;

export const NOTEBOOK_REFRESH_OUTCOME=Object.freeze({
  UPDATED:'updated',
  NO_CHANGE:'no-material-change',
  REJECTED:'rejected',
  FAILED:'failed',
});

const clean=value=>String(value??'').trim();
const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
const limitOf=value=>Math.max(1,Math.min(12,Math.floor(Number(value)||NOTEBOOK_REVISION_LIMIT)));

export function emptyNotebook(){return{version:2,text:'',updatedAt:0,updatedBy:'none',revisions:[]};}

export function normalizeNotebook(raw,{revisionLimit=NOTEBOOK_REVISION_LIMIT}={}){
  const source=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:emptyNotebook();
  const revisions=(Array.isArray(source.revisions)?source.revisions:[]).map(row=>({text:String(row?.text??''),updatedAt:Number(row?.updatedAt)||0,updatedBy:clean(row?.updatedBy)||'none'}));
  return{version:2,text:String(source.text||''),updatedAt:Number(source.updatedAt)||0,updatedBy:clean(source.updatedBy)||'none',revisions:revisions.slice(-limitOf(revisionLimit))};
}

// A save keeps the text it replaces as the newest revision. `assertFits` throws when the text is over the hard ceiling.
export function saveIntoNotebook(current,text,{updatedBy='operator',now=Date.now(),revisionLimit=NOTEBOOK_REVISION_LIMIT,assertFits=null}={}){
  const doc=normalizeNotebook(clone(current),{revisionLimit}),next=String(text??'').trim(),previous=doc.text;
  if(next===previous)return{doc,changed:false};
  assertFits?.(next);
  if(previous)doc.revisions=[...doc.revisions,{text:previous,updatedAt:doc.updatedAt,updatedBy:doc.updatedBy}].slice(-limitOf(revisionLimit));
  doc.text=next;doc.updatedAt=now;doc.updatedBy=clean(updatedBy)||'operator';
  return{doc,changed:true};
}

export function rollbackNotebookDocument(current,{now=Date.now(),revisionLimit=NOTEBOOK_REVISION_LIMIT}={}){
  const doc=normalizeNotebook(clone(current),{revisionLimit}),prior=doc.revisions.pop();
  if(!prior)throw new Error('There is no earlier Notebook revision to restore.');
  doc.text=String(prior.text||'');doc.updatedAt=now;doc.updatedBy='revision rollback';
  return doc;
}

// Newest first: the current text, then each earlier revision, with who wrote it and when.
export function listNotebookRevisions(doc){
  const normalized=normalizeNotebook(doc);
  const row=(entry,index,current)=>({index,current,updatedAt:entry.updatedAt,updatedBy:entry.updatedBy,chars:entry.text.length,preview:entry.text.replace(/\s+/g,' ').trim().slice(0,120)});
  const rows=normalized.revisions.map((entry,index)=>row(entry,index,false)).reverse();
  return[row(normalized,-1,true),...rows];
}

export function normalizeRefreshStatus(raw){
  const source=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
  const outcome=Object.values(NOTEBOOK_REFRESH_OUTCOME).includes(source.outcome)?source.outcome:null;
  return{outcome,reason:clean(source.reason),manual:source.manual===true,at:Number(source.at)||0,evidenceThrough:Number.isFinite(Number(source.evidenceThrough))?Number(source.evidenceThrough):-1,fingerprint:clean(source.fingerprint)};
}

// One line for the operator: what the last refresh did, and why.
export function describeRefreshResult(status){
  const value=normalizeRefreshStatus(status);
  if(!value.outcome)return'No refresh has run in this chat yet.';
  const label={[NOTEBOOK_REFRESH_OUTCOME.UPDATED]:'Updated',[NOTEBOOK_REFRESH_OUTCOME.NO_CHANGE]:'No material change',[NOTEBOOK_REFRESH_OUTCOME.REJECTED]:'Rejected',[NOTEBOOK_REFRESH_OUTCOME.FAILED]:'Failed'}[value.outcome];
  return`${label}${value.reason?` — ${value.reason}`:''}${value.manual?' (manual)':''}`;
}
