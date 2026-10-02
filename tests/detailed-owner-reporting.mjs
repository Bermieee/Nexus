import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createNexusUiHostBindings,projectNexusSensoryTrace,projectNexusTruthAssessment} from '../nexus-ui-bindings.js';
import {BrainDecisionVisibilityAdapter} from '../src/ui-core/brain-decision-visibility.js';
import {Wave13LoreStudyUIAdapter} from '../src/ui-core/wave13-operator-adapters.js';
import * as diagnostics from '../retrieval/diagnostics.js';
import {inspectSelectedWorldGraph} from '../retrieval/graph-inspection.js';
import {replaceNexusWorldTree} from '../world-tree/index.js';
import {currentNexusLoreSourceRevision,bumpNexusLoreSourceRevision} from '../nexus/lore-source-revision.js';
import {SelectedTurnGraphVisibilityAdapter} from '../src/ui-core/selected-turn-graph-visibility.js';
import {runNexusForegroundScatterGather} from '../nexus/scatter-gather-runtime.js';
import {WorkDirector} from '../nexus/work-director.js';
import {NexusWorkCoordinator} from '../nexus/work-coordinator.js';
import {projectNexusGatherReceipt} from '../nexus-ui-bindings.js';
import {createCanonicalWorldTreeReadApi} from '../core/world-tree-api.js';
const selection={chatId:'story',generationId:'g',turnId:'g'};

test('Sensory retains bounded candidate identities without source or provider bodies',()=>{
 const raw={candidateId:'candidate',sourceRevisionRefs:['shared'],evidenceRefs:['exact'],channelNominations:[{channelId:'ZZ_NATIVE_GRAPH_WALKER'}],graphMetadata:[{graphOwner:'WORLD_TREE',edgeId:'e',content:'PRIVATE'}],representationText:'PRIVATE',content:'PRIVATE'};
 const read=projectNexusSensoryTrace({events:[{category:'nexus.sensory',name:'candidate-envelope',data:{...selection,candidates:Array.from({length:150},()=>raw)}}]},selection);
 assert.equal(read.candidates.length,96);assert.equal(read.candidates[0].candidateId,'candidate');assert.equal(JSON.stringify(read).includes('PRIVATE'),false);
});

test('detailed stage statuses use scoped receipts and never borrow foreign owner reads',()=>{
 let foreign=false;
 const host=createNexusUiHostBindings({readCurrentChatId:()=>selection.chatId,readGenerationFrameIdentity:()=>selection,
  readSceneSnapshot:()=>({...selection,chatId:foreign?'other':'story',sceneRevision:2,status:'DEGRADED'}),
  readHotCognition:()=>({...selection,chatId:foreign?'other':'story',hotRevision:3}),
  readScatter:()=>({...selection,jobs:[]}),readGraphTraversal:()=>({...selection,traversedEdgeCount:1}),
 });
 const read=()=>new BrainDecisionVisibilityAdapter({bindings:host,selectionProvider:host.readSelection}).read();
 for(const stage of ['scene','hotCognition','runtime','retrieval'])assert.notEqual(read().stages.find(x=>x.stage===stage).state,'NO_EVIDENCE',stage);
 foreign=true;
 for(const stage of ['scene','hotCognition'])assert.equal(read().stages.find(x=>x.stage===stage).state,'NO_EVIDENCE',stage);
});

test('canonical Lore metadata does not claim a nonexistent study job is running',()=>{
 const host=createNexusUiHostBindings({readCurrentChatId:()=>selection.chatId,readLoreSnapshot:()=>({nodes:[{id:'lore',kind:'LORE_FACT',temporal:{status:'CURRENT'},data:{book:'book',uid:1}}]})});
 const read=new Wave13LoreStudyUIAdapter({bindings:host,selectionProvider:()=>selection}).read();
 assert.notEqual(read.source.operationalState,'WORKING');
 assert.equal(read.data.entries[0].retrievalReady,false);assert.equal(read.data.entries[0].learnedRevisionId,null);
});

