import { ResourceScope } from './lifecycle.js';
import { Signals } from './constants.js';
import { FrontFaceMode } from './wave6-presentation.js';
import { createButton, element } from './primitives.js';

export const WAVE13_FLOATING_NAV_VERSION='1.1.0';
const RAIL_WIDTH=136,NARROW_RAIL_WIDTH=112,EDGE=8,MIN_CARD=180,MINIMIZED_CARD_WIDTH=260,MAX_CARD=1360;

export class VerticalRailPopoutController{
  constructor({frontFaceController,shell,presentation,signals,scheduler,stateStore,workspaceRegistry,productName='Nexus',viewportProvider=null}={}){
    if(!frontFaceController||!shell||!presentation||!signals||!scheduler||!workspaceRegistry)throw new TypeError('Wave 13 floating navigation requires mounted UI.Core services');
    this.frontFaceController=frontFaceController;this.shell=shell;this.presentation=presentation;this.signals=signals;this.scheduler=scheduler;this.stateStore=stateStore;
    this.workspaceRegistry=workspaceRegistry;this.productName=productName;this.viewportProvider=viewportProvider;
    this.scope=new ResourceScope();this.navScope=new ResourceScope();this.nodes={};this.mounted=false;this.drag=null;
    const persisted=this.stateStore?.load?.().wave13FloatingNavigation??{};
    this.state={
      railX:numberOrNull(persisted.railX),railY:numberOrNull(persisted.railY),
      side:['LEFT','RIGHT'].includes(persisted.side)?persisted.side:'LEFT',
      minimized:Boolean(persisted.minimized),
      scrollByWorkspace:{...(persisted.scrollByWorkspace??{})},
    };
  }

