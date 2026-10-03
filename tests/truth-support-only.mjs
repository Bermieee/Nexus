import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NexusWorldTree } from '../world-tree/store.js';
import { importLegacyLoreBookToWorldTree } from '../world-tree/import-lore.js';
import { NexusWorldTreeReadApi, createCanonicalWorldTreeReadApi, memoryNodeFromRecord } from '../core/world-tree-api.js';
import {
  assessWorldTreeCandidates, inferTruthIntent, inferTruthNeed, isEstablishedChatFact, summarizeTruthAssessment, truthNeedsCorrection,
} from '../nexus/a52/truth/status-resolver.js';
import {
  CONTEXT_ONLY_MARKER, TRUTH_REASON_CODES, decideTruthOutcome, fullWeightFirst, isKnownTruthReasonCode, truthChunkPrefix,
} from '../nexus/truth-classification.js';
import { NexusDiagnosticChannel, createNexusDiagnosticEvent } from '../nexus/diagnostics-source.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const BOOK='Campaign',OTHER='GlobalBook',CHAT='chat-1';
const entry=(uid,extra={})=>({uid,comment:'Entry '+uid,key:['k'+uid],content:'Authored text '+uid,order:100,...extra});
const canon=(uid,extra={})=>entry(uid,{comment:'Gazef Stronoff',key:['Gazef'],content:'Gazef dies at the Katze Plains.',...extra});
const importBook=(tree,book,entries)=>importLegacyLoreBookToWorldTree(tree,{book,data:{entries:Object.fromEntries(entries.map(row=>[row.uid,row]))},legacyTree:null});
const lid=(book,uid)=>`lore:${book}:${uid}`;
// What the active scene is showing right now, in one chat: observed, current.
function sceneFact(tree,{id='1',chatId=CHAT,authority='OBSERVED',status='CURRENT',label='Gazef',supersededBy=[]}={}){
  tree.upsertNode({id:'scene-node-'+id,kind:'SCENE',scope:{type:'CHAT',chatId},provenance:{sourceType:'SCENE',sourceIds:[id]},temporal:{status,supersededBy},data:{label,authority,text:'Gazef is standing in Nazarick.'}});
  return 'scene-node-'+id;
}
// What the chat remembers or quotes: a summary of something that was said or happened.
function memoryFact(tree,{id='mem-1',chatId=CHAT,authority='REMEMBERED',status='CURRENT',characters=['Gazef']}={}){
  tree.upsertNode({id:'memory-node-'+id,kind:'MEMORY',scope:{type:'CHAT',chatId},provenance:{sourceType:'MESSAGE',sourceIds:[id]},temporal:{status},data:{id,text:'Albedo said Gazef is alive.',layer:1,characters,authority}});
  return 'memory:'+id;
}
const assess=(tree,uids,{book=BOOK,canonBooks=[BOOK],intent='CURRENT',chatId=CHAT,conflictAdvice=[]}={})=>{
  const api=createCanonicalWorldTreeReadApi({chatId,worldTree:tree});
  return assessWorldTreeCandidates(uids.map(uid=>({book,uid})),{worldTree:api,intent,kind:'lore',canonBooks,chatId,conflictAdvice});
};
const rowOf=(result,uid)=>result.rows.find(row=>row.candidate.uid===uid);
const conflict=(left,right,extra={})=>({choice:'REAL_CONFLICT',left,right,...extra});
const outcomeOf=row=>[row.outcome,row.reasonCode];

// ---------------------------------------------------------------- intent (narrative vs question)

const NARRATIVE=[
  'Ainz walks into the throne room and greets Albedo.',
  'After the meeting, Ainz returns to his chamber. When Albedo arrives, the guards bow.',
  'Before dawn, Ainz studies the old reports he used to ignore. Albedo previously served in the Great Tomb.',
  '"When did you arrive?" Albedo asks. "Before the war, I think," Ainz replies. "And what changed after?"',
  '*After a long pause, Ainz recalls what happened before the battle.* He steps forward, calm.',
  'The conflict between the kingdoms has changed everything, and nobody can say who was right.',
  'During the feast Ainz listens as the old guard recounts the history of the Tomb, formerly a ruin.',
  'Ainz says nothing at first. Then, after a moment, he asks Albedo to stand.',
  '',
];
const QUESTIONS=[
  ['When did Nazarick first appear?','TEMPORAL'],
  ['Ainz nods. (OOC: what happened to Gazef before the war?)','TEMPORAL'],
  ['Ainz nods. When did the Empire change hands?','TEMPORAL'],
  ['Who ruled the Empire previously?','HISTORICAL'],
  ['Was Gazef formerly a captain of the royal guard?','HISTORICAL'],
  ['Do these two accounts of the battle conflict?','CONTRADICTION'],
  ['Where is Gazef now?','CURRENT'],
];