test('on-demand references are exact scoped, bounded and invalidated independently of traversal history',()=>{
 let fresh=true,calls=0;
 diagnostics.recordGraphTraversalDiagnostics({...selection,receipt:{kind:'GraphTraversalReceipt',traversedEdgeCount:1},inspection:{worldRevision:1,anchorEntityIds:['a']}});
 const readers={readReferences:()=>{calls++;return {kind:'WorldGraphReferenceSet',query:'PRIVATE',edges:[{edgeId:'e',representationText:'PRIVATE',fromEntityId:'a',toEntityId:'b'}]};},isCurrent:()=>fresh};
 assert.equal(diagnostics.readWorldGraphReferenceDiagnostics({...selection,chatId:'other'},readers),null);
 const result=diagnostics.readWorldGraphReferenceDiagnostics(selection,readers);
 assert.equal(result.referenceSet.edges[0].edgeId,'e');assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(calls,1);
 fresh=false;assert.equal(diagnostics.readWorldGraphReferenceDiagnostics(selection,readers),null);
 assert.equal(diagnostics.readGraphTraversalDiagnostics(selection).traversedEdgeCount,1);
 diagnostics.clearRetrievalDiagnostics({chatId:'story'});assert.equal(diagnostics.readWorldGraphReferenceDiagnostics(selection),null);
});

test('shared source revisions do not prove individual candidate acceptance',()=>{
 const host=createNexusUiHostBindings({readCurrentChatId:()=>selection.chatId,readGenerationFrameIdentity:()=>selection,
  readSensoryTrace:()=>({...selection,candidates:[{candidateId:'a',sourceRevisionRefs:['shared'],evidenceRefs:['exact-a']}]}),
  readGather:()=>({...selection,results:[{resultId:'r',accepted:true,sourceRevisionRefs:['shared']}]}),
 });
 const read=new BrainDecisionVisibilityAdapter({bindings:host,selectionProvider:host.readSelection}).read();
 assert.equal(read.candidateFlow[0].gather,'NO_EVIDENCE');
});

test('actual canonical World Tree supports an on-demand query and fences source changes',()=>{
 const tree=replaceNexusWorldTree();
 tree.upsertNode({id:'lore:a',kind:'LORE_FACT',parentId:'world:nexus',scope:{type:'GLOBAL'},provenance:{sourceType:'LORE',sourceIds:['book']},temporal:{status:'CURRENT'},data:{book:'book',uid:1,label:'PRIVATE',content:'PRIVATE'}});
 tree.upsertNode({id:'lore:b',kind:'LORE_FACT',scope:{type:'GLOBAL'},provenance:{sourceType:'LORE',sourceIds:['book']},temporal:{status:'CURRENT'},data:{book:'book',uid:2,label:'PRIVATE',content:'PRIVATE'}});
 tree.linkEdge({id:'edge',from:'lore:a',to:'lore:b',relation:'relationship',data:{subtype:'related-to'},scope:{type:'GLOBAL'},provenance:{sourceType:'LORE',sourceIds:['book']}});
 const anchor=createCanonicalWorldTreeReadApi({chatId:selection.chatId}).allNodes().find(node=>node.payload?.uid===1).id;
 const source=currentNexusLoreSourceRevision(['book']);
 diagnostics.recordGraphTraversalDiagnostics({...selection,receipt:{kind:'GraphTraversalReceipt',traversedEdgeCount:1},inspection:{intentKind:'CURRENT',anchorEntityIds:[anchor],books:['book'],worldRevision:tree.revision,sourceRevisionRefs:[source]}});
 const host=createNexusUiHostBindings({readCurrentChatId:()=>selection.chatId,readGenerationFrameIdentity:()=>selection,readWorldGraphReferences:s=>inspectSelectedWorldGraph(s,selection.chatId)});
 const read=new SelectedTurnGraphVisibilityAdapter({bindings:host,selectionProvider:host.readSelection}).read();
 assert.ok(read.worldReferenceRead);assert.equal(read.worldReferenceRead.generationTimeReceipt,false);assert.equal(read.worldReferenceRead.readOnly,true);assert.equal(JSON.stringify(read).includes('PRIVATE'),false);
 assert.ok(read.referenceEdges.length>0,'real canonical edges must reach the inspector');
 assert.equal(inspectSelectedWorldGraph({...selection,chatId:'foreign'},selection.chatId),null);
 bumpNexusLoreSourceRevision({book:'book'});assert.equal(inspectSelectedWorldGraph(selection,selection.chatId),null);
 diagnostics.clearRetrievalDiagnostics({chatId:selection.chatId});
});

