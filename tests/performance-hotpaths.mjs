import fs from 'node:fs';
import assert from 'node:assert/strict';
import { isNarrativeSceneMessage, tailNarrativeSceneMessages } from '../retrieval/handoff-policy.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const search = read('retrieval/search-engine.js');
assert.match(search, /export async function searchTreeMany/);
assert.match(search, /function rankTreeSearchIndex/);
assert.match(search, /export async function searchTree[\s\S]*rankTreeSearchIndex\(index/);
assert.match(search, /export async function searchTreeMany[\s\S]*rankTreeSearchIndex\(index/);
assert.match(search, /buildBatchDocumentFrequencies\(index, allTerms\)/);
assert.match(search, /termDocumentFrequencies: documentFrequencies/);
assert.match(search, /entry\?\._searchFieldTokens \|\|/);
assert.match(search, /_searchFieldTokens, \.\.\.rest/);
assert.doesNotMatch(search, /applyPrompt|setExtensionPrompt|clearPrompt/);

const warmer = read('smart-context/warmer.js');
assert.match(warmer, /searchTreeMany/);
assert.match(warmer, /const batches = await searchTreeMany\(\{ queries, books, includeContent:false \}\)/);
assert.doesNotMatch(warmer, /for \(const term of terms\) \{\s*const found = await searchTree/);
assert.match(warmer, /SMART_CONTEXT_WARM_REVIEW_SITE_ID/);
assert.match(warmer, /startDecisionSiteThroughDirector/);
assert.match(warmer, /stage: 'after-scene-reference-resolution'/);
assert.match(warmer, /warmAuthorityState\(requestRevision, key, hydrationLimit\)/);

const telemetry = read('observability/telemetry.js');
assert.match(telemetry, /export function getTelemetryActivitySnapshot/);
assert.match(telemetry, /metadataOnly/);
const activityStart=telemetry.indexOf('export function getTelemetryActivitySnapshot');
const activityEnd=telemetry.indexOf('\nexport function ',activityStart+20);
const activityBody=telemetry.slice(activityStart,activityEnd<0?telemetry.length:activityEnd);
assert.doesNotMatch(activityBody, /\.push\(|\.splice\(|setItem\(|schedulePersist\(|state\.[A-Za-z0-9_.]+\s*=/);

const activityHost = read('nexus-ui-host.js');
const activityProjection = read('src/ui-core/activity-projection.js');
const activityConsole = read('src/ui-core/activity-console.js');
assert.match(activityHost, /readActivityFeed:\(\)=>projectNexusActivityFeed\(\{/);
assert.match(activityHost, /telemetry:getTelemetryActivitySnapshot\(\)/);
assert.match(activityHost, /subscribeActivityFeed:listener=>/);
assert.match(activityHost, /onTelemetryChange\(\(\)=>listener\(\{kind:'NexusActivityFeedChanged',source:'telemetry'\}\)\)/);
assert.match(activityHost, /queue\?\.onSignal\?\.\(\(\)=>listener\(\{kind:'NexusActivityFeedChanged',source:'queue'\}\)\)/);
assert.match(activityProjection, /const MAX_EVENTS=240/);
assert.match(activityProjection, /raw\.slice\(-MAX_EVENTS\)/);
assert.match(activityProjection, /metadataOnly:true/);
assert.match(activityConsole, /this\.subscribe\?\.\(\(\)=>this\.#onFeedChange\(\)\)/);
assert.doesNotMatch(activityConsole, /getTelemetrySnapshot|getTelemetryActivitySnapshot|commitCanonicalNexusMutation/);

const retriever=read('retrieval/retriever.js');
const postturn=read('postturn/pipeline.js');
const paging=read('paging/lore-paging.js');
assert.doesNotMatch(retriever, /Promise\.allSettled\(groups\.map\(\(\[book\]\)=>loadBook\(book\)\)\)/);
assert.doesNotMatch(postturn, /Promise\.allSettled\(books\.map\(book=>loadBook\(book\)\)\)/);
assert.doesNotMatch(paging, /Promise\.allSettled\(\(books\|\|\[\]\)\.map\(book=>this\.host\.loadBook\(book\)\)\)/);

const journal=read('nexus/commit-journal.js');
assert.match(journal, /function sortedIdbMirrorKeys\(\)/);
assert.match(journal, /invalidateIdbMirrorKeyOrder\(\)/);
assert.match(journal, /key\(index\) \{ return sortedIdbMirrorKeys\(\)\[Number\(index\)\] \?\? null; \}/);



const diagnostics=read('src/ui-core/turn-log-diagnostics.js');
assert.match(diagnostics, /const DEFAULT_MAX_VISIBLE=96/);
assert.match(diagnostics, /boundedVisibleRows\(filtered,this\.maxVisibleRows\)/);
assert.match(diagnostics, /metadataOnly:true,rawPrompts:false,storyLoreBodies:false,credentials:false,hiddenReasoning:false,mutationAuthority:false/);
assert.doesNotMatch(diagnostics, /commitCanonicalNexusMutation|reserveResourcePriority|releaseResourcePriority/);

const resourceProjection=read('nexus-ui-bindings.js');
assert.match(resourceProjection, /export function projectNexusResourceStatus/);
assert.match(resourceProjection, /const running=Array\.isArray\(lane\?\.running\)\?lane\.running\.length:0/);
assert.doesNotMatch(resourceProjection, /\.enqueue\s*\(|reserveResourcePriority\s*\(|releaseResourcePriority\s*\(/);

const jobQueue=read('core/job-queue.js');
assert.match(jobQueue, /onChange\(fn\) \{ this\.listeners\.add\(fn\); return \(\) => this\.listeners\.delete\(fn\); \}/);
assert.match(jobQueue, /onSignal\(fn\) \{ this\.signalListeners\.add\(fn\); return \(\) => this\.signalListeners\.delete\(fn\); \}/);
assert.match(jobQueue, /for \(const fn of this\.signalListeners\) \{ try \{ fn\(job\); \} catch \{\} \}/);
assert.match(jobQueue, /for \(const fn of this\.listeners\) \{ try \{ fn\(job, this\.snapshot\(\)\); \} catch \{\} \}/);



const sampleChat=[
  {is_user:true,mes:'old user'},
  {is_system:true,mes:'system'},
  {is_user:false,mes:'old assistant'},
  {is_user:false,mes:'The request was rejected because it was considered high risk.'},
  {is_user:true,mes:'   '},
  {is_user:true,mes:'recent user'},
  {is_user:false,mes:'recent assistant'},
  {is_user:true,mes:'current user'},
];
for(const limit of [1,2,3,4,8,2.9,Infinity]){
  const normalized=Math.max(1,Number(limit)||8);
  const expected=sampleChat.filter(isNarrativeSceneMessage).slice(-normalized);
  assert.deepEqual(tailNarrativeSceneMessages(sampleChat,limit),expected,`bounded narrative tail must preserve legacy semantics for ${limit}`);
}

for(const path of ['paging/runtime.js','smart-context/warmer.js','retrieval/retriever.js','memory/recall.js']){
  const source=read(path);
  assert.match(source,/tailNarrativeSceneMessages/,`${path} must use bounded narrative tail`);
}
assert.doesNotMatch(read('paging/runtime.js'),/filter\(isNarrativeSceneMessage\)\.slice\(\s*-/);
assert.doesNotMatch(read('memory/recall.js'),/filter\(isNarrativeSceneMessage\)\.slice\(\s*-/);



const pagingRuntime=read('paging/runtime.js');
assert.match(pagingRuntime,/indexedIds=new Set\(\)/);
assert.match(pagingRuntime,/indexedIds=new Set\(Object\.keys\(store\.records\|\|\{\}\)\)/);
assert.match(pagingRuntime,/ids\.length!==indexedIds\.size\|\|ids\.some\(id=>!indexedIds\.has\(id\)\)/);
assert.doesNotMatch(pagingRuntime,/JSON\.stringify\(ids\)!==JSON\.stringify\(indexedIds\)/);



const memoryPagingSource=read('paging/runtime.js');
const lorePagingSource=read('paging/lore-paging.js');
for(const source of [memoryPagingSource,lorePagingSource]){
  assert.match(source,/function diagnosticQueryFingerprint/);
  assert.match(source,/queryFingerprint=query\?diagnosticQueryFingerprint\(query\):null/);
  assert.doesNotMatch(source,/await (?:digest|hash)\(query\)/);
}
assert.match(memoryPagingSource,/await digest\(semanticVersion\)/,'memory semantic version must keep SHA-256 authority');
assert.match(lorePagingSource,/await hash\(JSON\.stringify\(/,'lore semantic version must keep SHA-256 authority');



const activityTelemetry=read('observability/telemetry.js');
const activityProjectionSource=read('src/ui-core/activity-projection.js');
assert.match(activityTelemetry,/return metadataOnly \? snapshot : clone\(snapshot\)/);
assert.match(activityProjectionSource,/const raw=Array\.isArray\(telemetry\?\.events\)\?telemetry\.events:\[\]/);
assert.match(activityProjectionSource,/raw\.slice\(-MAX_EVENTS\)/);
assert.doesNotMatch(activityProjectionSource,/\.filter\([^\n]*acknowledgedThrough/);



const schedulerSource=read('lifecycle/scheduler.js');
const activityHostSource=read('nexus-ui-host.js');
assert.match(schedulerSource,/export function getSchedulerState\(\)\{return \{active:cycleView\(activeCycle\),activeCycles:\[\.\.\.activeCycles\.values\(\)\]\.map\(cycleView\),physicalLeases:getLifecyclePhysicalLeaseSnapshot\(\),last:cycleView\(lastCycle\)\};\}/,'full scheduler diagnostics contract must include logical cycles and physical leases');
assert.match(schedulerSource,/export function getSchedulerStatusSummary\(\)\{return \{active:activeCycles\.size>0,activeLogicalCycles:activeCycles\.size,physicalLeaseCount:getLifecyclePhysicalLeaseSnapshot\(\)\.length,lastStatus:String\(lastCycle\?\.status\|\|''\)\};\}/);
assert.doesNotMatch(activityHostSource,/getSchedulerState\(\)/);

const queueSource=read('core/job-queue.js');
assert.match(queueSource,/statusSummary\(\)/);
assert.match(queueSource,/return \{ queuedCount, lanes \};/);
assert.match(queueSource,/healthSnapshot\(\) \{/,'full queue health diagnostics contract must remain');
assert.match(activityHostSource,/queue:getJobQueue\(getSettings\(\)\.jobs\)\.healthSnapshot\(\)/);

const lazyFeedSource=read('src/ui-core/activity-console.js');
assert.match(lazyFeedSource,/const turns=\[\.\.\.\(snap\?\.turns\?\?\[\]\)\]\.sort\([^\n]*\)\.slice\(0,120\)/,'the story feed renders a bounded number of newest turns');
assert.match(lazyFeedSource,/\.slice\(0,120\)\.map\(row=>this\.#leafRow/,'memory and problem views are bounded too');
assert.match(lazyFeedSource,/this\.renderScope\.cleanup\(\)/);
assert.doesNotMatch(lazyFeedSource,/JSON\.stringify\([^\n]*evt/,'activity row rendering must not serialize event payloads eagerly');

console.log('PASS performance hot-path + authority safety contract');
