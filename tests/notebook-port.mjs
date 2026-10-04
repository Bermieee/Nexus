// Part 3 Task 2: the Notebook on the merged systems. The host module is loaded for real with its
// outside dependencies stubbed, so refresh, digest, rollback and the outlet run the production code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { estimateContentTokens } from '../observability/token-estimator.js';
import { trackedCharacterLabels } from '../world-tree/tracking.js';
import { NOTEBOOK_KEY, NOTEBOOK_REFRESH_OUTCOME, NOTEBOOK_REFRESH_STATUS_KEY, describeRefreshResult, listNotebookRevisions, saveIntoNotebook, rollbackNotebookDocument } from '../memory/notebook-document.js';
import { NOTEBOOK_RETIRED_KEYS, migrateNotebookMetadata } from '../memory/notebook-migration.js';
import { NOTEBOOK_REFERENCE_CONTEXT_TOKENS, NOTEBOOK_SANITY_CEILING, NOTEBOOK_SIZE_DEFAULTS, resolveNotebookBudget } from '../memory/notebook-budget.js';
import { composeNotebookOutlet } from '../memory/notebook-outlet.js';
import { decideNotebookRefresh, ruleNotebookMaterialChange } from '../memory/notebook-gate.js';
import { validateNotebookEvidence } from '../memory/notebook-evidence.js';
import { NOTEBOOK_MATERIAL_CHANGE_SITE_ID } from '../memory/decision-sites.js';
import { getDecisionSite } from '../decision/site-registry.js';
import { buildWorldTreeMemoryRecordContribution } from '../world-tree/memory-contribution.js';
import { createNotebookHostBinding } from '../memory/notebook-binding.js';
import { renderNotebookWorkspace, formatNotebookAge } from '../src/ui-core/notebook-workspace.js';

const url=new URL('../memory/notebook.js',import.meta.url);
const read=file=>fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
const message=(index,text,user=false)=>({mes:text,is_user:user,is_system:false,_index:index});
const RETIRED=NOTEBOOK_RETIRED_KEYS;

let loads=0;
async function loadHost({metadata={},chat=[],maxContext=16384,notebookSettings={},assist=null,tree=null,memory=null}={}){
  const calls={enqueued:[],aborted:[],committed:[],published:[],logged:[],routed:[],saved:0,prompts:[]};
  const context={chatId:'story-1',chatMetadata:metadata,chat,maxContext,saveMetadataDebounced(){calls.saved+=1;}};
  const settings={enabled:true,notebook:{enabled:true,automatic:true,contextMessages:8,...notebookSettings}};
  const table={
    getContext:()=>context,getSettings:()=>settings,
    BUS_STAGE:{MAINTENANCE:'maintenance'},BUS_PRIORITY:{NOTEBOOK:1},NEXUS_BATCH_DOMAIN:{NOTEBOOK:'notebook'},
    structuredSidecarOptions:options=>options,parseStructuredJsonCandidate:text=>JSON.parse(text),
    composeNotebookSplitPayload:()=>null,validateNotebookDeltaPayload:()=>({valid:true}),validateNotebookPayload:()=>({valid:true}),
    mutateChatMetadataDurably:async(_context,_label,_keys,fn)=>fn(),
    estimateContentTokens,logEvent:(channel,name,data)=>{calls.logged.push({channel,name,data});},
    evaluateNotebookMaterialChangeAssist:async ctx=>assist?assist(ctx):{handled:false},
    notebookMaterialChangeFingerprint:ctx=>`fp:${JSON.stringify(ctx.evidence)}:${ctx.priorNotebook}`,
    beginNotebookRefreshTransaction:()=>({id:'tx-1'}),buildNotebookAssumptions:()=>({}),
    enforceNexusTransactionFreshBeforeStage:()=>({state:'fresh'}),stageNotebookRefreshTransaction:()=>({state:'staged'}),
    abortNexusTransaction:(id,reason)=>{calls.aborted.push({id,reason});},
    commitCanonicalNexusMutation:async(_id,mutation)=>{calls.committed.push(mutation);context.chatMetadata[mutation.key]=mutation.value;return{state:'committed'};},
    resolvePhysicalPackingBudget:()=>({promptTargetTokens:100000,resourcePolicy:{outputCeilingTokens:2048}}),
    assertPhysicalPromptBounded:()=>{},LOGICAL_SOFT_PACKING_TARGET:8000,
    currentNexusHotSnapshot:()=>({hotRevision:3}),renderCurrentNexusHotNotebook:()=>'HOT PROJECTION: Mara is in the courtyard.',
    publishNotebookOutlet:args=>{calls.published.push(args);return{accepted:true};},clearNotebookOutlet:()=>{},
    NEXUS_GENERATION_OUTLET_STATUS:{READY:'ready',EMPTY:'empty'},
    getNexusWorldTreeOwner:()=>tree,trackedCharacterLabels,
    getMemoryRecord:id=>memory?.[id]??null,markMemoryRouted:(id,options)=>{calls.routed.push({id,...options});return{id};},
  };
  globalThis.notebookPortFixture=new Proxy(table,{get:(target,name)=>name in target?target[name]:()=>undefined});
  const source=read('memory/notebook.js').replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)';/g,(_,names,path)=>
    /^\.\/notebook-[a-z]+\.js$/.test(path)?`import {${names}} from '${new URL(path,url).href}';`:`const {${names.replace(/\bas\b/g,':')}}=globalThis.notebookPortFixture;`)+`\n// load ${loads+=1}`;
  const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const enqueueWith=payload=>(stage,options)=>{calls.enqueued.push(options);calls.prompts.push(options.prompt);return{id:'job-1',promise:Promise.resolve({structuredPayload:typeof payload==='function'?payload(options):payload,tv2:{slot:'A'}})};};
  return{module,calls,context,settings,enqueueWith};
}
const chatOf=(...texts)=>texts.map((text,index)=>message(index,text,index%2===0));

