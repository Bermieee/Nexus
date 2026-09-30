import { ProductDetailLevel } from './wave5-product-model.js';
import { createButton, createKeyValue, createProgressBar, element, makeBadge } from './primitives.js';
import {
  LoreReviewOwnerPath, LoreReviewProposalKind, buildExactLoreEntries, buildHumanLoreTree,
  compareMutationFences, createLoreReviewProposal, loreRestudyProgress, mutationRestudyProgress,
  proposalOwnerPath, summarizeLoreReviewAction, toOwnerMutationRequest, verifySelectedLorebook,
} from './lore-review-workflow.js';

const ALL_KINDS=Object.values(LoreReviewProposalKind);
const PAGE_SIZE=24;
const REVIEW_PAGE_SIZE=12;
const OWNER_QUEUE_LIMIT=32;

export function createLoreReviewUiState(){
  return{
    bookId:null,sourceId:null,secondSourceId:null,entryQuery:'',entryPage:0,reviewPage:0,
    proposalKind:'UPDATE_ENTRY',proposalTitle:'',proposalContent:'',proposalTreePath:'',proposalReason:'',
    proposalTargetUid:'',splitSecondUid:'',splitSecondTitle:'',splitSecondContent:'',splitSecondTreePath:'',
    queuedProposals:[],ownerProposalByLocal:{},sessionId:null,settlementId:null,mergeBookId:null,mergeOutputId:'',status:'',
  };
}

export function renderLoreReviewWorkspace(host,{loreStudy,loreAuthoring,actionRouter,scope,refresh,productAdapter,draft=null}={}){
  const d=host.ownerDocument,state=ensureState(draft??createLoreReviewUiState()),detail=productAdapter?.getDetailLevel?.()??ProductDetailLevel.NORMAL;
  const section=element(d,'section',{className:'a52-lore-review-workspace',attrs:{'aria-label':'Lore authoring and review'}});
  const caps=loreAuthoring?.capabilities?.()??{},ownerSnapshot=loreAuthoring?.snapshot?.()??{last:{}};
  const discovery=valueOf(ownerSnapshot.last?.discovery),books=discovery?.books??[];
  const selected=loreStudy?.selectedLorebook?.()??{},selectedSnapshot=selected.snapshot??null;
  const loreRead=loreStudy?.read?.()??null;
  const chatId=loreRead?.source?.selection?.chatId??selected.selection?.chatId??null;

  section.append(workspaceHeader(d,caps));
  if(!loreAuthoring){
    section.append(message(d,'Owner authoring contract unavailable','Worker 4 authoring reads/actions are not exported by this assembly. No proposal can be approved or committed from the UI.','offline'));
    host.append(section);return;
  }

  const topActions=element(d,'div',{className:'a52-wave13-resource-actions'});
  topActions.append(createButton(d,{label:books.length?'Refresh owner source identity':'Load owner source identity',scope,size:'sm',variant:'quiet',disabled:!caps.discovery,onPress:async()=>{
    const route=await actionRouter.route({type:'wave13.loreAuthoring.discover',payload:{}});
    state.status=routeMessage(route,'Worker 4 source identity refreshed.');refresh?.();
  }}));
  section.append(topActions);

  if(!caps.reviewedMutation){
    const missing=[
      !caps.mutationCreate?'create':null,!caps.mutationApprove?'approve':null,!caps.mutationReject?'reject':null,
      !caps.mutationCommit?'commit':null,!caps.mutationRestore?'restore':null,!caps.mutationProposal?'proposal read':null,
      !caps.mutationQueue?'queue read':null,!caps.mutationAudit?'audit read':null,
    ].filter(Boolean);
    section.append(message(d,'Reviewed mutation extension unavailable',
      'Worker 4 mutationExtensionVersion:1 is incomplete or unavailable in this assembly. Missing: '+(missing.join(', ')||'contract version marker')+'. Local drafts remain non-authoritative and no direct Lorebook write is offered.','warning'));
  }else{
    section.append(message(d,'Reviewed mutation extension connected',
      'Worker 4 mutationExtensionVersion '+String(caps.mutationExtensionVersion)+' owns review, commit, recovery and restoration for all seven operator mutation kinds.','ready'));
  }
  if(!chatId)section.append(message(d,'Exact chat scope unavailable','Owner mutation submission is disabled until the selected Lorebook is bound to an exact chat. The UI will not silently elevate to GLOBAL_OPERATOR.','warning'));
  if(!caps.adaptiveNavigation)section.append(message(d,'Adaptive navigation read pending','The exact authored tree and Worker 4 generated Tree proposals remain available. No richer adaptive-navigation state is inferred.','historical'));

  if(!books.length){
    section.append(message(d,'No owner authoring sources loaded',state.status||'Load Worker 4 source identity after the selected SillyTavern Lorebook has been discovered and accepted.','historical'));
    host.append(section);return;
  }

  const selectedId=String(selectedSnapshot?.id??'');
  state.bookId=books.some(row=>row.lorebookId===state.bookId)?state.bookId:books.some(row=>String(row.lorebookId)===selectedId)?selectedId:books[0].lorebookId;
  const book=books.find(row=>row.lorebookId===state.bookId)??books[0],sources=book.sources??[];
  if(!sources.some(row=>row.sourceId===state.sourceId))state.sourceId=sources[0]?.sourceId??null;
  if(!sources.some(row=>row.sourceId===state.secondSourceId)||state.secondSourceId===state.sourceId)state.secondSourceId=sources.find(row=>row.sourceId!==state.sourceId)?.sourceId??null;
  const source=sources.find(row=>row.sourceId===state.sourceId)??null;
  const exact=selectedSnapshot?.id===book.lorebookId?(selectedSnapshot.entries??[]).find(row=>String(row.uid)===String(source?.uid)):null;
  syncProposalFields(state,source,exact);

  section.append(renderSourceBrowser(d,{state,book,books,sources,selectedSnapshot,scope,refresh,detail}));
  section.append(renderProposalComposer(d,{state,book,sources,source,exact,caps,chatId,actionRouter,scope,refresh}));
  section.append(renderOwnerMutationQueue(d,{state,loreStudy,loreAuthoring,actionRouter,scope,refresh,detail,chatId}));
  section.append(renderOwnerImpactPreview(d,{state,source,loreAuthoring,actionRouter,scope,refresh,detail}));
  section.append(renderOwnerTreeBuilder(d,{state,book,loreAuthoring,actionRouter,scope,refresh,detail}));
  section.append(renderOwnerMergePreview(d,{state,book,books,loreAuthoring,actionRouter,scope,refresh,detail}));
  section.append(renderReviewLifecycle(d,{state,book,loreStudy,loreAuthoring,actionRouter,scope,refresh,detail,chatId}));

  if(state.status)section.append(element(d,'p',{className:'a52-wave13-form-status',attrs:{role:'status','aria-live':'polite'},text:state.status}));
  host.append(section);
}

function workspaceHeader(d,caps){
  const root=element(d,'div',{className:'a52-lore-review-workspace__header'}),head=element(d,'div',{className:'a52-wave13-section-head'});
  head.append(element(d,'h2',{text:'Lore authoring review'}),makeBadge(d,'PREVIEW · NOT COMMITTED','historical'),
    makeBadge(d,caps.reviewedMutation?'OWNER MUTATIONS CONNECTED':'MUTATION CONTRACT PARTIAL',caps.reviewedMutation?'ready':'warning'));
  root.append(head,element(d,'p',{className:'a52-muted',text:'Drafts remain local until Worker 4 creates an owner proposal. Approval is still not a commit; canonical changes occur only through Worker 4 reviewed mutation commit/Settlement.'}));
  return root;
}

