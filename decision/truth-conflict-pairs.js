import { resolveNodeAuthority } from '../nexus/truth-classification.js';

// Candidate pairs for the post-turn truth.conflict judgment: a current fact this chat
// established (observed or remembered) against verified source canon about the same
// subject. Nothing here decides a conflict; the Decision site does, and Truth reads the
// result for this chat only. Canon must come from the active story's single bound book.
const CHAT_FACT_KINDS=new Set(['memory','character-memory','scene']);
const CHAT_FACT_AUTHORITIES=new Set(['OBSERVED','REMEMBERED']);
const text=node=>String(node?.payload?.content??node?.payload?.text??node?.payload?.summary??'').replace(/\s+/g,' ').trim();

export function chatCanonConflictPairs({api,nodes=[],chatId=null,canonBooks=null,limit=4}={}){
  if(chatId==null||!api?.findByAlias||!Array.isArray(canonBooks)||canonBooks.length!==1)return[];
  const pairs=[],seen=new Set();
  for(const chatNode of [...nodes].reverse()){
    if(!CHAT_FACT_KINDS.has(String(chatNode?.kind))||String(chatNode?.scope)!==String(chatId))continue;
    if(!CHAT_FACT_AUTHORITIES.has(String(chatNode?.authority??'').toUpperCase())||chatNode?.temporalStatus!=='CURRENT')continue;
    for(const alias of chatNode.aliases??[]){
      for(const canonNode of api.findByAlias(alias,chatId)){
        if(canonNode?.kind!=='lore'||canonNode?.scope!=='global')continue;
        if(resolveNodeAuthority(canonNode,{canonBooks}).authority!=='CANON')continue;
        if(!(canonNode.temporalStatus==='CURRENT'||canonNode.importDefaultedTiming===true))continue;
        const key=chatNode.id+'|'+canonNode.id;
        if(seen.has(key)||text(chatNode)===text(canonNode))continue;
        seen.add(key);
        pairs.push({chatNode,canonNode});
        if(pairs.length>=limit)return pairs;
      }
    }
  }
  return pairs;
}
