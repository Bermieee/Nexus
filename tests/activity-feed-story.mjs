import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectNexusActivityFeed, projectNexusActivityEvent } from '../src/ui-core/activity-projection.js';
import { projectStoryTurns, storyItemsFromEvent } from '../src/ui-core/activity-story.js';
import { ActivityFeedController } from '../src/ui-core/activity-console.js';
import { userTurnNumber } from '../nexus/turn-number.js';

const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
let sequence=0;
const ev=(category,name,data={},{level='info',ts=++sequence,id}={})=>({id:id??('e'+ts+'-'+sequence),ts,level,category,name,data});
const scope=(turn,chatId='chat-a',generationId='gen-'+turn)=>({chatId,generationId,turn});
const feed=(events,extra={})=>projectNexusActivityFeed({telemetry:{events},...extra});

// A realistic turn: new scene, lore injected, World Tree learned, one rejected update, plus a lot of engine noise.
function turnEvents(turn,{chatId='chat-a'}={}){
  const sc=scope(turn,chatId);
  return [
    ev('nexus.scene','scanner-observed',{chatId,boundaryConfirmed:true,location:'Throne Room',turn}),
    ev('nexus.sensory','candidate-envelope',{...sc,candidateCount:51}),
    ev('nexus.truth','assessment-complete',{...sc,candidateCount:52,keptCount:5}),
    ev('retrieval','injection-complete',{...sc,entryCount:3,estimatedInjectionTokens:1500,refs:[{title:'Albedo',content:'PRIVATE-LORE'},{title:'Great Tomb of Nazarick'},{title:'Throne Room'}]}),
    ev('worldtree.intake','applied',{...sc,source:'scene',createdNodes:1,createdEdges:1}),
    ev('worldtree.intake','rejected',{...sc},{level:'warn'}),
    ev('sidecar-a','request-start',{slot:'A'}),
  ];
}

// ---------------------------------------------------------------- what is and is not a feed row

const INTERNAL=[
  ['nexus.scatter','budget.plan',{jobId:'sensory.channel.1'}],
  ['nexus.scatter','scatter.summary',{counts:{A:1}}],
  ['scheduler','job-running',{}],
  ['scheduler','lane-cycle',{cycleId:'c',stepCount:3}],
  ['decision-core','decision.site',{siteId:'truth.intent',choice:'CURRENT'}],
  ['decision-core','recorded',{}],
  ['nexus.sensory','candidate-envelope',{candidateCount:51}],
  ['nexus.sensory','budget.plan',{}],
  ['nexus.walker','traversal',{}],
  ['nexus.truth','candidate-verdict',{classification:'CURRENT'}],
  ['nexus.truth','assessment-complete',{candidateCount:52,keptCount:5,droppedCount:47}],
  ['nexus.hot','segment-updated',{}],
  ['worldtree.intake','processing',{}],
  ['worldtree.growth','wait',{}],
  ['worldtree.watch','entered',{}],
  ['sidecar-a','request-start',{slot:'A'}],
  ['sidecar-b','request-success',{slot:'B',latencyMs:2500}],
  ['model-worker','dispatch-enqueued',{}],
  ['queue-dispatcher','tick',{}],
  ['lifecycle','phase',{}],
  ['nexus.gather','gather.verdict',{verdict:'ADMITTED'}],
  ['nexus.gather','gather.summary',{counts:{ADMITTED:3,LATE:0,STALE:0,INVALID:0}}],
  ['retrieval','candidate-rerank-shadow-complete',{}],
  ['retrieval','foreground-progress',{}],
  ['vector-paging','probe',{}],
  ['smart-context','warm',{}],
  ['prompt-loader','chat-completion-ready',{}],
];

