import { RenderCost } from './constants.js';
import { createButton, createKeyValue, element, makeBadge, makeCard, makeHealthPill } from './primitives.js';
import { VirtualListController } from './virtualization.js';
import { ProductDetailLevel } from './wave5-product-model.js';
import { ProductDataMode } from './wave6-contracts.js';
import { createAuthorityPill, createProductHealthSurface, sourceModeBadge, sourceStateMessage } from './wave6-presentation.js';
import { CognitionStageState, explainCognitionWhy } from './wave8-cognition.js';
import { renderBrainDecisionExplanation } from './brain-decision-visibility.js';

export function registerWave8Actions(actionRouter){
  const releases=[];
  if(!actionRouter.hasSubsystem('wave8-ui'))releases.push(actionRouter.registerSubsystem('wave8-ui',async action=>{
    if(action.type==='wave8.why')return explainCognitionWhy(action.target?.item??action.target);
    if(action.type==='wave8.inspect')return action.target?.object??action.target??null;
    if(action.type==='wave8.openWorkspace')return{workspaceId:action.target?.workspaceId??null};
    return null;
  }));
  for(const type of ['wave8.why','wave8.inspect','wave8.openWorkspace'])if(!actionRouter.hasAction(type))releases.push(actionRouter.registerAction(type,{subsystem:'wave8-ui'}));
  return()=>{for(const release of releases.reverse())try{release?.();}catch{}};
}

export function registerWave8Inspectors(registry,{cognition=null,forensics=null,decisionVisibility=null}={}){
  const releases=[];
  for(const kind of ['wave8-stage','wave8-job','wave8-sensory-candidate','wave8-truth-item','wave8-jev','wave8-gather-item','wave8-resource','wave8-lore']){
    if(!registry.has(kind))releases.push(registry.register(kind,(object,ctx)=>renderInspectorObject(object,ctx,{cognition,forensics})));
  }
  if(!registry.has('wave8-brain-decision'))releases.push(registry.register('wave8-brain-decision',(object,{document:d})=>{
    const model=object?.item??decisionVisibility?.read?.(object?.selection??{})??null;
    return renderBrainDecisionExplanation(d,model,{title:object?.title??'Selected-turn Brain decisions'});
  }));
  return()=>{for(const release of releases.reverse())try{release?.();}catch{}};
}

export function renderLiveBrainCognition(host,ctx){
  const d=host.ownerDocument,detail=ctx.productAdapter.getDetailLevel(),read=ctx.cognition?.read?.(currentSelection(ctx))??null;
  if(!read){host.append(sourceStateMessage(d,null));return;}
  const path=read.data;
  host.append(section(d,'Live cognition'));
  host.append(createProductHealthSurface(d,{source:read.source,label:'Brain cognition',compact:true,onInspect:()=>inspect(ctx,{kind:'wave8-stage',id:'brain-cognition',title:'Brain cognition',item:path,source:read.source})}));
  if(!path||read.source.mode===ProductDataMode.UNAVAILABLE){
    host.append(sourceStateMessage(d,read.source));return;
  }
  if(read.source.mode===ProductDataMode.FIXTURE)host.append(state(d,'Fixture mode','This cognition path is deterministic demo/test data, not live Brain activity.','inferred'));
  const decisionModel=ctx.brainDecisionVisibility?.read?.(currentSelection(ctx))??null;
  if(decisionModel)host.append(renderBrainDecisionExplanation(d,decisionModel,{compact:true,title:'Selected-turn Brain decisions',onInspect:()=>inspect(ctx,{kind:'wave8-brain-decision',id:'selected-turn-brain-decisions',title:'Selected-turn Brain decisions',item:decisionModel})}));
  host.append(sceneLoreStrip(d,path,read.sources,ctx));
  host.append(pipeline(d,path,ctx));
  host.append(normalSummary(d,path,ctx));
  if(detail!==ProductDetailLevel.NORMAL){
    host.append(choiceDetail(d,path,ctx));
    host.append(sensoryDetail(d,path,ctx));
    host.append(retrievalTruthDetail(d,path,ctx));
    host.append(jevPrecisionDetail(d,path,ctx));
    host.append(gatherDetail(d,path,ctx));
  }
  if(detail===ProductDetailLevel.ADVANCED){
    host.append(advancedIdentity(d,path,ctx));
    renderAdvancedCollections(host,d,path,ctx);
  }
}

