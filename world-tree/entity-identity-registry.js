// Ported from Bermieee/Area-52 main@670da42fe8e6da29c6148f09ba2c2af23e40031b; retained as a Nexus World Tree primitive.
import {stableHash} from './area52-browser-runtime-utils.js';

const clone=(value)=>value==null?value:structuredClone(value);
const uniq=(values)=>[...new Set((values??[]).filter(Boolean).map(String))].sort();
const req=(value,name)=>{if(typeof value!=='string'||!value.trim())throw new TypeError(name+' must be a non-empty string');return value.trim();};
const clean=(value)=>String(value??'').trim();
const labelKey=(value)=>clean(value).toLocaleLowerCase().replace(/\s+/g,' ');
const sourceKey=(providerId,sourceEntityId)=>req(providerId,'providerId')+'|'+req(sourceEntityId,'sourceEntityId');
const currentAlias=(row)=>row&&row.current!==false&&row.status!=='RETIRED'&&row.status!=='INVALIDATED';
const authoritativeOrigins=new Set(['SOURCE_EXPLICIT','OWNER_EXPLICIT','OPERATOR']);
const mutatingActions=new Set(['LINK','UNLINK','ALIAS_ADD','ALIAS_RETIRE']);

export const IdentityProposalAction=Object.freeze({
  LINK:'LINK',UNLINK:'UNLINK',MERGE:'MERGE',SPLIT:'SPLIT',ALIAS_ADD:'ALIAS_ADD',ALIAS_RETIRE:'ALIAS_RETIRE',AMBIGUOUS:'AMBIGUOUS',UNRESOLVED:'UNRESOLVED',
});
export const IdentityResolutionState=Object.freeze({
  PROPOSED:'PROPOSED',LINKED:'LINKED',UNLINKED:'UNLINKED',ALIAS_ADDED:'ALIAS_ADDED',ALIAS_RETIRED:'ALIAS_RETIRED',
  DEFERRED:'DEFERRED',REJECTED:'REJECTED',UNRESOLVED:'UNRESOLVED',INVALIDATED:'INVALIDATED',
});

function normalizedType(value){const x=clean(value||'UNKNOWN').toUpperCase();return x||'UNKNOWN';}
function compatibleDimension(a,b){return !a||!b||a==='UNKNOWN'||b==='UNKNOWN'||String(a)===String(b);}
const identityRevisionRef=(entityId,revision)=>String(entityId)+'@'+Math.max(1,Number(revision)||1);
function aliasTemporalMatch(row,{temporalMode='CURRENT',at=null}={}){
  const mode=String(temporalMode??'CURRENT').toUpperCase();
  if(mode!=='HISTORICAL')return currentAlias(row);
  const applicability=row?.temporalApplicability??null;
  if(at==null||!applicability)return true;
  const point=Number(at),from=applicability.validFrom==null?-Infinity:Number(applicability.validFrom),until=applicability.validUntil==null?Infinity:Number(applicability.validUntil);
  return Number.isFinite(point)&&point>=from&&point<=until;
}

export class NativeEntityIdentityRegistry{
  constructor({snapshot=null,maxProposals=2048,maxHistory=4096}={}){
    this.maxProposals=Math.max(64,Number(maxProposals)||2048);
    this.maxHistory=Math.max(128,Number(maxHistory)||4096);
    this.entities=new Map();
    this.sourceLinks=new Map();
    this.proposals=new Map();
    this.proposalOrder=[];
    this.settlements=[];
    this.sequence=0;
    this.activeStoryId=null;
    if(snapshot)this.restoreState(snapshot);
  }

