import { Signals } from './constants.js';
import { ResourceScope } from './lifecycle.js';
import { createButton, createKeyValue, element, makeBadge, makeCard, makeHealthPill } from './primitives.js';
import { VirtualListController } from './virtualization.js';
import { ProductDetailLevel } from './wave5-product-model.js';
import { createKnowledgeActionBar } from './provenance-ui.js';
import { ProductDataMode, Wave6Health, authorityDescriptor } from './wave6-contracts.js';
import { FrontFaceMode, FrontFaceDensity, WorkspaceComposition, createAuthorityPill, createComposition, createProductHealthSurface, sourceModeBadge, sourceStateMessage } from './wave6-presentation.js';
import { createWave7BrainLaunchers } from './wave7-workspaces.js';
import { renderLiveBrainCognition } from './wave8-workspace.js';

const PRODUCT=[
  ['home','Home','⌂',0,renderHome],['story','Story / Scene','◫',10,renderScene],['characters','Characters','◎',20,renderGeneric('Characters','characters')],
  ['lore','Lore','▤',30,renderGeneric('Lore','lore')],['memory-product','Memory','◉',40,renderGeneric('Memory','memory')],
  ['world-product','World','◇',50,renderGeneric('World','world')],['brain','Brain','◈',60,renderBrain],
];

export function registerWave6FrontFaceWorkspaces(registry,{adapter,brainPulse=null}={}){
  if(!registry||!adapter)throw new TypeError('Wave 6 Front Face requires WorkspaceRegistry and Wave6ProductAdapter');
  for(const [id,title,icon,order,renderer] of PRODUCT){
    if(registry.has(id))continue;
    registry.register({id,title,icon,category:'Product',navigation:{level:'product',order},views:['normal','detail','advanced'],supportedActions:['inspect','navigate','detail-level'],render(host,ctx){renderer(host,{...ctx,adapter,brainPulse,workspaceRegistry:registry});}});
  }
  if(!registry.has('forensics'))registry.register({id:'forensics',title:'Forensics',icon:'⌁',category:'Engineering',navigation:{level:'advanced',order:190},views:['advanced'],supportedActions:['inspect'],render(host,ctx){renderForensics(host,{...ctx,adapter,brainPulse,workspaceRegistry:registry});}});
}