function sceneLoreStrip(d,path,sources,ctx){
  const grid=element(d,'div',{className:'a52-wave8-status-grid'});
  const scene=path.scene,sceneCard=element(d,'section',{className:'a52-card a52-wave8-status-card'});
  sceneCard.append(element(d,'span',{className:'a52-eyebrow',text:'Current Scene'}));
  if(scene){
    sceneCard.append(sourceModeBadge(d,sources?.scene),element(d,'strong',{text:scene.title??scene.location??scene.sceneId??'Current Scene'}),element(d,'span',{className:'a52-muted',text:`Scene revision ${scene.revision??scene.sceneRevision??'unavailable'}`}));
    const cast=scene.cast??scene.activeCast??[];if(cast.length)sceneCard.append(element(d,'span',{text:cast.map(x=>typeof x==='string'?x:x.name??x.id).filter(Boolean).join(' · ')}));
  }else sceneCard.append(element(d,'strong',{text:'Scene Intelligence unavailable'}));
  grid.append(sceneCard);

  const lore=path.lore,loreCard=element(d,'section',{className:'a52-card a52-wave8-status-card'});
  loreCard.append(element(d,'span',{className:'a52-eyebrow',text:'Lore'}));
  if(lore){
    loreCard.append(sourceModeBadge(d,sources?.lore),element(d,'strong',{text:`${lore.sourceEntryCount??'—'} source entries`}),element(d,'span',{className:'a52-muted',text:`Representations: ${lore.learnedState??'unavailable'} · Index: ${lore.indexState??'unavailable'}`}),element(d,'span',{className:'a52-muted',text:`Revision: ${lore.lastRevision??'unavailable'}`}));
    loreCard.append(createButton(d,{label:'Inspect',scope:ctx.scope,size:'sm',variant:'inspect',onPress:()=>inspectThroughRouter(ctx,{kind:'wave8-lore',id:lore.lastRevision??'lore',title:'Lore cognition',item:lore})}));
  }else loreCard.append(element(d,'strong',{text:'Lore learning status unavailable'}));
  grid.append(loreCard);return grid;
}

function pipeline(d,path,ctx){
  const card=element(d,'section',{className:'a52-card a52-wave8-pipeline',attrs:{'aria-label':'Brain cognitive pipeline'}});
  card.append(element(d,'h2',{text:'Cognitive path'}));
  const flow=element(d,'div',{className:'a52-wave8-pipeline__flow'});
  for(const stage of path.stages){
    const button=element(d,'button',{className:'a52-wave8-stage',attrs:{type:'button','aria-label':`${stage.label}: ${stage.state}. ${stage.summary}`},dataset:{state:stage.state}});
    button.append(element(d,'span',{className:'a52-wave8-stage__mark',text:stageGlyph(stage.state)}),element(d,'strong',{text:stage.label}),makeBadge(d,stage.state,statusToken(stage.state)));
    if(stage.details?.mode)button.append(makeBadge(d,stage.details.mode,stage.details.mode===ProductDataMode.LIVE?'ready':stage.details.mode===ProductDataMode.DEGRADED?'warning':stage.details.mode===ProductDataMode.FIXTURE?'inferred':'offline'));
    button.append(element(d,'span',{className:'a52-muted',text:stage.summary||stage.reason||'No recorded detail'}));
    ctx.scope.listen(button,'click',()=>inspectThroughRouter(ctx,{kind:'wave8-stage',id:stage.id,title:stage.label,item:stage}));
    flow.append(button);
  }
  card.append(flow);return card;
}

