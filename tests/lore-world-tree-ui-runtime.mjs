import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NexusWorldTree, WorldTreeNodeKind } from '../world-tree/store.js';
import { importLegacyLoreBookToWorldTree } from '../world-tree/import-lore.js';
import {projectWorldTreeLoreData} from '../src/ui-core/wave13-operator-surfaces.js';

test('an empty canonical story never falls back to another book\'s legacy rows',()=>{
  const result=projectWorldTreeLoreData({nodes:[],edges:[],worldRevision:1},{entries:[{uid:1,book:'B',sourceId:'lore-fact:B:1'}],conflicts:[{id:'B-secret'}]});
  assert.deepEqual(result.entries,[]);assert.deepEqual(result.conflicts,[]);
});
test('legacy metadata cannot attach to a bound source through a colliding unqualified UID',()=>{
  const result=projectWorldTreeLoreData({nodes:[{id:'lore-fact:A:1',kind:'LORE_FACT',label:'A',temporal:{status:'CURRENT'}}],edges:[]},{entries:[{uid:1,book:'B',artifactIds:['B-secret']}]});
  assert.deepEqual(result.entries[0].artifactIds,[]);
});

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
  assert.match(host,/createLorebookWorldTreeBuilderHost/);
  assert.match(host,/loadWorldTreeSource=snapshot=>selectAuthoringSource\(snapshot\)/);
  assert.match(host,/bookBuilderBindings\.loadWorldTreeSource\(\{id:prepared.book,title:prepared.book\}\)/);
  assert.match(read('builder2/book-world-host.js'),/importLegacyLoreBookToWorldTree/);
  assert.match(host,/loadWorldTreeSource/);
  assert.match(host,/summarizeLoreUid/);
  assert.equal(host.includes('generateSummariesForTree'),false,'World Tree must not expose the shared legacy Tree summarizer');
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



test('World Tree uses an always-visible information sidebar and collapsible inspector',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const css=read('styles/ui-core-lore-neural.css');
  const study=graph.slice(graph.indexOf('function renderStudyRail'),graph.indexOf('function renderGraphPanel'));
  const insight=graph.slice(graph.indexOf('function renderLoreInsightRail'),graph.indexOf('const SEMANTIC_TONES'));
  assert.equal(study.includes('renderSelectedWorldTreeNodePanel'),false,'left sidebar must not duplicate selected UID details');
  assert.match(study,/nexus-world-sidebar/);
  assert.match(study,/Lore Overview/);
  assert.match(study,/Categories/);
  assert.match(study,/Filters/);
  assert.equal(study.includes('nexus-world-drawer__tab'),false);
  assert.match(insight,/rightDrawerOpen/);
  assert.match(insight,/nexus-inspector-window/);
  assert.match(insight,/Connections/);
  assert.match(insight,/Mentions/);
  assert.match(insight,/Media/);
  assert.match(insight,/Notes/);
  assert.match(insight,/nexus-inspector-drawer__handle/);
  assert.match(css,/nexus-world-sidebar\[data-open="false"\]/);
  assert.match(css,/Lore workspace composition pass · Area-52 target/);
});
test('dragged World Tree hubs keep wrapped labels and counts attached',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const geometry=graph.slice(graph.indexOf('function updateGraphGeometry'),graph.indexOf('function findSvgByData'));
  assert.match(geometry,/data-lines/);
  assert.match(geometry,/tagName\?\.toLowerCase\?\.\(\)===['"]tspan['"]/);
  assert.match(geometry,/child\.setAttribute\?\.\('x',String\(row\.x\)\)/);
  assert.match(geometry,/row\.y-\(lineCount-1\)\*5-3/);
  assert.match(geometry,/row\.y\+22/);
});

test('dragging a World Tree category moves its branch together without an arbitrary stretch cap',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const surfaces=read('src/ui-core/wave13-operator-surfaces.js');
  const drag=graph.slice(graph.indexOf('function graphRowLookup'),graph.indexOf('function installGraphSandbox'));
  assert.match(drag,/function graphDescendants/);
  assert.match(drag,/members:\s*members\.map/);
  assert.match(drag,/isHub\?graphDescendants\(graph,row\.id\)/);
  assert.equal(drag.includes('dragDistanceLimit'),false);
  assert.equal(drag.includes('clampDraggedRoot'),false);
  assert.match(drag,/let dx=rawDx,dy=rawDy/);
  assert.match(drag,/state\.savePins/);
  assert.match(surfaces,/savePins:caps\.worldTreeBuilder/);
  assert.match(surfaces,/saveWorldTreeLayoutPins\(nextPins\)/);
});

