import { getContext } from '../../../../../st-context.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh } from '../../../nexus/work-scope.js';

export function beginA52Work(options={}){return captureNexusWorkScope(getContext(),options);}
export function stillFresh(scope){return isNexusWorkScopeFresh(scope,getContext());}
export function isSourceRevisionCurrent(ref,{currentSourceRefs=null,worldTree=null}={}){
  const value=String(ref??'').trim();if(!value)return false;
  if(currentSourceRefs){const set=currentSourceRefs instanceof Set?currentSourceRefs:new Set((currentSourceRefs??[]).map(String));if(set.has(value))return true;}
  if(value.startsWith('world-tree:')&&worldTree){
    const parts=value.split(':');const revision=Number(parts.pop());const nodeId=parts.slice(1).join(':');const node=worldTree.getNode(nodeId);
    return !!node&&Number(node.revision)===revision;
  }
  return currentSourceRefs==null;
}
