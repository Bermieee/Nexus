import { createButton, createKeyValue, element, makeBadge } from './primitives.js';
import { nexusBrandIconAttrs } from './nexus-brand.js';

const PROFILE_ORDER=['lean','balanced','heavy'];
const PROFILE_LABEL={lean:'Lean',balanced:'Balanced',heavy:'Heavy'};

export function createUidSummarizerState(){
  return{open:false,selection:null,includeKeywords:true,running:false,error:null,result:null,profile:'balanced',edits:{},review:null,status:null};
}

export function openUidSummarizer(state,selection={}){
  if(!state)return false;
  state.open=true;
  state.selection={...selection};
  state.running=false;state.error=null;state.result=null;state.profile='balanced';state.edits={};state.review=null;state.status=null;
  return true;
}

export function closeUidSummarizer(state){
  if(!state)return false;
  state.open=false;state.running=false;state.error=null;state.status=null;
  return true;
}

export function renderUidSummarizerConsole(doc,{state,loreStudy,scope,refresh,notifications}={}){
  if(!state?.open)return null;
  const selection=state.selection??{},runtime=loreStudy?.runtimeStrip?.()??{};
  const veil=element(doc,'div',{className:'nexus-uid-summarizer-veil',attrs:{role:'presentation'}});
  const root=element(doc,'section',{className:'nexus-uid-summarizer',attrs:{role:'dialog','aria-modal':'true','aria-label':'UID Summarizer'}});
  const head=element(doc,'header',{className:'nexus-uid-summarizer__head'});
  const title=element(doc,'div',{className:'nexus-uid-summarizer__title'});
  const titleCopy=element(doc,'div',{className:'nexus-uid-summarizer__title-copy'});
  titleCopy.append(element(doc,'strong',{text:'UID Summarizer'}),element(doc,'span',{text:'Scoped compression + proposal-audited review'}));
  title.append(element(doc,'img',{className:'nexus-uid-summarizer__brand',attrs:nexusBrandIconAttrs()}),titleCopy);
  const strip=renderRuntimeStrip(doc,runtime);
  const close=createButton(doc,{label:'×  Close',scope,size:'sm',variant:'quiet',onPress:()=>{closeUidSummarizer(state);refresh?.();}});
  close.classList?.add?.('nexus-uid-summarizer__close');
  head.append(title,strip,close);

  const controls=element(doc,'div',{className:'nexus-uid-summarizer__controls'});
  const source=element(doc,'div',{className:'nexus-uid-summarizer__source'});
  source.append(element(doc,'span',{className:'nexus-eyebrow',text:'Lorebook'}),element(doc,'strong',{text:String(selection.book??'No source')}));
  const uid=element(doc,'div',{className:'nexus-uid-summarizer__source'});
  uid.append(element(doc,'span',{className:'nexus-eyebrow',text:'Selected UID'}),element(doc,'strong',{text:'#'+String(selection.uid??'—')+' · '+String(selection.title??'Untitled')}));
  const safer=element(doc,'label',{className:'nexus-uid-summarizer__toggle'});
  const checkbox=element(doc,'input',{attrs:{type:'checkbox'}});
  checkbox.checked=state.includeKeywords!==false;
  scope?.listen?.(checkbox,'change',()=>{state.includeKeywords=checkbox.checked;});
  safer.append(checkbox,element(doc,'span',{text:'Suggest safer keywords'}));
  const generate=createButton(doc,{label:state.running?'Summarizing…':'▶  Summarize selected UID',scope,variant:'primary',disabled:state.running||typeof loreStudy?.summarizeLoreUid!=='function',onPress:async()=>{
    state.running=true;state.error=null;state.status='Generating Lean, Balanced, and Heavy drafts…';refresh?.();
    try{
      const result=await loreStudy.summarizeLoreUid({book:selection.book,uid:selection.uid,includeKeywords:state.includeKeywords});
      state.result=result;state.profile=result?.options?.some(x=>x.profileId==='balanced')?'balanced':result?.options?.[0]?.profileId??'balanced';state.edits={};
      for(const option of result?.options??[])state.edits[option.profileId]={summary:String(option.summary??''),keywords:[...(option.keywords??[])]};
      state.status='Three draft profiles generated. Review the selected profile before staging.';
      notifications?.push?.({message:'UID '+String(selection.uid)+' summary drafts ready.',status:'ready'});
    }catch(error){state.error=String(error?.message??error);state.status=null;notifications?.push?.({message:'UID Summarizer failed: '+state.error,status:'error'});}
    finally{state.running=false;refresh?.();}
  }});
  controls.append(source,uid,safer,generate);

  const body=element(doc,'div',{className:'nexus-uid-summarizer__body'});
  const left=renderSelectedUidRail(doc,{selection,state});
  const right=renderReviewRail(doc,{selection,state,loreStudy,scope,refresh,notifications});
  body.append(left,right);

  if(state.error)root.append(head,controls,element(doc,'div',{className:'nexus-uid-summarizer__error',text:state.error}),body);
  else root.append(head,controls,body);
  veil.append(root);
  return veil;
}

