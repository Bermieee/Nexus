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
    'builder/ui.js','builder/quality-ui.js','builder/builder2-operator-ui.js','tree/ui-core-adapter.js','testing/test-mode-adapter.js','observability/sidecar-status.js',
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
    ...['builder','builder2','character-cards','core','decision','lifecycle','lore','maintenance','memory','nexus','observability','paging','postturn','proposals','retrieval','scene','sidecar','smart-context','testing','tools','tree','src']
      .filter(exists)
      .flatMap(rel=>walk(path.join(repo,rel)).filter(file=>file.endsWith('.js'))),
  ];
  const removedMarkers=[
    '/standalone-ui.js','/windowing.js','/theme.js','/activity-feed.js',
    '/memory/ui.js','/observability/ui.js','/paging/ui.js','/proposals/ui.js',
    '/smart-context/ui.js','/testing/ui.js','/tree/ui.js','/decision/settings-ui.js',
    '/retrieval/settings-ui.js','/builder/ui.js','/builder/quality-ui.js',
    '/builder/builder2-operator-ui.js','/tree/ui-core-adapter.js','/testing/test-mode-adapter.js',
    '/observability/sidecar-status.js','/maintenance/housekeeper-diagnostics.js','/ui/',
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
  assert.ok(imports.length>=8,'expected Nexus UI.Core stylesheet stack');
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

test('master activation is owned by the host extension manager',()=>{
  const source=read('core/settings.js');
  assert.match(source,/enabled:\s*true,/);
  assert.match(source,/settings\.enabled !== true/);
  assert.match(source,/SillyTavern's extension manager/);
});

test('read-only Nexus owner seams stay limited to direct runtime, Scene, resource, Character Card, Diagnostics, and World Tree reads',()=>{
  const source=read('nexus-ui-host.js');
  assert.match(source,/createNexusUiHostBindings/);
  assert.match(source,/readRuntimeDiagnostic/);
  assert.match(source,/snapshotMainBridgeStatus/);
  assert.match(source,/getSceneScannerSnapshot/);
  assert.match(source,/readSceneSnapshot/);
  assert.match(source,/readCharacterCards/);
  assert.match(source,/readCharacterCardMetadata/);
  const bindings=read('nexus-ui-bindings.js');
  assert.match(bindings,/readDiagnosticsTelemetry/);
  assert.match(source,/readNexusWorldTreeUiModel/);
  assert.equal(source.includes('hostBindings:{}'),false);
  const index=read('index.js');
  assert.match(index,/mountNexusUi\(\{ getContext, runtime: nexusRuntime \}\)/);
});


test('bootstrap installs the extension rendering policy before Nexus activation',()=>{
  const source=read('bootstrap.js');
  const dynamicImport='import';
  const policyIndex=source.indexOf(dynamicImport+"('./core/rendering-policy.js')");
  const nexusIndex=source.indexOf(dynamicImport+"('./index.js')");
  assert.ok(policyIndex>=0,'rendering policy import missing');
  assert.ok(nexusIndex>policyIndex,'Nexus index must load after rendering policy');
});

test('World Tree and Diagnostics are first-class Nexus UI owners',()=>{
  const host=read('nexus-ui-host.js');
  assert.match(host,/readNexusWorldTreeUiModel/);
  assert.match(host,/getTelemetrySnapshot/);
  assert.match(host,/getDecisionTelemetrySnapshot/);
  assert.match(host,/getRetrievalDiagnosticsSnapshot/);
  assert.match(host,/getGenerationFrameDiagnostics/);
  const surfaces=read('src/ui-core/wave13-operator-surfaces.js');
  assert.match(surfaces,/Central Nexus telemetry/);
  assert.match(surfaces,/Probe \/ health evidence/);
});




test('Connections distinguishes configuration, lock persistence, and verified readiness',()=>{
  const surfaces=read('src/ui-core/wave13-operator-surfaces.js');
  const resources=read('nexus/resource-connections.js');
  const sidecarA=surfaces.indexOf("id:'SIDECAR_A'");
  const sidecarB=surfaces.indexOf("id:'SIDECAR_B'");
  const jev=surfaces.indexOf("id:'JEV'");
  const vector=surfaces.indexOf("id:'VECTORING'");
  assert.ok(sidecarA>=0&&sidecarB>sidecarA&&jev>sidecarB&&vector>jev,'Connections grid order must be Sidecar A, Sidecar B, Jev, Vectoring');
  assert.match(surfaces,/if\(configured&&savedProfile\)/,'configured resources must only render locked when a saved lock exists');
  assert.match(surfaces,/configured\?'CONFIGURED':'OPEN'/,'released configured resources must render as editable CONFIGURED, not LOCKED');
  assert.match(resources,/JEV_UNVERIFIED/);
  assert.match(resources,/SIDECAR_UNVERIFIED/);
  assert.match(resources,/VECTORING_UNVERIFIED/);
  assert.match(resources,/connected:verified,callable:verified/,'READY/callable state must require successful verification');
});
test('Connections keeps the four Nexus execution connectors distinct',()=>{
  const shell=read('src/ui-core/shell.js');
  const surfaces=read('src/ui-core/wave13-operator-surfaces.js');
  const adapters=read('src/ui-core/wave13-operator-adapters.js');
  const host=read('nexus-ui-host.js');
  const decisions=read('decision/index.js');
  const vectorRuntime=read('paging/runtime.js');

  assert.equal(shell.includes('Brain State'),false,'retired Brain State must not return to the Nexus shell');
  for(const marker of ["id:'JEV'","id:'SIDECAR_A'","id:'SIDECAR_B'","id:'VECTORING'"]){
    assert.ok(surfaces.includes(marker),'missing fixed Connections slot '+marker);
  }
  assert.match(adapters,/SIDECAR_A/);
  assert.match(adapters,/SIDECAR_B/);
  assert.match(host,/resource-connections\.js/,'Nexus host must export the unified connection actions');
  assert.match(decisions,/\.\.\/nexus\/jev-connector\.js/,'legacy decision sites must resolve external semantic execution through the Jev connector');
  assert.match(vectorRuntime,/connection\?\.connected===false/,'Vectoring disconnect must stop embedding work');
});


test('Connections stays connector-focused after successful provider tests',()=>{
  const surfaces=read('src/ui-core/wave13-operator-surfaces.js');
  const connectionsStart=surfaces.indexOf("if(!registry.has('connections'))registry.register({");
  const settingsStart=surfaces.indexOf("if(!registry.has('settings'))registry.register({",connectionsStart);
  const connectionsBlock=surfaces.slice(connectionsStart,settingsStart);
  assert.equal(connectionsBlock.includes('renderFanoutGatherSurface'),false,'Connections must not append Fan-out / Gather runtime telemetry');
  assert.equal(connectionsBlock.includes('fan-out and Gather'),false,'Connections header copy must stay connection-focused');
  assert.equal(surfaces.includes("message(d,'Needs qualification'"),false,'READY connector cards must not show legacy qualification warnings');
  assert.equal(surfaces.includes("compactFact(d,'Qualification'"),false,'Connections summary must not expose legacy qualification state');
});
