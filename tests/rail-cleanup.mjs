// Part 3 Task 1: Memory and Lore left the rail. The World Tree workspace holds what they did,
// and old links and saved tab state open it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WorkspaceRegistry } from '../src/ui-core/registry.js';
import { RETIRED_RAIL_WORKSPACES, registerWave6FrontFaceWorkspaces } from '../src/ui-core/wave6-front-face.js';

const read=file=>fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
const adapter={getSnapshot:()=>({}),getDetailLevel:()=>'NORMAL'};
const railEntries=registry=>registry.list({navigationLevel:'product'}).sort((a,b)=>(a.navigation?.order??0)-(b.navigation?.order??0));

function assembled(){
  const registry=new WorkspaceRegistry();
  registerWave6FrontFaceWorkspaces(registry,{adapter});
  return registry;
}

test('the rail has World Tree and World, and no Memory or Lore item',()=>{
  const registry=assembled();
  const titles=railEntries(registry).map(entry=>entry.title);
  assert.ok(titles.includes('World Tree'),titles.join(','));
  assert.ok(titles.includes('World'));
  assert.ok(!titles.includes('Memory'),'Memory must not be a rail item');
  assert.ok(!titles.includes('Lore'),'Lore must not be a rail item');
  for(const retired of Object.keys(RETIRED_RAIL_WORKSPACES))assert.equal(registry.has(retired),false,`${retired} is still registered`);
});

test('old links and saved tab state resolve to the World Tree',()=>{
  const registry=assembled();
  for(const retired of ['lore','memory-product','memory'])assert.equal(registry.resolve(retired),'world-tree',retired);
  assert.equal(registry.resolve('world-tree'),'world-tree');
  assert.equal(registry.resolve('brain'),'brain','a live id is never rewritten');
  assert.equal(registry.resolve('nonexistent'),'nonexistent','an unknown id is left for the caller to reject');
  assert.ok(registry.has(registry.resolve('lore')));
});

test('an alias cannot shadow a registered workspace or loop',()=>{
  const registry=new WorkspaceRegistry();
  registry.register({id:'a',title:'A'});
  assert.throws(()=>registry.alias('a','b'),/still registered/);
  assert.throws(()=>registry.alias('x','x'));
  registry.alias('p','q');registry.alias('q','p');
  assert.ok(['p','q'].includes(registry.resolve('p')),'a cycle must terminate');
});

test('the shell resolves aliases for saved state and for selection',()=>{
  const shell=read('src/ui-core/shell.js');
  assert.match(shell,/workspaceRegistry\.resolve\?\.\(persisted\.selectedWorkspace\)/);
  assert.match(shell,/selectWorkspace\(requestedId\)\s*\{\s*const id = this\.workspaceRegistry\.resolve\?\.\(requestedId\)/);
});

test('every old Memory and Lore control is still reachable from the World Tree workspace',()=>{
  const surfaces=read('src/ui-core/wave13-operator-surfaces.js');
  const worldTree=surfaces.slice(surfaces.indexOf("registry.has('world-tree')"),surfaces.indexOf("registry.has('world-tree')")+900);
  assert.match(worldTree,/renderLoreStudySurface\(/,'Lore controls');
  assert.match(worldTree,/renderMemoryOwnerSurface\(body,\{\.\.\.ctx,memory\}\)/,'Memory overview and Character State review');
  assert.doesNotMatch(surfaces,/\['memory-product','memory'\]/,'the old Memory override must not remain');
  const labels=[
    'Review Recent Chat','Review Summary','Approve','Reject','Tracking Policy',
    'Attach Lorebook to this story','Create Lorebook',"'Run '+accepted+' due stud'",
  ];
  const uiSource=fs.readdirSync(new URL('../src/ui-core',import.meta.url)).filter(file=>file.endsWith('.js')).map(file=>read(`src/ui-core/${file}`)).join('\n');
  for(const label of labels)assert.ok(uiSource.includes(label),`control "${label}" is unreachable`);
});

test('proposal links and workspace refresh target the World Tree',()=>{
  const runtime=read('src/ui-core/wave6-runtime.js');
  assert.match(runtime,/selectWorkspace\('world-tree'\)|'world-tree'/);
  assert.doesNotMatch(runtime,/selectWorkspace\('(lore|memory-product)'\)/);
  assert.match(runtime,/currentWorkspace==='world-tree'/);
});
