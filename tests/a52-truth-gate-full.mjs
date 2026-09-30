import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  NexusWorldTreeReadApi,
  loreNodeFromEntry,
  memoryNodeFromRecord,
} from '../nexus/a52/shared/world-tree-api.js';
import {
  assessWorldTreeCandidates,
  inferTruthIntent,
} from '../nexus/a52/truth/status-resolver.js';

{
  assert.equal(inferTruthIntent('Where is Mara now?'),'CURRENT');
  assert.equal(inferTruthIntent('Where was Mara in the past?'),'HISTORICAL');
  assert.equal(inferTruthIntent('When did the tavern change owners?'),'TEMPORAL');
  assert.equal(inferTruthIntent('These accounts conflict; which is disputed?'),'CONTRADICTION');
}

{
  const entries=[
    {book:'world',uid:1,title:'Unlabelled',content:'No temporal metadata.'},
    {book:'world',uid:2,title:'Past',content:'Old location.',extensions:{nexusTemporal:{status:'HISTORICAL'}}},
    {book:'world',uid:3,title:'Superseded',content:'Old owner.',extensions:{nexusTemporal:{status:'SUPERSEDED',supersededBy:'lore:world:4'}}},
    {book:'world',uid:4,title:'Disputed',content:'Conflicting account.',extensions:{nexusTemporal:{status:'CONTRADICTED'}}},
  ];
  const tree=new NexusWorldTreeReadApi();
  for(const entry of entries)tree.upsertNode(loreNodeFromEntry({book:'world',entry:{...entry,comment:entry.title},candidate:entry,sourceRevisionRef:'lore-rev:1'}));
  const result=assessWorldTreeCandidates(entries,{worldTree:tree,query:'What is true now?',intent:'CURRENT',kind:'lore',sourceRevisionRefs:['lore-rev:1']});
  const byUid=new Map(result.rows.map(row=>[row.candidate.uid,row]));
  assert.equal(byUid.get(1).verdict.classification,'UNRESOLVED','missing status must stay visible as unresolved');
  assert.equal(byUid.get(1).keep,true);
  assert.equal(byUid.get(2).keep,true,'historical facts remain support');
  assert.equal(byUid.get(2).presentationLabel,'[Past]');
  assert.equal(byUid.get(3).keep,false,'superseded fact must not enter current retrieval');
  assert.equal(byUid.get(4).keep,true);
  assert.equal(byUid.get(4).presentationLabel,'[Disputed]');
  assert.deepEqual(result.candidates.map(row=>row.uid),[1,2,4]);
}

{
  const record={id:'mem-1',layer:1,text:'Mara used to live at the docks.',sourceMessageIds:['m1'],characters:['Mara'],locations:['Docks'],createdAt:1,updatedAt:2};
  const tree=new NexusWorldTreeReadApi({nodes:[memoryNodeFromRecord(record,{chatId:'chat-1'})]});
  const result=assessWorldTreeCandidates([record],{worldTree:tree,query:'Where is Mara now?',intent:'CURRENT',kind:'memory'});
  assert.equal(result.rows[0].verdict.classification,'HISTORICAL');
  assert.equal(result.rows[0].keep,true);
  assert.equal(result.candidates[0].a52Truth.presentationLabel,'[Past]');
}

{
  const retrieval=fs.readFileSync(new URL('../retrieval/retriever.js',import.meta.url),'utf8');
  const recall=fs.readFileSync(new URL('../memory/recall.js',import.meta.url),'utf8');
  assert.ok(retrieval.includes("from '../nexus/a52/truth/status-resolver.js'"));
  const truthAt=retrieval.indexOf('const truthAssessment=assessWorldTreeCandidates');
  const assembledAt=Math.max(retrieval.indexOf('let candidates = dedupeEntryRefs'),retrieval.indexOf('const sensoryResult=sensory.retrieveEnvelope'));
  const assistAt=retrieval.indexOf('candidateAssistRun = await evaluateRetrievalCandidateAdmissionAssist');
  assert.ok(assembledAt>=0&&truthAt>assembledAt&&assistAt>truthAt);
  assert.ok(retrieval.includes("logEvent('nexus.truth','candidate-verdict'"));
  assert.ok(retrieval.includes("candidate?.a52Truth?.presentationLabel"));
  assert.ok(recall.includes("assessWorldTreeCandidates(selected"));
  assert.ok(recall.includes("truthLabel?truthLabel+' ':''"));
  assert.ok(!retrieval.includes('A52Mode.SHADOW'));
  assert.ok(!retrieval.includes('A52Mode.ON'));
}

console.log('Area-52 revised Truth Gate wiring: PASS');
