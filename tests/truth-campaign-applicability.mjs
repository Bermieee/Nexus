import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NexusWorldTree } from '../world-tree/store.js';
import { importLegacyLoreBookToWorldTree } from '../world-tree/import-lore.js';
import { createCanonicalWorldTreeReadApi } from '../core/world-tree-api.js';
import { assessWorldTreeCandidates, summarizeTruthAssessment, truthNeedsCorrection } from '../nexus/a52/truth/status-resolver.js';
import {
  CAMPAIGN_APPLICABILITY, CONTEXT_ONLY_MARKER, TRUTH_REASON_CODES, fullWeightFirst, isKnownTruthReasonCode, truthChunkPrefix,
} from '../nexus/truth-classification.js';
import { NexusDiagnosticChannel, createNexusDiagnosticEvent } from '../nexus/diagnostics-source.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const BOOK='Campaign',OTHER='GlobalBook',CHAT='chat-1';
const canon=(uid,extra={})=>({uid,comment:'Gazef Stronoff',key:['Gazef'],content:'Gazef dies at the Katze Plains.',order:100,...extra});
const importBook=(tree,book,entries)=>importLegacyLoreBookToWorldTree(tree,{book,data:{entries:Object.fromEntries(entries.map(row=>[row.uid,row]))},legacyTree:null});
const lid=(book,uid)=>`lore:${book}:${uid}`;
function sceneFact(tree,{id='1',chatId=CHAT,authority='OBSERVED',status='CURRENT',label='Gazef',narrativeTime=null}={}){
  tree.upsertNode({id:'scene-node-'+id,kind:'SCENE',scope:{type:'CHAT',chatId},provenance:{sourceType:'SCENE',sourceIds:[id]},temporal:{status},data:{label,authority,narrativeTime,text:'Gazef is standing in Nazarick.'}});
  return 'scene-node-'+id;
}
const assess=(tree,uids,{book=BOOK,canonBooks=[BOOK],intent='CURRENT',chatId=CHAT,conflictAdvice=[]}={})=>{
  const api=createCanonicalWorldTreeReadApi({chatId,worldTree:tree});
  return assessWorldTreeCandidates(uids.map(uid=>({book,uid})),{worldTree:api,intent,kind:'lore',canonBooks,chatId,conflictAdvice});
};
const rowOf=(result,uid)=>result.rows.find(row=>row.candidate.uid===uid);
const differentTime=(left,right,extra={})=>({choice:'CHANGE_OVER_TIME',left,right,...extra});
const outcomeOf=row=>[row.outcome,row.reasonCode];
const UNKNOWN=CAMPAIGN_APPLICABILITY.UNKNOWN,DIFFERENT=CAMPAIGN_APPLICABILITY.DIFFERENT_TIME;

test('without verified campaign evidence nothing is inferred: UNRESOLVED is preserved and backstory stays usable',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[
    canon(1,{comment:'Event: Death of Gazef Stronoff'}),
    canon(2,{comment:'Albedo background',key:['Albedo'],content:'Albedo was created long ago.'}),
  ]);
  sceneFact(tree,{narrativeTime:'Day 1, the morning after Nazarick arrives'});
  const result=assess(tree,[1,2]);
  for(const uid of [1,2]){
    const row=rowOf(result,uid);
    assert.equal(row.verdict.classification,'UNRESOLVED');
    assert.equal(row.authority,'CANON');
    assert.equal(row.campaignApplicability,UNKNOWN);
    assert.deepEqual(outcomeOf(row),['FULL','CANON_NO_CONFLICT'],'an "Event:" title or a canon description alone proves nothing about this campaign');
  }
  assert.equal(truthNeedsCorrection(summarizeTruthAssessment(result)),false);
});

test('declared source timing and a scene clock are not compared: that gap is reported, not guessed at',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[canon(1,{extensions:{nexusTemporal:{validFrom:'Year 2138'}}})]);
  sceneFact(tree,{narrativeTime:'Day 1 of the campaign'});
  const row=rowOf(assess(tree,[1]),1);
  assert.equal(tree.getNode('lore-fact:'+BOOK+':1').temporal.validFrom,'Year 2138','the authored timing is kept intact');
  assert.equal(row.verdict.classification,'UNRESOLVED');
  assert.equal(row.campaignApplicability,UNKNOWN,'no orderable campaign clock exists to place the source timing against');
  assert.equal(row.timingUnspecified,false,'declared timing is not "unspecified"');
});