function normalSummary(d,path,ctx){
  const s=path.summary,grid=element(d,'div',{className:'a52-product-grid a52-wave8-summary'});
  const saved=optimizationSummary(path.choice?.measurements);
  grid.append(summaryCard(d,'Brain chose',s.brainChoice??'Choice receipt unavailable',s.jobs?`${s.jobs.admitted} admitted · ${s.jobs.skipped} skipped · ${s.jobs.deferred} deferred${saved?' · '+saved:''}`:'No job admission receipt'));
  grid.append(summaryCard(d,'Sensory',s.sensory?`${s.sensory.nominations} nominations → ${s.sensory.unique} unique`:'Unavailable',path.sensory?`${path.sensory.duplicateNominationCount} duplicates merged`:'No Candidate Bus receipt'));
  grid.append(summaryCard(d,'Retrieval',s.retrievalQuality??stageState(path,'RETRIEVAL_QUALITY'),retrievalMeaning(path)));
  grid.append(truthCard(d,path));
  grid.append(jevCard(d,path,ctx));
  grid.append(summaryCard(d,'Gather',s.gather?`${s.gather.ADMITTED} admitted`:'Unavailable',s.gather?`${s.gather.STALE} stale · ${s.gather.LATE} late · ${s.gather.REJECTED+s.gather.INVALID} rejected/invalid`:'No Gather receipt'));
  grid.append(summaryCard(d,'Context',s.seal?.sealed?'SEALED':'Unavailable',s.seal?`${s.seal.admitted} admitted · ${s.seal.stale} stale · ${s.seal.late} late excluded`:'No Context Seal receipt'));
  grid.append(summaryCard(d,'PromptPlan',s.promptPlan?`${number(s.promptPlan.tokens)} tokens`:'Unavailable',s.promptPlan?.id??'No PromptPlan read model'));
  return grid;
}

function choiceDetail(d,path,ctx){
  const card=element(d,'section',{className:'a52-card'});card.append(element(d,'h2',{text:'Cognitive Choice & job admission'}));
  const choice=path.choice;
  if(!choice){card.append(state(d,'Choice unavailable','No CognitiveChoiceReceipt is connected. Jobs are not inferred from worker activity.','offline'));return card;}
  card.append(element(d,'p',{text:choice.brainChoice?`Brain chose: ${choice.brainChoice}`:'Recorded cognitive choice'}));
  card.append(createKeyValue(d,[{key:'Candidate jobs',value:choice.candidateJobs.length},{key:'Admitted',value:choice.admitted.length},{key:'Skipped',value:choice.skipped.length},{key:'Deferred',value:choice.deferred.length}]));
  const savings=optimizationRows(choice.measurements);if(savings.length)card.append(element(d,'h3',{text:'Measured avoided work'}),createKeyValue(d,savings),element(d,'p',{className:'a52-muted',text:'These savings are displayed only because the CognitiveChoiceReceipt published them; UI.Core does not estimate skipped backend work.'}));
  const groups=[['ADMITTED',choice.admitted],['SKIPPED',choice.skipped],['DEFERRED',choice.deferred]];
  for(const [label,rows] of groups){
    if(!rows.length)continue;card.append(element(d,'h3',{text:label}));
    const listHost=element(d,'div',{className:'a52-wave8-decision-list'});
    for(const row of rows.slice(0,24))listHost.append(decisionRow(d,row,ctx));
    if(rows.length>24)listHost.append(element(d,'span',{className:'a52-muted',text:`+${rows.length-24} more — open Advanced for virtualized inspection`}));
    card.append(listHost);
  }
  if(path.scatter){
    card.append(element(d,'h3',{text:'Execution resources'}),element(d,'p',{text:`${path.scatter.jobs.length} logical jobs used ${path.scatter.resourceCount} physical execution resource${path.scatter.resourceCount===1?'':'s'}. Logical capability and physical resource identity are separate.`}));
  }
  return card;
}

function sensoryDetail(d,path,ctx){
  const card=element(d,'section',{className:'a52-card'});card.append(element(d,'h2',{text:'Sensory Net'}));
  const x=path.sensory;if(!x){card.append(state(d,'Sensory unavailable','No Candidate Bus / Sensory receipt was published.','offline'));return card;}
  card.append(element(d,'p',{text:`${x.inputNominationCount} nominations → ${x.uniqueCandidateCount} unique evidence candidates. ${x.duplicateNominationCount} cross-channel duplicates were merged.`}));
  const rows=Object.entries(x.perChannelCounts??{}).map(([key,value])=>({key:human(key),value}));
  if(rows.length)card.append(createKeyValue(d,rows));else if(x.channelsUsed?.length)card.append(element(d,'p',{text:`Channels used: ${x.channelsUsed.map(human).join(' · ')}`}),element(d,'p',{className:'a52-muted',text:'Per-channel nomination counts were not published in this summary receipt.'}));
  if(x.unavailableChannels.length||x.degradedChannels.length)card.append(state(d,'Channel degradation',`Unavailable: ${x.unavailableChannels.join(', ')||'none'} · Degraded: ${x.degradedChannels.join(', ')||'none'}`,'warning'));
  card.append(element(d,'p',{className:'a52-muted',text:'Channel count and fusion rank are retrieval metadata, not truth or authority.'}));
  return card;
}

