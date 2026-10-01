import { ResourceScope } from './lifecycle.js';
import { element } from './primitives.js';

const EDGE=8,ORB=50,MIN_W=520,MIN_H=340,MAX_W=1280,MAX_H=900,DRAG_THRESHOLD=5;
const TABS=['ALL','MEMORY','PROPOSALS','SYSTEM'];
const TAB_LABELS={ALL:'All',MEMORY:'Memory',PROPOSALS:'Proposals',SYSTEM:'System'};

export class ActivityFeedController{
  constructor({document,stateStore,readFeed,subscribe,clearPresentation=null,viewportProvider=null}={}){
    if(!document||typeof readFeed!=='function')throw new TypeError('ActivityFeedController requires document and readFeed()');
    this.document=document;this.stateStore=stateStore;this.readFeed=readFeed;this.subscribe=subscribe;this.clearPresentation=clearPresentation;this.viewportProvider=viewportProvider;
    this.scope=new ResourceScope();this.renderScope=new ResourceScope();this.nodes={};this.mounted=false;this.drag=null;this.resize=null;this.opened=false;this.tab='ALL';this.unread=0;this.lastSeenId=null;
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
    orb.append(element(d,'span',{className:'nexus-activity-orb__pulse',text:'⌁'}),element(d,'span',{className:'nexus-activity-orb__badge',text:'0'}));
    const panel=element(d,'section',{className:'nexus-activity-window',attrs:{role:'region','aria-label':'Nexus Activity Feed'},dataset:{open:'false'}});
    const head=element(d,'header',{className:'nexus-activity-window__head'});
    const dragHandle=element(d,'div',{className:'nexus-activity-window__drag',attrs:{role:'button',tabindex:'0','aria-label':'Move Activity Feed window'}});
    const title=element(d,'div',{className:'nexus-activity-window__title'});
    const titleCopy=element(d,'div',{className:'nexus-activity-window__copy'});
    titleCopy.append(element(d,'strong',{text:'Activity Feed'}),element(d,'span',{text:'Live system activity, memory, and cognition events'}));
    title.append(element(d,'span',{className:'nexus-activity-window__icon',text:'〰'}),titleCopy);
    const headActions=element(d,'div',{className:'nexus-activity-window__head-actions'});
    const clear=element(d,'button',{className:'nexus-activity-window__icon-button',text:'⌫',attrs:{type:'button','aria-label':'Clear visible Activity Feed',title:'Clear visible feed'}});
    const close=element(d,'button',{className:'nexus-activity-window__icon-button',text:'×',attrs:{type:'button','aria-label':'Close Activity Feed'}});
    dragHandle.append(title);headActions.append(clear,close);head.append(dragHandle,headActions);

    const tabs=element(d,'nav',{className:'nexus-activity-tabs',attrs:{'aria-label':'Activity Feed filters'}});
    const status=element(d,'div',{className:'nexus-activity-status'});
    const list=element(d,'div',{className:'nexus-activity-list',attrs:{role:'log','aria-live':'polite','aria-relevant':'additions text'}});
    const resize=element(d,'button',{className:'nexus-activity-window__resize',attrs:{type:'button','aria-label':'Resize Activity Feed window',title:'Drag to resize'}});
    panel.append(head,tabs,status,list,resize);d.body?.append(orb,panel);
    this.nodes={orb,panel,dragHandle,title,clear,close,tabs,status,list,resize,badge:orb.querySelector?.('.nexus-activity-orb__badge'),pulse:orb.querySelector?.('.nexus-activity-orb__pulse')};

    this.#ensureGeometry();this.#applyGeometry();this.#bindOrb();this.#bindPanelDrag();this.#bindResize();
    this.scope.listen(close,'click',()=>this.close());
    this.scope.listen(clear,'click',()=>{this.state.clearBeforeTs=Date.now();this.clearPresentation?.();this.lastSeenId=null;this.unread=0;this.#persist();this.render();});
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
    if(!this.mounted)return;const d=this.document,snap=this.#visibleFeed(this.readFeed?.()??{events:[],counts:{},status:{}});
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
      const count=id==='ALL'?Number(snap?.counts?.ALL??0):Number(snap?.counts?.[id]??0);
      const b=element(this.document,'button',{className:'nexus-activity-tab',attrs:{type:'button','aria-pressed':String(this.tab===id)},dataset:{tab:id,selected:String(this.tab===id)}});
      b.append(element(this.document,'span',{text:TAB_LABELS[id]}),element(this.document,'span',{className:'nexus-activity-tab__count',text:String(count)}));
      this.renderScope.listen(b,'click',()=>{this.tab=id;this.render();});
      tabs.append(b);
    }
  }
  #renderStatus(snap){
    const s=snap?.status??{},root=this.nodes.status;root.replaceChildren();
    const add=(label,state,value=null)=>{const row=element(this.document,'div',{className:'nexus-activity-status__item',dataset:{state:String(state??'unknown').toLowerCase()}});row.append(element(this.document,'span',{className:'nexus-activity-status__dot'}),element(this.document,'strong',{text:label}),element(this.document,'span',{text:value==null?humanState(state):String(value)}));root.append(row);};
    add('Main',s.main?.state);add('A',s.A?.state);add('B',s.B?.state);add('Running',Number(s.running)>0?'working':'idle',s.running??0);add('Queued',Number(s.queued)>0?'queued':'idle',s.queued??0);
  }
  #renderList(snap){
    const events=(snap?.events??[]).filter(row=>this.tab==='ALL'||row.tab===this.tab).slice(-180).reverse(),list=this.nodes.list;list.replaceChildren();
    if(!events.length){list.append(element(this.document,'div',{className:'nexus-activity-list__empty',text:'No activity in this view yet.'}));return;}
    for(const row of events){
      const item=element(this.document,'article',{className:'nexus-activity-row',dataset:{level:row.level,tone:row.tone,source:row.sourceId}});
      const tone=element(this.document,'span',{className:'nexus-activity-row__tone'});
      const icon=element(this.document,'span',{className:'nexus-activity-row__icon',text:row.icon||'◌'});
      const source=element(this.document,'span',{className:'nexus-activity-row__source',text:row.source});
      const summary=element(this.document,'span',{className:'nexus-activity-row__summary',text:row.summary});
      const time=element(this.document,'time',{className:'nexus-activity-row__time',text:formatTime(row.ts),attrs:{datetime:new Date(row.ts||0).toISOString()}});
      item.append(tone,icon,source,summary,time);
      if(row.detail)item.title=row.detail;
      list.append(item);
    }
  }
  #renderOrb(snap){
    const latest=snap?.events?.at?.(-1)??null;this.nodes.orb.dataset.level=latest?.level??'info';this.nodes.orb.dataset.tone=latest?.tone??'blue';this.nodes.orb.dataset.active=String(Number(snap?.status?.running??0)>0||['working','queued'].includes(snap?.status?.A?.state)||['working','queued'].includes(snap?.status?.B?.state));
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
  #visibleFeed(snapshot={}){
    const events=(snapshot?.events??[]).filter(row=>Number(row?.ts??0)>Number(this.state.clearBeforeTs??0));
    const counts={ALL:events.length,MEMORY:0,PROPOSALS:0,SYSTEM:0};
    for(const row of events)counts[row.tab]=(counts[row.tab]??0)+1;
    return{...snapshot,events,counts,latestEventId:events.at(-1)?.id??null,latestEventTs:events.at(-1)?.ts??null};
  }
  #persist(){this.stateStore?.save?.({activityFeed:{orbX:this.state.orbX,orbY:this.state.orbY,panelX:this.state.panelX,panelY:this.state.panelY,panelW:this.state.panelW,panelH:this.state.panelH,clearBeforeTs:this.state.clearBeforeTs}});}
}
function clamp(value,min,max){return Math.max(min,Math.min(max,Number(value)||0));}
function numberOrNull(value){const n=Number(value);return Number.isFinite(n)?n:null;}
function finiteOr(value,fallback){const n=Number(value);return Number.isFinite(n)?n:fallback;}
function humanState(value){const s=String(value??'').toLowerCase();return s?s.replace(/_/g,' '):'unknown';}
function formatTime(value){const d=new Date(Number(value)||0);if(Number.isNaN(d.getTime()))return'';return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
export function createActivityFeedController(options){return new ActivityFeedController(options);}