test('internal event types never produce feed rows and remain available in Diagnostics',()=>{
  const events=INTERNAL.map(([category,name,data])=>ev(category,name,{chatId:'chat-a',generationId:'g',turn:1,...data}));
  const before=JSON.stringify(events);
  const snap=feed(events);
  assert.equal(snap.turns.length,0);
  assert.deepEqual({...snap.counts},{STORY:0,MEMORY:0,PROPOSALS:0,PROBLEMS:0});
  assert.equal(JSON.stringify(events),before,'presentation never rewrites canonical telemetry');
  // Diagnostics still has every one of them as an inspectable event
  for(const record of events){
    const row=projectNexusActivityEvent(record);
    assert.equal(row.rawCategory,record.category);
    assert.ok(row.summary.length>0);
  }
  for(const [category,name,data] of INTERNAL)assert.deepEqual(storyItemsFromEvent(ev(category,name,data)),[],category+' '+name);
});

test('growth is shown only when it grew or expired; waiting is not shown',()=>{
  assert.equal(feed([ev('worldtree.growth','wait',{...scope(2)})]).turns.length,0);
  const expired=feed([ev('worldtree.growth','expired',{...scope(2)})]);
  assert.equal(expired.turns.length,1);
  assert.match(expired.turns[0].children[0].summary,/growth candidate expired/);
});

test('lore imports, owner edits and no-op World Tree writes are not story learning',()=>{
  const sc=scope(3);
  for(const [name,data] of [
    ['applied',{source:'lore',createdNodes:40,createdEdges:60}],
    ['applied',{source:'owner',createdNodes:1}],
    ['applied-deterministic',{source:'scene',noOp:true,nodeCount:2,edgeCount:2}],
    ['applied',{source:'scene',createdNodes:0,createdEdges:0,supersededNodes:0}],
  ])assert.equal(feed([ev('worldtree.intake',name,{...sc,...data})]).turns.length,0,name+' '+JSON.stringify(data));
  const learned=feed([ev('worldtree.intake','applied-deterministic',{...sc,source:'card',noOp:false,nodeCount:2,edgeCount:1})]);
  assert.equal(learned.turns[0].children[0].summary,'2 World Tree entries updated; 1 link');
  const memory=feed([ev('worldtree.intake','applied',{...sc,source:'character-memory',createdNodes:1})]);
  assert.equal(memory.counts.MEMORY,1,'character memory is memory');
});

test('a turn produces exactly one collapsed row and its children match the turn\'s events',()=>{
  const events=[...turnEvents(4),...turnEvents(5)];
  const snap=feed(events);
  assert.equal(snap.turns.length,2,'one row per turn');
  const four=snap.turns.find(row=>row.turn===4);
  assert.equal(four.label,'Turn 4');
  assert.equal(four.summary,'Scene + 3 lore added · 2 learned · 1 problem');
  assert.deepEqual(four.children.map(child=>child.label),['Added','Learned','Problem']);
  assert.deepEqual(four.children.map(child=>child.type),['ADDED','LEARNED','PROBLEM']);
  assert.equal(four.children[0].summary,'Throne Room scene; lore: Albedo, Great Tomb of Nazarick, Throne Room · 1.5k tokens');
  assert.equal(four.children[1].summary,'1 new World Tree entry; 1 new link');
  assert.equal(four.children[2].summary,'A World Tree update was rejected');
  // children are exactly backed by the events that produced them
  const ids=name=>events.filter(e=>e.name===name&&e.data.turn===4).map(e=>e.id);
  assert.deepEqual(new Set(four.children[0].trace.eventIds),new Set([...ids('scanner-observed'),...ids('injection-complete')]));
  assert.deepEqual([...four.children[1].trace.eventIds],ids('applied'));
  assert.deepEqual([...four.children[2].trace.eventIds],ids('rejected'));
  assert.ok(four.children.every(child=>child.trace.turn===4&&child.trace.chatId==='chat-a'&&child.trace.generationId==='gen-4'));
});

test('a turn with only some kinds of events shows only those children',()=>{
  const snap=feed([ev('retrieval','injection-complete',{...scope(7),entryCount:1,estimatedInjectionTokens:300,refs:[{title:'Ainz'}]})]);
  assert.equal(snap.turns.length,1);
  assert.deepEqual(snap.turns[0].children.map(child=>child.label),['Added']);
  assert.equal(snap.turns[0].summary,'1 lore added');
  assert.equal(snap.turns[0].children[0].summary,'lore: Ainz · 300 tokens');
});

