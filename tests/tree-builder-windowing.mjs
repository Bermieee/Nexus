import assert from 'node:assert/strict';
import fs from 'node:fs';

const tree=fs.readFileSync(new URL('../tree/ui.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../style.css',import.meta.url),'utf8');

assert.match(tree,/class="tv2-tree-classic-btn tv2-tree-minimize"/);
assert.match(tree,/function setTreeWorkspaceMinimized\(minimized\)/);
assert.match(tree,/tv2-tree-overlay-minimized/);
assert.match(tree,/minimizeTree\?\.addEventListener\('click'/);

const minimizeStart=tree.indexOf('function setTreeWorkspaceMinimized');
const minimizeEnd=tree.indexOf('\n    let builderBusyTimer',minimizeStart);
const minimizeBody=tree.slice(minimizeStart,minimizeEnd);
assert.doesNotMatch(minimizeBody,/cancelBuilderReview|cancelDurably|builderLaunchAbort\.abort|abortNexusTransaction/,
  'Tree minimize must never touch Builder execution/cancellation authority');

const closeStart=tree.indexOf('const closeTree=async');
const closeEnd=tree.indexOf("overlay.querySelector('.tv2-close-tree')",closeStart);
assert.match(tree.slice(closeStart,closeEnd),/cancelBuilderReview\('tree-window-closed'/,
  'Close remains the explicit Builder cancel/close path');

assert.match(css,/\.tv2-tree-overlay\.tv2-tree-overlay-minimized\{[\s\S]*pointer-events:none!important/);
assert.match(css,/\.tv2-tree-overlay\.tv2-tree-overlay-minimized \.tv2-tree-classic-panel\{[\s\S]*pointer-events:auto!important/);
assert.match(css,/background:transparent!important/);
assert.match(css,/\.tv2-tree-classic-body,[\s\S]*\.tv2-builder-quality-report\{[\s\S]*display:none!important/);

console.log('Tree Builder non-blocking minimize contract: PASS');