test('ordinary narrative never reads as a temporal, historical or contradiction question',()=>{
  for(const text of NARRATIVE)assert.equal(inferTruthNeed(text),'CURRENT',text);
});

test('genuine player questions are still read as temporal, historical or contradiction questions',()=>{
  for(const [text,intent] of QUESTIONS)assert.equal(inferTruthNeed(text),intent,text);
  assert.equal(inferTruthIntent('Where was Mara in the past?'),'HISTORICAL');
  assert.equal(inferTruthIntent('These accounts conflict; which is disputed?'),'CONTRADICTION');
});

test('a narrative turn keeps unspecified canon at full weight; a genuine temporal question does not',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[canon(1)]);
  const narrative=inferTruthNeed('After the meeting, Ainz returns to his chamber. When Albedo arrives, the guards bow.');
  const asked=inferTruthNeed('When did Nazarick first appear?');
  assert.equal(narrative,'CURRENT');
  assert.equal(asked,'TEMPORAL');
  assert.deepEqual(outcomeOf(rowOf(assess(tree,[1],{intent:narrative}),1)),['FULL','CANON_NO_CONFLICT']);
  assert.deepEqual(outcomeOf(rowOf(assess(tree,[1],{intent:asked}),1)),['SUPPORT_ONLY','CANON_TIMING_NOT_ESTABLISHED']);
});

test('the retrievers read intent from the player message only, and corrective narrowing cannot reclassify a turn',()=>{
  const retriever=read('retrieval/retriever.js');
  assert.ok(retriever.includes('inferTruthNeed(latestUserTruthText(context))'),'scene objectives and assistant prose never feed intent');
  assert.ok(!retriever.includes('inferTruthNeed(truthQuery)'));
  assert.ok(retriever.includes('const correctedAssessmentIntent=truthIntent;'));
  assert.ok(retriever.includes('intent:correctedAssessmentIntent,'));
  assert.ok(retriever.includes('effectiveTruthIntent=correctedAssessmentIntent;'));
  const recall=read('memory/recall.js');
  assert.ok(recall.includes('intent:inferTruthIntent(latestPlayerText(context)),'),'recall no longer infers intent from eight messages of prose');
  assert.ok(!recall.includes('inferTruthIntent(chat)'));
});

// ---------------------------------------------------------------- outcomes

test('ordinary verified canon keeps normal use and weight; its status stays UNRESOLVED',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1)]);
  const result=assess(tree,[1]),row=rowOf(result,1);
  assert.equal(row.verdict.classification,'UNRESOLVED');
  assert.deepEqual([row.outcome,row.reasonCode,row.supportOnly,row.keep],['FULL','CANON_NO_CONFLICT',false,true]);
  assert.equal(result.candidates[0].a52Truth.weight,'FULL');
  assert.equal(truthChunkPrefix(result.candidates[0].a52Truth),'','full-weight text is delivered unmarked');
});

test('explicit uncertainty and genuinely unresolved evidence are support only',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[
    entry(1,{extensions:{nexusTemporal:{status:'UNCERTAIN'}}}),
    entry(2,{extensions:{nexusTemporal:{status:'UNRESOLVED'}}}),
    entry(3),
  ]);
  const result=assess(tree,[1,2,3]);
  assert.deepEqual(outcomeOf(rowOf(result,1)),['SUPPORT_ONLY','STATUS_UNCERTAIN']);
  assert.deepEqual(outcomeOf(rowOf(result,2)),['SUPPORT_ONLY','STATUS_DECLARED_UNRESOLVED']);
  assert.equal(rowOf(result,3).outcome,'FULL');
  const unbound=rowOf(assess(tree,[3],{canonBooks:null}),3);
  assert.equal(unbound.verdict.classification,'UNRESOLVED');
  assert.deepEqual([unbound.outcome,unbound.reasonCode,unbound.keep],['SUPPORT_ONLY','NO_STATUS_EVIDENCE',true]);
  const stats=summarizeTruthAssessment(result);
  assert.equal(stats.supportOnlyCount,2);
  assert.equal(truthNeedsCorrection(stats),true);
});

