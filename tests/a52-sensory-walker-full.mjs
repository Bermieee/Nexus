import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  NexusWorldTreeReadApi,
  loreNodeFromEntry,
} from '../nexus/a52/shared/world-tree-api.js';
import {
  NexusSensoryBackbone,
  createNexusCandidateChannel,
} from '../nexus/a52/sensory/backbone.js';
import {
  createWorldTreeGraphProvider,
  resolveWorldTreeAnchors,
} from '../nexus/a52/sensory/walker/world-tree-provider.js';
import { NativeGraphNeighborhoodRetriever } from '../nexus/a52/graph-neighborhood-retriever.js';

const sourceRevision='lore-rev:1';
const mara={book:'world',uid:1,title:'Mara Relationships',content:'Mara trusts Iris and relies on her judgment.',extensions:{nexusTemporal:{status:'CURRENT'}}};
const iris={book:'world',uid:2,title:'Iris',content:'Iris keeps the silver key.',extensions:{nexusTemporal:{status:'CURRENT'}}};
const lexicalOnly={book:'world',uid:3,title:'Harbor',content:'The harbor is quiet.',extensions:{nexusTemporal:{status:'CURRENT'}}};

const tree=new NexusWorldTreeReadApi();
for(const row of [mara,iris,lexicalOnly]){
  tree.upsertNode(loreNodeFromEntry({
    book:row.book,
    entry:{...row,comment:row.title,key:[row.title]},
    candidate:row,
    sourceRevisionRef:sourceRevision,
  }));
}

{
  const maraMatches=tree.findByAlias('Lady Mara','chat-1');
  assert.ok(maraMatches.some(row=>row.id==='lore:world:1'),'title-derived aliases should normalize scene names');
  const anchors=resolveWorldTreeAnchors(tree,{acceptedScene:{participants:['Mara'],location:''}},{chatId:'chat-1'});
  assert.ok(anchors.includes('lore:world:1'));
}

const provider=createWorldTreeGraphProvider({
  worldTree:tree,
  sceneScan:{acceptedScene:{participants:['Mara'],location:''}},
  chatId:'chat-1',
  sourceRevisionRefs:[sourceRevision],
});
const walker=new NativeGraphNeighborhoodRetriever({
  temporalGraph:{allClaims(){return[];},readReferences(){return{references:[]};}},
  isSourceRevisionCurrent:ref=>ref===sourceRevision,
  limits:{maxDepth:3,maxNodes:96,maxEdges:192,maxCandidates:64,latencyBudgetMs:15},
});
walker.registerProvider(provider);

{
  const nominations=walker.retrieve({
    intentId:'turn',
    kind:'CURRENT',
    query:'What does Mara know about Iris?',
    entityRefs:['lore:world:1'],
  },{
    chatId:'chat-1',
    sourceRevisionSet:[sourceRevision],
    sceneRevision:0,
    worldRevision:0,
    latencyBudgetMs:15,
  });
  assert.ok(nominations.some(row=>row.evidenceIdentity==='lore:world:2'),'walker should discover Iris through Mara relationship text');
  assert.equal(walker.diagnostics().lastReceipt.staleRejectedCount,0);
  assert.ok(walker.diagnostics().lastReceipt.elapsedMs>=0);
  assert.ok(provider.diagnostics().edgeCount>0);
}

{
  const sensory=new NexusSensoryBackbone();
  sensory.register(createNexusCandidateChannel({
    channelId:'tree-traversal',
    candidates:[mara],
    sourceRevisionRefs:[sourceRevision],
    discoverySource:'traversal',
  }));
  sensory.register(createNexusCandidateChannel({
    channelId:'lexical',
    candidates:[mara,lexicalOnly],
    sourceRevisionRefs:[sourceRevision],
    discoverySource:'lexical',
  }));
  sensory.register(walker);
  const result=sensory.retrieveEnvelope({
    query:'Mara and Iris',
    intent:'CURRENT',
    anchorEntityIds:['lore:world:1'],
    sourceRevisionSet:[sourceRevision],
    sceneRevision:0,
    worldRevision:0,
    latencyBudgetMs:15,
  });
  const maraCandidate=result.candidates.find(row=>row.evidenceIdentity==='lore:world:1');
  const irisCandidate=result.candidates.find(row=>row.evidenceIdentity==='lore:world:2');
  assert.ok(maraCandidate);
  assert.ok(irisCandidate,'graph-only related entry should enter the fused envelope');
  assert.ok(maraCandidate.channelNominations.length>=2,'duplicate Nexus sources should fuse into one candidate');
  assert.ok(result.envelope.fusionReceipt.inputChannelCount>=3);
}

{
  const source=fs.readFileSync(new URL('../retrieval/retriever.js',import.meta.url),'utf8');
  const legacyAt=source.indexOf('const legacyCandidates=dedupeEntryRefs');
  const fuseAt=source.indexOf('const sensoryResult=sensory.retrieveEnvelope');
  const truthAt=source.indexOf('const truthAssessment=assessWorldTreeCandidates');
  const assistAt=source.indexOf('candidateAssistRun = await evaluateRetrievalCandidateAdmissionAssist');
  assert.ok(legacyAt>=0&&fuseAt>legacyAt&&truthAt>fuseAt&&assistAt>truthAt);
  assert.ok(source.includes("logEvent('a52.sensory','candidate-envelope'"));
  assert.ok(source.includes("logEvent('a52.walker','traversal'"));
  assert.ok(source.includes("channelId:'tree-traversal'"));
  assert.ok(source.includes("channelId:'lexical'"));
  assert.ok(source.includes("channelId:'scene-anchor'"));
  assert.ok(source.includes("channelId:'reuse'"));
  assert.ok(source.includes("channelId:'paging'"));
  assert.ok(!source.includes('A52Mode.SHADOW'));
}

console.log('Area-52 revised Sensory Net + Graph Walker wiring: PASS');
