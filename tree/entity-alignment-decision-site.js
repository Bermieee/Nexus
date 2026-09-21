import { loadBook } from '../lore/store.js';
import { getTree } from './store.js';
import { currentNodeForUid } from './ops.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { DECISION_MODE } from '../decision/constants.js';
import { recordDecisionShadowComparison } from '../decision/telemetry.js';
import { decisionAssistEnabled } from '../decision/mode.js';
import { hashLogicalSource } from '../nexus/large-input-reshape.js';
import { logEvent } from '../observability/telemetry.js';

export const TREE_LORE_ENTITY_ALIGNMENT_SITE_ID='tree-lore.entity-alignment.v1';
export const TREE_LORE_MERGE_LIST_SITE_ID='tree-lore.merge-review-list.v1';
const MAX_EVIDENCE_CHARS=12000;
export const MAX_MERGE_LIST_PAIRS=20;
function clean(v){return String(v??'').trim();}
function title(entry,uid){return clean(entry?.comment||entry?.key?.[0]||`UID ${uid}`);}
function keys(entry){return [...new Set((entry?.key||[]).map(clean).filter(Boolean))];}
function pathForNode(tree,nodeId){
  const wanted=String(nodeId||'');if(!wanted||!tree?.root)return[];let found=[];
  const walk=(node,path=[])=>{if(!node||found.length)return;const next=[...path,clean(node.label||node.id)].filter(Boolean);if(String(node.id)===wanted){found=next;return;}for(const child of node.children||[])walk(child,next);};walk(tree.root,[]);return found;
}
function liveView(book,entry,tree){const uid=Number(entry?.uid),node=currentNodeForUid(tree,uid),content=String(entry?.content||'');return{uid,title:title(entry,uid),content,keywords:keys(entry),treePath:pathForNode(tree,node?.id),nodeId:node?.id||null,disable:entry?.disable===true};}
function pairFingerprint({book,left,right,similarity=null}={}){return hashLogicalSource(JSON.stringify({book:clean(book),left,right,similarity}));}
function bounded(view){return{uid:view.uid,title:view.title,content:view.content,keywords:view.keywords,treePath:view.treePath,nodeId:view.nodeId};}
export function inspectEntityAlignmentEvidence(pair={}){
  const leftChars=String(pair?.left?.content||'').length,rightChars=String(pair?.right?.content||'').length;
  const complete=leftChars<=MAX_EVIDENCE_CHARS&&rightChars<=MAX_EVIDENCE_CHARS;
  return{complete,leftChars,rightChars,maxCharsPerEntry:MAX_EVIDENCE_CHARS,reason:complete?null:'source-exceeds-bounded-evidence-cap'};
}
export function treeLoreEntityAlignmentQuestions(){return{
  same_concept:{type:'noul',instructions:'Are the two lore entries fundamentally about the same entity, event, state, rule, relationship, or concept rather than merely sharing terms?'},
  meaningful_overlap:{type:'score',instructions:'How much durable semantic content meaningfully overlaps between the entries?',criteria:['No durable overlap','Small incidental overlap','Moderate shared facts','Strong overlap with distinct facts','Near-duplicate durable content']},
  contradiction:{type:'noul',instructions:'Do the entries contain materially incompatible claims that require conflict review rather than silent combination?'},
  left_has_unique_facts:{type:'noul',instructions:'Does the left entry contain durable facts not represented by the right entry?'},
  right_has_unique_facts:{type:'noul',instructions:'Does the right entry contain durable facts not represented by the left entry?'},
  evidence_sufficient:{type:'noul',instructions:'Is the supplied bounded evidence sufficient to make a reliable semantic alignment judgment for these two entries?'},
  merge_review_warranted:{type:'noul',instructions:'Would this pair benefit from human Merge Review or a separate merge-synthesis step, without implying authorization to merge?'}
};}
async function currentPair(pair){
  const data=await loadBook(pair.book),entries=Object.values(data?.entries||{}),byUid=new Map(entries.map(e=>[Number(e.uid),e]));const leftEntry=byUid.get(Number(pair.left.uid)),rightEntry=byUid.get(Number(pair.right.uid));
  if(!leftEntry||!rightEntry)return null;const tree=getTree(pair.book);return{book:pair.book,left:liveView(pair.book,leftEntry,tree),right:liveView(pair.book,rightEntry,tree),similarity:pair.similarity||null};
}
export const TREE_LORE_ENTITY_ALIGNMENT_SITE=registerDecisionSite({
  id:TREE_LORE_ENTITY_ALIGNMENT_SITE_ID,subsystem:'tree-lore',mode:DECISION_MODE.ASSIST,priority:45,
  contract:{id:TREE_LORE_ENTITY_ALIGNMENT_SITE_ID,version:1,subsystem:'tree-lore',questions:{same_concept:{type:'noul'},meaningful_overlap:{type:'score'},contradiction:{type:'noul'},left_has_unique_facts:{type:'noul'},right_has_unique_facts:{type:'noul'},evidence_sufficient:{type:'noul'},merge_review_warranted:{type:'noul',required:false}}},
  buildState(pair){const evidence=inspectEntityAlignmentEvidence(pair);if(!evidence.complete){const error=new Error('Tree/Lore entity-alignment evidence exceeds its bounded contract.');error.name='TV2TreeLoreAlignmentEvidenceUnbounded';throw error;}return{book:pair.book,left:bounded(pair.left),right:bounded(pair.right),deterministicSimilarity:pair.similarity||null};},
  buildQuestions(){return treeLoreEntityAlignmentQuestions();},
  getSourceFingerprint(pair){return pairFingerprint(pair);},
  async getCurrentSourceFingerprint(pair){const current=await currentPair(pair);return current?pairFingerprint(current):`missing:${pair.book}:${pair.left.uid}:${pair.right.uid}`;},
  metadata:{decisionClass:'entity-alignment',shadowOnly:false,assist:true,direct:true,boundary:'after-scan-before-review-list',maxEvidenceCharsPerEntry:MAX_EVIDENCE_CHARS},
});

