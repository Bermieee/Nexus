import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NexusWorldTree, WorldTreeNodeKind } from '../world-tree/store.js';
import { importLegacyLoreBookToWorldTree } from '../world-tree/import-lore.js';

const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('selected Lore source imports into the canonical World Tree UI model',()=>{
  const tree=new NexusWorldTree();
  const result=importLegacyLoreBookToWorldTree(tree,{
    book:'Chronicles',
    data:{entries:{
      1:{uid:1,comment:'Ember Tavern',content:'A tavern in Ember.',key:['Ember']},
      2:{uid:2,comment:'Sun Blade',content:'A lost blade.',key:['Blade']},
    }},
    legacyTree:null,
  });
  assert.equal(result.entryCount,2);
  const ui=tree.readUiModel();
  const lore=ui.nodes.filter(row=>row.kind===WorldTreeNodeKind.LORE_FACT);
  assert.equal(lore.length,2);
  assert.deepEqual(lore.map(row=>row.label).sort(),['Ember Tavern','Sun Blade']);
  assert.equal(ui.owner,'WORLD_TREE');
  assert.ok(ui.worldRevision>0);
});

test('Lore UI wires source loading, Merge and Summarizer to real owners',()=>{
  const host=read('nexus-ui-host.js');
  const wave12=read('src/ui-core/wave12-sillytavern-host.js');
  const adapter=read('src/ui-core/wave13-operator-adapters.js');
  const surfaces=read('src/ui-core/wave13-operator-surfaces.js');
  const graph=read('src/ui-core/lore-neural-graph.js');
  const runtime=read('src/ui-core/wave6-runtime.js');

  assert.match(host,/getNexusWorldTree/);
  assert.match(host,/importLegacyLoreBookToWorldTree/);
  assert.match(host,/loadWorldTreeSource/);
  assert.match(host,/summarizeWorldTreeSource/);
  assert.match(host,/scanWorldTreeMerge/);

  for(const name of ['loadWorldTreeSource','summarizeWorldTreeSource','scanWorldTreeMerge']){
    assert.ok(wave12.includes("'"+name+"'"),name+' must pass the Wave12 owner allowlist');
    assert.ok(adapter.includes(name),name+' must be exposed by the Lore UI adapter');
  }

  assert.match(runtime,/worldTree:hostBindings\?\.world/);
  assert.match(surfaces,/projectWorldTreeLoreData\(worldSnapshot,legacyData\)/);
  assert.match(surfaces,/loreStudy\.loadWorldTreeSource\(discovered\)/);
  assert.match(surfaces,/loreStudy\.scanWorldTreeMerge\(sourceBook\)/);
  assert.equal(surfaces.includes('loreStudy.summarizeWorldTreeSource(sourceBook)'),false,'World Tree toolbar must not run whole-source Summarizer anymore');

  assert.match(graph,/label:'Merge'.*disabled:typeof tools\?\.merge!=='function'/s);
  assert.equal(graph.includes("label:'Summarizer'"),false,'obsolete toolbar Summarizer must stay removed');
  assert.match(graph,/label:'Builder'.*disabled:typeof tools\?\.build!=='function'/s);
});

test('World Tree source control is promoted out of the tiny bottom-left dock',()=>{
  const surfaces=read('src/ui-core/wave13-operator-surfaces.js');
  const css=read('styles/ui-core-lore-neural.css');
  assert.match(surfaces,/nexus-world-tree-source-panel/);
  const loreSurface=surfaces.slice(surfaces.indexOf('export function renderLoreStudySurface'),surfaces.indexOf('function renderLoreDiagnosticsTools'));
  assert.equal(loreSurface.includes("classList?.add?.('nexus-world-tree-source-dock')"),false);
  assert.match(css,/Canonical World Tree source bar/);
  assert.match(css,/grid-template-columns:minmax\(220px,1\.1fr\) minmax\(300px,1\.5fr\) auto/);
  assert.match(css,/font-size:\.9rem/);
});


