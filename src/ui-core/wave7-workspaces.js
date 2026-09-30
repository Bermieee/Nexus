import { Signals } from './constants.js';
import { createButton, createKeyValue, element, makeBadge, makeCard, makeHealthPill } from './primitives.js';
import { VirtualListController } from './virtualization.js';
import { ProductDetailLevel } from './wave5-product-model.js';
import { createAuthorityPill, createProductHealthSurface, sourceModeBadge, sourceStateMessage } from './wave6-presentation.js';
import { createForensicBookmark, diffGenerationContext, explainContextSeal, explainContextSection } from './wave7-explainability.js';
import { ForensicMetadataIndex, buildForensicPath, forensicWhy, unresolvedConflictModel } from './wave7-forensics.js';

export function registerWave7Actions(actionRouter,{presentation}={}){
  const releases=[];
  if(!actionRouter.hasSubsystem('wave7-ui'))releases.push(actionRouter.registerSubsystem('wave7-ui',async(action)=>{
    if(action.type==='wave7.selectGeneration'){presentation?.selectGeneration?.({generationId:action.target?.generationId??null,turnId:action.target?.turnId??null});return{kind:'Wave7PresentationSelection',generationId:action.target?.generationId??null,turnId:action.target?.turnId??null};}
    if(action.type==='wave7.why'){
      if(action.target?.section)return explainContextSection(action.target.section);
      if(action.target?.item)return forensicWhy(action.target.item);
      if(action.target?.explanation)return action.target.explanation;
      return{kind:'Wave7Why',available:false,summary:'No owner-published explanation is available.'};
    }
    if(action.type==='wave7.inspect')return action.target?.object??action.target??null;
    if(action.type==='wave7.openWorkspace')return{workspaceId:action.target?.workspaceId??null};
    return null;
  }));
  for(const type of ['wave7.selectGeneration','wave7.why','wave7.inspect','wave7.openWorkspace'])if(!actionRouter.hasAction(type))releases.push(actionRouter.registerAction(type,{subsystem:'wave7-ui'}));
  return()=>{for(const release of releases.reverse())try{release?.();}catch{}};
}

export function registerWave7Inspectors(registry,{forensics,promptPlan}={}){
  const releases=[];
  if(!registry.has('wave7-generation'))releases.push(registry.register('wave7-generation',(object,ctx)=>renderGenerationInspector(object,ctx,forensics,promptPlan)));
  if(!registry.has('wave7-context-section'))releases.push(registry.register('wave7-context-section',(object,ctx)=>renderSectionInspector(object,ctx)));
  if(!registry.has('wave7-forensic-item'))releases.push(registry.register('wave7-forensic-item',(object,ctx)=>renderForensicInspector(object,ctx,forensics)));
  if(!registry.has('wave7-unresolved-conflict'))releases.push(registry.register('wave7-unresolved-conflict',(object,ctx)=>renderConflictInspector(object,ctx)));
  return()=>{for(const release of releases.reverse())try{release?.();}catch{}};
}

export function registerWave7Workspaces(registry,{promptPlan,forensics,presentation,scheduler}={}){
  if(!registry.has('generation-explainability'))registry.register({
    id:'generation-explainability',title:'Why This Generation?',icon:'?',category:'Brain',navigation:{level:'advanced',order:155},
    views:['normal','detail','advanced'],supportedActions:['inspect','why','generation-select'],render(host,ctx){renderGenerationWorkspace(host,{...ctx,promptPlan,forensics,presentation,scheduler});},
  });
  if(registry.has('forensics'))registry.update('forensics',{
    title:'Forensics',icon:'⌁',category:'Brain',navigation:{level:'advanced',order:160},
    views:['normal','detail','advanced'],supportedActions:['inspect','why','filter','generation-select'],render(host,ctx){renderForensicsWorkspace(host,{...ctx,promptPlan,forensics,presentation,scheduler});},
  });
}