function mergeListFingerprint({book,pairs=[]}={}){
  return hashLogicalSource(JSON.stringify({book:clean(book),pairs:(pairs||[]).map(pair=>({leftUid:Number(pair.left?.uid),rightUid:Number(pair.right?.uid),leftTitle:clean(pair.left?.title),rightTitle:clean(pair.right?.title),leftContent:String(pair.left?.content||''),rightContent:String(pair.right?.content||''),leftNodeId:pair.left?.nodeId||null,rightNodeId:pair.right?.nodeId||null,similarity:pair.similarity||null}))}));
}
function mergeListQuestions(context={}){
  return Object.fromEntries((context.pairs||[]).slice(0,MAX_MERGE_LIST_PAIRS).map((pair,index)=>{
    const statePath=`pairs[${index}]`;
    return [`pair_${index+1}_warranted`,{
      type:'noul',
      instructions:`Evaluate only \`${statePath}\`. Should \`${statePath}.left\` and \`${statePath}.right\` be admitted to human Merge Review? Do not evaluate any other pair in the state.`,
      criteria:{
        true:'The two entries are duplicate or fragmented records of the same canonical entity, relationship, state, event, rule, or concept, and human merge review could reduce duplicate canon without collapsing distinct subjects.',
        false:'The entries are sibling categories, contrasting schools/methods, merely related characters, cause/effect pairs, separate sequential events, or otherwise distinct canon that should remain separate.'
      }
    }];
  }));
}
async function currentMergeListFingerprint(context={}){
  const rows=context.pairs||[];if(!rows.length)return mergeListFingerprint({book:context.book,pairs:[]});
  const data=await loadBook(context.book),entries=Object.values(data?.entries||{}),byUid=new Map(entries.map(e=>[Number(e.uid),e])),tree=getTree(context.book),pairs=[];
  for(const original of rows){const le=byUid.get(Number(original.left?.uid)),re=byUid.get(Number(original.right?.uid));if(!le||!re)return `missing:${context.book}:${original.left?.uid}:${original.right?.uid}`;pairs.push({book:context.book,left:liveView(context.book,le,tree),right:liveView(context.book,re,tree),similarity:original.similarity||null});}
  return mergeListFingerprint({book:context.book,pairs});
}
export const TREE_LORE_MERGE_LIST_SITE=registerDecisionSite({
  id:TREE_LORE_MERGE_LIST_SITE_ID,subsystem:'tree-lore',mode:DECISION_MODE.ASSIST,priority:46,
  contract:{id:TREE_LORE_MERGE_LIST_SITE_ID,version:1,subsystem:'tree-lore',questions:Object.fromEntries(Array.from({length:MAX_MERGE_LIST_PAIRS},(_,i)=>[`pair_${i+1}_warranted`,{type:'noul',required:false}]))},
  buildState(context){return{book:context.book,pairs:(context.pairs||[]).slice(0,MAX_MERGE_LIST_PAIRS).map((pair,index)=>({slot:index+1,left:{uid:pair.left.uid,title:pair.left.title,nodeId:pair.left.nodeId,content:String(pair.left.content||'').slice(0,2400)},right:{uid:pair.right.uid,title:pair.right.title,nodeId:pair.right.nodeId,content:String(pair.right.content||'').slice(0,2400)},similarity:pair.similarity||null}))};},
  buildQuestions:mergeListQuestions,
  getSourceFingerprint(context){return context.sourceFingerprint||mergeListFingerprint(context);},
  getCurrentSourceFingerprint(context){return currentMergeListFingerprint(context);},
  metadata:{decisionClass:'merge-review-list-admission',shadowOnly:false,assist:true,direct:true,boundary:'after-scan-before-review-list',maxPairs:MAX_MERGE_LIST_PAIRS},
});
function record(pair,result){if(!result?.ok||result?.stale)return result;const warranted=Number(result.answers?.merge_review_warranted?.value);recordDecisionShadowComparison({contractId:result.contractId,provider:result.provider,agreement:Number.isFinite(warranted)?warranted>=.5:null,potentialExpensiveLlmCallAvoided:result.providerClass==='typed-decision',details:{surface:'tree-merge-review',pair:{book:pair.book,leftUid:pair.left.uid,rightUid:pair.right.uid},deterministicSimilarity:pair.similarity||null,mergeReviewProbability:Number.isFinite(warranted)?warranted:null,latencyMs:result.latencyMs,usage:result.usage}});return result;}
export async function buildTreeLoreEntityAlignmentPair({book,leftUid,rightUid,similarity=null}={}){
  const data=await loadBook(book),entries=Object.values(data?.entries||{}),byUid=new Map(entries.map(e=>[Number(e.uid),e])),leftEntry=byUid.get(Number(leftUid)),rightEntry=byUid.get(Number(rightUid));if(!leftEntry||!rightEntry)throw new Error(`Entity alignment source UID missing in "${book}".`);const tree=getTree(book);return{book,left:liveView(book,leftEntry,tree),right:liveView(book,rightEntry,tree),similarity};
}
export async function evaluateTreeLoreEntityAlignmentShadow(input,options={}){
  const pair=input?.left?.content!=null?input:await buildTreeLoreEntityAlignmentPair(input);const evidence=inspectEntityAlignmentEvidence(pair);if(!evidence.complete)return{ok:false,skipped:true,reason:'insufficient-evidence',evidence,contractId:TREE_LORE_ENTITY_ALIGNMENT_SITE_ID};
  const result=await evaluateDecisionSite(TREE_LORE_ENTITY_ALIGNMENT_SITE_ID,pair,{mode:DECISION_MODE.SHADOW,...options});return record(pair,result);
}


