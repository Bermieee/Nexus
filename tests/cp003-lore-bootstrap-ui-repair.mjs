import fs from 'node:fs';
import assert from 'node:assert/strict';
import { builder2LaunchControlsHtml, readBuilder2LaunchOptions } from '../builder/builder2-operator-ui.js';
import { createTree, validateCanonicalTreeIdentity } from '../tree/model.js';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const css = read('style.css');
assert.match(css, /#tv2_nexus_standalone_shell\s*\{/);
assert.match(css, /--tv2-z-control:59500/);
assert.match(css, /z-index:var\(--tv2-z-control\)/);
assert.match(css, /\.tv2-window-resize-grip/);
assert.match(css, /data-tv2-collapsed="true"/);
assert.match(css, /\.tv2-memory-digest-controls/);

const router = read('memory/lore-router.js');
assert.match(router, /getActiveBooks\(\{requireTree:false,access:'write'\}\)/);
assert.match(router, /treelessWritableBooks/);
assert.match(router, /Tree-less book, create durable lore as a new remember operation with node_id:null|Tree-less lorebook .* accepts only new UID proposals/);
assert.match(router, /writableTreeBooks/);

const engine = read('nexus/mutation-engine.js');
const createStart = engine.indexOf('case OP.ENTRY_CREATE:');
const createEnd = engine.indexOf('case OP.ENTRY_UPDATE:', createStart);
assert.ok(createStart >= 0 && createEnd > createStart);
const createBlock = engine.slice(createStart, createEnd);
assert.ok(createBlock.includes('tree = getTree(book) || tree;'));
assert.ok(createBlock.includes('if (tree) {'));
assert.ok(createBlock.includes('assignEntry(tree, createdUid, op.targetNodeId || null);'));
assert.ok(createBlock.includes('no Nexus Tree exists yet'));
assert.ok(!createBlock.includes('getTree(book) || requireTree()'), 'ENTRY_CREATE must not manufacture a Tree');

const html = builder2LaunchControlsHtml({ requestedMode: 'blank' });
assert.match(html, /value="blank" selected>Blank Tree \(Root only\)<\/option>/);
const fakeRoot = { querySelector(sel) {
    if (sel === '.tv2-b2-launch-mode') return { value: 'blank' };
    if (sel === '.tv2-b2-launch-validate-only') return { checked: false };
    return null;
}};
assert.deepEqual(readBuilder2LaunchOptions(fakeRoot), { requestedMode: 'blank', validateOnly: false });

const blank = createTree('Bootstrap Test');
const identity = validateCanonicalTreeIdentity(blank);
assert.equal(blank.root.label, 'Root');
assert.deepEqual(blank.root.entryUids, []);
assert.deepEqual(blank.root.children, []);
assert.equal(identity.nodeCount, 1);
assert.equal(identity.uidCount, 0);

const treeUi = read('tree/ui.js');
assert.match(treeUi, /launch\.requestedMode==='blank'/);
assert.match(treeUi, /if\(getTree\(book\)\)/);
assert.match(treeUi, /const blankTree=createTree\(book\)/);
assert.match(treeUi, /proposeTreeReplace\(book,blankTree/);
assert.match(treeUi, /assignedUidCount:0/);
assert.match(treeUi, /Existing Trees are never overwritten/);
assert.match(treeUi, /Existing lore UIDs remain unassigned until you place them/);

console.log('PASS CP003 lore bootstrap + blank Tree + standalone UI regression');
