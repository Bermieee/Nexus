import {
  AuthorityClass, KnowledgeStatus, MutationType, SettlementOutcome,
  createClaim, createProvenance, createSettlementReceipt,
} from './contracts.js';

const slotKey=(subjectId,predicate)=>`${subjectId}::${predicate}`;
const claimTime=(claim)=>Number(claim.temporal?.validFrom??0);
const clone=(x)=>structuredClone(x);

export class TemporalStateGraph {
  #claims=new Map(); #slotClaims=new Map(); #closures=new Map(); #invalidClaims=new Set(); #receipts=[]; #revision=0; #journal=[];
  get revision(){return this.#revision;}

  settleProposal(proposal,registry){
    this.#revision+=1;
    const stale=proposal.freshnessRevisionIds.some(id=>!registry.isActiveRevision(id));
    if(stale)return this.#receipt(proposal,SettlementOutcome.STALE,[],[],'source-revision-not-current');
    try{
      if(proposal.mutationType===MutationType.SET_CLAIM)return this.#settleClaimProposal(proposal);
      if(proposal.mutationType===MutationType.CLOSE_SLOT)return this.#settleClosureProposal(proposal);
      return this.#receipt(proposal,SettlementOutcome.REJECTED,[],[],'unsupported-mutation');
    }catch(error){return this.#receipt(proposal,SettlementOutcome.FAILED,[],[],error.message);}
  }

  #settleClaimProposal(proposal){
    const claim=clone(proposal.payload.claim);if(!claim?.id)throw new Error('SET_CLAIM proposal lacks claim');
    this.#invalidClaims.delete(claim.id);this.#claims.set(claim.id,claim);
    const key=slotKey(claim.subjectId,claim.predicate);const ids=this.#slotClaims.get(key)??[];if(!ids.includes(claim.id))ids.push(claim.id);this.#slotClaims.set(key,ids);
    if(claim.predicate==='state'&&claim.value==='destroyed'&&!this.#hasEarlierState(claim)){
      const inferred=this.#makeInferredPreState(claim);this.#invalidClaims.delete(inferred.id);this.#claims.set(inferred.id,inferred);const stateIds=this.#slotClaims.get(key)??[];if(!stateIds.includes(inferred.id))stateIds.push(inferred.id);this.#slotClaims.set(key,stateIds);
    }
    const superseded=this.#recomputeSlot(key);this.#journal.push({revision:this.#revision,type:'CLAIM_SETTLED',claimId:claim.id,slot:key,at:claimTime(claim)});
    return this.#receipt(proposal,SettlementOutcome.SETTLED,[claim.id],superseded,null);
  }

  #hasEarlierState(claim){
    const key=slotKey(claim.subjectId,claim.predicate);return(this.#slotClaims.get(key)??[]).some(id=>{if(id===claim.id||this.#invalidClaims.has(id))return false;const other=this.#claims.get(id);return other&&claimTime(other)<claimTime(claim)&&![KnowledgeStatus.UNRESOLVED,KnowledgeStatus.UNCERTAIN].includes(other.status);});
  }
  #makeInferredPreState(claim){
    const id=`inferred:${claim.id}:prestate`,sourceRevisionIds=claim.provenance?.sourceRevisionIds??[];
    const provenance=createProvenance({id:`prov:${id}`,sourceRevisionIds,evidenceIds:[claim.id],derivedFromIds:[claim.id],activity:'TEMPORAL_PRECONDITION',agent:'temporal-state-graph',invalidators:[...sourceRevisionIds,claim.id]});
    return createClaim({id,subjectId:claim.subjectId,predicate:'state',value:'intact',temporal:{kind:'HISTORICAL',validFrom:Math.max(0,claimTime(claim)-.001),validUntil:claimTime(claim)},authorityClass:AuthorityClass.INFERRED,confidence:.7,status:KnowledgeStatus.HISTORICAL,provenance,semanticKey:`${claim.subjectId}|state|"intact"`,claimType:'STATE',slotPolicy:'SINGLE',explicitness:'INFERRED_PRECONDITION',evidenceTime:claim.evidenceTime});
  }