function retrievalTruthDetail(d,path,ctx){
  const wrap=element(d,'div',{className:'a52-wave8-detail-grid'}),truth=path.truth,corrective=path.corrective;
  const retrieval=element(d,'section',{className:'a52-card'});retrieval.append(element(d,'h2',{text:'Retrieval quality'}));
  if(!truth){const st=path.stages.find(x=>x.id==='RETRIEVAL_QUALITY');retrieval.append(state(d,st?.state==='SKIPPED'?'Retrieval skipped':'Retrieval unavailable',st?.reason??st?.summary??'No retrieval-quality assessment.'));}else{
    retrieval.append(makeHealthPill(d,{label:truth.retrievalQuality??'UNAVAILABLE',status:qualityStatus(truth.retrievalQuality),detail:retrievalMeaning(path)}),element(d,'p',{text:truth.reason??'No reason published by Truth/quality producer.'}));
    if(truth.retrievalQuality==='MIXED')retrieval.append(correctiveFlow(d,truth,corrective));
    if(truth.retrievalQuality==='LOW')retrieval.append(state(d,'No long-term-memory contribution required','Generation may continue using current/Hot state. LOW retrieval is not a system failure.','historical'));
  }
  wrap.append(retrieval);

  const truthCardNode=element(d,'section',{className:'a52-card'});truthCardNode.append(element(d,'h2',{text:'Truth Gate'}));
  if(!truth)truthCardNode.append(state(d,'Truth unavailable','No TruthAssessment was published.','offline'));
  else{
    const chips=element(d,'div',{className:'a52-inline-status'});for(const [kind,count] of Object.entries(truth.counts).filter(([,n])=>n>0))chips.append(makeBadge(d,`${count} ${kind}`,truthStatus(kind)));truthCardNode.append(chips);
    truthCardNode.append(element(d,'p',{className:'a52-muted',text:'Truth classification remains separate from retrieval ranking, channel count, and Jev recommendation.'}));
    const unresolved=truth.truthRows.filter(x=>['CONTRADICTED','UNCERTAIN','UNRESOLVED'].includes(x.classification));for(const row of unresolved.slice(0,8))truthCardNode.append(truthRow(d,row,ctx));
  }
  wrap.append(truthCardNode);return wrap;
}

function jevPrecisionDetail(d,path,ctx){
  const wrap=element(d,'div',{className:'a52-wave8-detail-grid'});
  const jev=element(d,'section',{className:'a52-card'});jev.append(element(d,'h2',{text:'Jev'}));
  const j=path.jev;
  if(!j){jev.append(state(d,'Jev unavailable','No JevDecisionReceipt and no explicit Cognitive Choice skip decision are available.','offline'));}else if(j.state===CognitionStageState.UNAVAILABLE){jev.append(makeBadge(d,'UNAVAILABLE','warning'),element(d,'p',{text:j.reason??'Jev service was unavailable.'}),element(d,'p',{className:'a52-muted',text:'Ambiguity remains unresolved; no forced adjudication or Settlement is implied.'}));}else if(j.state===CognitionStageState.SKIPPED){
    jev.append(makeBadge(d,'SKIPPED','historical'),element(d,'p',{text:j.reason??'Jev was explicitly skipped; no reason was published.'}));
  }else{
    jev.append(makeBadge(d,j.outcome,jevStatus(j.outcome)),element(d,'p',{text:j.reason??'No Jev reason code was published.'}));
    const selected=j.selectedOptionIds.length?j.selectedOptionIds.join(', '):'none';
    jev.append(createKeyValue(d,[{key:'Selected/recommended',value:selected},{key:'Unresolved factors',value:j.unresolvedFactors.length},{key:'Owner settlement',value:j.ownerSettlement?.status??(j.requiresOwnerSettlement?'PENDING':'separate / not claimed')}]));
    jev.append(element(d,'p',{className:'a52-muted',text:'Jev is advisory cognition. A Jev selection is not automatically canon or Settlement.'}));
    jev.append(createButton(d,{label:'Inspect Jev evidence',scope:ctx.scope,variant:'inspect',onPress:()=>inspectThroughRouter(ctx,{kind:'wave8-jev',id:j.receiptId??'jev',title:'Jev decision',item:j})}));
  }
  wrap.append(jev);

  const precision=element(d,'section',{className:'a52-card'});precision.append(element(d,'h2',{text:'Precision'}));const p=path.precision;
  if(!p)precision.append(state(d,'Precision unavailable','No Precision receipt or explicit Choice skip decision is available.','offline'));
  else if(p.state===CognitionStageState.SKIPPED)precision.append(makeBadge(d,'SKIPPED','historical'),element(d,'p',{text:p.reason??'Precision was explicitly skipped.'}));
  else precision.append(makeBadge(d,p.state,statusToken(p.state)),element(d,'p',{text:`${p.inputCount??p.results.length} candidates → ${p.outputCount??p.results.length} generation-facing rankings.`}),element(d,'p',{className:'a52-muted',text:'Rerank score is ordering metadata, not truth or authority.'}));
  wrap.append(precision);return wrap;
}

