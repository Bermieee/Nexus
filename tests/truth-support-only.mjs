import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NexusWorldTree } from '../world-tree/store.js';
import { importLegacyLoreBookToWorldTree } from '../world-tree/import-lore.js';
import { NexusWorldTreeReadApi, createCanonicalWorldTreeReadApi } from '../core/world-tree-api.js';
import { assessWorldTreeCandidates, summarizeTruthAssessment, truthNeedsCorrection } from '../nexus/a52/truth/status-resolver.js';
import {
  CONTEXT_ONLY_MARKER, TRUTH_REASON_CODES, fullWeightFirst, isKnownTruthReasonCode, truthChunkPrefix,
} from '../nexus/truth-classification.js';
import { chatCanonConflictPairs } from '../decision/truth-conflict-pairs.js';
import { NexusDiagnosticChannel, createNexusDiagnosticEvent } from '../nexus/diagnostics-source.js';

const BOOK='Campaign',OTHER='GlobalBook',CHAT='chat-1';
const entry=(uid,extra={})=>({uid,comment:'Entry '+uid,key:['k'+uid],content:'Authored text '+uid,order:100,...extra});
const importBook=(tree,book,entries)=>importLegacyLoreBookToWorldTree(tree,{book,data:{entries:Object.fromEntries(entries.map(row=>[row.uid,row]))},legacyTree:null});
const lid=(book,uid)=>`lore:${book}:${uid}`;
function memoryFact(tree,{id='mem-1',chatId=CHAT,authority='REMEMBERED',status='CURRENT',characters=['Gazef'],text='Gazef is alive and standing in Nazarick.'}={}){
  tree.upsertNode({id:'memory-node-'+id,kind:'MEMORY',scope:{type:'CHAT',chatId},provenance:{sourceType:'MESSAGE',sourceIds:[id]},temporal:{status},data:{id,text,layer:1,characters,authority}});
  return 'memory:'+id;
}
const assess=(tree,uids,{book=BOOK,canonBooks=[BOOK],intent='CURRENT',chatId=CHAT,conflictAdvice=[]}={})=>{
  const api=createCanonicalWorldTreeReadApi({chatId,worldTree:tree});
  return assessWorldTreeCandidates(uids.map(uid=>({book,uid})),{worldTree:api,intent,kind:'lore',canonBooks,chatId,conflictAdvice});
};
const rowOf=(result,uid)=>result.rows.find(row=>row.candidate.uid===uid);
const conflict=(left,right)=>({choice:'REAL_CONFLICT',left,right});

test('ordinary verified canon keeps normal use and weight; its status stays UNRESOLVED',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1)]);
  const row=rowOf(assess(tree,[1]),1);
  assert.equal(row.verdict.classification,'UNRESOLVED');
  assert.equal(row.outcome,'FULL');
  assert.equal(row.reasonCode,'CANON_NO_CONFLICT');
  assert.equal(row.supportOnly,false);
  assert.equal(row.keep,true);
  const kept=assess(tree,[1]).candidates[0].a52Truth;
  assert.equal(kept.weight,'FULL');
  assert.equal(truthChunkPrefix(kept),'','full-weight text is delivered unmarked');
});

test('explicit uncertainty and genuinely unresolved evidence are support only',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[
    entry(1,{extensions:{nexusTemporal:{status:'UNCERTAIN'}}}),
    entry(2,{extensions:{nexusTemporal:{status:'UNRESOLVED'}}}),
    entry(3),
  ]);
  const result=assess(tree,[1,2,3]);
  assert.deepEqual([rowOf(result,1).outcome,rowOf(result,1).reasonCode],['SUPPORT_ONLY','STATUS_UNCERTAIN']);
  assert.deepEqual([rowOf(result,2).outcome,rowOf(result,2).reasonCode],['SUPPORT_ONLY','STATUS_DECLARED_UNRESOLVED']);
  assert.equal(rowOf(result,3).outcome,'FULL');
  const unbound=rowOf(assess(tree,[3],{canonBooks:null}),3);
  assert.equal(unbound.verdict.classification,'UNRESOLVED');
  assert.deepEqual([unbound.outcome,unbound.reasonCode,unbound.keep],['SUPPORT_ONLY','NO_STATUS_EVIDENCE',true],'no verified authority means insufficient evidence, kept as context only');
  const stats=summarizeTruthAssessment(result);
  assert.equal(stats.supportOnlyCount,2);
  assert.equal(truthNeedsCorrection(stats),true,'genuine open questions still call for correction');
});

