import { ResourceScope } from './lifecycle.js';
import { element } from './primitives.js';
import { nexusBrandIconAttrs } from './nexus-brand.js';

const EDGE=8,ORB=50,MIN_W=520,MIN_H=340,MAX_W=1280,MAX_H=900,DRAG_THRESHOLD=5;
// Story is the default. There is no All or System tab: engine internals live in Diagnostics.
const TABS=['STORY','MEMORY','PROPOSALS','PROBLEMS'];
const TAB_LABELS={STORY:'Story',MEMORY:'Memory',PROPOSALS:'Proposals',PROBLEMS:'Problems'};

export class ActivityFeedController{
  constructor({document,stateStore,readFeed,subscribe,clearPresentation=null,viewportProvider=null,openDiagnostics=null,openProposal=null}={}){
    if(!document||typeof readFeed!=='function')throw new TypeError('ActivityFeedController requires document and readFeed()');
    this.document=document;this.stateStore=stateStore;this.readFeed=readFeed;this.subscribe=subscribe;this.clearPresentation=clearPresentation;this.viewportProvider=viewportProvider;this.openDiagnostics=openDiagnostics;this.openProposal=openProposal;
    this.scope=new ResourceScope();this.renderScope=new ResourceScope();this.nodes={};this.mounted=false;this.drag=null;this.resize=null;this.opened=false;this.tab='STORY';this.unread=0;this.lastSeenId=null;this.expanded=new Set();this.expandedSteps=new Set();
    const p=this.stateStore?.load?.().activityFeed??{};
    this.state={
      orbX:numberOrNull(p.orbX),orbY:numberOrNull(p.orbY),
      panelX:numberOrNull(p.panelX),panelY:numberOrNull(p.panelY),
      panelW:finiteOr(p.panelW,860),panelH:finiteOr(p.panelH,620),clearBeforeTs:finiteOr(p.clearBeforeTs,0),
    };
  }
  mount(){
    if(this.mounted)return this;this.mounted=true;const d=this.document;
    const orb=element(d,'button',{className:'nexus-activity-orb',attrs:{type:'button','aria-label':'Open Nexus Activity Feed',title:'Activity Feed'}});
    orb.append(element(d,'img',{className:'nexus-activity-orb__mark',attrs:nexusBrandIconAttrs()}),element(d,'span',{className:'nexus-activity-orb__badge',text:'0'}));
    const panel=element(d,'section',{className:'nexus-activity-window',attrs:{role:'region','aria-label':'Nexus Activity Feed'},dataset:{open:'false'}});
    const head=element(d,'header',{className:'nexus-activity-window__head'});
    const dragHandle=element(d,'div',{className:'nexus-activity-window__drag',attrs:{role:'button',tabindex:'0','aria-label':'Move Activity Feed window'}});
    const title=element(d,'div',{className:'nexus-activity-window__title'});
    const titleCopy=element(d,'div',{className:'nexus-activity-window__copy'});
    titleCopy.append(element(d,'strong',{text:'Activity Feed'}),element(d,'span',{text:'Live story activity, saved memories, and updates that need you'}));
    title.append(element(d,'img',{className:'nexus-activity-window__icon',attrs:nexusBrandIconAttrs()}),titleCopy);
    const headActions=element(d,'div',{className:'nexus-activity-window__head-actions'});
    const clear=element(d,'button',{className:'nexus-activity-window__icon-button',text:'⌫',attrs:{type:'button','aria-label':'Clear visible Activity Feed',title:'Clear visible feed'}});
    const close=element(d,'button',{className:'nexus-activity-window__icon-button',text:'×',attrs:{type:'button','aria-label':'Close Activity Feed'}});
    dragHandle.append(title);headActions.append(clear,close);head.append(dragHandle,headActions);

    const tabs=element(d,'nav',{className:'nexus-activity-tabs',attrs:{'aria-label':'Activity Feed filters'}});
    const status=element(d,'div',{className:'nexus-activity-status'});
    const list=element(d,'div',{className:'nexus-activity-list',attrs:{role:'log','aria-live':'polite','aria-relevant':'additions text'}});
    const resize=element(d,'button',{className:'nexus-activity-window__resize',attrs:{type:'button','aria-label':'Resize Activity Feed window',title:'Drag to resize'}});
    panel.append(head,tabs,status,list,resize);d.body?.append(orb,panel);
    this.nodes={orb,panel,dragHandle,title,clear,close,tabs,status,list,resize,badge:orb.querySelector?.('.nexus-activity-orb__badge'),mark:orb.querySelector?.('.nexus-activity-orb__mark')};

    this.#ensureGeometry();this.#applyGeometry();this.#bindOrb();this.#bindPanelDrag();this.#bindResize();
    this.scope.listen(close,'click',()=>this.close());
    this.scope.listen(clear,'click',()=>{this.state.clearBeforeTs=Date.now();this.clearPresentation?.();this.lastSeenId=null;this.unread=0;this.expanded.clear();this.expandedSteps.clear();this.#persist();this.render();});
    this.scope.listen(d,'keydown',(event)=>{if(event.key==='Escape'&&this.opened){event.preventDefault?.();this.close();}});
    const win=d.defaultView??globalThis.window;if(win?.addEventListener){
      this.scope.listen(win,'resize',()=>{this.#clamp();this.#applyGeometry();});
      this.scope.listen(win,'orientationchange',()=>{this.#clamp();this.#applyGeometry();});
    }
    const release=this.subscribe?.(()=>this.#onFeedChange());if(typeof release==='function')this.scope.add(release);
    this.render();return this;
  }
  open(){this.opened=true;this.unread=0;const snap=this.#visibleFeed(this.readFeed());this.lastSeenId=snap?.latestEventId??this.lastSeenId;this.nodes.panel.dataset.open='true';this.nodes.panel.hidden=false;this.render();}
  close(){this.opened=false;this.nodes.panel.dataset.open='false';this.nodes.panel.hidden=true;this.#persist();this.render();}
  toggle(){this.opened?this.close():this.open();}
  render(){
    if(!this.mounted)return;const snap=this.#visibleFeed(this.readFeed?.()??{turns:[],memory:[],problems:[],proposals:[],counts:{},status:{}});
    this.#renderTabs(snap);this.#renderStatus(snap);this.#renderList(snap);this.#renderOrb(snap);
  }
  destroy(){if(!this.mounted)return;this.mounted=false;this.renderScope.cleanup();this.scope.cleanup();this.nodes.orb?.remove?.();this.nodes.panel?.remove?.();this.nodes={};}
  diagnostics(){return Object.freeze({kind:'NexusActivityFeedController',open:this.opened,tab:this.tab,unread:this.unread,orb:{x:this.state.orbX,y:this.state.orbY},panel:{x:this.state.panelX,y:this.state.panelY,width:this.state.panelW,height:this.state.panelH}});}
  #onFeedChange(){
    const raw=this.readFeed?.()??null;if(!raw)return;const snap=this.#visibleFeed(raw);
    const latest=snap.latestEventId;
    if(!this.opened&&latest&&latest!==this.lastSeenId)this.unread+=1;
    if(this.opened)this.lastSeenId=latest??this.lastSeenId;
    this.render();
  }
  #renderTabs(snap){
    this.renderScope.cleanup();this.renderScope=new ResourceScope();const tabs=this.nodes.tabs;tabs.replaceChildren();
    for(const id of TABS){
      const count=Number(snap?.counts?.[id]??0);
      const b=element(this.document,'button',{className:'nexus-activity-tab',attrs:{type:'button','aria-pressed':String(this.tab===id)},dataset:{tab:id,selected:String(this.tab===id),attention:String(id==='PROPOSALS'&&count>0)}});
      b.append(element(this.document,'span',{text:TAB_LABELS[id]}),element(this.document,'span',{className:'nexus-activity-tab__count',text:String(count)}));
      this.renderScope.listen(b,'click',()=>{this.tab=id;this.render();});
      tabs.append(b);
    }
  }
  // Keep actual worker state visible even when no outcome has arrived yet.
  #renderStatus(snap){
    const status=snap?.status??{},root=this.nodes.status;root.replaceChildren();
    for(const key of ['main','A','B','running','queued']){
      const worker=['main','A','B'].includes(key),label={main:'Main',A:'A',B:'B',running:'Running',queued:'Queued'}[key];
      const value=worker?(status[key]?.state??'disabled'):Number(status[key]??0);
      const state=worker?value:value>0?(key==='running'?'working':'queued'):'idle';
      const item=element(this.document,'div',{className:'nexus-activity-status__item',dataset:{state:String(state)},attrs:{title:label+': '+value,'aria-label':label+': '+value}});
      item.append(element(this.document,'span',{className:'nexus-activity-status__dot'}),element(this.document,'strong',{text:label}),element(this.document,'span',{text:String(value)}));
      root.append(item);
    }
    const link=element(this.document,'button',{className:'nexus-activity-status__link',text:'View system events',attrs:{type:'button'},dataset:{action:'view-system-events'}});
    this.renderScope.listen(link,'click',()=>this.openDiagnostics?.({}));
    root.append(link);
  }
  #renderList(snap){
    const list=this.nodes.list;list.replaceChildren();
    const activities=[...(snap?.activities??[])].sort((a,b)=>b.ts-a.ts).slice(0,120);
    const retained=new Set(activities.map(row=>row.id));for(const id of [...this.expanded])if(!retained.has(id))this.expanded.delete(id);
    const proposals=[...(snap?.proposals??[])].sort((a,b)=>a.ts-b.ts);
    let rows=[];
    if(this.tab==='STORY')rows=[...proposals.map(row=>this.#proposalRow(row)),...activities.map(row=>this.#activityRow(row))];
    else if(this.tab==='PROPOSALS')rows=proposals.map(row=>this.#proposalRow(row));
    else if(this.tab==='MEMORY')rows=[...(snap?.memory??[])].sort((a,b)=>b.ts-a.ts).slice(0,120).map(row=>this.#activityRow(row));
    else if(this.tab==='PROBLEMS')rows=[...(snap?.problems??[])].sort((a,b)=>b.ts-a.ts).slice(0,120).map(row=>this.#activityRow(row));
    if(!rows.length){list.append(element(this.document,'div',{className:'nexus-activity-list__empty',text:EMPTY[this.tab]??'Nothing here yet.'}));return;}
    for(const row of rows)list.append(row);
  }
  // Same layout everywhere: icon, label, one-line summary, time.
  #actionLine(tag,{icon,label,summary,ts,className}){
    const action=element(this.document,tag,{className});
    action.append(
      element(this.document,'span',{className:'nexus-activity-row__tone'}),
      element(this.document,'span',{className:'nexus-activity-row__icon',text:icon}),
      element(this.document,'span',{className:'nexus-activity-row__source',text:label,attrs:{title:label}}),
      element(this.document,'span',{className:'nexus-activity-row__summary',text:summary}),
      element(this.document,'time',{className:'nexus-activity-row__time',text:formatTime(ts),attrs:{datetime:new Date(ts||0).toISOString()}}),
    );
    return action;
  }
  #traceLink(trace){
    if(typeof this.openDiagnostics!=='function')return null;
    const link=element(this.document,'button',{className:'nexus-activity-row__trace',text:'Trace in Diagnostics',attrs:{type:'button'},dataset:{action:'open-trace'}});
    this.renderScope.listen(link,'click',event=>{event?.stopPropagation?.();this.openDiagnostics(trace);});
    return link;
  }
  #activityRow(row){
    const item=element(this.document,'details',{className:'nexus-activity-row',dataset:{kind:'activity',eventId:row.id,level:row.level,tone:row.tone}});
    item.append(this.#actionLine('summary',{icon:row.icon,label:row.source,summary:row.summary,ts:row.ts,className:'nexus-activity-row__action'}));
    const body=element(this.document,'div',{className:'nexus-activity-row__details'});
    const fields=row.detailFields??{};
    const lines=[];
    const list=value=>Array.isArray(value)?value:[];
    for(const ref of list(fields.refs))if(ref?.title)lines.push('Lore: '+ref.title);
    for(const memory of list(fields.selected))if(memory?.textPreview)lines.push('Recalled: '+memory.textPreview);
    if(fields.textPreview)lines.push('Summary: '+fields.textPreview);
    for(const node of list(fields.learnedNodes))if(node?.label)lines.push('Added: '+node.label+(node.kind?' ('+String(node.kind).toLowerCase()+')':''));
    for(const edge of list(fields.learnedConnections))if(edge&&typeof edge.relation==='string')lines.push([edge.from,edge.relation.replace(/-/g,' '),edge.to].filter(Boolean).join(' → '));
    for(const section of list(fields.sections))if(Number(section?.chars)>0)lines.push('Prepared: '+(section.label??section.id)+(section.tokens!=null?' · approximately '+section.tokens+' tokens':''));
    if(fields.reason)lines.push('Reason: '+fields.reason);
    if(fields.error?.message)lines.push('Problem: '+fields.error.message);
    if(fields.location)lines.push('Location: '+fields.location);
    if(row.source==='Scene Intelligence'){
      if(fields.parentLocation)lines.push('Within: '+fields.parentLocation);
      if(list(fields.participants).length)lines.push('Present: '+fields.participants.join(', '));
      if(list(fields.objects).length)lines.push('Objects: '+fields.objects.join(', '));
      for(const thread of list(fields.threads))lines.push('Thread: '+thread);
      for(const objective of list(fields.objectives))lines.push('Objective: '+objective);
      if(fields.narrativeTime)lines.push('Time: '+fields.narrativeTime);
      if(fields.activity)lines.push('Activity: '+fields.activity);
      if(fields.focus)lines.push('Focus: '+fields.focus);
      const names={activeCast:'people',immediateObjects:'objects',activeThreads:'threads',activeObjectives:'objectives',activeRelationships:'relationships',narrativeTime:'time',atmosphere:'activity'};
      if(list(fields.unresolvedFields).length)lines.push('Still uncertain: '+fields.unresolvedFields.map(value=>names[value]??String(value).replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase()).join(', '));
    }
    if(row.source==='Hot Cognition'){
      const names={SCENE:'scene',ACTIVE_CAST:'people',CONTINUITY:'continuity',ACTIVE_THREADS:'threads',ACTIVE_OBJECTIVES:'objectives',RECENT_EPISODE_TAIL:'recent narrative',GRAPH_NEIGHBORHOOD:'connected lore'};
      const changed=list(fields.changedSegments).map(key=>names[key]).filter(Boolean);
      if(changed.length)lines.push('Updated: '+changed.join(', '));
    }
    if(row.source==='Graph Walker'){
      if(fields.traversedNodeCount!=null)lines.push('Nodes visited: '+fields.traversedNodeCount);
      if(fields.traversedEdgeCount!=null)lines.push('Connections followed: '+fields.traversedEdgeCount);
      if(fields.nominationCount!=null)lines.push('Related candidates: '+fields.nominationCount);
      lines.push('Candidates still need relevance checks and room in the reply context.');
      if(Number(fields.boundedEdgeCount)>0||Number(fields.boundedNodeCount)>0||Number(fields.boundedCandidateCount)>0)lines.push('Some graph work remains outside this search budget.');
    }
    if(fields.estimatedInjectionTokens??fields.estimatedTokens)lines.push('Context: approximately '+(fields.estimatedInjectionTokens??fields.estimatedTokens)+' tokens');
    if(fields.memoryId)lines.push('Saved memory: '+fields.memoryId);
    if(fields.latencyMs!=null)lines.push('Time: '+(Number(fields.latencyMs)/1000).toFixed(1)+' seconds');
    for(const line of [...new Set(lines)])body.append(element(this.document,'div',{text:line}));
    if(!lines.length)body.append(element(this.document,'div',{text:row.summary}));
    const link=this.#traceLink(row.trace);if(link)body.append(link);
    item.open=this.expanded.has(row.id);
    this.renderScope.listen(item,'toggle',()=>{
      if(item.open)this.expanded.add(row.id);else this.expanded.delete(row.id);
      // Technical metadata is built only when explicitly expanded, never for collapsed rows.
      if(item.open&&!body.dataset.metadataBuilt){
        const details=element(this.document,'details',{className:'nexus-activity-row__steps'});
        details.append(element(this.document,'summary',{text:'Technical details'}));
        details.append(element(this.document,'pre',{text:JSON.stringify(fields,null,2)}));body.append(details);body.dataset.metadataBuilt='true';
      }
    });
    item.append(body);return item;
  }
  // Pending proposals need the player. They stand alone, highlighted, outside the turn grouping.
  #proposalRow(row){
    const item=element(this.document,'div',{className:'nexus-activity-row nexus-activity-row--proposal',dataset:{kind:'proposal',eventId:row.id,proposalId:row.proposalId,highlight:'true',level:'info'}});
    item.append(this.#actionLine('div',{icon:'◇',label:row.label,summary:row.summary,ts:row.ts,className:'nexus-activity-row__action'}));
    if(typeof this.openProposal==='function'){
      const review=element(this.document,'button',{className:'nexus-activity-row__trace',text:'Review',attrs:{type:'button'},dataset:{action:'review-proposal'}});
      this.renderScope.listen(review,'click',()=>this.openProposal(row));item.append(review);
    }
    return item;
  }
  #renderOrb(snap){
    const newest=[...(snap?.activities??[])].sort((a,b)=>b.ts-a.ts)[0]??null;
    this.nodes.orb.dataset.level=newest?.problem?'warn':'info';this.nodes.orb.dataset.tone='blue';
    this.nodes.orb.dataset.active=String(['working','queued'].includes(snap?.status?.dot?.state)||Number(snap?.counts?.PROPOSALS??0)>0);
    if(this.nodes.badge){this.nodes.badge.textContent=this.unread>99?'99+':String(this.unread);this.nodes.badge.hidden=this.unread<=0;}
  }
  #bindOrb(){
    const orb=this.nodes.orb,d=this.document;let press=null;
    this.scope.listen(orb,'pointerdown',(event)=>{if(event.button!=null&&event.button!==0)return;event.preventDefault?.();orb.setPointerCapture?.(event.pointerId);press={id:event.pointerId,startX:Number(event.clientX??0),startY:Number(event.clientY??0),originX:this.state.orbX,originY:this.state.orbY,moved:false};});
    this.scope.listen(d,'pointermove',(event)=>{if(!press||event.pointerId!==press.id)return;const dx=Number(event.clientX??0)-press.startX,dy=Number(event.clientY??0)-press.startY;if(Math.hypot(dx,dy)>=DRAG_THRESHOLD)press.moved=true;if(press.moved){this.state.orbX=press.originX+dx;this.state.orbY=press.originY+dy;this.#clamp();this.#applyGeometry();}});
    this.scope.listen(d,'pointerup',(event)=>{if(!press||event.pointerId!==press.id)return;orb.releasePointerCapture?.(event.pointerId);const moved=press.moved;press=null;this.#persist();if(!moved)this.toggle();});
    this.scope.listen(d,'pointercancel',()=>{press=null;});
  }
  #bindPanelDrag(){
    const h=this.nodes.dragHandle,d=this.document;this.scope.listen(h,'pointerdown',(event)=>{if(event.button!=null&&event.button!==0)return;event.preventDefault?.();h.setPointerCapture?.(event.pointerId);this.drag={id:event.pointerId,startX:Number(event.clientX??0),startY:Number(event.clientY??0),originX:this.state.panelX,originY:this.state.panelY};});
    this.scope.listen(d,'pointermove',(event)=>{if(!this.drag||event.pointerId!==this.drag.id)return;this.state.panelX=this.drag.originX+Number(event.clientX??0)-this.drag.startX;this.state.panelY=this.drag.originY+Number(event.clientY??0)-this.drag.startY;this.#clamp();this.#applyGeometry();});
    this.scope.listen(d,'pointerup',(event)=>{if(!this.drag||event.pointerId!==this.drag.id)return;h.releasePointerCapture?.(event.pointerId);this.drag=null;this.#persist();});
    this.scope.listen(d,'pointercancel',()=>{this.drag=null;});
  }
  #bindResize(){
    const h=this.nodes.resize,d=this.document;this.scope.listen(h,'pointerdown',(event)=>{if(event.button!=null&&event.button!==0)return;event.preventDefault?.();h.setPointerCapture?.(event.pointerId);this.resize={id:event.pointerId,startX:Number(event.clientX??0),startY:Number(event.clientY??0),w:this.state.panelW,h:this.state.panelH};});
    this.scope.listen(d,'pointermove',(event)=>{if(!this.resize||event.pointerId!==this.resize.id)return;this.state.panelW=this.resize.w+Number(event.clientX??0)-this.resize.startX;this.state.panelH=this.resize.h+Number(event.clientY??0)-this.resize.startY;this.#clamp();this.#applyGeometry();});
    this.scope.listen(d,'pointerup',(event)=>{if(!this.resize||event.pointerId!==this.resize.id)return;h.releasePointerCapture?.(event.pointerId);this.resize=null;this.#persist();});
    this.scope.listen(d,'pointercancel',()=>{this.resize=null;});
  }
  #ensureGeometry(){
    const vp=this.#viewport();if(this.state.orbX==null)this.state.orbX=Math.max(EDGE,vp.width-ORB-28);if(this.state.orbY==null)this.state.orbY=Math.max(EDGE,Math.round(vp.height*.22));
    if(this.state.panelX==null)this.state.panelX=Math.max(EDGE,Math.round((vp.width-this.state.panelW)/2));if(this.state.panelY==null)this.state.panelY=Math.max(EDGE,Math.round((vp.height-this.state.panelH)/2));this.#clamp();this.#persist();
  }
  #clamp(){
    const vp=this.#viewport();this.state.orbX=clamp(this.state.orbX,EDGE,Math.max(EDGE,vp.width-ORB-EDGE));this.state.orbY=clamp(this.state.orbY,EDGE,Math.max(EDGE,vp.height-ORB-EDGE));
    this.state.panelW=clamp(this.state.panelW,MIN_W,Math.max(MIN_W,Math.min(MAX_W,vp.width-EDGE*2)));this.state.panelH=clamp(this.state.panelH,MIN_H,Math.max(MIN_H,Math.min(MAX_H,vp.height-EDGE*2)));
    this.state.panelX=clamp(this.state.panelX,EDGE,Math.max(EDGE,vp.width-this.state.panelW-EDGE));this.state.panelY=clamp(this.state.panelY,EDGE,Math.max(EDGE,vp.height-this.state.panelH-EDGE));
  }
  #applyGeometry(){
    const o=this.nodes.orb,p=this.nodes.panel;if(o){o.style.left=this.state.orbX+'px';o.style.top=this.state.orbY+'px';}if(p){p.style.left=this.state.panelX+'px';p.style.top=this.state.panelY+'px';p.style.width=this.state.panelW+'px';p.style.height=this.state.panelH+'px';p.hidden=!this.opened;}
  }
  #viewport(){
    const supplied=this.viewportProvider?.(),win=this.document.defaultView??globalThis.window;
    return{width:Math.max(320,Number(supplied?.width??win?.innerWidth??this.document.documentElement?.clientWidth??1280)||1280),height:Math.max(360,Number(supplied?.height??win?.innerHeight??this.document.documentElement?.clientHeight??800)||800)};
  }
  // Clear is presentation-only. It hides earlier story activity but never a pending proposal,
  // which still needs the player.
  #visibleFeed(snapshot={}){
    const cutoff=Number(this.state.clearBeforeTs??0),after=row=>Number(row?.ts??0)>cutoff;
    const turns=(snapshot?.turns??[]).filter(after),memory=(snapshot?.memory??[]).filter(after),problems=(snapshot?.problems??[]).filter(after),proposals=snapshot?.proposals??[];
    const activities=(snapshot?.activities??[]).filter(after);
    const newest=[...activities].sort((a,b)=>a.ts-b.ts).at(-1)??null;
    return{...snapshot,activities,turns,memory,problems,proposals,counts:{STORY:activities.length,MEMORY:memory.length,PROPOSALS:proposals.length,PROBLEMS:problems.length},latestEventId:newest?.latestEventId??newest?.id??null,latestEventTs:newest?.ts??null};
  }
  #persist(){this.stateStore?.save?.({activityFeed:{orbX:this.state.orbX,orbY:this.state.orbY,panelX:this.state.panelX,panelY:this.state.panelY,panelW:this.state.panelW,panelH:this.state.panelH,clearBeforeTs:this.state.clearBeforeTs}});}
}
function clamp(value,min,max){return Math.max(min,Math.min(max,Number(value)||0));}
function numberOrNull(value){const n=Number(value);return Number.isFinite(n)?n:null;}
function finiteOr(value,fallback){const n=Number(value);return Number.isFinite(n)?n:fallback;}
const EMPTY={STORY:'No story activity reported yet.',MEMORY:'No memories were saved or recalled yet.',PROPOSALS:'Nothing is waiting for you.',PROBLEMS:'No problems reported.'};
function formatTime(value){const d=new Date(Number(value)||0);if(Number.isNaN(d.getTime()))return'';return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
export function createActivityFeedController(options){return new ActivityFeedController(options);}