function renderSourceBrowser(d,{state,book,books,sources,selectedSnapshot,scope,refresh,detail}){
  const root=element(d,'section',{className:'a52-card a52-lore-browser'});
  root.append(sectionHead(d,'1. Source identity · selected Lorebook · exact entries · human tree','AUTHORED SOURCE','observed'));
  const verification=verifySelectedLorebook({selectedSnapshot,ownerBook:book});
  root.append(message(d,verification.verified?'Selected Lorebook verified':'Lorebook verification incomplete',verification.reason,verification.verified?'ready':verification.state==='LOREBOOK_MISMATCH'||verification.state==='SOURCE_SET_MISMATCH'?'warning':'historical'));
  root.append(createKeyValue(d,[
    {key:'SillyTavern Lorebook',value:selectedSnapshot?.title??selectedSnapshot?.id??'Not loaded'},
    {key:'Owner Lorebook',value:book.title??book.lorebookId},{key:'Lorebook ID',value:book.lorebookId},
    {key:'Exact authored entries',value:selectedSnapshot?.entries?.length??'Not loaded'},{key:'Owner source identities',value:sources.length},
    {key:'Matched source UIDs',value:verification.matchedEntries??0},{key:'Discovery receipt persisted',value:book.discoveryIdentityPersisted?'Yes':'No'},
  ]));
  const controls=element(d,'div',{className:'a52-lore-browser__controls'});
  const bookSelect=field(d,'select','Lorebook to review');for(const row of books)bookSelect.append(option(d,row.lorebookId,row.title??row.lorebookId));bookSelect.value=book.lorebookId;
  const search=field(d,'input','Filter exact Lore entries',{type:'search',placeholder:'Filter title, UID, path, key, or text'});search.value=state.entryQuery??'';
  listen(scope,bookSelect,'change',()=>{state.bookId=bookSelect.value;state.sourceId=null;state.secondSourceId=null;state.entryPage=0;state.proposalSourceId=null;refresh?.();});
  listen(scope,search,'input',()=>{state.entryQuery=String(search.value??'');state.entryPage=0;refresh?.();});
  controls.append(labelWrap(d,'Lorebook',bookSelect),labelWrap(d,'Filter entries',search));root.append(controls);

  const page=buildExactLoreEntries({selectedSnapshot:selectedSnapshot?.id===book.lorebookId?selectedSnapshot:null,ownerBook:book,query:state.entryQuery,page:state.entryPage,pageSize:PAGE_SIZE});
  const tree=buildHumanLoreTree(selectedSnapshot?.id===book.lorebookId?(selectedSnapshot.entries??[]):[],{maxNodes:200});
  const split=element(d,'div',{className:'a52-lore-browser__split'}),treePanel=element(d,'section',{className:'a52-lore-browser__tree'}),entryPanel=element(d,'section',{className:'a52-lore-browser__entries'});
  treePanel.append(element(d,'strong',{text:'Human tree'}),element(d,'p',{className:'a52-muted',text:'Author-facing organization only; tree placement is not semantic truth.'}));
  if(tree.rows.length){const list=element(d,'div',{className:'a52-lore-tree-list',attrs:{role:'tree'}});for(const row of tree.rows){const node=element(d,'div',{className:'a52-lore-tree-row',attrs:{role:'treeitem','aria-level':String(row.depth+1)},dataset:{depth:String(row.depth)}});node.append(element(d,'span',{text:'›'.repeat(Math.min(row.depth,5))+' '+row.label}),makeBadge(d,String(row.entryCount),'observed'));list.append(node);}treePanel.append(list);}
  else treePanel.append(element(d,'p',{className:'a52-muted',text:'Load the matching selected SillyTavern Lorebook to browse its authored tree.'}));
  const pager=element(d,'div',{className:'a52-wave13-section-head'});pager.append(element(d,'strong',{text:'Exact authored entries · '+page.total}));
  const pagerActions=element(d,'div',{className:'a52-wave13-resource-actions'});
  pagerActions.append(createButton(d,{label:'Previous',scope,size:'sm',variant:'quiet',disabled:page.page<=0,onPress:()=>{state.entryPage=Math.max(0,page.page-1);refresh?.();}}),createButton(d,{label:'Next',scope,size:'sm',variant:'quiet',disabled:page.page>=page.pages-1,onPress:()=>{state.entryPage=Math.min(page.pages-1,page.page+1);refresh?.();}}));pager.append(pagerActions);
  entryPanel.append(pager,element(d,'p',{className:'a52-muted',text:'Page '+String(page.page+1)+' / '+String(page.pages)+'. Review content is bounded and never exported as telemetry.'}));
  const entries=element(d,'div',{className:'a52-lore-entry-table'});
  for(const row of page.rows){const button=element(d,'button',{className:'a52-lore-entry-row',attrs:{type:'button','aria-label':'Select authored Lore entry '+row.title},dataset:{selected:String(row.sourceId===state.sourceId)}});button.append(element(d,'strong',{text:row.title}),element(d,'span',{text:row.treePath.join(' / ')||'Unplaced'}),element(d,'code',{text:detail===ProductDetailLevel.ADVANCED?(row.sourceRevisionId??row.uid):row.uid}));listen(scope,button,'click',()=>{if(row.sourceId){state.sourceId=row.sourceId;state.proposalSourceId=null;refresh?.();}});entries.append(button);}
  entryPanel.append(entries);split.append(treePanel,entryPanel);root.append(split);return root;
}

