import { getSettings, updateSettings } from '../core/settings.js';
import { logEvent } from '../observability/telemetry.js';
import { normalizeWorldTreeDocument, worldTreeDocumentStats } from './a52/shared/world-tree-document.js';

const clone=value=>value==null?value:structuredClone(value);

export function getGlobalWorldTreeDocument(){
  const settings=getSettings();
  return clone(normalizeWorldTreeDocument(settings.worldTree));
}

export function mutateGlobalWorldTreeDocumentDirect(mutator,{reason='world-tree-mutation',legacyTreeBooks=[]}={}){
  if(typeof mutator!=='function')throw new TypeError('World Tree mutation requires a mutator function');
  let result=null,stats=null;
  updateSettings(settings=>{
    const before=normalizeWorldTreeDocument(settings.worldTree);
    const working=clone(before);
    const value=mutator(working,settings);
    const next=normalizeWorldTreeDocument(value?.kind==='NexusWorldTreeDocument'?value:working);
    next.revision=Math.max(before.revision+1,next.revision);
    next.updatedAt=Date.now();
    settings.worldTree=next;
    settings.trees=settings.trees||{};
    for(const book of legacyTreeBooks??[])delete settings.trees[String(book)];
    result=value?.kind==='NexusWorldTreeDocument'?clone(next):clone(value);
    stats=worldTreeDocumentStats(next);
  });
  logEvent('world-tree','global-mutated',{reason,legacyTreeBooks:[...(legacyTreeBooks??[])],stats},'info');
  return result??getGlobalWorldTreeDocument();
}

export function setGlobalWorldTreeDocumentDirect(document,{reason='world-tree-replaced',legacyTreeBooks=[]}={}){
  const next=normalizeWorldTreeDocument(document);
  return mutateGlobalWorldTreeDocumentDirect(working=>{
    for(const key of Object.keys(working))delete working[key];
    Object.assign(working,clone(next));
    return working;
  },{reason,legacyTreeBooks});
}

export function globalWorldTreeStats(){
  return worldTreeDocumentStats(getGlobalWorldTreeDocument());
}

export function globalWorldTreeNode(id){
  return getGlobalWorldTreeDocument().nodes?.[String(id)]??null;
}

export function listGlobalWorldTreeNodes({kind=null,scope=null}={}){
  return Object.values(getGlobalWorldTreeDocument().nodes??{})
    .filter(node=>kind==null||String(node.kind)===String(kind))
    .filter(node=>scope==null||String(node.scope)===String(scope))
    .map(clone);
}
