const PROPOSAL_KINDS=Object.freeze([
  'CREATE_ENTRY','UPDATE_ENTRY','DELETE_ENTRY','MERGE_ENTRIES','SPLIT_ENTRY','MOVE_ENTRY','PLACE_ENTRY',
]);

export const LoreReviewProposalKind=Object.freeze(Object.fromEntries(PROPOSAL_KINDS.map(value=>[value,value])));
export const LoreReviewDecision=Object.freeze({APPROVE:'APPROVE',REJECT:'REJECT',DEFER:'DEFER'});
export const LoreReviewOwnerPath=Object.freeze({
  REVIEWED_MUTATION:'REVIEWED_MUTATION',
  TREE_REVIEW:'TREE_REVIEW',
  MERGE_REVIEW:'MERGE_REVIEW',
  OWNER_CONTRACT_MISSING:'OWNER_CONTRACT_MISSING',
});
export const LoreMutationOwnerOperation=Object.freeze({
  CREATE_ENTRY:'CREATE',
  UPDATE_ENTRY:'UPDATE',
  DELETE_ENTRY:'DELETE',
  MERGE_ENTRIES:'MERGE',
  SPLIT_ENTRY:'SPLIT',
  MOVE_ENTRY:'MOVE',
  PLACE_ENTRY:'TREE_ASSIGN',
});

const text=(value,max=240)=>value==null?null:String(value).slice(0,max);
const list=(value,max=32)=>Array.isArray(value)?value.slice(0,max):[];
const uniq=(value,max=32)=>[...new Set(list(value,max*2).filter(x=>x!=null).map(String))].slice(0,max);
const clone=(value)=>value==null?value:(typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value)));
const treePath=(value)=>{
  if(Array.isArray(value))return value.filter(Boolean).map(String).slice(0,12);
  if(typeof value==='string')return value.split(/[\\/>]+/).map(x=>x.trim()).filter(Boolean).slice(0,12);
  return[];
};
const titleOf=(entry)=>text(entry?.title??entry?.comment??entry?.name??entry?.metadata?.title??entry?.uid??'Lore entry',160);
const contentOf=(entry,max=1200)=>text(entry?.content??entry?.text??entry?.body??'',max)??'';

export function verifySelectedLorebook({selectedSnapshot=null,ownerBook=null}={}){
  if(!selectedSnapshot)return Object.freeze({kind:'LorebookVerification',state:'NO_SELECTION',verified:false,reason:'No selected SillyTavern Lorebook snapshot is loaded.',lorebookId:ownerBook?.lorebookId??null,entryCount:null,matchedEntries:0,missingOwnerUids:[]});
  if(!ownerBook)return Object.freeze({kind:'LorebookVerification',state:'OWNER_IDENTITY_MISSING',verified:false,reason:'Worker 4 has not published source identity for the selected Lorebook.',lorebookId:selectedSnapshot?.id??null,entryCount:selectedSnapshot?.entries?.length??0,matchedEntries:0,missingOwnerUids:[]});
  const selectedId=String(selectedSnapshot.id??'');
  const ownerId=String(ownerBook.lorebookId??'');
  if(!selectedId||selectedId!==ownerId)return Object.freeze({kind:'LorebookVerification',state:'LOREBOOK_MISMATCH',verified:false,reason:'The loaded SillyTavern Lorebook does not match the owner source surface.',lorebookId:selectedId||null,ownerLorebookId:ownerId||null,entryCount:selectedSnapshot?.entries?.length??0,matchedEntries:0,missingOwnerUids:[]});
  const selectedUids=new Set((selectedSnapshot.entries??[]).map(row=>String(row?.uid??'')).filter(Boolean));
  const ownerUids=(ownerBook.sources??[]).map(row=>String(row?.uid??'')).filter(Boolean);
  const missingOwnerUids=ownerUids.filter(uid=>!selectedUids.has(uid)).slice(0,64);
  const matchedEntries=ownerUids.filter(uid=>selectedUids.has(uid)).length;
  const persisted=ownerBook.discoveryIdentityPersisted!==false;
  const verified=missingOwnerUids.length===0&&persisted;
  return Object.freeze({
    kind:'LorebookVerification',
    state:verified?'VERIFIED':missingOwnerUids.length?'SOURCE_SET_MISMATCH':'DISCOVERY_UNVERIFIED',
    verified,
    reason:verified?'Selected SillyTavern Lorebook matches Worker 4 exact source identity.':missingOwnerUids.length?'One or more owner source UIDs are absent from the loaded SillyTavern Lorebook.':'The source set matches, but Worker 4 did not publish persisted discovery identity.',
    lorebookId:selectedId,title:text(selectedSnapshot.title??ownerBook.title,180),entryCount:selectedSnapshot.entries?.length??0,
    ownerSourceCount:ownerUids.length,matchedEntries,missingOwnerUids,discoveryIdentityPersisted:persisted,
  });
}

