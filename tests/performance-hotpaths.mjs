import fs from 'node:fs';
import assert from 'node:assert/strict';

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

const feed = read('activity-feed.js');
assert.match(feed, /scheduleFeedRender/);
assert.match(feed, /requestAnimationFrame/);
assert.match(feed, /getTelemetryActivitySnapshot\(\{metadataOnly:true\}\)/);
assert.match(feed, /const snap=snapshot\|\|getTelemetryActivitySnapshot\(\)/);
assert.doesNotMatch(feed, /getTelemetrySnapshot/);
assert.doesNotMatch(feed, /retriever|prompt-loader|generation-frame|character-state-review|builder2|commitCanonicalNexusMutation/);

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



const diagnostics=read('observability/ui.js');
assert.match(telemetry, /export function getTelemetrySidecarSnapshot/);
assert.match(diagnostics, /getTelemetrySidecarSnapshot/);
assert.match(diagnostics, /scheduleDiagnosticsRender/);
assert.match(diagnostics, /coordinationSnapshotHtml\(snapshot\)/);
assert.doesNotMatch(diagnostics, /onTelemetryChange\(\(_record, next\)/);
assert.doesNotMatch(diagnostics, /retriever|prompt-loader-adapters|character-state-review|builder2\/pipeline|commitCanonicalNexusMutation/);



const sidecarStatus=read('observability/sidecar-status.js');
assert.match(sidecarStatus, /getTelemetrySidecarSnapshot/);
assert.doesNotMatch(sidecarStatus, /getTelemetrySnapshot/);
assert.match(sidecarStatus, /scheduleRender/);
assert.match(sidecarStatus, /requestAnimationFrame/);
assert.match(sidecarStatus, /queue\.onSignal\?\.\(scheduleRender\)\|\|queue\.onChange\(scheduleRender\)/);
assert.doesNotMatch(sidecarStatus, /\.enqueue\s*\(|\benqueue\s*\(|\bdispatch[A-Za-z0-9_]*\s*\(|\bcancel\s*\(|reserveResourcePriority\s*\(|releaseResourcePriority\s*\(/);

const jobQueue=read('core/job-queue.js');
assert.match(jobQueue, /onChange\(fn\) \{ this\.listeners\.add\(fn\); return \(\) => this\.listeners\.delete\(fn\); \}/);
assert.match(jobQueue, /onSignal\(fn\) \{ this\.signalListeners\.add\(fn\); return \(\) => this\.signalListeners\.delete\(fn\); \}/);
assert.match(jobQueue, /for \(const fn of this\.signalListeners\) \{ try \{ fn\(job\); \} catch \{\} \}/);
assert.match(jobQueue, /for \(const fn of this\.listeners\) \{ try \{ fn\(job, this\.snapshot\(\)\); \} catch \{\} \}/);

console.log('PASS performance hot-path + authority safety contract');