test('the canon exemption never answers temporal questions or overrides explicit state',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[
    entry(1),
    entry(2,{extensions:{nexusTemporal:{status:'HISTORICAL'}}}),
    entry(3,{extensions:{nexusTemporal:{status:'SUPERSEDED',supersededBy:'lore:Campaign:1'}}}),
  ]);
  const by=intent=>assess(tree,[1,2,3],{intent});
  assert.deepEqual(outcomeOf(rowOf(by('CURRENT'),1)),['FULL','CANON_NO_CONFLICT']);
  assert.deepEqual(outcomeOf(rowOf(by('TEMPORAL'),1)),['SUPPORT_ONLY','CANON_TIMING_NOT_ESTABLISHED']);
  assert.deepEqual(outcomeOf(rowOf(by('CONTRADICTION'),1)),['SUPPORT_ONLY','CANON_TIMING_NOT_ESTABLISHED']);
  assert.deepEqual(outcomeOf(rowOf(by('HISTORICAL'),1)),['DROPPED','CANON_TIMING_NOT_ESTABLISHED']);
  assert.equal(rowOf(by('HISTORICAL'),1).verdict.classification,'UNRESOLVED');
  assert.deepEqual(outcomeOf(rowOf(by('CURRENT'),2)),['SUPPORT_ONLY','STATUS_HISTORICAL_CONTEXT']);
  assert.deepEqual(outcomeOf(rowOf(by('HISTORICAL'),2)),['FULL','STATUS_MATCHES_TEMPORAL_QUESTION']);
  assert.deepEqual(outcomeOf(rowOf(by('CURRENT'),3)),['DROPPED','STATUS_SUPERSEDED']);
  assert.equal(rowOf(by('HISTORICAL'),3).outcome,'FULL');
});

// ---------------------------------------------------------------- conflicts: verified and applicable only

test('a verified observed chat fact beats canon for this chat only; global lore is untouched',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[canon(1)]);
  const factId=sceneFact(tree);
  const advice=[conflict(lid(BOOK,1),factId)];
  const revision=tree.revision,before=JSON.stringify(tree.exportState());
  const row=rowOf(assess(tree,[1],{conflictAdvice:advice}),1);
  assert.equal(row.verdict.classification,'CONTRADICTED');
  assert.deepEqual([row.outcome,row.reasonCode,row.conflict],['SUPPORT_ONLY','CHAT_FACT_SUPERSEDES_CANON','CHAT_LOSES']);
  assert.equal(row.presentationLabel,'[Disputed]');
  assert.equal(row.keep,true);
  assert.equal(tree.revision,revision,'assessment never writes the World Tree');
  assert.equal(JSON.stringify(tree.exportState()),before);
  assert.equal(tree.getNode('lore-fact:'+BOOK+':1').temporal.status,'UNRESOLVED','global lore keeps its own status');
  const other=rowOf(assess(tree,[1],{chatId:'chat-2',conflictAdvice:advice}),1);
  assert.deepEqual([other.verdict.classification,...outcomeOf(other)],['UNRESOLVED','FULL','CANON_NO_CONFLICT'],'another chat still reads canon');
  assert.deepEqual(outcomeOf(rowOf(assess(tree,[1]),1)),['FULL','CANON_NO_CONFLICT'],'no conflict evidence, no change');
});

test('a shared subject, a newer mention, or a remembered or quoted statement is not a conflict',()=>{
  const outcome=(setup,advice=true,options={})=>{
    const tree=new NexusWorldTree();
    importBook(tree,BOOK,[canon(1)]);
    const factId=setup(tree);
    const row=rowOf(assess(tree,[1],{conflictAdvice:advice?[conflict(lid(BOOK,1),factId)]:[],...options}),1);
    return outcomeOf(row);
  };
  const unchanged=['FULL','CANON_NO_CONFLICT'],beaten=['SUPPORT_ONLY','CHAT_FACT_SUPERSEDES_CANON'];
  assert.deepEqual(outcome(tree=>sceneFact(tree)),beaten,'baseline: verified observed fact');
  assert.deepEqual(outcome(tree=>sceneFact(tree),false),unchanged,'same subject and newer, but no conflict verdict');
  assert.deepEqual(outcome(tree=>memoryFact(tree)),unchanged,'a remembered statement does not establish a current fact');
  assert.deepEqual(outcome(tree=>memoryFact(tree,{authority:'OBSERVED'})),unchanged,'a memory record is never an established fact, whatever its label');
  assert.deepEqual(outcome(tree=>sceneFact(tree,{authority:'REMEMBERED'})),unchanged);
  assert.deepEqual(outcome(tree=>sceneFact(tree,{authority:'INFERRED'})),unchanged,'an inference does not beat canon');
  assert.deepEqual(outcome(tree=>sceneFact(tree,{status:'HISTORICAL'})),unchanged,'a closed scene is not current');
  assert.deepEqual(outcome(tree=>sceneFact(tree,{supersededBy:['scene-node-2']})),unchanged,'a superseded fact is not current');
  assert.deepEqual(outcome(tree=>sceneFact(tree,{chatId:'chat-2'})),unchanged,'another chat\'s fact is not visible here');
  assert.deepEqual(outcome(tree=>sceneFact(tree,{label:'Albedo'})),unchanged,'a conflict verdict on unrelated subjects is not applicable');
  assert.deepEqual(outcome(tree=>sceneFact(tree),true,{canonBooks:null}),['SUPPORT_ONLY','NO_STATUS_EVIDENCE'],'without a bound book canon is not canon, and the fact cannot demote it');
});

