import { GeneralStatus, KnowledgeStatus, RuntimeStatus } from './constants.js';
import { ProductHealth } from './wave5-product-model.js';

export const ProductDataMode = Object.freeze({
  LIVE:'LIVE',
  DEGRADED:'DEGRADED',
  UNAVAILABLE:'UNAVAILABLE',
  FIXTURE:'FIXTURE',
});

export const Wave6Health = Object.freeze({
  READY:'READY',
  WORKING:'WORKING',
  DEGRADED:'DEGRADED',
  STALE:'STALE',
  BLOCKED:'BLOCKED',
  UNAVAILABLE:'UNAVAILABLE',
  IDLE:'IDLE',
});

export const AuthorityVisualClass = Object.freeze({
  SOURCE_CANON:'SOURCE_CANON',
  OBSERVED:'OBSERVED',
  SETTLED:'SETTLED',
  CURRENT:'CURRENT',
  INFERRED:'INFERRED',
  UNRESOLVED:'UNRESOLVED',
  UNCERTAIN:'UNCERTAIN',
  HISTORICAL:'HISTORICAL',
  SUPERSEDED:'SUPERSEDED',
  SHADOW:'SHADOW',
  EXPERIMENTAL:'EXPERIMENTAL',
});

const MODE = new Set(Object.values(ProductDataMode));
const HEALTH = new Set(Object.values(Wave6Health));
const HEALTH_MAP = new Map([
  [GeneralStatus.READY,Wave6Health.READY],[GeneralStatus.LOADING,Wave6Health.WORKING],[GeneralStatus.STALE,Wave6Health.STALE],
  [GeneralStatus.WARNING,Wave6Health.DEGRADED],[GeneralStatus.ERROR,Wave6Health.BLOCKED],[GeneralStatus.OFFLINE,Wave6Health.UNAVAILABLE],
  [RuntimeStatus.ACTIVE,Wave6Health.WORKING],[RuntimeStatus.YIELDING,Wave6Health.WORKING],[RuntimeStatus.PARKED,Wave6Health.IDLE],
  [RuntimeStatus.BLOCKED,Wave6Health.BLOCKED],[RuntimeStatus.RECOVERING,Wave6Health.WORKING],[RuntimeStatus.COMPLETE,Wave6Health.READY],[RuntimeStatus.STALE,Wave6Health.STALE],
  [ProductHealth.READY,Wave6Health.READY],[ProductHealth.CURRENT,Wave6Health.READY],[ProductHealth.LEARNING,Wave6Health.WORKING],
  [ProductHealth.STUDYING,Wave6Health.WORKING],[ProductHealth.INITIALIZING,Wave6Health.WORKING],[ProductHealth.DEGRADED,Wave6Health.DEGRADED],
  [ProductHealth.BLOCKED,Wave6Health.BLOCKED],[ProductHealth.UNAVAILABLE,Wave6Health.UNAVAILABLE],[ProductHealth.IDLE,Wave6Health.IDLE],
  ['healthy',Wave6Health.READY],['ready',Wave6Health.READY],['loading',Wave6Health.WORKING],['warning',Wave6Health.DEGRADED],
  ['degraded',Wave6Health.DEGRADED],['stale',Wave6Health.STALE],['blocked',Wave6Health.BLOCKED],['error',Wave6Health.BLOCKED],
  ['offline',Wave6Health.UNAVAILABLE],['unavailable',Wave6Health.UNAVAILABLE],['idle',Wave6Health.IDLE],
]);

const HEALTH_STATUS = Object.freeze({
  [Wave6Health.READY]:'ready',[Wave6Health.WORKING]:'loading',[Wave6Health.DEGRADED]:'warning',
  [Wave6Health.STALE]:'stale',[Wave6Health.BLOCKED]:'error',[Wave6Health.UNAVAILABLE]:'offline',[Wave6Health.IDLE]:'historical',
});
const AUTHORITY = Object.freeze({
  SOURCE_CANON:{label:'SOURCE CANON',glyph:'◆',status:'canonical',description:'Direct source authority.'},
  OBSERVED:{label:'OBSERVED',glyph:'◉',status:'observed',description:'Directly observed evidence.'},
  SETTLED:{label:'SETTLED',glyph:'✓',status:'canonical',description:'Settled by the owning authority.'},
  CURRENT:{label:'CURRENT',glyph:'✓',status:'canonical',description:'Current settled state.'},
  INFERRED:{label:'INFERRED',glyph:'✦',status:'inferred',description:'Derived interpretation, not settled truth.'},
  UNRESOLVED:{label:'UNRESOLVED',glyph:'◇',status:'warning',description:'Competing evidence remains unresolved.'},
  UNCERTAIN:{label:'UNCERTAIN',glyph:'?',status:'warning',description:'Evidence is insufficient for a settled state.'},
  HISTORICAL:{label:'HISTORICAL',glyph:'◷',status:'historical',description:'Historically valid, not current.'},
  SUPERSEDED:{label:'SUPERSEDED',glyph:'◷',status:'historical',description:'Replaced by a newer state.'},
  SHADOW:{label:'SHADOW',glyph:'◫',status:'inferred',description:'Non-authoritative shadow evaluation.'},
  EXPERIMENTAL:{label:'EXPERIMENTAL',glyph:'⚗',status:'inferred',description:'Experimental, non-authoritative result.'},
});