  mount(){
    if(this.mounted)return this;this.mounted=true;
    const nodes=this.frontFaceController.nodes,d=nodes.root.ownerDocument;
    const rail=element(d,'aside',{className:'nexus-wave13-rail',attrs:{'aria-label':this.productName+' navigation'},dataset:{wave13Rail:''}});
    const railHandle=element(d,'button',{className:'nexus-wave13-drag-handle',text:'Nexus',attrs:{type:'button','aria-label':'Move Nexus navigation and panel',title:'Drag to move Nexus. Arrow keys also move it.'}});
    const nav=element(d,'nav',{className:'nexus-wave13-rail__nav',attrs:{'aria-label':'Product sections'}});
    const card=element(d,'section',{className:'nexus-wave13-popout',attrs:{role:'region','aria-label':this.productName+' section panel'},dataset:{side:this.state.side}});
    const cardHead=element(d,'header',{className:'nexus-wave13-popout__head'});
    const cardHandle=element(d,'button',{className:'nexus-wave13-popout__drag',text:'⠿',attrs:{type:'button','aria-label':'Move Nexus panel and navigation',title:'Drag to move the attached Nexus panel and navigation together.'}});
    const title=element(d,'strong',{className:'nexus-wave13-popout__title',text:'Home'});
    const controls=element(d,'div',{className:'nexus-wave13-popout__controls'});
    const minimize=createButton(d,{label:this.state.minimized?'Expand':'Collapse',ariaLabel:this.state.minimized?'Expand section panel':'Collapse section panel',className:'nexus-wave13-text-button',scope:this.scope,onPress:()=>this.toggleMinimized()});
    const close=createButton(d,{label:'Close',ariaLabel:'Close section panel',className:'nexus-wave13-text-button',scope:this.scope,onPress:()=>this.close()});
    controls.append(minimize,close);cardHead.append(cardHandle,title,controls);
    const cardBody=element(d,'div',{className:'nexus-wave13-popout__body'});
    const sideResizeHandle=element(d,'button',{className:'nexus-wave13-popout__side-resize',text:'',attrs:{type:'button','aria-label':'Resize section panel from side edge',title:'Drag the outside edge left or right to resize. Arrow keys resize when focused.'}});
    const resizeHandle=element(d,'button',{className:'nexus-wave13-popout__resize',text:'↔ Resize',attrs:{type:'button','aria-label':'Resize section panel',title:'Drag left or right to resize. Arrow keys resize when focused.'}});
    cardBody.append(nodes.expanded);card.append(cardHead,cardBody,sideResizeHandle,resizeHandle);
    nodes.root.replaceChildren(rail,card);rail.append(railHandle,nav);
    nodes.root.classList.add('nexus-wave13-floating-product');
    this.nodes={rail,railHandle,nav,card,cardHead,cardHandle,title,controls,minimize,close,cardBody,sideResizeHandle,resizeHandle};
    this.shell.root.classList.add('nexus-wave13-shell');
    this.#syncNav();
    this.scope.add(this.workspaceRegistry.subscribe(()=>this.#syncNav()));
    this.scope.add(this.presentation.subscribe(()=>this.scheduleLayout()));
    this.scope.subscribe(this.signals,Signals.UI_WORKSPACE_CHANGED,({payload})=>{
      this.#syncSelected(payload.workspaceId);this.#updateTitle(payload.workspaceId);this.open();
      this.scheduler.invalidate('wave13:restore-scroll',()=>this.#restoreScroll(payload.workspaceId),{cost:'CHEAP'});
    });
    this.#bindAssemblyDrag(railHandle);
    this.#bindAssemblyDrag(cardHandle);
    this.#bindMoveKeys(railHandle);
    this.#bindMoveKeys(cardHandle);
    this.#bindResize(resizeHandle);
    this.#bindResize(sideResizeHandle);
    this.scope.listen(this.shell.nodes.workspace,'scroll',()=>this.#rememberScroll(this.shell.currentWorkspace));
    this.scope.listen(d,'keydown',(event)=>{
      if(event.key==='Escape'&&this.presentation.get().frontFaceMode===FrontFaceMode.EXPANDED){event.preventDefault?.();this.close();}
    });
    const win=d.defaultView??globalThis.window;
    if(win&&typeof win.addEventListener==='function'){
      this.scope.listen(win,'resize',()=>this.scheduleLayout());
      this.scope.listen(win,'orientationchange',()=>this.scheduleLayout());
    }
    this.#ensureInitialPosition();
    this.#applyLayout();
    this.#syncSelected(this.shell.currentWorkspace);
    this.#updateTitle(this.shell.currentWorkspace);
    this.#restoreScroll(this.shell.currentWorkspace);
    return this;
  }

  open(workspaceId=null){
    if(workspaceId&&this.workspaceRegistry.has(workspaceId)&&workspaceId!==this.shell.currentWorkspace){
      this.#rememberScroll(this.shell.currentWorkspace);
      this.shell.selectWorkspace(workspaceId);
    }
    if(this.presentation.get().frontFaceMode!==FrontFaceMode.EXPANDED)this.presentation.patch({frontFaceMode:FrontFaceMode.EXPANDED});
    else this.scheduleLayout();
  }

  close(){
    this.#rememberScroll(this.shell.currentWorkspace);
    if(this.presentation.get().frontFaceMode!==FrontFaceMode.COLLAPSED)this.presentation.patch({frontFaceMode:FrontFaceMode.COLLAPSED});
    const selected=[...(this.nodes.nav?.querySelectorAll?.('[data-workspace-id]')??[])].find(x=>x.dataset.workspaceId===this.shell.currentWorkspace);
    (selected??this.nodes.railHandle)?.focus?.();
  }

  toggleMinimized(){
    this.state.minimized=!this.state.minimized;this.#persist();this.#applyLayout();
  }

  resize(delta){
    const p=this.presentation.get(),vp=this.#viewport(),rail=this.#railSize(),max=Math.max(MIN_CARD,Math.min(MAX_CARD,vp.width-rail.width-EDGE*2));
    this.presentation.setWidth(Math.max(MIN_CARD,Math.min(max,Number(p.frontFaceWidth)+Number(delta||0))));
  }

  scheduleLayout(){this.scheduler.invalidate('wave13:floating-layout',()=>this.#applyLayout(),{cost:'CHEAP'});}

  diagnostics(){
    const vp=this.#viewport(),p=this.presentation.get(),rail=this.#railSize(),card=this.#cardGeometry();
    return Object.freeze({kind:'Wave13FloatingNavigationDiagnostics',contractVersion:WAVE13_FLOATING_NAV_VERSION,mounted:this.mounted,workspace:this.shell.currentWorkspace,mode:p.frontFaceMode,rail:{x:this.state.railX,y:this.state.railY,width:rail.width},card:{x:card.x,y:card.y,width:card.width,height:card.height,requestedWidth:p.frontFaceWidth,side:this.state.side,minimized:this.state.minimized,attached:true},viewport:vp,dragging:Boolean(this.drag),scrollTop:Number(this.shell.nodes.workspace?.scrollTop??0)});
  }

  destroy(){
    if(!this.mounted)return;this.#rememberScroll(this.shell.currentWorkspace);this.mounted=false;this.drag=null;this.navScope.cleanup();this.scope.cleanup();
    this.shell.root?.classList?.toggle?.('nexus-wave13-shell',false);this.nodes={};
  }

  #syncNav(){
    const nav=this.nodes.nav;if(!nav)return;this.navScope.cleanup();this.navScope=new ResourceScope();nav.replaceChildren();
    const entries=this.workspaceRegistry.list({navigationLevel:'product'}).sort((a,b)=>(a.navigation?.order??0)-(b.navigation?.order??0)||a.registrationSequence-b.registrationSequence);
    for(const entry of entries){
      const button=element(nav.ownerDocument,'button',{className:'nexus-wave13-rail__item',attrs:{type:'button','aria-label':entry.title,title:entry.title},dataset:{workspaceId:entry.id}});
      button.append(element(nav.ownerDocument,'span',{className:'nexus-wave13-rail__icon',text:entry.icon||entry.title.slice(0,1),attrs:{'aria-hidden':'true'}}),element(nav.ownerDocument,'span',{className:'nexus-wave13-rail__label',text:railLabel(entry)}));
      this.navScope.listen(button,'click',()=>this.open(entry.id));
      this.navScope.listen(button,'keydown',(event)=>{
        if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault?.();
        const items=[...(nav.querySelectorAll?.('[data-workspace-id]')??[])],index=items.indexOf(button);
        const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowDown'?(index+1)%items.length:(index-1+items.length)%items.length;
        items[next]?.focus?.();
      });
      nav.append(button);
    }
    this.#syncSelected(this.shell.currentWorkspace);
  }

  #syncSelected(id){
    for(const button of this.nodes.nav?.querySelectorAll?.('[data-workspace-id]')??[]){
      const selected=button.dataset.workspaceId===id;button.classList.toggle('is-selected',selected);button.setAttribute('aria-current',selected?'page':'false');
    }
  }

  #updateTitle(id){
    if(!this.nodes.title)return;
    try{
      const entry=this.workspaceRegistry.get(id);
      this.nodes.title.textContent=entry?.title??'Nexus';
      const preferred=Number(entry?.preferredWidth);
      if(Number.isFinite(preferred)&&preferred>0&&this.presentation.get().frontFaceWidth<preferred)this.presentation.setWidth(preferred);
    }catch{this.nodes.title.textContent='Nexus';}
  }

  #ensureInitialPosition(){
    const vp=this.#viewport(),rail=this.#railSize();
    if(this.state.railX==null){const rect=this.frontFaceController.host?.getBoundingClientRect?.();this.state.railX=Number.isFinite(rect?.left)&&rect.left>0?rect.left:Math.max(EDGE,vp.width-rail.width-EDGE);}
    if(this.state.railY==null){const rect=this.frontFaceController.host?.getBoundingClientRect?.();this.state.railY=Number.isFinite(rect?.top)?Math.max(EDGE,rect.top):Math.max(EDGE,Math.min(vp.height-rail.height,72));}
    this.#clampRail();this.#chooseSide();this.#persist();
  }

  #viewport(){
    const d=this.nodes.rail?.ownerDocument??this.frontFaceController.host?.ownerDocument,win=d?.defaultView??globalThis.window,supplied=this.viewportProvider?.();
    const width=Math.max(280,Number(supplied?.width??win?.innerWidth??d?.documentElement?.clientWidth??d?.body?.clientWidth??1280)||1280);
    const height=Math.max(320,Number(supplied?.height??win?.innerHeight??d?.documentElement?.clientHeight??d?.body?.clientHeight??800)||800);
    return{width,height};
  }

  #railSize(){
    const vp=this.#viewport(),count=this.workspaceRegistry.list({navigationLevel:'product'}).length,width=vp.width<=520?NARROW_RAIL_WIDTH:RAIL_WIDTH;
    return{width,height:Math.max(260,Math.min(vp.height-EDGE*2,58+(count*42)))};
  }

