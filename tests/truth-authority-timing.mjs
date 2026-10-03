import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NexusWorldTree } from '../world-tree/store.js';
import { importLegacyLoreBookToWorldTree, legacyLoreTemporal } from '../world-tree/import-lore.js';
import { loreEntryDeclaresTemporalState } from '../world-tree/lore-temporal-declaration.js';
import { createCanonicalWorldTreeReadApi } from '../core/world-tree-api.js';
import {
  assessWorldTreeCandidates,
  resolveNodeAuthority,
  summarizeTruthAssessment,
  truthNeedsCorrection,
} from '../nexus/a52/truth/status-resolver.js';

const BOOK='Campaign';
const entry=(uid,extra={})=>({uid,comment:'Entry '+uid,key:['k'+uid],content:'Authored text '+uid,order:100,...extra});
function importBook(tree,book,entries){
  importLegacyLoreBookToWorldTree(tree,{book,data:{entries:Object.fromEntries(entries.map(row=>[row.uid,row]))},legacyTree:null});
}
const assess=(tree,uids,{book=BOOK,canonBooks=[BOOK],intent='CURRENT',chatId='chat-1',conflictAdvice=[]}={})=>{
  const api=createCanonicalWorldTreeReadApi({chatId,worldTree:tree});
  return assessWorldTreeCandidates(uids.map(uid=>({book,uid})),{worldTree:api,intent,kind:'lore',canonBooks,conflictAdvice});
};
const rowOf=(result,uid)=>result.rows.find(row=>row.candidate.uid===uid);

test('authored canon with no declared timing: canon authority, timing stays UNRESOLVED and unspecified',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1)]);
  const row=rowOf(assess(tree,[1]),1);
  assert.equal(row.verdict.classification,'UNRESOLVED','temporal status is not converted to CURRENT');
  assert.equal(row.authority,'CANON');
  assert.equal(row.authoritySource,'IMPORT_PROVENANCE');
  assert.equal(row.timingUnspecified,true);
  assert.equal(row.unresolved,true);
  assert.equal(row.keep,true);
  assert.equal(row.supportOnly,false);
});

test('explicit historical, superseded, contradicted, uncertain and unresolved states are preserved',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[
    entry(1,{extensions:{nexusTemporal:{status:'HISTORICAL'}}}),
    entry(2,{extensions:{nexusTemporal:{status:'SUPERSEDED',supersededBy:'lore:Campaign:9'}}}),
    entry(3,{extensions:{nexusTemporal:{status:'CONTRADICTED'}}}),
    entry(4,{extensions:{nexusTemporal:{status:'UNCERTAIN'}}}),
    entry(5,{extensions:{nexusTemporal:{status:'UNRESOLVED'}}}),
    entry(6,{historical:true}),
    entry(7,{extensions:{nexusTemporal:{reason:'owner flagged'}}}),
  ]);
  const result=assess(tree,[1,2,3,4,5,6,7]);
  const klass=uid=>rowOf(result,uid).verdict.classification;
  assert.deepEqual([1,2,3,4,5,6,7].map(klass),['HISTORICAL','SUPERSEDED','CONTRADICTED','UNCERTAIN','UNRESOLVED','HISTORICAL','UNRESOLVED']);
  for(const uid of [1,2,3,4,5,6,7]){
    assert.equal(rowOf(result,uid).authority,'CANON','source authority is independent of timing');
    assert.equal(rowOf(result,uid).timingUnspecified,false,'declared timing is never "unspecified": '+uid);
  }
  assert.equal(rowOf(result,2).keep,false,'superseded stays dropped for CURRENT');
});

test('empty reason/supersededBy/contradictedBy is not evidence: no source entry means no unspecified-timing claim',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1)]);
  const node=tree.getNode('lore-fact:'+BOOK+':1');
  tree.upsertNode({...node,data:{...node.data,sourceEntry:undefined}});
  const row=rowOf(assess(tree,[1]),1);
  assert.equal(row.verdict.classification,'UNRESOLVED');
  assert.equal(row.authority,'CANON');
  assert.equal(row.timingUnspecified,false);
});

test('a reason recorded on the node after import keeps timing an open question',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1)]);
  const node=tree.getNode('lore-fact:'+BOOK+':1');
  tree.upsertNode({...node,temporal:{...node.temporal,reason:'owner-review'}});
  assert.equal(rowOf(assess(tree,[1]),1).timingUnspecified,false);
});