test('Hot preparation reports only a published generation contribution with its exact chat identity',async()=>{
  const host=await loadHost({chat:chatOf('Mara walks into the courtyard.')});
  host.module.prepareNotebookPrompt();
  assert.equal(host.calls.logged.filter(event=>event.name==='notebook-projection').length,0,'a local preview is not generation publication');
  host.module.prepareNotebookPrompt({generationId:'gen-1'});
  const event=host.calls.logged.find(event=>event.name==='notebook-projection');
  assert.equal(event.data.chatId,'story-1');assert.equal(event.data.generationId,'gen-1');
  assert.equal(event.data.chars,host.calls.published[0].content.includes('HOT PROJECTION')?'HOT PROJECTION: Mara is in the courtyard.'.length:0);
});

test('stored-key migration happens once and leaves no retired key',async()=>{
  const old={version:2,text:'Current scene: courtyard.',updatedAt:5,updatedBy:'sidecar-A',revisions:[{text:'older',updatedAt:1,updatedBy:'operator'}]};
  const metadata={[RETIRED[0]]:old};
  const first=migrateNotebookMetadata(metadata);
  assert.deepEqual(first,{migrated:true,dropped:[RETIRED[0]]});
  assert.equal(metadata[NOTEBOOK_KEY].text,'Current scene: courtyard.');
  assert.equal(metadata[NOTEBOOK_KEY].revisions.length,1);
  assert.equal(Object.keys(metadata).some(key=>key.startsWith('tv2')),false);
  const second=migrateNotebookMetadata(metadata);
  assert.deepEqual(second,{migrated:false,dropped:[]},'a second pass changes nothing');
  // An existing current key wins and the stale retired key is still dropped.
  const both={[NOTEBOOK_KEY]:{version:2,text:'new',updatedAt:9,updatedBy:'operator',revisions:[]},[RETIRED[0]]:old};
  assert.equal(migrateNotebookMetadata(both).migrated,false);
  assert.equal(both[NOTEBOOK_KEY].text,'new');assert.ok(!(RETIRED[0] in both));
  // The oldest note list becomes one document.
  const notes={[RETIRED[1]]:[{title:'Goal',text:'Find the key'}]};
  migrateNotebookMetadata(notes);
  assert.match(notes[NOTEBOOK_KEY].text,/Goal\nFind the key/);assert.ok(!(RETIRED[1] in notes));
  // Through the host: the first read migrates and asks for one save, later reads do not.
  const host=await loadHost({metadata:{[RETIRED[0]]:old}});
  assert.equal(host.module.getNotebook().text,'Current scene: courtyard.');
  assert.equal(host.calls.saved,1);
  host.module.getNotebook();host.module.getNotebook();
  assert.equal(host.calls.saved,1,'migration is not repeated');
  assert.equal(Object.keys(host.context.chatMetadata).some(key=>key.startsWith('tv2')),false);
});

