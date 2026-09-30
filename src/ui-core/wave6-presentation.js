import { createButton, element, makeBadge, makeHealthPill } from './primitives.js';
import { ProductDataMode, Wave6Health, authorityDescriptor, createProductSourceStatus, healthStatusToken } from './wave6-contracts.js';

export const FrontFaceMode=Object.freeze({COLLAPSED:'COLLAPSED',EXPANDED:'EXPANDED'});
export const FrontFaceDensity=Object.freeze({COMPACT:'COMPACT',COMFORTABLE:'COMFORTABLE'});
export const WorkspaceComposition=Object.freeze({COMPACT:'COMPACT',DASHBOARD:'DASHBOARD',INSPECTOR_HEAVY:'INSPECTOR_HEAVY'});
export const MotionMode=Object.freeze({SYSTEM:'SYSTEM',FULL:'FULL',REDUCED:'REDUCED'});
export const LoreMotionMode=MotionMode;

const MODES=new Set(Object.values(FrontFaceMode)),DENSITIES=new Set(Object.values(FrontFaceDensity)),MOTION_MODES=new Set(Object.values(MotionMode));
const DEFAULTS=Object.freeze({frontFaceMode:FrontFaceMode.COLLAPSED,frontFaceWidth:560,frontFaceDensity:FrontFaceDensity.COMPACT,inspectorVisible:false,inspectorWidth:320,lastProductWorkspace:'home',motionMode:MotionMode.FULL});