test('authority derivation needs the exact bound book and verified import provenance',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1)]);
  importBook(tree,'OtherBook',[entry(1)]);
  assert.equal(rowOf(assess(tree,[1],{canonBooks:null}),1).authority,null,'no binding, no derivation');
  assert.equal(rowOf(assess(tree,[1],{canonBooks:['OtherBook']}),1).authority,null,'different bound book');
  assert.equal(rowOf(assess(tree,[1],{book:'OtherBook',canonBooks:[BOOK]}),1).authority,null,'candidate book is not the bound book');
  const unbound=rowOf(assess(tree,[1],{canonBooks:null}),1);
  assert.equal(unbound.verdict.classification,'UNRESOLVED');
  assert.equal(unbound.timingUnspecified,false);
  assert.equal(rowOf(assess(tree,[1],{book:'OtherBook',canonBooks:['OtherBook']}),1).authority,'CANON');
});

test('unverified provenance, chat scope and non-lore nodes never derive canon',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1),entry(2),entry(3)]);
  const forged=tree.getNode('lore-fact:'+BOOK+':2');
  tree.upsertNode({...forged,provenance:{...forged.provenance,sourceType:'MESSAGE'}});
  const foreign=tree.getNode('lore-fact:'+BOOK+':3');
  tree.upsertNode({...foreign,provenance:{...foreign.provenance,importedFrom:'chat'}});
  tree.upsertNode({
    id:'lore-fact:ChatBook:1',kind:'LORE_FACT',scope:{type:'CHAT',chatId:'chat-1'},
    provenance:{sourceType:'SILLYTAVERN_WORLD_INFO',sourceIds:['ChatBook','1'],importedFrom:'legacy-lorebook'},
    temporal:{status:'UNRESOLVED'},data:{book:'ChatBook',uid:1,label:'chat',content:'x',sourceEntry:{uid:1}},
  });
  const result=assess(tree,[1,2,3]);
  assert.equal(rowOf(result,1).authority,'CANON');
  assert.equal(rowOf(result,2).authority,null);
  assert.equal(rowOf(result,3).authority,null);
  assert.equal(rowOf(assess(tree,[1],{canonBooks:[BOOK,'OtherBook']}),1).authority,null,'a multi-book list is not an active-story binding');
  const chatRow=rowOf(assess(tree,[1],{book:'ChatBook',canonBooks:['ChatBook']}),1);
  assert.equal(chatRow.authority,null,'chat-scoped node is not global canon');
  assert.equal(chatRow.timingUnspecified,false);
});

test('stored authority is honored as written, including card-derived nodes',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1)]);
  const node=tree.getNode('lore-fact:'+BOOK+':1');
  tree.upsertNode({...node,data:{...node.data,authority:'INFERRED'}});
  const inferred=rowOf(assess(tree,[1]),1);
  assert.equal(inferred.authority,'INFERRED');
  assert.equal(inferred.authoritySource,'STORED');
  assert.equal(inferred.timingUnspecified,false,'only canon authority can have unspecified timing');
  tree.upsertNode({id:'character:card:mara',kind:'CHARACTER',scope:{type:'GLOBAL'},provenance:{sourceType:'CARD',sourceIds:['mara']},temporal:{status:'CURRENT'},data:{label:'Mara',authority:'CARD'}});
  const api=createCanonicalWorldTreeReadApi({chatId:'chat-1',worldTree:tree});
  assert.deepEqual({...resolveNodeAuthority(api.getNode('character:card:mara'),{canonBooks:[BOOK]})},{authority:'CARD',authoritySource:'STORED'});
});

test('assessment never changes stored World Tree data',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,[entry(1),entry(2,{extensions:{nexusTemporal:{status:'HISTORICAL'}}})]);
  const before=JSON.stringify(tree.exportState?.()??[...tree.iterateNodes({chatId:null})]);
  const revision=tree.revision;
  assess(tree,[1,2]);
  assert.equal(tree.revision,revision);
  assert.equal(JSON.stringify(tree.exportState?.()??[...tree.iterateNodes({chatId:null})]),before);
  assert.equal(tree.getNode('lore-fact:'+BOOK+':1').data.authority,undefined,'authority is derived at read time, not stored');
  assert.equal(tree.getNode('lore-fact:'+BOOK+':1').temporal.status,'UNRESOLVED');
});