function renderProposalComposer(d,{state,book,sources,source,exact,caps,chatId,actionRouter,scope,refresh}){
  const root=element(d,'section',{className:'a52-card a52-lore-proposal-composer'});
  root.append(sectionHead(d,'2. Evidence-led local drafts','LOCAL PREVIEW · NOT COMMITTED','historical'),
    element(d,'p',{className:'a52-muted',text:'All seven operations can be drafted here. Creating an owner proposal copies only the explicit operation request into Worker 4 review; it does not write authored canon.'}));

  const grid=element(d,'div',{className:'a52-lore-proposal-form'});
  const kind=field(d,'select','Proposal operation');for(const value of ALL_KINDS)kind.append(option(d,value,human(value)));kind.value=state.proposalKind;
  const sourceSelect=field(d,'select','Primary source');for(const row of sources)sourceSelect.append(option(d,row.sourceId,row.metadata?.title??row.uid??row.sourceId));sourceSelect.value=source?.sourceId??'';
  const second=field(d,'select','Secondary source');second.append(option(d,'','None'));for(const row of sources.filter(x=>x.sourceId!==source?.sourceId))second.append(option(d,row.sourceId,row.metadata?.title??row.uid??row.sourceId));second.value=state.secondSourceId??'';
  const targetUid=field(d,'input','Target or output UID',{type:'text',placeholder:'new-entry-uid'});targetUid.value=state.proposalTargetUid??'';
  const title=field(d,'input','Proposed title',{type:'text',placeholder:'Title'});title.value=state.proposalTitle??'';
  const path=field(d,'input','Target human tree path',{type:'text',placeholder:'World / Region / Topic'});path.value=state.proposalTreePath??'';
  const reason=field(d,'input','Proposal reason',{type:'text',placeholder:'Why this change is being proposed'});reason.value=state.proposalReason??'';
  const content=field(d,'textarea','Proposed authored content',{rows:'6',placeholder:'Exact proposed authored text. Local preview only.'});content.value=state.proposalContent??'';

  listen(scope,kind,'change',()=>{state.proposalKind=kind.value;syncProposalFields(state,source,exact,true);refresh?.();});
  listen(scope,sourceSelect,'change',()=>{state.sourceId=sourceSelect.value;state.proposalSourceId=null;refresh?.();});
  listen(scope,second,'change',()=>{state.secondSourceId=second.value||null;});
  listen(scope,targetUid,'input',()=>state.proposalTargetUid=String(targetUid.value??''));
  listen(scope,title,'input',()=>state.proposalTitle=String(title.value??''));listen(scope,path,'input',()=>state.proposalTreePath=String(path.value??''));listen(scope,reason,'input',()=>state.proposalReason=String(reason.value??''));listen(scope,content,'input',()=>state.proposalContent=String(content.value??''));
  grid.append(labelWrap(d,'Operation',kind),labelWrap(d,'Primary source',sourceSelect),labelWrap(d,'Secondary source (merge)',second),labelWrap(d,'Target / output UID',targetUid),labelWrap(d,'Title',title),labelWrap(d,'Target tree path',path),labelWrap(d,'Reason',reason),labelWrap(d,'Exact proposed content',content));

  if(state.proposalKind==='SPLIT_ENTRY'){
    const uid=field(d,'input','Second split output UID',{type:'text'});uid.value=state.splitSecondUid??'';
    const splitTitle=field(d,'input','Second split output title',{type:'text'});splitTitle.value=state.splitSecondTitle??'';
    const splitPath=field(d,'input','Second split output tree path',{type:'text'});splitPath.value=state.splitSecondTreePath??'';
    const splitContent=field(d,'textarea','Second split output exact content',{rows:'5'});splitContent.value=state.splitSecondContent??'';
    listen(scope,uid,'input',()=>state.splitSecondUid=String(uid.value??''));listen(scope,splitTitle,'input',()=>state.splitSecondTitle=String(splitTitle.value??''));listen(scope,splitPath,'input',()=>state.splitSecondTreePath=String(splitPath.value??''));listen(scope,splitContent,'input',()=>state.splitSecondContent=String(splitContent.value??''));
    grid.append(labelWrap(d,'Split output 2 UID',uid),labelWrap(d,'Split output 2 title',splitTitle),labelWrap(d,'Split output 2 tree path',splitPath),labelWrap(d,'Split output 2 exact content',splitContent));
  }

  grid.append(createButton(d,{label:'Queue local draft',scope,onPress:()=>{
    try{
      const current=sources.find(row=>row.sourceId===state.sourceId)??source,secondary=sources.find(row=>row.sourceId===state.secondSourceId)??null,entry=exact;
      const targetPath=parsePath(state.proposalTreePath),targetUidValue=String(state.proposalTargetUid??'').trim();
      const fence=[current,secondary].filter(Boolean).map(row=>({sourceId:row.sourceId,sourceRevisionId:row.sourceRevisionId,contentHash:row.contentHash}));
      const outputs=state.proposalKind==='SPLIT_ENTRY'?[
        {lorebookId:book.lorebookId,uid:targetUidValue,title:state.proposalTitle,content:state.proposalContent,treePath:targetPath,metadata:{title:state.proposalTitle,treePath:targetPath}},
        {lorebookId:book.lorebookId,uid:String(state.splitSecondUid??'').trim(),title:state.splitSecondTitle,content:state.splitSecondContent,treePath:parsePath(state.splitSecondTreePath),metadata:{title:state.splitSecondTitle,treePath:parsePath(state.splitSecondTreePath)}},
      ]:[];
      const proposal=createLoreReviewProposal({
        proposalKind:state.proposalKind,lorebookId:book.lorebookId,sourceId:current?.sourceId,baseSourceRevisionId:current?.sourceRevisionId,uid:current?.uid,
        targetUid:targetUidValue,targetSourceIds:[secondary?.sourceId].filter(Boolean),title:state.proposalTitle,content:state.proposalContent,targetTreePath:targetPath,reason:state.proposalReason,
        outputs,sourceRevisionFence:fence,sourceMetadata:current?.metadata??{},targetMetadata:{...(current?.metadata??{}),title:state.proposalTitle||current?.metadata?.title,treePath:targetPath},
        evidenceSourceIds:[current?.sourceId,secondary?.sourceId].filter(Boolean),provenanceRefs:[...(current?.metadata?.provenanceRefs??[]),...(secondary?.metadata?.provenanceRefs??[])],scope:chatId,
        temporalState:current?.metadata?.temporalState,contradictionState:current?.metadata?.contradictionState,
        before:entry?{...entry,sourceId:current?.sourceId,sourceRevisionId:current?.sourceRevisionId}:null,
        after:state.proposalKind==='DELETE_ENTRY'?null:{title:state.proposalTitle||entry?.comment||entry?.title,uid:targetUidValue||current?.uid,sourceId:current?.sourceId,sourceRevisionId:current?.sourceRevisionId,content:state.proposalContent,treePath:targetPath},
      });
      // Validate the exact #261 request shape before accepting the local draft as owner-submittable.
      toOwnerMutationRequest(proposal,{chatId});
      state.queuedProposals=[...state.queuedProposals,proposal].slice(-80);state.status='Queued '+human(proposal.proposalKind)+' locally. Worker 4 has not received it yet.';refresh?.();
    }catch(error){state.status='Proposal draft failed: '+String(error?.message??error);refresh?.();}
  }}));
  root.append(grid);

  if(state.queuedProposals.length){
    const queueList=element(d,'div',{className:'a52-lore-proposal-queue'});
    for(const proposal of state.queuedProposals.slice(-40)){
      const pathState=proposalOwnerPath(proposal,caps),ownerId=state.ownerProposalByLocal?.[proposal.proposalId]??null,card=element(d,'article',{className:'a52-card a52-lore-proposal-card'});
      card.append(sectionHead(d,human(proposal.proposalKind),ownerId?'OWNER PROPOSAL CREATED · NOT COMMITTED':'LOCAL PREVIEW · NOT COMMITTED',ownerId?'observed':'historical','strong'),
        createKeyValue(d,[
          {key:'Source revision',value:proposal.baseSourceRevisionId??'New source'},{key:'Owner path',value:human(pathState)},{key:'Scope',value:proposal.scope??'Exact chat unavailable'},
          {key:'Target UID',value:proposal.targetUid??'N/A'},{key:'Target tree',value:proposal.targetTreePath?.join(' / ')||'Unchanged'},{key:'Provenance refs',value:proposal.provenanceRefs?.length??0},
          {key:'Owner proposal',value:ownerId??'Not created'},
        ]));
      const compare=element(d,'div',{className:'a52-lore-before-after'});compare.append(previewBox(d,'Before',proposal.before),previewBox(d,'After',proposal.after));card.append(compare);
      if(proposal.outputs?.length)card.append(element(d,'p',{className:'a52-muted',text:'Exact split outputs: '+proposal.outputs.map(row=>row.uid).join(', ')}));
      if(pathState===LoreReviewOwnerPath.OWNER_CONTRACT_MISSING)card.append(message(d,'Owner mutation action unavailable','This draft remains local. Worker 3 will not substitute a Tree/Merge lifecycle action or write Lore directly.','warning'));
      if(!ownerId&&pathState===LoreReviewOwnerPath.REVIEWED_MUTATION){
        card.append(createButton(d,{label:'Create owner proposal',scope,size:'sm',disabled:!chatId||!caps.mutationCreate,onPress:async()=>{
          let payload;try{payload=toOwnerMutationRequest(proposal,{chatId});}catch(error){state.status=String(error?.message??error);refresh?.();return;}
          const route=await actionRouter.route({type:'wave13.loreAuthoring.createMutationProposal',payload}),value=routeValue(route);
          if(value?.proposalId){state.ownerProposalByLocal={...(state.ownerProposalByLocal??{}),[proposal.proposalId]:value.proposalId};}
          state.status=routeMessage(route,'Worker 4 created a review-ready owner proposal. No authored source has changed.');refresh?.();
        }}));
      }
      queueList.append(card);
    }
    const queueActions=element(d,'div',{className:'a52-wave13-resource-actions'});
    queueActions.append(createButton(d,{label:'Clear local drafts',scope,size:'sm',variant:'quiet',onPress:()=>{state.queuedProposals=[];state.ownerProposalByLocal={};state.status='Cleared local UI drafts. Existing Worker 4 owner proposals were not deleted or mutated.';refresh?.();}}));
    root.append(queueList,queueActions);
  }
  return root;
}