function gatherDetail(d,path,ctx){
  const card=element(d,'section',{className:'a52-card'});card.append(element(d,'h2',{text:'Gather → Seal → PromptPlan'}));const g=path.gather;
  if(!g){card.append(state(d,'Gather unavailable','No GatherReceipt is connected. Context contribution is not inferred from Result Bus presence alone.','offline'));return card;}
  const chips=element(d,'div',{className:'a52-inline-status'});for(const key of ['ADMITTED','STALE','LATE','REJECTED','INVALID'])chips.append(makeBadge(d,`${g.counts[key]} ${key}`,gatherStatus(key)));card.append(chips);
  for(const row of g.results.filter(x=>x.status!=='ADMITTED').slice(0,10))card.append(gatherRow(d,row,ctx));
  const seal=path.seal;if(seal){const admitted=seal.admittedEvidenceCount??(seal.effectiveAdmittedResultIds??seal.admittedResultIds??[]).length;const conflict=seal.coherenceConflictIds?.length??0;card.append(state(d,'Context Seal',conflict?`SEALED receipt degraded · ${conflict} conflicting admission${conflict===1?'':'s'} hidden from admitted display until producer correction.`:`SEALED · ${admitted} cognitive results/evidence admitted · ${seal.staleResultIds.length} stale excluded · ${seal.lateResultIds.length} late excluded.`,conflict?'warning':'ready'));}
  else card.append(state(d,'Context Seal unavailable','The immutable publication boundary cannot be shown without a Seal receipt.','offline'));
  if(path.promptPlan)card.append(createButton(d,{label:'Why This Generation?',scope:ctx.scope,onPress:()=>openWorkspace(ctx,'generation-explainability')}));
  card.append(createButton(d,{label:'Open Forensics',scope:ctx.scope,variant:'quiet',onPress:()=>openWorkspace(ctx,'forensics')}));
  return card;
}

function advancedIdentity(d,path,ctx){
  const card=element(d,'section',{className:'a52-card'});card.append(element(d,'h2',{text:'Advanced cognition identity'}),createKeyValue(d,[
    {key:'Turn',value:path.turnId??'unavailable'},{key:'Generation',value:path.generationId??'unavailable'},{key:'Correlation',value:path.correlationId??'unavailable'},
    {key:'World / Scene revision',value:`${path.choice?.revisionIdentity?.worldRevision??path.sensory?.worldRevision??path.seal?.worldRevision??'—'} / ${path.choice?.revisionIdentity?.sceneRevision??path.sensory?.sceneRevision??path.seal?.sceneRevision??'—'}`},
    {key:'Context Seal',value:path.seal?.sealId??'unavailable'},{key:'PromptPlan',value:path.promptPlan?.promptPlanId??'unavailable'},
    {key:'Bound chat / turn',value:`${path.bindingSelection?.chatId??'—'} / ${path.bindingSelection?.turnId??path.turnId??'—'}`},
  ]));
  if(path.jev?.confidence!=null)card.append(element(d,'p',{className:'a52-muted',text:`Jev confidence metadata: ${path.jev.confidence}. This is not a probability of truth and does not grant authority.`}));
  return card;
}

