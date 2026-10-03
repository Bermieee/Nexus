import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusWorldTree } from '../world-tree/store.js';
import { recordWorldTreeDecision } from '../world-tree/decision-records.js';
import * as worldDecisions from '../world-tree/decision-records.js';
import { getTelemetrySnapshot } from '../observability/telemetry.js';
import { recordDecisionRecord, readDecisionRecords, resetDecisionRecordsForTests } from '../decision/records.js';
import { runJobTable } from '../scheduler/runtime.js';

test('World Tree telemetry retains selected-generation decision evidence and budget', () => {
    const tree=new NexusWorldTree();
    const row=recordWorldTreeDecision(tree,{chatId:'story-a',generationId:'g-old',site:'worldtree.growth',subject:{type:'node',id:'room'},chosen:'GROW',decidedBy:'RULE',options:['GROW','WAIT'],reasonCodes:['SCENE_PRESENCE'],evidence:[{type:'scene',ref:'scene:7',weight:1}],budget:{granted:2,used:1,deferred:1}});
    const event=getTelemetrySnapshot().events.find(event=>event.data?.id===row.id);
    assert.equal(event.data.chatId,'story-a');
    assert.equal(event.data.generationId,'g-old');
    assert.deepEqual(event.data.evidence,[{type:'scene',ref:'scene:7',weight:1}]);
    assert.deepEqual(event.data.budget,{granted:2,used:1,deferred:1});
});
test('Decision Core records retain source references and actual budget rather than a blank placeholder', () => {
    resetDecisionRecordsForTests();
    recordDecisionRecord({site:'scheduler.plan',selection:{chatId:'story-a',generationId:'g7'},chosen:'RUN',reasonCode:'RULE_FALLBACK',evidence:[{type:'scene',ref:'scene:7',weight:1}],budget:{granted:2,used:1,deferred:1}});
    const record=readDecisionRecords({chatId:'story-a',generationId:'g7'})[0];
    assert.deepEqual(record.evidence,[{type:'scene',ref:'scene:7',weight:1}]);
    assert.deepEqual(record.budget,{granted:2,used:1,deferred:1});
});
test('historical World Tree selection reads that generation instead of the latest frame', () => {
    resetDecisionRecordsForTests();
    const tree=new NexusWorldTree();
    for(const generationId of ['g-old','g-current'])recordWorldTreeDecision(tree,{chatId:'story-a',generationId,site:'worldtree.growth',subject:{type:'node',id:'room'},chosen:'GROW',decidedBy:'RULE',reasonCodes:['SCENE_PRESENCE']});
    const timeline=worldDecisions.readWorldTreeDecisionTimeline(tree,{chatId:'story-a',selection:{chatId:'story-a',generationId:'g-old'},frame:{generationId:'g-current'}});
    assert.equal(timeline.generationId,'g-old');
    assert.equal(timeline.records.length,1);
    assert.equal(timeline.records[0].generationId,'g-old');
    assert.equal(worldDecisions.readWorldTreeDecisionTimeline(tree,{chatId:'story-a',selection:{chatId:'story-b',generationId:'g-old'}}).records.length,0);
});
test('scheduler planning records the selected generation and due job choices',async()=>{
    resetDecisionRecordsForTests();
    const row={id:'worldtree.intake',lane:'postTurn',priority:1,inputs:()=>({}),async *steps(){return{applied:true};},accept:()=>true,onResult:()=>{}};
    await runJobTable([row],{scope:{chatId:'story-a'},generationId:'g7',yieldHost:async()=>{}});
    const records=readDecisionRecords({chatId:'story-a',generationId:'g7',site:'scheduler.plan'});
    assert.equal(records.length,1);
    assert.ok(records[0].chosen.includes('worldtree.intake'));
});
