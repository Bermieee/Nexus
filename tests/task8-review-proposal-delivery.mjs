import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibleReflectionReadings, stageTask8Review } from '../decision/task8-review-proposals.js';

test('independent but contradictory Green Room readings cannot form a reflection',()=>{
  const history=[1,0,1].map((warmth,index)=>({characterRef:'mara',supportIdentity:'support-'+index,directEvidenceRefs:['scene:'+index],dimensions:{warmth}}));
  assert.deepEqual(compatibleReflectionReadings(history,'mara'),[]);
  for(const row of history)row.dimensions.warmth=.8;
  assert.equal(compatibleReflectionReadings(history,'mara').length,3);
});
test('reflection and identity/supersession advice enters existing proposal admission without canon mutation',async()=>{
  const staged=[];
  for(const [site,subjects] of [['greenroom.reflect',['mara']],['worldtree.identity',['a','b']],['worldtree.supersede',['old','new']]]){
    const result=await stageTask8Review({chatId:'story-a',generationId:'g7',site,subjects,choice:'REVIEW',evidenceRefs:['scene:7']},{enqueue:async(op,meta)=>{staged.push({op,meta});return{id:'proposal-'+staged.length};}});
    assert.equal(result.staged,true);
  }
  assert.equal(staged.length,3);
  assert.ok(staged.every(({op,meta})=>op.type==='metadata.set'&&op.value.canonicalMutation===false&&meta.origin.chatId==='story-a'));
  let calls=0;
  const stale=await stageTask8Review({chatId:'story-a',site:'worldtree.identity',subjects:['a','b'],choice:'REVIEW'},{isFresh:()=>false,enqueue:async()=>{calls++;}});
  assert.equal(stale.staged,false);assert.equal(calls,0);
});
