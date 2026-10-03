// No job is pinned to a Sidecar. Saved routing locks are dropped, the router never honours one,
// and the scheduler sends background upkeep to B and the turn in progress to A.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root=new URL('../',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,root),'utf8');

async function loadSettings(saved){
  const url=new URL('core/settings.js',root);
  const stored={tv2:saved};
  globalThis.settingsPinFixture={extension_settings:stored,getRequestHeaders:()=>({}),saveSettings:()=>{},saveSettingsDebounced:()=>{},DEFAULT_VECTOR_PAGING:{},migrateLorebookBuilderSettings:()=>false};
  const source=read('core/settings.js').replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)';/g,(_,names)=>`const {${names.replace(/\bas\b/g,':')}}=globalThis.settingsPinFixture;`)+`\n// ${Math.random()}`;
  const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  return{module,stored};
}

test('saved routing locks are dropped when settings load, so nothing can be pinned',async()=>{
  const{module,stored}=await loadSettings({routing:{maintenance:'A',locks:{maintenance:'A',retrieval:'B',loreInjection:'A'}}});
  const settings=module.getSettings();
  assert.equal(Object.hasOwn(settings.routing,'locks'),false,'locks are removed from the live settings');
  assert.equal(Object.hasOwn(stored.tv2.routing,'locks'),false,'and from what is saved');
  assert.equal(settings.routing.maintenance,'A','the preferred slot setting is untouched: only the pin is removed');
  const fresh=(await loadSettings({})).module.getSettings();
  assert.equal(Object.hasOwn(fresh.routing,'locks'),false,'new installs have no locks either');
  assert.equal(fresh.routing.maintenance,'B','background upkeep defaults to Sidecar B');
  assert.equal(fresh.routing.retrieval,'A','retrieval for the turn defaults to Sidecar A');
});

test('the router never honours a lock and no code path reads one for routing',()=>{
  const router=read('sidecar/router.js');
  assert.match(router,/lockedSlot\(_role\)\s*\{\s*return null;\s*\}/);
  assert.doesNotMatch(router,/settings\.routing\?\.locks/);
  assert.doesNotMatch(read('core/settings.js'),/locks:\s*\{/,'no default lock table');
});

test('the scheduler sends background upkeep to B and the turn in progress to A',()=>{
  const scheduler=read('scheduler/sidecars.js');
  assert.match(scheduler,/request\.lane==='background'\?\(this\.background\.state==='BACKGROUND'\?\['B'\]:\[\]\):request\.lane==='foreground'\?\['A','B'\]:\['B','A'\]/);
});
