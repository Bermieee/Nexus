import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectNexusActivityFeed, projectNexusActivityEvent } from '../src/ui-core/activity-projection.js';

const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Activity Feed maps retired Decision Core presentation to Jev',()=>{
  const row=projectNexusActivityEvent({
    id:'e1',ts:100,level:'info',category:'decision-core',name:'retrieval-candidate-admission-batched',
    data:{candidateCount:6},
  });
  assert.equal(row.source,'Jev');
  assert.equal(row.sourceId,'jev');
  assert.equal(row.tab,'SYSTEM');
  assert.match(row.summary,/Retrieval Candidate Admission Batched/i);
});

test('Activity Feed exposes Scene Intelligence as a first-class source',()=>{
  const row=projectNexusActivityEvent({
    id:'e2',ts:200,level:'info',category:'scene-intelligence',name:'scene-continuity-updated',
    data:{state:'stable'},
  });
  assert.equal(row.source,'Scene Intelligence');
  assert.equal(row.sourceId,'scene-intelligence');
  assert.equal(row.tab,'SYSTEM');
});

test('Activity Feed preserves Main A B Running Queued runtime strip semantics',()=>{
  const snap=projectNexusActivityFeed({
    telemetry:{events:[]},
    queue:{running:[{id:'r1'}],queued:[{id:'q1'},{id:'q2'}],lanes:{A:{running:['a1'],queued:[]},B:{running:[],queued:['b1']}}},
    mainBridge:{mode:'disabled',active:false},
    settings:{sidecars:{A:{enabled:true},B:{enabled:true}}},
  });
  assert.deepEqual(
    {main:snap.status.main.state,A:snap.status.A.state,B:snap.status.B.state,running:snap.status.running,queued:snap.status.queued},
    {main:'disabled',A:'working',B:'queued',running:1,queued:2},
  );
});

test('Activity Feed tabs partition memory proposals and system events',()=>{
  const snap=projectNexusActivityFeed({
    telemetry:{events:[
      {id:'m',ts:1,level:'info',category:'memory-recall',name:'historical-memory-injected',data:{}},
      {id:'p',ts:2,level:'info',category:'proposal-review',name:'proposal-created',data:{}},
      {id:'s',ts:3,level:'info',category:'scheduler',name:'job-running',data:{}},
    ]},
  });
  assert.equal(snap.counts.ALL,3);
  assert.equal(snap.counts.MEMORY,1);
  assert.equal(snap.counts.PROPOSALS,1);
  assert.equal(snap.counts.SYSTEM,1);
});

test('floating Activity Feed controller keeps orb and window geometry independent',()=>{
  const src=read('src/ui-core/activity-console.js');
  assert.match(src,/orbX:numberOrNull\(p\.orbX\)/);
  assert.match(src,/panelX:numberOrNull\(p\.panelX\)/);
  assert.match(src,/panelW:finiteOr\(p\.panelW,860\)/);
  assert.match(src,/panelH:finiteOr\(p\.panelH,620\)/);
  assert.match(src,/#bindOrb\(\)/);
  assert.match(src,/#bindPanelDrag\(\)/);
  assert.match(src,/#bindResize\(\)/);
  assert.match(src,/Math\.hypot\(dx,dy\)>=DRAG_THRESHOLD/,'orb click must be distinguished from drag');
  assert.match(src,/this\.state\.panelW=this\.resize\.w/);
  assert.match(src,/this\.state\.panelH=this\.resize\.h/);
  assert.match(src,/activityFeed:\{orbX:this\.state\.orbX,orbY:this\.state\.orbY,panelX:this\.state\.panelX,panelY:this\.state\.panelY,panelW:this\.state\.panelW,panelH:this\.state\.panelH,clearBeforeTs:this\.state\.clearBeforeTs\}/);
});

test('Activity Feed clear is presentation-only and never clears canonical telemetry',()=>{
  const controller=read('src/ui-core/activity-console.js');
  const runtime=read('src/ui-core/wave6-runtime.js');
  assert.match(controller,/this\.state\.clearBeforeTs=Date\.now\(\)/);
  assert.match(controller,/#visibleFeed\(snapshot=/);
  assert.equal(controller.includes('clearTelemetry'),false);
  assert.equal(runtime.includes('DemoActivityFeedController'),false);
  assert.match(runtime,/new ActivityFeedController/);
});


test('selected Nexus brand icon is used across shell and Activity Feed surfaces',()=>{
  const brand=read('src/ui-core/nexus-brand.js');
  const shell=read('src/ui-core/shell.js');
  const activity=read('src/ui-core/activity-console.js');
  const quick=read('src/ui-core/wave6-front-face.js');
  assert.match(brand,/data:image\/webp;base64,/);
  assert.match(shell,/nexus-brand__mark/);
  assert.match(activity,/nexus-activity-orb__mark/);
  assert.match(activity,/nexus-activity-window__icon/);
  assert.equal(activity.includes("text:'⌁'"),false,'Activity orb must not fall back to the placeholder glyph');
  assert.equal(activity.includes("text:'〰'"),false,'Activity header must not fall back to the placeholder glyph');
  assert.match(quick,/nexus-quick-dash__brand-mark/);
});


test('console theme does not reintroduce the legacy Nexus pseudo-logo',()=>{
  const css=read('styles/ui-core-console-theme.css');
  assert.match(css,/\.nexus-brand::before\{content:none!important;display:none!important\}/);
  assert.equal(css.includes("clip-path:polygon(50% 0,96% 88%"),false,'legacy Area-52-style A mark must stay removed');
  assert.match(css,/\.nexus-brand__mark\{/);
  assert.match(css,/\.nexus-brand__copy\{/);
});