  #clampRail(){
    const vp=this.#viewport(),size=this.#railSize();
    this.state.railX=clamp(this.state.railX,EDGE,Math.max(EDGE,vp.width-size.width-EDGE));
    this.state.railY=clamp(this.state.railY,EDGE,Math.max(EDGE,vp.height-size.height-EDGE));
  }

  #chooseSide(){
    const vp=this.#viewport(),rail=this.#railSize(),right=vp.width-(this.state.railX+rail.width)-EDGE,left=this.state.railX-EDGE;
    this.state.side=right>=left?'RIGHT':'LEFT';
  }

  #cardGeometry(){
    const vp=this.#viewport(),rail=this.#railSize(),p=this.presentation.get();
    this.#chooseSide();
    const room=Math.max(80,this.state.side==='RIGHT'?vp.width-(this.state.railX+rail.width)-EDGE:this.state.railX-EDGE);
    const requestedWidth=this.state.minimized?MINIMIZED_CARD_WIDTH:(Number(p.frontFaceWidth)||560);
    const width=Math.max(80,Math.min(requestedWidth,MAX_CARD,room));
    const height=this.state.minimized?48:Math.max(220,Math.min(vp.height-EDGE*2,Math.round(vp.height*.82)));
    const x=this.state.side==='RIGHT'?this.state.railX+rail.width:this.state.railX-width;
    const y=clamp(this.state.railY,EDGE,Math.max(EDGE,vp.height-height-EDGE));
    return{x:clamp(x,EDGE,Math.max(EDGE,vp.width-width-EDGE)),y,width,height};
  }

  #applyLayout(){
    if(!this.mounted)return;this.#clampRail();const p=this.presentation.get(),rail=this.#railSize(),card=this.#cardGeometry();
    if(p.frontFaceMode===FrontFaceMode.EXPANDED&&!this.state.minimized)this.shell.flushPendingWorkspaceRefresh?.();
    this.frontFaceController.nodes.root.style.width=rail.width+'px';
    this.nodes.rail.style.left=this.state.railX+'px';this.nodes.rail.style.top=this.state.railY+'px';this.nodes.rail.style.width=rail.width+'px';this.nodes.rail.style.maxHeight=rail.height+'px';
    this.nodes.card.style.left=card.x+'px';this.nodes.card.style.top=card.y+'px';this.nodes.card.style.width=card.width+'px';this.nodes.card.style.height=card.height+'px';
    this.nodes.card.dataset.side=this.state.side;this.nodes.card.dataset.minimized=String(this.state.minimized);
    this.nodes.card.style.display=p.frontFaceMode===FrontFaceMode.EXPANDED?'':'none';this.nodes.cardBody.style.display=this.state.minimized?'none':'';
    this.nodes.resizeHandle.style.display=this.state.minimized?'none':'';this.nodes.sideResizeHandle.style.display=this.state.minimized?'none':'';
    this.nodes.minimize.textContent=this.state.minimized?'Expand':'Collapse';this.nodes.minimize.setAttribute('aria-label',this.state.minimized?'Expand section panel':'Collapse section panel');
    this.frontFaceController.nodes.expanded.style.display=p.frontFaceMode===FrontFaceMode.EXPANDED?'':'none';this.#persist();
  }

  #bindAssemblyDrag(handle){
    this.scope.listen(handle,'pointerdown',(event)=>{
      if(event.button!=null&&event.button!==0)return;event.preventDefault?.();handle.setPointerCapture?.(event.pointerId);
      this.drag={target:'assembly',startX:Number(event.clientX??0),startY:Number(event.clientY??0),originX:this.state.railX,originY:this.state.railY,pointerId:event.pointerId??null};
    });
    const doc=handle.ownerDocument;
    this.scope.listen(doc,'pointermove',(event)=>{
      if(!this.drag||this.drag.target!=='assembly')return;
      this.state.railX=this.drag.originX+Number(event.clientX??0)-this.drag.startX;this.state.railY=this.drag.originY+Number(event.clientY??0)-this.drag.startY;
      this.#clampRail();this.#applyLayout();
    });
    this.scope.listen(doc,'pointerup',(event)=>{if(this.drag?.target==='assembly'){handle.releasePointerCapture?.(event.pointerId);this.drag=null;this.#persist();}});
    this.scope.listen(doc,'pointercancel',()=>{if(this.drag?.target==='assembly')this.drag=null;});
  }

  #bindMoveKeys(handle){
    this.scope.listen(handle,'keydown',(event)=>{
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault?.();
      const step=event.shiftKey?48:16;this.state.railX+=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0;this.state.railY+=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;
      this.#clampRail();this.#applyLayout();
    });
  }

  #bindResize(handle){
    this.scope.listen(handle,'pointerdown',(event)=>{
      if(event.button!=null&&event.button!==0)return;event.preventDefault?.();handle.setPointerCapture?.(event.pointerId);
      this.drag={target:'resize',startX:Number(event.clientX??0),originWidth:Number(this.presentation.get().frontFaceWidth),pointerId:event.pointerId??null,side:this.state.side};
    });
    const doc=handle.ownerDocument;
    this.scope.listen(doc,'pointermove',(event)=>{
      if(!this.drag||this.drag.target!=='resize')return;
      const delta=(Number(event.clientX??0)-this.drag.startX)*(this.drag.side==='RIGHT'?1:-1);this.resizeTo(this.drag.originWidth+delta);
    });
    this.scope.listen(doc,'pointerup',(event)=>{if(this.drag?.target==='resize'){handle.releasePointerCapture?.(event.pointerId);this.drag=null;}});
    this.scope.listen(doc,'pointercancel',()=>{if(this.drag?.target==='resize')this.drag=null;});
    this.scope.listen(handle,'keydown',(event)=>{
      if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault?.();
      const outward=this.state.side==='RIGHT'?event.key==='ArrowRight':event.key==='ArrowLeft';this.resize(outward?(event.shiftKey?120:40):-(event.shiftKey?120:40));
    });
  }

  resizeTo(width){
    const vp=this.#viewport(),rail=this.#railSize(),max=Math.max(MIN_CARD,Math.min(MAX_CARD,vp.width-rail.width-EDGE*2));
    this.presentation.setWidth(Math.max(MIN_CARD,Math.min(max,Number(width)||MIN_CARD)));
  }

  #rememberScroll(id){if(!id||!this.shell.nodes.workspace)return;this.state.scrollByWorkspace[id]=Math.max(0,Number(this.shell.nodes.workspace.scrollTop??0));this.#persist();}
  #restoreScroll(id){if(!id||!this.shell.nodes.workspace)return;this.shell.nodes.workspace.scrollTop=Math.max(0,Number(this.state.scrollByWorkspace[id]??0));}
  #persist(){this.stateStore?.save?.({wave13FloatingNavigation:{railX:this.state.railX,railY:this.state.railY,side:this.state.side,minimized:this.state.minimized,scrollByWorkspace:{...this.state.scrollByWorkspace}}});}
}

export function createVerticalRailPopoutController(options){return new VerticalRailPopoutController(options);}
function railLabel(entry){if(entry.id==='story')return'Story';if(entry.id==='world-tree')return'World Tree';if(entry.id==='world-product')return'World';return String(entry.title??entry.id).replace(/\s*\/\s*Scene$/,'');}
function clamp(value,min,max){return Math.max(min,Math.min(max,Number(value)||0));}
function numberOrNull(value){return Number.isFinite(Number(value))?Number(value):null;}