test('a swipe of the same turn stays one row, and events with no identity attach by time',()=>{
  const first=scope(6,'chat-a','gen-6a'),swipe=scope(6,'chat-a','gen-6b');
  const snap=feed([
    ev('retrieval','injection-complete',{...first,entryCount:2,refs:[{title:'A'},{title:'B'}]},{ts:10}),
    ev('retrieval','injection-complete',{...swipe,entryCount:2,refs:[{title:'A'},{title:'B'}]},{ts:20}),
    ev('summary','created',{},{ts:30}),
    ev('nexus.gather','gather.summary',{counts:{LATE:1}},{ts:31}),
  ]);
  assert.equal(snap.turns.length,1);
  assert.equal(snap.turns[0].summary,'4 lore added · 1 learned · 1 problem');
  assert.equal(snap.turns[0].generationId,'gen-6b','the trace follows the latest generation');
});

test('story and chat isolation: another chat\'s turn never borrows these events',()=>{
  const snap=feed([...turnEvents(3,{chatId:'chat-a'}),...turnEvents(3,{chatId:'chat-b'})]);
  assert.equal(snap.turns.length,2);
  assert.deepEqual(new Set(snap.turns.map(row=>row.chatId)),new Set(['chat-a','chat-b']));
  for(const turn of snap.turns)assert.equal(turn.summary,'Scene + 3 lore added · 2 learned · 1 problem');
  const orphan=feed([ev('summary','created',{chatId:'chat-b'},{ts:5}),...turnEvents(3,{chatId:'chat-a'}).map((e,i)=>({...e,ts:100+i}))]);
  assert.equal(orphan.turns.find(row=>row.chatId==='chat-a').summary.includes('learned'),true);
  assert.equal(orphan.turns.length,2,'a chat-b memory event does not attach to chat-a\'s turn');
});

test('turn numbers come from the player\'s message count, falling back to order',()=>{
  assert.equal(userTurnNumber([{is_user:true},{is_user:false},{is_user:true},{is_user:false}]),2);
  assert.equal(userTurnNumber(null),0);
  const snap=feed([ev('summary','created',{chatId:'x'},{ts:1}),ev('summary','created',{chatId:'y'},{ts:2})]);
  assert.deepEqual(snap.turns.map(row=>row.label),['Turn 1','Turn 2']);
});

// ---------------------------------------------------------------- problems

test('a Gather problem (late, stale or invalid) appears; a clean Gather does not',()=>{
  const clean=feed([ev('nexus.gather','gather.summary',{counts:{ADMITTED:4,REJECTED:1,LATE:0,STALE:0,INVALID:0}},{ts:1})]);
  assert.equal(clean.turns.length,0);
  assert.equal(clean.counts.PROBLEMS,0);
  for(const [counts,pattern] of [[{LATE:2},/2 late/],[{stale:1},/1 stale/],[{ADMITTED:3,INVALID:3},/3 invalid/],[{LATE:1,STALE:1,INVALID:1},/1 late, 1 stale, 1 invalid/]]){
    const snap=feed([ev('nexus.gather','gather.summary',{counts},{ts:1})]);
    assert.equal(snap.counts.PROBLEMS,1,JSON.stringify(counts));
    assert.match(snap.problems[0].summary,pattern);
    assert.equal(snap.turns[0].children[0].type,'PROBLEM');
  }
});