test('the canon exemption never answers temporal questions or overrides explicit state',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[
    entry(1),
    entry(2,{extensions:{nexusTemporal:{status:'HISTORICAL'}}}),
    entry(3,{extensions:{nexusTemporal:{status:'SUPERSEDED',supersededBy:'lore:Campaign:1'}}}),
  ]);
  const by=intent=>assess(tree,[1,2,3],{intent});
  const plain=intent=>{const r=rowOf(by(intent),1);return[r.outcome,r.reasonCode];};
  assert.deepEqual(plain('CURRENT'),['FULL','CANON_NO_CONFLICT']);
  assert.deepEqual(plain('TEMPORAL'),['SUPPORT_ONLY','CANON_TIMING_NOT_ESTABLISHED'],'does not establish when it is true');
  assert.deepEqual(plain('CONTRADICTION'),['SUPPORT_ONLY','CANON_TIMING_NOT_ESTABLISHED'],'does not settle contradictions');
  assert.deepEqual(plain('HISTORICAL'),['DROPPED','CANON_TIMING_NOT_ESTABLISHED'],'does not answer historical questions without evidence');
  assert.equal(rowOf(by('HISTORICAL'),1).verdict.classification,'UNRESOLVED');
  // explicit history is still honored
  assert.deepEqual([rowOf(by('CURRENT'),2).outcome,rowOf(by('CURRENT'),2).reasonCode],['SUPPORT_ONLY','STATUS_HISTORICAL_CONTEXT']);
  assert.deepEqual([rowOf(by('HISTORICAL'),2).outcome,rowOf(by('HISTORICAL'),2).reasonCode],['FULL','STATUS_MATCHES_TEMPORAL_QUESTION']);
  assert.deepEqual([rowOf(by('CURRENT'),3).outcome,rowOf(by('CURRENT'),3).reasonCode],['DROPPED','STATUS_SUPERSEDED']);
  assert.equal(rowOf(by('HISTORICAL'),3).outcome,'FULL');
});

test('a chat-established fact wins for this chat only; canon becomes disputed support, global lore is untouched',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1,{comment:'Gazef Stronoff',key:['Gazef'],content:'Gazef dies at the Katze Plains.'})]);
  const factId=memoryFact(tree);
  const advice=[conflict(lid(BOOK,1),factId)];
  const revision=tree.revision,before=JSON.stringify(tree.exportState());
  const row=rowOf(assess(tree,[1],{conflictAdvice:advice}),1);
  assert.equal(row.verdict.classification,'CONTRADICTED');
  assert.deepEqual([row.outcome,row.reasonCode,row.conflict],['SUPPORT_ONLY','CHAT_FACT_SUPERSEDES_CANON','CHAT_LOSES']);
  assert.equal(row.presentationLabel,'[Disputed]');
  assert.equal(row.keep,true);
  assert.equal(tree.revision,revision,'assessment never writes the World Tree');
  assert.equal(JSON.stringify(tree.exportState()),before);
  assert.equal(tree.getNode('lore-fact:'+BOOK+':1').data.authority,undefined);
  assert.equal(tree.getNode('lore-fact:'+BOOK+':1').temporal.status,'UNRESOLVED','global lore keeps its own status');
  // another chat cannot see this chat's fact and keeps reading canon
  const other=rowOf(assess(tree,[1],{chatId:'chat-2',conflictAdvice:advice}),1);
  assert.deepEqual([other.verdict.classification,other.outcome,other.reasonCode],['UNRESOLVED','FULL','CANON_NO_CONFLICT']);
  const none=rowOf(assess(tree,[1]),1);
  assert.deepEqual([none.outcome,none.reasonCode],['FULL','CANON_NO_CONFLICT'],'no conflict, no change');
});

test('only a current, observed or remembered fact from this exact chat can win',()=>{
  const losing=(options,chatId=CHAT)=>{
    const tree=new NexusWorldTree();
    importBook(tree,BOOK,[entry(1)]);
    const factId=memoryFact(tree,options);
    const r=rowOf(assess(tree,[1],{chatId,conflictAdvice:[conflict(lid(BOOK,1),factId)]}),1);
    return[r.outcome,r.reasonCode];
  };
  assert.deepEqual(losing({}),['SUPPORT_ONLY','CHAT_FACT_SUPERSEDES_CANON']);
  assert.deepEqual(losing({authority:'OBSERVED'}),['SUPPORT_ONLY','CHAT_FACT_SUPERSEDES_CANON']);
  assert.deepEqual(losing({authority:'INFERRED'}),['SUPPORT_ONLY','CONFLICT_UNSETTLED'],'an inference does not beat canon');
  assert.deepEqual(losing({status:'HISTORICAL'}),['SUPPORT_ONLY','CONFLICT_UNSETTLED'],'a past chat fact does not beat canon');
  assert.deepEqual(losing({chatId:'chat-2'},'chat-2'),['SUPPORT_ONLY','CHAT_FACT_SUPERSEDES_CANON'],'wins in its own chat');
  assert.deepEqual(losing({chatId:'chat-2'}),['FULL','CANON_NO_CONFLICT'],'an unseen fact from another chat is ignored');
});

