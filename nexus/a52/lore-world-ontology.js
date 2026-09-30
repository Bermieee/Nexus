import {ArtifactType, AuthorityClass, deepClone, stableHash, stableStringify} from './lore-contracts.js';

function unique(values){return [...new Set(values)].sort();}

export class LoreWorldOntology {
  constructor({runtime}={}){
    if(!runtime) throw new TypeError('LoreWorldOntology requires LoreStudyRuntime');
    this.runtime=runtime;
    this.snapshotValue=null;
  }

  rebuild(){
    const nodes=new Map(), edges=[], memberships=new Map(), sourceRevisions=new Map();
    const addNode=(id,row)=>{if(!nodes.has(id))nodes.set(id,{id,...row});};
    const addMembership=(key,sourceId,sourceRevisionId)=>{
      const rows=memberships.get(key)||new Map();
      rows.set(sourceId,sourceRevisionId);
      memberships.set(key,rows);
    };

    for(const source of this.runtime.registry.listEntries({includeRemoved:false})){
      const revision=this.runtime.registry.currentRevision(source.sourceId,{allowMissing:true});
      const learned=this.runtime.store.currentLearnedRevision(source.sourceId);
      if(!revision||revision.state==='REMOVED'||!learned||learned.state!=='CURRENT'||learned.sourceRevisionId!==revision.id)continue;
      sourceRevisions.set(source.sourceId,revision.id);
      for(const segment of revision.metadata?.treePath||[]){
        const key='tree-topic:'+String(segment).toLowerCase();
        addNode(key,{kind:'TREE_TOPIC',label:String(segment),authorityClass:AuthorityClass.DERIVED,truthAuthority:false});
        addMembership(key,source.sourceId,revision.id);
      }
      // Read-only rows: only primitive fields are copied into new nodes and edges.
      for(const artifact of (this.runtime.store.artifactsForLearnedRevisionReadOnly??this.runtime.store.artifactsForLearnedRevision).call(this.runtime.store,learned.id)){
        if(artifact.artifactType===ArtifactType.CONCEPT){
          const key='concept:'+artifact.payload.concept;
          addNode(key,{kind:'LEARNED_CONCEPT',label:artifact.payload.concept,parentConcept:artifact.payload.parentConcept||null,authorityClass:artifact.authorityClass,truthAuthority:false});
          addMembership(key,source.sourceId,revision.id);
          edges.push({kind:'CONCEPT_EVIDENCE',from:key,to:artifact.payload.entityId,sourceId:source.sourceId,sourceRevisionId:revision.id,evidenceArtifactId:artifact.id,authorityClass:artifact.authorityClass});
        }else if(artifact.artifactType===ArtifactType.RELATIONSHIP){
          const key='relationship:'+artifact.payload.predicate;
          addNode(key,{kind:'RELATIONSHIP_TYPE',label:artifact.payload.predicate,authorityClass:artifact.unresolved?AuthorityClass.UNRESOLVED:AuthorityClass.DERIVED,truthAuthority:false});
          addMembership(key,source.sourceId,revision.id);
          edges.push({kind:'RELATIONSHIP_EVIDENCE',from:artifact.payload.subjectId,to:artifact.payload.objectId,predicate:artifact.payload.predicate,sourceId:source.sourceId,sourceRevisionId:revision.id,evidenceArtifactId:artifact.id,unresolved:Boolean(artifact.unresolved),temporalClass:artifact.temporalClass,authorityClass:artifact.authorityClass});
        }
      }
    }

    const communities=[];
    for(const [key,rows] of memberships.entries()){
      if(rows.size<2)continue;
      communities.push({
        kind:'LoreLearnedCommunity',
        id:'ontology-community:'+stableHash(key+'|'+[...rows.keys()].sort().join('|')),
        conceptRef:key,
        label:nodes.get(key)?.label||key,
        sourceIds:[...rows.keys()].sort(),
        sourceRevisionRefs:[...rows.values()].sort(),
        authorityClass:AuthorityClass.DERIVED,
        sourceAuthority:false,
        truthAuthority:false,
        settlementAuthority:false,
      });
    }

    const dependencyRows=[...sourceRevisions.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
    this.snapshotValue={
      kind:'LoreWorldOntologySnapshot',
      contractVersion:1,
      ontologyRevision:'lore-ontology:'+stableHash(stableStringify({dependencyRows,nodes:[...nodes.keys()].sort(),edges:edges.map(x=>[x.kind,x.from,x.to,x.predicate||null,x.sourceRevisionId]).sort()})),
      sourceRevisionFence:dependencyRows.map(([,revisionId])=>revisionId),
      nodes:[...nodes.values()].map(deepClone).sort((a,b)=>a.id.localeCompare(b.id)),
      // Same order as comparing stableStringify(a) with stableStringify(b), with each key computed once instead of per comparison.
      edges:edges.map((edge)=>[stableStringify(edge),edge]).sort((a,b)=>a[0].localeCompare(b[0])).map(([,edge])=>deepClone(edge)),
      communities:communities.sort((a,b)=>a.id.localeCompare(b.id)),
      authoredTreePreserved:true,
      learnedFromWorldLore:true,
      fixedRpOntologyRequired:false,
      externalGraphDatabaseRequired:false,
      externalVectorServerRequired:false,
      sourceAuthority:false,
      temporalStateAuthority:false,
      settlementAuthority:false,
    };
    return deepClone(this.snapshotValue);
  }

  current(){return this.snapshotValue?deepClone(this.snapshotValue):this.rebuild();}

  impactForSource(sourceId){
    const current=this.current();
    return {
      kind:'LoreOntologyImpactCone',
      sourceId,
      currentSourceRevisionId:this.runtime.registry.currentRevision(sourceId,{allowMissing:true})?.id||null,
      affectedNodeIds:current.nodes.filter(node=>current.edges.some(edge=>edge.sourceId===sourceId&&(edge.from===node.id||('relationship:'+edge.predicate)===node.id))).map(node=>node.id).sort(),
      affectedCommunityIds:current.communities.filter(row=>row.sourceIds.includes(sourceId)).map(row=>row.id).sort(),
      unrelatedSourcesRemainIndependent:true,
      mutationAuthority:false,
    };
  }

  communitiesForSources(sourceIds=[]){
    const wanted=new Set(sourceIds);
    return this.current().communities.filter(row=>row.sourceIds.some(id=>wanted.has(id))).map(deepClone);
  }
}