test('a disagreeing verdict, a stale revision or an unreadable partner voids the evidence',()=>{
  const run=(adviceFor)=>{
    const tree=new NexusWorldTree();
    importBook(tree,BOOK,[canon(1)]);
    const factId=sceneFact(tree);
    const node=createCanonicalWorldTreeReadApi({chatId:CHAT,worldTree:tree}).getNode(lid(BOOK,1));
    return outcomeOf(rowOf(assess(tree,[1],{conflictAdvice:adviceFor(factId,node)}),1));
  };
  const beaten=['SUPPORT_ONLY','CHAT_FACT_SUPERSEDES_CANON'],unchanged=['FULL','CANON_NO_CONFLICT'];
  assert.deepEqual(run(fact=>[conflict(lid(BOOK,1),fact)]),beaten);
  assert.deepEqual(run((fact,node)=>[conflict(lid(BOOK,1),fact,{leftRevision:node.revision})]),beaten,'a matching recorded revision applies');
  assert.deepEqual(run((fact,node)=>[conflict(lid(BOOK,1),fact,{leftRevision:node.revision+7})]),unchanged,'the canon node changed since it was judged');
  assert.deepEqual(run(fact=>[conflict(lid(BOOK,1),fact,{rightRevision:999})]),unchanged,'the chat fact changed since it was judged');
  assert.deepEqual(run(fact=>[conflict(lid(BOOK,1),fact),{choice:'CHANGE_OVER_TIME',left:fact,right:lid(BOOK,1)}]),unchanged,'a contrary verdict on the same pair');
  assert.deepEqual(run(fact=>[conflict(lid(BOOK,1),fact),{choice:'COMPATIBLE',left:lid(BOOK,1),right:fact}]),unchanged);
  assert.deepEqual(run(()=>[conflict(lid(BOOK,1),'scene-node-gone')]),unchanged,'a stale or unreadable partner');
  assert.deepEqual(run(fact=>[{choice:'UNRESOLVED',left:lid(BOOK,1),right:fact}]),unchanged,'only REAL_CONFLICT counts');
});

test('support-only evidence cannot win a conflict or settle one',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[
    canon(1),
    canon(2,{extensions:{nexusTemporal:{status:'UNCERTAIN'}}}),
    canon(3,{extensions:{nexusTemporal:{status:'HISTORICAL'}}}),
    canon(4),
  ]);
  const scene=sceneFact(tree);
  const api=createCanonicalWorldTreeReadApi({chatId:CHAT,worldTree:tree});
  assert.equal(isEstablishedChatFact(api.getNode(scene),CHAT),true);
  for(const uid of [2,3])assert.equal(isEstablishedChatFact(api.getNode(lid(BOOK,uid)),CHAT),false,'uncertain or historical lore is not a chat fact');
  // everything that can win is itself full weight; nothing support-only can
  assert.equal(decideTruthOutcome({classification:'CURRENT',intent:'CURRENT',usableForIntent:true,authority:'OBSERVED'}).outcome,'FULL');
  // canon vs canon: neither side settles the other, exempt or not
  const result=assess(tree,[1,4],{conflictAdvice:[conflict(lid(BOOK,1),lid(BOOK,4))]});
  for(const uid of [1,4])assert.deepEqual(outcomeOf(rowOf(result,uid)),['SUPPORT_ONLY','CONFLICT_UNSETTLED']);
  // an uncertain or historical canon fact in conflict with a scene fact keeps its explicit state
  const kept=assess(tree,[2,3],{conflictAdvice:[conflict(lid(BOOK,2),scene),conflict(lid(BOOK,3),scene)]});
  assert.equal(rowOf(kept,2).verdict.classification,'UNCERTAIN');
  assert.equal(rowOf(kept,3).verdict.classification,'HISTORICAL');
  // a memory candidate (support-only history) never beats canon, in either direction
  const memory=memoryFact(tree);
  const memoryRow=assessWorldTreeCandidates([{id:'mem-1'}],{worldTree:api,intent:'CURRENT',kind:'memory',chatId:CHAT,canonBooks:[BOOK],conflictAdvice:[conflict(memory,lid(BOOK,1))]}).rows[0];
  assert.equal(memoryRow.conflict,null);
  assert.notEqual(memoryRow.reasonCode,'CHAT_FACT_WINS');
  assert.deepEqual(outcomeOf(rowOf(assess(tree,[1],{conflictAdvice:[conflict(memory,lid(BOOK,1))]}),1)),['FULL','CANON_NO_CONFLICT']);
});