test('Lore UI tolerates an empty World Tree during first mount',()=>{
  const surfaces=read('src/ui-core/wave13-operator-surfaces.js');
  const loreSurface=surfaces.slice(surfaces.indexOf('export function renderLoreStudySurface'),surfaces.indexOf('function renderLoreDiagnosticsTools'));
  assert.match(loreSurface,/const entries=Array\.isArray\(data\?\.entries\)\?data\.entries:\[\]/);
  assert.equal(loreSurface.includes('data.entries.filter'),false,'first mount must never filter an undefined entries collection');
  assert.equal(loreSurface.includes("compactFact(d,'World nodes',data.entries.length)"),false,'first mount must never count an undefined entries collection');
  assert.match(surfaces,/if\(!loreNodes\.length\)\{[\s\S]*entries:legacyEntries/,'World Tree Lore projection must always publish an entries array');
});


test('Lore Replay Growth is driven by canonical World Tree publication revisions',()=>{
  const tree=new NexusWorldTree();
  importLegacyLoreBookToWorldTree(tree,{
    book:'GrowthBook',
    data:{entries:{
      10:{uid:10,comment:'First',content:'First node',key:['First']},
      20:{uid:20,comment:'Second',content:'Second node',key:['Second']},
      30:{uid:30,comment:'Third',content:'Third node',key:['Third']},
    }},
  });
  const lore=tree.readUiModel().nodes.filter(row=>row.kind===WorldTreeNodeKind.LORE_FACT);
  assert.equal(lore.length,3);
  assert.ok(lore.every(row=>Number.isFinite(Number(row.createdRevision))));
  const revisions=lore.map(row=>Number(row.createdRevision));
  assert.deepEqual([...revisions].sort((a,b)=>a-b),revisions,'World Tree UI model must preserve canonical creation order metadata');

  const graph=read('src/ui-core/lore-neural-graph.js');
  assert.match(graph,/createdRevision/);
  assert.match(graph,/growthRank/);
  assert.match(graph,/replayDelayFor/);
  assert.match(graph,/Replay Growth/);
  assert.match(graph,/replayLoreNeuralGrowth\(renderState\)/);
});


test('Lore graph derives hubs from canonical World Tree parents when available',()=>{
  const tree=new NexusWorldTree();
  importLegacyLoreBookToWorldTree(tree,{
    book:'GroupedBook',
    data:{entries:{
      1:{uid:1,comment:'Alpha',content:'Alpha',key:['Alpha']},
      2:{uid:2,comment:'Beta',content:'Beta',key:['Beta']},
    }},
    legacyTree:{
      lastBuilt:1,
      root:{id:'root-group',label:'Primary Lore',entryUids:[1,2],keywords:[],summary:'',children:[]},
    },
  });
  const ui=tree.readUiModel();
  const groups=ui.nodes.filter(row=>row.kind===WorldTreeNodeKind.LORE_GROUP);
  const facts=ui.nodes.filter(row=>row.kind===WorldTreeNodeKind.LORE_FACT);
  assert.equal(groups.length,1);
  assert.ok(facts.every(row=>row.parentId===groups[0].id));
  assert.ok(facts.every(row=>Number.isFinite(Number(row.createdRevision))));
  assert.ok(ui.edges.some(edge=>edge.to===facts[0].id));

  const surfaces=read('src/ui-core/wave13-operator-surfaces.js');
  const graph=read('src/ui-core/lore-neural-graph.js');
  assert.match(surfaces,/worldParentId:parent\?\.id\?\?node\.parentId/);
  assert.match(surfaces,/worldParentLabel:parent\?\.label/);
  assert.match(graph,/LORE_GROUP','LORE_SOURCE/);
  assert.match(graph,/groupKey:canonicalParent/);
  assert.match(graph,/Canonical edges/);
});


test('World Tree uses collapsible side drawers with no duplicate left Selected UID card',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const css=read('styles/ui-core-lore-neural.css');
  const study=graph.slice(graph.indexOf('function renderStudyRail'),graph.indexOf('function renderGraphPanel'));
  const insight=graph.slice(graph.indexOf('function renderLoreInsightRail'),graph.indexOf('const SEMANTIC_TONES'));
  assert.equal(study.includes('renderSelectedWorldTreeNodePanel'),false,'left drawer must not duplicate selected UID details');
  assert.match(study,/leftDrawerOpen/);
  assert.match(study,/\['world','World'\]/);
  assert.match(study,/\['categories','Categories'\]/);
  assert.match(study,/\['source','Source'\]/);
  assert.match(insight,/rightDrawerOpen/);
  assert.match(insight,/nexus-inspector-window/);
  assert.match(insight,/\['connections','Connections'/);
  assert.match(insight,/\['scene','Scene Intelligence'/);
  assert.match(insight,/\['details','Details'/);
  assert.match(insight,/nexus-inspector-drawer__handle/);
  assert.match(css,/\.nexus-world-drawer\[data-open=false\]>.nexus-world-drawer__surface/);
  assert.match(css,/\.nexus-inspector-drawer\[data-open=false\]>.nexus-inspector-window/);
  assert.match(css,/pointer-events:none!important/);
  assert.match(css,/visibility:hidden/);
  assert.match(css,/\.nexus-world-drawer__tab\{/);
  assert.match(css,/transition:transform \.24s/);
});

test('World Tree visual hierarchy uses semantic glow focus and the Nexus brand core',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const css=read('styles/ui-core-lore-neural.css');
  assert.match(graph,/NEXUS_BRAND_ICON_DATA_URI/);
  assert.match(graph,/nexus-world-core-gradient/);
  assert.match(graph,/nexus-lore-core-node__brand/);
  assert.match(graph,/hoverNodeId/);
  assert.match(graph,/is-hover-connected/);
  assert.match(graph,/is-muted/);
  assert.match(css,/World Tree immersive drawer \+ lighting pass/);
  assert.match(css,/nexus-world-selected-breathe/);
  assert.match(css,/nexus-world-star-drift/);
  assert.match(css,/\.nexus-lore-neural-svg\.has-selection/);
});

test('Scene Intelligence drawer remains evidence-bound instead of deriving scene state from Lore text',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const insight=graph.slice(graph.indexOf('function renderLoreInsightRail'),graph.indexOf('const SEMANTIC_TONES'));
  assert.match(insight,/Not yet published/);
  assert.match(insight,/Lore text is not used to invent scene state/);
  assert.equal(insight.includes('Narrative role\',value:category'),false);
});