function renderOwnerMutationQueue(d,{state,loreStudy,loreAuthoring,actionRouter,scope,refresh,detail,chatId}){
  const caps=loreAuthoring.capabilities(),root=element(d,'section',{className:'a52-card a52-lore-owner-mutations'});
  root.append(sectionHead(d,'3. Worker 4 reviewed mutation queue',caps.reviewedMutation?'OWNER REVIEW / SETTLEMENT':'OWNER CONTRACT UNAVAILABLE',caps.reviewedMutation?'observed':'warning'),
    element(d,'p',{className:'a52-muted',text:'This is the authoritative review state for local mutation proposals. REVIEW_READY and APPROVED are still not authored canon. Only COMMITTED has source-mutation authority.'}));
  if(!caps.mutationQueue){root.append(message(d,'Mutation queue read unavailable','Worker 4 did not publish mutationQueue(). Local drafts remain non-authoritative.','warning'));return root;}
  if(!chatId){root.append(message(d,'Exact chat scope unavailable','The UI will not enumerate or act on owner mutations without the selected story chat identity.','warning'));return root;}
  const queue=valueOf(loreAuthoring.mutationQueue({chatId,limit:OWNER_QUEUE_LIMIT}));
  if(!queue){root.append(message(d,'Mutation queue unavailable','Worker 4 returned no readable mutation queue. No state is inferred.','warning'));return root;}
  root.append(createKeyValue(d,[{key:'Visible owner proposals',value:queue.itemCount??queue.items?.length??0},{key:'Queue bound',value:queue.bounds?.limit??OWNER_QUEUE_LIMIT},{key:'Raw reconstruction exposed',value:queue.rawReconstructionIncluded?'Unexpectedly yes':'No'}]));
  if(!(queue.items??[]).length){root.append(message(d,'No owner proposals for this chat','Create one from a local draft above.','historical'));return root;}

  const list=element(d,'div',{className:'a52-lore-review-cards'});
  for(const queued of (queue.items??[]).slice(0,OWNER_QUEUE_LIMIT)){
    const owner=valueOf(loreAuthoring.mutationProposal({proposalId:queued.proposalId}))??queued;
    const audit=caps.mutationAudit?valueOf(loreAuthoring.mutationAudit({proposalId:owner.proposalId})):null;
    const local=findLocalForOwner(state,owner.proposalId),fence=local?compareMutationFences(local,owner):null;
    const card=element(d,'article',{className:'a52-card a52-lore-review-card'});
    card.append(sectionHead(d,human(owner.operation??'Mutation'),mutationStateLabel(owner.state),mutationStateStatus(owner.state),'strong'));
    card.append(createKeyValue(d,[
      {key:'Proposal ID',value:detail===ProductDetailLevel.ADVANCED?owner.proposalId:'Owner proposal'},
      {key:'State',value:human(owner.state??'UNKNOWN')},{key:'Scope',value:owner.scope?.scopeMode==='GLOBAL_OPERATOR'?'GLOBAL_OPERATOR':owner.scope?.chatId??'NO_EVIDENCE'},
      {key:'Source fence',value:formatFence(owner.sourceRevisionFence)},{key:'Target expectations',value:formatTargets(owner.targetExpectations)},
      {key:'Local fence comparison',value:fence?fence.matches?'MATCH':'CHANGED / MISSING':'No local draft mapping'},
      {key:'Affected tree paths',value:(owner.affectedTreePaths??[]).map(path=>path.join?.(' / ')??String(path)).slice(0,8).join(' · ')||'None published'},
      {key:'Semantic change rows',value:owner.impactSummary?.semanticChangeRows??0},{key:'Required rebuild actions',value:owner.impactSummary?.requiredActions??0},
      {key:'Audit events',value:audit?.eventCountTotal??audit?.events?.length??'Unavailable'},
    ]));
    if(fence&&!fence.matches)card.append(message(d,'Source revision changed since local draft','The owner proposal is authoritative for its own fence. Review the owner preview before any decision; the UI will not silently rewrite the proposal.','warning'));
    if(owner.lastError)card.append(message(d,owner.state==='STALE'?'Commit/review revalidation stale':'Owner mutation failure',(owner.lastError.code??'OWNER_ERROR')+' · '+(owner.lastError.message??''),'warning'));

    const compare=element(d,'div',{className:'a52-lore-before-after'});
    compare.append(ownerPreviewList(d,'Before',owner.preview?.before),ownerPreviewList(d,'After',owner.preview?.after));card.append(compare);
    card.append(renderMutationEvidence(d,owner));
    card.append(renderMutationImpact(d,owner));
    if(audit)card.append(renderMutationAudit(d,audit));
    if(owner.recovery)card.append(renderRecovery(d,owner.recovery));

    const buttons=element(d,'div',{className:'a52-wave13-resource-actions'}),scopePayload=ownerScopePayload(owner);
    if(owner.state==='REVIEW_READY'){
      buttons.append(
        createButton(d,{label:'Approve owner proposal',scope,size:'sm',variant:'primary',disabled:!caps.mutationApprove,onPress:async()=>{
          const decisionId='ui:mutation:approve:'+owner.proposalId;
          const route=await actionRouter.route({type:'wave13.loreAuthoring.approveMutationProposal',payload:{proposalId:owner.proposalId,operatorDecisionId:decisionId,...scopePayload}});
          const value=routeValue(route);state.status=value?.state==='STALE'?'Worker 4 marked the proposal STALE during approval revalidation. No commit occurred.':routeMessage(route,'Worker 4 recorded APPROVED. Authored canon is still unchanged.');refresh?.();
        }}),
        createButton(d,{label:'Reject owner proposal',scope,size:'sm',variant:'quiet',disabled:!caps.mutationReject,onPress:async()=>{
          const decisionId='ui:mutation:reject:'+owner.proposalId;
          const route=await actionRouter.route({type:'wave13.loreAuthoring.rejectMutationProposal',payload:{proposalId:owner.proposalId,operatorDecisionId:decisionId,note:'Rejected from Worker 3 Lore review UI',...scopePayload}});
          state.status=routeMessage(route,'Worker 4 recorded REJECTED. No authored mutation occurred.');refresh?.();
        }})
      );
    }
    if(owner.state==='APPROVED'){
      buttons.append(createButton(d,{label:'Commit approved mutation',scope,size:'sm',variant:'primary',disabled:!caps.mutationCommit,onPress:async()=>{
        const decisionId=owner.approval?.operatorDecisionId;
        if(!decisionId){state.status='Owner approval identity is missing; commit is disabled by evidence.';refresh?.();return;}
        const route=await actionRouter.route({type:'wave13.loreAuthoring.commitMutationProposal',payload:{proposalId:owner.proposalId,operatorDecisionId:decisionId,...scopePayload}});
        const value=routeValue(route);
        if(value?.state==='COMMITTED')state.status='Worker 4 committed the reviewed mutation through its owner Settlement path.';
        else if(value?.state==='STALE')state.status='Commit revalidation returned STALE. Authored canon was not changed by this proposal.';
        else if(value?.state==='FAILED')state.status='Worker 4 commit failed. Review the recovery receipt before taking another action.';
        else state.status=routeMessage(route,'Worker 4 processed the commit request.');
        refresh?.();
      }}));
    }
    if(owner.state==='COMMITTED'){
      buttons.append(createButton(d,{label:'Restore committed mutation',scope,size:'sm',variant:'quiet',disabled:!caps.mutationRestore,onPress:async()=>{
        const sequence=owner.commit?.committedSequence??'commit';
        const decisionId='ui:mutation:restore:'+owner.proposalId+':'+String(sequence);
        const route=await actionRouter.route({type:'wave13.loreAuthoring.restoreMutationProposal',payload:{proposalId:owner.proposalId,restorationId:'ui:restore:'+owner.proposalId,operatorDecisionId:decisionId,...scopePayload}});
        state.status=routeMessage(route,'Worker 4 processed an explicit append-only restoration decision.');refresh?.();
      }}));
    }
    if(buttons.children?.length)card.append(buttons);

    if(['COMMITTED','RESTORED'].includes(String(owner.state))){
      const restudy=mutationRestudyProgress(owner,loreStudy?.read?.()),den=Math.max(1,restudy.obligationIds.length),pct=Math.round((restudy.ready+restudy.removed)/den*100);
      card.append(element(d,'h4',{text:'Actual post-mutation restudy'}),createKeyValue(d,[
        {key:'Study obligations',value:restudy.obligationIds.length},{key:'Matched receipts',value:restudy.matched},{key:'Missing receipts',value:restudy.missing},
        {key:'Accepted / due',value:restudy.accepted},{key:'Studying',value:restudy.studying},{key:'Ready',value:restudy.ready},{key:'Removed',value:restudy.removed},{key:'Failed',value:restudy.failed},
      ]),createProgressBar(d,{value:restudy.obligationIds.length?pct:0,label:'Mutation restudy readiness'}));
      if(restudy.state==='NO_EVIDENCE'||restudy.missing)card.append(message(d,'Restudy receipt incomplete','Worker 4 published study obligation IDs, but the Lore Study surface has not yet published every matching state.','warning'));
      card.append(createButton(d,{label:'Run pending restudy',scope,size:'sm',variant:'quiet',disabled:!loreStudy?.capabilities?.().run,onPress:async()=>{const route=await actionRouter.route({type:'wave13.lore.run',payload:{scope:'DUE'}});state.status=routeMessage(route,'Requested due Lore study work.');refresh?.();}}));
    }
    list.append(card);
  }
  root.append(list);return root;
}