function renderSelectedUidRail(doc,{selection,state}={}){
  const rail=element(doc,'aside',{className:'nexus-uid-summarizer__left'});
  const head=element(doc,'div',{className:'nexus-uid-summarizer__panel-head'});
  const copy=element(doc,'div',{className:'nexus-uid-summarizer__panel-copy'});
  copy.append(element(doc,'strong',{text:'Selected UID'}),element(doc,'span',{text:'World Tree source selection'}));
  head.append(element(doc,'span',{className:'nexus-uid-summarizer__panel-icon',text:'⌘'}),copy);
  const card=element(doc,'section',{className:'nexus-uid-summarizer__uid-card'});
  const orb=element(doc,'span',{className:'nexus-uid-summarizer__uid-orb'});
  const title=element(doc,'div',{className:'nexus-uid-summarizer__uid-title'});
  title.append(element(doc,'strong',{text:String(selection.title??'Untitled UID')}),element(doc,'span',{text:'#'+String(selection.uid??'—')}));
  card.append(orb,title);
  card.append(createKeyValue(doc,[
    {key:'Lorebook',value:selection.book??'NO_EVIDENCE'},
    {key:'Category',value:selection.category??'NO_EVIDENCE'},
    {key:'Owner state',value:selection.ownerState??'NO_EVIDENCE'},
    {key:'Retrieval-ready',value:selection.retrievalReady?'Yes':'No'},
    {key:'Revision',value:selection.revision??'NO_EVIDENCE'},
    {key:'Representations',value:selection.representations??0},
    {key:'Derived refs',value:selection.derivedRefs??0},
  ]));
  const keys=Array.isArray(selection.keys)?selection.keys:[];
  const keyBox=element(doc,'div',{className:'nexus-uid-summarizer__keys'});
  keyBox.append(element(doc,'span',{className:'nexus-eyebrow',text:'Current keys'}));
  if(keys.length){const chips=element(doc,'div',{className:'nexus-uid-summarizer__key-chips'});for(const key of keys.slice(0,12))chips.append(makeBadge(doc,String(key),'observed'));keyBox.append(chips);}
  else keyBox.append(element(doc,'span',{className:'nexus-muted',text:'No source keywords published.'}));
  rail.append(head,card,keyBox);
  if(state.result){
    rail.append(createKeyValue(doc,[
      {key:'Original tokens',value:state.result.originalTokens??'—'},
      {key:'Drafts generated',value:state.result.options?.length??0},
      {key:'Transaction',value:state.result.transactionId??'—'},
    ]));
  }
  return rail;
}