test('canonical World Tree color is coordinated by branch lineage',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const hierarchy=graph.slice(graph.indexOf('export function applyCanonicalWorldHierarchy'),graph.indexOf('function semanticTopologyGroups'));
  assert.match(hierarchy,/const rootHubs=\[\]/);
  assert.match(hierarchy,/chooseRootTone/);
  assert.match(hierarchy,/paintBranch\(child,tone\)/);
  assert.match(hierarchy,/if\(hub\?\.tone\)node\.tone=hub\.tone/);
  assert.match(hierarchy,/if\(source\?\.tone\)artifact\.tone=source\.tone/);
});

test('World Tree synchronizes the global rendering policy to its selected motion mode',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const panel=graph.slice(graph.indexOf('function renderGraphPanel'),graph.indexOf('function applyZoomPresentation'));
  assert.match(graph,/setNexusMotionMode/);
  assert.match(panel,/setNexusMotionMode\(motionPolicy\.mode,\{document:doc\}\)/);
  assert.match(panel,/motionEnabled=motionPolicy\.enabled&&extensionPolicy\.animationsEnabled/);
});

test('World Tree runtime animation reveals once and stays stable across refreshes',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const css=read('styles/ui-core-lore-neural.css');
  assert.match(graph,/const REVEAL_RENDER_PASSES=1/);
  assert.match(graph,/reconcileSeen/);
  assert.equal(graph.includes('trimSeen(seen,192)'),false,'runtime refresh must not forget old animated ids');
  assert.match(graph,/data-runtime-motion/);
  assert.match(graph,/--nexus-orbit-phase-60/);
  assert.match(graph,/--nexus-orbit-phase-90/);
  assert.match(graph,/--nexus-orbit-phase-42/);
  assert.match(graph,/--nexus-star-phase/);
  assert.match(css,/Runtime animation lifecycle: reveal once/);
  assert.match(css,/data-runtime-motion=reduced/);
  assert.match(css,/var\(--nexus-orbit-phase-60/);
  assert.match(css,/var\(--nexus-star-phase/);
  assert.equal(css.includes('#113nexus'),false,'invalid studying-node fill must stay removed');
});

test('World Tree reveal timing is parent bubble then line then child bubble',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const css=read('styles/ui-core-lore-neural.css');
  const hierarchy=graph.slice(graph.indexOf('export function applyCanonicalWorldHierarchy'),graph.indexOf('function semanticTopologyGroups'));
  assert.match(hierarchy,/scheduleBranch/);
  assert.match(hierarchy,/edge\.delay=parentReadyAt\+siblingStagger/);
  assert.match(hierarchy,/target\.delay=edge\.delay\+lineDuration/);
  assert.match(hierarchy,/readyAt=target\.delay\+nodeRevealDuration\(target\)/);
  assert.match(hierarchy,/scheduleBranch\(target\.id,readyAt/);
  assert.match(graph,/rebindGraphEdges\(graph\)/);
  assert.match(css,/stroke-dasharray:1!important/);
  assert.match(css,/var\(--nexus-link-duration,520ms\)/);
  assert.equal(css.includes('.nexus-lore-neural-link{stroke-dashoffset:0!important}'),false);
});

test('World Tree clicks do not mutate layout or interrupt active growth',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const drag=graph.slice(graph.indexOf('function graphRowLookup'),graph.indexOf('function installGraphSandbox'));
  const sandbox=graph.slice(graph.indexOf('function installGraphSandbox'),graph.indexOf('function renderEmptyCanvas'));
  assert.match(drag,/if\(!drag\.moved&&distance<=6\)return/);
  assert.match(sandbox,/if\(!drag\.moved&&Math\.hypot\(dx,dy\)<=6\)return/);
  assert.equal(graph.includes("renderState.viewport=null;}applyGraphInteraction(svg,graph,renderState);};"),false);
  const activations=graph.slice(graph.indexOf("const activateHub"),graph.indexOf("applyGraphInteraction(svg,graph,renderState);\n  installGraphSandbox"));
  assert.equal(activations.includes('settleGrowthReveal(renderState,graph)'),false);
  assert.match(activations,/refreshAfterActiveGrowth\(renderState,refresh,doc\)/);
  assert.match(graph,/function markActiveGrowthWindow/);
  assert.match(graph,/function refreshAfterActiveGrowth/);
});