export function createWave7BrainLaunchers(doc,{ctx,currentGenerationId=null}={}){
  const card=element(doc,'section',{className:'nexus-card nexus-wave7-launchers',attrs:{'aria-label':'Generation context explanation'}});
  const read=ctx.promptPlan?.read?.(currentGenerationId?{generationId:currentGenerationId}:{})??null,explain=read?.data?.explainability??null;
  card.append(element(doc,'span',{className:'nexus-eyebrow',text:'Generation Context'}),element(doc,'h2',{text:'Why did this generation receive this context?'}));
  if(!explain){
    card.append(element(doc,'p',{className:'nexus-muted',text:'PromptPlan/context readers have not published a completed generation explanation.'}));
    if(read?.source)card.append(sourceStateMessage(doc,read.source));
  }else{
    const budget=contextBudget(explain),counts=explain.sectionCounts??{},head=element(doc,'div',{className:'nexus-inline-status'});
    head.append(sourceModeBadge(doc,read.source),makeHealthPill(doc,{label:`Context · ${read.source.health}`,status:read.source.statusToken,detail:read.source.impact}),makeBadge(doc,explain.generationId??'generation','observed'));
    card.append(head,createKeyValue(doc,[
      {key:'Budget',value:`${number(budget.allocated)} / ${number(budget.total)} tokens · ${number(budget.remaining)} remaining`},
      {key:'Sections',value:`${explain.sections.length} · ${counts.REUSED??0} reused · ${counts.REBUILT??0} rebuilt · ${counts.UPDATED??0} updated`},
      {key:'Omitted',value:`${counts.DROPPED??0} dropped · ${counts.DEFERRED??0} deferred`},
      {key:'Model profile',value:explain.modelProfileId??'unavailable'},
      {key:'Fallback',value:explain.fallbackState??'NONE'},
      {key:'Final packet estimate',value:`${number(explain.usedOrEstimatedTokens)} tokens`},
      {key:'Unresolved evidence',value:String(explain.unresolvedEvidence?.length??0)},
    ]));
  }
  const actions=element(doc,'div',{className:'nexus-inline-status'});
  if(explain)actions.append(createButton(doc,{label:'Inspect context plan',scope:ctx.scope,onPress:()=>ctx.inspect?.({kind:'wave7-generation',id:explain.generationId,title:'Generation Context',generation:explain})}));
  actions.append(createButton(doc,{label:'Why This Generation?',scope:ctx.scope,onPress:()=>openWorkspace(ctx,'generation-explainability')}),createButton(doc,{label:'Forensics',scope:ctx.scope,variant:'quiet',onPress:()=>openWorkspace(ctx,'forensics')}));
  card.append(actions);return card;
}

function renderGenerationWorkspace(host,ctx){
  const d=host.ownerDocument,detail=ctx.productAdapter.getDetailLevel();
  header(host,ctx,'Why This Generation?','What context reached this generation, what changed, what was contained, and which explanation evidence Core actually published.');
  const selection=selectedGeneration(ctx),generationId=selection.generationId;
  const read=ctx.promptPlan.read(generationId?{generationId}:{}),source=read.source;
  host.append(generationSelector(d,ctx,read.data?.generationId??generationId));
  if(!read.data?.explainability){host.append(sourceStateMessage(d,source));return;}
  const explain=read.data.explainability;
  const forensic=explain.generationId?ctx.forensics.readGeneration(explain.generationId,{limit:5000}):null;
  host.append(generationHero(d,explain,source));
  host.append(section(d,'Why?'),whySummary(d,explain,ctx));
  host.append(section(d,'Context plan'),contextSections(d,explain,detail,ctx));
  host.append(section(d,'Context Seal'),sealCard(d,explain,forensic,detail,ctx));
  const previous=ctx.promptPlan.readPrevious(explain);const diff=diffGenerationContext(previous,explain);
  host.append(section(d,'Previous generation comparison'),diffCard(d,diff,ctx));
  if(explain.unresolvedEvidence?.length){host.append(section(d,'Unresolved evidence preserved'));for(const conflict of unresolvedConflictModel(explain.receipt))host.append(conflictCard(d,conflict,ctx));}
  if(detail===ProductDetailLevel.ADVANCED)host.append(advancedGeneration(d,explain,ctx));
}

function renderForensicsWorkspace(host,ctx){
  const d=host.ownerDocument,detail=ctx.productAdapter.getDetailLevel();header(host,ctx,'Cognitive Forensics','Reconstruct meaningful cognitive decisions without flattening Runtime execution into the same timeline.');
  const selection=selectedGeneration(ctx),generationId=selection.generationId??ctx.promptPlan.read().data?.generationId??null;
  host.append(generationSelector(d,ctx,generationId,{compact:true}));
  const read=generationId?ctx.forensics.readGeneration(generationId,{limit:10000}):ctx.forensics.read();
  if(!read.data?.timeline){host.append(sourceStateMessage(d,read.source));return;}
  const timeline=read.data.timeline;host.append(createProductHealthSurface(d,{source:read.source,label:'Forensic reconstruction',compact:true}));
  if(!timeline.complete)host.append(state(d,'Partial reconstruction','Missing stages/references remain explicit; Nexus did not invent replacements.','warning'));
  host.append(forensicPathCard(d,buildForensicPath(timeline),ctx));
  host.append(forensicFilters(d,ctx,timeline));
  const listHost=element(d,'section',{className:'nexus-card nexus-forensic-timeline',attrs:{'aria-label':'Cognitive forensic timeline'}});
  listHost.append(element(d,'h2',{text:`Cognitive timeline · ${timeline.rows.length} recorded/reference items`}));
  const virtualHost=element(d,'div');listHost.append(virtualHost);host.append(listHost);
  const filterIndex=new ForensicMetadataIndex(timeline.rows);const initial=applyFilters(ctx,filterIndex,generationId);
  const controller=new VirtualListController({host:virtualHost,items:initial,itemSize:58,overscan:8,scope:ctx.scope,keyForItem:x=>x.id,renderItem(item){return forensicRow(d,item,ctx);}});controller.mount();
  ctx.scope.add(()=>{});
  bindFilterRefresh(ctx,controller,filterIndex,generationId);
  if(timeline.runtimeWorkRefs.length){
    host.append(section(d,'Related Runtime work'),state(d,'Execution history is separate',`${timeline.runtimeWorkRefs.length} Runtime Work Ledger reference${timeline.runtimeWorkRefs.length===1?'':'s'} available. Open a reference to inspect computational execution without merging it into the cognitive timeline.`));
    const runtimeLinks=element(d,'div',{className:'nexus-inline-status'});for(const ref of timeline.runtimeWorkRefs.slice(0,12))runtimeLinks.append(createButton(d,{label:ref,scope:ctx.scope,size:'sm',variant:'quiet',onPress:()=>inspectRuntimeRef(ctx,ref)}));host.append(runtimeLinks);
  }
  if(timeline.missingStages.length)host.append(section(d,'Stages not recorded for this turn'),list(d,timeline.missingStages.map(x=>`${x} — no recorded stage/reference; not fabricated`)));
  if(detail===ProductDetailLevel.ADVANCED)host.append(advancedForensic(d,read.data,ctx));
}

