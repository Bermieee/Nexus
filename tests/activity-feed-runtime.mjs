import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectNexusActivityFeed, projectNexusActivityEvent } from '../src/ui-core/activity-projection.js';
import { ActivityFeedController } from '../src/ui-core/activity-console.js';

const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('functional milestones retain candidate and budget details without flooding the feed',()=>{
  const events=[],scope={chatId:'story-a',generationId:'gen-a'};
  const add=(category,name,data={},level='info')=>events.push({id:'e'+events.length,ts:events.length+1,category,name,level,data:{...scope,...data}});
  for(let i=0;i<17;i++)add('nexus.sensory','budget.plan',{jobId:'sensory.channel.'+i,channelId:'channel-'+i,reasonCode:'ALLOCATION_READY'});
  add('nexus.sensory','candidate-envelope',{candidateCount:51});
  for(let i=0;i<52;i++)add('nexus.truth','candidate-verdict',{candidateId:'lore:'+i,classification:'CURRENT',kept:i<5});
  add('nexus.truth','assessment-complete',{candidateCount:52,keptCount:5,droppedCount:47});
  add('retrieval','injection-complete',{entryCount:5,estimatedInjectionTokens:1167,refs:[{book:'Book A',uid:16,title:'Ainz',content:'PRIVATE-LORE'}]});
  add('sidecar-a','request-start',{slot:'A',reason:'lore-injection',model:'glm-5.3-flash'});
  add('sidecar-a','request-success',{slot:'A',reason:'lore-injection',model:'glm-5.3-flash',latencyMs:2500});
  add('nexus.truth','candidate-verdict',{candidateId:'bad',classification:'INVALID',reasonCode:'SOURCE_STALE'},'warn');
  const before=JSON.stringify(events),snap=projectNexusActivityFeed({telemetry:{events}});
  assert.equal(snap.events.length,6);
  const sensory=snap.events.find(row=>row.eventName==='candidate-envelope');
  assert.match(sensory.summary,/51.*candidates/i);assert.equal(sensory.relatedEvents.length,17);
  const truth=snap.events.find(row=>row.eventName==='assessment-complete');
  assert.equal(truth.source,'Truth');assert.match(truth.summary,/52.*5.*47/);assert.equal(truth.relatedEvents.length,52);
  assert.match(snap.events.find(row=>row.eventName==='injection-complete').summary,/5 Lore entries.*1,167/i);
  assert.equal(snap.events.filter(row=>row.source==='SC-A').length,2);
  assert.match(snap.events.find(row=>row.eventName==='request-start').summary,/Working.*lore-injection/i);
  assert.ok(snap.events.some(row=>row.level==='warn'&&row.detailFields.reasonCode==='SOURCE_STALE'));
  assert.equal(JSON.stringify(events),before,'presentation must never rewrite canonical telemetry');
  assert.equal(JSON.stringify(snap).includes('PRIVATE-LORE'),false);
});

test('detail groups never borrow another story or generation and remain available before completion',()=>{
  const event=(id,chatId,generationId,name,data={})=>({id,ts:1,category:'nexus.truth',name,level:'info',data:{chatId,generationId,...data}});
  const snap=projectNexusActivityFeed({telemetry:{events:[
    event('a','a','gen','candidate-verdict',{candidateId:'a-only',kept:true}),
    event('b','b','gen','assessment-complete',{candidateCount:1}),
    event('c','a','next','assessment-complete',{candidateCount:2}),
  ]}});
  const pending=snap.events.find(row=>row.relatedEvents?.some(e=>e.id==='a'));
  assert.ok(pending,'in-progress details must remain inspectable');
  assert.ok(snap.events.filter(row=>['b','c'].includes(row.id)).every(row=>row.relatedEvents.length===0));
});