function renderAdvancedCollections(host,d,path,ctx){
  if(path.scatter?.jobs?.length)host.append(section(d,'Execution resource mapping'),virtualCollection(d,path.scatter.jobs,ctx,{kind:'wave8-resource',title:'Logical execution jobs',rowLabel:x=>`${x.capability} · ${x.state} · resource ${x.resourceId??'unavailable'}`,height:52}));
  if(path.sensory?.candidates?.length)host.append(section(d,'Sensory candidates'),virtualCollection(d,path.sensory.candidates,ctx,{kind:'wave8-sensory-candidate',title:'Sensory candidate',rowLabel:x=>`${x.candidateId??'candidate'} · ${x.freshness} · ${x.channels.length} channels`,height:54}));
  if(path.gather?.results?.length)host.append(section(d,'Gather results'),virtualCollection(d,path.gather.results,ctx,{kind:'wave8-gather-item',title:'Gather result',rowLabel:x=>`${x.capability} · ${x.status} · ${x.resultId??'result'}`,height:56}));
}

function virtualCollection(d,items,ctx,{kind,title,rowLabel,height=54}){
  const card=element(d,'section',{className:'a52-card a52-wave8-virtual'}),host=element(d,'div');card.append(element(d,'span',{className:'a52-muted',text:`${items.length} items · virtualized`}),host);
  new VirtualListController({host,items,itemSize:height,overscan:8,scope:ctx.scope,keyForItem:(x,i)=>x.id??x.jobId??x.candidateId??x.resultId??String(i),renderItem(item){
    const b=element(d,'button',{className:'a52-wave8-list-row',attrs:{type:'button'},text:rowLabel(item)});ctx.scope.listen(b,'click',()=>inspectThroughRouter(ctx,{kind,id:item.id??item.jobId??item.candidateId??item.resultId??title,title,item}));return b;
  }}).mount();return card;
}

function decisionRow(d,row,ctx){
  const root=element(d,'div',{className:'a52-wave8-decision-row',dataset:{disposition:row.disposition}});root.append(makeBadge(d,row.disposition,dispositionStatus(row.disposition)),element(d,'strong',{text:row.capability}),element(d,'span',{className:'a52-muted',text:row.reason??'Reason not published'}));
  root.append(createButton(d,{label:'Why?',scope:ctx.scope,size:'sm',variant:'quiet',onPress:()=>why(ctx,row)}));return root;
}
function truthRow(d,row,ctx){const root=element(d,'div',{className:'a52-wave8-truth-row'});root.append(makeBadge(d,row.classification,truthStatus(row.classification)),element(d,'span',{text:row.candidateId??'candidate'}),createButton(d,{label:'Why?',scope:ctx.scope,size:'sm',variant:'quiet',onPress:()=>why(ctx,row)}));return root;}
function gatherRow(d,row,ctx){const root=element(d,'div',{className:'a52-wave8-gather-row',dataset:{status:row.status}});root.append(makeBadge(d,row.status,gatherStatus(row.status)),element(d,'strong',{text:row.capability}),element(d,'span',{className:'a52-muted',text:row.reason??gatherImpact(row)}),createButton(d,{label:'Why?',scope:ctx.scope,size:'sm',variant:'quiet',onPress:()=>why(ctx,row)}));return root;}
function correctiveFlow(d,truth,corrective){const root=element(d,'div',{className:'a52-wave8-corrective',attrs:{'aria-label':'Bounded corrective retrieval'}});root.append(element(d,'span',{text:'Initial retrieval'}),makeBadge(d,'MIXED','warning'),element(d,'span',{text:'→'}));if(corrective){root.append(element(d,'span',{text:'Corrective pass'}),makeBadge(d,corrective.state,statusToken(corrective.state)),element(d,'span',{text:`Attempt ${corrective.attempt??'—'} / ${corrective.maxAttempts??1}`}));if(corrective.finalQuality)root.append(element(d,'span',{text:'→'}),makeBadge(d,corrective.finalQuality,qualityStatus(corrective.finalQuality)));}else root.append(makeBadge(d,'CORRECTION RECEIPT UNAVAILABLE','offline'));return root;}
function summaryCard(d,title,value,detail){const body=element(d,'div',{className:'a52-stack'});body.append(element(d,'strong',{className:'a52-metric-value',text:String(value)}),element(d,'span',{className:'a52-muted',text:String(detail??'')}));return makeCard(d,{title,body});}
function truthCard(d,path){const body=element(d,'div',{className:'a52-stack'}),truth=path.truth;if(!truth){body.append(element(d,'strong',{className:'a52-metric-value',text:'Unavailable'}));return makeCard(d,{title:'Truth',body});}const rows=Object.entries(truth.counts).filter(([,n])=>n>0).map(([k,n])=>`${n} ${k}`);body.append(element(d,'strong',{className:'a52-metric-value',text:rows.join(' · ')||'No candidates'}));return makeCard(d,{title:'Truth',body});}
function jevCard(d,path,ctx){const body=element(d,'div',{className:'a52-stack'}),j=path.jev;if(!j)body.append(element(d,'strong',{className:'a52-metric-value',text:'Unavailable'}),element(d,'span',{className:'a52-muted',text:'No Jev receipt / explicit skip decision'}));else if(j.state===CognitionStageState.UNAVAILABLE)body.append(element(d,'strong',{className:'a52-metric-value',text:'Unavailable'}),element(d,'span',{className:'a52-muted',text:j.reason??'Ambiguity preserved without forced adjudication'}));else body.append(element(d,'strong',{className:'a52-metric-value',text:j.outcome==='SKIPPED'?'Skipped':j.outcome}),element(d,'span',{className:'a52-muted',text:j.reason??'Reason not published'}));return makeCard(d,{title:'Jev',body});}