test('ordinary canon with unspecified timing does not by itself call for corrective retrieval',()=>{
  const tree=new NexusWorldTree();
  importBook(tree,BOOK,Array.from({length:82},(_,i)=>entry(i+1)));
  const uids=Array.from({length:82},(_,i)=>i+1);
  const stats=summarizeTruthAssessment(assess(tree,uids));
  assert.equal(stats.candidateCount,82);
  assert.equal(stats.keptCount,82);
  assert.equal(stats.unspecifiedTimingCount,82);
  assert.equal(stats.unresolvedCount,0);
  assert.equal(truthNeedsCorrection(stats),false);
  const unbound=summarizeTruthAssessment(assess(tree,uids,{canonBooks:null}));
  assert.equal(unbound.unresolvedCount,82,'without a verified binding the old behavior is unchanged');
  assert.equal(truthNeedsCorrection(unbound),true);
});

test('genuine open questions still call for corrective retrieval',()=>{
  const needs=(extra,opts)=>{
    const tree=new NexusWorldTree();
    importBook(tree,BOOK,[entry(1),extra]);
    return truthNeedsCorrection(summarizeTruthAssessment(assess(tree,[1,extra.uid],opts)));
  };
  assert.equal(needs(entry(2,{extensions:{nexusTemporal:{status:'UNCERTAIN'}}})),true,'declared uncertain');
  assert.equal(needs(entry(2,{extensions:{nexusTemporal:{status:'UNRESOLVED'}}})),true,'declared unresolved');
  assert.equal(needs(entry(2,{extensions:{nexusTemporal:{status:'CONTRADICTED'}}})),true,'disputed');
  assert.equal(needs(entry(2,{extensions:{nexusTemporal:{status:'SUPERSEDED'}}})),true,'dropped as superseded');
  assert.equal(needs(entry(2),{intent:'HISTORICAL'}),true,'unspecified canon is not usable for a historical question');
  assert.equal(needs(entry(2),{conflictAdvice:[{choice:'REAL_CONFLICT',left:'lore:Campaign:2',right:'lore:Campaign:1'}]}),true,'reported conflict');
  assert.equal(needs(entry(2)),false);
});

test('the importer default and the declaration helper agree',()=>{
  const battery=[
    entry(1),
    entry(2,{extensions:{nexusTemporal:{status:'CURRENT'}}}),
    entry(3,{extensions:{nexusTemporal:{status:'bogus'}}}),
    entry(4,{status:'historical'}),
    entry(5,{metadata:{temporalStatus:'superseded'}}),
    entry(6,{supersededBy:['x']}),
    entry(7,{contradictedBy:'y'}),
    entry(8,{historical:true}),
    entry(9,{validFrom:'Y1'}),
    entry(10,{extensions:{nexusTemporal:{validUntil:'Y9'}}}),
    entry(11,{temporalReason:'because'}),
    entry(12,{metadata:{}}),
  ];
  for(const row of battery){
    const t=legacyLoreTemporal(row);
    const defaulted=t.status==='UNRESOLVED'&&!t.validFrom&&!t.validUntil&&!t.reason&&!t.supersedes.length&&!t.supersededBy.length&&!t.contradictedBy.length;
    const declares=loreEntryDeclaresTemporalState(row);
    if(!declares)assert.ok(defaulted,'undeclared entry must be the importer default: uid '+row.uid);
    if(t.status!=='UNRESOLVED'||t.supersedes.length||t.supersededBy.length||t.contradictedBy.length||t.validFrom||t.validUntil||t.reason)assert.ok(declares,'importer-recorded timing must count as declared: uid '+row.uid);
  }
  assert.equal(loreEntryDeclaresTemporalState(entry(3,{extensions:{nexusTemporal:{status:'bogus'}}})),true,'an unrecognized declaration is conservatively treated as declared');
});

test('retriever applies the bound-book rule and the open-question condition',()=>{
  const retriever=fs.readFileSync(new URL('../retrieval/retriever.js',import.meta.url),'utf8');
  assert.equal(retriever.match(/canonBooks:books,/g)?.length,2,'both assessment calls pass the exact bound books');
  assert.ok(retriever.includes('const correctiveNeeded=truthNeedsCorrection(initialTruthStats);'));
  assert.ok(retriever.includes('unspecifiedTimingCount'));
});
