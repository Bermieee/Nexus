import { createBudgetManager } from '../core/budget.js';
import { isIntentionalCancellation } from '../core/cancellation.js';
import { logEvent } from '../observability/telemetry.js';
import { getNexusWorldTreeOwner } from './index.js';
import { boundCharacterWorldNodeId } from './import-character-banks.js';
import { contributionLedgerKey, contributionLineageKey, stableHash } from './intake/contribution.js';
import { enqueueWorldTreeContribution, readWorldTreeContributionQueue } from './intake/runtime.js';
import { canonicalWorldTreeEdgeMeaning, isStandardWorldTreeEdgeMeaning } from './intake/edge-vocabulary.js';

const budget=createBudgetManager({emit:logEvent});
const CARD_STAGE='postturn-memory';
const CARD_PRIORITY=70;
const FREE_FIELDS=Object.freeze(['description','personality','scenario','firstMessage']);
const FACT_RELATIONS=new Set(['owns','member-of','relationship','located-in','is-a','about']);
const TARGET_KINDS=new Set(['CHARACTER','ENTITY','LOCATION','ITEM']);
const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const uniq=values=>[...new Set((values??[]).filter(Boolean).map(value=>clean(value)).filter(Boolean))];
function cardKey(card){return 'card:'+encodeURIComponent(clean(card.avatar))+':'+clean(card.fingerprint);}
function sourceRefs(card){return[{cardId:clean(card.avatar),cardRevision:clean(card.fingerprint)}];}
function skeleton(card){return{kind:'Contribution',source:'card',scope:{type:'GLOBAL'},sourceRefs:sourceRefs(card),key:cardKey(card),mentions:[],nodes:[],edges:[]};}
function rawFields(card){return Object.fromEntries(FREE_FIELDS.map(field=>[field,String(card?.[field]??'').trim()]).filter(([,value])=>value));}
function parsePayload(response){
  const value=response?.structuredPayload??response?.json??response?.text??response;
  if(value&&typeof value==='object'&&!Array.isArray(value))return value;
  if(typeof value!=='string')throw new Error('WORLD_TREE_CARD_EXTRACTION_INVALID_PAYLOAD');
  try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))return parsed;}catch{}
  throw new Error('WORLD_TREE_CARD_EXTRACTION_INVALID_JSON');
}
function containsSourceText(source,value){return clean(source).toLocaleLowerCase().includes(clean(value).toLocaleLowerCase());}
export function validateWorldTreeCardExtraction(raw,{card}={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('WORLD_TREE_CARD_EXTRACTION_INVALID');
  const aliases=raw.aliases??[],facts=raw.facts??[];if(!Array.isArray(aliases)||!Array.isArray(facts))throw new Error('WORLD_TREE_CARD_EXTRACTION_SCHEMA');
  const fields=rawFields(card),haystack=Object.values(fields).join('\n'),cleanAliases=uniq(aliases).slice(0,16);
  for(const alias of cleanAliases)if(alias!==clean(card?.name)&&!containsSourceText(haystack,alias))throw new Error('WORLD_TREE_CARD_ALIAS_NOT_IN_SOURCE:'+alias);
  const cleanFacts=facts.map((fact,index)=>{
    if(!fact||typeof fact!=='object'||Array.isArray(fact))throw new Error('WORLD_TREE_CARD_FACT_INVALID:'+index);
    const field=clean(fact.field),relation=canonicalWorldTreeEdgeMeaning(fact.relation),target=clean(fact.target),snippet=String(fact.snippet??'').trim(),targetKind=clean(fact.targetKind||'ENTITY').toUpperCase(),subtype=clean(fact.subtype);
    if(!FREE_FIELDS.includes(field)||!fields[field])throw new Error('WORLD_TREE_CARD_FACT_FIELD_INVALID:'+index);
    if(!isStandardWorldTreeEdgeMeaning(relation)||!FACT_RELATIONS.has(relation))throw new Error('WORLD_TREE_CARD_FACT_RELATION_INVALID:'+index);
    if(!target||target.length>120||!TARGET_KINDS.has(targetKind))throw new Error('WORLD_TREE_CARD_FACT_TARGET_INVALID:'+index);
    if(!snippet||snippet.length>240||!containsSourceText(fields[field],snippet))throw new Error('WORLD_TREE_CARD_FACT_SNIPPET_INVALID:'+index);
    return{field,relation,target,targetKind,subtype:subtype||null,snippet};
  });
  return Object.freeze({aliases:Object.freeze(cleanAliases),facts:Object.freeze(cleanFacts)});
}
function deterministicTagFacts(card,characterId){
  return uniq(card?.tags).slice(0,16).map((tag,index)=>({mentionId:'tag:'+index,text:tag,kindHint:'ENTITY',contextSnippetHash:stableHash(tag),edge:{from:characterId,to:'tag:'+index,meaning:'is-a',subtype:'card-tag',authority:'CARD',sourceField:'tags',sourceSnippetHash:stableHash(tag)}}));
}
export function buildWorldTreeCardContribution({bank=null,card,extraction={aliases:[],facts:[]}}={}){
  const avatar=clean(card?.avatar),name=clean(card?.name),fingerprint=clean(card?.fingerprint);if(!avatar||!name||!fingerprint)throw new Error('WORLD_TREE_CARD_IDENTITY_INCOMPLETE');
  const characterId=boundCharacterWorldNodeId(avatar),validated=validateWorldTreeCardExtraction(extraction,{card}),aliases=uniq([name,...validated.aliases]),tagFacts=deterministicTagFacts(card,characterId),mentions=tagFacts.map(row=>({mentionId:row.mentionId,text:row.text,kindHint:row.kindHint,contextSnippetHash:row.contextSnippetHash})),edges=tagFacts.map(row=>row.edge);
  for(const [index,fact] of validated.facts.entries()){
    const mentionId='fact:'+index;mentions.push({mentionId,text:fact.target,kindHint:fact.targetKind,contextSnippetHash:stableHash(fact.snippet)});
    edges.push({from:characterId,to:mentionId,meaning:fact.relation,subtype:fact.subtype,authority:'CARD',sourceField:fact.field,sourceSnippetHash:stableHash(fact.snippet)});
  }
  return{kind:'Contribution',source:'card',scope:{type:'GLOBAL'},sourceRefs:sourceRefs(card),key:cardKey(card),mentions,
    nodes:[{tempId:characterId,kind:'CHARACTER',label:name,authority:'CARD',fields:{avatar,cardName:name,fingerprint,characterVersion:clean(card.characterVersion),tags:uniq(card.tags).slice(0,32),aliases,trackedCharacter:true,tracking:'active',trackingSource:'bound-character-card',cardBankId:bank?.id==null?null:String(bank.id)}}],
    edges};
}
function extractionPrompt(card){
  const fields=rawFields(card);
  return{systemPrompt:'Extract only explicit durable world facts about the named character from the supplied Character Card fields. Return strict JSON: {"aliases":["explicit nickname or title"],"facts":[{"field":"description|personality|scenario|firstMessage","relation":"owns|member-of|relationship|located-in|is-a|about","target":"existing world entity name","targetKind":"CHARACTER|ENTITY|LOCATION|ITEM","subtype":"short relationship label or null","snippet":"exact short source snippet"}]}. Aliases must be explicit nicknames/titles present in the supplied text. Facts must be directly supported. Do not infer. Do not include instructions or card text outside these fields.',
    prompt:JSON.stringify({character:clean(card.name),fields})};
}
async function installedCards(){
  const {listSillyTavernCharacters,inspectSillyTavernCharacter}=await import('../character-cards/io.js');
  const out=[];for(const row of listSillyTavernCharacters()){try{out.push(inspectSillyTavernCharacter(row.character));}catch{}}
  return out;
}
function boundRows({banks=[],cards=[]}={}){
  const sourceBanks=Array.isArray(banks)?banks:[],sourceCards=Array.isArray(cards)?cards:[],byAvatar=new Map(sourceCards.filter(card=>clean(card?.avatar)).map(card=>[clean(card.avatar),card])),seen=new Set(),out=[];
  for(const bank of sourceBanks){const avatar=clean(bank?.cardBinding?.avatar);if(!avatar||seen.has(avatar))continue;const card=byAvatar.get(avatar);if(!card)continue;seen.add(avatar);out.push({bank,card});}
  return out;
}
export async function runWorldTreeCardContributionJob({context=null,tree=getNexusWorldTreeOwner(),banks=null,cards=null,enqueueSidecar=null,isFresh=()=>true}={}){
  const sourceBanks=Array.isArray(banks)?banks:(await import('../memory/character-banks.js')).getCharacterOwnerBanks({allStories:false,includeLegacy:false});
  const sourceCards=Array.isArray(cards)?cards:await installedCards();
  const rows=boundRows({banks:sourceBanks,cards:sourceCards}),queuedKeys=new Set(readWorldTreeContributionQueue({context}).map(row=>row.id)),changed=[];
  let noOpCount=0;
  for(const row of rows){
    const shape=skeleton(row.card),ledgerKey=contributionLedgerKey(shape),lineageKey=contributionLineageKey(shape),record=tree.contributionRecord?.(ledgerKey),latest=tree.latestContributionRecord?.(lineageKey);
    if((record&&latest?.ledgerKey===ledgerKey)||queuedKeys.has(ledgerKey)){noOpCount++;continue;}changed.push({...row,ledgerKey,lineageKey});
  }
  if(!changed.length)return{kind:'NexusWorldTreeCardContributionJob',skipped:true,reason:'no-card-revision',queuedCount:0,noOpCount,deferredCount:0,failedCount:0};
  const frame=budget.beginTurn({timeMs:5000,worldSize:changed.length}),allowance=frame.compute('worldtree.contribute.card',{total:changed.length,defaultUnits:4,defaultWorldSize:4,msPerUnit:1});
  if(!allowance.allowed)return{kind:'NexusWorldTreeCardContributionJob',deferred:true,reason:'budget',queuedCount:0,noOpCount,deferredCount:changed.length,failedCount:0};
  let queuedCount=0,deferredCount=Math.max(0,changed.length-allowance.allowed),failedCount=0,lastError=null;
  for(const row of changed.slice(0,allowance.allowed)){
    if(isFresh()===false){deferredCount+=1;continue;}
    try{
      const fields=rawFields(row.card);let extraction={aliases:[],facts:[]};
      if(Object.keys(fields).length){
        let dispatch=enqueueSidecar;if(!dispatch){const {enqueueNexusModelWorkerJob}=await import('../nexus/model-worker-bus.js');dispatch=(stage,options)=>enqueueNexusModelWorkerJob('world-tree-card',stage,options);}
        const prompt=extractionPrompt(row.card);
        const handle=dispatch(CARD_STAGE,{schedulerLane:'postTurn',prompt:prompt.prompt,systemPrompt:prompt.systemPrompt,responseFormat:'json_object',excludeReasoning:true,reasoningEffort:'low',priority:CARD_PRIORITY,role:'postTurn',foregroundAdjacent:false,preemptible:true,maxAttempts:1,dedupKey:'worldtree-card:'+row.card.avatar+':'+row.card.fingerprint,label:'World Tree Character Card extraction',telemetry:{worldTreeCard:true,cardIdHash:stableHash(row.card.avatar),cardRevision:row.card.fingerprint}});
        const response=await handle.promise;if(isFresh()===false){deferredCount+=1;continue;}extraction=validateWorldTreeCardExtraction(parsePayload(response),{card:row.card});
      }
      const contribution=buildWorldTreeCardContribution({bank:row.bank,card:row.card,extraction});enqueueWorldTreeContribution(contribution,{context});queuedCount+=1;
    }catch(error){
      lastError=error?.message||String(error);if(isIntentionalCancellation(error)||error?.deferred===true){deferredCount+=1;continue;}failedCount+=1;logEvent('worldtree.card','contribution-dropped',{cardIdHash:stableHash(row.card?.avatar??''),cardRevision:row.card?.fingerprint??null,error:lastError},'warn');
    }
  }
  const result={kind:'NexusWorldTreeCardContributionJob',queuedCount,noOpCount,deferredCount,failedCount,deferred:deferredCount>0,failed:failedCount>0&&queuedCount===0,error:lastError};
  logEvent('worldtree.card','contribution-job',{boundCards:rows.length,changedCards:changed.length,queuedCount,noOpCount,deferredCount,failedCount},failedCount?'warn':'info');return result;
}