test('verified story-scoped evidence marks canon as reference without touching its status or authority',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[canon(1)]);
  const fact=sceneFact(tree);
  const advice=[differentTime(lid(BOOK,1),fact)];
  const revision=tree.revision,before=JSON.stringify(tree.exportState());
  const row=rowOf(assess(tree,[1],{conflictAdvice:advice}),1);
  assert.equal(row.verdict.classification,'UNRESOLVED','temporal status stays separate');
  assert.equal(row.authority,'CANON','source authority stays separate');
  assert.equal(row.campaignApplicability,DIFFERENT);
  assert.deepEqual(outcomeOf(row),['SUPPORT_ONLY','CANON_REFERENCE_NOT_CURRENT']);
  assert.equal(row.presentationLabel,'[Canon reference]');
  assert.equal(row.keep,true,'reference stays available');
  assert.equal(tree.revision,revision,'nothing is written');
  assert.equal(JSON.stringify(tree.exportState()),before);
  assert.equal(tree.getNode('lore-fact:'+BOOK+':1').data.content,'Gazef dies at the Katze Plains.','the authored event is intact');
  // local to this chat
  const other=rowOf(assess(tree,[1],{chatId:'chat-2',conflictAdvice:advice}),1);
  assert.deepEqual([other.campaignApplicability,...outcomeOf(other)],[UNKNOWN,'FULL','CANON_NO_CONFLICT']);
  assert.deepEqual([rowOf(assess(tree,[1]),1).campaignApplicability,...outcomeOf(rowOf(assess(tree,[1]),1))],[UNKNOWN,'FULL','CANON_NO_CONFLICT']);
});

test('reference is context on ordinary turns and usable for time questions',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[canon(1)]);
  const advice=[differentTime(lid(BOOK,1),sceneFact(tree))];
  const by=intent=>outcomeOf(rowOf(assess(tree,[1],{intent,conflictAdvice:advice}),1));
  assert.deepEqual(by('CURRENT'),['SUPPORT_ONLY','CANON_REFERENCE_NOT_CURRENT']);
  assert.deepEqual(by('CONTRADICTION'),['SUPPORT_ONLY','CANON_REFERENCE_NOT_CURRENT']);
  assert.deepEqual(by('HISTORICAL'),['FULL','CANON_REFERENCE_MATCHES_TIME_QUESTION']);
  assert.deepEqual(by('TEMPORAL'),['FULL','CANON_REFERENCE_MATCHES_TIME_QUESTION']);
});

test('the evidence must be verified and applicable, like any chat-over-canon evidence',()=>{
  const outcome=(setup,build=(fact)=>[differentTime(lid(BOOK,1),fact)],options={})=>{
    const tree=new NexusWorldTree();
    importBook(tree,BOOK,[canon(1)]);
    const fact=setup(tree);
    const node=createCanonicalWorldTreeReadApi({chatId:CHAT,worldTree:tree}).getNode(lid(BOOK,1));
    return rowOf(assess(tree,[1],{conflictAdvice:build(fact,node),...options}),1).campaignApplicability;
  };
  assert.equal(outcome(tree=>sceneFact(tree)),DIFFERENT,'baseline');
  assert.equal(outcome(tree=>sceneFact(tree),()=>[]),UNKNOWN,'no verdict, no evidence, however recent the mention');
  assert.equal(outcome(tree=>sceneFact(tree,{authority:'REMEMBERED'})),UNKNOWN,'remembered is not established');
  assert.equal(outcome(tree=>sceneFact(tree,{authority:'INFERRED'})),UNKNOWN);
  assert.equal(outcome(tree=>sceneFact(tree,{status:'HISTORICAL'})),UNKNOWN,'a closed scene is not the campaign\'s present');
  assert.equal(outcome(tree=>sceneFact(tree,{chatId:'chat-2'})),UNKNOWN,'another chat\'s fact is invisible');
  assert.equal(outcome(tree=>sceneFact(tree,{label:'Albedo'})),UNKNOWN,'no shared subject');
  assert.equal(outcome(tree=>sceneFact(tree),(fact,node)=>[differentTime(lid(BOOK,1),fact,{leftRevision:node.revision})]),DIFFERENT);
  assert.equal(outcome(tree=>sceneFact(tree),(fact,node)=>[differentTime(lid(BOOK,1),fact,{leftRevision:node.revision+3})]),UNKNOWN,'stale revision');
  assert.equal(outcome(tree=>sceneFact(tree),fact=>[differentTime(lid(BOOK,1),fact),{choice:'COMPATIBLE',left:fact,right:lid(BOOK,1)}]),UNKNOWN,'disagreeing verdict');
  assert.equal(outcome(tree=>sceneFact(tree),fact=>[{choice:'COMPATIBLE',left:lid(BOOK,1),right:fact}]),UNKNOWN,'compatible is not different-time');
  assert.equal(outcome(tree=>sceneFact(tree),()=>[differentTime(lid(BOOK,1),'scene-node-gone')]),UNKNOWN,'unreadable partner');
  assert.equal(outcome(tree=>sceneFact(tree),undefined,{canonBooks:null}),UNKNOWN,'no bound Lorebook, no canon');
});

