import test from 'node:test';
import assert from 'node:assert/strict';
import { recordDecisionRecord, readDecisionRecords, resetDecisionRecordsForTests, DECISION_RECORD_REASON_TEXT } from '../decision/records.js';
import { runTask8ChoiceDecision, TASK8_POSTTURN_SITE_IDS } from '../decision/task8-postturn-sites.js';
import { runTruthForegroundChoice, TRUTH_FOREGROUND_SITE_IDS } from '../decision/truth-foreground-sites.js';

test('DecisionRecord trace is metadata-only, bounded, and readable',()=>{
  resetDecisionRecordsForTests();
  const row=recordDecisionRecord({site:'scheduler.test',subsystem:'scheduler',selection:{chatId:'chat-a',generationId:'g1',turnId:'7'},subject:{type:'job',id:'job-1'},options:['RUN','SKIP'],chosen:'RUN',source:'fallback',reasonCode:'RULE_FALLBACK',latencyMs:4});
  assert.equal(row.kind,'DecisionRecord');assert.equal(row.decidedBy,'RULE');assert.equal(row.why[0],DECISION_RECORD_REASON_TEXT.RULE_FALLBACK);
  assert.equal(JSON.stringify(row).includes('story text'),false);assert.equal(readDecisionRecords({chatId:'chat-a',generationId:'g1'}).length,1);
});

test('Task8 final choice emits exactly one DecisionRecord when Decision Core is off',async()=>{
  resetDecisionRecordsForTests();
  const out=await runTask8ChoiceDecision(TASK8_POSTTURN_SITE_IDS.RUN_GREEN_ROOM,{chatId:'chat-a',generationId:'g1'},'SKIP',{telemetrySelection:{chatId:'chat-a',generationId:'g1'}});
  assert.equal(out.choice,'SKIP');
  const rows=readDecisionRecords({chatId:'chat-a',generationId:'g1',site:TASK8_POSTTURN_SITE_IDS.RUN_GREEN_ROOM});
  assert.equal(rows.length,1);assert.equal(rows[0].chosen,'SKIP');assert.ok(rows[0].reasonCodes.every(code=>DECISION_RECORD_REASON_TEXT[code]));
});

test('Truth foreground final fallback emits exactly one DecisionRecord',async()=>{
  resetDecisionRecordsForTests();
  const out=await runTruthForegroundChoice(TRUTH_FOREGROUND_SITE_IDS.INTENT,{chatId:'chat-a',generationId:'g2'},'CURRENT',{allowedChoices:['CURRENT','HISTORICAL'],foregroundDeadlineMs:null,telemetrySelection:{chatId:'chat-a',generationId:'g2'}});
  assert.equal(out.choice,'CURRENT');
  const rows=readDecisionRecords({chatId:'chat-a',generationId:'g2',site:TRUTH_FOREGROUND_SITE_IDS.INTENT});
  assert.equal(rows.length,1);assert.deepEqual(rows[0].options,['CURRENT','HISTORICAL']);assert.ok(DECISION_RECORD_REASON_TEXT[rows[0].reasonCodes[0]]);
});
