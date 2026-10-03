// Moves a chat's stored Notebook to the current key, once. This is the only file that names the
// retired keys: read the old value, write the new key, drop the old.
import { NOTEBOOK_KEY } from './notebook-document.js';

const RETIRED_DOCUMENT_KEY='tv2_notebook_v2';
const RETIRED_NOTES_KEY='tv2_notebook_v1';
export const NOTEBOOK_RETIRED_KEYS=Object.freeze([RETIRED_DOCUMENT_KEY,RETIRED_NOTES_KEY]);

const isDocument=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const clean=value=>String(value??'').trim();

export function migrateNotebookMetadata(metadata){
  if(!isDocument(metadata))return{migrated:false,dropped:[]};
  let migrated=false;
  if(!isDocument(metadata[NOTEBOOK_KEY])){
    const retired=metadata[RETIRED_DOCUMENT_KEY],notes=metadata[RETIRED_NOTES_KEY];
    if(isDocument(retired)){metadata[NOTEBOOK_KEY]=retired;migrated=true;}
    else if(Array.isArray(notes)&&notes.length){
      const text=notes.map(note=>`${clean(note?.title)||'Working note'}\n${clean(note?.text)}`).filter(Boolean).join('\n\n');
      metadata[NOTEBOOK_KEY]={version:2,text,updatedAt:0,updatedBy:'legacy-notes',revisions:[]};migrated=true;
    }
  }
  const dropped=[];
  for(const key of NOTEBOOK_RETIRED_KEYS)if(Object.hasOwn(metadata,key)){delete metadata[key];dropped.push(key);}
  return{migrated,dropped};
}
