import test from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import fs from 'node:fs';import vm from 'node:vm';import path from 'node:path';
import {sceneObservationsConflict} from '../nexus/a52/scene/observation-comparison.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');let context={chatId:'review',chat:[],chatMetadata:{}};let hint=null;
const stubs={
 '../../../st-context.js':{getContext:()=>context},
 'core/settings.js':{getSettings:()=>({decisionCore:{enabled:true},retrieval:{changeGateEnabled:true}})},
 'sidecar/bus.js':{BUS_STAGE:{SCENE_SCAN:'scene-scan'},BUS_PRIORITY:{SCENE_SCAN:1}},
 'nexus/model-worker-bus.js':{enqueueNexusModelWorkerJob:()=>{throw Error('No provider calls allowed')}},
 'sidecar/normalize-response.js':{parseStructuredJsonCandidate:()=>{throw Error('Unexpected text parser')}},
 'observability/telemetry.js':{logEvent:()=>{}},
 'retrieval/handoff-policy.js':{isNarrativeSceneMessage:()=>true},
 'nexus/work-scope.js':{captureNexusWorkScope:()=>({}),isNexusWorkScopeFresh:()=>true},
 'core/cancellation.js':{isIntentionalCancellation:()=>false},
 'scene/decision-site.js':{evaluateSceneScanPreflightAssist:async()=>hint,currentScenePreflightEvidence:()=>({}),scenePreflightFingerprint:()=>''},
 'nexus/scene-intelligence.js':{observeNexusSceneAuthority:()=>null}
};
const cache=new Map();function load(name){if(cache.has(name))return cache.get(name);const stub=stubs[name];const mod=stub?new vm.SyntheticModule(Object.keys(stub),function(){for(const[k,v]of Object.entries(stub))this.setExport(k,v)},{identifier:name}):new vm.SourceTextModule(fs.readFileSync(path.join(root,name),'utf8'),{identifier:name});cache.set(name,mod);return mod;}
const entry=new vm.SourceTextModule("export * as scanner from '../scene/scanner.js';export * as gate from '../retrieval/change-gate.js';export * as runtime from '../scene/runtime.js';",{identifier:'tests/entry.js'});await entry.link((spec,parent)=>load(path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier),spec))));await entry.evaluate();const{scanner,gate,runtime}=entry.namespace;
const base={participants:['Mara','Eris'],location:'Nazarick 9th floor corridor',activity:'talking',objective:'deliver message',focus:'message',timeContext:'morning',relationshipFocus:false};
function payload(scene,extra={}){return {scene,references:{characters:[],locations:[],organizations:[],concepts:[],items:[],...extra},reasoning:'Observed from narrative'}};
function dispatch(value){return (_stage,opts)=>{const validation=opts.structuredValidator(value);return{promise:validation.valid?Promise.resolve({structuredPayload:validation.value}):Promise.reject(Error(validation.reason))}};}
async function seed(){hint=null;scanner.clearSceneScannerState();gate.clearSceneChangeGate();context.chat=[{mes:'Opening',is_user:false}];await scanner.scanScene({context,enqueueSidecar:dispatch(payload(base))});context.chat.push({mes:'Mara continues the discussion.',is_user:true});}
test('distinct numbered floors cannot be stabilized into the same location',async()=>{
 await seed();const result=await scanner.scanScene({context,enqueueSidecar:dispatch(payload({...base,location:'Nazarick 10th floor corridor'}))});assert.equal(result.acceptedScene.location,'Nazarick 10th floor corridor');assert.equal(result.delta.location.changed,true);
});
test('a stale preflight hint cannot override a fresh measured major change',async()=>{
 await seed();hint={ok:true,stale:false,answers:{scan_required:{value:1},change_hint:{value:'NO_CHANGE'}}};const result=await runtime.ensureSceneAuthority({context,enqueueSidecar:dispatch(payload({...base,location:'Mountain shrine'}))});assert.equal(result.sceneScan.delta.location.changed,true);assert.equal(result.gate.mode,'MAJOR_CHANGE');
});
test('an omitted participant remains present without departure evidence',async()=>{
 await seed();const result=await scanner.scanScene({context,enqueueSidecar:dispatch(payload({...base,participants:['Mara']}))});assert.deepEqual([...result.acceptedScene.participants],['Mara','Eris']);assert.equal(result.delta.participants.changed,false);assert.equal(gate.evaluateSceneChange({sceneScan:result}).mode,'NO_CHANGE');
});
test('explicit grounded departure can remove a participant',async()=>{
 await seed();context.chat.at(-1).mes='Eris leaves the corridor.';const result=await scanner.scanScene({context,enqueueSidecar:dispatch(payload({...base,participants:['Mara'],departedParticipants:[{name:'Eris',evidence:'Eris leaves the corridor.'}]}))});assert.deepEqual([...result.delta.participants.removed],['Eris']);
});
test('an invented departure quote cannot remove a participant',async()=>{
 await seed();const result=await scanner.scanScene({context,enqueueSidecar:dispatch(payload({...base,participants:['Mara'],departedParticipants:[{name:'Eris',evidence:'Eris leaves the corridor.'}]}))});assert.deepEqual([...result.acceptedScene.participants],['Mara','Eris']);
});
test('a grounded explicit completion clears the old objective',async()=>{
 await seed();context.chat.at(-1).mes='Mara delivers the message.';const result=await scanner.scanScene({context,enqueueSidecar:dispatch(payload({...base,objective:'',clearedFields:{objective:'Mara delivers the message.'}}))});assert.equal(result.acceptedScene.objective,'');assert.equal(result.delta.objective.changed,true);
});
test('blank or ungrounded clearing cannot erase an established objective',async()=>{
 await seed();const result=await scanner.scanScene({context,enqueueSidecar:dispatch(payload({...base,objective:'',clearedFields:{objective:'Mara delivers the message.'}}))});assert.equal(result.acceptedScene.objective,'deliver message');
});
test('a duplicate discussed reference cannot discard an otherwise valid physical scene',async()=>{
 await seed();const result=await scanner.scanScene({context,enqueueSidecar:dispatch(payload(base,{characters:[{name:'Mara',relation:'discussed'}]}))});assert.equal(result.degraded,false);assert.deepEqual([...result.references.characters],[]);assert.deepEqual([...result.acceptedScene.participants],['Mara','Eris']);
});
const observed=value=>({observationClass:'OBSERVED',value});
test('different supported locations still require arbitration',()=>{
 assert.equal(sceneObservationsConflict({fields:{location:observed('Nazarick 9th floor')}},{fields:{location:observed('Nazarick 10th floor')}}),true);
});
test('conflicting supported presence still requires arbitration',()=>{
 assert.equal(sceneObservationsConflict({fields:{activeCast:observed([{characterId:'Eris',state:'PRESENT'}])}},{fields:{activeCast:observed([{characterId:'Eris',state:'ABSENT'}])}}),true);
});
test('unknown values and extra containment evidence do not manufacture conflict',()=>{
 assert.equal(sceneObservationsConflict({fields:{location:observed('Throne room'),immediateObjects:{observationClass:'UNKNOWN',value:[]}}},{fields:{location:observed({location:'Throne room',parentLocation:'Nazarick'}),immediateObjects:observed(['Staff'])}}),false);
});
test('cast ordering and confidence do not manufacture conflict',()=>{
 assert.equal(sceneObservationsConflict({fields:{activeCast:observed([{characterId:'Mara',confidence:.7},{characterId:'Eris',confidence:.8}])}},{fields:{activeCast:observed([{characterId:'Eris',confidence:1},{characterId:'Mara',confidence:1}])}}),false);
});