test('World Tree electric branches are deterministic layered geometry',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const css=read('styles/ui-core-lore-neural.css');
  assert.match(graph,/function seededRandom/);
  assert.match(graph,/function electricEdgeGeometry/);
  assert.match(graph,/hashText\(String\(seed/);
  assert.match(graph,/nexus-lore-neural-link--halo/);
  assert.match(graph,/nexus-lore-neural-link--core/);
  assert.match(graph,/nexus-lore-neural-tendril/);
  assert.match(graph,/nexus-lore-neural-pulse/);
  assert.match(graph,/findAllSvgByData/);
  assert.match(graph,/electricEdgeGeometry\(edge\)/);
  assert.match(css,/World Tree neural-electric renderer/);
  assert.match(css,/nexus-world-electric-pulse/);
  assert.match(css,/nexus-lore-neural-link--halo\.nexus-lore-neural-link--hub/);
  assert.match(css,/nexus-lore-neural-link--core\.nexus-lore-neural-link--hub/);
});

test('World Tree visual depth makes first-ring categories dominant',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const css=read('styles/ui-core-lore-neural.css');
  assert.match(graph,/function assignVisualDepths/);
  assert.match(graph,/hubRadius=visualDepth<=1\?49:visualDepth===2\?39:34/);
  assert.match(graph,/data-depth/);
  assert.match(css,/nexus-lore-hub-node\[data-depth="1"\]/);
  assert.match(css,/nexus-lore-core-node__aura--outer/);
  assert.match(css,/nexus-lore-core-node__aura--inner/);
});

test('World Tree organic fibers stay visibly bundled with real tapered roots',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const css=read('styles/ui-core-lore-neural.css');
  assert.match(graph,/function smoothPath/);
  assert.match(graph,/function organicFiberPoints/);
  assert.match(graph,/function companionFiberPoints/);
  assert.match(graph,/function taperedRibbonPath/);
  assert.match(graph,/function curvedTendril/);
  assert.match(graph,/const fibers=\[/);
  assert.match(graph,/companionFiberPoints\(primary\.points,fiberDistance,-1/);
  assert.match(graph,/companionFiberPoints\(primary\.points,fiberDistance,1/);
  assert.match(graph,/:fiber:left/);
  assert.match(graph,/:fiber:right/);
  assert.match(graph,/const ribbons=\[/);
  assert.match(graph,/data-ribbon-index/);
  assert.match(graph,/data-tendril-level/);
  assert.match(graph,/data-tip-index/);
  assert.match(css,/Organic neural refinement: smooth fibers/);
  assert.match(css,/nexus-lore-neural-taper--root/);
  assert.match(css,/nexus-lore-neural-taper--mid/);
  assert.match(css,/nexus-lore-synapse-tip/);
  assert.match(css,/nexus-lore-neural-fiber--hub/);
});

test('World Tree Explore presentation is radial while Builder preview keeps Builder coordinates',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  assert.match(graph,/function applyRadialWorldPresentation/);
  assert.match(graph,/if\(mode\.startsWith\('BUILDER'\)\)return graph/);
  assert.match(graph,/const rootRadius=count<=4\?212:count<=6\?224:236/);
  assert.match(graph,/root\.x=cx\+Math\.cos\(angle\)\*rootRadius/);
  assert.match(graph,/placeChildren\(root\.id,angle,rootSector,2/);
  assert.match(graph,/builderMode\?state\?\.ownerLayout\?\.positions/);
  assert.match(graph,/:state\?\.ownerLayout\?\.pins/);
  assert.match(graph,/applyRadialWorldPresentation\(graph,renderState\)/);
});

test('decorative World Tree filaments wait until the real edge reaches its child',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const css=read('styles/ui-core-lore-neural.css');
  assert.match(graph,/--nexus-tendril-delay:'\+String\(delay\+duration\+120\)\+'ms/);
  assert.match(graph,/const branchDelay=delay\+duration\+120\+index\*44/);
  assert.match(graph,/const branchCount=primary\.kind==='hub'\?\(primary\.len>155\?2:1\):0/);
  assert.match(css,/nexus-lore-neural-tendril\[data-tendril-level="1"\][\s\S]*opacity:\.18/);
  assert.match(css,/nexus-lore-neural-tendril\[data-tendril-level="2"\][\s\S]*opacity:\.10/);
});

test('World Tree never shows an incoming connection before its fresh destination bubble reveal',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const growth=graph.slice(graph.indexOf('function growthState'),graph.indexOf('function settleGrowthReveal'));
  assert.match(growth,/const freshTargets=new Set\(\[\.\.\.result\.newHubs,\.\.\.result\.newNodes,\.\.\.result\.newArtifacts\]\)/);
  assert.match(growth,/if\(freshTargets\.has\(edge\.toId\)\)result\.newEdges\.add\(edge\.id\)/);
  assert.match(graph,/function nativeVisibilityGate/);
  assert.match(graph,/nativeVisibilityGate\(doc,line,delay\)/);
  assert.match(graph,/nativeVisibilityGate\(doc,taper,delay\+duration\)/);
  assert.match(graph,/nativeVisibilityGate\(doc,tendrilPath,branchDelay\)/);
  assert.match(graph,/nativeVisibilityGate\(doc,dot,delay\+duration\+150\+index\*28\)/);
});

test('Lore workspace uses stacked overview categories filters and compact header tools',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const left=graph.slice(graph.indexOf('function renderStudyRail'),graph.indexOf('function renderGraphPanel'));
  const panel=graph.slice(graph.indexOf('function renderGraphPanel'),graph.indexOf('function applyZoomPresentation'));
  assert.equal(left.includes('nexus-world-drawer__tabs'),false);
  assert.match(left,/Lore Overview/);
  assert.match(left,/Categories/);
  assert.match(left,/Filters/);
  assert.match(left,/renderState\.focusHubId=hub\.id/);
  assert.match(panel,/Your world's memory, visualized\./);
  assert.match(panel,/nexus-world-tree-search-wrap/);
  assert.match(panel,/nexus-world-tree-tools-menu/);
  assert.match(panel,/function renderCanvasControls|renderCanvasControls/);
});

test('Lore inspector is story first with technical data collapsed',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const inspector=graph.slice(graph.indexOf('function renderLoreInsightRail'),graph.indexOf('const SEMANTIC_TONES'));
  assert.match(inspector,/nexus-inspector-window__portrait/);
  assert.match(inspector,/nexus-inspector-window__summary-card/);
  assert.match(inspector,/Connections/);
  assert.match(inspector,/Mentions/);
  assert.match(inspector,/Media/);
  assert.match(inspector,/Notes/);
  assert.match(inspector,/Technical details/);
  assert.match(inspector,/Last updated/);
  assert.match(inspector,/Affiliation/);
});