export function buildExactLoreEntries({selectedSnapshot=null,ownerBook=null,query='',page=0,pageSize=32}={}){
  const ownerByUid=new Map((ownerBook?.sources??[]).map(row=>[String(row?.uid??''),row]));
  const needle=String(query??'').trim().toLowerCase();
  const rows=(selectedSnapshot?.entries??[]).map((entry,index)=>{
    const uid=String(entry?.uid??index),owner=ownerByUid.get(uid)??null;
    const path=treePath(entry?.metadata?.treePath??entry?.treePath??owner?.metadata?.treePath);
    return Object.freeze({
      kind:'ExactAuthoredLoreEntry',uid,index,title:titleOf(entry),content:contentOf(entry),
      keys:uniq(entry?.key??entry?.keys??entry?.keywords??[],16),treePath:path,
      sourceId:owner?.sourceId??null,sourceRevisionId:owner?.sourceRevisionId??null,revision:owner?.revision??null,
      sourceState:owner?.state??null,contentHash:owner?.contentHash??null,
      temporalState:text(entry?.metadata?.temporalState??entry?.temporalState??owner?.metadata?.temporalState,80),
      contradictionState:text(entry?.metadata?.contradictionState??entry?.contradictionState??owner?.metadata?.contradictionState,80),
      provenanceRefs:uniq(owner?.metadata?.provenanceRefs??entry?.metadata?.provenanceRefs??[],16),
      scope:text(owner?.metadata?.scope??entry?.metadata?.scope??entry?.metadata?.storyScope,180),
      exactSourceRecoverable:owner?.exactSourceRecoverable!==false,
    });
  }).filter(row=>!needle||[row.title,row.uid,row.sourceId,row.treePath.join(' / '),row.keys.join(' '),row.content].some(v=>String(v??'').toLowerCase().includes(needle)));
  const size=Math.max(8,Math.min(64,Number(pageSize)||32)),pages=Math.max(1,Math.ceil(rows.length/size)),safePage=Math.max(0,Math.min(pages-1,Number(page)||0));
  return Object.freeze({kind:'ExactLoreEntryPage',total:rows.length,page:safePage,pageSize:size,pages,rows:Object.freeze(rows.slice(safePage*size,(safePage+1)*size))});
}

export function buildHumanLoreTree(entries,{maxNodes=160}={}){
  const root={label:'Lorebook',path:[],entryUids:[],children:new Map()};
  const source=Array.isArray(entries)?entries:[];
  for(const entry of source){
    const path=treePath(entry?.treePath??entry?.metadata?.treePath);
    let node=root;
    for(const part of (path.length?path:['Unplaced'])){
      if(!node.children.has(part))node.children.set(part,{label:part,path:[...node.path,part],entryUids:[],children:new Map()});
      node=node.children.get(part);
    }
    node.entryUids.push(String(entry?.uid??entry?.sourceId??'unknown'));
  }
  let emitted=0;
  const flatten=(node,depth=0)=>{
    if(emitted>=maxNodes)return[];
    emitted+=1;
    const row=Object.freeze({kind:'HumanLoreTreeNode',label:node.label,path:Object.freeze([...node.path]),depth,entryUids:Object.freeze(node.entryUids.slice(0,64)),entryCount:node.entryUids.length,childCount:node.children.size});
    const children=[...node.children.values()].sort((a,b)=>a.label.localeCompare(b.label)).flatMap(child=>flatten(child,depth+1));
    return[row,...children];
  };
  const rows=flatten(root).slice(1);
  return Object.freeze({kind:'HumanLoreTree',nodeCount:rows.length,truncated:emitted>=maxNodes,rows:Object.freeze(rows)});
}

