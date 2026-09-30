import { KnowledgeStatus, createTruthGateResult } from './contracts.js';
const unresolved=new Set([KnowledgeStatus.CONTRADICTED,KnowledgeStatus.UNRESOLVED,KnowledgeStatus.UNCERTAIN]);
const historical=new Set([KnowledgeStatus.HISTORICAL,KnowledgeStatus.SUPERSEDED]);

function usable(classification,intent){
  if(intent==='CURRENT')return classification===KnowledgeStatus.CURRENT||unresolved.has(classification);
  if(intent==='HISTORICAL')return [KnowledgeStatus.CURRENT,KnowledgeStatus.HISTORICAL,KnowledgeStatus.SUPERSEDED].includes(classification);
  if(intent==='TEMPORAL')return [KnowledgeStatus.CURRENT,KnowledgeStatus.HISTORICAL,KnowledgeStatus.SUPERSEDED,KnowledgeStatus.CONTRADICTED,KnowledgeStatus.UNRESOLVED,KnowledgeStatus.UNCERTAIN].includes(classification);
  if(intent==='CONTRADICTION')return unresolved.has(classification);
  return classification===KnowledgeStatus.CURRENT;
}

export class TruthGate {
  constructor({graph,externalEvidenceResolver=null}={}){
    this.graph=graph;
    this.externalEvidenceResolver=typeof externalEvidenceResolver==='function'?externalEvidenceResolver:null;
  }

  setExternalEvidenceResolver(resolver=null){
    if(resolver!==null&&typeof resolver!=='function')throw new TypeError('external evidence resolver must be a function');
    this.externalEvidenceResolver=resolver;
  }

  classify(candidate,{intent='CURRENT'}={}){
    const claimIds=candidate.claimIds??candidate.claimRefs??[];
    const claims=claimIds.map(id=>this.graph.getClaim(id)).filter(Boolean);
    if(claims.length){
      const claim=claims[0],classification=claim.status??KnowledgeStatus.UNRESOLVED;
      const ok=usable(classification,intent);
      const base=createTruthGateResult({
        candidateId:candidate.candidateId,classification,usableForIntent:ok,
        reasons:[ok?`${classification.toLowerCase()}-usable-for-${intent.toLowerCase()}`:`${classification.toLowerCase()}-not-usable-for-${intent.toLowerCase()}`],
        claimIds:[claim.id],provenance:claim.provenance,
      });
      return {...base,sourceRevisionRefs:[...(claim.provenance?.sourceRevisionIds??[])],identityRevisionRefs:[...(claim.identityRevisionRefs??candidate.identityRevisionRefs??[])],temporalStatus:classification,authorityClass:claim.authorityClass,evidenceRefs:[...(claim.provenance?.evidenceIds??[])]};
    }

    const evidence=this.externalEvidenceResolver?.(candidate)??null;
    if(evidence){
      const classification=evidence.temporalStatus??KnowledgeStatus.UNRESOLVED;
      const ok=usable(classification,intent);
      const base=createTruthGateResult({
        candidateId:candidate.candidateId,classification,usableForIntent:ok,
        reasons:[ok?`external-${classification.toLowerCase()}-usable-for-${intent.toLowerCase()}`:`external-${classification.toLowerCase()}-not-usable-for-${intent.toLowerCase()}`],
        claimIds:[],provenance:{
          id:'truth-external:'+evidence.evidenceId,
          sourceRevisionIds:[...(evidence.sourceRevisionRefs??[])],
          evidenceIds:[evidence.evidenceId],
          derivedFromIds:[typeof evidence.artifactRef==='string'?evidence.artifactRef:evidence.artifactRef?.artifactId??evidence.evidenceId],
          activity:'TRUTH_VALIDATE_EXTERNAL_KNOWLEDGE',
          agent:'truth-gate',
          invalidators:[...(evidence.sourceRevisionRefs??[]),...(evidence.dependencyRevisionRefs??[])],
        },
      });
      return {...base,knowledgeEvidenceId:evidence.evidenceId,authorityClass:evidence.authorityClass,sourceClass:evidence.sourceClass,sourceRevisionRefs:[...(evidence.sourceRevisionRefs??candidate.sourceRevisionRefs??[])],identityRevisionRefs:[...(candidate.identityRevisionRefs??evidence.extensions?.identityRevisionRefs??[])],temporalStatus:classification,evidenceRefs:[...(candidate.evidenceRefs??[evidence.evidenceId])]};
    }

    const missing=createTruthGateResult({
      candidateId:candidate.candidateId,classification:KnowledgeStatus.UNRESOLVED,usableForIntent:false,
      reasons:['claim-missing-or-invalid'],claimIds,provenance:candidate.provenance,
    });
    return {...missing,sourceRevisionRefs:[...(candidate.sourceRevisionRefs??[])],identityRevisionRefs:[...(candidate.identityRevisionRefs??[])],temporalStatus:candidate.temporalStatus??KnowledgeStatus.UNRESOLVED,authorityClass:candidate.authorityClass??'UNKNOWN',evidenceRefs:[...(candidate.evidenceRefs??[])]};
  }
  classifyAll(candidates,options={}){return candidates.map(c=>this.classify(c,options));}
}
