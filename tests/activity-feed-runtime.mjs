import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectNexusActivityFeed, projectNexusActivityEvent } from '../src/ui-core/activity-projection.js';
import { ActivityFeedController } from '../src/ui-core/activity-console.js';

const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('a Lorebook file read is not presented as a World Tree load or story attachment',()=>{
 const row=projectNexusActivityEvent({id:'source-read',ts:1,category:'lore',name:'loaded',data:{book:'Book',entryCount:105}});
 assert.equal(row.source,'Lorebook');assert.match(row.summary,/source read/i);assert.match(row.summary,/Book/);
 const sync=projectNexusActivityEvent({id:'sync',ts:2,category:'world-tree',name:'legacy-lore-synced',data:{books:['Book']}});
 assert.equal(sync.source,'World Tree');
});

test('typed source labels and expanded metadata retain outcomes without exposing private payloads',()=>{
  const row=projectNexusActivityEvent({id:'outcome',ts:1,category:'nexus.truth',name:'candidate-verdict',
    data:{candidateId:'candidate:7',classification:'HISTORICAL',kept:false,sourceRevisionRefs:['rev:7'],
      reasonCode:'HISTORICAL_SUPPORT',prompt:'PRIVATE-PROMPT',reasoning:'PRIVATE-REASONING',apiKey:'PRIVATE-KEY',content:'PRIVATE-CONTENT'}});
  assert.equal(row.source,'Truth');assert.equal(row.detailFields.classification,'HISTORICAL');assert.equal(row.detailFields.kept,false);
  assert.deepEqual(row.detailFields.sourceRevisionRefs,['rev:7']);
  assert.equal(JSON.stringify(row).includes('PRIVATE-'),false);
  const gather=projectNexusActivityEvent({id:'g',ts:2,category:'nexus.gather',name:'gather.summary',data:{counts:{ADMITTED:3,REJECTED:1}}});
  assert.equal(gather.source,'Gather');assert.match(gather.summary,/3.*admitted.*1.*rejected/i);
});

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