test('a chat-scoped candidate that beats canon is full weight, and only a verified one',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[canon(1)]);
  tree.upsertNode({id:'lore-fact:ChatBook:1',kind:'LORE_FACT',scope:{type:'CHAT',chatId:CHAT},provenance:{sourceType:'MESSAGE',sourceIds:['m1']},temporal:{status:'CURRENT'},data:{book:'ChatBook',uid:1,label:'Gazef',keys:['Gazef'],content:'chat fact',authority:'OBSERVED'}});
  const advice=[conflict(lid(BOOK,1),lid('ChatBook',1))];
  const win=rowOf(assess(tree,[1],{book:'ChatBook',conflictAdvice:advice}),1);
  assert.deepEqual([win.outcome,win.reasonCode,win.verdict.classification],['FULL','CHAT_FACT_WINS','CURRENT']);
  const node=tree.getNode('lore-fact:ChatBook:1',{chatId:CHAT});
  tree.upsertNode({...node,data:{...node.data,authority:'REMEMBERED'}});
  assert.equal(rowOf(assess(tree,[1],{book:'ChatBook',conflictAdvice:advice}),1).reasonCode,'STATUS_CURRENT','a remembered chat statement gets no precedence');
});

test('a fact scoped to a different chat never wins even if a read exposes it',()=>{
  const lore={id:'lore:Campaign:1',kind:'lore',scope:'global',temporalStatus:'UNRESOLVED',authority:null,importDefaultedTiming:true,revision:1,
    provenance:{sourceType:'SILLYTAVERN_WORLD_INFO',importedFrom:'legacy-lorebook',sourceIds:[BOOK,'1']},sourceRefs:[],aliases:['Gazef'],edges:[],payload:{book:BOOK,uid:1,title:'t',content:'c'}};
  const foreign={id:'scene-x',kind:'scene',scope:'chat-2',temporalStatus:'CURRENT',authority:'OBSERVED',revision:1,sourceRefs:[],aliases:['Gazef'],edges:[],payload:{}};
  const api=new NexusWorldTreeReadApi({nodes:[lore,foreign]});
  const run=chatId=>assessWorldTreeCandidates([{book:BOOK,uid:1}],{worldTree:api,intent:'CURRENT',kind:'lore',canonBooks:[BOOK],chatId,conflictAdvice:[conflict('lore:Campaign:1','scene-x')]}).rows[0];
  assert.equal(run('chat-1').conflict,null,'a foreign chat fact is not evidence here');
  assert.equal(run('chat-2').reasonCode,'CHAT_FACT_SUPERSEDES_CANON');
  assert.equal(run(null).conflict,null,'no chat identity, no winner');
});

test('conflicts between canon entries stay unsettled, and explicit states are not overridden',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[
    canon(1),canon(2),
    canon(3,{extensions:{nexusTemporal:{status:'HISTORICAL'}}}),
    canon(4,{extensions:{nexusTemporal:{status:'SUPERSEDED'}}}),
    canon(5,{extensions:{nexusTemporal:{status:'UNCERTAIN'}}}),
  ]);
  const factId=sceneFact(tree);
  const advice=[conflict(lid(BOOK,1),lid(BOOK,2)),conflict(lid(BOOK,3),factId),conflict(lid(BOOK,4),factId),conflict(lid(BOOK,5),factId)];
  const result=assess(tree,[1,2,3,4,5],{conflictAdvice:advice});
  for(const uid of [1,2]){
    assert.deepEqual(outcomeOf(rowOf(result,uid)),['SUPPORT_ONLY','CONFLICT_UNSETTLED']);
    assert.equal(rowOf(result,uid).timingUnspecified,false);
  }
  assert.equal(rowOf(result,3).verdict.classification,'HISTORICAL');
  assert.equal(rowOf(result,4).verdict.classification,'SUPERSEDED');
  assert.equal(rowOf(result,4).keep,false,'a superseded fact is not resurrected by a conflict report');
  assert.equal(rowOf(result,5).verdict.classification,'UNCERTAIN');
});

test('story isolation: only the single bound Lorebook supplies authority',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[canon(1)]);
  importBook(tree,OTHER,[canon(1)]);
  const otherNode=tree.getNode('lore-fact:'+OTHER+':1');
  tree.upsertNode({...otherNode,data:{...otherNode.data,authority:'CANON'}});
  for(const opts of [{book:OTHER},{book:OTHER,canonBooks:[OTHER,BOOK]},{canonBooks:[BOOK,OTHER]},{canonBooks:[]},{canonBooks:null},{canonBooks:['Elsewhere']}]){
    const row=rowOf(assess(tree,[1],opts),1);
    assert.equal(row.authority,null,JSON.stringify(opts));
    assert.deepEqual(outcomeOf(row),['SUPPORT_ONLY','NO_STATUS_EVIDENCE'],JSON.stringify(opts));
  }
  assert.equal(rowOf(assess(tree,[1],{book:OTHER,canonBooks:[OTHER]}),1).authority,'CANON');
  assert.equal(rowOf(assess(tree,[1]),1).outcome,'FULL');
  // a verified chat fact cannot demote a book that is not the bound one
  const factId=sceneFact(tree);
  const row=rowOf(assess(tree,[1],{book:OTHER,conflictAdvice:[conflict(lid(OTHER,1),factId)]}),1);
  assert.notEqual(row.reasonCode,'CHAT_FACT_SUPERSEDES_CANON');
  assert.equal(row.conflict,null);
});