export class FrontFacePresentationState{
  #listeners=new Set();
  constructor({stateStore,defaults={}}={}){
    this.stateStore=stateStore??null;const persisted=this.stateStore?.load?.()??{},migrated={...persisted};
    if(migrated.motionMode==null&&migrated.loreMotionMode!=null)migrated.motionMode=migrated.loreMotionMode;
    delete migrated.loreMotionMode;
    const migratedDefaults={...defaults};if(migratedDefaults.motionMode==null&&migratedDefaults.loreMotionMode!=null)migratedDefaults.motionMode=migratedDefaults.loreMotionMode;delete migratedDefaults.loreMotionMode;
    const merged={...DEFAULTS,...migratedDefaults,...migrated};
    this.state=normalize(merged);
  }
  get(){return structuredCloneSafe(this.state);}
  patch(patch={}){
    const next=normalize({...this.state,...patch});if(JSON.stringify(next)===JSON.stringify(this.state))return this.get();
    this.state=next;this.stateStore?.save?.(next);for(const listener of [...this.#listeners]){try{listener(this.get());}catch{}}return this.get();
  }
  toggle(){return this.patch({frontFaceMode:this.state.frontFaceMode===FrontFaceMode.COLLAPSED?FrontFaceMode.EXPANDED:FrontFaceMode.COLLAPSED});}
  setWorkspace(id){return this.patch({lastProductWorkspace:String(id||'home')});}
  setWidth(width){return this.patch({frontFaceWidth:width});}
  setInspector(visible,width=this.state.inspectorWidth){return this.patch({inspectorVisible:Boolean(visible),inspectorWidth:width});}
  setDensity(density){return this.patch({frontFaceDensity:density});}
  setMotionMode(mode){return this.patch({motionMode:mode});}
  setLoreMotionMode(mode){return this.setMotionMode(mode);}
  subscribe(listener){if(typeof listener!=='function')throw new TypeError('presentation listener must be a function');this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
}

export class HostAdjacentMountAdapter{
  constructor({reserveWidth=null,releaseWidth=null,onModeChange=null,fixedReservationWidth=null}={}){this.reserveWidth=typeof reserveWidth==='function'?reserveWidth:null;this.releaseWidth=typeof releaseWidth==='function'?releaseWidth:null;this.onModeChange=typeof onModeChange==='function'?onModeChange:null;this.fixedReservationWidth=fixedReservationWidth!=null&&Number.isFinite(Number(fixedReservationWidth))?Math.max(0,Number(fixedReservationWidth)):null;this.reserved=0;}
  apply({mode,width,collapsedWidth=76}={}){
    const collapsed=Number.isFinite(Number(collapsedWidth))?Math.max(0,Number(collapsedWidth)):76;
    const requested=mode===FrontFaceMode.EXPANDED?Number(width)||560:collapsed;const next=this.fixedReservationWidth??requested;
    this.reserveWidth?.(next);this.reserved=next;this.onModeChange?.({mode,width:next});return next;
  }
  destroy(){this.releaseWidth?.(this.reserved);this.reserved=0;}
}

export function createAuthorityPill(doc,authority,{title=null}={}){
  const d=authorityDescriptor(authority);return element(doc,'span',{className:'a52-authority-pill',text:`${d.glyph} ${title??d.label}`,attrs:{role:'status','aria-label':`${d.label}: ${d.description}`},dataset:{authority:d.authority,status:d.status}});
}

export function createProductHealthSurface(doc,{source=null,label=null,impact=null,actionLabel='Inspect details',onInspect=null,scope=null,compact=false}={}){
  const s=source??createProductSourceStatus();const root=element(doc,'section',{className:`a52-health-surface${compact?' a52-health-surface--compact':''}`,attrs:{role:'status'},dataset:{mode:s.mode,health:s.health,status:s.statusToken}});
  const head=element(doc,'div',{className:'a52-health-surface__head'});
  head.append(makeHealthPill(doc,{label:label??s.label??s.health,status:s.statusToken,detail:s.operationalState??s.mode}),makeBadge(doc,s.operationalState??s.mode,modeStatus(s.mode)));
  root.append(head);
  const message=impact??s.impact??s.reason;if(message)root.append(element(doc,'p',{className:'a52-health-surface__impact',text:message}));
  if(s.reason&&!compact)root.append(element(doc,'p',{className:'a52-muted',text:s.reason}));
  if(onInspect)root.append(createButton(doc,{label:actionLabel,scope,size:'sm',variant:'inspect',onPress:onInspect}));
  return root;
}

export function createComposition(doc,{type=WorkspaceComposition.DASHBOARD,primary=null,secondary=[],attention=null,activity=null}={}){
  const root=element(doc,'div',{className:'a52-composition',dataset:{composition:type}});
  if(primary)root.append(region(doc,'primary',primary));
  if(secondary.length){const grid=element(doc,'div',{className:'a52-composition__secondary'});for(const node of secondary)grid.append(node);root.append(grid);}
  if(attention)root.append(region(doc,'attention',attention));if(activity)root.append(region(doc,'activity',activity));return root;
}

export function sourceStateMessage(doc,source,{emptyLabel='No data'}={}){
  const s=source??createProductSourceStatus();const root=element(doc,'section',{className:'a52-state-message',attrs:{role:'status'},dataset:{status:s.statusToken,mode:s.mode}});
  const title=s.operationalState==='WAITING_FOR_TURN'?'Waiting for turn':s.operationalState==='IDLE'?'Idle':s.operationalState==='DISCONNECTED'?'Disconnected':s.mode===ProductDataMode.UNAVAILABLE?'Unavailable':s.mode===ProductDataMode.DEGRADED?'Degraded':s.mode===ProductDataMode.FIXTURE?'Fixture / demo':emptyLabel;
  root.append(element(doc,'strong',{text:title}),element(doc,'span',{text:s.impact||s.reason||'No current data is available.'}));return root;
}

export function sourceModeBadge(doc,source){const s=source??createProductSourceStatus();return makeBadge(doc,s.operationalState??s.mode,modeStatus(s.mode));}
export function statusForHealth(health){return healthStatusToken(health??Wave6Health.UNAVAILABLE);}

function region(doc,name,node){const r=element(doc,'section',{className:`a52-composition__${name}`});r.append(node);return r;}
function modeStatus(mode){if(mode===ProductDataMode.LIVE)return'ready';if(mode===ProductDataMode.DEGRADED)return'warning';if(mode===ProductDataMode.FIXTURE)return'inferred';return'offline';}
export function normalizeMotionMode(value){
  const mode=String(value??MotionMode.FULL).toUpperCase();
  return MOTION_MODES.has(mode)?mode:MotionMode.FULL;
}
export function resolveMotionPolicy(mode,{systemReduced=false}={}){
  const normalized=normalizeMotionMode(mode);
  const reduced=normalized===MotionMode.REDUCED||(normalized===MotionMode.SYSTEM&&Boolean(systemReduced));
  return{mode:normalized,reduced,enabled:!reduced,systemReduced:Boolean(systemReduced),ignoresSystemPreference:normalized===MotionMode.FULL};
}

function normalize(value){
  const mode=MODES.has(value.frontFaceMode)?value.frontFaceMode:DEFAULTS.frontFaceMode;
  const density=DENSITIES.has(value.frontFaceDensity)?value.frontFaceDensity:DEFAULTS.frontFaceDensity;
  const width=Math.max(360,Math.min(1440,Number(value.frontFaceWidth)||DEFAULTS.frontFaceWidth));
  const inspectorWidth=Math.max(240,Math.min(560,Number(value.inspectorWidth)||DEFAULTS.inspectorWidth));
  const motionMode=normalizeMotionMode(value.motionMode??value.loreMotionMode);
  return{frontFaceMode:mode,frontFaceWidth:width,frontFaceDensity:density,inspectorVisible:Boolean(value.inspectorVisible),inspectorWidth,lastProductWorkspace:String(value.lastProductWorkspace||'home'),motionMode};
}
function structuredCloneSafe(value){return typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value));}