function renderMutationEvidence(d,owner){
  const evidence=owner.evidence??{},root=element(d,'section',{className:'a52-lore-mutation-evidence'});
  root.append(element(d,'h4',{text:'Evidence / provenance'}),createKeyValue(d,[
    {key:'Source revision refs',value:(evidence.sourceRevisionRefs??[]).slice(0,16).join(', ')||'NO_EVIDENCE'},
    {key:'Learned artifact refs',value:evidence.artifactRefs?.length??0},{key:'Claim refs',value:evidence.claimRefs?.length??0},{key:'Explicit refs',value:evidence.explicitEvidenceRefs?.length??0},
  ]));return root;
}

function renderMutationImpact(d,owner){
  const rows=owner.semanticImpact??[],required=[];
  for(const plan of rows)for(const row of (plan?.impact?.required??[]))required.push(row?.target??row);
  const root=element(d,'section',{className:'a52-lore-mutation-impact'});
  root.append(element(d,'h4',{text:'Semantic impact / rebuild work'}),createKeyValue(d,[
    {key:'Source plans',value:owner.impactSummary?.sourcePlans??rows.length},{key:'Direct dependents',value:owner.impactSummary?.directDependents??0},
    {key:'Transitive dependents',value:owner.impactSummary?.transitiveDependents??0},{key:'Required work',value:[...new Set(required.map(String))].slice(0,20).join(', ')||'None published'},
    {key:'Unrelated sources invalidated',value:owner.impactSummary?.unrelatedSourcesInvalidated?'Yes':'No'},
  ]));return root;
}

function renderMutationAudit(d,audit){
  const events=(audit.events??[]).slice(-6),root=element(d,'section',{className:'a52-lore-mutation-audit'});
  root.append(element(d,'h4',{text:'Owner audit'}),createKeyValue(d,[
    {key:'Audit events retained',value:audit.eventCountTotal??events.length},{key:'Raw reconstruction',value:audit.rawReconstructionIncluded?'Unexpectedly exposed':'Excluded'},
    {key:'Reconstruction sources',value:audit.reconstruction?.sources?.length??0},{key:'Append-only restoration',value:audit.reconstruction?.appendOnlyRestoration?'Yes':'No / not yet'},
  ]));
  if(events.length){const list=element(d,'div',{className:'a52-wave13-diagnostics__activity'});for(const event of events)list.append(element(d,'div',{className:'a52-wave13-flow-row'},makeBadge(d,human(event.kind??'AUDIT'),'observed'),element(d,'span',{text:event.failure?.code??event.error?.code??event.operatorDecisionId??'Owner audit event'})));root.append(list);}
  return root;
}

function renderRecovery(d,recovery){
  return message(d,'Multi-write recovery',
    'State '+String(recovery.status??'UNKNOWN')+' · partial revisions '+String(recovery.partialRevisionEvents?.length??0)+' · compensation revisions '+String(recovery.compensationRevisionEvents?.length??0)+(recovery.error?' · '+String(recovery.error.code??recovery.error.message??'recovery error'):''),
    recovery.status==='COMPENSATED'?'observed':'warning');
}

function renderOwnerImpactPreview(d,{state,source,loreAuthoring,actionRouter,scope,refresh,detail}){
  const root=element(d,'section',{className:'a52-card a52-lore-owner-impact'}),caps=loreAuthoring.capabilities();
  root.append(sectionHead(d,'4. Edit-impact preview · semantic impact','OWNER READ · NOT COMMITTED','historical'),
    element(d,'p',{className:'a52-muted',text:'This uses Worker 4 semanticImpactPreview. It is read-only and cannot mutate authored canon.'}));
  root.append(createButton(d,{label:'Preview current edit impact',scope,size:'sm',disabled:!caps.semanticImpactPreview||!source||!String(state.proposalContent??'').trim(),onPress:()=>{
    const result=loreAuthoring.semanticImpactPreview({sourceId:source.sourceId,content:String(state.proposalContent??'')});
    state.status=result?.ok?'Worker 4 semantic impact preview refreshed. No source revision was applied.':'Worker 4 semantic impact read failed: '+String(result?.error?.message??result?.error?.code??'unknown error');refresh?.();
  }}));
  const preview=valueOf(loreAuthoring.snapshot?.().last?.semanticImpact);
  if(preview){
    const impact=preview.impact??preview.semanticChange?.invalidationPlan??{},classification=preview.classification??{};
    root.append(createKeyValue(d,[
      {key:'Source revision',value:preview.previousSource?.sourceRevisionId??preview.baseSourceRevisionId??source?.sourceRevisionId??'Not published'},
      {key:'Meaning changed',value:classification.meaningChanged==null?'Preview model':classification.meaningChanged?'Yes':'No'},
      {key:'Wording only',value:classification.wordingOnly?'Yes':'No'},{key:'Structure changed',value:classification.structureChanged?'Yes':'No'},
      {key:'Dependency / rebuild area',value:(impact.required??impact.targets??[]).map(row=>row?.target??row).slice(0,20).join(', ')||'None published'},
    ]));
    if(detail===ProductDetailLevel.ADVANCED)root.append(createKeyValue(d,[{key:'Direct / transitive',value:[impact.direct?.length??0,impact.transitive?.length??0].join(' / ')}]));
  }
  return root;
}

