import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
if(!vm.SourceTextModule){const run=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(import.meta.url)],{encoding:'utf8'});process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');process.exit(run.status??1);}

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function runtime({choices={},dimensions={warmth:.8}}={}){
  const staged=[],selections=[],tree={revision:1},context={chatId:'story-a',chatMetadata:{},chat:[],generationId:'g7'};
  const scene={sceneId:'scene-7',revision:7};
  const history=[1,2,3].map(id=>({characterRef:'mara',supportIdentity:'support-'+id,directEvidenceRefs:['scene:'+id],dimensions}));
  const nodes=[{id:'a',kind:'entity',revision:1,aliases:['Known person']},{id:'b',kind:'entity',revision:2,aliases:['Known person']}];
  const stubs={
    'core/world-tree-api.js':{createCanonicalWorldTreeReadApi:()=>({allNodes:()=>nodes,findByAlias:()=>[]}),normalizeWorldTreeAlias:value=>String(value).toLowerCase()},
    'core/ephemeral-state.js':{readWorkingState:()=>({states:[],history})},
    'nexus/hot-cognition.js':{currentNexusHotSnapshot:()=>({segments:{}})},
    'nexus/scene-intelligence.js':{getNexusSceneIntelligenceView:()=>scene},
    'retrieval/diagnostics.js':{getRetrievalDiagnosticsSnapshot:()=>({})},
    'retrieval/source-plan.js':{fallbackRetrievalSourcePlan:()=>({hot:'normal',walker:'normal',vector:'normal'}),writeRetrievalSourcePlan:()=>{}},
    'decision/task8-postturn-sites.js':{TASK8_POSTTURN_SITE_IDS:{WORLDTREE_SUGGEST_TRACK:'worldtree.suggestTrack',WALKER_ANCHOR:'walker.anchor',HOT_THREAD_STATE:'hot.threadState',GREENROOM_SURFACE:'greenroom.surface',GREENROOM_REFLECT:'greenroom.reflect',WORLDTREE_IDENTITY:'worldtree.identity',WORLDTREE_SUPERSEDE:'worldtree.supersede',TRUTH_CONFLICT:'truth.conflict'},runTask8ChoiceDecision:async(site,state,fallback,options)=>{selections.push(options.telemetrySelection);return{choice:choices[site]??fallback,source:'fallback'};},runRetrievalSourcePlanDecision:async(state,fallback,options)=>{selections.push(options.telemetrySelection);return{plan:fallback,source:'fallback'};}},
    'observability/telemetry.js':{logEvent:()=>{}},
    'decision/task8-advice.js':{writeTask8PostTurnAdvice:()=>{}},
    'world-tree/tracking.js':{observeWorldTreeTrackAppearances:()=>[],recordWorldTreeTrackSuggestion:()=>{}},
    'world-tree/index.js':{getNexusWorldTreeOwner:()=>tree},
    'world-tree/intake/candidates.js':{listWorldTreeCandidates:()=>[]},
    'world-tree/watch-list.js':{syncWorldTreeWatchList:()=>[],worldTreeWatchRetrievalBoost:()=>({multiplier:1,nodeIds:[],highLikelihoodCount:0})},
    'scene/scanner.js':{getSceneScannerSnapshot:()=>({})},
    'proposals/store.js':{enqueueProposal:async(op,meta)=>{staged.push({op,meta});return{id:'proposal-'+staged.length};}},
    'nexus/work-scope.js':{captureNexusWorkScope:()=>({chatId:context.chatId}),isNexusWorkScopeFresh:()=>true},
    'nexus/generation-frame-bus.js':{getGenerationFrameIdentity:()=>({chatId:context.chatId,generationId:'g7'})},
  };
  const cache=new Map(),vmContext=vm.createContext({console,Date,Map,Set,Object,Array,String,Number,Boolean,JSON,Math,structuredClone});
  function load(file){
    const key=path.relative(root,file).split(path.sep).join('/');if(cache.has(key))return cache.get(key);
    const stub=stubs[key];
    const mod=stub?new vm.SyntheticModule(Object.keys(stub),function(){for(const [name,value]of Object.entries(stub))this.setExport(name,value);},{context:vmContext,identifier:file}):new vm.SourceTextModule(fs.readFileSync(file,'utf8'),{context:vmContext,identifier:file});
    cache.set(key,mod);return mod;
  }
  const module=load(path.join(root,'decision/task8-runtime.js'));
  await module.link((specifier,parent)=>load(path.resolve(path.dirname(parent.identifier),specifier)));
  await module.evaluate();
  return{run:module.namespace.runTask8PostTurnAdvisoryPass,staged,selections,context};
}
test('real post-turn advisory pass stages reflection, identity and supersession review',async()=>{
  const env=await runtime();
  await env.run({context:env.context,generationId:'g7',gate:'MINOR'});
  assert.deepEqual(env.staged.map(row=>row.op.value.site).sort(),['greenroom.reflect','worldtree.identity','worldtree.supersede']);
  assert.ok(env.staged.every(row=>row.op.value.canonicalMutation===false));
  assert.ok(env.selections.every(selection=>selection.chatId==='story-a'&&selection.generationId==='g7'));
});
test('negative identity and supersession decisions do not create owner-review work',async()=>{
  const env=await runtime({choices:{'worldtree.identity':'SEPARATE','worldtree.supersede':'NO_SUPERSESSION','greenroom.reflect':'SKIP'}});
  await env.run({context:env.context,generationId:'g7',gate:'MINOR'});
  assert.equal(env.staged.length,0);
});
test('observations with no common dimensional reading cannot become a reflection',async()=>{
  const env=await runtime({dimensions:{},choices:{'worldtree.identity':'SEPARATE','worldtree.supersede':'NO_SUPERSESSION'}});
  await env.run({context:env.context,generationId:'g7',gate:'MINOR'});
  assert.equal(env.staged.length,0);
});