export function createLoreReviewProposal(input={}){
  const proposalKind=String(input.proposalKind??input.action??'').toUpperCase();
  if(!PROPOSAL_KINDS.includes(proposalKind))throw new TypeError('Unsupported Lore proposal kind: '+proposalKind);
  const localFence=list(input.sourceRevisionFence,16).map(row=>Object.freeze({
    sourceId:text(row?.sourceId,220),sourceRevisionId:text(row?.sourceRevisionId,220),contentHash:text(row?.contentHash,220),
  })).filter(row=>row.sourceId);
  const outputs=list(input.outputs,8).map(row=>Object.freeze({
    lorebookId:text(row?.lorebookId??input.lorebookId,180),uid:text(row?.uid,180),title:titleOf(row),
    content:contentOf(row,1600),treePath:Object.freeze(treePath(row?.treePath??row?.metadata?.treePath)),
    metadata:Object.freeze(clone(row?.metadata??{})),
  }));
  const payload={
    kind:'LoreUiReviewProposal',contractVersion:2,
    proposalId:text(input.proposalId??['ui-lore',proposalKind,input.lorebookId,input.sourceId,input.uid,input.targetUid,Date.now()].filter(Boolean).join(':'),260),
    proposalKind,lorebookId:text(input.lorebookId,180),sourceId:text(input.sourceId,220),baseSourceRevisionId:text(input.baseSourceRevisionId,220),uid:text(input.uid,180),
    targetUid:text(input.targetUid??input.uid,180),targetSourceIds:Object.freeze(uniq(input.targetSourceIds,16)),targetTreePath:Object.freeze(treePath(input.targetTreePath)),
    title:text(input.title,180),content:contentOf(input,1600),reason:text(input.reason,600),
    sourceMetadata:Object.freeze(clone(input.sourceMetadata??{})),targetMetadata:Object.freeze(clone(input.targetMetadata??{})),
    outputs:Object.freeze(outputs),sourceRevisionFence:Object.freeze(localFence),
    evidenceSourceIds:Object.freeze(uniq(input.evidenceSourceIds,32)),provenanceRefs:Object.freeze(uniq(input.provenanceRefs,32)),
    scope:text(input.scope,220),scopeMode:text(input.scopeMode,80),temporalState:text(input.temporalState,100),contradictionState:text(input.contradictionState,100),
    before:boundedPreview(input.before),after:boundedPreview(input.after),
    mutationAuthority:false,commitState:'DRAFT_NOT_SUBMITTED',operatorDecision:null,
  };
  return Object.freeze(payload);
}

export function proposalOwnerPath(proposal,capabilities={}){
  const kind=String(proposal?.proposalKind??proposal?.action??'').toUpperCase();
  if(PROPOSAL_KINDS.includes(kind))return capabilities.reviewedMutation||Number(capabilities.mutationExtensionVersion??0)>=1?LoreReviewOwnerPath.REVIEWED_MUTATION:LoreReviewOwnerPath.OWNER_CONTRACT_MISSING;
  return LoreReviewOwnerPath.OWNER_CONTRACT_MISSING;
}