function renderOwnerTreeBuilder(d,{state,book,loreAuthoring,actionRouter,scope,refresh,detail}){
  const root=element(d,'section',{className:'a52-card a52-lore-owner-tree'});
  root.append(sectionHead(d,'5. Tree Builder proposal','OWNER PLAN · NOT COMMITTED','historical'),
    element(d,'p',{className:'a52-muted',text:'This is Worker 4’s generated-plan lifecycle, separate from generic TREE_ASSIGN mutation proposals. Tree previews remain author-facing navigation, not semantic truth.'}));
  const caps=loreAuthoring.capabilities(),actions=element(d,'div',{className:'a52-wave13-resource-actions'});
  actions.append(createButton(d,{label:'Refresh Tree proposal',scope,disabled:!caps.tree,onPress:async()=>{const route=await actionRouter.route({type:'wave13.loreAuthoring.proposeTree',payload:{lorebookIds:[book.lorebookId]}});state.status=routeMessage(route,'Worker 4 Tree proposal refreshed. No source was committed.');refresh?.();}}));
  if(caps.lifecycle)actions.append(createButton(d,{label:'Start reviewed Tree build',scope,disabled:Boolean(state.sessionId),onPress:async()=>{const route=await actionRouter.route({type:'wave13.loreAuthoring.startTreeBuild',payload:{lorebookIds:[book.lorebookId]}});const value=routeValue(route);if(value?.sessionId)state.sessionId=value.sessionId;state.status=routeMessage(route,'Worker 4 generated Tree review session started.');refresh?.();}}));
  root.append(actions);
  const treePlan=valueOf(loreAuthoring.snapshot?.().last?.tree);
  if(treePlan){root.append(createKeyValue(d,[{key:'Proposal count',value:treePlan.proposals?.length??0},{key:'Review items',value:treePlan.reviewItems?.length??0},{key:'Revision fence',value:(treePlan.sourceRevisionFence??[]).length},{key:'Mutation authority',value:treePlan.mutationAuthority?'Unexpectedly granted':'Not granted'}]));const list=element(d,'div',{className:'a52-lore-tree-proposals'});for(const row of (treePlan.proposals??[]).slice(0,40)){const card=element(d,'article',{className:'a52-wave13-flow-row'});card.append(makeBadge(d,human(row.state??'NEEDS_REVIEW'),'historical'),element(d,'strong',{text:human(row.action)}),element(d,'span',{text:row.rationale??'Owner proposal'}));list.append(card);}root.append(list);if(detail===ProductDetailLevel.ADVANCED)root.append(createKeyValue(d,[{key:'Plan ID',value:treePlan.planId??'—'},{key:'Fence refs',value:(treePlan.sourceRevisionFence??[]).slice(0,20).join(', ')||'none'}]));}
  return root;
}

function renderOwnerMergePreview(d,{state,book,books,loreAuthoring,actionRouter,scope,refresh,detail}){
  const root=element(d,'section',{className:'a52-card a52-lore-owner-merge'});
  root.append(sectionHead(d,'6. Merge / reconciliation preview','OWNER PREVIEW · NOT COMMITTED','historical'),
    element(d,'p',{className:'a52-muted',text:'This keeps the existing Worker 4 generated reconciliation workflow. It is separate from an operator-authored MERGE mutation proposal above.'}));
  const others=(books??[]).filter(row=>row.lorebookId!==book.lorebookId),select=field(d,'select','Merge comparison lorebook');
  select.append(option(d,'','Choose second Lorebook'));for(const row of others)select.append(option(d,row.lorebookId,row.title??row.lorebookId));select.value=state.mergeBookId??'';
  const button=createButton(d,{label:'Preview merge reconciliation',scope,disabled:!loreAuthoring.capabilities().merge||!state.mergeBookId,onPress:async()=>{const route=await actionRouter.route({type:'wave13.loreAuthoring.previewMerge',payload:{lorebookIds:[book.lorebookId,state.mergeBookId]}});state.status=routeMessage(route,'Worker 4 merge reconciliation preview refreshed. No source was committed.');refresh?.();}});
  listen(scope,select,'change',()=>{state.mergeBookId=select.value||null;button.disabled=!loreAuthoring.capabilities().merge||!state.mergeBookId;});
  root.append(labelWrap(d,'Compare with',select),button);
  const preview=valueOf(loreAuthoring.snapshot?.().last?.merge);
  if(preview){const cls=preview.classifications??{},validation=preview.validation??{};root.append(createKeyValue(d,[
    {key:'Unique semantic facts retained',value:validation.retainedEverySemanticFact?'Yes':'No'},{key:'Every current source mapped',value:validation.mappedEveryCurrentSource?'Yes':'No'},
    {key:'Contradictions kept separate',value:validation.preservedContradictionsSeparately?'Yes':'No'},{key:'Exact duplicates',value:cls.exactDuplicates?.length??0},
    {key:'Likely overlap',value:cls.likelyOverlap?.length??0},{key:'Complementary',value:cls.complementary?.length??0},{key:'Title/key collisions',value:cls.titleKeyCollisions?.length??0},{key:'Unresolved contradictions',value:cls.unresolvedContradictions?.length??0},
  ]));if(detail===ProductDetailLevel.ADVANCED)root.append(createKeyValue(d,[{key:'Preview ID',value:preview.previewId??'—'},{key:'Source revision fence',value:(preview.sourceRevisionFence??[]).slice(0,24).join(', ')||'none'}]));}
  if(!loreAuthoring.capabilities().lifecycle)root.append(message(d,'No destructive Apply action','This assembly exposes generated Tree/Merge previews only. Worker 3 intentionally offers no direct Apply path without Worker 4 review and Settlement authority.','historical'));
  return root;
}

