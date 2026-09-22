import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const html = read('settings.html');
assert.match(html, /id="tv2_nexus_call_center_main_access"/);
assert.doesNotMatch(html, /id="tv2_nexus_main_worker_enabled"/);
assert.match(html, /Master Main switch for Nexus/);
assert.match(html, /id="tv2_nexus_call_center_status"/);

const ui = read('ui.js');
assert.doesNotMatch(ui, /tv2_nexus_main_worker_enabled/);
assert.doesNotMatch(ui, /tv2_nexus_call_center_test(?:_capability|_approval)?(?![A-Za-z0-9_])/);
assert.doesNotMatch(ui, /tv2_lorebook_list|tv2_lorebook_filter|renderLorebookList/);
assert.doesNotMatch(ui, /tv2_open_uid_summarizer|tv2_open_tree/);
assert.doesNotMatch(ui, /renderLogLauncher|createCallCenterTestHarness/);
assert.match(ui, /desiredMainAccess=\$id\('tv2_nexus_call_center_main_access'\)/);
assert.match(ui, /modelWorker:\{\.\.\.\(s\.nexus\?\.modelWorker\|\|\{\}\),useMain:desiredMainAccess\}/);

const settings = read('core/settings.js');
assert.match(settings, /canonicalMainAccess = settings\.nexus\.callCenter\.mainModelAccess === true/);
assert.match(settings, /settings\.nexus\.modelWorker\.useMain = canonicalMainAccess/);

const workerBus = read('nexus/model-worker-bus.js');
assert.match(workerBus, /s\.nexus\?\.callCenter\?\.mainModelAccess===true/);
assert.doesNotMatch(workerBus, /s\.nexus\?\.modelWorker\?\.useMain===true/);

const runtime = read('core/runtime.js');
assert.match(runtime, /live\.nexus\?\.callCenter\?\.mainModelAccess === true/);

const bridge = read('nexus/main-bridge-status.js');
assert.match(bridge, /const workerRequested = boundaryAllowed/);

const css = read('style.css');
assert.match(css, /--tv2-z-control:59500/);
assert.match(css, /#tv2_nexus_standalone_shell\s*\{[\s\S]*?z-index:var\(--tv2-z-control\)/);
assert.doesNotMatch(css, /z-index:10040/);
assert.doesNotMatch(css, /width:15px!important;\s*height:15px!important;\s*min-width:15px!important;\s*min-height:15px!important;/);
assert.equal((css.match(/\.tv2-provider-cap\{display:none\}/g) || []).length, 1);

const observability = read('observability/ui.js');
assert.doesNotMatch(observability, /renderLogLauncher|tv2_log_launcher_status|tv2_recent_log_count|tv2_recent_log_preview/);
assert.match(ui, /tv2-window-head/);
assert.match(ui, /tv2-window-head-title/);
assert.match(ui, /tv2-window-head-meta/);
const treeUi = read('tree/ui.js');
assert.match(treeUi, /tv2-tree-uid-summarize/);
assert.match(treeUi, /openUidSummarizer/);

const retiredCssClasses = ["tv2-top-actions","tv2-sidecar-telemetry","tv2-log-launcher","tv2-log-launcher-title","tv2-log-launcher-status","tv2-log-dropdown","tv2-recent-log-preview","tv2-recent-log-row","tv2-shell","tv2-topbar","tv2-master-toggle","tv2-runtime-switches","tv2-small-button","tv2-tree-spacer","tv2-workspace-panel","tv2-tree-toolbar","tv2-tree-workarea","tv2-tree-browser","tv2-tree-browser-head","tv2-tree-node-list","tv2-tree-node-button","tv2-tree-editor","tv2-tree-edit-head","tv2-tree-move-row","tv2-tree-danger","tv2-empty-state","tv2-smart-pass-summary","tv2-settings-button","tv2-summary-hint","tv2-full-label","tv2-global-settings-overlay","tv2-global-settings-panel","tv2-status-launcher","tv2-launcher-badge","tv2-brand-header","tv2-brand-icon","tv2-brand-copy","tv2-brand-badge","tv2-tree-import-menu","tv2-tree-import-pop","tv2-tree-entry-card","tv2-tree-entry-title","tv2-tree-child-title","tv2-lorebook-filter","tv2-lorebook-list","tv2-lorebook-card","tv2-lorebook-dot","tv2-lorebook-card-info","tv2-lorebook-card-meta","tv2-empty-book-list","tv2-memory-group","tv2-memory-group-head","tv2-memory-card","tv2-memory-card-title","tv2-memory-card-path","tv2-memory-card-meta","tv2-memory-card-badges","tv2-memory-badge-pin","tv2-memory-badge-warm","tv2-memory-badge-manual","tv2-memory-badge-earned","tv2-memory-dev","tv2-unpin","tv2-memory-stats","tv2-memory-toolbar","tv2-story-scope-box","tv2-story-scope-head","tv2-story-scope-actions","tv2-telemetry-section"];
for (const legacyClass of retiredCssClasses) {
    assert.ok(!new RegExp('\\.' + legacyClass + '(?![A-Za-z0-9_-])').test(css), `retired CSS class remains: ${legacyClass}`);
}
assert.doesNotMatch(css, /z-index\s*:\s*10000/);
assert.doesNotMatch(css, /\.tv2-uid-summarizer-overlay\{\s*\}|\.tv2-lore-editor-overlay\{\s*\}/);
assert.match(css, /\.tv2-window-head\{/);
assert.match(css, /\.tv2-window-head-meta\{/);

console.log('PASS task #197 UI authority + stale CSS regression');