export async function evaluateTreeLoreEntityAlignmentAssist(input,options={}){
  if(!decisionAssistEnabled())return{ok:false,skipped:true,reason:'assist-off',contractId:TREE_LORE_ENTITY_ALIGNMENT_SITE_ID};
  const pair=input?.left?.content!=null?input:await buildTreeLoreEntityAlignmentPair(input);const evidence=inspectEntityAlignmentEvidence(pair);if(!evidence.complete)return{ok:false,skipped:true,reason:'insufficient-evidence',evidence,contractId:TREE_LORE_ENTITY_ALIGNMENT_SITE_ID};
  return evaluateDecisionSite(TREE_LORE_ENTITY_ALIGNMENT_SITE_ID,pair,{mode:DECISION_MODE.ASSIST,...options});
}

export function applyMergeReviewListDecision(rows=[],result=null,{threshold=0.65}={}){
  const sourceRows=Array.isArray(rows)?rows:[];
  const selected=[],decisions=[];
  sourceRows.forEach((row,index)=>{
    const warranted=Number(result?.answers?.[`pair_${index+1}_warranted`]?.value);
    const admitted=Number.isFinite(warranted)&&warranted>=threshold;
    decisions.push({uidA:Number(row.uidA),uidB:Number(row.uidB),probability:Number.isFinite(warranted)?warranted:null,admitted});
    if(admitted)selected.push({...row,decisionProvider:result?.provider||null,decisionLatencyMs:Number(result?.latencyMs)||0,jevSelected:true,jevProbability:warranted});
  });
  return {selected,decisions,rejectedCount:Math.max(0,sourceRows.length-selected.length)};
}

