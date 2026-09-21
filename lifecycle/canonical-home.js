import { searchTree } from '../retrieval/search-engine.js';
import { loadBook, findEntryByUid } from '../lore/store.js';
import {
  evaluateLifecycleCanonicalHomes,
  lifecycleCanonicalHomeFingerprint,
  MAX_LIFECYCLE_CANONICAL_CLUSTERS,
  MAX_LIFECYCLE_CANONICAL_CANDIDATES,
} from './decision-site.js';

function clean(value){return String(value??'').replace(/\s+/g,' ').trim();}
function clip(value,max=1800){const text=String(value??'');return text.length<=max?text:`${text.slice(0,max)}…`;}
function unique(values=[]){return [...new Set((values||[]).map(String).filter(Boolean))];}
function hashText(value=''){let h=2166136261>>>0;const text=String(value??'');for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');}
function canonicalCandidateFingerprint(row={}){const payload={book:String(row?.book||''),uid:Number(row?.uid),title:String(row?.title||''),content:String(row?.content||'')};const text=JSON.stringify(payload);return `canonical-home-${hashText(text)}-${text.length}`;}

export async function verifyCanonicalHomeCandidateFresh(candidate){
  if(!candidate||!candidate.book||!Number.isInteger(Number(candidate.uid)))return{fresh:false,reason:'invalid-candidate'};
  try{
    const data=await loadBook(String(candidate.book));
    const entry=findEntryByUid(data?.entries,Number(candidate.uid));
    if(!entry)return{fresh:false,reason:'candidate-missing'};
    const current={book:String(candidate.book),uid:Number(candidate.uid),title:String(entry?.comment||entry?.title||''),content:String(entry?.content||'')};
    const currentFingerprint=canonicalCandidateFingerprint(current);
    const expected=String(candidate.canonicalFingerprint||'');
    return{fresh:!!expected&&expected===currentFingerprint,reason:expected===currentFingerprint?'fresh':'candidate-revised',currentFingerprint,expectedFingerprint:expected,current};
  }catch(error){return{fresh:false,reason:'candidate-read-failed',error:error?.message||String(error)};}
}

export function normalizeDurableEvidenceClusters(rows=[]){
  return (Array.isArray(rows)?rows:[]).map((row,index)=>({
    id:clean(row?.id||`cluster-${index+1}`),
    kind:clean(row?.kind||'fact'),
    statement:clean(row?.statement||row?.text||''),
    sourceIndices:unique(row?.source_indices||row?.sourceIndices||[]).map(Number).filter(Number.isInteger),
    sourceIds:unique(row?.source_message_ids||row?.sourceIds||[]),
  })).filter(row=>row.statement);
}

export async function attachCanonicalHomeCandidates(clusters=[],{books=[],limit=MAX_LIFECYCLE_CANONICAL_CANDIDATES}={}){
  const allowedBooks=unique(books);
  const out=[];
  for(const cluster of normalizeDurableEvidenceClusters(clusters)){
    const rows=await searchTree({query:cluster.statement,books:allowedBooks.length?allowedBooks:null,includeContent:true,limit:Math.max(1,Math.min(MAX_LIFECYCLE_CANONICAL_CANDIDATES,Number(limit)||MAX_LIFECYCLE_CANONICAL_CANDIDATES))});
    out.push({...cluster,candidates:(rows||[]).filter(row=>!allowedBooks.length||allowedBooks.includes(String(row?.book||''))).slice(0,MAX_LIFECYCLE_CANONICAL_CANDIDATES).map(row=>({
      book:String(row?.book||''),uid:Number(row?.uid),nodeId:row?.nodeId==null?null:String(row.nodeId),title:String(row?.title||''),path:Array.isArray(row?.path)?row.path.map(String).slice(0,8):[],content:clip(row?.content||'',1800),score:Number(row?.score)||0,canonicalFingerprint:canonicalCandidateFingerprint(row),
    }))});
  }
  return out;
}

export async function resolveCanonicalHomePlan({clusters=[],books=[],chatId='',sourceKind='durable-lore',sourceRange=null,sourceVersion='',policy={},readCurrentSourceFingerprint=null}={}){
  const withCandidates=await attachCanonicalHomeCandidates(clusters,{books});
  const resolutions=[];
  for(let offset=0;offset<withCandidates.length;offset+=MAX_LIFECYCLE_CANONICAL_CLUSTERS){
    const batch=withCandidates.slice(offset,offset+MAX_LIFECYCLE_CANONICAL_CLUSTERS);
    const context={chatId,sourceKind,sourceRange,sourceVersion,clusters:batch,policy:{oneEvidenceClusterOneCanonicalHome:true,automaticAuthorityOnly:true,...policy}};
    context.sourceFingerprint=lifecycleCanonicalHomeFingerprint(context);
    if(typeof readCurrentSourceFingerprint==='function')context.readCurrentSourceFingerprint=async()=>{
      const fresh=await readCurrentSourceFingerprint();
      return fresh===false||fresh==null?`stale:${context.sourceFingerprint}`:context.sourceFingerprint;
    };
    const decision=await evaluateLifecycleCanonicalHomes(context);
    if(!decision?.handled)return{handled:false,reason:decision?.reason||'canonical-home-decision-unavailable',clusters:withCandidates,resolutions,decision};
    for(let index=0;index<decision.resolutions.length;index++){
      const resolution=decision.resolutions[index];
      if(resolution?.disposition==='EXISTING_HOME'){
        const freshness=await verifyCanonicalHomeCandidateFresh(resolution.candidate);
        if(!freshness.fresh)return{handled:false,reason:'canonical-home-candidate-stale',clusters:withCandidates,resolutions,decision,staleCandidate:{clusterId:resolution.clusterId,book:resolution.candidate?.book||null,uid:resolution.candidate?.uid??null,freshness}};
      }
      resolutions.push({...resolution,cluster:batch[index]});
    }
  }
  return{handled:true,reason:'resolved',clusters:withCandidates,resolutions};
}
