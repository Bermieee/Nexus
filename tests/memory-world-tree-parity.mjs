import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusWorldTree } from '../world-tree/store.js';
import { importLegacyMemoryRecordsToWorldTree, legacyMemoryWorldNodeId } from '../world-tree/import-memory-bank.js';
import { compareMemoryRecordParity } from '../world-tree/memory-read-parity.js';
const record=(id='m')=>({id,layer:1,text:'Historical incident',childIds:['child'],parentId:null,promotedTo:null,sourceMessageIds:['msg'],sourceFingerprint:'source-1',routeState:'unrouted',routeProposalIds:[],routeReasoning:'',routeEvaluation:{status:'PENDING'},createdAt:10,updatedAt:20,sidecarSlot:'B',cycleId:'cycle',permanent:true,locked:true});
test('complete imported owner record survives World Tree export/reload',()=>{
 const tree=new NexusWorldTree(),source=record();importLegacyMemoryRecordsToWorldTree(tree,{chatId:'one',records:[source]});
 assert.deepEqual(tree.getNode(legacyMemoryWorldNodeId('one','m'),{chatId:'one'}).data.sourceRecord,source);
 const restored=new NexusWorldTree({snapshot:tree.exportState()});assert.equal(compareMemoryRecordParity(restored,{chatId:'one',records:[source]}).status,'PASS');
});
test('routing-only changes refresh an otherwise unchanged imported record',()=>{
 const tree=new NexusWorldTree(),source=record();importLegacyMemoryRecordsToWorldTree(tree,{chatId:'one',records:[source]});
 const changed={...source,routeEvaluation:{status:'ASSESSED'},routeProposalIds:['proposal']};const receipt=importLegacyMemoryRecordsToWorldTree(tree,{chatId:'one',records:[changed]});
 assert.equal(receipt.updated.length,1);assert.equal(compareMemoryRecordParity(tree,{chatId:'one',records:[changed]}).status,'PASS');
});
test('missing source records remain superseded audit history, and restoration is explicit',()=>{
 const tree=new NexusWorldTree(),source=record();importLegacyMemoryRecordsToWorldTree(tree,{chatId:'one',records:[source]});importLegacyMemoryRecordsToWorldTree(tree,{chatId:'one',records:[]});
 const historical=tree.getNode(legacyMemoryWorldNodeId('one','m'),{chatId:'one'});assert(historical);assert.equal(historical.temporal.status,'SUPERSEDED');assert.equal(historical.data.sourcePresent,false);
 assert.equal(compareMemoryRecordParity(tree,{chatId:'one',records:[]}).status,'PASS');importLegacyMemoryRecordsToWorldTree(tree,{chatId:'one',records:[source]});assert.equal(compareMemoryRecordParity(tree,{chatId:'one',records:[source]}).status,'PASS');
});
test('parity detects missing fields without leaking text or comparing another story',()=>{
 const tree=new NexusWorldTree(),source=record();importLegacyMemoryRecordsToWorldTree(tree,{chatId:'one',records:[source]});importLegacyMemoryRecordsToWorldTree(tree,{chatId:'two',records:[record('foreign')]});
 const node=tree.getNode(legacyMemoryWorldNodeId('one','m'),{chatId:'one'});delete node.data.sourceRecord.routeState;tree.upsertNode(node);
 const receipt=compareMemoryRecordParity(tree,{chatId:'one',records:[source]});assert.equal(receipt.status,'MISMATCH');assert.equal(receipt.counts.different,1);assert.equal(receipt.counts.extra,0);assert(!JSON.stringify(receipt).includes(source.text));assert(receipt.fields.includes('routeState'));
});
test('parity never uses the capped UI read, and lazy owner reads are copies',()=>{
 const tree=new NexusWorldTree(),records=Array.from({length:35},(_,i)=>record(`m${i}`));importLegacyMemoryRecordsToWorldTree(tree,{chatId:'one',records});
 tree.read=()=>{throw new Error('capped UI read forbidden');};assert.equal(compareMemoryRecordParity(tree,{chatId:'one',records}).counts.examined,35);
 const node=tree.iterateNodes({chatId:'one',kind:'MEMORY'}).next().value;node.data.text='changed';assert.notEqual(tree.getNode(node.id,{chatId:'one'}).data.text,'changed');
});
import fs from 'node:fs';
import { projectNexusDiagnosticTelemetryFromObservability } from '../nexus/diagnostics-source.js';
test('installed bridge reports pre/post parity and metadata-only diagnostics',async()=>{
 const tree=new NexusWorldTree();globalThis.memoryParityFixture={tree,records:[record()],events:[]};
 const url=new URL('../world-tree/legacy-world-bridge.js',import.meta.url);
 const stubs={
 '../../../../st-context.js':'export const getContext=()=>({chatId:"one"});',
 '../memory/store.js':'export const getAllMemoryRecords=()=>globalThis.memoryParityFixture.records;export const currentMemoryStoryId=()=>"one";export const memoryRecordValidity=()=>({valid:true});',
 '../memory/character-banks.js':'export const getCharacterBanks=()=>[];export const currentCharacterBankStoryId=()=>"one";',
 './index.js':'export const getNexusWorldTree=()=>globalThis.memoryParityFixture.tree;',
 '../observability/system-events.js':'export const logSystemEvent=(category,name,data)=>globalThis.memoryParityFixture.events.push({category,name,data});'
 };
 const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
 const source=fs.readFileSync(url,'utf8').replace(/from '([^']+)'/g,(_,name)=>`from '${stubs[name]?data(stubs[name]):new URL(name,url).href}'`);
 const bridge=await import(data(source));const first=bridge.syncLegacyWorldSourcesToWorldTree();
 assert.equal(first.memoryParity.before.status,'MISMATCH');assert.equal(first.memoryParity.after.status,'PASS');
 globalThis.memoryParityFixture.records[0].routeState='routed';const next=bridge.syncLegacyWorldSourcesToWorldTree();
 assert.equal(next.memoryParity.before.counts.different,1);assert.equal(next.memoryParity.after.status,'PASS');
 const projected=projectNexusDiagnosticTelemetryFromObservability({events:globalThis.memoryParityFixture.events});
 assert.equal(projected.events.at(-1).data.phase,'POST_IMPORT');
 assert.equal(projected.events.at(-1).data.readersSwitched,false);
 assert(!JSON.stringify(projected).includes('Historical incident'));
 delete globalThis.memoryParityFixture;
});
