import fs from 'node:fs';
import assert from 'node:assert/strict';

const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
const housekeeper=read('maintenance/housekeeper.js');
const merge=read('tools/merge.js');
const treeStore=read('tree/store.js');
const memoryStore=read('memory/store.js');
const indexSource=read('index.js');

assert.match(housekeeper,/currentMemoryBankRevision/);
assert.match(housekeeper,/function housekeeperSourceSignature/);
assert.match(housekeeper,/loreTreeRevision:currentNexusLoreSourceRevision\(books\)/);
assert.match(housekeeper,/memoryRevision:currentMemoryBankRevision\(\)/);
assert.match(housekeeper,/audit:housekeeperAuditConfig\(settings\)/);

assert.match(housekeeper,/requireTree:false/);
assert.match(housekeeper,/\.filter\(book=>hasTree\(book\)\)/);

const reuseGate=housekeeper.indexOf("housekeeper-early-reuse-hit");
const memoryScan=housekeeper.indexOf("report.canonicalReadCounts.memory+=1");
assert.ok(reuseGate>=0&&memoryScan>=0&&reuseGate<memoryScan,'canonical reuse gate must run before Memory/semantic scan work');
assert.match(housekeeper,/if \(!force && lastReport\?\.successful === true && lastReport\?\.sourceSignature === sourceSignature/);
assert.doesNotMatch(housekeeper,/lastReport\?\.findingFingerprint === report\.findingFingerprint/);
assert.doesNotMatch(housekeeper,/refreshHousekeeperFindingFreshness\(report\.findings\)/);

assert.match(housekeeper,/scanBook\(book,settings,\{sourceData:data,sourceTree:tree\}\)/);
assert.match(housekeeper,/scanMergeCandidates\(book, \{[^}]*sourceData: data, sourceTree: tree/s);
assert.match(merge,/sourceData===undefined\?await loadBook\(book\):sourceData/);
assert.match(merge,/sourceTree===undefined\?getTree\(book\):sourceTree/);

assert.match(treeStore,/bumpNexusLoreSourceRevision\(\{book,reason:`tree-saved:\$\{mutationKind\}`\}\)/);
assert.match(treeStore,/bumpNexusLoreSourceRevision\(\{book,reason:'tree-deleted'\}\)/);
assert.match(memoryStore,/export function currentMemoryBankRevision\(\)/);
assert.match(memoryStore,/evidenceRevision/);
assert.match(indexSource,/bumpNexusLoreSourceRevision\(\{reason:name\.toLowerCase\(\),broad:true\}\)/);

assert.match(housekeeper,/canonicalReadCounts:\{lore:0,tree:0,memory:0\}/);
assert.match(housekeeper,/housekeeper-early-reuse-miss/);
assert.match(housekeeper,/source-changed-during-housekeeper-review/);

console.log('PASS #201 canonical Housekeeper reuse contract');