  // Story isolation. An identity registered by a story-scoped owner (for example Lore, whose read authority is
  // per story) carries the stories that may see it. Global identities (no scope) are visible everywhere. A scoped
  // identity is hidden when no story is active or the story is not in its scope (fail closed). The identity
  // record and its history are kept; only visibility is scoped.
  setActiveStory(storyId){this.activeStoryId=storyId==null||storyId===''?null:String(storyId);return this.activeStoryId;}
  #visible(entity,storyId){
    const scope=entity?.storyScopeIds??[];if(!scope.length)return true;
    const story=storyId??this.activeStoryId;return story!=null&&scope.includes(String(story));
  }

  registerIdentity({
    entityId,canonicalLabel,entityType='UNKNOWN',worldId=null,providerId='CORE',sourceEntityId=null,
    aliases=[],sourceRevisionRefs=[],provenanceRefs=[],authorityOrigin='OWNER_EXPLICIT',metadata={},storyScopeId=null,
  }={}){
    const id=req(entityId,'entityId'),label=req(canonicalLabel,'canonicalLabel'),type=normalizedType(entityType),world=worldId==null?null:String(worldId);
    const existing=this.entities.get(id);
    if(existing){
      const ownerCharacterPromotion=type==='CHARACTER'&&['OWNER_EXPLICIT','OPERATOR'].includes(String(authorityOrigin))&&['UNKNOWN','ENTITY','LORE_FACT'].includes(String(existing.entityType??'UNKNOWN'));
      const sameIdentity=existing.canonicalLabel===label&&(compatibleDimension(existing.entityType,type)||ownerCharacterPromotion)&&compatibleDimension(existing.worldId,world);
      if(!sameIdentity)throw new Error('ENTITY_IDENTITY_CONFLICT:'+id);
      if(ownerCharacterPromotion&&existing.entityType!=='CHARACTER'){existing.entityType='CHARACTER';existing.revision=Math.max(1,Number(existing.revision)||1)+1;existing.updatedSequence=++this.sequence;}
      // A global identity stays global; a scoped identity gains the additional story.
      if(storyScopeId!=null&&(existing.storyScopeIds??[]).length){existing.storyScopeIds=[...new Set([...existing.storyScopeIds,String(storyScopeId)])].sort();}
      if(sourceEntityId)this.#linkSource(existing,{providerId,sourceEntityId,sourceRevisionRefs,provenanceRefs,authorityOrigin});
      for(const alias of aliases)this.#addAlias(existing,{alias,sourceRevisionRefs,provenanceRefs,authorityOrigin,providerId,sourceEntityId});
      return clone(existing);
    }
    const row={
      kind:'EntityIdentity',contractVersion:'1.0.0',entityId:id,canonicalLabel:label,entityType:type,worldId:world,
      aliases:[],sourceLinks:[],revision:1,status:'CURRENT',authorityOrigin,storyScopeIds:storyScopeId==null?[]:[String(storyScopeId)],
      sourceRevisionRefs:uniq(sourceRevisionRefs),provenanceRefs:uniq(provenanceRefs),metadata:clone(metadata),
      createdSequence:++this.sequence,updatedSequence:this.sequence,
    };
    this.entities.set(id,row);
    if(sourceEntityId)this.#linkSource(row,{providerId,sourceEntityId,sourceRevisionRefs,provenanceRefs,authorityOrigin});
    for(const alias of aliases)this.#addAlias(row,{alias,sourceRevisionRefs,provenanceRefs,authorityOrigin,providerId,sourceEntityId});
    return clone(row);
  }

  propose({
    proposalId=null,action=IdentityProposalAction.UNRESOLVED,providerId='UNKNOWN',sourceEntityId=null,label=null,
    targetEntityId=null,candidateEntityIds=[],worldId=null,entityType='UNKNOWN',alias=null,
    authorityOrigin='HEURISTIC',explicit=false,confidence=null,sourceRevisionRefs=[],provenanceRefs=[],
    temporalApplicability=null,context={},negativeIdentityEvidence=false,reason=null,
  }={}){
    const act=String(action??IdentityProposalAction.UNRESOLVED).toUpperCase();
    if(!Object.values(IdentityProposalAction).includes(act))throw new TypeError('Unsupported identity proposal action: '+act);
    const provider=req(providerId,'providerId'),source=sourceEntityId==null?null:String(sourceEntityId),name=clean(alias??label);
    const target=targetEntityId==null?null:String(targetEntityId);
    const candidates=uniq(candidateEntityIds.length?candidateEntityIds:this.candidateEntities({label:name,worldId,entityType}).map(x=>x.entityId));
    if(target&&!candidates.includes(target))candidates.push(target);
    candidates.sort();
    const targetRow=target?this.entities.get(target):null;
    let recommendation='DEFER',code='IDENTITY_EVIDENCE_INSUFFICIENT';
    if(negativeIdentityEvidence){recommendation='REJECT';code='EXPLICIT_NON_IDENTITY_EVIDENCE';}
    else if(target&&!targetRow){recommendation='REJECT';code='TARGET_ENTITY_UNKNOWN';}
    else if(targetRow&&!compatibleDimension(targetRow.worldId,worldId)){recommendation='REJECT';code='WORLD_IDENTITY_MISMATCH';}
    else if(targetRow&&!compatibleDimension(targetRow.entityType,normalizedType(entityType))){recommendation='REJECT';code='ENTITY_TYPE_MISMATCH';}
    else if(['MERGE','SPLIT'].includes(act)){recommendation='DEFER';code='OWNER_SETTLEMENT_REQUIRED';}
    else if(mutatingActions.has(act)&&explicit&&authoritativeOrigins.has(String(authorityOrigin))&&targetRow){
      const provenanceReady=uniq(provenanceRefs).length>0&&(String(authorityOrigin)==='OPERATOR'||uniq(sourceRevisionRefs).length>0);
      if(provenanceReady){recommendation='LINK';code='EXPLICIT_IDENTITY_EVIDENCE';}
      else{recommendation='DEFER';code='EXPLICIT_IDENTITY_PROVENANCE_REQUIRED';}
    }else if(act==='AMBIGUOUS'||candidates.length>1){recommendation='DEFER';code='AMBIGUOUS_IDENTITY_SET';}
    else if(act==='UNRESOLVED'){recommendation='DEFER';code='IDENTITY_UNRESOLVED';}
    else if(['MODEL','MODEL_GUESS','GRAPH_PROXIMITY','RETRIEVAL_COACTIVATION','HEURISTIC'].includes(String(authorityOrigin))){
      recommendation='DEFER';code='NON_AUTHORITATIVE_IDENTITY_SIGNAL';
    }
    const id=proposalId??('identity-proposal:'+stableHash({act,provider,source,name,target,candidates,worldId,entityType,sourceRevisionRefs,provenanceRefs},{length:24}));
    const proposal={
      kind:'IdentityResolutionProposal',contractVersion:'1.0.0',proposalId:id,action:act,providerId:provider,sourceEntityId:source,
      label:name||null,alias:clean(alias)||null,targetEntityId:target,candidateEntityIds:candidates,worldId:worldId==null?null:String(worldId),
      entityType:normalizedType(entityType),authorityOrigin:String(authorityOrigin),explicit:Boolean(explicit),
      confidence:confidence==null?null:Math.max(0,Math.min(1,Number(confidence)||0)),sourceRevisionRefs:uniq(sourceRevisionRefs),
      provenanceRefs:uniq(provenanceRefs),temporalApplicability:clone(temporalApplicability),context:clone(context),
      negativeIdentityEvidence:Boolean(negativeIdentityEvidence),recommendation,recommendationCode:code,
      reason:reason==null?code:String(reason),state:IdentityResolutionState.PROPOSED,createdSequence:++this.sequence,
      canonicalMutation:false,settlementAuthority:false,modelAuthority:false,retrievalAuthority:false,graphAuthority:false,
    };
    this.proposals.set(id,proposal);this.proposalOrder.push(id);this.#bound();
    return clone(proposal);
  }

  settle(proposalId,{decision='ACCEPT',settlementAuthority='CORE_IDENTITY_SETTLEMENT',reason=null}={}){
    const proposal=this.proposals.get(req(proposalId,'proposalId'));if(!proposal)throw new Error('Unknown identity proposal: '+proposalId);
    const accepted=String(decision).toUpperCase()==='ACCEPT';
    let state=IdentityResolutionState.REJECTED,applied=false,code='IDENTITY_PROPOSAL_REJECTED';
    const entity=proposal.targetEntityId?this.entities.get(proposal.targetEntityId):null;
    if(!accepted){state=IdentityResolutionState.REJECTED;code='SETTLEMENT_REJECTED';}
    else if(proposal.recommendation==='REJECT'){state=IdentityResolutionState.REJECTED;code=proposal.recommendationCode;}
    else if(proposal.recommendation!=='LINK'||!mutatingActions.has(proposal.action)){
      state=proposal.action==='AMBIGUOUS'||proposal.candidateEntityIds.length>1?IdentityResolutionState.UNRESOLVED:IdentityResolutionState.DEFERRED;
      code=proposal.recommendationCode;
    }else if(!proposal.explicit||!authoritativeOrigins.has(proposal.authorityOrigin)){
      state=IdentityResolutionState.DEFERRED;code='NON_AUTHORITATIVE_IDENTITY_SIGNAL';
    }else if(!entity){state=IdentityResolutionState.REJECTED;code='TARGET_ENTITY_UNKNOWN';}
    else{
      if(proposal.action==='LINK'){
        if(!proposal.sourceEntityId){state=IdentityResolutionState.REJECTED;code='SOURCE_ENTITY_ID_REQUIRED';}
        else{this.#linkSource(entity,proposal);state=IdentityResolutionState.LINKED;applied=true;code='EXPLICIT_LINK_SETTLED';}
      }else if(proposal.action==='UNLINK'){
        if(!proposal.sourceEntityId){state=IdentityResolutionState.REJECTED;code='SOURCE_ENTITY_ID_REQUIRED';}
        else{this.#unlinkSource(entity,proposal);state=IdentityResolutionState.UNLINKED;applied=true;code='EXPLICIT_UNLINK_SETTLED';}
      }else if(proposal.action==='ALIAS_ADD'){
        if(!proposal.alias&&!proposal.label){state=IdentityResolutionState.REJECTED;code='ALIAS_REQUIRED';}
        else{this.#addAlias(entity,{...proposal,alias:proposal.alias??proposal.label});if(proposal.sourceEntityId)this.#linkSource(entity,proposal);state=IdentityResolutionState.ALIAS_ADDED;applied=true;code='EXPLICIT_ALIAS_SETTLED';}
      }else if(proposal.action==='ALIAS_RETIRE'){
        const retired=this.#retireAlias(entity,proposal.alias??proposal.label,proposal);
        state=retired?IdentityResolutionState.ALIAS_RETIRED:IdentityResolutionState.REJECTED;applied=retired;code=retired?'EXPLICIT_ALIAS_RETIRED':'ALIAS_NOT_FOUND';
      }
    }
    const next={...proposal,state,settledSequence:++this.sequence,settlementAuthority:String(settlementAuthority),settlementReason:reason??code,canonicalMutation:applied};
    this.proposals.set(proposal.proposalId,next);
    const receipt={
      kind:'IdentityResolutionReceipt',contractVersion:'1.0.0',proposalId:proposal.proposalId,action:proposal.action,state,applied,
      entityId:proposal.targetEntityId,candidateEntityIds:[...proposal.candidateEntityIds],sourceRevisionRefs:[...proposal.sourceRevisionRefs],
      provenanceRefs:[...proposal.provenanceRefs],reasonCode:code,settlementAuthority:String(settlementAuthority),
      modelAuthority:false,retrievalAuthority:false,graphAuthority:false,
    };
    this.settlements.push(receipt);while(this.settlements.length>this.maxHistory)this.settlements.shift();
    return clone(receipt);
  }

  candidateEntities({label,worldId=null,entityType='UNKNOWN',includeRetiredAliases=false,temporalMode='CURRENT',at=null,storyId=null}={}){
    const key=labelKey(label);if(!key)return[];
    const type=normalizedType(entityType),out=[],historical=String(temporalMode??'CURRENT').toUpperCase()==='HISTORICAL';
    for(const entity of this.entities.values()){
      if(!this.#visible(entity,storyId))continue;
      if(!compatibleDimension(entity.worldId,worldId)||!compatibleDimension(entity.entityType,type))continue;
      const canonical=!historical&&labelKey(entity.canonicalLabel)===key;
      const aliases=(entity.aliases??[]).filter(row=>historical?aliasTemporalMatch(row,{temporalMode:'HISTORICAL',at}):(includeRetiredAliases||currentAlias(row))).filter(row=>labelKey(row.alias)===key);
      if(canonical||aliases.length)out.push({entityId:entity.entityId,canonicalLabel:entity.canonicalLabel,entityType:entity.entityType,worldId:entity.worldId,canonicalLabelMatch:canonical,aliasMatches:clone(aliases)});
    }
    return out.sort((a,b)=>a.entityId.localeCompare(b.entityId));
  }

  resolveSource({providerId,sourceEntityId,storyId=null}={}){
    const key=sourceKey(providerId,sourceEntityId),link=this.sourceLinks.get(key);
    if(!link||link.current===false)return null;
    const entity=this.entities.get(link.entityId);return entity&&this.#visible(entity,storyId)?{kind:'EntityResolution',state:'RESOLVED_SOURCE_LINK',entity:clone(entity),link:clone(link)}:null;
  }

  resolveMention({providerId=null,sourceEntityId=null,label=null,worldId=null,entityType='UNKNOWN',temporalMode='CURRENT',at=null,storyId=null}={}){
    const historical=String(temporalMode??'CURRENT').toUpperCase()==='HISTORICAL';
    if(!historical&&providerId&&sourceEntityId){const direct=this.resolveSource({providerId,sourceEntityId,storyId});if(direct)return direct;}
    const candidates=this.candidateEntities({label,worldId,entityType,temporalMode,at,storyId});
    const aliasBacked=candidates.filter(row=>row.aliasMatches.length);
    if(candidates.length===1&&aliasBacked.length===1)return{kind:'EntityResolution',state:historical?'RESOLVED_HISTORICAL_ALIAS':'RESOLVED_ACCEPTED_ALIAS',entity:clone(this.entities.get(aliasBacked[0].entityId)),candidateEntityIds:[aliasBacked[0].entityId],aliasMatches:clone(aliasBacked[0].aliasMatches)};
    return{kind:'EntityResolution',state:candidates.length?'UNRESOLVED':'NOT_FOUND',entity:null,candidateEntityIds:candidates.map(x=>x.entityId)};
  }

  normalizeRef(ref,{providerId='CORE',worldId=null,entityType='UNKNOWN',storyId=null}={}){
    if(ref==null)return{entityId:null,resolved:false,state:'EMPTY',sourceRef:null};
    if(typeof ref==='string'){
      if(this.entities.has(ref)&&this.#visible(this.entities.get(ref),storyId))return{entityId:ref,resolved:true,state:'CANONICAL_ID',sourceRef:ref};
      const result=this.resolveMention({label:ref,worldId,entityType,storyId});
      if(result.entity)return{entityId:result.entity.entityId,resolved:true,state:result.state,sourceRef:ref};
      return{entityId:String(providerId)+'::'+ref,resolved:false,state:result.state,sourceRef:ref,candidateEntityIds:result.candidateEntityIds??[]};
    }
    if(ref.canonicalEntityId&&this.entities.has(String(ref.canonicalEntityId))&&this.#visible(this.entities.get(String(ref.canonicalEntityId)),storyId))return{entityId:String(ref.canonicalEntityId),resolved:true,state:'EXPLICIT_CANONICAL_REF',sourceRef:clone(ref)};
    const sourceEntityId=ref.sourceEntityId??ref.entityId??ref.characterId??ref.objectId??ref.id??ref.ref??null;
    const provider=ref.providerId??providerId;
    if(sourceEntityId){
      const direct=this.resolveSource({providerId:String(provider),sourceEntityId:String(sourceEntityId),storyId});
      if(direct)return{entityId:direct.entity.entityId,resolved:true,state:'RESOLVED_SOURCE_LINK',sourceRef:clone(ref)};
    }
    const result=this.resolveMention({providerId:provider,sourceEntityId,label:ref.label??ref.name??ref.canonicalName,worldId:ref.worldId??worldId,entityType:ref.entityType??entityType,storyId});
    if(result.entity)return{entityId:result.entity.entityId,resolved:true,state:result.state,sourceRef:clone(ref)};
    const local=sourceEntityId?String(provider)+'::'+String(sourceEntityId):String(provider)+'::mention:'+stableHash(ref,{length:16});
    return{entityId:local,resolved:false,state:result.state,sourceRef:clone(ref),candidateEntityIds:result.candidateEntityIds??[]};
  }

  invalidateSourceRevision(sourceRevisionId,{reason='SOURCE_REVISION_INVALIDATED'}={}){
    const ref=req(sourceRevisionId,'sourceRevisionId'),affectedEntityIds=[],retiredAliases=[],retiredLinks=[],invalidatedIdentityRevisionRefs=[];
    for(const entity of this.entities.values()){
      let changed=false;const priorIdentityRevisionRef=identityRevisionRef(entity.entityId,entity.revision);
      for(const alias of entity.aliases??[]){
        if(currentAlias(alias)&&(alias.sourceRevisionRefs??[]).includes(ref)){alias.current=false;alias.status='INVALIDATED';alias.invalidatedBy=ref;alias.invalidationReason=reason;retiredAliases.push(alias.alias);changed=true;}
      }
      for(const link of entity.sourceLinks??[]){
        if(link.current!==false&&(link.sourceRevisionRefs??[]).includes(ref)){link.current=false;link.status='INVALIDATED';link.invalidatedBy=ref;link.invalidationReason=reason;this.sourceLinks.delete(sourceKey(link.providerId,link.sourceEntityId));retiredLinks.push(link.providerId+'|'+link.sourceEntityId);changed=true;}
      }
      if(changed){invalidatedIdentityRevisionRefs.push(priorIdentityRevisionRef);entity.revision+=1;entity.updatedSequence=++this.sequence;affectedEntityIds.push(entity.entityId);}
    }
    const invalidatableProposalStates=new Set([IdentityResolutionState.PROPOSED,IdentityResolutionState.DEFERRED,IdentityResolutionState.UNRESOLVED]);
    for(const proposal of this.proposals.values()){
      if(invalidatableProposalStates.has(proposal.state)&&(proposal.sourceRevisionRefs??[]).includes(ref))this.proposals.set(proposal.proposalId,{...proposal,state:IdentityResolutionState.INVALIDATED,invalidationReason:reason});
    }
    return{kind:'IdentityRevisionInvalidationReceipt',sourceRevisionId:ref,affectedEntityIds:uniq(affectedEntityIds),retiredAliases:uniq(retiredAliases),retiredLinks:uniq(retiredLinks),invalidatedIdentityRevisionRefs:uniq(invalidatedIdentityRevisionRefs),currentIdentityRevisionRefs:uniq(affectedEntityIds.map(id=>{const row=this.entities.get(id);return row?identityRevisionRef(id,row.revision):null;})),historyPreserved:true,unrelatedIdentityMutation:false};
  }

  identityReference(entityId,{storyId=null}={}){const entity=this.entities.get(String(entityId));return entity&&this.#visible(entity,storyId)?{kind:'EntityIdentityReference',entityId:entity.entityId,revision:entity.revision,revisionRef:identityRevisionRef(entity.entityId,entity.revision),status:entity.status,entityType:entity.entityType,worldId:entity.worldId,authorityOrigin:entity.authorityOrigin,readOnly:true}:null;}
  isCurrentRevisionRef(ref){const value=String(ref??'');for(const entity of this.entities.values())if(identityRevisionRef(entity.entityId,entity.revision)===value)return true;return false;}
  readReferences(entityIds=[],{limit=128,storyId=null}={}){const max=Math.max(1,Math.min(512,Number(limit)||128)),wanted=new Set((entityIds??[]).filter(Boolean).map(String));const rows=[];for(const entity of this.entities.values()){if(wanted.size&&!wanted.has(entity.entityId))continue;rows.push(this.identityReference(entity.entityId,{storyId}));if(rows.length>=max)break;}return{kind:'EntityIdentityReferenceSet',contractVersion:'1.0.0',references:rows.filter(Boolean),authorityGranted:false,mutationAuthority:false,settlementAuthority:false};}

  contract(){
    return{
      kind:'CoreEntityIdentityContract',contractVersion:'1.0.0',
      proposalKind:'IdentityResolutionProposal',receiptKind:'IdentityResolutionReceipt',
      proposalActions:Object.values(IdentityProposalAction),resolutionStates:Object.values(IdentityResolutionState),
      explicitAuthorityOrigins:[...authoritativeOrigins].sort(),
      rules:{
        proposalMutation:false,modelMergeAuthority:false,retrievalMergeAuthority:false,graphMergeAuthority:false,
        graphProximityMaySettleIdentity:false,confidenceMaySettleIdentity:false,canonicalMergeSplitRequiresOwnerSettlement:true,
        sourceRevisionInvalidatesOnlyDependentAssertions:true,historicalAliasPreserved:true,historicalAliasResolutionExplicit:true,aliasResolutionRequiresUniqueCandidate:true,
        stableRevisionReferences:true,revisionReferencesReadOnly:true,
      },
    };
  }

  readModel({limit=128,storyId=null,compact=false}={}){
    const max=Math.max(1,Math.min(512,Number(limit)||128));
    const visible=[...this.entities.values()].filter(entity=>this.#visible(entity,storyId));
    return{
      kind:'EntityIdentityReadModel',contractVersion:'1.0.0',
      identities:visible.slice(0,max).map(entity=>compact?this.#compactIdentity(entity):clone(entity)),
      compact:Boolean(compact),detailReader:compact?'entityIdentityDetail':null,
      recentProposals:this.proposalOrder.slice(-max).map(id=>this.proposals.get(id)).filter(Boolean).map(clone),
      recentSettlements:this.settlements.slice(-max).map(clone),
      counts:{identities:visible.length,hiddenOutOfStory:this.entities.size-visible.length,currentSourceLinks:this.sourceLinks.size,proposals:this.proposals.size},
      authority:{proposalMutation:false,modelMerge:false,retrievalMerge:false,graphMerge:false,settlementRequired:true},
    };
  }

  // Reference row for routine reads: identity, revision and counts, never the per-alias/per-link/per-source
  // arrays (those grow with the corpus). The full record is `get(entityId,{storyId})`.
  #compactIdentity(entity){
    return{
      kind:'EntityIdentityReference',entityId:entity.entityId,canonicalLabel:entity.canonicalLabel,entityType:entity.entityType,worldId:entity.worldId,
      status:entity.status,revision:entity.revision,revisionRef:identityRevisionRef(entity.entityId,entity.revision),authorityOrigin:entity.authorityOrigin,
      storyScopeIds:[...(entity.storyScopeIds??[])],
      aliasCount:(entity.aliases??[]).filter(currentAlias).length,sourceLinkCount:(entity.sourceLinks??[]).filter(row=>row.current!==false).length,
      sourceRevisionCount:(entity.sourceRevisionRefs??[]).length,provenanceCount:(entity.provenanceRefs??[]).length,readOnly:true,
    };
  }

  // Source revision refs asserted by identities an owner registered (metadata.ownerAuthority) and visible to the story.
  // Lets a restored session know which owner revisions its identities still depend on.
  ownerRevisionRefs(ownerAuthority,{storyId=null}={}){
    const refs=new Set();
    for(const entity of this.entities.values()){
      if(!this.#visible(entity,storyId)||entity.metadata?.ownerAuthority!==ownerAuthority)continue;
      for(const ref of entity.sourceRevisionRefs??[])refs.add(String(ref));
    }
    return refs;
  }

  get(entityId,{storyId=null}={}){const row=this.entities.get(String(entityId));return row&&this.#visible(row,storyId)?clone(row):null;}
  proposal(proposalId){const row=this.proposals.get(String(proposalId));return row?clone(row):null;}

  exportState(){
    return clone({kind:'NativeEntityIdentityRegistrySnapshot',version:'1.0.0',sequence:this.sequence,entities:[...this.entities.entries()],sourceLinks:[...this.sourceLinks.entries()],proposals:[...this.proposals.entries()],proposalOrder:this.proposalOrder,settlements:this.settlements,maxProposals:this.maxProposals,maxHistory:this.maxHistory});
  }

  restoreState(snapshot){
    if(!snapshot||snapshot.kind!=='NativeEntityIdentityRegistrySnapshot')throw new TypeError('NativeEntityIdentityRegistrySnapshot is required');
    this.sequence=Number(snapshot.sequence??0);this.entities=new Map(clone(snapshot.entities??[]));this.sourceLinks=new Map(clone(snapshot.sourceLinks??[]));this.proposals=new Map(clone(snapshot.proposals??[]));this.proposalOrder=clone(snapshot.proposalOrder??[]);this.settlements=clone(snapshot.settlements??[]);this.#bound();return this.exportState();
  }

  #linkSource(entity,input){
    const provider=req(input.providerId,'providerId'),source=req(input.sourceEntityId,'sourceEntityId'),key=sourceKey(provider,source);
    const existing=this.sourceLinks.get(key);
    if(existing&&existing.current!==false&&existing.entityId!==entity.entityId)throw new Error('SOURCE_ENTITY_ALREADY_LINKED:'+key);
    const row={kind:'EntitySourceLink',providerId:provider,sourceEntityId:source,entityId:entity.entityId,current:true,status:'CURRENT',authorityOrigin:String(input.authorityOrigin??'OWNER_EXPLICIT'),sourceRevisionRefs:uniq(input.sourceRevisionRefs),provenanceRefs:uniq(input.provenanceRefs),createdSequence:++this.sequence};
    this.sourceLinks.set(key,row);entity.sourceLinks.push(row);entity.sourceRevisionRefs=uniq([...entity.sourceRevisionRefs,...row.sourceRevisionRefs]);entity.provenanceRefs=uniq([...entity.provenanceRefs,...row.provenanceRefs]);entity.revision+=1;entity.updatedSequence=this.sequence;return row;
  }

  #unlinkSource(entity,input){
    const key=sourceKey(input.providerId,input.sourceEntityId),existing=this.sourceLinks.get(key);if(!existing||existing.entityId!==entity.entityId)return false;
    existing.current=false;existing.status='RETIRED';existing.retiredSequence=++this.sequence;this.sourceLinks.delete(key);
    const row=(entity.sourceLinks??[]).find(x=>x.providerId===existing.providerId&&x.sourceEntityId===existing.sourceEntityId&&x.current!==false);if(row){row.current=false;row.status='RETIRED';row.retiredSequence=this.sequence;}
    entity.revision+=1;entity.updatedSequence=this.sequence;return true;
  }

  #addAlias(entity,input){
    const alias=req(input.alias,'alias'),sourceRevisionRefs=uniq(input.sourceRevisionRefs),provenanceRefs=uniq(input.provenanceRefs);
    const duplicate=(entity.aliases??[]).find(row=>currentAlias(row)&&labelKey(row.alias)===labelKey(alias)&&String(row.providerId??'')===String(input.providerId??''));
    if(duplicate)return duplicate;
    const row={kind:'AliasCandidate',alias,entityId:entity.entityId,current:true,status:'CURRENT',authorityOrigin:String(input.authorityOrigin??'OWNER_EXPLICIT'),providerId:input.providerId??null,sourceEntityId:input.sourceEntityId??null,sourceRevisionRefs,provenanceRefs,temporalApplicability:clone(input.temporalApplicability??null),createdSequence:++this.sequence};
    entity.aliases.push(row);entity.sourceRevisionRefs=uniq([...entity.sourceRevisionRefs,...sourceRevisionRefs]);entity.provenanceRefs=uniq([...entity.provenanceRefs,...provenanceRefs]);entity.revision+=1;entity.updatedSequence=this.sequence;return row;
  }

  #retireAlias(entity,alias,input){
    const key=labelKey(alias);if(!key)return false;let changed=false;
    for(const row of entity.aliases??[])if(currentAlias(row)&&labelKey(row.alias)===key){row.current=false;row.status='RETIRED';row.retiredSequence=++this.sequence;row.retireSourceRevisionRefs=uniq(input.sourceRevisionRefs);row.retireProvenanceRefs=uniq(input.provenanceRefs);changed=true;}
    if(changed){entity.revision+=1;entity.updatedSequence=this.sequence;}return changed;
  }

  #bound(){
    while(this.proposalOrder.length>this.maxProposals){const old=this.proposalOrder.shift();this.proposals.delete(old);}
    while(this.settlements.length>this.maxHistory)this.settlements.shift();
  }
}
