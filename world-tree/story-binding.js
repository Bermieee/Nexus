// Product operations use the existing Story Scope, never the edit picker or
// globally enabled Lorebook inventory, as their authority.
export function worldTreeStoryBinding(context,scope){
  const chatId=String(context?.chatId??'').trim();
  const read=[...new Set(scope?.readBooks??[])],write=[...new Set(scope?.writeBooks??[])];
  if(!chatId||scope?.configured!==true||read.length!==1||!String(read[0]).trim())return null;
  if(String(scope.chatKey??'')!==chatId)return null;
  const stored=context?.chatMetadata?.tv2_story_scope_v1;
  if(stored&&(stored.configured!==true||Number(stored.version)<2||String(stored.chatKey??'')!==chatId))return null;
  if(write.some(book=>book!==read[0])||(scope.primaryWriteBook&&scope.primaryWriteBook!==read[0]))return null;
  return Object.freeze({chatId,book:read[0],revision:Number(scope.revision)||0,writable:write.includes(read[0])});
}
export function assertWorldTreeStoryBinding(context,scope,{book=null,write=false,expected=null}={}){
  const binding=worldTreeStoryBinding(context,scope);
  if(!binding)throw Error('World Tree requires one Lorebook bound to the active story');
  if(book!=null&&String(book)!==binding.book)throw Error('World Tree Lorebook is outside the active story binding');
  if(write&&!binding.writable)throw Error('World Tree story binding is read-only');
  if(expected&&JSON.stringify(binding)!==JSON.stringify(expected))throw Error('World Tree story binding changed');
  return binding;
}