test('a fact scoped to a different chat never wins even if a read exposes it',()=>{
  const canon={id:'lore:Campaign:1',kind:'lore',scope:'global',temporalStatus:'UNRESOLVED',authority:null,importDefaultedTiming:true,
    provenance:{sourceType:'SILLYTAVERN_WORLD_INFO',importedFrom:'legacy-lorebook',sourceIds:[BOOK,'1']},sourceRefs:[],aliases:[],edges:[],payload:{book:BOOK,uid:1,title:'t',content:'c'}};
  const foreign={id:'memory:x',kind:'memory',scope:'chat-2',temporalStatus:'CURRENT',authority:'REMEMBERED',sourceRefs:[],aliases:[],edges:[],payload:{id:'x',text:'t'}};
  const api=new NexusWorldTreeReadApi({nodes:[canon,foreign]});
  const run=chatId=>assessWorldTreeCandidates([{book:BOOK,uid:1}],{worldTree:api,intent:'CURRENT',kind:'lore',canonBooks:[BOOK],chatId,conflictAdvice:[conflict('lore:Campaign:1','memory:x')]}).rows[0];
  assert.equal(run('chat-1').reasonCode,'CONFLICT_UNSETTLED','a foreign chat fact cannot demote canon as a winner');
  assert.equal(run('chat-2').reasonCode,'CHAT_FACT_SUPERSEDES_CANON');
  assert.equal(run(null).reasonCode,'CONFLICT_UNSETTLED','no chat identity, no winner');
});

test('conflicts without a chat winner stay unsettled, and explicit states are not overridden',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[
    entry(1),entry(2),
    entry(3,{extensions:{nexusTemporal:{status:'HISTORICAL'}}}),
    entry(4,{extensions:{nexusTemporal:{status:'SUPERSEDED'}}}),
    entry(5,{extensions:{nexusTemporal:{status:'UNCERTAIN'}}}),
  ]);
  const factId=memoryFact(tree);
  const advice=[conflict(lid(BOOK,1),lid(BOOK,2)),conflict(lid(BOOK,3),factId),conflict(lid(BOOK,4),factId),conflict(lid(BOOK,5),factId)];
  const result=assess(tree,[1,2,3,4,5],{conflictAdvice:advice});
  for(const uid of [1,2]){
    assert.deepEqual([rowOf(result,uid).outcome,rowOf(result,uid).reasonCode],['SUPPORT_ONLY','CONFLICT_UNSETTLED'],'canon cannot settle canon, exempt or not');
    assert.equal(rowOf(result,uid).timingUnspecified,false);
  }
  assert.equal(rowOf(result,3).verdict.classification,'HISTORICAL');
  assert.equal(rowOf(result,4).verdict.classification,'SUPERSEDED');
  assert.equal(rowOf(result,4).keep,false,'a superseded fact is not resurrected by a conflict report');
  assert.equal(rowOf(result,5).verdict.classification,'UNCERTAIN');
  assert.deepEqual(summarizeTruthAssessment(result).unspecifiedTimingCount,0);
});

test('a chat-scoped candidate that beats canon is full weight; a stale partner changes nothing',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1)]);
  tree.upsertNode({id:'lore-fact:ChatBook:1',kind:'LORE_FACT',scope:{type:'CHAT',chatId:CHAT},provenance:{sourceType:'MESSAGE',sourceIds:['m1']},temporal:{status:'CURRENT'},data:{book:'ChatBook',uid:1,label:'chat',content:'chat fact',authority:'OBSERVED'}});
  const win=rowOf(assess(tree,[1],{book:'ChatBook',conflictAdvice:[conflict(lid(BOOK,1),lid('ChatBook',1))]}),1);
  assert.deepEqual([win.outcome,win.reasonCode,win.verdict.classification],['FULL','CHAT_FACT_WINS','CURRENT']);
  const stale=rowOf(assess(tree,[1],{conflictAdvice:[conflict(lid(BOOK,1),'memory:gone')]}),1);
  assert.deepEqual([stale.outcome,stale.reasonCode],['FULL','CANON_NO_CONFLICT'],'an unresolvable partner is not a conflict');
});