test('problems that affect the story are in plain words, and engine warnings are not problems',()=>{
  const snap=feed([
    ev('retrieval','foreground-retrieval-failed',{...scope(2)},{level:'error'}),
    ev('memory-recall','rerank-failed',{...scope(2)},{level:'warn'}),
    ev('worldtree.intake','rejected',{...scope(2)},{level:'warn'}),
    ev('retrieval','minor-empty-nodes-preserved',{...scope(2)},{level:'warn'}),
    ev('scheduler','job-deferred',{...scope(2)},{level:'warn'}),
    ev('nexus.truth','candidate-verdict',{...scope(2),classification:'INVALID'},{level:'warn'}),
  ]);
  assert.equal(snap.counts.PROBLEMS,3);
  assert.deepEqual(snap.problems.map(row=>row.summary),[
    'Lore retrieval failed, so this reply used no new lore',
    'Memory ranking failed; a simpler ranking was used',
    'A World Tree update was rejected',
  ]);
  assert.ok(snap.problems.every(row=>row.trace.eventIds.length===1&&row.turnLabel==='Turn 2'));
});

test('memory shows what was saved and recalled, in its own view',()=>{
  const snap=feed([
    ev('memory-recall','injection-complete',{...scope(8),selectedCount:2,characterMemoryCount:1,estimatedTokens:1200}),
    ev('summary','created',{...scope(8)}),
    ev('retrieval','injection-complete',{...scope(8),entryCount:1,refs:[{title:'Ainz'}]}),
  ]);
  assert.equal(snap.counts.MEMORY,2);
  assert.deepEqual(snap.memory.map(row=>row.label).sort(),['Recalled','Saved']);
  assert.match(snap.memory.find(row=>row.label==='Recalled').summary,/3 memories added to context · 1.2k tokens/);
  assert.equal(snap.turns.length,1,'memory is part of the same turn row');
});

// ---------------------------------------------------------------- proposals, status, tabs (the controller)

function activityDocument(){
  const make=tag=>({tagName:tag.toUpperCase(),dataset:{},style:{},children:[],attributes:{},listeners:new Map(),open:false,className:'',textContent:'',
    setAttribute(key,value){this.attributes[key]=String(value);},getAttribute(key){return this.attributes[key]??null;},
    append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=[...nodes];},
    addEventListener(type,fn){this.listeners.set(type,fn);},removeEventListener(type,fn){if(this.listeners.get(type)===fn)this.listeners.delete(type);},
    querySelector(){return null;},remove(){},dispatch(type){this.listeners.get(type)?.({target:this,stopPropagation(){}});}});
  const doc=make('document');doc.createElement=make;doc.body=make('body');doc.defaultView={innerWidth:1280,innerHeight:800};return doc;
}
const flatten=node=>[node,...(node.children??[]).flatMap(flatten)];
const textOf=node=>flatten(node).map(n=>n.textContent??'').join(' ');
const proposal=(id,status='pending',createdAt=1)=>({id,status,createdAt,op:{type:'lore.create',book:'Overlord'},source:'tool-gateway',sourceExcerpt:'PRIVATE-EXCERPT'});
function mountFeed({events,proposals=[],queue={},mainBridge={mode:'disabled'},open=true}={}){
  const calls=[],document=activityDocument(),state={events:events??[],proposals:[...proposals]};
  const controller=new ActivityFeedController({
    document,readFeed:()=>projectNexusActivityFeed({telemetry:{events:state.events},proposals:state.proposals,queue,mainBridge,settings:{sidecars:{A:{enabled:true},B:{enabled:true}}}}),
    openDiagnostics:trace=>{calls.push(['diagnostics',trace]);return true;},openProposal:row=>{calls.push(['proposal',row.proposalId]);return true;},
  }).mount();
  if(open)controller.open();
  return {controller,document,state,calls};
}
const rowsOf=controller=>controller.nodes.list.children;

test('Story is the default tab; the tabs are Story, Memory, Proposals and Problems, with no All or System',()=>{
  const {controller}=mountFeed({events:turnEvents(4)});
  assert.equal(controller.tab,'STORY');
  assert.equal(controller.diagnostics().tab,'STORY');
  const tabs=controller.nodes.tabs.children;
  assert.deepEqual(tabs.map(tab=>tab.dataset.tab),['STORY','MEMORY','PROPOSALS','PROBLEMS']);
  assert.deepEqual(tabs.map(tab=>tab.children[0].textContent),['Story','Memory','Proposals','Problems']);
  assert.equal(tabs.find(tab=>tab.dataset.tab==='STORY').dataset.selected,'true');
  assert.ok(!tabs.some(tab=>/^(all|system)$/i.test(tab.children[0].textContent)),'no All or System tab');
  controller.destroy();
});