function renderReviewLifecycle(d,{state,loreStudy,loreAuthoring,actionRouter,scope,refresh,detail,chatId}){
  const root=element(d,'section',{className:'a52-card a52-lore-review-lifecycle'});
  root.append(sectionHead(d,'7. Generated-plan Draft Review → Final Preview → Settlement',state.sessionId?'GENERATED REVIEW SESSION':'NO GENERATED SESSION',state.sessionId?'observed':'historical'),
    element(d,'p',{className:'a52-muted',text:'This lifecycle remains for Worker 4-generated Tree/Merge plans. Its previews do not represent generic mutation proposals and never look committed before owner Settlement succeeds.'}));
  if(!state.sessionId){root.append(message(d,'No generated-plan review session','Start Worker 4 Tree Builder above when a generated structural plan needs review. Generic mutation proposals use the owner queue in section 3.','historical'));return root;}

  const progress=valueOf(loreAuthoring.authoringProgress({sessionId:state.sessionId}));
  if(!progress){root.append(message(d,'Review session unavailable','Worker 4 did not return progress. No approval or apply control is enabled.','warning'));return root;}
  if(progress.settlement?.settlementId)state.settlementId=progress.settlement.settlementId;
  const stale=progress.stale?.reason??null;
  root.append(createKeyValue(d,[{key:'Session',value:state.sessionId},{key:'Type',value:progress.type??'—'},{key:'Stage',value:human(progress.stage??'UNKNOWN')},{key:'Build',value:String(progress.build?.cursor??0)+' / '+String(progress.build?.total??progress.totalActions??0)},{key:'Draft revision',value:progress.draftRevision??'—'},{key:'Revision/scope fence',value:stale?'STALE · '+stale:'Current'}]));
  if(stale)root.append(message(d,'Revision or scope conflict',String(stale)+'. The generated preview cannot be treated as approved or committed.','warning'));
  if(progress.lastError)root.append(message(d,'Owner review failure',progress.lastError.message??progress.lastError.code??'Worker 4 reported an authoring failure.','warning'));
  if(['BUILDING','CHECKPOINTED'].includes(String(progress.stage))&&!progress.settlement)root.append(createButton(d,{label:'Resume owner build checkpoint',scope,onPress:async()=>{const route=await actionRouter.route({type:'wave13.loreAuthoring.resumeBuild',payload:{sessionId:state.sessionId,maxActions:32}});state.status=routeMessage(route,'Owner build checkpoint advanced.');refresh?.();}}));

  const draft=valueOf(loreAuthoring.draftReview({sessionId:state.sessionId}));
  if(draft?.actions?.length){
    const pages=Math.max(1,Math.ceil(draft.actions.length/REVIEW_PAGE_SIZE));state.reviewPage=Math.max(0,Math.min(pages-1,state.reviewPage||0));
    const visible=draft.actions.slice(state.reviewPage*REVIEW_PAGE_SIZE,(state.reviewPage+1)*REVIEW_PAGE_SIZE),nav=element(d,'div',{className:'a52-wave13-section-head'});
    nav.append(element(d,'strong',{text:'Draft Review · '+draft.actions.length+' proposals · page '+String(state.reviewPage+1)+' / '+String(pages)}));
    const navActions=element(d,'div',{className:'a52-wave13-resource-actions'});navActions.append(createButton(d,{label:'Previous',scope,size:'sm',variant:'quiet',disabled:state.reviewPage===0,onPress:()=>{state.reviewPage--;refresh?.();}}),createButton(d,{label:'Next',scope,size:'sm',variant:'quiet',disabled:state.reviewPage>=pages-1,onPress:()=>{state.reviewPage++;refresh?.();}}));nav.append(navActions);root.append(nav);
    const batch=element(d,'div',{className:'a52-wave13-resource-actions'});
    for(const [label,decision] of [['Approve page','ACCEPT'],['Reject page','REJECT'],['Defer page','DEFER']])batch.append(createButton(d,{label,scope,size:'sm',variant:decision==='ACCEPT'?'primary':'quiet',disabled:!visible.some(row=>!row.decision),onPress:async()=>{for(const action of visible.filter(row=>!row.decision)){const route=await actionRouter.route({type:'wave13.loreAuthoring.recordDecision',payload:{sessionId:state.sessionId,actionId:action.id,decision,operatorDecisionId:'ui:'+state.sessionId+':'+action.id+':'+decision}});if(!route?.ok||route.result?.ok===false){state.status=routeMessage(route,'');refresh?.();return;}}state.status=human(decision)+' recorded for this generated-plan page. This is not a commit.';refresh?.();}}));root.append(batch);
    const cards=element(d,'div',{className:'a52-lore-review-cards'});
    for(const action of visible){const summary=summarizeLoreReviewAction(action),card=element(d,'article',{className:'a52-card a52-lore-review-card'});card.append(reviewCardHead(d,summary,action),createKeyValue(d,[{key:'Source revision refs',value:summary.sourceRevisionRefs.length?summary.sourceRevisionRefs.join(', '):'NO_EVIDENCE'},{key:'Provenance / evidence refs',value:summary.provenanceRefs.length},{key:'Scope',value:summary.scope??chatId??'Not published'},{key:'Affected tree nodes',value:summary.affectedTreeNodes.join(', ')||'None published'},{key:'Dependency / rebuild area',value:summary.dependencyArea.join(', ')||'Not published'}]));const compare=element(d,'div',{className:'a52-lore-before-after'});compare.append(previewBox(d,'Before',summary.before),previewBox(d,'After',summary.after));card.append(compare);if(!action.decision){const buttons=element(d,'div',{className:'a52-wave13-resource-actions'});for(const [label,decision] of [['Approve','ACCEPT'],['Reject','REJECT'],['Defer','DEFER']])buttons.append(createButton(d,{label,scope,size:'sm',variant:decision==='ACCEPT'?'primary':'quiet',onPress:async()=>{const route=await actionRouter.route({type:'wave13.loreAuthoring.recordDecision',payload:{sessionId:state.sessionId,actionId:action.id,decision,operatorDecisionId:'ui:'+state.sessionId+':'+action.id+':'+decision}});state.status=routeMessage(route,label+' recorded with Worker 4. No commit has occurred.');refresh?.();}}));card.append(buttons);}if(detail===ProductDetailLevel.ADVANCED&&summary.actionId)card.append(element(d,'code',{text:summary.actionId}));cards.append(card);}root.append(cards);
  }

  const allDecided=Boolean(draft?.actions?.length)&&draft.actions.every(action=>Boolean(action.decision));
  if(String(progress.stage)==='DRAFT_REVIEW'&&allDecided&&!stale)root.append(createButton(d,{label:'Compute revision-fenced Final Preview',scope,onPress:async()=>{const route=await actionRouter.route({type:'wave13.loreAuthoring.computeFinalPreview',payload:{sessionId:state.sessionId}});state.status=routeMessage(route,'Final Preview recomputed. Still not committed.');refresh?.();}}));
  const finalPreview=valueOf(loreAuthoring.finalPreview({sessionId:state.sessionId}));
  if(finalPreview){root.append(sectionHead(d,'Final Preview','PREVIEW · NOT COMMITTED','historical','h4'),createKeyValue(d,[{key:'Validation',value:finalPreview.validation?.ok?'PASS':'FAIL'},{key:'Operations',value:finalPreview.operations?.length??0},{key:'Semantic preflight',value:finalPreview.authoritativeSemanticPreflight?'PASS':'Not published / failed'},{key:'Explicit approval required',value:finalPreview.explicitApprovalRequired?'Yes':'No'},{key:'Final Preview ID',value:finalPreview.finalPreviewId??'—'}]));if(finalPreview.validation?.failures?.length)root.append(message(d,'Commit-time revalidation blocked',finalPreview.validation.failures.join(', '),'warning'));}
  if(String(progress.stage)==='FINAL_PREVIEW'&&finalPreview?.validation?.ok&&!stale)root.append(createButton(d,{label:'Approve current Final Preview',scope,onPress:async()=>{const route=await actionRouter.route({type:'wave13.loreAuthoring.approveFinalPreview',payload:{sessionId:state.sessionId,operatorApprovalId:'ui:final:'+state.sessionId+':'+String(progress.draftRevision??1)}});const value=routeValue(route);state.status=value?.readyForApproval===false?'Worker 4 rejected approval during revalidation: '+String(value?.stale?.reason??'owner revalidation failed'):routeMessage(route,'Worker 4 accepted the generated-plan approval. Canon is still unchanged until Settlement succeeds.');refresh?.();}}));
  if(loreAuthoring.capabilities().settlement&&(String(progress.stage)==='READY_TO_SETTLE'||progress.settlement?.state==='CHECKPOINTED'))root.append(createButton(d,{label:progress.settlement?'Resume approved Settlement':'Apply approved Settlement',scope,onPress:async()=>{const route=await actionRouter.route({type:'wave13.loreAuthoring.applySettlement',payload:{sessionId:state.sessionId,maxOperations:32}});const value=routeValue(route);if(value?.settlementId)state.settlementId=value.settlementId;state.status=routeMessage(route,'Worker 4 processed generated-plan Settlement operations.');refresh?.();}}));
  const settlementId=state.settlementId??progress.settlement?.settlementId??null,settlement=settlementId?valueOf(loreAuthoring.settlement({settlementId})):null;
  if(settlement){const committed=String(settlement.state)==='SETTLED';root.append(sectionHead(d,'Generated-plan owner Settlement receipt',committed?'COMMITTED BY OWNER':human(settlement.state??'PENDING'),committed?'ready':'warning','h4'),createKeyValue(d,[{key:'State',value:human(settlement.state??'UNKNOWN')},{key:'Applied',value:String(settlement.cursor??0)+' / '+String(settlement.operationCount??0)},{key:'Revision events',value:settlement.revisionEvents?.length??0},{key:'Invalidation receipts',value:settlement.invalidationReceipts?.length??0},{key:'Reconstructable',value:settlement.reconstructable?'Yes':'No'}]));if(settlement.lastError)root.append(message(d,'Settlement / commit failure',settlement.lastError.message??settlement.lastError.code??'Worker 4 rejected or failed the commit.','warning'));if(committed){if(loreAuthoring.capabilities().restoration)root.append(createButton(d,{label:'Restore settled revisions',scope,size:'sm',variant:'quiet',onPress:async()=>{const route=await actionRouter.route({type:'wave13.loreAuthoring.restoreSettlement',payload:{settlementId,restorationId:'ui:restore:'+settlementId,maxOperations:32}});state.status=routeMessage(route,'Worker 4 restoration processed the generated-plan Settlement.');refresh?.();}}));const restudy=loreRestudyProgress(loreStudy?.read?.()),pct=restudy.total?Math.round((restudy.ready+restudy.removed)/restudy.total*100):0;root.append(element(d,'h4',{text:'Post-commit restudy'}),createKeyValue(d,[{key:'Accepted / due',value:restudy.accepted},{key:'Studying',value:restudy.studying},{key:'Ready',value:restudy.ready},{key:'Failed',value:restudy.failed},{key:'Stale',value:restudy.stale}]),createProgressBar(d,{value:pct,label:'Post-commit Lore readiness'}));}}
  return root;
}

