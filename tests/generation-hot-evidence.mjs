import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as bus from '../nexus/generation-frame-bus.js';
import {publishNotebookOutlet} from '../nexus/generation-frame-ports.js';
import {createNexusUiHostBindings} from '../nexus-ui-bindings.js';
import {createWave11LiveReceiptBinding} from '../src/ui-core/wave11-live-bindings.js';

test.afterEach(()=>bus.resetGenerationFrameState());
test('the production notebook publisher captures the Hot input used by its prompt',async()=>{
 const hot={kind:'HotCognitionSnapshot',chatNamespace:'story',worldRevision:1,sceneRevision:1,hotRevision:2,sourceRevisionRefs:['message:1'],segments:{LOCATION:{value:'Courtyard'}}};
 const selection={chatId:'story',generationId:'notebook-gen',worldRevision:1,sceneRevision:1,sourceRevisionRefs:['aggregate:1']};
 bus.beginGenerationFrameState({generationId:selection.generationId,chatId:selection.chatId,schedulerEnvelope:selection});
 globalThis.notebookEvidenceFixture={getContext:()=>({chatId:'story',chatMetadata:{}}),getSettings:()=>({enabled:true,notebook:{enabled:true}}),
  currentNexusHotSnapshot:()=>hot,renderCurrentNexusHotNotebook:()=> 'Working state at Courtyard',logEvent:()=>{},estimateContentTokens:text=>Math.ceil(text.length/4)};
 const url=new URL('../memory/notebook.js',import.meta.url);
 const source=fs.readFileSync(url,'utf8').replace(/import\s*\{([^}]+)\}\s*from\s*'([^']+)';/g,(_,names,path)=>
  ['../nexus/generation-frame-ports.js','../nexus/generation-frame-contract.js'].includes(path)||/^\.\/notebook-[a-z]+\.js$/.test(path)?`import {${names}} from '${new URL(path,url).href}';`:`const {${names.replace(/\bas\b/g,':')}}=globalThis.notebookEvidenceFixture;`);
 const notebook=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 notebook.prepareNotebookPrompt({generationId:selection.generationId});
 assert.match(bus.getGenerationFrameSnapshot().outlets.notebook.content,/Courtyard/);
 bus.sealGenerationFrameState();bus.markGenerationFrameApplied();hot.segments.LOCATION.value='Later scene';
 assert.equal(bus.readGenerationFrameHotSnapshot(selection).segments.LOCATION.value,'Courtyard');
 delete globalThis.notebookEvidenceFixture;
});
test('Hot selected-turn evidence is the captured notebook input, not later live working state',()=>{
 const selection={chatId:'story',generationId:'gen-1',turnId:'gen-1',worldRevision:1,sceneRevision:1,sourceRevisionRefs:['aggregate:1']};
 bus.beginGenerationFrameState({generationId:'gen-1',chatId:'story',schedulerEnvelope:selection});
 const hot={kind:'HotCognitionSnapshot',chatNamespace:'story',worldRevision:1,sceneRevision:1,hotRevision:2,sourceRevisionRefs:['message:1'],segments:{LOCATION:{value:'Courtyard'}}};
 publishNotebookOutlet({generationId:'gen-1',content:'Working state at Courtyard',data:{hotSnapshot:hot}});
 bus.sealGenerationFrameState();bus.markGenerationFrameApplied();
 hot.segments.LOCATION.value='Harbor';hot.hotRevision=3;
 assert.equal(typeof bus.readGenerationFrameHotSnapshot,'function');
 const host=createNexusUiHostBindings({readCurrentChatId:()=> 'story',readGenerationFrameIdentity:bus.getGenerationFrameIdentity,readHotCognition:bus.readGenerationFrameHotSnapshot});
 const live=createWave11LiveReceiptBinding(host);
 const receipt=host.readSelectedTurnReceipt();
 assert.ok(receipt.producers.hotCognition);
 const captured=bus.readGenerationFrameHotSnapshot(selection);
 assert.equal(captured.hotRevision,2);
 assert.equal(captured.segments.LOCATION.value,'Courtyard');
 assert.deepEqual(captured.consumedSourceRevisionRefs,['message:1']);
 assert.deepEqual(captured.sourceRevisionRefs,['aggregate:1']);
 assert.equal(live.bridges.cognition.readHotCognitionReadModel(selection).segments.LOCATION.value,'Courtyard');
 assert.throws(()=>live.bridges.cognition.readHotCognitionReadModel({...selection,sourceRevisionRefs:['foreign-source']}),error=>error.code==='LIVE_RECEIPT_STALE');
 captured.segments.LOCATION.value='Changed externally';
 assert.equal(bus.readGenerationFrameHotSnapshot(selection).segments.LOCATION.value,'Courtyard');
 assert.equal(bus.readGenerationFrameHotSnapshot({...selection,chatId:'foreign'}),null);
 assert.equal(bus.readGenerationFrameHotSnapshot({...selection,generationId:'old'}),null);
 bus.beginGenerationFrameState({generationId:'gen-2',chatId:'story',schedulerEnvelope:{...selection,generationId:'gen-2'}});
 assert.equal(bus.readGenerationFrameHotSnapshot(selection),null);
});

test('a notebook snapshot from another chat or world revision cannot become generation Hot evidence',()=>{
 for(const hot of [{chatNamespace:'foreign',worldRevision:1,sceneRevision:1},{chatNamespace:'story',worldRevision:0,sceneRevision:1},{chatNamespace:'story',worldRevision:1,sceneRevision:2}]){
  bus.beginGenerationFrameState({generationId:'gen',chatId:'story',schedulerEnvelope:{worldRevision:1,sceneRevision:1}});
  publishNotebookOutlet({generationId:'gen',content:'working',data:{hotSnapshot:hot}});
  bus.sealGenerationFrameState();bus.markGenerationFrameApplied();
  if(typeof bus.readGenerationFrameHotSnapshot==='function')assert.equal(bus.readGenerationFrameHotSnapshot({chatId:'story',generationId:'gen'}),null);
  else assert.fail('Missing captured Hot reader');
 }
});