test('unscoped diagnostic steps group only consecutively and worker plans keep their own job identity',()=>{
  const events=[
    {id:'u1',ts:1,category:'nexus.sensory',name:'budget.plan'},
    {id:'u2',ts:2,category:'nexus.sensory',name:'budget.plan'},
    {id:'bound',ts:3,category:'nexus.sensory',name:'candidate-envelope',data:{chatId:'other',generationId:'other',candidateCount:4}},
    {id:'u3',ts:4,category:'nexus.sensory',name:'budget.plan'},
    {id:'plan-a',ts:5,category:'sidecar-a',name:'plan',data:{chatId:'a',generationId:'gen',jobId:'job-a'}},
    {id:'start-b',ts:6,category:'sidecar-a',name:'request-start',data:{chatId:'a',generationId:'gen',jobId:'job-b'}},
    {id:'start-a',ts:7,category:'sidecar-a',name:'request-start',data:{chatId:'a',generationId:'gen',jobId:'job-a'}},
  ];
  const rows=projectNexusActivityFeed({telemetry:{events}}).events;
  assert.deepEqual(rows.find(row=>row.id==='u1').relatedEvents.map(row=>row.id),['u1','u2']);
  assert.deepEqual(rows.find(row=>row.id==='u3').relatedEvents.map(row=>row.id),['u3']);
  assert.equal(rows.find(row=>row.id==='bound').relatedEvents.length,0);
  assert.equal(rows.find(row=>row.id==='start-b').relatedEvents.length,0);
  assert.deepEqual(rows.find(row=>row.id==='start-a').relatedEvents.map(row=>row.id),['plan-a']);
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

function activityDocument(){
  const make=tag=>({tagName:tag.toUpperCase(),dataset:{},style:{},children:[],attributes:{},listeners:new Map(),open:false,
    setAttribute(key,value){this.attributes[key]=String(value);},getAttribute(key){return this.attributes[key]??null;},
    append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=[...nodes];},
    addEventListener(type,fn){this.listeners.set(type,fn);},removeEventListener(type,fn){if(this.listeners.get(type)===fn)this.listeners.delete(type);},
    querySelector(){return null;},remove(){},dispatch(type){this.listeners.get(type)?.({target:this});}});
  const doc=make('document');doc.createElement=make;doc.body=make('body');doc.defaultView={innerWidth:1280,innerHeight:800};return doc;
}
const flatten=node=>[node,...(node.children??[]).flatMap(flatten)];

test('activity rows open real detail boxes and stay expanded across live updates',()=>{
  const document=activityDocument(),raw=[{id:'retrieval',ts:1,category:'retrieval',name:'injection-complete',data:{entryCount:5,refs:[{book:'Book',uid:1,title:'Ainz'}]}}];
  const controller=new ActivityFeedController({document,readFeed:()=>projectNexusActivityFeed({telemetry:{events:raw}})}).mount();
  controller.open();
  let row=flatten(controller.nodes.list).find(node=>node.tagName==='DETAILS');
  assert.ok(row,'each activity action must have an expandable detail box');
  assert.equal(row.children[0].tagName,'SUMMARY','native summary provides mouse and keyboard activation');
  row.open=true;row.dispatch('toggle');
  raw.push({id:'worker',ts:2,category:'sidecar-a',name:'request-start',data:{model:'test',slot:'A'}});
  controller.render();
  row=flatten(controller.nodes.list).find(node=>node.tagName==='DETAILS'&&node.dataset.eventId==='retrieval');
  assert.equal(row.open,true,'new telemetry must not collapse the action being inspected');
  const text=flatten(row).map(node=>node.textContent??'').join(' ');assert.match(text,/Ainz/);assert.match(text,/Book/);
  controller.destroy();
});

test('expanded processing steps stay open when another function publishes activity',()=>{
  const document=activityDocument(),raw=[
    {id:'verdict',ts:1,category:'nexus.truth',name:'candidate-verdict',data:{chatId:'a',generationId:'g',candidateId:'c'}},
    {id:'truth',ts:2,category:'nexus.truth',name:'assessment-complete',data:{chatId:'a',generationId:'g',candidateCount:1}},
  ];
  const controller=new ActivityFeedController({document,readFeed:()=>projectNexusActivityFeed({telemetry:{events:raw}})}).mount();controller.open();
  const row=flatten(controller.nodes.list).find(node=>node.dataset.eventId==='truth');row.open=true;row.dispatch('toggle');
  const steps=flatten(row).find(node=>node.className==='nexus-activity-row__steps');steps.open=true;steps.dispatch('toggle');
  raw.push({id:'scene',ts:3,category:'scene-intelligence',name:'scanner-observed'});controller.render();
  assert.equal(flatten(controller.nodes.list).find(node=>node.className==='nexus-activity-row__steps').open,true);
  controller.destroy();
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
