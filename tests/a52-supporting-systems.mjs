import assert from 'node:assert/strict';
import {
  LoreContracts,
  LoreStudyRuntime,
  LoreWorldOntology,
  NativeEntityIdentityRegistry,
  TemporalStateGraph,
  createMutationProposal,
  createClaim,
  createProvenance,
  MutationType,
  KnowledgeStatus,
  AuthorityClass,
  parseAttribution,
  readSourceTime,
  compareTimes,
  StructuredOutputSchemaRegistry,
  CoreStructuredOutputValidator,
  SceneLoreHandoffAdapter,
  resolveA52Modes,
  A52Mode,
  validatePromptIntegrity,
  PromptIntegrityCode,
} from '../nexus/a52/index.js';

{
  const attribution=parseAttribution('The innkeeper says the Sun Blade was removed before the fire.');
  assert.equal(attribution.mode,'HEARSAY');
  assert.equal(attribution.speaker,'innkeeper');
  const a=readSourceTime({at:3},{lorebookId:'story'});
  const b=readSourceTime({at:10},{lorebookId:'story'});
  assert.equal(compareTimes(a.at,b.at),-1);
}

{
  const runtime=new LoreStudyRuntime();
  runtime.ingestLorebook({
    id:'story',
    fullSnapshot:true,
    entries:[
      {uid:'before',content:'The Ember Tavern is intact.',metadata:{at:3}},
      {uid:'after',content:'The Ember Tavern burns down.',metadata:{at:10}},
    ],
  });
  runtime.runDue();
  const resolution=runtime.store.temporalResolution(runtime.registry);
  assert.equal(resolution.superseded.size,1,'later same-property lore supersedes the earlier state');
  const claims=runtime.store.currentArtifacts(runtime.registry,{types:[LoreContracts.ArtifactType.CLAIM]});
  assert.ok(claims.length>=2,'Lore Study published claim artifacts');
  const ontology=new LoreWorldOntology({runtime}).rebuild();
  assert.equal(ontology.learnedFromWorldLore,true);
  assert.ok(ontology.sourceRevisionFence.length>=1);
}

{
  const identities=new NativeEntityIdentityRegistry();
  identities.registerIdentity({
    entityId:'entity:mara',
    canonicalLabel:'Mara',
    entityType:'PERSON',
    aliases:['Lady Mara','the innkeeper'],
    sourceRevisionRefs:['lore:1'],
    provenanceRefs:['prov:1'],
    storyScopeId:'story-a',
  });
  identities.setActiveStory('story-a');
  assert.equal(identities.candidateEntities({label:'Lady Mara'}).at(0)?.entityId,'entity:mara');
  identities.setActiveStory('story-b');
  assert.equal(identities.candidateEntities({label:'Lady Mara'}).length,0,'story-scoped identity must not leak across stories');
}

{
  const graph=new TemporalStateGraph();
  const registry={isActiveRevision:()=>true};
  const provenance=(id)=>createProvenance({
    id:'prov:'+id,
    sourceRevisionIds:['lore:1'],
    evidenceIds:[id],
    activity:'TEST',
    agent:'nexus-a52-test',
    invalidators:['lore:1'],
  });
  const settle=(id,value,at)=>graph.settleProposal(createMutationProposal({
    id:'proposal:'+id,
    mutationType:MutationType.SET_CLAIM,
    owner:'WORLD_STATE',
    sourceRevisionIds:['lore:1'],
    freshnessRevisionIds:['lore:1'],
    payload:{claim:createClaim({
      id,
      subjectId:'entity:ember-tavern',
      predicate:'state',
      value,
      temporal:{kind:'CURRENT',validFrom:at,validUntil:null},
      authorityClass:AuthorityClass.SOURCE_CANON,
      status:KnowledgeStatus.CURRENT,
      provenance:provenance(id),
    })},
  }),registry);
  settle('claim:intact','intact',3);
  settle('claim:destroyed','destroyed',10);
  assert.equal(graph.getClaim('claim:intact').status,KnowledgeStatus.SUPERSEDED);
  assert.equal(graph.getClaim('claim:destroyed').status,KnowledgeStatus.CURRENT);
}

{
  const registry=new StructuredOutputSchemaRegistry();
  registry.register({
    schemaId:'green-room-test',
    typeValidate:value=>({ok:value&&Array.isArray(value.characters),errors:['characters required']}),
    semanticValidate:value=>({ok:value.characters.every(row=>row.authority==='INFERRED'),errors:['authority escalation']}),
    normalize:value=>({characters:value.characters.map(row=>({...row,normalized:true}))}),
  });
  const validator=new CoreStructuredOutputValidator({registry});
  const valid=validator.validate({schemaId:'green-room-test',rawOutput:'{"characters":[{"authority":"INFERRED"}]}'});
  assert.equal(valid.ok,true);
  const invalid=validator.validate({schemaId:'green-room-test',rawOutput:'{"characters":[{"authority":"SETTLED"}]}'});
  assert.equal(invalid.ok,false);
}

{
  const adapter=new SceneLoreHandoffAdapter();
  const result=await adapter.retrieve({sceneReceipt:{status:'NO_WORK'},generationId:'g1'});
  assert.equal(result.status,'NO_WORK');
}

{
  const modes=resolveA52Modes({a52:{loreStudy:'shadow',entityIdentity:{mode:'on'}}});
  assert.equal(modes.loreStudy,A52Mode.SHADOW);
  assert.equal(modes.entityIdentity,A52Mode.ON);
}

{
  const bad=validatePromptIntegrity({
    currentFacts:[
      {authorityClass:'INFERRED',temporalStatus:'CURRENT'},
      {authorityClass:'SOURCE_CANON',temporalStatus:'HISTORICAL'},
    ],
    historicalFacts:[{temporalStatus:'SUPERSEDED'}],
    greenRoom:[{authority:'SETTLED',canonical:true}],
  });
  assert.equal(bad.ok,false);
  assert.ok(bad.violations.some(row=>row.code===PromptIntegrityCode.INFERRED_IN_CURRENT));
  assert.ok(bad.violations.some(row=>row.code===PromptIntegrityCode.HISTORICAL_IN_CURRENT));
  assert.ok(bad.violations.some(row=>row.code===PromptIntegrityCode.HISTORICAL_LABEL_MISSING));
  assert.ok(bad.violations.some(row=>row.code===PromptIntegrityCode.GREEN_ROOM_AUTHORITY));
  const good=validatePromptIntegrity({
    currentFacts:[{authorityClass:'SOURCE_CANON',temporalStatus:'CURRENT'}],
    historicalFacts:[{temporalStatus:'HISTORICAL',temporalLabel:'PAST'}],
    greenRoom:[{authority:'INFERRED',canonical:false,durableMutation:false}],
  });
  assert.equal(good.ok,true);
}

console.log('Area-52 supporting-system scenarios: PASS');