test('Lore composition keeps source setup collapsed and selection readable',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const surfaces=read('src/ui-core/wave13-operator-surfaces.js');
  const css=read('styles/ui-core-lore-neural.css');
  assert.match(surfaces,/nexus-world-tree-source-drawer/);
  assert.match(surfaces,/nexus-world-tree-source-summary/);
  assert.match(css,/Lore workspace composition pass · Area-52 target/);
  assert.match(css,/\.nexus-lore-hub-node\.is-muted,[\s\S]*opacity:\.40!important/);
  assert.match(css,/has-selection \.nexus-lore-neural-link:not\(\.is-connected\)\{opacity:\.28!important/);
  assert.match(css,/--nexus-lore-character:#a66bff/);
  assert.match(css,/--nexus-lore-concept:#8b5cf6/);
  assert.match(css,/--nexus-lore-memory:#2ee6d6/);
  assert.match(graph,/recollection\/\.test\(value\)\)return'teal'/);
  assert.match(graph,/concept\|idea\|rule\|system\/\.test\(value\)\)return'purple'/);
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


test('Story-first inspector stays evidence-bound to published Lore metadata',()=>{
  const graph=read('src/ui-core/lore-neural-graph.js');
  const insight=graph.slice(graph.indexOf('function renderLoreInsightRail'),graph.indexOf('const SEMANTIC_TONES'));
  assert.match(insight,/meta\.status/);
  assert.match(insight,/meta\.origin/);
  assert.match(insight,/meta\.affiliation/);
  assert.match(insight,/meta\.firstMention/);
  assert.match(insight,/meta\.lastUpdated/);
  assert.match(insight,/Array\.isArray\(meta\.mentions\)/);
  assert.match(insight,/Array\.isArray\(meta\.media\)/);
  assert.match(insight,/Array\.isArray\(meta\.notes\)/);
  assert.equal(insight.includes('Scene Intelligence'),false);
  assert.equal(insight.includes('Not yet published'),false);
});
