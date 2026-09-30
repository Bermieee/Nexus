import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=rel=>fs.readFileSync(path.join(repo,rel),'utf8');
const exists=rel=>fs.existsSync(path.join(repo,rel));

function walk(dir){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test('Nexus mounts UI.Core instead of the legacy settings UI',()=>{
  const index=read('index.js');
  assert.match(index,/from '\.\/nexus-ui-host\.js'/);
  for(const marker of [
    "from './ui.js'",
    'standalone-ui.js',
    'windowing.js',
    'renderExtensionTemplateAsync',
    'bindUI',
    'mountNexusSettingsRoot',
    'resetMemoryBankUiState',
    'initActivityFeed',
  ]) assert.equal(index.includes(marker),false,marker);
});

test('legacy Nexus UI artifacts stay removed',()=>{
  for(const rel of ['settings.html','standalone-ui.js','ui.js','theme.js','windowing.js']){
    assert.equal(exists(rel),false,rel);
  }
  assert.equal(exists('ui'),false,'legacy ui/ component package');
  for(const rel of [
    'activity-feed.js','memory/ui.js','observability/ui.js','paging/ui.js','proposals/ui.js',
    'smart-context/ui.js','testing/ui.js','tree/ui.js','decision/settings-ui.js','retrieval/settings-ui.js',
    'builder/ui.js','builder/quality-ui.js','builder/builder2-operator-ui.js','tree/ui-core-adapter.js',
  ]) assert.equal(exists(rel),false,rel);
});

test('all UI.Core relative JS imports resolve inside the transplanted package',()=>{
  const root=path.join(repo,'src','ui-core');
  const files=walk(root).filter(file=>file.endsWith('.js'));
  assert.ok(files.length>=60,'expected complete UI.Core transplant');
  for(const file of files){
    const source=fs.readFileSync(file,'utf8');
    for(const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)){
      const spec=match[1];
      if(!spec.startsWith('.'))continue;
      const target=path.resolve(path.dirname(file),spec);
      const candidates=[target,target+'.js',path.join(target,'index.js')];
      assert.ok(candidates.some(existsAbsolute=>fs.existsSync(existsAbsolute)),
        path.relative(repo,file)+' -> '+spec);
    }
  }
});


test('production source has no imports of removed Nexus UI and no unresolved in-repo relative imports',()=>{
  const roots=[
    ...fs.readdirSync(repo,{withFileTypes:true})
      .filter(entry=>entry.isFile()&&entry.name.endsWith('.js'))
      .map(entry=>path.join(repo,entry.name)),
    ...['builder','builder2','character-cards','core','decision','lifecycle','lore','maintenance','memory','nexus','observability','paging','postturn','proposals','retrieval','scene','sidecar','smart-context','tools','tree','src']
      .filter(exists)
      .flatMap(rel=>walk(path.join(repo,rel)).filter(file=>file.endsWith('.js'))),
  ];
  const removedMarkers=[
    '/standalone-ui.js','/windowing.js','/theme.js','/activity-feed.js',
    '/memory/ui.js','/observability/ui.js','/paging/ui.js','/proposals/ui.js',
    '/smart-context/ui.js','/testing/ui.js','/tree/ui.js','/decision/settings-ui.js',
    '/retrieval/settings-ui.js','/builder/ui.js','/builder/quality-ui.js',
    '/builder/builder2-operator-ui.js','/tree/ui-core-adapter.js','/ui/',
  ];
  for(const file of roots){
    const source=fs.readFileSync(file,'utf8');
    const specs=[
      ...source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map(match=>match[1]);
    for(const spec of specs){
      if(!spec.startsWith('.'))continue;
      const normalized='/'+path.normalize(spec).replaceAll('\\','/');
      for(const marker of removedMarkers){
        assert.equal(normalized.includes(marker),false,path.relative(repo,file)+' imports removed UI '+spec);
      }
      const target=path.resolve(path.dirname(file),spec);
      if(target!==repo&&!target.startsWith(repo+path.sep))continue;
      const candidates=[target,target+'.js',target+'.mjs',path.join(target,'index.js'),path.join(target,'index.mjs')];
      assert.ok(candidates.some(candidate=>fs.existsSync(candidate)),
        path.relative(repo,file)+' -> '+spec);
    }
  }
});

test('Nexus stylesheet imports resolve',()=>{
  const css=read('style.css');
  const imports=[...css.matchAll(/@import\s+url\(["']?([^"')]+)["']?\)/g)].map(m=>m[1]);
  assert.ok(imports.length>=8,'expected Area 52 UI stylesheet stack');
  for(const spec of imports){
    if(!spec.startsWith('.'))continue;
    assert.ok(exists(spec.replace(/^\.\//,'')),spec);
  }
});

test('transplanted product-facing UI is branded Nexus',()=>{
  const roots=[path.join(repo,'src','ui-core'),path.join(repo,'styles')];
  const files=roots.flatMap(walk).filter(file=>/\.(?:js|css)$/.test(file));
  for(const file of files){
    const source=fs.readFileSync(file,'utf8');
    for(const oldName of ['Area-52','Area 52','AREA-52','AREA 52']){
      assert.equal(source.includes(oldName),false,path.relative(repo,file)+' contains '+oldName);
    }
  }
  assert.match(read('nexus-ui-host.js'),/productName:'Nexus'/);
});