function renderInspectorObject(object,{document:d,scope},{forensics}){
  const item=object.item??object.payload??object,root=element(d,'div',{className:'a52-stack'});root.append(element(d,'h2',{text:object.title??'Cognitive detail'}));
  if(item.state)root.append(makeBadge(d,item.state,statusToken(item.state)));if(item.status)root.append(makeBadge(d,item.status,gatherStatus(item.status)));if(item.classification)root.append(makeBadge(d,item.classification,truthStatus(item.classification)));if(item.authority&&typeof item.authority==='string')root.append(createAuthorityPill(d,item.authority));
  const rows=[];for(const [key,value] of Object.entries(item??{})){if(value==null||['kind','rawPayload','payload'].includes(key))continue;if(typeof value==='function'||typeof value==='object')continue;rows.push({key,value:String(value)});if(rows.length>=18)break;}if(rows.length)root.append(createKeyValue(d,rows));
  if(item.reason||item.reasonCode)root.append(element(d,'p',{text:`Recorded reason: ${item.reason??item.reasonCode}`}));
  if(item.evidenceRefs?.length)root.append(element(d,'p',{className:'a52-muted',text:`Evidence refs: ${item.evidenceRefs.join(', ')}`}));
  if(forensics&&item.evidenceRefs?.length){const ref=item.evidenceRefs[0],trace=forensics.getKnowledgeTrace?.(ref);if(trace)root.append(element(d,'pre',{className:'a52-context-packet',text:JSON.stringify(trace,null,2)}));}
  return root;
}

