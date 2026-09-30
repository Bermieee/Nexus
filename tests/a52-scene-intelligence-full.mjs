import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ActiveCastResolver } from '../nexus/a52/scene/active-cast.js';
import { SpatialStateTracker } from '../nexus/a52/scene/spatial-state.js';
import { SemanticBoundaryDetector } from '../nexus/a52/scene/boundary-detector.js';
import { BoundaryVerifier } from '../nexus/a52/scene/boundary-verifier.js';
import { CastPresence, ObservationClass } from '../nexus/a52/scene/contracts.js';
import {
  boundSceneNarrative,
  buildSceneObservationPrompt,
  normalizeSceneObservationOutput,
  sceneObservationValidator,
} from '../nexus/a52/scene/observation-specialist.js';

{
  const long='A'.repeat(2000)+' middle '+'Z'.repeat(5000);
  const bounded=boundSceneNarrative(long);
  assert.equal(bounded.coverage.complete,false);
  assert.equal(bounded.coverage.window,'HEAD_TAIL');
  assert.ok(bounded.text.startsWith('A'.repeat(100)));
  assert.ok(bounded.text.endsWith('Z'.repeat(100)));
  assert.ok(bounded.text.length<=6000);
}

{
  const built=buildSceneObservationPrompt({
    narrative:'Mara enters the Ember Tavern carrying the silver key.',
    sceneId:'scene-1',baseRevision:3,evidenceRef:'e1',sourceRevisionId:'r1',
  });
  assert.match(built.systemPrompt,/Nexus Scene Intelligence/);
  assert.match(built.prompt,/UNTRUSTED_SCENE_EVIDENCE_JSON/);
  const payload=normalizeSceneObservationOutput({
    fields:{
      location:{value:{location:'Ember Tavern'},confidence:1,observationClass:'OBSERVED'},
      activeCast:{value:[{characterId:'Mara',state:'PRESENT'}],confidence:1,observationClass:'OBSERVED'},
      immediateObjects:{value:[{objectId:'silver key',state:'PRESENT'}],confidence:.9,observationClass:'OBSERVED'},
    },
    boundarySignals:{locationTransition:{strength:.9}},
  });
  assert.equal(payload.kind,'NexusSceneObservationPayload');
  assert.equal(payload.authority,'PROPOSAL_ONLY');
  assert.equal(payload.canonicalMutationAuthority,false);
  assert.equal(payload.fields.location.value.location,'Ember Tavern');
  assert.equal(sceneObservationValidator(payload).valid,true);
  assert.throws(()=>normalizeSceneObservationOutput({
    fields:{illegalField:{value:'x',confidence:1,observationClass:'OBSERVED'}},
    boundarySignals:{},
  }),/Unsupported Scene field/);
}

{
  const cast=new ActiveCastResolver();
  const first=cast.resolve({
    previous:[],revision:1,evidenceRefs:['e1'],
    observations:[
      {characterId:'Mara',state:CastPresence.PRESENT,confidence:1,evidenceRefs:['e1'],explicit:true},
      {characterId:'Iris',state:CastPresence.PRESENT,confidence:1,evidenceRefs:['e1'],explicit:true},
    ],
  });
  const second=cast.resolve({
    previous:first.value,revision:2,evidenceRefs:['e2'],
    observations:[
      {characterId:'Mara',state:CastPresence.PRESENT,confidence:1,evidenceRefs:['e2'],explicit:true},
      {characterId:'Iris',state:CastPresence.DEPARTED,confidence:1,evidenceRefs:['e2'],explicit:true},
    ],
  });
  assert.equal(second.value.find(row=>row.characterId==='Iris').state,CastPresence.DEPARTED);

  const spatial=new SpatialStateTracker();
  const location=spatial.update({
    previous:null,revision:1,evidenceRefs:['e1'],
    proposal:{location:'Ember Tavern',confidence:1,observationClass:ObservationClass.OBSERVED},
  });
  assert.equal(location.value.location,'Ember Tavern');
}

{
  const detector=new SemanticBoundaryDetector();
  const verifier=new BoundaryVerifier();
  const candidate=detector.detect({
    sceneId:'scene-1',evidenceRefs:['e1'],
    signals:{locationTransition:1,majorTimeJump:.8},
  });
  assert.ok(candidate);
  const pending=verifier.submit(candidate);
  assert.equal(pending.status,'PENDING');
  const decision=verifier.observe(candidate.candidateId,{support:1,evidenceRefs:['e2']});
  assert.equal(decision.status,'CONFIRMED');
}

{
  const runtime=fs.readFileSync(new URL('../nexus/scene-intelligence.js',import.meta.url),'utf8');
  const scanner=fs.readFileSync(new URL('../scene/runtime.js',import.meta.url),'utf8');
  const frame=fs.readFileSync(new URL('../nexus/generation-frame-outlets.js',import.meta.url),'utf8');
  const frameContract=fs.readFileSync(new URL('../nexus/generation-frame-contract.js',import.meta.url),'utf8');
  const scheduler=fs.readFileSync(new URL('../lifecycle/scheduler.js',import.meta.url),'utf8');
  const retrieval=fs.readFileSync(new URL('../retrieval/retriever.js',import.meta.url),'utf8');
  const index=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
  const bus=fs.readFileSync(new URL('../sidecar/bus.js',import.meta.url),'utf8');

  assert.ok(scanner.includes('observeNexusSceneAuthority({ sceneScan, gate, context })'));
  assert.ok(runtime.includes("path:'scanner'"));
  assert.ok(runtime.includes("path='extractor'"));
  assert.ok(runtime.includes("runNexusSceneObservationPostTurn"));
  assert.ok(runtime.includes("getNexusSceneWorldTreeNodes"));
  assert.ok(runtime.includes("observeNexusHotSceneSignal"));
  assert.ok(runtime.includes("retractNexusSceneMessage"));

  assert.ok(frame.includes('getNexusSceneIntelligenceView'));
  assert.ok(frame.includes("source:'scene-intelligence'"));
  assert.ok(frameContract.includes("[NEXUS_GENERATION_OUTLET.SCENE]: Object.freeze({ order:100"));
  assert.ok(frameContract.includes("[NEXUS_GENERATION_OUTLET.CHANGE_GATE]: Object.freeze({ order:110"));

  assert.ok(scheduler.includes("recordStep(cycle,'scene-observation','running'"));
  assert.ok(scheduler.includes('runNexusSceneObservationPostTurn'));
  assert.ok(bus.includes("SCENE_OBSERVATION:'scene-observation'"));
  assert.ok(retrieval.includes('createCanonicalWorldTreeReadApi'));
  assert.ok(retrieval.includes("syncLegacyLoreToWorldTree('sensory-canonical-read')"));
  assert.ok(!retrieval.includes('getNexusSceneWorldTreeNodes'),'Retrieval must not build a second Scene-backed World Tree');
  assert.ok(index.includes('retractNexusSceneMessage'));
  assert.ok(index.includes("activateNexusSceneIntelligence({context:getContext(),reason:'CHAT_SWITCH'})"));

  assert.ok(!runtime.includes('A52Mode.SHADOW'));
  assert.ok(!runtime.includes('A52Mode.ON'));
}

console.log('Area-52 revised Scene Intelligence wiring: PASS');