test('retired names exist only in the migration file and the shared sidecar fields it reads',()=>{
  for(const file of ['memory/notebook-document.js','memory/notebook-budget.js','memory/notebook-outlet.js','memory/notebook-evidence.js','memory/notebook-gate.js'])assert.doesNotMatch(read(file),/tv2|TV2|a52/i,file);
  const host=read('memory/notebook.js');
  assert.doesNotMatch(host,/tv2_notebook|tv2-notebook|TV2Notebook|a52/i);
  const sharedFields=host.match(/tv2/gi)||[];
  assert.equal(sharedFields.length,3,'only the three shared sidecar/durability accessors remain');
  assert.match(read('memory/notebook-migration.js'),/tv2_notebook_v2/);
  assert.doesNotMatch(host,/getCharacterBanks|deleteMemoryRecord|unlinkCharacterMemoryEverywhere/);
});

test('an update without valid [M#] evidence is rejected and the old Notebook kept',async()=>{
  const chat=chatOf('Mara opens the gate.','The guard steps aside.');
  const metadata={[NOTEBOOK_KEY]:{version:2,text:'Current scene: the gate.',updatedAt:1,updatedBy:'operator',revisions:[]}};
  const host=await loadHost({metadata,chat});
  const bad=await host.module.refreshNotebookFromScene({manual:true,enqueueSidecar:host.enqueueWith({changed:true,notebook:'INVENTED STATE',reason:'x',evidence:['M99']})});
  assert.equal(bad.rejected,true);assert.equal(bad.code,'NO_VALID_EVIDENCE');
  assert.equal(host.module.getNotebook().text,'Current scene: the gate.');
  assert.equal(host.calls.committed.length,0,'nothing was committed');
  assert.equal(host.calls.aborted.length,1);
  const status=host.module.getNotebookRefreshStatus();
  assert.equal(status.outcome,NOTEBOOK_REFRESH_OUTCOME.REJECTED);
  assert.match(describeRefreshResult(status),/^Rejected — .*\[M#\]/);
  assert.equal(validateNotebookEvidence({changed:true,evidence:['M1'],notebook:'x'},'[M1 | User]\nhi').valid,true);
  assert.equal(validateNotebookEvidence({changed:true,evidence:[],notebook:'x'},'[M1 | User]\nhi').valid,false);
  // The same update with real evidence is accepted.
  const good=await host.module.refreshNotebookFromScene({manual:true,enqueueSidecar:host.enqueueWith({changed:true,notebook:'Current scene: the gate is open.',reason:'gate opened',evidence:['M0']})});
  assert.equal(good.updated,true);
  assert.equal(host.module.getNotebook().text,'Current scene: the gate is open.');
  assert.equal(host.module.getNotebookRefreshStatus().outcome,NOTEBOOK_REFRESH_OUTCOME.UPDATED);
});

test('no material change skips the refresh and a manual Refresh always runs',async()=>{
  const chat=chatOf('Mara opens the gate and walks into the long courtyard where the old fountain still runs.','The guard steps aside and bows to her.');
  const metadata={[NOTEBOOK_KEY]:{version:2,text:'Current scene: the gate.',updatedAt:1,updatedBy:'operator',revisions:[]}};
  const host=await loadHost({metadata,chat});
  const noChange=host.enqueueWith({changed:false,reason:'nothing new',evidence:['M1']});
  const first=await host.module.refreshNotebookFromScene({enqueueSidecar:noChange});
  assert.equal(first.updated,false);assert.equal(host.calls.enqueued.length,1,'the first automatic refresh looks at the scene');
  assert.equal(host.module.getNotebookRefreshStatus().outcome,NOTEBOOK_REFRESH_OUTCOME.NO_CHANGE);
  const second=await host.module.refreshNotebookFromScene({enqueueSidecar:noChange});
  assert.equal(second.skipped,true);assert.equal(second.reason,'no-material-change');assert.equal(host.calls.enqueued.length,1,'no worker job for an unchanged scene');
  assert.match(describeRefreshResult(host.module.getNotebookRefreshStatus()),/^No material change — Nothing new in the chat/);
  const manual=await host.module.refreshNotebookFromScene({manual:true,enqueueSidecar:noChange});
  assert.equal(manual.skipped,undefined);assert.equal(host.calls.enqueued.length,2,'manual Refresh runs on an unchanged scene');
  // New text brings the automatic refresh back.
  host.context.chat.push(message(2,'A bell rings three times across the city, and Mara counts every strike before she answers.',true));
  const third=await host.module.refreshNotebookFromScene({enqueueSidecar:noChange});
  assert.equal(third.skipped,undefined);assert.equal(host.calls.enqueued.length,3);
});

test('Decision Core answers the material-change question and its fallback is the rule',async()=>{
  const site=getDecisionSite(NOTEBOOK_MATERIAL_CHANGE_SITE_ID);
  assert.ok(site,'notebook.material-change.v1 is a registered Decision Core site');
  const evidence=[{evidenceId:'M5',text:'x'.repeat(200)}];
  const lastRefresh={outcome:'updated',evidenceThrough:4,fingerprint:'old'};
  let asked=0;
  const decided=await decideNotebookRefresh({evidence,lastRefresh,fingerprint:'new',assist:async()=>{asked+=1;return{handled:true,material:false};}});
  assert.equal(asked,1);assert.equal(decided.run,false);assert.equal(decided.source,'decision-core');
  const unavailable=await decideNotebookRefresh({evidence,lastRefresh,fingerprint:'new',assist:async()=>({handled:false})});
  assert.equal(unavailable.run,true);assert.equal(unavailable.source,'rule-fallback','with no answer the rule stands and the refresh runs');
  const thrown=await decideNotebookRefresh({evidence,lastRefresh,fingerprint:'new',assist:async()=>{throw new Error('boom');}});
  assert.equal(thrown.run,true);assert.equal(thrown.degraded,true);
  let manualAsked=0;
  const manual=await decideNotebookRefresh({manual:true,evidence:[],lastRefresh,fingerprint:'old',assist:async()=>{manualAsked+=1;return{handled:true,material:false};}});
  assert.equal(manual.run,true);assert.equal(manualAsked,0,'a manual Refresh never asks');
  // The rule alone: nothing new and trivial text are not material; real new text is.
  assert.equal(ruleNotebookMaterialChange({evidence:[{evidenceId:'M4',text:'old'}],lastRefresh,fingerprint:'x'}).material,false);
  assert.equal(ruleNotebookMaterialChange({evidence:[{evidenceId:'M5',text:'ok'}],lastRefresh,fingerprint:'x'}).reason,'only-trivial-new-text');
  assert.equal(ruleNotebookMaterialChange({evidence,lastRefresh,fingerprint:'x'}).material,true);
  assert.equal(ruleNotebookMaterialChange({evidence:[{evidenceId:'M0',text:'hi'}],lastRefresh:null}).material,true,'the first look is never skipped');
});

test('rollback restores the previous revision',async()=>{
  const host=await loadHost({chat:chatOf('hello')});
  await host.module.saveNotebook('Version one',{updatedBy:'operator'});
  await host.module.saveNotebook('Version two',{updatedBy:'operator'});
  assert.equal(host.module.getNotebook().revisions.length,1);
  const restored=await host.module.rollbackNotebook();
  assert.equal(restored.text,'Version one');assert.equal(restored.updatedBy,'revision rollback');assert.equal(restored.revisions.length,0);
  await assert.rejects(host.module.rollbackNotebook(),/no earlier Notebook revision/);
  const rows=listNotebookRevisions({version:2,text:'C',updatedAt:30,updatedBy:'operator',revisions:[{text:'A',updatedAt:10,updatedBy:'sidecar-A'},{text:'B',updatedAt:20,updatedBy:'summary-digest'}]});
  assert.deepEqual(rows.map(row=>[row.current,row.updatedBy,row.updatedAt]),[[true,'operator',30],[false,'summary-digest',20],[false,'sidecar-A',10]],'newest first, with who and when');
  assert.throws(()=>rollbackNotebookDocument({text:'x',revisions:[]}));
  assert.equal(saveIntoNotebook({text:'x'},'x').changed,false);
});

test('the size budget scales with the main model context and keeps a sanity ceiling',()=>{
  const at=contextTokens=>resolveNotebookBudget({contextTokens});
  assert.deepEqual([at(null).targetTokens,at(null).maxTokens],[NOTEBOOK_SIZE_DEFAULTS.targetTokens,NOTEBOOK_SIZE_DEFAULTS.maxTokens],'unknown context starts at today’s sizes');
  assert.deepEqual([at(NOTEBOOK_REFERENCE_CONTEXT_TOKENS).targetTokens,at(NOTEBOOK_REFERENCE_CONTEXT_TOKENS).maxTokens],[1400,1800]);
  assert.ok(at(8192).targetTokens<at(16384).targetTokens&&at(16384).targetTokens<at(32768).targetTokens,'larger context, larger Notebook');
  assert.ok(at(8192).maxTokens<at(32768).maxTokens);
  assert.equal(at(4096).targetTokens,NOTEBOOK_SANITY_CEILING.floorTokens,'a tiny context hits the floor, not zero');
  assert.equal(at(1_000_000).targetTokens,NOTEBOOK_SANITY_CEILING.targetTokens);assert.equal(at(1_000_000).maxTokens,NOTEBOOK_SANITY_CEILING.maxTokens);
  for(const size of [0,3000,16384,500000])assert.ok(at(size||null).maxTokens>=at(size||null).targetTokens);
  assert.ok(resolveNotebookBudget({configured:{targetTokens:900,maxTokens:1100},contextTokens:null}).targetTokens===900,'configured sizes are the starting point');
  assert.match(read('memory/notebook-budget.js'),/core\/budget\.js/);assert.match(read('memory/notebook.js'),/resolveNotebookBudget/);
});

test('the hard limit follows the context, and over-budget content is compacted, never dropped',async()=>{
  const big=Array.from({length:40},(_,index)=>`${index%8===0?'Current thread':'Background note'} ${index}: ${'detail '.repeat(40)}`).join('\n\n');
  const tight=await loadHost({maxContext:8192,chat:chatOf('hi','there')});
  await assert.rejects(tight.module.saveNotebook(big),error=>error.name==='NexusNotebookSizeExceeded'&&error.maxTokens<estimateContentTokens(big));
  const roomy=await loadHost({maxContext:131072,chat:chatOf('hi','there')});
  await roomy.module.saveNotebook(big);
  assert.equal(roomy.module.getNotebook().text,big.trim());
  // The context shrinks later: the stored text is untouched, the prompt carries a compacted copy and says so.
  const metadata={[NOTEBOOK_KEY]:{version:2,text:big.trim(),updatedAt:1,updatedBy:'operator',revisions:[]}};
  const shrunk=await loadHost({metadata,maxContext:8192,chat:chatOf('hi','there','and more')});
  const prepared=shrunk.module.prepareNotebookPrompt({generationId:'g1'});
  assert.equal(prepared.compaction.compacted,true);assert.ok(prepared.compaction.heldBackBlocks>0);
  const sent=shrunk.calls.published.at(-1).content;
  assert.match(sent,/\[Notebook compacted for this turn: \d+ lower-priority blocks? held back/);
  assert.ok(estimateContentTokens(sent)<estimateContentTokens(big));
  assert.equal(shrunk.module.getNotebook().text,big.trim(),'the Notebook itself is never trimmed');
  assert.equal(shrunk.calls.logged.some(event=>event.name==='prompt-compacted'),true,'compaction is reported, not silent');
  assert.equal(composeNotebookOutlet({doc:{text:'small note'},budget:{targetTokens:400,maxTokens:450}}).compaction,null,'content inside the budget is sent whole');
  // A model rewrite over the ceiling is refused with a stated reason and the old text kept.
  const overflow=await loadHost({metadata:{[NOTEBOOK_KEY]:{version:2,text:'Current scene: the gate.',updatedAt:1,updatedBy:'operator',revisions:[]}},maxContext:8192,chat:chatOf('one','two')});
  await assert.rejects(overflow.module.refreshNotebookFromScene({manual:true,enqueueSidecar:overflow.enqueueWith({changed:true,notebook:big,reason:'x',evidence:['M0']})}));
  assert.equal(overflow.module.getNotebook().text,'Current scene: the gate.');
  assert.equal(overflow.module.getNotebookRefreshStatus().outcome,NOTEBOOK_REFRESH_OUTCOME.REJECTED);
});

test('the World tab shows the same content the NOTEBOOK outlet sends for the turn',async()=>{
  const metadata={[NOTEBOOK_KEY]:{version:2,text:'Current scene: the courtyard.\n\nGoal: Mara wants the key.',updatedAt:7,updatedBy:'operator',revisions:[]}};
  for(const chat of [chatOf('Mara arrives.','The guard bows.'),[message(0,'Opening line from the user.',true)]]){
    const host=await loadHost({metadata:structuredClone(metadata),chat});
    host.module.prepareNotebookPrompt({generationId:'turn-1'});
    const outlet=host.calls.published.at(-1).content,projection=host.module.readNotebookProjection();
    assert.equal(projection.content,outlet,'tab and outlet are the same text');
    assert.ok(projection.hotText&&outlet.includes(projection.hotText),'the Hot Cognition projection is part of the outlet');
    assert.ok(outlet.includes(projection.notebookText));
  }
  const cold=await loadHost({metadata:structuredClone(metadata),chat:[message(0,'Opening line from the user.',true)]});
  assert.equal(cold.module.readNotebookProjection().coldStart,true,'a fresh opening uses the cold-start brief in both places');
  const off=await loadHost({metadata:structuredClone(metadata),chat:chatOf('a','b'),notebookSettings:{enabled:false}});
  assert.equal(off.module.readNotebookProjection().enabled,false);
});

test('digesting a Summary marks it digested and never deletes it',async()=>{
  const memory={'mem-1':{id:'mem-1',text:'Mara and the guard agreed to open the gate at dawn.',permanent:false,locked:false,updatedAt:3}};
  const host=await loadHost({memory,chat:chatOf('hi')});
  const result=await host.module.digestMemoryToNotebook('mem-1',{enqueueSidecar:host.enqueueWith({changed:true,notebook:'Commitment: open the gate at dawn.',reason:'active commitment',evidence:['S1']})});
  assert.equal(result.digested,true);assert.equal(result.deleted,false);assert.equal(result.marked,true);
  assert.deepEqual(host.calls.routed,[{id:'mem-1',state:'superseded',reasoning:'digested-to-notebook'}]);
  assert.equal(host.module.getNotebook().text,'Commitment: open the gate at dawn.');
  assert.equal(host.module.getNotebook().updatedBy,'summary-digest');
  const noop=await loadHost({memory,chat:chatOf('hi')});
  const kept=await noop.module.digestMemoryToNotebook('mem-1',{enqueueSidecar:noop.enqueueWith({changed:false,reason:'nothing active',evidence:[]})});
  assert.equal(kept.digested,false);assert.equal(noop.calls.routed.length,0,'a Summary that adds nothing is not marked');
  await assert.rejects(host.module.digestMemoryToNotebook('missing'),/not found/);
  const locked=await loadHost({memory:{'mem-2':{id:'mem-2',text:'x',permanent:true}},chat:chatOf('hi')});
  await assert.rejects(locked.module.digestMemoryToNotebook('mem-2'),/Permanent memory/);
  // The World Tree sees the mark: the memory node is SUPERSEDED with the digest as its reason, and stays on record.
  const node=buildWorldTreeMemoryRecordContribution({record:{id:'mem-1',text:'Gate at dawn.',layer:0,routeState:'superseded',routeReasoning:'digested-to-notebook'},chatId:'story-1'}).nodes[0];
  assert.equal(node.temporalStatus,'SUPERSEDED');assert.equal(node.temporalReason,'digested-to-notebook');
  const live=buildWorldTreeMemoryRecordContribution({record:{id:'mem-1',text:'Gate at dawn.',layer:0,routeState:'unrouted'},chatId:'story-1'}).nodes[0];
  assert.notEqual(live.temporalStatus,'SUPERSEDED');
});

test('character names come from the World Tree tracked characters',async()=>{
  const nodes=[
    {id:'c1',kind:'CHARACTER',scope:{type:'GLOBAL'},data:{label:'Mara',trackedCharacter:true},provenance:{}},
    {id:'c2',kind:'CHARACTER',scope:{type:'GLOBAL'},data:{label:'Untracked Extra'},provenance:{}},
    {id:'c3',kind:'ENTITY',scope:{type:'GLOBAL'},data:{label:'Brann',trackedCharacter:true},provenance:{}},
    {id:'c4',kind:'ENTITY',scope:{type:'CHAT',chatId:'story-1'},data:{label:'Chat Only',trackedCharacter:true},provenance:{}},
  ];
  const tree={*iterateNodes(){yield*nodes;}};
  assert.deepEqual(trackedCharacterLabels({tree,chatId:'story-1'}),['Brann','Mara']);
  assert.deepEqual(trackedCharacterLabels({tree:null}),[]);
  const host=await loadHost({tree,chat:chatOf('Mara arrives and Brann follows her inside.','The room is quiet.')});
  await host.module.refreshNotebookFromScene({manual:true,enqueueSidecar:host.enqueueWith({changed:false,reason:'none',evidence:['M0']})});
  assert.match(host.calls.prompts[0],/TRACKED CHARACTERS\nBrann, Mara/);
  assert.doesNotMatch(host.calls.prompts[0],/Untracked Extra|CHARACTER BANKS/);
});

test('the refresh runs as the notebook.refresh job and reports through the scheduler',()=>{
  const jobs=read('scheduler/jobs.js'),scheduler=read('lifecycle/scheduler.js');
  assert.match(jobs,/row\('notebook\.refresh'/);
  assert.match(scheduler,/executors\['notebook\.refresh'\]=async/);
  assert.match(scheduler,/refreshNotebookFromScene\(\{manual,enqueueSidecar:cycleEnqueue\(cycle,'notebook'/);
});

// ---------------------------------------------------------------- the World tab

function fakeDocument(){
  const make=tag=>({tagName:tag.toUpperCase(),dataset:{},style:{},children:[],attributes:{},listeners:new Map(),className:'',textContent:'',value:'',
    setAttribute(key,value){this.attributes[key]=String(value);},getAttribute(key){return this.attributes[key]??null;},
    append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=[...nodes];},
    addEventListener(type,fn){this.listeners.set(type,fn);},removeEventListener(){},
    click(){return this.listeners.get('click')?.({target:this});},input(value){this.value=value;this.listeners.get('input')?.({target:this});}});
  const doc=make('document');doc.createElement=tag=>{const node=make(tag);node.ownerDocument=doc;return node;};return doc;
}
const flatten=node=>[node,...(node.children??[]).flatMap(flatten)];
const textOf=node=>flatten(node).map(row=>row.textContent??'').join(' ');
const byRole=(root,role)=>flatten(root).find(node=>node.dataset?.role===role);
const buttonNamed=(root,label)=>flatten(root).find(node=>node.tagName==='BUTTON'&&node.textContent.replace(/…$/,'')===label);
function mountTab(binding,now=()=>1_000_000){
  const doc=fakeDocument(),host=doc.createElement('div');let renders=0;
  const refresh=()=>{renders+=1;renderNotebookWorkspace(host,{notebook:binding,refresh,now});};
  refresh();return{host,doc,refresh,renders:()=>renders};
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,0));

test('the Notebook tab shows the text, who changed it and when, the last refresh, and the outlet projection',async()=>{
  const metadata={[NOTEBOOK_KEY]:{version:2,text:'Current scene: the courtyard.\n\nGoal: Mara wants the key.',updatedAt:940_000,updatedBy:'sidecar-A',revisions:[{text:'Current scene: the gate.',updatedAt:100_000,updatedBy:'operator'}]},
    [NOTEBOOK_REFRESH_STATUS_KEY]:{outcome:'rejected',reason:'The update cited no recent message ([M#]), so the existing Notebook was kept.',manual:false,at:950_000,evidenceThrough:1,fingerprint:'x'}};
  const host=await loadHost({metadata,chat:chatOf('Mara arrives.','The guard bows.')});
  host.module.prepareNotebookPrompt({generationId:'turn-1'});
  const binding=createNotebookHostBinding({api:host.module,refresh:async()=>({}),readChatId:()=>host.context.chatId});
  const tab=mountTab(binding);
  const text=textOf(tab.host);
  assert.match(textOf(byRole(tab.host,'last-refresh')),/Last refresh: Rejected — The update cited no recent message/);
  assert.equal(byRole(tab.host,'last-refresh').dataset.outcome,'rejected');
  assert.equal(byRole(tab.host,'text').textContent,'Current scene: the courtyard.\n\nGoal: Mara wants the key.');
  assert.match(byRole(tab.host,'current-meta').textContent,/Updated by Nexus refresh · 1 min ago/);
  const revisions=flatten(tab.host).filter(node=>node.dataset?.role==='revision');
  assert.equal(revisions.length,2);assert.match(textOf(revisions[1]).replace(/\s+/g,' '),/Earlier · you · 15 min ago/);
  assert.equal(byRole(tab.host,'hot').textContent,'HOT PROJECTION: Mara is in the courtyard.');
  assert.match(text,/Read-only\./);
  // The exact text sent is the NOTEBOOK outlet content for the same turn.
  assert.equal(byRole(tab.host,'outlet-text').textContent,host.calls.published.at(-1).content);
  assert.ok(!/ownerDocument/.test(text));
});

test('Edit, Save, Refresh and Rollback act through the host and show what happened',async()=>{
  const host=await loadHost({chat:chatOf('Mara arrives.','The guard bows.')});
  const binding=createNotebookHostBinding({api:host.module,refresh:async()=>host.module.refreshNotebookFromScene({manual:true,enqueueSidecar:host.enqueueWith({changed:true,notebook:'Current scene: Mara enters.',reason:'arrival',evidence:['M0']})}),readChatId:()=>host.context.chatId});
  const tab=mountTab(binding);
  assert.match(byRole(tab.host,'text').textContent,/The Notebook is empty/);
  assert.equal(buttonNamed(tab.host,'Rollback').attributes.disabled,'true','nothing to roll back yet');
  buttonNamed(tab.host,'Edit').click();
  const editor=byRole(tab.host,'editor');assert.ok(editor,'Edit opens the editor');
  editor.input('Goal: find the key.');
  buttonNamed(tab.host,'Save').click();await wait();
  assert.equal(host.module.getNotebook().text,'Goal: find the key.');
  assert.equal(byRole(tab.host,'editor'),undefined,'saving closes the editor');
  buttonNamed(tab.host,'Refresh').click();await wait();await wait();
  assert.equal(host.module.getNotebook().text,'Current scene: Mara enters.');
  assert.match(textOf(byRole(tab.host,'last-refresh')),/Updated — arrival \(manual\)/);
  assert.equal(host.module.getNotebook().revisions.at(-1).text,'Goal: find the key.');
  assert.equal(buttonNamed(tab.host,'Rollback').attributes.disabled,'false');
  buttonNamed(tab.host,'Rollback').click();await wait();
  assert.equal(host.module.getNotebook().text,'Goal: find the key.');
  // A save that is too large is refused with the reason, and the text stays.
  const tight=await loadHost({maxContext:4096,chat:chatOf('a','b')});
  const tightTab=mountTab(createNotebookHostBinding({api:tight.module,refresh:async()=>({}),readChatId:()=>'story-1'}));
  buttonNamed(tightTab.host,'Edit').click();byRole(tightTab.host,'editor').input('word '.repeat(5000));
  buttonNamed(tightTab.host,'Save').click();await wait();
  assert.match(byRole(tightTab.host,'message').textContent,/exceeds the configured hard persisted ceiling/);
  assert.equal(byRole(tightTab.host,'message').dataset.kind,'error');assert.equal(tight.module.getNotebook().text,'');
});

test('the tab says so when a chat is not open, the Notebook is off, or the content was compacted',async()=>{
  const noChat=mountTab(createNotebookHostBinding({api:(await loadHost({})).module,refresh:async()=>({}),readChatId:()=>null}));
  assert.match(textOf(noChat.host),/Open a chat to see its Notebook/);
  assert.match(textOf(mountTab(null).host),/not available in this session/);
  const off=await loadHost({chat:chatOf('a','b'),notebookSettings:{enabled:false}});
  assert.match(textOf(byRole(mountTab(createNotebookHostBinding({api:off.module,refresh:async()=>({}),readChatId:()=>'story-1'})).host,'projection')),/turned off, so nothing is sent/);
  const big=Array.from({length:40},(_,index)=>`${index%8===0?'Current thread':'Background note'} ${index}: ${'detail '.repeat(40)}`).join('\n\n');
  const shrunk=await loadHost({metadata:{[NOTEBOOK_KEY]:{version:2,text:big,updatedAt:1,updatedBy:'operator',revisions:[]}},maxContext:8192,chat:chatOf('a','b','c')});
  const tab=mountTab(createNotebookHostBinding({api:shrunk.module,refresh:async()=>({}),readChatId:()=>'story-1'}));
  assert.match(textOf(byRole(tab.host,'compaction')),/Compacted for this turn: \d+ lower-priority blocks? held back/);
  assert.equal(formatNotebookAge(0),'never');assert.equal(formatNotebookAge(1_000_000-30_000,1_000_000),'just now');
});

test('the World rail item opens the Notebook and the host exposes it to the interface',()=>{
  const surfaces=read('src/ui-core/wave13-operator-surfaces.js');
  assert.match(surfaces,/registry\.has\('world-product'\)&&notebook/);
  assert.match(surfaces,/registry\.update\('world-product'/);
  assert.match(read('src/ui-core/wave6-runtime.js'),/notebook:hostBindings\?\.notebook\?\?null/);
  assert.match(read('src/ui-core/wave12-sillytavern-host.js'),/'world','notebook'/);
  assert.match(read('nexus-ui-host.js'),/notebook:createNotebookHostBinding\(/);
  assert.match(read('lifecycle/scheduler.js'),/case'notebook':result=await refreshNotebookFromScene\(\{manual:true/);
});
