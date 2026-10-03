import assert from 'node:assert/strict';

class SessionStorageMock {
    constructor(){this.map=new Map();this.writes=[];}
    get length(){return this.map.size;}
    key(index){return [...this.map.keys()][index]??null;}
    getItem(key){return this.map.has(String(key))?this.map.get(String(key)):null;}
    setItem(key,value){const k=String(key),v=String(value);this.map.set(k,v);this.writes.push({key:k,chars:v.length});}
    removeItem(key){this.map.delete(String(key));}
    clear(){this.map.clear();}
}

const storage=new SessionStorageMock();
globalThis.sessionStorage=storage;

const first=await import('../observability/telemetry.js?task205=first');
first.configureTelemetry({persistSession:true,maxEvents:128,captureChars:64,capturePayloads:false});
const useful=first.logEvent('worldtree.intake','applied',{chatId:'story-a',source:'scene',createdNodes:1,createdEdges:0,
    learnedNodes:[{id:'n1',label:'Tower',kind:'LOCATION',content:'PRIVATE-CONTENT'}],prompt:'PRIVATE-PROMPT'});
for(let i=0;i<300;i+=1){
    first.logEvent('bench','event',{i,keep:`value-${i}`,prompt:'x'.repeat(4000)});
}
await new Promise(resolve=>setTimeout(resolve,320));

const before=first.getTelemetrySnapshot();
const activity=first.getTelemetryActivitySnapshot();
assert.equal(activity.activityEvents.length,1,'useful history survives raw-event noise');
assert.equal(activity.activityEvents[0].id,useful.id);
assert.ok(!JSON.stringify(activity.activityEvents).includes('PRIVATE-'),'activity history contains only approved metadata');
assert.equal(before.events.length,128,'maxEvents ring semantics must remain unchanged');
assert.equal(before.events.at(-1)?.data?.prompt,undefined,'payload capture off must drop payload fields before persistence work');

const chunkKeys=[...storage.map.keys()].filter(key=>key.startsWith('tv2:telemetry:v2:events:'));
assert.ok(chunkKeys.length>=2,'incremental event chunks must be persisted');
for(const key of chunkKeys){
    const parsed=JSON.parse(storage.getItem(key));
    assert.ok(Array.isArray(parsed.events));
    assert.ok(parsed.events.length<=64,'hot persistence chunk must remain bounded');
}
assert.equal(storage.getItem('tv2:telemetry:v1'),null,'legacy whole-ring persistence key must not be used by the hot path');
assert.equal(storage.getItem('tv2:telemetry:v2:checkpoint'),null,'normal event bursts must not serialize a full checkpoint');

const exported=first.exportTelemetryObject();
assert.equal(exported.version,'tv2-telemetry-v1','portable diagnostic export contract must remain compatible');
assert.ok(storage.getItem('tv2:telemetry:v2:checkpoint'),'explicit export may create a full checkpoint');

const second=await import('../observability/telemetry.js?task205=second');
second.configureTelemetry({persistSession:true,maxEvents:128,captureChars:64,capturePayloads:false});
const restored=second.getTelemetrySnapshot();
assert.deepEqual(restored.events.map(row=>row.id),before.events.map(row=>row.id),'restore must reconstruct the visible bounded event ring');
assert.deepEqual(restored.metrics,before.metrics,'restore must preserve compact metrics state');
assert.deepEqual(restored.latest,before.latest,'restore must preserve latest diagnostic state');
assert.deepEqual(second.getTelemetryActivitySnapshot().activityEvents,activity.activityEvents,'useful history survives reload independently of raw retention');
for(let i=0;i<300;i++)second.logEvent('summary','created',{chatId:'story-a',memoryId:'m'+i});
assert.equal(second.getTelemetryActivitySnapshot().activityEvents.length,240,'useful history is separately bounded');
second.clearTelemetry();
assert.equal(second.getTelemetryActivitySnapshot().activityEvents.length,0,'explicit telemetry clear also clears useful history');

console.log('PASS #205 bounded incremental telemetry persistence + restore contract');