export async function selectTreeLoreMergeReviewCandidates(book,rows=[],options={}){
  const sourceRows=Array.isArray(rows)?rows:[];
  if(!sourceRows.length)return{handled:true,rows:[],decision:null,reason:'empty-scan'};
  if(!decisionAssistEnabled())return{handled:false,rows:sourceRows,decision:null,reason:'assist-off'};
  if(sourceRows.length>MAX_MERGE_LIST_PAIRS)return{handled:false,rows:sourceRows,decision:null,reason:'candidate-bound-exceeded',candidateCount:sourceRows.length,maxPairs:MAX_MERGE_LIST_PAIRS};
  try{
    const data=await loadBook(book),entries=Object.values(data?.entries||{}),byUid=new Map(entries.map(e=>[Number(e.uid),e])),tree=getTree(book),pairs=[];
    for(const row of sourceRows){
      const leftEntry=byUid.get(Number(row.uidA)),rightEntry=byUid.get(Number(row.uidB));if(!leftEntry||!rightEntry)return{handled:false,rows:sourceRows,decision:null,reason:'source-missing'};
      pairs.push({book,left:liveView(book,leftEntry,tree),right:liveView(book,rightEntry,tree),similarity:{percent:Number(row.percent||0),titlePercent:Number(row.titlePercent||0),contentPercent:Number(row.contentPercent||0),sameNode:row.sameNode===true}});
    }
    const sourceFingerprint=mergeListFingerprint({book,pairs});
    const result=await evaluateDecisionSite(TREE_LORE_MERGE_LIST_SITE_ID,{book,pairs,sourceFingerprint},{mode:DECISION_MODE.ASSIST,...options});
    if(!result?.ok||result?.stale)return{handled:false,rows:sourceRows,decision:result,reason:result?.stale?'stale':'decision-unavailable'};
    const applied=applyMergeReviewListDecision(sourceRows,result);
    logEvent('decision-core','merge-review-list-assist-applied',{book,candidateCount:sourceRows.length,selectedCount:applied.selected.length,rejectedCount:applied.rejectedCount,provider:result.provider||null,latencyMs:Number(result.latencyMs)||0,decisions:applied.decisions},'info');
    return{handled:true,rows:applied.selected,decision:result,decisions:applied.decisions,reason:'assist-success',decisionCalls:1};
  }catch(error){return{handled:false,rows:sourceRows,decision:null,reason:'decision-error',error};}
}

