import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const style = read('style.css');
assert.doesNotMatch(style, /@import[^\n]+tests\/harness\//, 'production style.css must not import test harness CSS');
assert.match(style, /@import url\("\.\/ui\/tokens\.css"\)/);
assert.match(style, /@import url\("\.\/ui\/nexus-ui\.css"\)/);
assert.match(style, /\.tv2-memory-bank-panel\{width:min\(1380px,98vw\)/, 'Memory Bank may widen instead of sacrificing either rail');

const launcher = read('tests/harness/test-mode-launcher.js');
for (const path of [
    './test-mode-launcher.css',
    './character-banks/character-bank-launcher.css',
    './change-gate/change-gate-launcher.css',
    './world-loads/world-load-launcher.css',
]) assert.ok(launcher.includes("new URL('" + path + "', import.meta.url).href"), "missing lazy harness style: " + path);
assert.match(launcher, /ensureHarnessStyle\('launcher'\)/);
assert.match(launcher, /ensureHarnessStyle\('characterBanks'\)/);
assert.match(launcher, /ensureHarnessStyle\('changeGate'\)/);
assert.match(launcher, /ensureHarnessStyle\('worldLoads'\)/);

const memory = read('memory/ui.js');
assert.doesNotMatch(memory, /CHARACTER_PROFILE_FIELDS/, 'non-policy Character Details must not be rendered in Character State');
assert.doesNotMatch(memory, /const CHARACTER_DETAIL_FIELDS=\[/, 'nineteen-field Character State form must not return');
assert.doesNotMatch(memory, /\['review','State Review'\]/, 'review must stay in the right rail, not become a center tab');
assert.match(memory, /\['state','State'\]/);
assert.match(memory, /return nxRail\(\{title:'Character State Review'/);
assert.match(memory, /className:'nx-character-review-rail'/);
assert.match(memory, /right:right\?\[right\]:\[\]/);
assert.match(memory, /node\.dataset\.characterPolicyPanel=domain/);
assert.match(memory, /open\.dataset\.characterPolicyLink=group\.domain/);
assert.match(memory, /data-character-policy-link/);
assert.match(memory, /className:'nx-character-policy-grid'/);
assert.match(memory, /const tracking=\{\.\.\.\(current\.tracking\|\|\{\}\)\}/, 'tab transitions must preserve tracking policy state');

const contract = read('memory/character-state-contract.js');
for (const exact of [
    "personality: Object.freeze({ label: 'Personality'",
    "relationships: Object.freeze({ label: 'Relationships'",
    "status: Object.freeze({ label: 'Status / conditions / equipment'",
    "goals: Object.freeze({ label: 'Goals / unresolved threads'",
    "behavior: Object.freeze({ label: 'Behavior changes'",
]) assert.ok(contract.includes(exact), 'missing Character Tracking Policy: ' + exact);
const policyBlock = contract.match(/export const CHARACTER_TRACKING_POLICY = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] || '';
assert.equal((policyBlock.match(/Object\.freeze\(\{ label:/g) || []).length, 5, 'Character Tracking Policy must remain exactly five areas');

const css = read('ui/nexus-ui.css');
assert.match(css, /grid-template-columns:minmax\(190px,230px\) minmax\(380px,1fr\) minmax\(340px,430px\)/);
assert.match(css, /\.nx-character-review-rail\{min-width:0;container-type:inline-size;position:sticky/);
assert.match(css, /\.nx-character-policy-grid\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
assert.doesNotMatch(css, /\.nx-character-review-workspace/);

const inventory = read('docs/UI_CSS_SELECTOR_INVENTORY_TASK208.md');
assert.match(inventory, /LIVE \/ COMPATIBILITY/);
assert.match(inventory, /TEST\/DEVELOPER ONLY/);
assert.match(inventory, /No additional `tv2-\*` family is deleted/);

console.log('PASS tasks #208/#211 production CSS + Character workspace contract');