const authorityAliases = new Map([
  [KnowledgeStatus.CANONICAL,'SOURCE_CANON'],[KnowledgeStatus.OBSERVED,'OBSERVED'],[KnowledgeStatus.CURRENT,'CURRENT'],
  [KnowledgeStatus.INFERRED,'INFERRED'],[KnowledgeStatus.UNRESOLVED,'UNRESOLVED'],[KnowledgeStatus.UNCERTAIN,'UNCERTAIN'],
  [KnowledgeStatus.HISTORICAL,'HISTORICAL'],[KnowledgeStatus.SUPERSEDED,'SUPERSEDED'],
  ['SOURCE_CANON','SOURCE_CANON'],['CANONICAL','SOURCE_CANON'],['SETTLED','SETTLED'],['CURRENT','CURRENT'],
  ['OBSERVED','OBSERVED'],['INFERRED','INFERRED'],['INFERRED_CONTEXT','INFERRED'],['UNRESOLVED','UNRESOLVED'],
  ['UNCERTAIN','UNCERTAIN'],['HISTORICAL','HISTORICAL'],['SUPERSEDED','SUPERSEDED'],['SHADOW','SHADOW'],['EXPERIMENTAL','EXPERIMENTAL'],
]);

export function normalizeWave6Health(value,{fallback=Wave6Health.UNAVAILABLE}={}){
  if(HEALTH.has(value))return value;
  return HEALTH_MAP.get(value)??HEALTH_MAP.get(String(value??'').toLowerCase())??fallback;
}

export function healthStatusToken(value){return HEALTH_STATUS[normalizeWave6Health(value)]??'offline';}

export function createProductSourceStatus({mode=ProductDataMode.UNAVAILABLE,health=null,label=null,impact='',reason='',producer=null,revision=null,connected=null,operationalState=null,selection=null,freshness=null,errorCode=null}={}){
  if(!MODE.has(mode))throw new TypeError(`Unsupported product data mode: ${mode}`);
  const normalizedHealth=normalizeWave6Health(health??(mode===ProductDataMode.LIVE?Wave6Health.READY:mode===ProductDataMode.DEGRADED?Wave6Health.DEGRADED:mode===ProductDataMode.FIXTURE?Wave6Health.READY:Wave6Health.UNAVAILABLE));
  return deepFreeze({
    kind:'ProductSourceStatus',mode,health:normalizedHealth,statusToken:healthStatusToken(normalizedHealth),
    label:label??mode,impact:String(impact??''),reason:String(reason??''),producer:producer??null,revision:revision??null,
    operationalState:operationalState??null,selection:selection==null?null:clone(selection),freshness:freshness??null,errorCode:errorCode??null,
    connected:connected??(mode===ProductDataMode.LIVE||mode===ProductDataMode.DEGRADED),fixture:mode===ProductDataMode.FIXTURE,
  });
}

export function authorityDescriptor(value){
  const key=authorityAliases.get(value)??authorityAliases.get(String(value??'').toUpperCase())??'UNRESOLVED';
  return deepFreeze({kind:'AuthorityDescriptor',authority:key,...AUTHORITY[key]});
}

export function impactFirstHealth({health,available=true,label='Available',impact='',reason='',action='Inspect'}={}){
  const state=available?normalizeWave6Health(health,{fallback:Wave6Health.READY}):Wave6Health.UNAVAILABLE;
  return deepFreeze({
    kind:'ImpactFirstHealth',state,statusToken:healthStatusToken(state),
    label:label||state,impact:String(impact??''),reason:String(reason??''),action:String(action??'Inspect'),
    available:state!==Wave6Health.UNAVAILABLE,
  });
}

export function sourceModeFrom(status){return status?.mode??ProductDataMode.UNAVAILABLE;}

export function assertFixtureNotLive(status){
  if(status?.fixture===true&&status?.mode===ProductDataMode.LIVE)throw new TypeError('Fixture-backed state cannot report LIVE');
  return true;
}

export function deepFreeze(value){
  if(!value||typeof value!=='object'||Object.isFrozen(value))return value;
  Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);return value;
}

export function clone(value){return value==null?value:typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value));}
