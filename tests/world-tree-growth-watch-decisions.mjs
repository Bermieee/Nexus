import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusWorldTree } from '../world-tree/store.js';
import { recordWorldTreeDecision } from '../world-tree/decision-records.js';
import { scoreWorldTreeGrowth, decideWorldTreeGrowth } from '../world-tree/growth.js';
import { syncWorldTreeWatchList, readWorldTreeWatchList, worldTreeWatchRetrievalBoost } from '../world-tree/watch-list.js';
import { retrievalSourcePlanMultipliers } from '../retrieval/source-plan.js';
import { TASK8_POSTTURN_SITE_IDS } from '../decision/task8-postturn-sites.js';
import { getDecisionSite } from '../decision/site-registry.js';

function node(tree,id,label,kind='ENTITY'){tree.upsertNode({id,kind,scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[id]},temporal:{status:'CURRENT'},data:{label,aliases:[label]}});}

test('worldtree.growth site is registered and rule scoring preserves authority hierarchy',()=>{
  assert.ok(getDecisionSite(TASK8_POSTTURN_SITE_IDS.WORLDTREE_GROWTH));
  assert.ok(scoreWorldTreeGrowth({authority:'CARD'})>scoreWorldTreeGrowth({authority:'REMEMBERED'}));
  assert.ok(scoreWorldTreeGrowth({authority:'OBSERVED',scenePresence:true})>=.75);
  assert.ok(scoreWorldTreeGrowth({authority:'REMEMBERED',independentSources:3,repetition:3})>=.75);
});

test('DecisionRecords are durable metadata-only records and can be referenced by World Tree rows',async()=>{
  const tree=new NexusWorldTree(),record=recordWorldTreeDecision(tree,{chatId:'chat-a',site:'worldtree.growth',subject:{type:'candidate',id:'candidate:x'},options:['GROW','WAIT','REVIEW'],chosen:'WAIT',decidedBy:'RULE',reasonCodes:['GROWTH_BELOW_THRESHOLD'],evidence:[{type:'turn',ref:'message:1',weight:1}],score:.3,threshold:.75});
  assert.equal(tree.getDecisionRecord(record.id).chosen,'WAIT');assert.equal(JSON.stringify(tree.exportState()).includes('candidate:x'),true);
  node(tree,'a','A');node(tree,'b','B');
  tree.applyContributionRevision({ledgerKey:'k',lineageKey:'l',fingerprint:'f',source:'owner',scope:{type:'GLOBAL'},decisionRecordIds:[record.id],nodes:[],edges:[{id:'e',from:'a',to:'b',relation:'relationship',scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:['e']},temporal:{status:'CURRENT'},data:{subtype:'test'}}]});
  const edge=tree.getEdge('e');assert.deepEqual(edge.data.decisionRecordIds,[record.id]);assert.equal(tree.readUiModel().edges.find(row=>row.id==='e').why[0].chosen,'WAIT');
});

test('high-confidence growth decisions are rule-owned and produce DecisionRecords',async()=>{
  const tree=new NexusWorldTree(),result=await decideWorldTreeGrowth({tree,context:{chatId:'chat-a'},subject:{type:'candidate',id:'c1'},authority:'OBSERVED',sourceRefs:[{sceneId:'s1'}],scenePresence:true,independentSources:1,repetition:1});
  assert.equal(result.chosen,'GROW');assert.equal(result.decidedBy,'RULE');assert.equal(tree.getDecisionRecord(result.record.id).site,'worldtree.growth');
});

test('watch list is an ephemeral overlay, expires by turns, and boosts retrieval planning',()=>{
  const tree=new NexusWorldTree();node(tree,'location:ember','Ember Tavern','LOCATION');
  syncWorldTreeWatchList({tree,chatId:'chat-a',sceneScan:{references:{characters:[],locations:[{name:'Ember Tavern',relation:'planned-destination'}],organizations:[],concepts:[],items:[]}},currentTurn:2,ttlTurns:3});
  let rows=readWorldTreeWatchList({tree,chatId:'chat-a'});assert.equal(rows.length,1);assert.equal(rows[0].reasonCode,'MENTIONED_AS_DESTINATION');
  const boost=worldTreeWatchRetrievalBoost({tree,chatId:'chat-a'});assert.equal(boost.highLikelihoodCount,1);assert.ok(retrievalSourcePlanMultipliers({hot:'normal',walker:'normal',vector:'normal',watchBoost:boost.multiplier}).walker>1);
  assert.equal('overlays' in tree.exportState(),false);
  syncWorldTreeWatchList({tree,chatId:'chat-a',sceneScan:{references:{characters:[],locations:[],organizations:[],concepts:[],items:[]}},currentTurn:6,ttlTurns:3});
  rows=readWorldTreeWatchList({tree,chatId:'chat-a'});assert.equal(rows.length,0);assert.ok(tree.listDecisionRecords({chatId:'chat-a'}).some(row=>row.reasonCodes.includes('WATCH_EXPIRED')));
});
