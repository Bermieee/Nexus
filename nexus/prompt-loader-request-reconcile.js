import {
  comparePromptLoaderAdapterSelection,
  promptLoaderPresentationsCompatible,
  resolvePromptLoaderAdapter,
} from './prompt-loader-adapters.js';
import { composeGenerationFrame } from './generation-frame-contract.js';

function clean(value){return String(value??'').trim();}
function replaceFirst(text,needle,replacement){
  const index=text.indexOf(needle);
  if(index<0)return null;
  return text.slice(0,index)+replacement+text.slice(index+needle.length);
}
function replaceInContent(content,needle,replacement){
  if(typeof content==='string'){
    const next=replaceFirst(content,needle,replacement);
    return next==null?null:{content:next,partIndex:null};
  }
  if(!Array.isArray(content))return null;
  for(let i=0;i<content.length;i+=1){
    const part=content[i];
    if(!part||typeof part!=='object')continue;
    const field=typeof part.text==='string'?'text':typeof part.content==='string'?'content':null;
    if(!field)continue;
    const next=replaceFirst(part[field],needle,replacement);
    if(next==null)continue;
    part[field]=next;
    return{content,partIndex:i};
  }
  return null;
}

/**
 * Reconcile only Nexus-owned presentation bytes in the already assembled
 * Chat Completion request. Semantic outlets and their selected content remain
 * unchanged. This exists for the exact case where SillyTavern's authoritative
 * request model/provider differs from the adapter inferred before prompt build.
 */
export function reconcilePromptLoaderRequestMessages({
  messages=[],
  frame=null,
  model='',
  provider='',
}={}){
  const oldPrompt=String(frame?.serializedPrompt??'');
  const sealedAdapter=frame?.promptLoader??frame?.manifest?.promptLoader??null;
  const actualAdapter=resolvePromptLoaderAdapter({model:clean(model),provider:clean(provider)});
  const verification=sealedAdapter
    ?comparePromptLoaderAdapterSelection(sealedAdapter,{model:clean(model),provider:clean(provider)})
    :null;

  if(!frame||!oldPrompt||!Array.isArray(messages)){
    return Object.freeze({
      corrected:false,
      changedBytes:false,
      reason:'missing-request-or-frame',
      verification,
      actualAdapter,
      messageIndex:null,
      partIndex:null,
    });
  }
  if(verification?.matched===true){
    return Object.freeze({
      corrected:false,
      changedBytes:false,
      reason:'adapter-match',
      verification,
      actualAdapter,
      messageIndex:null,
      partIndex:null,
    });
  }

  const presentationCompatible=sealedAdapter
    ?promptLoaderPresentationsCompatible(sealedAdapter,actualAdapter)
    :false;
  const recomposed=composeGenerationFrame(frame,{promptLoader:actualAdapter});
  const newPrompt=String(recomposed?.serializedPrompt??'');
  if(!newPrompt){
    return Object.freeze({
      corrected:false,
      changedBytes:false,
      reason:'recompose-empty',
      verification,
      actualAdapter,
      messageIndex:null,
      partIndex:null,
    });
  }
  if(newPrompt===oldPrompt){
    return Object.freeze({
      corrected:true,
      changedBytes:false,
      reason:presentationCompatible?'compatible-presentation':'equivalent-bytes',
      verification,
      actualAdapter,
      messageIndex:null,
      partIndex:null,
      serializedPrompt:newPrompt,
    });
  }

  for(let i=0;i<messages.length;i+=1){
    const row=messages[i];
    if(!row||typeof row!=='object')continue;
    const replaced=replaceInContent(row.content,oldPrompt,newPrompt);
    if(!replaced)continue;
    row.content=replaced.content;
    return Object.freeze({
      corrected:true,
      changedBytes:true,
      reason:'request-presentation-reconciled',
      verification,
      actualAdapter,
      messageIndex:i,
      partIndex:replaced.partIndex,
      serializedPrompt:newPrompt,
    });
  }

  return Object.freeze({
    corrected:false,
    changedBytes:false,
    reason:'sealed-prompt-not-found',
    verification,
    actualAdapter,
    messageIndex:null,
    partIndex:null,
  });
}
