import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetManager } from '../core/budget.js';

test('time reservations and measured cost constrain work without losing its continuation',()=>{
  const manager=createBudgetManager({now:()=>0});
  manager.observe('walker',{units:10,durationMs:20});
  const frame=manager.beginTurn({deadline:100,now:0,promptTokens:1000,worldSize:200});
  frame.reserve('other',80);
  const receipt=frame.compute('walker',{total:100,defaultUnits:96,defaultWorldSize:200,msPerUnit:1,tokensPerUnit:10});
  assert.equal(receipt.allowed,10);
  assert.equal(receipt.deferred,90);
  assert.equal(receipt.complete,false);
  assert.deepEqual(receipt.continuation,{offset:10,total:100});
});
test('world and outlet room scale defaults and measured costs adapt future turns',()=>{
  const manager=createBudgetManager({now:()=>0});
  const spec={total:2000,defaultUnits:64,defaultWorldSize:200,msPerUnit:1,tokensPerUnit:10};
  const small=manager.beginTurn({timeMs:1000,promptTokens:10000,worldSize:20}).compute('vector',spec);
  const large=manager.beginTurn({timeMs:1000,promptTokens:10000,worldSize:2000}).compute('vector',spec);
  assert.ok(large.allowed>small.allowed);
  assert.equal(manager.beginTurn({timeMs:1000,promptTokens:20,worldSize:2000}).compute('vector',spec).allowed,2);
  manager.observe('vector',{units:1,durationMs:500});
  assert.equal(manager.beginTurn({timeMs:1000,promptTokens:10000,worldSize:2000}).compute('vector',spec).allowed,2);
});
test('expired deadline allows zero and ceiling is visible as an error receipt',()=>{
  const events=[];const manager=createBudgetManager({emit:(...event)=>events.push(event)});
  const expired=manager.beginTurn({deadline:10,now:20}).compute('walker',{total:20,defaultUnits:96});
  assert.equal(expired.allowed,0);assert.equal(expired.deferred,20);
  const ceiling=manager.beginTurn({timeMs:100000,promptTokens:100000,worldSize:100000}).compute('walker',{total:100000,defaultUnits:10000,defaultWorldSize:1,sanityCeiling:100});
  assert.equal(ceiling.ceilingHit,true);assert.equal(ceiling.deferred,99900);
  assert.ok(events.some(row=>row[1]==='budget.ceiling'));
});