test('every classification carries a fixed reason code for its outcome, with no story text',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[
    canon(1),canon(2),
    canon(3,{extensions:{nexusTemporal:{status:'HISTORICAL'}}}),
    canon(4,{extensions:{nexusTemporal:{status:'SUPERSEDED'}}}),
    canon(5,{extensions:{nexusTemporal:{status:'UNCERTAIN'}}}),
    canon(6,{extensions:{nexusTemporal:{status:'CONTRADICTED'}}}),
    canon(7,{extensions:{nexusTemporal:{status:'CURRENT'}}}),
    canon(8,{extensions:{nexusTemporal:{status:'UNRESOLVED'}}}),
  ]);
  const factId=sceneFact(tree);
  const seen=new Set();
  for(const intent of ['CURRENT','HISTORICAL','TEMPORAL','CONTRADICTION']){
    const result=assess(tree,[1,2,3,4,5,6,7,8,99],{intent,conflictAdvice:[conflict(lid(BOOK,1),factId)]});
    assert.equal(result.rows.length,9);
    for(const row of result.rows){
      assert.ok(isKnownTruthReasonCode(row.outcome,row.reasonCode),`${intent} ${row.candidateId}: ${row.outcome}/${row.reasonCode}`);
      assert.match(row.reasonCode,/^[A-Z_]+$/);
      assert.equal(row.keep,row.outcome!=='DROPPED');
      assert.equal(row.supportOnly,row.outcome==='SUPPORT_ONLY');
      seen.add(row.reasonCode);
    }
    for(const candidate of result.candidates)assert.equal(candidate.a52Truth.reasonCode,rowOf(result,candidate.uid).reasonCode);
  }
  assert.ok(seen.size>=8,'scenarios exercise many distinct codes: '+[...seen]);
  assert.ok(TRUTH_REASON_CODES.FULL.includes('CANON_NO_CONFLICT')&&TRUTH_REASON_CODES.SUPPORT_ONLY.includes('NO_STATUS_EVIDENCE'));
  assert.equal(isKnownTruthReasonCode('FULL','NO_STATUS_EVIDENCE'),false);
});

// ---------------------------------------------------------------- delivery: the real render functions

