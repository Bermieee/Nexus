// What the Notebook tab can ask of the host. Wraps the Notebook module so the UI gets plain data and
// four actions, and never reaches into chat metadata itself.
export function createNotebookHostBinding({api,refresh,readChatId=()=>null,subscribe=()=>()=>{}}={}){
  if(!api)throw new TypeError('The Notebook binding needs the Notebook module API');
  return Object.freeze({
    read(){
      const chatId=readChatId();
      if(chatId==null)return Object.freeze({active:false,chatId:null});
      const doc=api.getNotebook(),projection=api.readNotebookProjection(),status=api.getNotebookRefreshStatus();
      return Object.freeze({
        active:true,chatId:String(chatId),text:doc.text,updatedAt:doc.updatedAt,updatedBy:doc.updatedBy,
        revisions:api.listNotebookRevisions(doc),canRollback:doc.revisions.length>0,
        projection,budget:projection.budget,
        lastRefresh:Object.freeze({...status,line:api.describeRefreshResult(status)}),
      });
    },
    subscribe:listener=>subscribe(listener),
    save:text=>api.saveNotebook(text,{updatedBy:'operator'}),
    rollback:()=>api.rollbackNotebook(),
    refresh:()=>refresh(),
  });
}
