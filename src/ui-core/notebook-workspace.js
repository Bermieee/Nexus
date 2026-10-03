import { createButton, element } from './primitives.js';

// The World tab. The Notebook is the story's working state: not canon, and nothing here writes the
// World Tree. It shows the text, who changed it and when, what the model is sent this turn, and what
// the last refresh did.
const drafts=new WeakMap();

export function formatNotebookAge(timestamp,now=Date.now()){
  const value=Number(timestamp);
  if(!Number.isFinite(value)||value<=0)return'never';
  const seconds=Math.max(0,Math.round((now-value)/1000));
  if(seconds<45)return'just now';
  if(seconds<3600)return`${Math.max(1,Math.round(seconds/60))} min ago`;
  if(seconds<86400)return`${Math.round(seconds/3600)} h ago`;
  return`${Math.round(seconds/86400)} d ago`;
}

const author=updatedBy=>({none:'nobody yet',operator:'you','revision rollback':'a rollback','summary-digest':'a Summary digest','legacy-notes':'imported notes'}[updatedBy]??(String(updatedBy).startsWith('sidecar-')?'Nexus refresh':String(updatedBy)));

function section(d,title,{role,note}={}){
  const node=element(d,'section',{className:'nexus-notebook__section',dataset:{role}});
  node.append(element(d,'h2',{text:title}));
  if(note)node.append(element(d,'p',{className:'nexus-muted',text:note}));
  return node;
}