test('story isolation: only the single bound Lorebook supplies authority',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1)]);
  importBook(tree,OTHER,[entry(1)]);
  const otherNode=tree.getNode('lore-fact:'+OTHER+':1');
  tree.upsertNode({...otherNode,data:{...otherNode.data,authority:'CANON'}});
  for(const opts of [{book:OTHER},{book:OTHER,canonBooks:[OTHER,BOOK]},{canonBooks:[BOOK,OTHER]},{canonBooks:[]},{canonBooks:null},{canonBooks:['Elsewhere']}]){
    const row=rowOf(assess(tree,[1],opts),1);
    assert.equal(row.authority,null,JSON.stringify(opts));
    assert.deepEqual([row.outcome,row.reasonCode],['SUPPORT_ONLY','NO_STATUS_EVIDENCE'],JSON.stringify(opts));
  }
  assert.equal(rowOf(assess(tree,[1],{book:OTHER,canonBooks:[OTHER]}),1).authority,'CANON');
  assert.equal(rowOf(assess(tree,[1]),1).outcome,'FULL');
  // a chat fact cannot demote a book that is not the bound one
  const factId=memoryFact(tree);
  const row=rowOf(assess(tree,[1],{book:OTHER,conflictAdvice:[conflict(lid(OTHER,1),factId)]}),1);
  assert.notEqual(row.reasonCode,'CHAT_FACT_SUPERSEDES_CANON');
});

test('conflict candidates pair chat facts only with bound-book canon of this chat',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1,{comment:'Gazef Stronoff',key:['Gazef'],content:'Gazef dies.'})]);
  importBook(tree,OTHER,[entry(1,{comment:'Gazef Stronoff',key:['Gazef'],content:'Gazef lives elsewhere.'})]);
  const mine=memoryFact(tree);
  memoryFact(tree,{id:'mem-other-chat',chatId:'chat-2'});
  memoryFact(tree,{id:'mem-inferred',authority:'INFERRED'});
  const api=createCanonicalWorldTreeReadApi({chatId:CHAT,worldTree:tree});
  const pairs=chatCanonConflictPairs({api,nodes:api.allNodes(),chatId:CHAT,canonBooks:[BOOK]});
  assert.deepEqual(pairs.map(p=>[p.canonNode.id,p.chatNode.id]),[[lid(BOOK,1),mine]]);
  assert.deepEqual(chatCanonConflictPairs({api,nodes:api.allNodes(),chatId:CHAT,canonBooks:[BOOK,OTHER]}),[]);
  assert.deepEqual(chatCanonConflictPairs({api,nodes:api.allNodes(),chatId:CHAT,canonBooks:null}),[]);
  assert.deepEqual(chatCanonConflictPairs({api,nodes:api.allNodes(),chatId:null,canonBooks:[BOOK]}),[]);
});

test('every classification carries a fixed reason code for its outcome, with no story text',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[
    entry(1),entry(2),
    entry(3,{extensions:{nexusTemporal:{status:'HISTORICAL'}}}),
    entry(4,{extensions:{nexusTemporal:{status:'SUPERSEDED'}}}),
    entry(5,{extensions:{nexusTemporal:{status:'UNCERTAIN'}}}),
    entry(6,{extensions:{nexusTemporal:{status:'CONTRADICTED'}}}),
    entry(7,{extensions:{nexusTemporal:{status:'CURRENT'}}}),
    entry(8,{extensions:{nexusTemporal:{status:'UNRESOLVED'}}}),
  ]);
  const factId=memoryFact(tree);
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
  assert.equal(isKnownTruthReasonCode('FULL','NO_STATUS_EVIDENCE'),false,'codes are fixed per outcome');
});

