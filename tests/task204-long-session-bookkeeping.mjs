import fs from 'node:fs';
import assert from 'node:assert/strict';
import { countAssistantTurnsForCadence, updateAssistantTurnCounter } from '../lifecycle/cadence-counter.js';

const chat=[];
for(let turn=0;turn<5000;turn+=1){
    chat.push({is_user:true,is_system:false,mes:`user ${turn}`});
    chat.push({is_user:false,is_system:false,mes:`assistant ${turn}`});
}
const full=countAssistantTurnsForCadence(chat);
assert.equal(full,5000);

const initial=updateAssistantTurnCounter(null,chat,{epoch:10});
assert.equal(initial.counter.assistantTurns,5000);
assert.equal(initial.inspectedMessages,10000);
assert.equal(initial.rebased,true);

chat.push({is_user:false,is_system:false,mes:'assistant append'});
const appended=updateAssistantTurnCounter(initial.counter,chat,{epoch:10});
assert.equal(appended.counter.assistantTurns,5001);
assert.equal(appended.inspectedMessages,1,'normal append must inspect only the delta');
assert.equal(appended.rebased,false);

const hit=updateAssistantTurnCounter(appended.counter,chat,{epoch:10});
assert.equal(hit.counter.assistantTurns,5001);
assert.equal(hit.inspectedMessages,0,'unchanged cadence check must be O(1) with respect to history');

const structural=updateAssistantTurnCounter(hit.counter,chat,{epoch:11});
assert.equal(structural.counter.assistantTurns,countAssistantTurnsForCadence(chat));
assert.equal(structural.rebased,true);
assert.equal(structural.inspectedMessages,chat.length,'structural epoch changes must rebase truthfully');

const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
const scheduler=read('lifecycle/scheduler.js');
const index=read('index.js');
const memory=read('memory/store.js');

assert.match(scheduler,/updateAssistantTurnCounter/);
assert.match(scheduler,/cadence-counter-advanced/);
assert.match(scheduler,/cadence-counter-rebased/);
assert.match(scheduler,/export function noteLifecycleCadenceAppend/);
assert.match(scheduler,/export function markLifecycleCadenceStructureDirty/);
assert.doesNotMatch(scheduler,/function currentAssistantTurns\(ctx=getContext\(\)\)\{return \(ctx\?\.chat\|\|\[\]\)\.filter/);

assert.match(index,/noteLifecycleCadenceAppend\(\)/);
assert.match(index,/markLifecycleCadenceStructureDirty\(reason\)/);

assert.match(memory,/let memoryInspectionCache = null/);
assert.match(memory,/function memoryInspectionCanReuse/);
assert.match(memory,/function getMemoryInspectionIndex/);
assert.match(memory,/indexReused:reused/);
assert.match(memory,/evidenceRevision/);
assert.match(memory,/saveMemoryStore\(\{affectsInspection:false\}\)/);
assert.match(memory,/saveMemoryStore\(\{notify:false,affectsInspection:false\}\)/);

console.log('PASS #204 5,000-turn incremental cadence + Memory inspection contract');