export function renderNotebookWorkspace(host,{notebook,scope=null,refresh=()=>{},now=Date.now}={}){
  const d=host.ownerDocument;
  const root=element(d,'div',{className:'nexus-notebook'});
  const head=element(d,'div',{className:'nexus-workspace-header'});
  head.append(element(d,'h1',{text:'Notebook'}),element(d,'p',{className:'nexus-muted',text:'The story’s working state between turns. It is not canon, and nothing here changes the World Tree.'}));
  root.append(head);
  const finish=()=>host.replaceChildren(root);
  if(!notebook){root.append(element(d,'p',{className:'nexus-muted',attrs:{role:'status'},text:'The Notebook is not available in this session.'}));finish();return root;}
  let view;
  try{view=notebook.read();}catch(error){root.append(element(d,'p',{attrs:{role:'alert'},text:`The Notebook could not be read: ${error?.message??error}`}));finish();return root;}
  if(!view?.active){root.append(element(d,'p',{className:'nexus-muted',attrs:{role:'status'},text:'Open a chat to see its Notebook.'}));finish();return root;}

  const state=drafts.get(notebook)??{editing:false,draft:'',busy:null,message:null};
  drafts.set(notebook,state);
  if(state.chatId!==view.chatId){Object.assign(state,{chatId:view.chatId,editing:false,draft:'',busy:null,message:null});}
  const redraw=()=>refresh();
  const run=async(label,action)=>{
    if(state.busy)return;
    state.busy=label;state.message=null;redraw();
    try{
      const result=await action();
      state.message={kind:'status',text:result?.skipped?`Not run: ${result.reason??'skipped'}.`:`${label} finished.`};
      return result;
    }catch(error){state.message={kind:'error',text:error?.message??String(error)};}
    finally{state.busy=null;redraw();}
  };
  const button=(label,onPress,{disabled=false,variant='secondary'}={})=>createButton(d,{label,scope,variant,disabled:disabled||Boolean(state.busy),onPress});

  // One line: what the last refresh did.
  const last=element(d,'p',{className:'nexus-notebook__last-refresh',dataset:{role:'last-refresh',outcome:view.lastRefresh?.outcome??'none'},attrs:{role:'status'},text:`Last refresh: ${view.lastRefresh?.line??'No refresh has run in this chat yet.'}`});
  if(view.lastRefresh?.at)last.append(element(d,'span',{className:'nexus-muted',text:` · ${formatNotebookAge(view.lastRefresh.at,now())}`}));
  root.append(last);

  // The current text, with Edit / Save / Refresh / Rollback.
  const current=section(d,'Current text',{role:'current'});
  current.append(element(d,'p',{className:'nexus-muted',dataset:{role:'current-meta'},text:`Updated by ${author(view.updatedBy)} · ${formatNotebookAge(view.updatedAt,now())} · ${view.text.length} characters`}));
  if(state.editing){
    const area=element(d,'textarea',{className:'nexus-input nexus-notebook__editor',attrs:{rows:'14','aria-label':'Notebook text'},dataset:{role:'editor'}});
    area.value=state.draft;
    const onInput=()=>{state.draft=String(area.value??'');};
    if(scope?.listen)scope.listen(area,'input',onInput);else area.addEventListener('input',onInput);
    current.append(area);
  }else{
    current.append(element(d,'pre',{className:'nexus-notebook__text',dataset:{role:'text'},text:view.text||'The Notebook is empty. A refresh or an edit will start it.'}));
  }
  const actions=element(d,'div',{className:'nexus-notebook__actions'});
  if(state.editing){
    actions.append(
      button('Save',()=>run('Save',async()=>{const saved=await notebook.save(state.draft);state.editing=false;state.draft='';return saved;}),{variant:'primary'}),
      button('Cancel',()=>{state.editing=false;state.draft='';state.message=null;redraw();}),
    );
  }else{
    actions.append(button('Edit',()=>{state.editing=true;state.draft=view.text;state.message=null;redraw();}));
  }
  actions.append(
    button(state.busy==='Refresh'?'Refreshing…':'Refresh',()=>run('Refresh',()=>notebook.refresh())),
    button('Rollback',()=>run('Rollback',()=>notebook.rollback()),{disabled:!view.canRollback||state.editing}),
  );
  current.append(actions);
  if(state.busy)current.append(element(d,'p',{className:'nexus-muted',attrs:{role:'status'},text:`${state.busy}…`}));
  if(state.message)current.append(element(d,'p',{dataset:{role:'message',kind:state.message.kind},attrs:{role:state.message.kind==='error'?'alert':'status'},text:state.message.text}));
  root.append(current);

  // Who changed it, newest first.
  const revisions=section(d,'Revisions',{role:'revisions',note:'Rollback restores the revision just below the current one.'});
  const list=element(d,'ol',{className:'nexus-notebook__revisions'});
  for(const row of view.revisions??[]){
    const item=element(d,'li',{dataset:{role:'revision',current:String(row.current===true)}});
    item.append(element(d,'strong',{text:row.current?'Current':'Earlier'}),element(d,'span',{text:` · ${author(row.updatedBy)} · ${formatNotebookAge(row.updatedAt,now())} · ${row.chars} characters`}));
    if(row.preview)item.append(element(d,'div',{className:'nexus-muted',text:row.preview}));
    list.append(item);
  }
  revisions.append(list);root.append(revisions);

  // Read-only: exactly what the NOTEBOOK outlet sends this turn.
  const projection=view.projection??{};
  const hot=section(d,'Sent with the next reply',{role:'projection',note:'Read-only. This is the Hot Cognition projection that goes out with the Notebook in the NOTEBOOK outlet.'});
  if(projection.enabled===false)hot.append(element(d,'p',{className:'nexus-muted',text:'The Notebook is turned off, so nothing is sent.'}));
  else{
    hot.append(element(d,'pre',{className:'nexus-notebook__projection',dataset:{role:'hot'},text:projection.hotText||'No Hot Cognition state yet.'}));
    const size=view.budget?`${projection.tokens??0} of about ${view.budget.maxTokens} tokens allowed${view.budget.contextTokens?` for a ${view.budget.contextTokens}-token context`:''}`:`${projection.tokens??0} tokens`;
    hot.append(element(d,'p',{className:'nexus-muted',dataset:{role:'projection-size'},text:`${projection.coldStart?'Cold-start brief · ':''}${size}`}));
    if(projection.compaction?.compacted)hot.append(element(d,'p',{dataset:{role:'compaction'},attrs:{role:'status'},text:`Compacted for this turn: ${projection.compaction.heldBackBlocks} lower-priority block${projection.compaction.heldBackBlocks===1?'':'s'} held back (${projection.compaction.fullTokens} → ${projection.compaction.sentTokens} tokens). The stored Notebook is unchanged.`}));
    const exact=element(d,'details',{dataset:{role:'outlet'}});
    exact.append(element(d,'summary',{text:'Exact text sent'}),element(d,'pre',{className:'nexus-notebook__outlet',dataset:{role:'outlet-text'},text:projection.content||'(nothing)'}));
    hot.append(exact);
  }
  root.append(hot);
  finish();
  return root;
}