test('explicit states are preserved and conflicts take precedence',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[
    canon(1),
    canon(2,{extensions:{nexusTemporal:{status:'HISTORICAL'}}}),
    canon(3,{extensions:{nexusTemporal:{status:'SUPERSEDED'}}}),
    canon(4,{extensions:{nexusTemporal:{status:'UNCERTAIN'}}}),
    canon(5,{extensions:{nexusTemporal:{status:'CURRENT'}}}),
  ]);
  const fact=sceneFact(tree);
  const advice=[2,3,4,5].map(uid=>differentTime(lid(BOOK,uid),fact));
  const result=assess(tree,[2,3,4,5],{conflictAdvice:advice});
  assert.deepEqual([2,3,4,5].map(uid=>rowOf(result,uid).verdict.classification),['HISTORICAL','SUPERSEDED','UNCERTAIN','CURRENT']);
  for(const uid of [2,3,4,5])assert.equal(rowOf(result,uid).campaignApplicability,UNKNOWN,'only genuinely unresolved timing is qualified: '+uid);
  assert.equal(rowOf(result,3).keep,false);
  // a real conflict on the same node outranks a different-time verdict on another pair
  const second=sceneFact(tree,{id:'2'});
  const mixed=assess(tree,[1],{conflictAdvice:[{choice:'REAL_CONFLICT',left:lid(BOOK,1),right:fact},differentTime(lid(BOOK,1),second)]});
  assert.deepEqual([rowOf(mixed,1).reasonCode,rowOf(mixed,1).campaignApplicability],['CHAT_FACT_SUPERSEDES_CANON',UNKNOWN]);
});

test('story isolation: only the single bound Lorebook\'s canon is qualified',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[canon(1)]);
  importBook(tree,OTHER,[canon(1)]);
  const fact=sceneFact(tree);
  const advice=[differentTime(lid(BOOK,1),fact),differentTime(lid(OTHER,1),fact)];
  assert.equal(rowOf(assess(tree,[1],{conflictAdvice:advice}),1).campaignApplicability,DIFFERENT);
  for(const opts of [{book:OTHER},{book:OTHER,canonBooks:[OTHER,BOOK]},{canonBooks:[BOOK,OTHER]},{canonBooks:[]}]){
    const row=rowOf(assess(tree,[1],{...opts,conflictAdvice:advice}),1);
    assert.equal(row.campaignApplicability,UNKNOWN,JSON.stringify(opts));
    assert.equal(row.authority,null);
  }
  assert.equal(rowOf(assess(tree,[1],{book:OTHER,canonBooks:[OTHER],conflictAdvice:advice}),1).campaignApplicability,DIFFERENT,'the rule follows the bound book, not a book name');
});

// ---------------------------------------------------------------- real delivery paths