function ownerPreviewList(d,label,rows){
  const box=element(d,'section',{className:'a52-lore-preview-box'});box.append(element(d,'strong',{text:label}));
  if(!(rows??[]).length){box.append(element(d,'p',{className:'a52-muted',text:'None / not applicable'}));return box;}
  for(const row of rows.slice(0,8)){box.append(createKeyValue(d,[{key:'Source',value:row.sourceId??[row.lorebookId,row.uid].filter(Boolean).join(':')},{key:'Revision',value:row.sourceRevisionId??(row.state==='PROPOSED'?'Proposed':'—')},{key:'State',value:row.state??'—'},{key:'Tree path',value:row.treePath?.join(' / ')||'—'}]));if(row.contentIncluded&&row.content!=null)box.append(element(d,'pre',{className:'a52-lore-preview-text',text:String(row.content).slice(0,1200)}));}
  return box;
}
function sectionHead(d,title,badge,status='observed',tag='h3'){const head=element(d,'div',{className:'a52-wave13-section-head'});head.append(element(d,tag,{text:title}),makeBadge(d,badge,status));return head;}
function reviewCardHead(d,summary,action){const head=element(d,'div',{className:'a52-wave13-section-head'});head.append(element(d,'strong',{text:human(summary.action??'Authoring action')}),makeBadge(d,action.decision?human(action.decision):'DECISION REQUIRED',action.decision?'observed':'warning'),makeBadge(d,summary.materialized?'MATERIALIZED BY OWNER':'PREVIEW · NOT COMMITTED',summary.materialized?'ready':'historical'));return head;}
function previewBox(d,label,value){const box=element(d,'section',{className:'a52-lore-preview-box'});box.append(element(d,'strong',{text:label}));if(!value){box.append(element(d,'p',{className:'a52-muted',text:'None / not applicable'}));return box;}if(value.title||value.sourceRevisionId||value.treePath?.length)box.append(createKeyValue(d,[{key:'Title',value:value.title??'—'},{key:'Revision',value:value.sourceRevisionId??'—'},{key:'Tree path',value:value.treePath?.join(' / ')||'—'}]));const body=value.content??value.text??value.value;if(body)box.append(element(d,'pre',{className:'a52-lore-preview-text',text:String(body).slice(0,1200)}));return box;}
function mutationStateLabel(state){const x=String(state??'UNKNOWN');if(x==='COMMITTED')return'COMMITTED BY OWNER';if(x==='APPROVED')return'APPROVED · NOT COMMITTED';if(x==='REVIEW_READY'||x==='PROPOSED')return'PREVIEW · NOT COMMITTED';if(x==='REJECTED')return'REJECTED · NO COMMIT';if(x==='RESTORED')return'RESTORED BY OWNER';if(x==='STALE')return'STALE · NOT COMMITTED';if(x==='FAILED')return'FAILED · REVIEW RECOVERY';return human(x);}
function mutationStateStatus(state){const x=String(state??'');if(x==='COMMITTED'||x==='RESTORED')return'ready';if(x==='STALE'||x==='FAILED'||x==='REJECTED')return'warning';return'historical';}
function formatFence(rows){return(rows??[]).slice(0,8).map(row=>String(row.sourceId??'source')+' @ '+String(row.sourceRevisionId??'NO_EVIDENCE')).join(' · ')||'No source fence (new source)';}
function formatTargets(rows){return(rows??[]).slice(0,8).map(row=>String(row.sourceId??'target')+' @ '+String(row.expectedSourceRevisionId??'ABSENT')).join(' · ')||'None';}
function ownerScopePayload(owner){return owner?.scope?.scopeMode==='GLOBAL_OPERATOR'?{scopeMode:'GLOBAL_OPERATOR'}:{chatId:owner?.scope?.chatId};}
function findLocalForOwner(state,proposalId){const localId=Object.entries(state.ownerProposalByLocal??{}).find(([,ownerId])=>String(ownerId)===String(proposalId))?.[0];return localId?(state.queuedProposals??[]).find(row=>row.proposalId===localId)??null:null;}
function parsePath(value){return String(value??'').split(/[\\/>]+/).map(x=>x.trim()).filter(Boolean).slice(0,12);}
function syncProposalFields(state,source,exact,force=false){
  const token=String(source?.sourceId??'')+'|'+String(state.proposalKind??'');if(!force&&state.proposalSourceId===token)return;state.proposalSourceId=token;
  const uid=String(source?.uid??exact?.uid??'entry');state.proposalTitle=exact?.comment??exact?.title??source?.metadata?.title??'';state.proposalContent=state.proposalKind==='DELETE_ENTRY'||state.proposalKind==='PLACE_ENTRY'?'':String(exact?.content??'');
  state.proposalTreePath=(exact?.metadata?.treePath??exact?.treePath??source?.metadata?.treePath??[]).join?.(' / ')??'';state.proposalReason='';
  if(state.proposalKind==='CREATE_ENTRY')state.proposalTargetUid='new-entry';
  else if(state.proposalKind==='MERGE_ENTRIES')state.proposalTargetUid=uid+'-merged';
  else if(state.proposalKind==='MOVE_ENTRY')state.proposalTargetUid=uid+'-moved';
  else if(state.proposalKind==='SPLIT_ENTRY'){state.proposalTargetUid=uid+'-part-1';state.splitSecondUid=uid+'-part-2';state.splitSecondTitle=(state.proposalTitle||uid)+' Part 2';state.splitSecondContent='';state.splitSecondTreePath=state.proposalTreePath;}
  else state.proposalTargetUid=uid;
}
function ensureState(state){const defaults=createLoreReviewUiState();for(const [key,value] of Object.entries(defaults))if(state[key]===undefined)state[key]=Array.isArray(value)?[...value]:value&&typeof value==='object'?{...value}:value;return state;}
function valueOf(result){return result?.ok===true?result.value??null:null;}
function routeValue(route){return route?.ok===true&&route.result?.ok===true?route.result.value??null:null;}
function routeMessage(route,success){if(!route?.ok)return'UI routing failed: '+String(route?.error??'unknown error');if(route.result?.ok===false)return'Worker 4 action failed: '+String(route.result.error?.message??route.result.error?.code??'unknown error');return success;}
function listen(scope,node,type,handler){if(scope?.listen)scope.listen(node,type,handler);else node?.addEventListener?.(type,handler);}
function field(d,tag,label,attrs={}){return element(d,tag,{className:'a52-input',attrs:{'aria-label':label,...attrs}});}
function option(d,value,label){return element(d,'option',{text:label,attrs:{value}});}
function labelWrap(d,label,node){const root=element(d,'label',{className:'a52-wave13-field'});root.append(element(d,'span',{text:label}),node);return root;}
function message(d,title,body,status='historical'){const root=element(d,'section',{className:'a52-state-message',attrs:{role:status==='error'?'alert':'status'},dataset:{status}});root.append(element(d,'strong',{text:title}),element(d,'span',{text:String(body??'')}));return root;}
function human(value){return String(value??'').toLowerCase().replace(/(^|_)([a-z])/g,(_,space,letter)=>(space?' ':'')+letter.toUpperCase());}