async function why(ctx,item){const result=await ctx.actionRouter.route({type:'wave8.why',target:{item}});if(result.ok)ctx.inspect?.({kind:'wave8-stage',id:`why:${item.jobId??item.resultId??item.candidateId??item.classification??'item'}`,title:'Why?',item:result.result});}
async function inspectThroughRouter(ctx,object){const result=await ctx.actionRouter.route({type:'wave8.inspect',target:{object}});if(result.ok)ctx.inspect?.(result.result);}
async function openWorkspace(ctx,id){const result=await ctx.actionRouter.route({type:'wave8.openWorkspace',target:{workspaceId:id}});if(result.ok&&result.result?.workspaceId)ctx.navigate?.(result.result.workspaceId);}
function inspect(ctx,o){ctx.inspect?.(o);}
function currentSelection(ctx){
  const bookmark=ctx.presentation?.get?.().bookmark??null;
  if(bookmark?.generationId||bookmark?.turnId)return ctx.liveReceiptBinding?.selection?.({generationId:bookmark.generationId??null,turnId:bookmark.turnId??null})??{generationId:bookmark.generationId??null,turnId:bookmark.turnId??null};
  return ctx.liveReceiptBinding?.selection?.()??{};
}
function retrievalMeaning(path){const q=path.truth?.retrievalQuality;if(q==='HIGH')return'Retrieval was sufficient.';if(q==='MIXED')return path.corrective?.executed?'Evidence was incomplete; one bounded corrective pass was performed.':'Evidence was incomplete; correction status unavailable.';if(q==='LOW')return'No trustworthy long-term-memory contribution was found.';const stage=path.stages.find(x=>x.id==='RETRIEVAL_QUALITY');return stage?.reason??stage?.summary??'Unavailable';}
function gatherImpact(row){if(row.status==='LATE')return'Completed after Context Seal; not included in this generation.';if(row.status==='STALE')return'Revision fence is stale; excluded from active generation.';if(row.status==='INVALID')return'Structured result failed validation and was not admitted.';return'Not admitted to this generation.';}
function stageState(path,id){return path.stages.find(x=>x.id===id)?.state??'UNAVAILABLE';}
function stageGlyph(state){if(state==='COMPLETE')return'✓';if(state==='ACTIVE')return'●';if(state==='SKIPPED')return'—';if(state==='DEFERRED')return'→';if(state==='STALE')return'◷';if(state==='INVALID'||state==='FAILED')return'!';if(state==='DEGRADED')return'△';return'○';}
function statusToken(v){if(['COMPLETE','ADMITTED','READY'].includes(v))return'ready';if(v==='ACTIVE')return'loading';if(['SKIPPED','DEFERRED','LOW'].includes(v))return'historical';if(['DEGRADED','STALE','LATE','UNRESOLVED','PARTIAL','ABSTAINED'].includes(v))return'warning';if(['INVALID','FAILED','REJECTED'].includes(v))return'error';return'offline';}
function qualityStatus(v){return v==='HIGH'?'ready':v==='MIXED'?'warning':v==='LOW'?'historical':'offline';}
function truthStatus(v){return v==='CURRENT'?'canonical':v==='HISTORICAL'||v==='SUPERSEDED'?'historical':v==='CONTRADICTED'||v==='UNCERTAIN'||v==='UNRESOLVED'?'warning':'observed';}
function jevStatus(v){return v==='DECIDED'?'ready':v==='PARTIAL'||v==='UNRESOLVED'||v==='ABSTAINED'||v==='REQUEST_OPERATOR'||v==='ESCALATE_OWNER'?'warning':v==='STALE'?'warning':v==='INVALID'?'error':'historical';}
function gatherStatus(v){return v==='ADMITTED'?'ready':v==='STALE'||v==='LATE'?'warning':v==='REJECTED'||v==='INVALID'?'error':'observed';}
function dispositionStatus(v){return v==='ADMITTED'?'ready':v==='SKIPPED'?'historical':v==='DEFERRED'?'observed':'offline';}
function state(d,title,message,status='ready'){const r=element(d,'section',{className:'a52-state-message',attrs:{role:'status'},dataset:{status}});r.append(element(d,'strong',{text:title}),element(d,'span',{text:message}));return r;}
function section(d,title){return element(d,'h2',{className:'a52-section-title',text:title});}
function human(v){return String(v??'').replace(/[_:-]+/g,' ').replace(/\b\w/g,m=>m.toUpperCase());}
function number(v){return v==null?'unavailable':new Intl.NumberFormat('en-US').format(Number(v)||0);}

function optimizationRows(measurements){
  if(!measurements||typeof measurements!=='object')return[];
  const fields=[
    ['Avoided jobs',measurements.avoidedJobs??measurements.savedJobs],
    ['Avoided channel calls',measurements.avoidedChannelCalls??measurements.savedChannelCalls],
    ['Channel invocations',measurements.channelInvocations],
    ['Optional-provider calls',measurements.optionalProviderCalls],
    ['Execution resources',measurements.executionResources??measurements.resourceCount],
    ['Elapsed',measurements.elapsedMs==null?null:String(measurements.elapsedMs)+' ms'],
  ];
  return fields.filter(([,value])=>value!=null).map(([key,value])=>({key,value}));
}
function optimizationSummary(measurements){
  const rows=optimizationRows(measurements).filter(x=>x.key==='Avoided jobs'||x.key==='Avoided channel calls'||x.key==='Optional-provider calls');
  return rows.map(x=>x.value+' '+x.key.toLowerCase()).join(' · ');
}