test('one status dot with a tooltip replaces the Main / A / B / Running / Queued strip',()=>{
  const {controller}=mountFeed({events:[],queue:{running:[{id:'r'}],queued:[{id:'q'}],lanes:{A:{running:['a'],queued:[]},B:{running:[],queued:['b']}}},mainBridge:{mode:'disabled'}});
  const status=controller.nodes.status;
  const items=flatten(status).filter(n=>String(n.className).includes('nexus-activity-status__item'));
  assert.equal(items.length,1,'a single status item');
  assert.equal(flatten(status).filter(n=>String(n.className).includes('nexus-activity-status__dot')).length,1);
  assert.equal(items[0].dataset.state,'working');
  const tooltip=items[0].dataset.tooltip;
  for(const part of ['Main: disabled','A: working','B: queued','Running: 1','Queued: 1'])assert.ok(tooltip.includes(part),part);
  assert.equal(items[0].attributes.title,tooltip);
  const headline=textOf(status);
  assert.ok(!/Main|disabled|Queued/.test(headline.replace('View system events','')),'no strip text in the feed itself: '+headline);
  controller.destroy();
});

test('"Main disabled" is never a headline state: the dot stays idle and the detail lives in the tooltip',()=>{
  const snap=projectNexusActivityFeed({telemetry:{events:[]},mainBridge:{mode:'disabled'},settings:{sidecars:{A:{enabled:true},B:{enabled:true}}}});
  assert.equal(snap.status.main.state,'disabled');
  assert.equal(snap.status.dot.state,'idle');
  assert.equal(snap.status.dot.label,'Idle');
  assert.ok(snap.status.dot.tooltip.includes('Main: disabled'));
  assert.equal(projectNexusActivityFeed({telemetry:{events:[]},mainBridge:{mode:'disconnected'}}).status.dot.state,'attention');
  assert.deepEqual(
    {main:snap.status.main.state,A:snap.status.A.state,B:snap.status.B.state,running:snap.status.running,queued:snap.status.queued},
    {main:'disabled',A:'idle',B:'idle',running:0,queued:0},'the status data keeps its meaning for other readers',
  );
});

test('View system events opens Diagnostics',()=>{
  const {controller,calls}=mountFeed({events:[]});
  const link=flatten(controller.nodes.status).find(n=>n.dataset?.action==='view-system-events');
  assert.ok(link);
  assert.equal(link.textContent,'View system events');
  link.dispatch('click');
  assert.deepEqual(calls,[['diagnostics',{}]]);
  controller.destroy();
});

test('a pending proposal stands alone at the top, highlighted, until the player acts',()=>{
  const ctx=mountFeed({events:turnEvents(4),proposals:[proposal('p1','pending',50)]});
  const {controller,state}=ctx;
  const first=()=>rowsOf(controller)[0];
  assert.equal(first().dataset.kind,'proposal');
  assert.equal(first().dataset.highlight,'true');
  assert.equal(rowsOf(controller).filter(row=>row.dataset.kind==='proposal').length,1);
  assert.ok(rowsOf(controller).filter(row=>row.dataset.kind==='turn').length===1,'the turn is a separate row');
  assert.ok(!textOf(first()).includes('PRIVATE-EXCERPT'));
  // later turns arrive: the proposal is still first
  state.events.push(...turnEvents(5).map((e,i)=>({...e,ts:1000+i})));
  controller.render();
  assert.equal(first().dataset.kind,'proposal');
  assert.equal(rowsOf(controller).filter(row=>row.dataset.kind==='turn').length,2);
  // clearing the visible feed hides history but never a proposal that needs the player
  controller.nodes.clear.dispatch('click');
  assert.equal(first().dataset.kind,'proposal');
  assert.equal(rowsOf(controller).filter(row=>row.dataset.kind==='turn').length,0);
  // it has a badge while waiting
  const proposalsTab=controller.nodes.tabs.children.find(tab=>tab.dataset.tab==='PROPOSALS');
  assert.equal(proposalsTab.dataset.attention,'true');
  assert.equal(proposalsTab.children[1].textContent??proposalsTab.children[1].text,'1');
  // the player reviews it
  flatten(first()).find(n=>n.dataset?.action==='review-proposal').dispatch('click');
  assert.deepEqual(ctx.calls.at(-1),['proposal','p1']);
  // once the player acts (approves), the row goes
  state.proposals=[proposal('p1','approved',50)];
  controller.render();
  assert.equal(rowsOf(controller).filter(row=>row.dataset.kind==='proposal').length,0);
  const live=controller.nodes.tabs.children.find(tab=>tab.dataset.tab==='PROPOSALS');
  assert.equal(live.dataset.attention,'false');
  controller.destroy();
});