function generationSelector(d,ctx,currentId,{compact=false}={}){
  const rows=ctx.promptPlan.listGenerations({limit:25}),box=element(d,'section',{className:`nexus-generation-selector${compact?' nexus-generation-selector--compact':''}`,attrs:{'aria-label':'Generation selector'}});
  box.append(element(d,'span',{className:'nexus-eyebrow',text:'Generation'}));
  const actions=element(d,'div',{className:'nexus-inline-status'});
  if(rows.length){
    const currentIndex=Math.max(0,rows.findIndex(x=>x.generationId===currentId));const current=rows[currentIndex]??rows.at(-1),previous=currentIndex>0?rows[currentIndex-1]:rows.length>1?rows.at(-2):null;
    if(current)actions.append(createButton(d,{label:`Current · ${current.generationId}`,scope:ctx.scope,size:'sm',onPress:()=>selectGeneration(ctx,current)}));
    if(previous)actions.append(createButton(d,{label:`Previous · ${previous.generationId}`,scope:ctx.scope,size:'sm',variant:'quiet',onPress:()=>selectGeneration(ctx,previous)}));
    for(const row of rows.slice(-5).reverse())if(row.generationId!==current?.generationId&&row.generationId!==previous?.generationId)actions.append(createButton(d,{label:row.generationId,scope:ctx.scope,size:'sm',variant:'quiet',onPress:()=>selectGeneration(ctx,row)}));
  }else actions.append(makeBadge(d,'Generation reader unavailable','offline'));
  const lookup=element(d,'input',{className:'nexus-search',attrs:{type:'search',placeholder:'Generation ID…','aria-label':'Direct generation lookup'}});
  ctx.scope.listen(lookup,'keydown',(event)=>{if(event.key==='Enter'&&lookup.value?.trim())selectGeneration(ctx,{generationId:lookup.value.trim(),turnId:null});});
  box.append(actions,lookup);return box;
}

function generationHero(d,x,source){
  const card=element(d,'section',{className:'nexus-card nexus-generation-hero'}),head=element(d,'div',{className:'nexus-inline-status'}),budget=contextBudget(x),compiled=x.budgetEvidence?.compiled??{};
  const delivery=x.deliveryEvidence??{};
  head.append(sourceModeBadge(d,source),makeHealthPill(d,{label:`Context · ${source.health}`,status:source.statusToken,detail:source.impact}),makeBadge(d,x.generationId??'generation unavailable','observed'));
  card.append(head,element(d,'h2',{text:x.generationId??'Generation'}),createKeyValue(d,[
    {key:'Available budget',value:`${number(budget.total)} tokens`},
    {key:'Core planned budget',value:`${number(budget.total)} total · ${number(budget.allocated)} allocated · ${number(budget.remaining)} remaining`},
    {key:'Compiled/sealed budget',value:`${number(compiled.total)} total · ${number(compiled.allocated)} compiled · ${number(compiled.remaining)} remaining`},
    {key:'Planned',value:delivery.planned?.state??'NO_EVIDENCE'},{key:'Compiled / sealed',value:delivery.compiled?.state??'NO_EVIDENCE'},{key:'Observed in host request',value:delivery.observed?.state??'NO_EVIDENCE'},
    {key:'Final packet estimate',value:`${number(x.usedOrEstimatedTokens)} tokens`},{key:'Model profile',value:x.modelProfileId??'unavailable'},{key:'Fallback',value:x.fallbackState??'NONE'},
    {key:'Integrity',value:x.integrityState??'unavailable'},{key:'Turn',value:x.turnId??'unavailable'},
  ]));
  return card;
}

