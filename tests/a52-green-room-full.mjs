import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  GreenRoomStore,
  createGreenRoomBatch,
  validateGreenRoomProviderOutput,
  projectGreenRoomForGeneration,
} from '../nexus/a52/green-room.js';
import { validatePromptIntegrity, PromptIntegrityCode } from '../nexus/a52/prompt-integrity.js';

{
  const batch=validateGreenRoomProviderOutput({
    sceneRevision:4,
    authority:'INFERRED',
    characters:[{
      characterRef:'Mara',
      confidence:.8,
      dimensions:{
        guardedness:.4,
        warmth:.7,
        anger:.1,
        trustTrend:'UP',
        anxiety:.2,
        latentIntent:'Protect the group',
        attentionTarget:'Iris',
        socialPressure:.3,
        uncertainty:.25,
      },
      directEvidenceRefs:['m1'],
      sourceRevisionSet:['r1'],
      expiryCondition:{ttlTurns:2},
    }],
  },{
    sceneRevision:4,
    knownCharacterRefs:['Mara'],
    knownEvidenceRefs:['m1'],
  });
  assert.equal(batch.authority,'INFERRED');
  assert.equal(batch.characters[0].canonical,false);
  assert.throws(()=>validateGreenRoomProviderOutput({
    sceneRevision:4,
    authority:'SETTLED',
    characters:[],
  },{sceneRevision:4}),/authority/i);
  assert.throws(()=>validateGreenRoomProviderOutput({
    sceneRevision:4,
    characters:[{
      characterRef:'Unknown',
      confidence:.5,
      dimensions:{uncertainty:.5},
      directEvidenceRefs:['m1'],
      sourceRevisionSet:['r1'],
    }],
  },{sceneRevision:4,knownCharacterRefs:['Mara'],knownEvidenceRefs:['m1']}),/Unknown Green Room character/);
}

{
  const store=new GreenRoomStore({defaultTtlTurns:2});
  const batch=createGreenRoomBatch({
    sceneRevision:7,
    characters:[{
      characterRef:'Mara',
      confidence:.9,
      dimensions:{warmth:.8,trustTrend:'UP'},
      directEvidenceRefs:['m7'],
      sourceRevisionSet:['r7'],
    }],
  });
  store.putBatch(batch,{turnSequence:20,activeCharacterRefs:['Mara']});
  assert.equal(store.active({turnSequence:20,sceneRevision:7,activeCharacterRefs:['Mara']}).length,1);
  assert.equal(store.active({turnSequence:20,sceneRevision:8,activeCharacterRefs:['Mara']}).length,0,'scene revision change must expire inference');

  store.putBatch(batch,{turnSequence:30,activeCharacterRefs:['Mara']});
  assert.equal(store.active({turnSequence:32,sceneRevision:7,activeCharacterRefs:['Mara']}).length,1);
  assert.equal(store.active({turnSequence:33,sceneRevision:7,activeCharacterRefs:['Mara']}).length,0,'TTL must expire after two turns');
}

{
  const good=validatePromptIntegrity({greenRoom:[{authority:'INFERRED',canonical:false,durableMutation:false}]});
  assert.equal(good.ok,true);
  const bad=validatePromptIntegrity({greenRoom:[{authority:'SETTLED',canonical:true}]});
  assert.equal(bad.ok,false);
  assert.equal(bad.violations[0].code,PromptIntegrityCode.GREEN_ROOM_AUTHORITY);

  const store=new GreenRoomStore();
  store.putBatch(createGreenRoomBatch({
    sceneRevision:2,
    characters:[{
      characterRef:'Iris',
      confidence:.75,
      dimensions:{anxiety:.3,trustTrend:'STABLE'},
      directEvidenceRefs:['m2'],
      sourceRevisionSet:['r2'],
    }],
  }),{turnSequence:2,activeCharacterRefs:['Iris']});
  const projection=projectGreenRoomForGeneration(store,{sceneRevision:2,turnSequence:2,activeCharacterRefs:['Iris']});
  assert.equal(projection.authority,'INFERRED');
  assert.equal(projection.durableMutation,false);
  assert.equal(projection.characters[0].authority,'INFERRED');
}

{
  const runtime=fs.readFileSync(new URL('../nexus/green-room.js',import.meta.url),'utf8');
  const scheduler=fs.readFileSync(new URL('../lifecycle/scheduler.js',import.meta.url),'utf8');
  const frame=fs.readFileSync(new URL('../nexus/generation-frame-outlets.js',import.meta.url),'utf8');
  const frameContract=fs.readFileSync(new URL('../nexus/generation-frame-contract.js',import.meta.url),'utf8');
  const index=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
  const bus=fs.readFileSync(new URL('../sidecar/bus.js',import.meta.url),'utf8');

  assert.ok(runtime.includes("authority:'INFERRED'"));
  assert.ok(runtime.includes('validateGreenRoomProviderOutput'));
  assert.ok(runtime.includes('validatePromptIntegrity'));
  assert.ok(runtime.includes('SKIP_GREEN_ROOM'));
  assert.ok(runtime.includes("defaultTtlTurns:2"));
  assert.ok(runtime.includes('currentNexusHotSnapshot'));
  assert.ok(runtime.includes('getNexusSceneIntelligenceView'));
  assert.ok(!runtime.includes('updateCharacterBank('));
  assert.ok(!runtime.includes('mutateChatMetadataDurably'));
  assert.ok(!runtime.includes('saveMetadata'));

  const sceneAt=scheduler.indexOf("recordStep(cycle,'scene-observation','running'");
  const greenAt=scheduler.indexOf("recordStep(cycle,'green-room','running'");
  assert.ok(sceneAt>=0&&greenAt>sceneAt,'Green Room must run after Scene observation');
  assert.ok(scheduler.includes('runNexusGreenRoomPostTurn'));

  assert.ok(frame.includes('getNexusGreenRoomProjection'));
  assert.ok(frame.includes('renderNexusGreenRoom'));
  assert.ok(frame.includes("greenRoomAuthority:'INFERRED'"));
  assert.ok(frame.includes("greenRoomCount:greenRoom?.characters?.length||0"));
  assert.ok(frameContract.includes('explicitly labeled Green Room inferences'));
  assert.ok(!frameContract.includes("GREEN_ROOM: 'green-room'"),'Green Room must not create a new Generation Frame outlet');

  assert.ok(index.includes('invalidateNexusGreenRoomForSourceChange'));
  assert.ok(index.includes("resetNexusGreenRoom({reason:'chat-changed'})"));
  assert.ok(bus.includes("GREEN_ROOM:'green-room'"));
  assert.ok(bus.includes('GREEN_ROOM: 67'));

  assert.ok(!runtime.includes('A52Mode.SHADOW'));
  assert.ok(!runtime.includes('A52Mode.ON'));
}

console.log('Area-52 revised Green Room wiring: PASS');