test('only proposals that need the player are shown, and they are the Proposals tab',()=>{
  const snap=projectNexusActivityFeed({telemetry:{events:[]},proposals:[
    proposal('a','pending',3),proposal('b','recovery-required',2),proposal('c','committing',1),proposal('d','approved',4),proposal('e','rejected',5),proposal('f','failed',6),
  ]});
  assert.deepEqual(snap.proposals.map(row=>row.proposalId),['b','a']);
  assert.equal(snap.proposals[0].summary,'Lore Create · in Overlord · from Tool Gateway');
  assert.equal(snap.counts.PROPOSALS,2);
  const {controller}=mountFeed({events:[],proposals:[proposal('a'),proposal('b','recovery-required',2)]});
  controller.tab='PROPOSALS';controller.render();
  assert.equal(rowsOf(controller).length,2);
  assert.ok(rowsOf(controller).every(row=>row.dataset.highlight==='true'));
  controller.destroy();
});

test('turn rows expand into child rows in the same layout, each linking to its Diagnostics trace',()=>{
  const {controller,calls,state}=mountFeed({events:turnEvents(4)});
  const turn=rowsOf(controller).find(row=>row.dataset.kind==='turn');
  assert.equal(turn.tagName,'DETAILS','native expand arrow');
  assert.equal(turn.children[0].tagName,'SUMMARY');
  const layout=node=>node.children.map(c=>String(c.className).replace('nexus-activity-row__',''));
  assert.deepEqual(layout(turn.children[0]),['tone','icon','source','summary','time'],'collapsed row: icon, label, summary, time');
  assert.equal(turn.children[0].children[2].textContent??turn.children[0].children[2].text,'Turn 4');
  const children=flatten(turn).filter(n=>n.dataset?.kind&&['added','learned','problem'].includes(n.dataset.kind));
  assert.deepEqual(children.map(row=>row.dataset.kind),['added','learned','problem']);
  for(const child of children)assert.deepEqual(layout(child.children[0]),['tone','icon','source','summary','time'],'child rows use the same layout');
  assert.ok(!flatten(turn).some(n=>n.tagName==='PRE'||n.tagName==='P'),'no cards or text blocks');
  const links=flatten(turn).filter(n=>n.dataset?.action==='open-trace');
  assert.equal(links.length,3);
  links[2].dispatch('click');
  assert.equal(calls.at(-1)[0],'diagnostics');
  const trace=calls.at(-1)[1];
  assert.deepEqual([trace.chatId,trace.generationId,trace.turn],['chat-a','gen-4',4]);
  assert.deepEqual([...trace.eventIds],[state.events.find(e=>e.name==='rejected').id],'the link carries exactly the events behind the row');
  controller.destroy();
});