  #settleClosureProposal(proposal){
    const closure=clone(proposal.payload);if(!closure?.subjectId||!closure?.predicate||!Number.isFinite(closure.at))throw new Error('CLOSE_SLOT proposal is invalid');
    const key=slotKey(closure.subjectId,closure.predicate),list=this.#closures.get(key)??[];
    const existing=list.findIndex(x=>x.id===closure.id||x.proposalId===proposal.id);const row={...closure,proposalId:proposal.id,sourceRevisionIds:[...proposal.sourceRevisionIds]};if(existing>=0)list[existing]=row;else list.push(row);
    list.sort((a,b)=>a.at-b.at||a.proposalId.localeCompare(b.proposalId));this.#closures.set(key,list);const superseded=this.#recomputeSlot(key);this.#journal.push({revision:this.#revision,type:'SLOT_CLOSED',slot:key,at:closure.at,reason:closure.reason});
    return this.#receipt(proposal,SettlementOutcome.SETTLED,[],superseded,null);
  }

  #closeActive(active,time,superseded,nextClaimId=null){
    for(const id of active){const claim=this.#claims.get(id);if(!claim)continue;const explicitHistorical=claim.temporal.kind==='HISTORICAL';const status=explicitHistorical?KnowledgeStatus.HISTORICAL:KnowledgeStatus.SUPERSEDED;if(status===KnowledgeStatus.SUPERSEDED)superseded.push(id);this.#claims.set(id,{...claim,status,temporal:{...claim.temporal,validUntil:time},supersededBy:nextClaimId});}
  }

  #recomputeSlot(key){
    const ids=(this.#slotClaims.get(key)??[]).filter(id=>!this.#invalidClaims.has(id));
    const claims=ids.map(id=>this.#claims.get(id)).filter(Boolean).sort((a,b)=>claimTime(a)-claimTime(b)||a.id.localeCompare(b.id));
    const closures=(this.#closures.get(key)??[]).filter(c=>c.sourceRevisionIds.every(id=>true)).sort((a,b)=>a.at-b.at||a.proposalId.localeCompare(b.proposalId));
    const superseded=[];

    const multi=claims.filter(c=>c.slotPolicy==='MULTI');
    for(const claim of multi){let status=KnowledgeStatus.CURRENT;if(claim.temporal.kind==='HISTORICAL')status=KnowledgeStatus.HISTORICAL;else if(claim.temporal.kind==='UNRESOLVED'||claim.authorityClass===AuthorityClass.UNRESOLVED)status=KnowledgeStatus.UNRESOLVED;else if(claim.temporal.kind==='UNCERTAIN')status=KnowledgeStatus.UNCERTAIN;this.#claims.set(claim.id,{...claim,status});}

    const single=claims.filter(c=>c.slotPolicy!=='MULTI');
    const explicitHistorical=single.filter(c=>c.temporal.kind==='HISTORICAL');
    for(const claim of explicitHistorical)this.#claims.set(claim.id,{...claim,status:KnowledgeStatus.HISTORICAL});
    const activeCandidates=single.filter(c=>c.temporal.kind!=='HISTORICAL');
    const groups=[];
    for(const claim of activeCandidates){const time=claimTime(claim),last=groups.at(-1);if(last&&last.time===time)last.claims.push(claim);else groups.push({time,claims:[claim]});}
    const timeline=[];for(const g of groups)timeline.push({type:'GROUP',time:g.time,claims:g.claims});for(const c of closures)timeline.push({type:'CLOSURE',time:c.at,closure:c});
    timeline.sort((a,b)=>a.time-b.time||(a.type==='CLOSURE'?-1:1));
    let active=[],activeValue=undefined;
    for(const item of timeline){
      if(item.type==='CLOSURE'){
        if(active.length)this.#closeActive(active,item.time,superseded,null);active=[];activeValue=undefined;continue;
      }
      const group=item.claims,distinct=[...new Set(group.map(c=>JSON.stringify(c.value)))];
      if(distinct.length>1){
        if(active.length&&claimTime(this.#claims.get(active[0]))<item.time)this.#closeActive(active,item.time,superseded,null);
        active=[];activeValue=undefined;
        for(const claim of group){let status=KnowledgeStatus.CONTRADICTED;if(claim.temporal.kind==='UNRESOLVED'||claim.authorityClass===AuthorityClass.UNRESOLVED)status=KnowledgeStatus.UNRESOLVED;else if(claim.temporal.kind==='UNCERTAIN')status=KnowledgeStatus.UNCERTAIN;this.#claims.set(claim.id,{...claim,status,temporal:{...claim.temporal,validUntil:null},contradictedBy:group.filter(x=>x.id!==claim.id).map(x=>x.id).sort(),supersededBy:null});}
        continue;
      }
      const value=distinct[0],assertive=group.filter(c=>!['UNRESOLVED','UNCERTAIN'].includes(c.temporal.kind)&&c.authorityClass!==AuthorityClass.UNRESOLVED),uncertain=group.filter(c=>!assertive.includes(c));
      if(!assertive.length){
        const conflictsActive=active.length&&JSON.stringify(activeValue)!==value;if(conflictsActive){this.#closeActive(active,item.time,superseded,null);active=[];activeValue=undefined;}
        for(const claim of uncertain){const status=claim.temporal.kind==='UNCERTAIN'?KnowledgeStatus.UNCERTAIN:KnowledgeStatus.UNRESOLVED;this.#claims.set(claim.id,{...claim,status,temporal:{...claim.temporal,validUntil:null}});}continue;
      }
      if(active.length&&JSON.stringify(activeValue)!==value){this.#closeActive(active,item.time,superseded,assertive[0].id);active=[];activeValue=undefined;}
      if(!active.length){activeValue=assertive[0].value;}
      for(const claim of assertive){this.#claims.set(claim.id,{...claim,status:KnowledgeStatus.CURRENT,temporal:{...claim.temporal,validUntil:null},supersededBy:null});active.push(claim.id);}
      for(const claim of uncertain){this.#claims.set(claim.id,{...claim,status:claim.temporal.kind==='UNCERTAIN'?KnowledgeStatus.UNCERTAIN:KnowledgeStatus.UNRESOLVED});}
    }
    return[...new Set(superseded)].sort();
  }

  invalidateClaimsBySourceRevision(revisionId){
    const affectedSlots=new Set(),invalidated=[];
    for(const[id,claim]of this.#claims){if((claim.provenance?.sourceRevisionIds??[]).includes(revisionId)){this.#invalidClaims.add(id);invalidated.push(id);affectedSlots.add(slotKey(claim.subjectId,claim.predicate));}}
    for(const[key,closures]of this.#closures){const kept=closures.filter(item=>!item.sourceRevisionIds.includes(revisionId));if(kept.length!==closures.length){this.#closures.set(key,kept);affectedSlots.add(key);}}
    for(const key of affectedSlots)this.#recomputeSlot(key);this.#journal.push({revision:this.#revision,type:'SOURCE_INVALIDATED',sourceRevisionId:revisionId,claimIds:[...invalidated]});return invalidated.sort();
  }

  invalidateClaimsByIdentityRevision(identityRevisionRef){
    const ref=String(identityRevisionRef??'').trim();if(!ref)return[];
    const affectedSlots=new Set(),invalidated=[];
    for(const[id,claim]of this.#claims){if((claim.identityRevisionRefs??[]).includes(ref)){this.#invalidClaims.add(id);invalidated.push(id);affectedSlots.add(slotKey(claim.subjectId,claim.predicate));}}
    for(const key of affectedSlots)this.#recomputeSlot(key);
    if(invalidated.length)this.#journal.push({revision:this.#revision,type:'IDENTITY_REVISION_INVALIDATED',identityRevisionRef:ref,claimIds:[...invalidated].sort()});
    return invalidated.sort();
  }

  #receipt(proposal,outcome,settledArtifactIds,supersededArtifactIds,reason){const receipt=createSettlementReceipt({id:`receipt:${this.#revision}:${proposal.id}`,proposalId:proposal.id,owner:'WORLD_STATE',outcome,settledArtifactIds,supersededArtifactIds,revision:this.#revision,reason});this.#receipts.push(receipt);return clone(receipt);}
  getClaim(claimId){if(this.#invalidClaims.has(claimId))return null;const c=this.#claims.get(claimId);return c?clone(c):null;}
  allClaims({includeInvalid=false}={}){return[...this.#claims.entries()].filter(([id])=>includeInvalid||!this.#invalidClaims.has(id)).map(([,c])=>clone(c));}
  slotClaims(subjectId,predicate,{includeInvalid=false}={}){return(this.#slotClaims.get(slotKey(subjectId,predicate))??[]).filter(id=>includeInvalid||!this.#invalidClaims.has(id)).map(id=>this.#claims.get(id)).filter(Boolean).map(clone);}
  currentClaims(filter={}){return this.allClaims().filter(c=>c.status===KnowledgeStatus.CURRENT&&this.#matches(c,filter));}
  historicalClaims(filter={}){return this.allClaims().filter(c=>[KnowledgeStatus.HISTORICAL,KnowledgeStatus.SUPERSEDED].includes(c.status)&&this.#matches(c,filter));}
  unresolvedClaims(filter={}){return this.allClaims().filter(c=>[KnowledgeStatus.CONTRADICTED,KnowledgeStatus.UNCERTAIN,KnowledgeStatus.UNRESOLVED].includes(c.status)&&this.#matches(c,filter));}
  #matches(claim,filter){return(!filter.subjectId||claim.subjectId===filter.subjectId)&&(!filter.predicate||claim.predicate===filter.predicate);}

  unresolvedState(subjectId,predicate){
    const claims=this.slotClaims(subjectId,predicate);if(claims.some(c=>c.status===KnowledgeStatus.CURRENT))return null;
    const unresolved=claims.filter(c=>[KnowledgeStatus.CONTRADICTED,KnowledgeStatus.UNCERTAIN,KnowledgeStatus.UNRESOLVED].includes(c.status));if(!unresolved.length)return null;
    const maxTime=Math.max(...unresolved.map(claimTime)),latest=unresolved.filter(c=>claimTime(c)===maxTime);
    return{status:KnowledgeStatus.UNRESOLVED,subjectId,predicate,claimIds:latest.map(c=>c.id).sort(),classifications:[...new Set(latest.map(c=>c.status))].sort(),sourceRevisionIds:[...new Set(latest.flatMap(c=>c.provenance?.sourceRevisionIds??[]))].sort()};
  }

  currentProjection(){
    const groups=new Map();for(const claim of this.currentClaims()){const key=`${claim.subjectId}|${claim.predicate}|${JSON.stringify(claim.value)}`;const row=groups.get(key)??{subjectId:claim.subjectId,predicate:claim.predicate,value:claim.value,status:KnowledgeStatus.CURRENT,claimIds:[],sourceRevisionIds:[],identityRevisionRefs:[]};row.claimIds.push(claim.id);row.sourceRevisionIds.push(...(claim.provenance?.sourceRevisionIds??[]));row.identityRevisionRefs.push(...(claim.identityRevisionRefs??[]));groups.set(key,row);}return[...groups.values()].map(r=>({...r,claimIds:[...new Set(r.claimIds)].sort(),sourceRevisionIds:[...new Set(r.sourceRevisionIds)].sort(),identityRevisionRefs:[...new Set(r.identityRevisionRefs)].sort()}));
  }

  readReferences({entityIds=[],limit=128}={}){
    const wanted=new Set((entityIds??[]).filter(Boolean).map(String)),max=Math.max(1,Math.min(512,Number(limit)||128));
    const rows=this.allClaims().filter(c=>!wanted.size||wanted.has(c.subjectId)||wanted.has(String(c.value))).slice(0,max).map(c=>({claimId:c.id,subjectId:c.subjectId,predicate:c.predicate,value:clone(c.value),status:c.status,temporal:clone(c.temporal),authorityClass:c.authorityClass,sourceRevisionIds:[...(c.provenance?.sourceRevisionIds??[])],identityRevisionRefs:[...(c.identityRevisionRefs??[])],readOnly:true}));
    return{kind:'TemporalStateReferenceSet',contractVersion:'1.0.0',worldRevision:this.#revision,references:rows,authorityGranted:false,mutationAuthority:false,settlementAuthority:false};
  }

  timeline(subjectId,predicate){return this.slotClaims(subjectId,predicate).sort((a,b)=>claimTime(a)-claimTime(b)||a.id.localeCompare(b.id));}
  transitions(subjectId,predicate){
    const claims=this.timeline(subjectId,predicate).filter(c=>c.slotPolicy!=='MULTI'&&c.temporal.kind!=='UNRESOLVED'&&c.temporal.kind!=='UNCERTAIN');const rows=[];let previous=null;
    for(const claim of claims){if(previous&&JSON.stringify(previous.value)===JSON.stringify(claim.value))continue;rows.push({subjectId,predicate,from:previous?.value??null,to:claim.value,at:claimTime(claim),claimIds:[claim.id],status:claim.status});previous=claim;}
    const closures=this.#closures.get(slotKey(subjectId,predicate))??[];for(const closure of closures)rows.push({subjectId,predicate,from:previous?.value??null,to:null,at:closure.at,claimIds:[],status:KnowledgeStatus.HISTORICAL,reason:closure.reason});
    return rows.sort((a,b)=>a.at-b.at||String(a.to).localeCompare(String(b.to)));
  }
  neighbors(entityId,{limit=16}={}){const out=[];for(const claim of this.allClaims()){if(claim.subjectId===entityId||claim.value===entityId)out.push(claim);if(out.length>=limit)break;}return out;}
  journal(){return clone(this.#journal);}
  receipts(){return clone(this.#receipts);}

  exportState(){
    return clone({
      kind:'TemporalStateGraphSnapshot',
      claims:[...this.#claims.entries()],
      slotClaims:[...this.#slotClaims.entries()],
      closures:[...this.#closures.entries()],
      invalidClaims:[...this.#invalidClaims],
      receipts:this.#receipts,
      revision:this.#revision,
      journal:this.#journal,
    });
  }

  restoreState(snapshot){
    if(!snapshot||snapshot.kind!=='TemporalStateGraphSnapshot')throw new TypeError('TemporalStateGraphSnapshot is required');
    this.#claims=new Map(clone(snapshot.claims??[]));
    this.#slotClaims=new Map(clone(snapshot.slotClaims??[]));
    this.#closures=new Map(clone(snapshot.closures??[]));
    this.#invalidClaims=new Set(snapshot.invalidClaims??[]);
    this.#receipts=clone(snapshot.receipts??[]);
    this.#revision=Number(snapshot.revision??0);
    this.#journal=clone(snapshot.journal??[]);
    const slots=new Set([...this.#slotClaims.keys(),...this.#closures.keys()]);for(const key of slots)this.#recomputeSlot(key);
    return this.exportState();
  }
}