export function toOwnerMutationRequest(proposal,{chatId=null,scopeMode=null}={}){
  const kind=String(proposal?.proposalKind??'').toUpperCase();
  const operation=LoreMutationOwnerOperation[kind];
  if(!operation)throw new TypeError(kind+' is not supported by Worker 4 mutationExtensionVersion:1');
  const resolvedScope=scopeMode??proposal?.scopeMode??null;
  const scope=resolvedScope==='GLOBAL_OPERATOR'
    ?{scopeMode:'GLOBAL_OPERATOR'}
    :{chatId:text(chatId??proposal?.scope,220)};
  if(!scope.chatId&&!scope.scopeMode)throw new TypeError('Exact chatId is required unless scopeMode=GLOBAL_OPERATOR is explicitly selected.');
  const request={operation,...scope,evidenceRefs:uniq(proposal?.provenanceRefs,64),origin:{kind:'OPERATOR_UI',uiProposalId:text(proposal?.proposalId,260)}};
  const metadata=(fallback={})=>({
    ...clone(fallback??{}),
    ...(proposal?.title?{title:proposal.title}:{}),
    ...(proposal?.targetTreePath?.length?{treePath:[...proposal.targetTreePath]}:{}),
  });
  if(kind==='CREATE_ENTRY'){
    const uid=required(proposal?.targetUid??proposal?.uid,'CREATE target UID');
    request.target={lorebookId:required(proposal?.lorebookId,'CREATE Lorebook'),uid,content:requiredContent(proposal?.content,'CREATE exact authored content'),metadata:metadata(proposal?.targetMetadata)};
  }else if(kind==='UPDATE_ENTRY'){
    request.sourceId=required(proposal?.sourceId,'UPDATE source');
    request.after={content:requiredContent(proposal?.content,'UPDATE exact authored content'),metadata:metadata(Object.keys(proposal?.sourceMetadata??{}).length?proposal.sourceMetadata:proposal?.targetMetadata)};
  }else if(kind==='DELETE_ENTRY'){
    request.sourceId=required(proposal?.sourceId,'DELETE source');
  }else if(kind==='MERGE_ENTRIES'){
    const ids=uniq([proposal?.sourceId,...(proposal?.targetSourceIds??[])],16);
    if(ids.length<2)throw new TypeError('MERGE requires at least two current source IDs.');
    request.sourceIds=ids;
    request.target={lorebookId:required(proposal?.lorebookId,'MERGE target Lorebook'),uid:required(proposal?.targetUid,'MERGE target UID'),content:requiredContent(proposal?.content,'MERGE exact output content'),metadata:metadata(proposal?.targetMetadata)};
  }else if(kind==='SPLIT_ENTRY'){
    request.sourceId=required(proposal?.sourceId,'SPLIT source');
    if((proposal?.outputs??[]).length<2)throw new TypeError('SPLIT requires at least two exact operator-supplied outputs.');
    request.outputs=proposal.outputs.map((row,index)=>({
      lorebookId:required(row?.lorebookId??proposal?.lorebookId,'SPLIT output '+String(index+1)+' Lorebook'),
      uid:required(row?.uid,'SPLIT output '+String(index+1)+' UID'),
      content:requiredContent(row?.content,'SPLIT output '+String(index+1)+' exact content'),
      metadata:{...clone(row?.metadata??{}),...(row?.title?{title:row.title}:{}),...(row?.treePath?.length?{treePath:[...row.treePath]}:{})},
    }));
  }else if(kind==='MOVE_ENTRY'){
    request.sourceId=required(proposal?.sourceId,'MOVE source');
    request.target={lorebookId:required(proposal?.lorebookId,'MOVE target Lorebook'),uid:required(proposal?.targetUid,'MOVE target UID'),metadata:metadata(Object.keys(proposal?.sourceMetadata??{}).length?proposal.sourceMetadata:proposal?.targetMetadata)};
  }else if(kind==='PLACE_ENTRY'){
    request.sourceId=required(proposal?.sourceId,'TREE_ASSIGN source');
    if(!proposal?.targetTreePath?.length)throw new TypeError('TREE_ASSIGN requires a target human-tree path.');
    request.treePath=[...proposal.targetTreePath];
  }
  return Object.freeze(request);
}

// Compatibility export for older Worker 3 tests/callers. The UI no longer uses a source-session seam.
export function toOwnerSourceMutationProposal(proposal,options={}){
  return toOwnerMutationRequest(proposal,options);
}

export function compareMutationFences(localProposal,ownerProposal){
  const local=list(localProposal?.sourceRevisionFence,32);
  const owner=list(ownerProposal?.sourceRevisionFence,32);
  const localMap=new Map(local.map(row=>[String(row?.sourceId??''),String(row?.sourceRevisionId??'')]));
  const changed=owner.filter(row=>{
    const expected=localMap.get(String(row?.sourceId??''));
    return expected&&expected!==String(row?.sourceRevisionId??'');
  }).map(row=>({sourceId:row.sourceId,localSourceRevisionId:localMap.get(String(row.sourceId)),ownerSourceRevisionId:row.sourceRevisionId}));
  const missing=local.filter(row=>!owner.some(x=>String(x?.sourceId)===String(row?.sourceId))).map(row=>row.sourceId);
  return Object.freeze({kind:'LoreMutationFenceComparison',matches:changed.length===0&&missing.length===0,changed:Object.freeze(changed),missing:Object.freeze(missing)});
}

export function summarizeLoreReviewAction(action,{contentLimit=900}={}){
  const receipt=action?.evidenceReceipt??{},proposed=action?.proposedOutput??{},before=action?.before??proposed?.before??receipt?.before??null,after=action?.after??proposed?.after??receipt?.after??proposed??null;
  return Object.freeze({
    kind:'LoreReviewActionSummary',actionId:text(action?.id??action?.actionId,220),action:text(action?.action??action?.type??proposed?.action,100),
    decision:text(action?.decision,80),previewOnly:!action?.materialized,materialized:Boolean(action?.materialized),
    before:boundedPreview(before,contentLimit),after:boundedPreview(after,contentLimit),
    sourceRevisionRefs:Object.freeze(uniq(action?.inputSourceRevisions??receipt?.exactSourceRevisions??receipt?.sourceRevisionRefs??[],32)),
    provenanceRefs:Object.freeze(uniq(receipt?.provenanceRefs??receipt?.learnedEvidenceRefs??action?.evidenceRefs??[],32)),
    scope:text(receipt?.scope??receipt?.storyScope?.chatId??action?.scope,220),
    temporalState:text(receipt?.temporalState??proposed?.temporalState??action?.temporalState,100),
    contradictionState:text(receipt?.contradictionState??proposed?.contradictionState??action?.contradictionState,100),
    affectedTreeNodes:Object.freeze(uniq(action?.affectedTreeNodes??proposed?.affectedTreeNodes??[],32)),
    dependencyArea:Object.freeze(uniq(action?.dependencyArea??action?.invalidationTargets??proposed?.invalidationTargets??receipt?.invalidationTargets??[],32)),
    rationale:text(action?.rationale??proposed?.rationale,700),
  });
}