function whySummary(d,x,ctx){
  const card=element(d,'section',{className:'nexus-card'}),counts=x.sectionCounts??{};
  card.append(element(d,'p',{text:`${x.sections.length} context section records · ${counts.REUSED??0} reused · ${counts.UPDATED??0} updated · ${counts.REBUILT??0} rebuilt · ${counts.DROPPED??0} dropped · ${counts.DEFERRED??0} deferred.`}));
  if(x.reasons.length){const ul=element(d,'ul',{className:'nexus-why-list'});for(const row of x.reasons.slice(0,8))ul.append(element(d,'li',{text:`${human(row.slot)} — ${row.reason}`}));card.append(ul);}
  if(x.unavailableReasonCount)card.append(state(d,'Some reasons were not published',`${x.unavailableReasonCount} section${x.unavailableReasonCount===1?' has':'s have'} state/revision data but no owner-provided explanation. Nexus will not invent one.`));
  card.append(createButton(d,{label:'Inspect generation',scope:ctx.scope,variant:'inspect',onPress:()=>inspect(ctx,{kind:'wave7-generation',id:x.generationId,title:x.generationId??'Generation',generation:x})}));
  return card;
}

function contextSections(d,x,detail,ctx){
  const root=element(d,'div',{className:'nexus-context-section-grid'});
  for(const [index,section] of x.sections.entries()){
    const explanation=explainContextSection(section),card=element(d,'article',{className:'nexus-context-section-card',dataset:{state:explanation.state},attrs:{'aria-label':`Context section ${index+1}: ${human(explanation.slot)}`}});
    const head=element(d,'div',{className:'nexus-inline-status'});head.append(
      makeBadge(d,`#${index+1}`,'observed'),element(d,'strong',{text:human(explanation.slot)}),
      makeBadge(d,`Planned: ${explanation.plannedState}`,stateToken(explanation.plannedState)),
      makeBadge(d,`Compiled: ${explanation.compiledState}`,stateToken(explanation.compiledState)),
      makeBadge(d,`Host: ${explanation.observedState}`,stateToken(explanation.observedState)),
      makeBadge(d,`${number(explanation.actualTokens??explanation.estimatedTokens)} tokens`,'observed')
    );
    card.append(head,element(d,'p',{text:explanation.impact}));
    if(explanation.reason)card.append(element(d,'p',{className:'nexus-muted',text:explanation.reason}));else card.append(element(d,'p',{className:'nexus-muted',text:'Reason not published by the owning context model.'}));
    if(detail!==ProductDetailLevel.NORMAL)card.append(createKeyValue(d,[{key:'Priority',value:explanation.priority??'unavailable'},{key:'Tokens',value:number(explanation.actualTokens??explanation.estimatedTokens)},{key:'Representation',value:explanation.representation??'unavailable'},{key:'Cache eligible',value:explanation.cacheEligible==null?'unavailable':String(explanation.cacheEligible)}]));
    if(explanation.authority)card.append(createAuthorityPill(d,explanation.authority));
    const actions=element(d,'div',{className:'nexus-inline-status'});actions.append(createButton(d,{label:'Why?',scope:ctx.scope,size:'sm',variant:'quiet',onPress:()=>why(ctx,{section})}),createButton(d,{label:'Inspect',scope:ctx.scope,size:'sm',variant:'inspect',onPress:()=>inspectThroughRouter(ctx,{kind:'wave7-context-section',id:`${x.generationId}:${section.slot}`,title:human(section.slot),section,generationId:x.generationId})}));card.append(actions);root.append(card);
  }
  return root;
}

function sealCard(d,x,forensic,detail,ctx){
  const seal=x.seal?{...x.seal,lateResultIds:forensic?.data?.forensic?.lateResultRefs??x.seal.lateResultIds??[]}:null,expl=explainContextSeal(seal);
  const card=element(d,'section',{className:'nexus-card nexus-seal-explainer'});
  if(!expl.available){card.append(state(d,'Context Seal unavailable',expl.impact,'offline'));return card;}
  card.append(element(d,'div',{className:'nexus-inline-status'},makeBadge(d,'SEALED','canonical'),makeBadge(d,expl.fallbackState??'NONE',expl.fallbackState&&expl.fallbackState!=='NONE'?'warning':'ready')),element(d,'p',{text:expl.summary}));
  card.append(createKeyValue(d,[{key:'Accepted',value:expl.accepted},{key:'Rejected',value:expl.rejected},{key:'Stale',value:expl.stale},{key:'Late',value:expl.late}]));
  if(detail!==ProductDetailLevel.NORMAL)card.append(createKeyValue(d,[{key:'Seal',value:expl.sealId},{key:'Turn',value:expl.turnId},{key:'World / Scene revision',value:`${expl.revisionFences.worldRevision??'—'} / ${expl.revisionFences.sceneRevision??'—'}`},{key:'Source revisions',value:expl.revisionFences.sourceRevisionRefs.join(', ')||'none'}]));
  if(detail===ProductDetailLevel.ADVANCED)card.append(createButton(d,{label:'Inspect seal',scope:ctx.scope,variant:'inspect',onPress:()=>inspectThroughRouter(ctx,{kind:'wave7-generation',id:expl.sealId,title:'Context Seal',payload:seal})}));
  return card;
}