test('actual Gather acceptance preserves candidate attribution through the selected seal',async()=>{
 const result=await runNexusForegroundScatterGather({generationId:selection.generationId,chatId:selection.chatId,runtime:{director:new WorkDirector(),coordinator:new NexusWorkCoordinator()},deadlineMs:5000,isFresh:()=>true,
  executors:{'foreground-bootstrap':async()=>({ready:true}),'foreground-retrieval':async()=>({ready:true,candidateIds:['candidate']}),'foreground-memory':async()=>({ready:true})}});
 const gather=projectNexusGatherReceipt(result.diagnostics);
 assert.ok(gather.results.some(row=>row.candidateIds.includes('candidate')));
 const frame={...selection,appliedAt:10,sections:[],failedOutlets:[]};
 const host=createNexusUiHostBindings({readCurrentChatId:()=>selection.chatId,readGenerationFrameIdentity:()=>selection,readGenerationFrameDiagnostics:()=>frame,readGather:()=>gather,readSensoryTrace:()=>({...selection,candidates:[{candidateId:'candidate',evidenceRefs:[],sourceRevisionRefs:[]}]}),readTruthAssessment:()=>({...selection,admittedCandidateIds:['candidate']})});
 const read=new BrainDecisionVisibilityAdapter({bindings:host,selectionProvider:host.readSelection}).read();
 assert.equal(read.candidateFlow[0].truth,'PROVEN');assert.equal(read.candidateFlow[0].gather,'PROVEN');assert.equal(read.candidateFlow[0].seal,'PROVEN');
});

test('Truth identities survive eviction of per-candidate events',()=>{
 const read=projectNexusTruthAssessment({events:[{category:'nexus.truth',name:'assessment-complete',data:{...selection,candidateVerdicts:[{candidateId:'a',kept:true},{candidateId:'b',kept:false}]}}]},selection);
 assert.deepEqual(read.admittedCandidateIds,['a']);assert.equal(read.truthResults.length,2);
});

test('Jev failures cannot label successful Sidecar work as failed',()=>{
 const events=[{category:'sidecar-a',name:'request-success',data:{...selection,routeId:'physical',jobId:'job'}},{category:'decision-core',name:'decision-failed',id:'jev',data:{...selection,physicalAttempt:true,provider:'openrouter-jev',ok:false,jevReturned:false}}];
 const host=createNexusUiHostBindings({readCurrentChatId:()=>selection.chatId,readGenerationFrameIdentity:()=>selection,readTelemetry:()=>({events})});
 const read=host.readSelectedTurnReceipt(selection);
 assert.equal(read.producers.sidecar.status,'COMPLETE');assert.equal(read.producers.sidecar.physicalAttempt,true);
 assert.equal(read.producers.jev.physicalAttempt,true);assert.equal(read.producers.jev.returned,false);assert.equal(read.producers.jev.ownerAccepted,null);
});

test('actual retrieval return attributes only the final injected candidates',()=>{
 const code=fs.readFileSync(new URL('../retrieval/retriever.js',import.meta.url),'utf8');
 const end=code.indexOf('\nexport function clearRetrieval('),start=code.lastIndexOf('    return {',end);
 const read=new Function('selectedCandidates','refs',`const gate={},retrievalDegraded=false,regionRefs=[],nodeRefs=[],regionalReasoning='',nodeReasoning='',injectionReasoning='',text='',estimatedInjectionTokens=0,regionJob=null,nodeJob=null,injectionJob=null;${code.slice(start,end).trim().replace(/\}\s*$/, '')}`);
 const rows=[{book:'b',uid:1,sensoryCandidateId:'selected'},{book:'b',uid:2,sensoryCandidateId:'not-injected'}];
 assert.deepEqual(read(rows,[{book:'b',uid:1}]).candidateIds,['selected']);
});