export class HostAdjacentFrontFaceController{
  constructor({host,shell,adapter,presentation,scheduler,signals,brainPulse=null,hostMountAdapter=null,productName='Nexus',collapsedReservationWidth=76}={}){
    if(!host||!shell||!adapter||!presentation||!scheduler||!signals)throw new TypeError('HostAdjacentFrontFaceController missing required UI.Core service');
    this.host=host;this.shell=shell;this.adapter=adapter;this.presentation=presentation;this.scheduler=scheduler;this.signals=signals;this.brainPulse=brainPulse;this.hostMountAdapter=hostMountAdapter;this.productName=productName;this.collapsedReservationWidth=Math.max(0,Number(collapsedReservationWidth)||0);
    this.scope=new ResourceScope();this.quickScope=new ResourceScope();this.nodes={};this.mounted=false;
  }
  mount(){
    if(this.mounted)return this;this.mounted=true;const d=this.host.ownerDocument;
    const root=element(d,'section',{className:'nexus-front-face',attrs:{'aria-label':`${this.productName} cognitive interface`}});
    const quick=element(d,'aside',{className:'nexus-quick-dash',attrs:{'aria-label':`${this.productName} Quick Dash`}});
    const expanded=element(d,'section',{className:'nexus-front-face__expanded'});
    const shellRoot=element(d,'div',{className:'nexus-front-face__shell'});
    expanded.append(shellRoot);root.append(quick,expanded);this.host.replaceChildren(root);this.nodes={root,quick,expanded,shellRoot};
    this.shell.root=shellRoot;this.shell.mount();
    this.scope.add(this.presentation.subscribe(()=>{this.#applyPresentation();this.scheduleQuickDash();}));
    this.scope.subscribe(this.signals,Signals.UI_WORKSPACE_CHANGED,({payload})=>this.presentation.setWorkspace(payload.workspaceId));
    this.scope.subscribe(this.signals,'*',()=>this.scheduleQuickDash());
    this.brainPulse?.mount?.();
    this.#applyPresentation();
    const state=this.presentation.get();if(this.shell.workspaceRegistry.has(state.lastProductWorkspace)&&this.shell.currentWorkspace!==state.lastProductWorkspace)this.shell.selectWorkspace(state.lastProductWorkspace);
    this.scheduler.cancel('wave6:quick-dash');this.renderQuickDash();return this;
  }
  scheduleQuickDash(){this.scheduler.invalidate('wave6:quick-dash',()=>this.renderQuickDash(),{cost:'CHEAP'});}
  renderQuickDash(){
    if(!this.nodes.quick)return;this.quickScope.cleanup();this.quickScope=new ResourceScope();const d=this.nodes.quick.ownerDocument,s=this.adapter.getSnapshot(),p=this.presentation.get(),pulse=this.brainPulse?.getSnapshot?.()??null;
    const health=s.brain?.overall??Wave6Health.UNAVAILABLE,scene=s.scene,attention=s.wave6?.attention??[];
    const brand=element(d,'div',{className:'nexus-quick-dash__brand'});brand.append(element(d,'strong',{text:this.productName}),sourceModeBadge(d,overallSource(s)));
    const brain=makeHealthPill(d,{label:`Brain · ${human(health)}`,status:healthToken(health),detail:pulse?.currentFocus??''});
    const sceneNode=element(d,'div',{className:'nexus-quick-dash__scene'});sceneNode.append(element(d,'span',{className:'nexus-eyebrow',text:'Current Scene'}),element(d,'strong',{text:scene?.title??'Not connected'}));if(scene?.narrativeTime)sceneNode.append(element(d,'span',{className:'nexus-muted',text:scene.narrativeTime}));
    const attentionNode=element(d,'div',{className:'nexus-quick-dash__attention'});attentionNode.append(makeBadge(d,`Attention ${attention.length}`,attention.length?'warning':'ready'));
    const activity=element(d,'div',{className:'nexus-quick-dash__activity',text:pulse?.activity?.[0]?.meaning??(pulse?.currentFocus??'Brain ready')});
    const button=createButton(d,{label:p.frontFaceMode===FrontFaceMode.COLLAPSED?'Expand':'Collapse',scope:this.quickScope,onPress:()=>this.presentation.toggle()});
    this.nodes.quick.replaceChildren(brand,brain,sceneNode,attentionNode,activity,button);
  }
  #applyPresentation(){
    const p=this.presentation.get(),expanded=p.frontFaceMode===FrontFaceMode.EXPANDED;
    this.nodes.root.dataset.presentation=p.frontFaceMode;this.nodes.root.dataset.density=p.frontFaceDensity;
    this.nodes.root.style.width=`${expanded?p.frontFaceWidth:76}px`;
    this.nodes.quick.style.display='';this.nodes.expanded.style.display=expanded?'':'none';
    this.nodes.shellRoot.classList.toggle('nexus-density-compact',p.frontFaceDensity===FrontFaceDensity.COMPACT);
    this.hostMountAdapter?.apply?.({mode:p.frontFaceMode,width:p.frontFaceWidth,collapsedWidth:this.collapsedReservationWidth});
  }
  destroy(){
    if(!this.mounted)return;this.mounted=false;this.brainPulse?.destroy?.();this.quickScope.cleanup();this.scope.cleanup();this.shell.destroy();this.hostMountAdapter?.destroy?.();this.host.replaceChildren();this.nodes={};
  }
}

function renderHome(host,ctx){
  const d=host.ownerDocument,s=ctx.adapter.getSnapshot(),level=ctx.adapter.getDetailLevel();header(host,ctx,'Nexus','Cognitive state beside the host chat — impact first, machinery on demand.');
  const primary=element(d,'section',{className:'nexus-card nexus-wave6-home-primary'});
  primary.append(element(d,'span',{className:'nexus-eyebrow',text:'Current story / scene'}),element(d,'h2',{text:s.story?.title??s.scene?.title??'Host conversation'}),element(d,'p',{className:'nexus-muted',text:s.scene?s.scene.title:'Scene Intelligence is not connected.'}),makeHealthPill(d,{label:`Brain · ${human(s.brain.overall)}`,status:healthToken(s.brain.overall),detail:ctx.brainPulse?.getSnapshot?.().currentFocus??''}));
  const operatorStatus=ctx.operations?.read?.()??null;
  const secondary=['scene','runtime','coprocessor','promptPlan'].map(key=>{
    const source=s.wave6.sources[key],target=operatorStatus?.inspections?.[key]??sourceInspection(key,source,ctx.liveReceiptBinding?.selection?.()??{});
    return sourceCard(d,source,()=>inspect(ctx,target));
  });
  const attention=renderAttention(d,s.wave6.attention,ctx);
  const activity=renderActivity(d,ctx.brainPulse?.getSnapshot?.().activity??[]);
  host.append(createComposition(d,{type:WorkspaceComposition.COMPACT,primary,secondary,attention,activity}));
  if(level!==ProductDetailLevel.NORMAL){host.append(section(d,'Product availability'),renderAvailability(d,s.wave6.sources));}
  if(level===ProductDetailLevel.ADVANCED){host.append(section(d,'Context delivery'),renderPromptPlan(d,s.promptPlan,s.wave6.sources.promptPlan,level,ctx));}
}

function renderScene(host,ctx){
  const d=host.ownerDocument,s=ctx.adapter.getSnapshot(),source=s.wave6.sources.scene,level=ctx.adapter.getDetailLevel();header(host,ctx,'Current Scene','Scene Intelligence read model; inference stays visibly non-canonical.');
  if(!s.scene){host.append(sourceStateMessage(d,source));return;}
  const x=s.scene,card=element(d,'section',{className:'nexus-card nexus-wave6-scene'});
  card.append(element(d,'div',{className:'nexus-inline-status'},sourceModeBadge(d,source),makeBadge(d,`r${x.revision}`,'observed')),element(d,'h2',{text:x.title}),kv(d,'Narrative time',x.narrativeTime),kv(d,'Present',x.cast.filter(y=>y.state==='PRESENT').map(y=>y.name).join(' · ')||'No confirmed cast'),kv(d,'Objects',x.objects.filter(y=>y.state!=='MENTIONED_ONLY').map(y=>y.name).join(' · ')||'None confirmed'),kv(d,'Active threads',x.activeThreads.join(' · ')||'None'));
  if(x.atmosphere){const row=kv(d,'Atmosphere',x.atmosphere.label);row.append(createAuthorityPill(d,x.atmosphere.authority));card.append(row);}
  host.append(card);
  if(x.uncertainFields?.length)host.append(state(d,'Unresolved Scene fields',x.uncertainFields.join(' · '),'warning'));
  if(level!==ProductDetailLevel.NORMAL){host.append(section(d,'Scene continuity'),createKeyValue(d,[{key:'Boundary',value:x.boundary?.state??'STABLE'},{key:'Prior relationship',value:x.relationshipToPrior??'—'},{key:'Prefetch',value:`${x.prefetchState?.count??0} active recommendations`},{key:'Latest change',value:x.latestDeltaSummary?.changedFields?.join(', ')??'—'}]));}
  if(level===ProductDetailLevel.ADVANCED){host.append(createButton(d,{label:'Why / evidence',scope:ctx.scope,onPress:()=>inspect(ctx,{kind:'scene-read-model',id:x.id,title:x.title,scene:x,diagnosticRefs:x.diagnosticRefs,provenanceRefs:x.provenanceRefs})}));if(ctx.actionRouter)host.append(createKnowledgeActionBar(d,{ref:{id:x.id,kind:'scene',state:x.lifecycle},actionRouter:ctx.actionRouter,scope:ctx.scope}));}
}

function renderGeneric(title,key){
  return function(host,ctx){
    const d=host.ownerDocument,s=ctx.adapter.getSnapshot(),source=s.wave6.sources[key],data=s[key],level=ctx.adapter.getDetailLevel();header(host,ctx,title,`${title} product surface uses live read models only when a producer is connected.`);
    if(!data){host.append(sourceStateMessage(d,source));return;}
    host.append(createProductHealthSurface(d,{source,label:title}));
    const body=element(d,'section',{className:'nexus-card'});body.append(element(d,'h2',{text:`${title} summary`}),renderObjectSummary(d,data));host.append(body);
    if(level===ProductDetailLevel.ADVANCED)host.append(createButton(d,{label:`Inspect ${title} read model`,scope:ctx.scope,onPress:()=>inspect(ctx,{kind:'wave6-read-model',id:key,title,payload:data,source})}));
  };
}

function renderBrain(host,ctx){
  const d=host.ownerDocument,s=ctx.adapter.getSnapshot(),level=ctx.adapter.getDetailLevel(),pulse=ctx.brainPulse?.getSnapshot?.()??fallbackPulse(s);
  header(host,ctx,'Brain','What useful cognition is happening now; engineering machinery stays behind Advanced.');
  const hero=element(d,'section',{className:'nexus-card nexus-brain-pulse',attrs:{'aria-label':`Brain Pulse ${pulse.overall}`}});
  const pulseHead=element(d,'div',{className:'nexus-brain-pulse__head'});pulseHead.append(makeHealthPill(d,{label:`Brain · ${human(pulse.overall)}`,status:healthToken(pulse.overall),detail:pulse.currentFocus}),sourceModeBadge(d,overallSource(s)));const lanes=element(d,'div',{className:'nexus-brain-pulse__lanes'});lanes.append(pulseLane(d,'Foreground',pulse.foreground),pulseLane(d,'Background',pulse.background));hero.append(pulseHead,element(d,'h2',{text:pulse.currentFocus}),lanes);
  host.append(hero);
  if(ctx.cognition)renderLiveBrainCognition(host,ctx);
  if(ctx.promptPlan&&ctx.forensics&&ctx.presentation)host.append(createWave7BrainLaunchers(d,{ctx,currentGenerationId:s.promptPlan?.generationId??null}));
  if(pulse.activity.length){host.append(section(d,'Meaningful activity'),renderActivity(d,pulse.activity));}
  if(pulse.attention.length)host.append(section(d,'Needs attention'),renderActivity(d,pulse.attention));
  host.append(section(d,'Context Delivery'),renderPromptPlan(d,s.promptPlan,s.wave6.sources.promptPlan,level,ctx));
  if(level!==ProductDetailLevel.NORMAL){
    const detail=element(d,'div',{className:'nexus-product-grid'});detail.append(metric(d,'HOT',String(pulse.hotCount),'Foreground-required cognition'),metric(d,'DEEP',String(pulse.deepCount),'Background / deeper cognition'),metric(d,'Warm context',`${pulse.warm?.hit??0} hits`,`${pulse.warm?.miss??0} misses`),metric(d,'Contained',`${pulse.staleDropCount??0} stale`,`${pulse.fallbackCount??0} fallback events`));host.append(detail);
  }
  if(level===ProductDetailLevel.ADVANCED){
    host.append(section(d,'Result destinations'),renderObjectSummary(d,pulse.resultDestinations),section(d,'Forensics'),forensicsSummary(d,s.forensics,s.wave6.sources.forensics,ctx),section(d,'Engineering workspaces'));
    const g=element(d,'div',{className:'nexus-product-grid'});for(const x of ctx.workspaceRegistry.list().filter(x=>x.navigation?.level!=='product')){const body=element(d,'div',{className:'nexus-stack'});body.append(element(d,'span',{className:'nexus-muted',text:x.category}),createButton(d,{label:'Open',scope:ctx.scope,onPress:()=>ctx.navigate?.(x.id)}));g.append(makeCard(d,{title:x.title,body}));}host.append(g);
  }
}

function renderForensics(host,ctx){
  const d=host.ownerDocument,s=ctx.adapter.getSnapshot(),source=s.wave6.sources.forensics,data=s.forensics;header(host,ctx,'Forensics','Advanced reconstruction: source → cognition → proposal → validation → Settlement → Context → generation.');
  if(!data){host.append(sourceStateMessage(d,source));return;}
  host.append(createProductHealthSurface(d,{source,label:'Forensics'}));
  const rows=[...(data.transactions??[])].map(x=>({id:x.transactionId??x.id??`tx-${x.sequence}`,label:`${x.sequence??'—'} · ${x.transactionType??x.type??'transaction'} · ${x.reasonCode??''}`,payload:x}));
  const card=element(d,'section',{className:'nexus-card'});card.append(element(d,'h2',{text:`Cognitive Transaction Ledger · ${rows.length}`}));
  const listHost=element(d,'div');card.append(listHost);host.append(card);
  if(rows.length&&ctx.scope)new VirtualListController({host:listHost,items:rows,itemSize:46,overscan:6,scope:ctx.scope,keyForItem:x=>x.id,renderItem(item){const b=element(d,'button',{className:'nexus-nav-item',text:item.label,attrs:{type:'button'}});ctx.scope.listen(b,'click',()=>inspect(ctx,{kind:'cognitive-transaction',id:item.id,title:item.label,payload:item.payload}));return b;}}).mount();
  else if(!rows.length)listHost.append(state(d,'No cognitive transactions','The forensic producer is connected but has no rows yet.'));
  const bundles=data.bundles??[];if(bundles.length)host.append(section(d,'Forensic bundles'),list(d,bundles.map(x=>`${x.turnId} · ${x.generationId??'no generation'} · ${x.complete?'complete':'partial'}`)));
}

function renderPromptPlan(d,plan,source,level,ctx){
  if(!plan)return sourceStateMessage(d,source);
  const card=element(d,'section',{className:'nexus-card nexus-prompt-delivery'});card.append(element(d,'div',{className:'nexus-inline-status'},sourceModeBadge(d,source),plan.seal?makeBadge(d,plan.seal.sealedState?'SEALED':'UNSEALED',plan.seal.sealedState?'canonical':'warning'):makeBadge(d,'SEAL UNAVAILABLE','offline')),element(d,'h2',{text:'Context prepared'}),element(d,'p',{text:`${num(plan.totalTokens)} / ${num(plan.budgetTotal)} tokens · ${plan.reusedSegments} reused · ${plan.updatedSegments} updated · ${plan.dropped.length} dropped · ${plan.deferred.length} deferred`}));
  if(level!==ProductDetailLevel.NORMAL){card.append(list(d,(plan.sections??[]).map(x=>`${x.slot??'section'} · ${x.allocatedTokens??'—'} tokens · ${x.representation??'—'}`)));}
  if(level===ProductDetailLevel.ADVANCED){card.append(createKeyValue(d,[{key:'Plan',value:plan.promptPlanId},{key:'Model profile',value:plan.modelProfileId??'unavailable'},{key:'World / Scene revision',value:`${plan.worldRevision??'—'} / ${plan.sceneRevision??'—'}`},{key:'Integrity',value:plan.integrityReceipt?.valid===true?'VALID':plan.integrityReceipt?'FAILED':'UNAVAILABLE'},{key:'Fallbacks',value:plan.fallbackDecisions.join(', ')||'none'}]),createButton(d,{label:'Inspect PromptPlan',scope:ctx.scope,onPress:()=>inspect(ctx,{kind:'prompt-plan',id:plan.promptPlanId,title:'PromptPlan',payload:plan})}));if(plan.contextReceipt)card.append(kv(d,'Context Receipt',`${plan.contextReceipt.generationId??plan.generationId??'generation'} · ${plan.contextReceipt.finalContextSize??plan.totalTokens} · seal ${plan.contextReceipt.contextSealValid??plan.seal?.sealedState??'unknown'}`));else card.append(state(d,'Context Receipt unavailable','The current Core producer does not expose a completed-generation Context Receipt yet.'));}
  return card;
}

function forensicsSummary(d,data,source,ctx){
  if(!data)return sourceStateMessage(d,source);
  const card=element(d,'section',{className:'nexus-card'});card.append(element(d,'p',{text:`${data.transactions?.length??0} cognitive transactions · ${data.bundles?.length??0} forensic bundles`}),createButton(d,{label:'Open full Forensics',scope:ctx.scope,onPress:()=>ctx.navigate?.('forensics')}));return card;
}

function header(host,ctx,title,subtitle){const d=host.ownerDocument,h=element(d,'div',{className:'nexus-product-header'}),t=element(d,'div');t.append(element(d,'h1',{text:title}),element(d,'p',{className:'nexus-muted',text:subtitle}));const controls=element(d,'div',{className:'nexus-detail-control',attrs:{role:'group','aria-label':'Detail level'}});for(const level of Object.values(ProductDetailLevel)){const b=createButton(d,{label:human(level),scope:ctx.scope,size:'sm',variant:'quiet',onPress:()=>{ctx.adapter.setDetailLevel(level);ctx.refresh?.();}});b.setAttribute('aria-pressed',String(ctx.adapter.getDetailLevel()===level));if(ctx.adapter.getDetailLevel()===level)b.classList.add('is-selected');controls.append(b);}h.append(t,controls);host.append(h);}
function sourceCard(d,source,onInspect){return createProductHealthSurface(d,{source,label:source.label,onInspect,actionLabel:'Inspect details',compact:true});}
function sourceInspection(id,source,selection={}){
  const reason=source?.reason??source?.impact??'No selected-turn owner receipt is available.';
  return{kind:'wave13-producer-inspection',id:'source:'+id,title:(source?.label??id)+' detail',producerId:id,available:false,selection:{...selection},reason,payload:{kind:'UnavailableProducerReceipt',status:'UNAVAILABLE',reason,chatId:selection?.chatId??null,turnId:selection?.turnId??null,generationId:selection?.generationId??null}};
}
function renderAttention(d,items,ctx){if(!items.length)return state(d,'No attention required','Connected cognitive surfaces report no operator-impacting issue.');const r=element(d,'div',{className:'nexus-stack'});for(const x of items.slice(0,5)){const n=element(d,'article',{className:'nexus-notification-summary',dataset:{status:x.status}});n.append(element(d,'strong',{text:x.title}),element(d,'span',{text:x.message}));n.append(createButton(d,{label:'Inspect',scope:ctx.scope,size:'sm',variant:'inspect',onPress:()=>inspect(ctx,{kind:'wave6-attention',id:x.id,title:x.title,payload:x})}));r.append(n);}return r;}
function renderActivity(d,items){if(!items.length)return state(d,'Quiet','No meaningful cognitive activity to surface.');return list(d,items.slice(0,10).map(x=>`${symbol(x.status)} ${x.meaning??x.message??'Activity updated'}`),'nexus-product-activity');}
function renderAvailability(d,sources){const g=element(d,'div',{className:'nexus-product-grid'});for(const [id,source] of Object.entries(sources))g.append(createProductHealthSurface(d,{source,label:source.label??id,compact:true}));return g;}
function pulseLane(d,label,lane){const r=element(d,'div',{className:'nexus-brain-pulse__lane',dataset:{active:String(Boolean(lane?.active))}});r.append(element(d,'span',{className:'nexus-eyebrow',text:label}),element(d,'strong',{text:lane?.label??'Idle'}),element(d,'span',{className:'nexus-muted',text:`${lane?.count??0} active`}));return r;}
function fallbackPulse(s){return{overall:s.brain.overall,currentFocus:'Brain status available',foreground:{active:false,count:0,label:'Foreground idle'},background:{active:false,count:0,label:'Background idle'},hotCount:0,deepCount:0,warm:{hit:0,miss:0},fallbackCount:0,staleDropCount:0,resultDestinations:{},attention:[],activity:[]};}
function overallSource(s){const sources=Object.values(s.wave6?.sources??{});const live=sources.find(x=>x.mode===ProductDataMode.LIVE);return live??sources[0]??{mode:ProductDataMode.UNAVAILABLE};}
function renderObjectSummary(d,data){const rows=[];if(Array.isArray(data))return list(d,data.slice(0,20).map(x=>typeof x==='string'?x:x.name??x.label??x.id??JSON.stringify(x)));for(const [key,value] of Object.entries(data??{}).slice(0,20)){if(value==null)continue;if(typeof value==='object')rows.push({key,value:Array.isArray(value)?`${value.length} items`:value.label??value.name??value.status??value.state??'available'});else rows.push({key,value:String(value)});}return rows.length?createKeyValue(d,rows):state(d,'Empty','The connected producer returned no summary fields.');}
function inspect(ctx,o){if(ctx.inspect)return ctx.inspect(o);ctx.signals?.publish?.(Signals.UI_INSPECT_SELECTION_CHANGED,{object:o},{source:'wave6-front-face'});}
function state(d,t,m,status='ready'){const r=element(d,'section',{className:'nexus-state-message',attrs:{role:'status'},dataset:{status}});r.append(element(d,'strong',{text:t}),element(d,'span',{text:m}));return r;}
function section(d,t){return element(d,'h2',{className:'nexus-section-title',text:t});}
function kv(d,l,v){const r=element(d,'div',{className:'nexus-label-value'});r.append(element(d,'span',{className:'nexus-eyebrow',text:l}),element(d,'span',{text:String(v??'—')}));return r;}
function list(d,items=[],className=''){const ul=element(d,'ul',{className});for(const x of items)ul.append(element(d,'li',{text:String(x)}));return ul;}
function metric(d,t,v,detail){const b=element(d,'div',{className:'nexus-stack'});b.append(element(d,'strong',{className:'nexus-metric-value',text:v}),element(d,'span',{className:'nexus-muted',text:detail}));return makeCard(d,{title:t,body:b});}
function healthToken(v){if(['READY','CURRENT','COMPLETE'].includes(v))return'ready';if(['STUDYING','LEARNING','WORKING','ACTIVE'].includes(v))return'loading';if(['DEGRADED','STALE'].includes(v))return'warning';if(v==='BLOCKED')return'error';if(v==='UNAVAILABLE')return'offline';return'historical';}
function symbol(v){return v==='complete'?'✓':v==='warning'?'!':v==='contained'?'↳':v==='paused'?'Ⅱ':'•';}
function human(v){return String(v??'').toLowerCase().replace(/(^|_)([a-z])/g,(_,sp,l)=>`${sp?' ':''}${l.toUpperCase()}`);}
function num(v){return new Intl.NumberFormat('en-US').format(Number(v)||0);}