function renderReviewRail(doc,{selection,state,loreStudy,scope,refresh,notifications}={}){
  const rail=element(doc,'section',{className:'nexus-uid-summarizer__right'});
  const intro=element(doc,'div',{className:'nexus-uid-summarizer__review-head'});
  const copy=element(doc,'div',{className:'nexus-uid-summarizer__panel-copy'});
  copy.append(element(doc,'strong',{text:'Review workflow'}),element(doc,'span',{text:'Generate once, compare Lean / Balanced / Heavy, then stage only the chosen draft.'}));
  intro.append(element(doc,'span',{className:'nexus-uid-summarizer__review-icon',text:'▤'}),copy);
  rail.append(intro);

  if(!state.result){
    const empty=element(doc,'div',{className:'nexus-uid-summarizer__empty'});
    empty.append(element(doc,'span',{className:'nexus-uid-summarizer__empty-icon',text:'▤'}),element(doc,'strong',{text:state.running?'Generating three summary profiles…':'No summary drafts generated yet.'}),element(doc,'span',{text:state.running?'Nexus is producing Lean, Balanced, and Heavy together.':'Click “Summarize selected UID” to generate all three review options.'}));
    if(state.status)empty.append(element(doc,'small',{text:state.status}));
    rail.append(empty);return rail;
  }

  const options=state.result.options??[];
  const tabs=element(doc,'div',{className:'nexus-uid-summarizer__profiles',attrs:{role:'tablist','aria-label':'Summary profiles'}});
  for(const id of PROFILE_ORDER){
    const option=options.find(row=>row.profileId===id);
    const button=createButton(doc,{label:PROFILE_LABEL[id],scope,size:'sm',variant:state.profile===id?'primary':'quiet',disabled:!option,onPress:()=>{state.profile=id;refresh?.();}});
    button.setAttribute?.('role','tab');button.setAttribute?.('aria-selected',String(state.profile===id));button.dataset.profile=id;
    tabs.append(button);
  }
  rail.append(tabs);

  const option=options.find(row=>row.profileId===state.profile)??options[0];
  if(!option)return rail;
  const edit=state.edits[option.profileId]??{summary:String(option.summary??''),keywords:[...(option.keywords??[])]};
  state.edits[option.profileId]=edit;
  const stats=element(doc,'div',{className:'nexus-uid-summarizer__draft-stats'});
  stats.append(
    metric(doc,'Profile',option.label??PROFILE_LABEL[option.profileId]??option.profileId),
    metric(doc,'Estimated',String(option.estimatedTokens??'—')+' tok'),
    metric(doc,'Target',String(option.targetTokens??'—')+' tok'),
    metric(doc,'Safety cap',String(option.safetyCapTokens??'—')+' tok')
  );
  const summaryLabel=element(doc,'label',{className:'nexus-uid-summarizer__draft-label'});
  summaryLabel.append(element(doc,'span',{text:'Summary draft'}));
  const textarea=element(doc,'textarea',{className:'nexus-uid-summarizer__draft',attrs:{rows:'14','aria-label':(option.label??option.profileId)+' summary draft'}});
  textarea.value=edit.summary;scope?.listen?.(textarea,'input',()=>{edit.summary=String(textarea.value??'');});
  summaryLabel.append(textarea);
  const keywordsLabel=element(doc,'label',{className:'nexus-uid-summarizer__draft-label'});
  keywordsLabel.append(element(doc,'span',{text:'Suggested keywords'}));
  const keywords=element(doc,'input',{className:'nexus-input',attrs:{type:'text','aria-label':'Suggested keywords'}});
  keywords.value=(edit.keywords??[]).join(', ');scope?.listen?.(keywords,'input',()=>{edit.keywords=String(keywords.value??'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,12);});
  keywordsLabel.append(keywords);
  rail.append(stats,summaryLabel,keywordsLabel);

  const actions=element(doc,'div',{className:'nexus-uid-summarizer__review-actions'});
  const stage=createButton(doc,{label:'Stage '+String(option.label??'selected')+' for review',scope,variant:'primary',disabled:!loreStudy?.capabilities?.().stageLoreUidSummary||Boolean(state.review),onPress:async()=>{
    state.error=null;state.status='Staging selected draft in the Nexus review ledger…';refresh?.();
    try{
      state.review=await loreStudy.stageLoreUidSummary({transactionId:state.result.transactionId,option,summary:edit.summary,keywords:edit.keywords});
      state.status='Selected '+String(option.label)+' draft staged for operator review. No lore write has occurred.';
      notifications?.push?.({message:String(option.label)+' UID summary staged for review. No canonical write occurred.',status:'ready'});
    }catch(error){state.error=String(error?.message??error);state.status=null;}
    refresh?.();
  }});
  actions.append(stage);
  if(state.review){
    actions.append(makeBadge(doc,'STAGED · NOT COMMITTED','warning'));
    if(loreStudy?.capabilities?.().rejectLoreUidSummary)actions.append(createButton(doc,{label:'Reject staged draft',scope,size:'sm',variant:'quiet',onPress:async()=>{
      try{await loreStudy.rejectLoreUidSummary({transactionId:state.result.transactionId,reason:'Rejected in UID Summarizer review'});state.status='Staged summary rejected. No lore write occurred.';state.review=null;notifications?.push?.({message:'UID summary review rejected.',status:'info'});}
      catch(error){state.error=String(error?.message??error);}refresh?.();
    }}));
  }
  rail.append(actions);
  if(state.status)rail.append(element(doc,'p',{className:'nexus-uid-summarizer__status',text:state.status}));
  return rail;
}

function renderRuntimeStrip(doc,status={}){
  const root=element(doc,'div',{className:'nexus-uid-summarizer__runtime'});
  const add=(label,state,value=null)=>{const row=element(doc,'span',{className:'nexus-uid-summarizer__runtime-item',dataset:{state:String(state??'unknown')}});row.append(element(doc,'i'),element(doc,'b',{text:label}),element(doc,'span',{text:value==null?String(state??'unknown'):String(value)}));root.append(row);};
  add('Main',status.main?.state??'unknown');add('A',status.A?.state??'unknown');add('B',status.B?.state??'unknown');add('Queued',Number(status.queued)>0?'queued':'idle',status.queued??0);
  return root;
}
function metric(doc,label,value){const box=element(doc,'div',{className:'nexus-uid-summarizer__metric'});box.append(element(doc,'span',{text:label}),element(doc,'strong',{text:String(value)}));return box;}