function diffCard(d,diff,ctx){
  const card=element(d,'section',{className:'nexus-card'});if(!diff.available){card.append(state(d,'Comparison unavailable',diff.reason,'offline'));return card;}
  card.append(element(d,'h3',{text:`${diff.fromGenerationId??'Previous'} → ${diff.toGenerationId??'Current'}`}));
  for(const key of ['UNCHANGED','UPDATED','REBUILT','ADDED','REMOVED','DROPPED','DEFERRED','UNKNOWN']){
    const rows=diff.groups[key]??[];if(!rows.length)continue;const group=element(d,'div',{className:'nexus-diff-group',dataset:{state:key}});group.append(element(d,'strong',{text:key}),list(d,rows.map(x=>`${human(x.slot)}${x.reason?` — ${x.reason}`:''}`)));card.append(group);
  }
  if(diff.insufficient)card.append(state(d,'Some semantic comparison is unavailable','The read models did not publish enough reuse/change evidence to classify every shared section.','warning'));
  return card;
}

function conflictCard(d,conflict,ctx){
  const card=element(d,'article',{className:'nexus-card nexus-unresolved-card'});card.append(element(d,'div',{className:'nexus-inline-status'},makeBadge(d,'UNRESOLVED','warning'),createAuthorityPill(d,conflict.authority)),element(d,'h3',{text:`${conflict.subjectId??'Unknown subject'} · ${conflict.predicate??'unknown claim'}`}),element(d,'p',{text:'Nexus preserved disagreement; no winning alternative is implied.'}));
  if(conflict.alternatives.length)card.append(list(d,conflict.alternatives.map(x=>typeof x==='string'?x:JSON.stringify(x))));else card.append(element(d,'p',{className:'nexus-muted',text:'Competing alternatives were not expanded in the available read model.'}));
  card.append(createButton(d,{label:'Inspect evidence',scope:ctx.scope,variant:'inspect',onPress:()=>inspectThroughRouter(ctx,{kind:'wave7-unresolved-conflict',id:conflict.id,title:'Unresolved evidence',conflict})}));return card;
}

function forensicFilters(d,ctx,timeline){
  const box=element(d,'section',{className:'nexus-forensic-filters',attrs:{'aria-label':'Forensic filters'}}),search=element(d,'input',{className:'nexus-search',attrs:{type:'search',placeholder:'Search event, source, claim, task…','aria-label':'Search forensic timeline'}});
  search.value=ctx.presentation.get().filters.search??'';search.dataset.wave7Filter='search';box.append(search);
  const filters=element(d,'div',{className:'nexus-inline-status'});
  for(const [label,key,values] of [['Status','status',['ALL','STALE','LATE','REJECTED','UNRESOLVED','ACCEPTED']],['Authority','authority',['ALL','SOURCE_CANON','OBSERVED','SETTLED','INFERRED','UNRESOLVED','HISTORICAL']],['Stage','stage',['ALL','SOURCE','COGNITION','TRUTH','PROPOSAL','SETTLEMENT','GATHER','CONTEXT']]]){
    const select=element(d,'select',{attrs:{'aria-label':`${label} filter`},dataset:{wave7Filter:key}});for(const value of values){const option=element(d,'option',{text:value,attrs:{value:value==='ALL'?'':value}});select.append(option);}select.value=ctx.presentation.get().filters[key]??'';filters.append(select);
  }
  box.append(filters,element(d,'span',{className:'nexus-muted',text:`${timeline.rows.length} indexed timeline items`}));return box;
}

function bindFilterRefresh(ctx,controller,index,generationId){
  const root=controller.host.parentNode??controller.host;const controls=root?.parentNode?.querySelectorAll?.('[data-wave7-filter]')??[];
  const schedule=()=>ctx.scheduler.invalidate(`wave7:forensic-filter:${generationId??'none'}`,()=>{
    const filters={...ctx.presentation.get().filters,generationId};for(const node of controls){const key=node.dataset.wave7Filter;filters[key]=node.value??'';}ctx.presentation.setFilters(filters);controller.setItems(applyFilters(ctx,index,generationId));
  },{cost:'NORMAL'});
  for(const node of controls)ctx.scope.listen(node,node.tagName==='SELECT'?'change':'input',schedule);
}

function applyFilters(ctx,index,generationId){return index.query({...ctx.presentation.get().filters,generationId});}

function forensicRow(d,item,ctx){
  const button=element(d,'button',{className:'nexus-forensic-row',attrs:{type:'button','aria-label':`${item.eventType}: ${item.impact}`},dataset:{status:item.status,stage:item.stage}});
  const main=element(d,'span',{className:'nexus-forensic-row__main'});main.append(element(d,'strong',{text:human(item.eventType)}),element(d,'span',{className:'nexus-muted',text:item.impact}));
  const badges=element(d,'span',{className:'nexus-forensic-row__badges'});badges.append(makeBadge(d,item.stage,'observed'),makeBadge(d,item.status,statusToken(item.status)),createAuthorityPill(d,item.authority?.authority??'UNRESOLVED'));
  button.append(main,badges);ctx.scope.listen(button,'click',()=>inspectThroughRouter(ctx,{kind:'wave7-forensic-item',id:item.id,title:human(item.eventType),item}));return button;
}