export function loreRestudyProgress(read){
  const data=read?.data??read??{},counts=data.operatorCounts??{},entries=Array.isArray(data.entries)?data.entries:[];
  const accepted=Number(counts.ACCEPTED??entries.filter(x=>String(x.operatorState).toUpperCase()==='ACCEPTED').length)||0;
  const studying=Number(counts.STUDYING??entries.filter(x=>String(x.operatorState).toUpperCase()==='STUDYING').length)||0;
  const ready=Number(counts.READY??entries.filter(x=>String(x.operatorState).toUpperCase()==='READY').length)||0;
  const failed=Number(counts.FAILED??entries.filter(x=>String(x.operatorState).toUpperCase()==='FAILED').length)||0;
  const removed=Number(counts.REMOVED??entries.filter(x=>String(x.operatorState).toUpperCase()==='REMOVED').length)||0;
  const stale=entries.filter(x=>String(x.freshness??'').toUpperCase().includes('STALE')).length;
  const total=Math.max(entries.length,accepted+studying+ready+failed+removed);
  return Object.freeze({kind:'LoreRestudyProgress',accepted,studying,ready,failed,removed,stale,total,complete:total>0&&ready+removed===total&&failed===0&&studying===0&&accepted===0});
}

export function mutationRestudyProgress(ownerProposal,read){
  const ids=uniq(ownerProposal?.state==='RESTORED'?(ownerProposal?.restoration?.studyObligationIds??ownerProposal?.studyObligationIds):ownerProposal?.studyObligationIds,64),data=read?.data??read??{},entries=Array.isArray(data.entries)?data.entries:[];
  if(!ids.length)return Object.freeze({kind:'LoreMutationRestudyProgress',state:'NO_EVIDENCE',obligationIds:[],matched:0,missing:0,accepted:0,studying:0,ready:0,failed:0,removed:0,complete:false});
  const wanted=new Set(ids),rows=entries.filter(row=>wanted.has(String(row?.studyObligationId??'')));
  const observedIds=new Set(rows.map(row=>String(row?.studyObligationId??'')));
  const count=(state)=>rows.filter(row=>String(row?.operatorState??'').toUpperCase()===state).length;
  const missing=ids.filter(id=>!observedIds.has(id)).length,accepted=count('ACCEPTED'),studying=count('STUDYING'),ready=count('READY'),failed=count('FAILED'),removed=count('REMOVED');
  return Object.freeze({kind:'LoreMutationRestudyProgress',state:missing?'PARTIAL_RECEIPTS':failed?'FAILED':accepted||studying?'IN_PROGRESS':'READY',obligationIds:Object.freeze(ids),matched:rows.length,missing,accepted,studying,ready,failed,removed,complete:missing===0&&failed===0&&accepted===0&&studying===0&&ready+removed===ids.length});
}

function required(value,label){const v=value==null?'':String(value).trim();if(!v)throw new TypeError(label+' is required.');return v;}
function requiredContent(value,label){if(typeof value!=='string'||!value.trim())throw new TypeError(label+' is required.');return value;}
function boundedPreview(value,max=1200){
  if(value==null)return null;
  if(typeof value==='string')return Object.freeze({text:text(value,max)});
  if(typeof value!=='object')return Object.freeze({value:text(value,max)});
  return Object.freeze({
    title:titleOf(value),uid:text(value.uid,180),sourceId:text(value.sourceId,220),sourceRevisionId:text(value.sourceRevisionId??value.revisionId,220),
    content:contentOf(value,max),treePath:Object.freeze(treePath(value.treePath??value.metadata?.treePath)),
    keys:Object.freeze(uniq(value.key??value.keys??value.keywords??[],16)),
    scope:text(value.scope??value.storyScope?.chatId??value.metadata?.scope,220),
    temporalState:text(value.temporalState??value.metadata?.temporalState,100),
    contradictionState:text(value.contradictionState??value.metadata?.contradictionState,100),
  });
}