function extractFunction(source,signature){
  const start=source.indexOf(signature);
  assert.ok(start>=0,'signature changed: '+signature);
  const bodyStart=source.indexOf('{',start+signature.length-1);
  let depth=0,end=bodyStart;
  for(let i=bodyStart;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'){depth--;if(!depth){end=i+1;break;}}}
  return source.slice(start,end);
}
function loadRenderInjection(){
  const source=read('retrieval/retriever.js'),start=source.indexOf('function renderInjection(');
  const code=extractFunction(source,source.slice(start,source.indexOf('} = {}) {',start)+'} = {}) '.length));
  const stubs={candidateKey:(b,u)=>JSON.stringify([b,Number(u)]),estimateContentTokens:t=>Math.ceil(String(t).length/4),canonicalLorePresentation:r=>[...r],
    planLorePresentationCache:({currentCandidates})=>({orderedCandidates:[...currentCandidates].reverse(),strategy:'test',hasPrior:false,previousCount:0}),
    sameLorePresentationMembership:(a,b)=>a.length===b.length&&a.every(row=>b.includes(row))};
  return new Function(...Object.keys(stubs),'fullWeightFirst','truthChunkPrefix',code+'\nreturn renderInjection;')(...Object.values(stubs),fullWeightFirst,truthChunkPrefix);
}
function loadRecallRender(){
  const code=extractFunction(read('memory/recall.js'),"function render(records,budgetTokens=null,model='',characterMemories=[]){");
  const stubs={characterMemoryRenderBlocks:()=>[],estimateContentTokens:t=>Math.ceil(String(t).length/4)};
  return new Function(...Object.keys(stubs),'fullWeightFirst','truthChunkPrefix',code+'\nreturn render;')(...Object.values(stubs),fullWeightFirst,truthChunkPrefix);
}

test('Truth output flows through the real Lore and Memory delivery: reference is labelled, marked and ordered last',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[canon(1),canon(2,{comment:'Albedo',key:['Albedo'],content:'Albedo guards the Tomb.'})]);
  const advice=[differentTime(lid(BOOK,1),sceneFact(tree))];
  const result=assess(tree,[1,2],{conflictAdvice:advice});
  // the same candidate shape the retriever hands to renderInjection after Truth
  const lore=result.candidates.map(c=>({...c,title:'T'+c.uid,content:'content '+c.uid}));
  assert.deepEqual(lore.map(c=>c.a52Truth.campaignApplicability).sort(),[DIFFERENT,UNKNOWN].sort());
  const out=loadRenderInjection()(lore,0,'m');
  const at=uid=>out.text.indexOf(`UID ${uid} `);
  assert.ok(at(2)>=0&&at(1)>at(2),'full-weight canon precedes the reference entry');
  assert.ok(out.text.includes('[Canon reference] '+CONTEXT_ONLY_MARKER+' [Campaign | UID 1 '));
  assert.ok(!out.text.includes(CONTEXT_ONLY_MARKER+' [Campaign | UID 2'));
  // Memory recall renders Truth's output with the same helper
  const records=result.candidates.map((c,i)=>({id:String(c.uid),layer:1,turnRange:[i,i+1],text:'summary '+c.uid,a52Truth:c.a52Truth}));
  const recall=loadRecallRender()(records,0,'m');
  assert.ok(recall.text.indexOf('summary 2\n')<recall.text.indexOf('summary 1\n'));
  assert.ok(recall.text.includes('[Canon reference] '+CONTEXT_ONLY_MARKER+' [L1'));
  // under a tight budget the reference entry is the first to go
  const cost=c=>Math.ceil(((truthChunkPrefix(c.a52Truth)?truthChunkPrefix(c.a52Truth)+' ':'')+`[${c.book} | UID ${c.uid} | ${c.title}]\n${c.content}`).length/4);
  const ref=lore.find(c=>c.uid===1),full=lore.find(c=>c.uid===2);
  const tight=loadRenderInjection()(lore,cost(full)+1,'m');
  assert.deepEqual(tight.includedCandidates.map(c=>c.uid),[2]);
  assert.ok(cost(ref)>1);
});

test('reason codes and Diagnostics carry the new outcome without story text',()=>{
  assert.ok(isKnownTruthReasonCode('SUPPORT_ONLY','CANON_REFERENCE_NOT_CURRENT'));
  assert.ok(isKnownTruthReasonCode('FULL','CANON_REFERENCE_MATCHES_TIME_QUESTION'));
  assert.equal(isKnownTruthReasonCode('FULL','CANON_REFERENCE_NOT_CURRENT'),false);
  for(const codes of Object.values(TRUTH_REASON_CODES))for(const code of codes)assert.match(code,/^[A-Z_]+$/);
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[canon(1)]);
  const result=assess(tree,[1],{conflictAdvice:[differentTime(lid(BOOK,1),sceneFact(tree))]});
  assert.equal(summarizeTruthAssessment(result).canonReferenceCount,1);
  const event=createNexusDiagnosticEvent({channelId:NexusDiagnosticChannel.TRUTH,name:'candidate-verdict',selection:{generationId:'g1'},metrics:{
    classification:'UNRESOLVED',outcome:'SUPPORT_ONLY',reasonCode:'CANON_REFERENCE_NOT_CURRENT',authority:'CANON',campaignApplicability:'DIFFERENT_TIME',story:'Gazef dies',
  }});
  assert.equal(event.data.campaignApplicability,'DIFFERENT_TIME');
  assert.equal(event.data.reasonCode,'CANON_REFERENCE_NOT_CURRENT');
  assert.equal(event.data.story,undefined);
  assert.ok(read('retrieval/retriever.js').includes('campaignApplicability:row.campaignApplicability??null,'));
});

test('the design stays inside its boundaries: no title convention, no retagging, no campaign-start storage, no new producer',()=>{
  const resolver=read('nexus/a52/truth/status-resolver.js'),classification=read('nexus/truth-classification.js');
  for(const source of [resolver,classification]){
    assert.ok(!/Event:|startsWith\(['"]Event|campaignStart|campaign-start|campaignDate/i.test(source),'no title convention or campaign-start field');
    assert.ok(!/upsertNode|addEphemeralOverlay|chatMetadata|writeWorkingState/.test(source),'Truth classification stores nothing');
  }
  assert.ok(!fs.existsSync(path.join(root,'decision/truth-conflict-pairs.js')),'no automatic producer was added');
  assert.ok(!read('decision/task8-runtime.js').includes('CHANGE_OVER_TIME'),'no new model-backed path was added');
});