function advancedGeneration(d,x,ctx){
  const card=element(d,'section',{className:'nexus-card'});card.append(element(d,'h3',{text:'Advanced generation identity'}),createKeyValue(d,[{key:'PromptPlan',value:x.promptPlanId},{key:'Context Seal',value:x.contextSealId??'unavailable'},{key:'Model profile',value:x.modelProfileId??'unavailable'},{key:'World revision',value:x.worldRevision??'unavailable'},{key:'Scene revision',value:x.sceneRevision??'unavailable'},{key:'Source revisions',value:x.sourceRevisionRefs.join(', ')||'none'}]));return card;
}
function advancedForensic(d,data,ctx){
  const card=element(d,'section',{className:'nexus-card'});card.append(element(d,'h3',{text:'Advanced reconstruction'}),createKeyValue(d,[{key:'Bundle',value:data.forensic.bundleId},{key:'World / Scene revision',value:`${data.forensic.worldRevision??'—'} / ${data.forensic.sceneRevision??'—'}`},{key:'Transactions',value:data.transactions.length},{key:'Diagnostic refs',value:data.forensic.diagnosticRefs.join(', ')||'none'}]));return card;
}

function renderGenerationInspector(object,{document:d,scope,services},forensics,promptPlan){
  const root=element(d,'div',{className:'nexus-stack'}),x=object.generation??object.payload??{},level=services?.productAdapter?.getDetailLevel?.()??ProductDetailLevel.NORMAL,budget=contextBudget(x),counts=x.sectionCounts??{};
  root.append(element(d,'h2',{text:object.title??'Generation Context'}),element(d,'p',{className:'nexus-muted',text:'Read-only explanation of the generation packet. Authority comes from owning subsystem receipts, not UI confidence.'}),createKeyValue(d,[
    {key:'Generation',value:x.generationId??'—'},{key:'Model profile',value:x.modelProfileId??'—'},{key:'Core planned budget',value:`${number(budget.allocated)} / ${number(budget.total)} · ${number(budget.remaining)} remaining`},
    {key:'Planned / compiled / observed',value:`${x.deliveryEvidence?.planned?.state??'NO_EVIDENCE'} / ${x.deliveryEvidence?.compiled?.state??'NO_EVIDENCE'} / ${x.deliveryEvidence?.observed?.state??'NO_EVIDENCE'}`},
    {key:'Final packet estimate',value:`${number(x.usedOrEstimatedTokens)} tokens`},{key:'Reuse / rebuild',value:`${counts.REUSED??0} reused · ${counts.REBUILT??0} rebuilt · ${counts.UPDATED??0} updated`},{key:'Fallback',value:x.fallbackState??'NONE'},
  ]));
  if(x.sections?.length){root.append(element(d,'h3',{text:'Ordered context sections'}));for(const [index,section] of x.sections.entries()){const row=element(d,'div',{className:'nexus-inspector-trace-row'});row.append(makeBadge(d,`#${index+1}`,'observed'),element(d,'span',{text:`${human(section.slot)} · ${number(section.actualTokens??section.estimatedTokens)} tokens`}),makeBadge(d,`Plan ${section.plannedState??'NO_EVIDENCE'}`,stateToken(section.plannedState)),makeBadge(d,`Compiled ${section.compiledState??'NO_EVIDENCE'}`,stateToken(section.compiledState)),makeBadge(d,`Host ${section.observedState??'NO_EVIDENCE'}`,stateToken(section.observedState)));if(section.authority)row.append(createAuthorityPill(d,section.authority));root.append(row);}}
  if(level!==ProductDetailLevel.NORMAL){
    root.append(element(d,'h3',{text:'Evidence and revision fences'}),createKeyValue(d,[{key:'World / Scene',value:`${x.worldRevision??'—'} / ${x.sceneRevision??'—'}`},{key:'Source revisions',value:(x.sourceRevisionRefs??[]).join(', ')||'none'},{key:'PromptPlan',value:x.promptPlanId??'—'},{key:'Context Seal',value:x.contextSealId??'—'}]));
    for(const conflict of unresolvedConflictModel(x.receipt)){const row=element(d,'div',{className:'nexus-inspector-trace-row'});row.append(createAuthorityPill(d,conflict.authority),element(d,'span',{text:`${conflict.subjectId??'Evidence'} · ${conflict.predicate??'unresolved'}`}));root.append(row);}
    const forensic=x.generationId?forensics?.readGeneration?.(x.generationId,{limit:256}):null,path=forensic?.data?.timeline?buildForensicPath(forensic.data.timeline):null;
    if(path){root.append(element(d,'h3',{text:'Decision trail'}));for(const step of path.steps){const row=element(d,'div',{className:'nexus-inspector-trace-row'});row.append(makeBadge(d,step.status,statusToken(step.status)),element(d,'span',{text:`${step.label} — ${step.impact}`}));if(step.status!=='MISSING')row.append(createAuthorityPill(d,step.authority?.authority??step.authority));root.append(row);}if(path.lateAfterSeal.length)root.append(state(d,'Late work stayed outside the sealed generation',`${path.lateAfterSeal.length} late result${path.lateAfterSeal.length===1?' is':'s are'} recorded after the Context Seal and did not rewrite it.`,'warning'));}
  }
  if(level===ProductDetailLevel.ADVANCED){root.append(element(d,'h3',{text:'Advanced read-only payload'}),element(d,'pre',{className:'nexus-context-packet',text:JSON.stringify(x,null,2)}));}
  return root;
}
function renderSectionInspector(object,{document:d,services}){
  const x=explainContextSection(object.section),root=element(d,'div',{className:'nexus-stack'}),level=services?.productAdapter?.getDetailLevel?.()??ProductDetailLevel.NORMAL;root.append(element(d,'h2',{text:object.title??human(x.slot)}),element(d,'div',{className:'nexus-inline-status'},makeBadge(d,`Planned ${x.plannedState}`,stateToken(x.plannedState)),makeBadge(d,`Compiled ${x.compiledState}`,stateToken(x.compiledState)),makeBadge(d,`Host ${x.observedState}`,stateToken(x.observedState))),element(d,'p',{text:x.impact}),element(d,'p',{className:'nexus-muted',text:x.reason??'Reason not published by owning backend.'}),createKeyValue(d,[{key:'Tokens',value:number(x.actualTokens??x.estimatedTokens)},{key:'Priority',value:x.priority??'—'},{key:'Reuse',value:x.reuseState??'—'},{key:'Cache eligible',value:x.cacheEligible==null?'—':String(x.cacheEligible)},{key:'Representation',value:x.representation??'—'}]));if(x.authority)root.append(createAuthorityPill(d,x.authority));if(level!==ProductDetailLevel.NORMAL)root.append(createKeyValue(d,[{key:'Source subsystem',value:x.sourceSubsystem??'unavailable'},{key:'Revision identity',value:x.revisionIdentity?JSON.stringify(x.revisionIdentity):'unavailable'},{key:'Compiled receipt',value:x.evidence?.compiled?.receiptRef??'NO_EVIDENCE'},{key:'Host receipt',value:x.evidence?.observed?.receiptRef??'NO_EVIDENCE'}]));return root;
}
function renderForensicInspector(object,{document:d,scope,services},forensics){
  const item=object.item??{},whyModel=forensicWhy(item),root=element(d,'div',{className:'nexus-stack'}),level=services?.productAdapter?.getDetailLevel?.()??ProductDetailLevel.NORMAL;root.append(element(d,'h2',{text:object.title??human(item.eventType)}),makeBadge(d,item.status??'RECORDED',statusToken(item.status)),createAuthorityPill(d,item.authority?.authority??'UNRESOLVED'),element(d,'p',{text:whyModel.summary}),createKeyValue(d,[{key:'Subsystem',value:item.subsystem??'—'},{key:'Reason',value:item.reasonCode??'not published'},{key:'Revision',value:`${item.beforeRevision??'—'} → ${item.afterRevision??'—'}`},{key:'Correlation',value:item.correlationId??'—'},{key:'Task',value:item.taskId??'—'}]));
  if(item.rawPayloadAvailable&&forensics&&level===ProductDetailLevel.ADVANCED){const out=element(d,'div',{className:'nexus-lazy-detail'}),button=createButton(d,{label:'Load raw diagnostic detail',scope,variant:'quiet',onPress:async()=>{button.disabled=true;try{const payload=await forensics.loadDetail(item.id);out.replaceChildren(payload==null?state(d,'Detail unavailable','The owning producer did not return a retained payload.','offline'):element(d,'pre',{className:'nexus-context-packet',text:JSON.stringify(payload,null,2)}));}catch(error){out.replaceChildren(state(d,'Detail failed',String(error?.message??error),'warning'));}}});root.append(button,out);}else if(item.rawPayloadAvailable)root.append(element(d,'p',{className:'nexus-muted',text:'Raw diagnostic detail is available in Advanced view only.'}));
  return root;
}
function forensicPathCard(d,path,ctx){
  const card=element(d,'section',{className:'nexus-card nexus-forensic-path',attrs:{'aria-label':'Generation cognitive path'}});card.append(element(d,'h2',{text:'Generation path'}),element(d,'p',{className:'nexus-muted',text:'Recorded semantic steps only. Missing steps stay missing; Runtime work remains a separate cross-link.'}));
  const steps=element(d,'div',{className:'nexus-forensic-path__steps',attrs:{role:'list'}});
  for(const step of path.steps){const node=element(d,'article',{className:'nexus-forensic-path__step',attrs:{role:'listitem','aria-label':`${step.label}: ${step.status}`},dataset:{status:step.status}}),head=element(d,'div',{className:'nexus-inline-status'});head.append(makeBadge(d,step.status,statusToken(step.status)),element(d,'strong',{text:step.label}));if(step.status!=='MISSING')head.append(createAuthorityPill(d,step.authority?.authority??step.authority));node.append(head,element(d,'p',{className:'nexus-muted',text:step.impact}));steps.append(node);}card.append(steps);
  if(path.lateAfterSeal.length)card.append(state(d,'Late result contained',`${path.lateAfterSeal.length} late result${path.lateAfterSeal.length===1?' is':'s are'} visible in history but did not alter the sealed generation.`,'warning'));
  return card;
}
function contextBudget(x){const evidence=x?.budgetEvidence?.planned;if(evidence)return evidence;const budget=x?.budget??{},allocated=finiteOrNull(budget.allocated??budget.usedTokens??x?.plannedTokens),total=finiteOrNull(budget.total??budget.available??budget.contextWindow),explicit=finiteOrNull(budget.remaining),remaining=explicit??(total!=null&&allocated!=null?Math.max(0,total-allocated):null);return{allocated,total,remaining};}
function finiteOrNull(value){if(value==null||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;}

function renderConflictInspector(object,{document:d}){
  const x=object.conflict??{},root=element(d,'div',{className:'nexus-stack'});root.append(element(d,'h2',{text:'Unresolved conflict'}),makeBadge(d,'UNRESOLVED','warning'),createAuthorityPill(d,x.authority??'UNRESOLVED'),element(d,'p',{text:'Competing evidence remains preserved. The UI does not choose a winner.'}),createKeyValue(d,[{key:'Subject',value:x.subjectId??'—'},{key:'Predicate',value:x.predicate??'—'},{key:'Provenance',value:(x.provenanceRefs??[]).join(', ')||'—'}]));return root;
}

async function selectGeneration(ctx,row){const result=await ctx.actionRouter.route({type:'wave7.selectGeneration',target:row});if(result.ok)ctx.refresh?.();}
async function openWorkspace(ctx,id){const result=await ctx.actionRouter.route({type:'wave7.openWorkspace',target:{workspaceId:id}});if(result.ok&&result.result?.workspaceId)ctx.navigate?.(result.result.workspaceId);}
async function why(ctx,target){const result=await ctx.actionRouter.route({type:'wave7.why',target});if(result.ok)ctx.inspect?.({kind:'wave7-generation',id:`why:${target.section?.slot??target.item?.id??'selection'}`,title:'Why?',generation:result.result});}
async function inspectThroughRouter(ctx,object){const result=await ctx.actionRouter.route({type:'wave7.inspect',target:{object}});if(result.ok)ctx.inspect?.(result.result);}
async function inspectRuntimeRef(ctx,ref){const object=ctx.forensics.getRuntimeWork(ref);await inspectThroughRouter(ctx,{kind:'wave7-generation',id:ref,title:`Runtime work ${ref}`,payload:object??{reference:ref,status:'UNAVAILABLE'}});}
function selectedGeneration(ctx){return ctx.presentation.get().bookmark??createForensicBookmark();}
function header(host,ctx,title,subtitle){const d=host.ownerDocument,h=element(d,'div',{className:'nexus-product-header'}),t=element(d,'div');t.append(element(d,'h1',{text:title}),element(d,'p',{className:'nexus-muted',text:subtitle}));const controls=element(d,'div',{className:'nexus-detail-control',attrs:{role:'group','aria-label':'Detail level'}});for(const level of Object.values(ProductDetailLevel)){const b=createButton(d,{label:human(level),scope:ctx.scope,size:'sm',variant:'quiet',onPress:()=>{ctx.productAdapter.setDetailLevel(level);ctx.refresh?.();}});b.setAttribute('aria-pressed',String(ctx.productAdapter.getDetailLevel()===level));if(ctx.productAdapter.getDetailLevel()===level)b.classList.add('is-selected');controls.append(b);}h.append(t,controls);host.append(h);}
function state(d,title,message,status='ready'){const r=element(d,'section',{className:'nexus-state-message',attrs:{role:'status'},dataset:{status}});r.append(element(d,'strong',{text:title}),element(d,'span',{text:message}));return r;}
function section(d,title){return element(d,'h2',{className:'nexus-section-title',text:title});}
function list(d,items=[]){const ul=element(d,'ul');for(const item of items)ul.append(element(d,'li',{text:String(item)}));return ul;}
function human(v){return String(v??'').toLowerCase().replace(/(^|_)([a-z])/g,(_,sp,l)=>`${sp?' ':''}${l.toUpperCase()}`);}
function number(v){return v==null?'unavailable':new Intl.NumberFormat('en-US').format(Number(v)||0);}
function stateToken(v){if(v==='REUSED'||v==='INCLUDED')return'ready';if(v==='UPDATED'||v==='REBUILT'||v==='NEW')return'loading';if(v==='DEFERRED'||v==='DROPPED'||v==='INVALIDATED')return'warning';return'offline';}
function statusToken(v){if(['ACCEPTED','RECORDED','REFERENCE'].includes(v))return'ready';if(['STALE','LATE','UNRESOLVED'].includes(v))return'warning';if(v==='REJECTED')return'error';if(v==='MISSING')return'offline';if(v==='SKIPPED')return'historical';return'observed';}
