// Attachment is an explicit operator action. It reuses Nexus's existing
// durable Story Scope writer; ordinary reads/imports never infer an attachment.
export async function attachWorldTreeStoryBook({book,getContext,getManagedBooks,configureCurrentStoryScope}={}){
  const context=getContext(),chatId=String(context?.chatId??'').trim(),id=String(book??'').trim();
  if(!chatId||!context.chatMetadata)throw Error('Attach a Lorebook requires an active story');
  const prior=JSON.stringify(context.chatMetadata.tv2_story_scope_v1??null);
  const books=getManagedBooks({requireTree:false,access:'any',injection:'any'});
  if(!id||!books.includes(id))throw Error('Choose a valid Lorebook to attach to this story');
  const preflight=()=>{const live=getContext();if(String(live?.chatId??'')!==chatId||live.chatMetadata!==context.chatMetadata||JSON.stringify(live.chatMetadata.tv2_story_scope_v1??null)!==prior)throw Error('Story binding changed while attachment was pending');};
  preflight();
  const scope=await configureCurrentStoryScope({readBooks:[id],writeBooks:[id],primaryWriteBook:id,reason:'operator-world-tree-story-attachment'},{managedBooks:books,preflight});
  const live=getContext();
  if(String(live?.chatId??'')!==chatId||live.chatMetadata!==context.chatMetadata)throw Error('Story changed while attaching Lorebook; no World Tree source was loaded');
  return {kind:'NexusWorldTreeStoryAttachment',chatId,book:id,revision:scope.revision};
}