function extractFunction(source,signature){
  const start=source.indexOf(signature);
  assert.ok(start>=0,'function signature changed; update the test loader: '+signature);
  const bodyStart=source.indexOf('{',start+signature.length-1);
  let depth=0,end=bodyStart;
  for(let i=bodyStart;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'){depth--;if(!depth){end=i+1;break;}}}
  return source.slice(start,end);
}
function loadRenderInjection(){
  const source=read('retrieval/retriever.js');
  const start=source.indexOf('function renderInjection(');
  const signatureEnd=source.indexOf('} = {}) {',start)+'} = {}) '.length;
  const code=extractFunction(source,source.slice(start,signatureEnd));
  const stubs={
    candidateKey:(book,uid)=>JSON.stringify([book,Number(uid)]),
    estimateContentTokens:text=>Math.ceil(String(text).length/4),
    canonicalLorePresentation:rows=>[...rows],
    planLorePresentationCache:({currentCandidates})=>({orderedCandidates:[...currentCandidates].reverse(),strategy:'test',hasPrior:false,previousCount:0}),
    sameLorePresentationMembership:(a,b)=>a.length===b.length&&a.every(row=>b.includes(row)),
  };
  const names=[...Object.keys(stubs),'fullWeightFirst','truthChunkPrefix'];
  return new Function(...names,code+'\nreturn renderInjection;')(...Object.values(stubs),fullWeightFirst,truthChunkPrefix);
}
function loadRecallRender(){
  const code=extractFunction(read('memory/recall.js'),"function render(records,budgetTokens=null,model='',characterMemories=[]){");
  const stubs={characterMemoryRenderBlocks:()=>[],estimateContentTokens:text=>Math.ceil(String(text).length/4)};
  return new Function(...Object.keys(stubs),'fullWeightFirst','truthChunkPrefix',code+'\nreturn render;')(...Object.values(stubs),fullWeightFirst,truthChunkPrefix);
}
const cand=(uid,weight,label='')=>({book:BOOK,uid,title:'T'+uid,content:'content '+uid,a52Truth:weight?{weight,presentationLabel:label}:undefined});

test('lore delivery marks support-only text as context and admits it after full-weight text',()=>{
  const render=loadRenderInjection();
  const out=render([cand(1,'SUPPORT_ONLY'),cand(2,'FULL'),cand(3,'SUPPORT_ONLY','[Disputed]'),cand(4,undefined),cand(5,'FULL','[Past]')],0,'m');
  const text=out.text,at=uid=>text.indexOf(`UID ${uid} `);
  assert.deepEqual(out.includedCandidates.map(c=>c.uid).sort(),[1,2,3,4,5],'nothing is dropped without a budget');
  assert.ok(Math.min(at(2),at(4),at(5))>=0&&Math.min(at(1),at(3))>Math.max(at(2),at(4),at(5)),'full-weight text precedes support-only text even after the planner reorders');
  assert.ok(text.includes(CONTEXT_ONLY_MARKER+' [Campaign | UID 1 '));
  assert.ok(text.includes('[Disputed] '+CONTEXT_ONLY_MARKER+' [Campaign | UID 3'));
  assert.equal(text.split(CONTEXT_ONLY_MARKER).length-1,2);
  assert.ok(!text.includes(CONTEXT_ONLY_MARKER+' [Campaign | UID 2'));
});

test('under budget pressure support-only lore is the first to go, but required lore is never lost',()=>{
  const render=loadRenderInjection();
  const rows=[cand(1,'SUPPORT_ONLY'),cand(2,'FULL'),cand(3,'FULL'),cand(4,'SUPPORT_ONLY')];
  const cost=row=>{const prefix=truthChunkPrefix(row.a52Truth);return Math.ceil(((prefix?prefix+' ':'')+`[${row.book} | UID ${row.uid} | ${row.title}]\n${row.content}`).length/4);};
  const budget=cost(rows[0])+cost(rows[1])+1;
  assert.ok(cost(rows[1])+cost(rows[2])<=budget&&cost(rows[1])+cost(rows[2])+cost(rows[0])>budget);
  const tight=render(rows,budget,'m');
  assert.deepEqual(tight.includedCandidates.map(c=>c.uid).sort(),[2,3]);
  assert.equal(tight.omitted,2);
  assert.ok(render(rows,budget,'m',{requiredRefs:[{book:BOOK,uid:1}]}).includedCandidates.some(c=>c.uid===1));
  assert.equal(render(rows,100000,'m').includedCandidates.length,4);
});

test('Memory recall treats support-only memory the same way: marked, ordered last, budgeted last',()=>{
  const render=loadRecallRender();
  const record=(id,layer,weight,label='')=>({id,layer,turnRange:[id*10,id*10+5],text:'summary '+id,a52Truth:weight?{weight,presentationLabel:label}:undefined});
  const records=[record(1,3,'SUPPORT_ONLY','[Past]'),record(2,1,'FULL'),record(3,2,'SUPPORT_ONLY','[Past]'),record(4,1,undefined)];
  const out=render(records,0,'m');
  const at=id=>out.text.indexOf(`summary ${id}\n`);
  assert.deepEqual(out.includedIds.sort(),['1','2','3','4']);
  assert.ok(Math.max(at(2),at(4))<Math.min(at(1),at(3)),'full-weight memory precedes support-only memory despite deeper layers');
  assert.equal(out.text.split(CONTEXT_ONLY_MARKER).length-1,2);
  assert.ok(out.text.includes('[Past] '+CONTEXT_ONLY_MARKER+' [L3'));
  assert.ok(!out.text.includes(CONTEXT_ONLY_MARKER+' [L1'));
  const blockCost=r=>Math.ceil(`\n${truthChunkPrefix(r.a52Truth)?truthChunkPrefix(r.a52Truth)+' ':''}[L${r.layer} | messages ${r.turnRange[0]}-${r.turnRange[1]}]\n${r.text}\n`.length/4);
  const headerCost=Math.ceil(render([],0,'m').text.length/4);
  const limited=render([records[0],records[1]],headerCost+blockCost(records[1])+2,'m');
  assert.deepEqual(limited.includedIds,['2'],'support-only memory only gets what full-weight memory leaves');
  assert.equal(limited.omitted,1);
});

test('memory records are historical context unless asked about, never a current fact',()=>{
  const record={id:'mem-9',layer:1,text:'Mara used to live at the docks.',sourceMessageIds:['m1'],characters:['Mara'],locations:['Docks'],createdAt:1,updatedAt:2};
  const api=new NexusWorldTreeReadApi({nodes:[memoryNodeFromRecord(record,{chatId:CHAT})]});
  const by=intent=>assessWorldTreeCandidates([record],{worldTree:api,intent,kind:'memory',chatId:CHAT}).rows[0];
  assert.deepEqual(outcomeOf(by('CURRENT')),['SUPPORT_ONLY','STATUS_HISTORICAL_CONTEXT']);
  assert.deepEqual(outcomeOf(by(inferTruthIntent('Where did Mara live previously?'))),['FULL','STATUS_MATCHES_TEMPORAL_QUESTION']);
  assert.deepEqual(outcomeOf(by(inferTruthIntent('Mara returns to the docks after dusk, remembering when she used to live there.'))),['SUPPORT_ONLY','STATUS_HISTORICAL_CONTEXT']);
});

test('every consumer of Truth outcomes is accounted for and renders through the shared helpers',()=>{
  const skip=new Set(['tests','node_modules','.git','docs','records']);
  const users=[];
  (function walk(dir){
    for(const name of fs.readdirSync(dir,{withFileTypes:true})){
      if(skip.has(name.name))continue;
      const full=path.join(dir,name.name);
      if(name.isDirectory())walk(full);
      else if(name.name.endsWith('.js')){
        const rel=path.relative(root,full).split(path.sep).join('/');
        if(rel==='nexus/truth-classification.js'||rel==='nexus/a52/truth/status-resolver.js')continue;
        const source=fs.readFileSync(full,'utf8');
        if(/\ba52Truth\b/.test(source)||/\bassessWorldTreeCandidates\b/.test(source))users.push(rel);
      }
    }
  })(root);
  assert.deepEqual(users.sort(),['memory/recall.js','retrieval/retriever.js'],'a new consumer of Truth outcomes must be added here on purpose, with enforcement');
  for(const file of users){
    const source=read(file);
    assert.ok(source.includes('truthChunkPrefix(')&&source.includes('fullWeightFirst('),file+' must mark and order support-only text');
  }
  assert.ok(read('retrieval/retriever.js').includes('truthChunkPrefix(candidate?.a52Truth)'));
  assert.ok(read('memory/recall.js').includes('truthChunkPrefix(r?.a52Truth)'));
  // Diagnostics and UI only read the verdict events; nothing writes Truth output into the World Tree.
  for(const file of users)assert.ok(!/upsertNode|applyWorldTreeContribution|linkEdge/.test(read(file)),file);
});

test('the retriever hands Truth the exact chat and the bound books',()=>{
  const source=read('retrieval/retriever.js');
  assert.equal(source.match(/canonBooks:books,\n\s+chatId:scope\?\.chatId\?\?context\?\.chatId\?\?null,/g)?.length,2);
  assert.ok(source.includes('fullWeightFirst(rows,row=>row.candidate?.a52Truth)'));
});

test('no automatic chat-versus-canon conflict producer is part of Truth classification',()=>{
  assert.equal(fs.existsSync(path.join(root,'decision/truth-conflict-pairs.js')),false);
  const task8=read('decision/task8-runtime.js');
  assert.ok(!task8.includes('chatCanonConflictPairs'));
  assert.ok(!task8.includes('readWorldTreeStoryBinding'));
  assert.ok(fs.existsSync(path.join(root,'docs/truth-chat-canon-conflict-producer-proposal.md')),'the producer is documented as a separate proposal');
});

test('Diagnostics keeps reason codes, outcomes and counts, and still drops story text',()=>{
  const verdict=createNexusDiagnosticEvent({channelId:NexusDiagnosticChannel.TRUTH,name:'candidate-verdict',selection:{generationId:'g1'},metrics:{
    intent:'CURRENT',classification:'UNRESOLVED',kept:true,supportOnly:false,outcome:'FULL',reasonCode:'CANON_NO_CONFLICT',authority:'CANON',timingUnspecified:true,
    story:'Gazef is alive in Nazarick',prompt:'raw prompt',
  }});
  assert.equal(verdict.data.reasonCode,'CANON_NO_CONFLICT');
  assert.equal(verdict.data.outcome,'FULL');
  assert.equal(verdict.data.authority,'CANON');
  assert.equal(verdict.data.timingUnspecified,true);
  assert.equal(verdict.data.story,undefined);
  const summary=createNexusDiagnosticEvent({channelId:NexusDiagnosticChannel.TRUTH,name:'assessment-complete',selection:{generationId:'g1'},metrics:{
    candidateCount:82,keptCount:82,droppedCount:0,unresolvedCount:0,unspecifiedTimingCount:80,
    outcomeCounts:{FULL:80,SUPPORT_ONLY:2,DROPPED:0},reasonCodeCounts:{CANON_NO_CONFLICT:80,CHAT_FACT_SUPERSEDES_CANON:2},
  }});
  assert.equal(summary.data.unspecifiedTimingCount,80);
  assert.equal(summary.data.outcomeCounts.SUPPORT_ONLY,2);
  assert.equal(summary.data.reasonCodeCounts.CHAT_FACT_SUPERSEDES_CANON,2);
});