test('an expanded turn stays open across live updates and unrelated engine activity',()=>{
  const {controller,state}=mountFeed({events:turnEvents(4)});
  let turn=rowsOf(controller).find(row=>row.dataset.kind==='turn');
  turn.open=true;turn.dispatch('toggle');
  state.events.push(ev('scheduler','job-running',{}),ev('nexus.truth','candidate-verdict',{}),ev('sidecar-a','request-start',{slot:'A'}));
  controller.render();
  turn=rowsOf(controller).find(row=>row.dataset.kind==='turn');
  assert.equal(turn.open,true);
  assert.equal(rowsOf(controller).filter(row=>row.dataset.kind==='turn').length,1,'engine activity adds no rows');
  controller.destroy();
});

test('Problems and Memory views are flat lists with a trace link per row',()=>{
  const {controller}=mountFeed({events:[...turnEvents(4),ev('memory-recall','injection-complete',{...scope(4),selectedCount:1,estimatedTokens:200})]});
  controller.tab='PROBLEMS';controller.render();
  assert.equal(rowsOf(controller).length,1);
  assert.ok(textOf(rowsOf(controller)[0]).includes('A World Tree update was rejected'));
  assert.equal(flatten(rowsOf(controller)[0]).filter(n=>n.dataset?.action==='open-trace').length,1);
  controller.tab='MEMORY';controller.render();
  assert.equal(rowsOf(controller).length,1);
  assert.ok(textOf(rowsOf(controller)[0]).includes('1 memory added to context'));
  const empty=mountFeed({events:[]});empty.controller.tab='PROBLEMS';empty.controller.render();
  assert.match(textOf(rowsOf(empty.controller)[0]),/No problems/);
  controller.destroy();empty.controller.destroy();
});

test('nothing private reaches the feed',()=>{
  const snap=feed(turnEvents(4),{proposals:[proposal('p1')]});
  const json=JSON.stringify(snap);
  assert.equal(json.includes('PRIVATE-'),false);
  assert.equal(json.includes('sourceExcerpt'),false);
});

// ---------------------------------------------------------------- wiring that source text can show

test('story events carry the identity the feed groups by',()=>{
  assert.match(read('retrieval/retriever.js'),/logEvent\('retrieval', 'injection-complete', \{\n\s+chatId: scope\?\.chatId \?\? context\?\.chatId \?\? null,\n\s+generationId: scope\?\.generationId \?\? generationId \?\? null,\n\s+turn: userTurnNumber\(context\?\.chat\)/);
  assert.match(read('memory/recall.js'),/logEvent\('memory-recall','injection-complete',\{chatId:[^}]*generationId:[^}]*turn:userTurnNumber\(context\?\.chat\)/);
  const intake=read('world-tree/intake/runtime.js');
  assert.match(intake,/logEvent\('worldtree\.intake','applied',\{chatId:[^}]*generationId:generationId\?\?null,turn:userTurnNumber\(context\?\.chat\)/);
  assert.match(intake,/logEvent\('worldtree\.intake','applied-deterministic',\{generationId:generationId\?\?null,chatId:/);
  assert.match(read('nexus/scene-intelligence.js'),/logEvent\('nexus\.scene','scanner-observed',\{[^}]*location:[^}]*turn:userTurnNumber\(context\?\.chat\)/);
});

test('the host feeds pending proposals in and refreshes on proposal changes; the runtime links out',()=>{
  const host=read('nexus-ui-host.js');
  assert.match(host,/proposals:\(\(\)=>\{try\{return getProposals\('all'\);\}catch\{return\[\];\}\}\)\(\)/);
  assert.match(host,/getProposalChangeEventName\(\)/);
  assert.match(host,/source:'proposals'/);
  const runtime=read('src/ui-core/wave6-runtime.js');
  assert.match(runtime,/openDiagnostics:trace=>/);
  assert.match(runtime,/\['turn-log','diagnostics'\]/);
  assert.match(runtime,/openProposal:/);
  const controller=read('src/ui-core/activity-console.js');
  assert.ok(controller.includes("this.tab='STORY'"));
  assert.ok(!controller.includes("'ALL'")&&!controller.includes("'SYSTEM'"));
  assert.ok(controller.includes('View system events'));
});