// ---- final delivery: the real renderInjection from the retriever, with its imports stubbed ----
function loadRenderInjection(){
  const source=fs.readFileSync(new URL('../retrieval/retriever.js',import.meta.url),'utf8');
  const start=source.indexOf('function renderInjection(');
  const bodyStart=source.indexOf('} = {}) {',start)+'} = {}) '.length;
  assert.ok(start>=0&&bodyStart>start,'renderInjection signature changed; update the test loader');
  let depth=0,end=bodyStart;
  for(let i=bodyStart;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'){depth--;if(!depth){end=i+1;break;}}}
  const stubs={
    candidateKey:(book,uid)=>JSON.stringify([book,Number(uid)]),
    estimateContentTokens:text=>Math.ceil(String(text).length/4),
    canonicalLorePresentation:rows=>[...rows],
    // adversarial planner: reverses, so ordering must be re-imposed after planning
    planLorePresentationCache:({currentCandidates})=>({orderedCandidates:[...currentCandidates].reverse(),strategy:'test',hasPrior:false,previousCount:0}),
    sameLorePresentationMembership:(a,b)=>a.length===b.length&&a.every(row=>b.includes(row)),
  };
  const names=[...Object.keys(stubs),'fullWeightFirst','truthChunkPrefix'];
  return new Function(...names,source.slice(start,end)+'\nreturn renderInjection;')(...Object.values(stubs),fullWeightFirst,truthChunkPrefix);
}
const cand=(uid,weight,label='')=>({book:BOOK,uid,title:'T'+uid,content:'content '+uid,a52Truth:weight?{weight,presentationLabel:label}:undefined});

test('final delivery labels support-only text as context and admits it after full-weight text',()=>{
  const render=loadRenderInjection();
  const out=render([cand(1,'SUPPORT_ONLY'),cand(2,'FULL'),cand(3,'SUPPORT_ONLY','[Disputed]'),cand(4,undefined),cand(5,'FULL','[Past]')],0,'m');
  const text=out.text;
  assert.deepEqual(out.includedCandidates.map(c=>c.uid),[1,2,3,4,5],'nothing is dropped without a budget');
  const at=uid=>text.indexOf(`UID ${uid} `);
  const lastFull=Math.max(at(2),at(4),at(5)),firstSupport=Math.min(at(1),at(3));
  assert.ok(Math.min(at(2),at(4),at(5))>=0&&firstSupport>lastFull,'full-weight text precedes support-only text even after the planner reorders');
  assert.ok(text.includes(CONTEXT_ONLY_MARKER+' [Campaign | UID 1 '),'support-only chunk carries the marker');
  assert.ok(text.includes('[Disputed] '+CONTEXT_ONLY_MARKER+' [Campaign | UID 3'),'marker follows the presentation label');
  assert.equal(text.split(CONTEXT_ONLY_MARKER).length-1,2);
  assert.ok(!text.includes(CONTEXT_ONLY_MARKER+' [Campaign | UID 2'),'full-weight text is unmarked');
});

test('under budget pressure support-only text is the first to go, but required text is never lost',()=>{
  const render=loadRenderInjection();
  const rows=[cand(1,'SUPPORT_ONLY'),cand(2,'FULL'),cand(3,'FULL'),cand(4,'SUPPORT_ONLY')];
  const cost=row=>{const prefix=truthChunkPrefix(row.a52Truth);return Math.ceil(((prefix?prefix+' ':'')+`[${row.book} | UID ${row.uid} | ${row.title}]\n${row.content}`).length/4);};
  // Room for one support-only chunk plus one full chunk, but not both full chunks plus any context:
  // list order would admit the support-only chunk first; full-weight-first admits both full chunks.
  const budget=cost(rows[0])+cost(rows[1])+1;
  assert.ok(cost(rows[1])+cost(rows[2])<=budget&&cost(rows[1])+cost(rows[2])+cost(rows[0])>budget);
  const tight=render(rows,budget,'m');
  assert.deepEqual(tight.includedCandidates.map(c=>c.uid).sort(),[2,3]);
  assert.equal(tight.omitted,2);
  const required=render(rows,budget,'m',{requiredRefs:[{book:BOOK,uid:1}]});
  assert.ok(required.includedCandidates.some(c=>c.uid===1),'a required ref is still delivered');
  const roomy=render(rows,100000,'m');
  assert.equal(roomy.includedCandidates.length,4,'with room, context is still delivered');
});

test('the retriever hands Truth the exact chat and renders through the shared helpers',()=>{
  const source=fs.readFileSync(new URL('../retrieval/retriever.js',import.meta.url),'utf8');
  assert.equal(source.match(/canonBooks:books,\n\s+chatId:scope\?\.chatId\?\?context\?\.chatId\?\?null,/g)?.length,2,'both Truth assessment calls receive the bound books and the exact chat');
  assert.ok(source.includes('truthChunkPrefix(candidate?.a52Truth)'));
  assert.ok(source.includes('fullWeightFirst(rows,row=>row.candidate?.a52Truth)'));
  const task8=fs.readFileSync(new URL('../decision/task8-runtime.js',import.meta.url),'utf8');
  assert.ok(task8.includes('chatCanonConflictPairs'));
  assert.ok(task8.includes('canonBooks:storyBinding?[storyBinding.book]:null'));
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
