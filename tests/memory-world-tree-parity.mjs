import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusWorldTree } from '../world-tree/store.js';
import { importLegacyMemoryRecordsToWorldTree, legacyMemoryWorldNodeId, legacyMemoryControlWorldNodeId } from '../world-tree/import-memory-bank.js';
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
test('control metadata parity covers active layers, coverage and summary pointers',()=>{
 const tree=new NexusWorldTree(),source=record();
 const control={
  activeLayers:[[source.id]],permanentIds:[source.id],
  coverageReceipts:[{id:'coverage:m',turnRange:[0,1],sourceMessageIds:['0','1'],sourceFingerprint:'fp',sourceMemoryId:source.id,source:'layer0-summary',createdAt:5}],
  summarizedUpTo:1,effectiveSummarizedUpTo:1,
 };
 importLegacyMemoryRecordsToWorldTree(tree,{chatId:'one',records:[source],control});
 const receipt=compareMemoryRecordParity(tree,{chatId:'one',records:[source],control});
 assert.equal(receipt.status,'PASS');assert.equal(receipt.controlMetadata,'PASS');assert.deepEqual(receipt.controlMismatches,[]);
 const node=tree.getNode(legacyMemoryControlWorldNodeId('one'),{chatId:'one'});
 assert.equal(node.kind,'SUMMARY');assert.equal(node.data.summarizedUpTo,1);assert.deepEqual(node.data.activeLayers,[[source.id]]);
 node.data.activeLayers[0].push('mutated');
 assert.deepEqual(tree.getNode(legacyMemoryControlWorldNodeId('one'),{chatId:'one'}).data.activeLayers,[[source.id]]);
 const changed={...control,effectiveSummarizedUpTo:0};
 const mismatch=compareMemoryRecordParity(tree,{chatId:'one',records:[source],control:changed});
 assert.equal(mismatch.status,'MISMATCH');assert.equal(mismatch.controlMetadata,'MISMATCH');assert(mismatch.controlMismatches.includes('effectiveSummarizedUpTo'));
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
 '../memory/store.js':'export const getMemoryOwnerRecords=()=>globalThis.memoryParityFixture.records;export const getMemoryOwnerReadControlSnapshot=()=>({activeLayers:[["m"]],permanentIds:[],coverageReceipts:[],summarizedUpTo:-1,effectiveSummarizedUpTo:-1});export const getMemoryReadAuthorityStatus=()=>({authority:"WORLD_TREE",readersSwitched:true});export const currentMemoryStoryId=()=>"one";export const memoryRecordValidity=()=>({valid:true});',
 '../memory/character-banks.js':'export const getCharacterBanks=()=>[];export const currentCharacterBankStoryId=()=>"one";',
 './index.js':'export const getNexusWorldTreeOwner=()=>globalThis.memoryParityFixture.tree;',
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
 assert.equal(projected.events.at(-1).data.readersSwitched,true);
 assert.equal(projected.events.at(-1).data.readAuthority,'WORLD_TREE');
 assert.equal(next.memoryParity.after.controlMetadata,'PASS');
 assert(!JSON.stringify(projected).includes('Historical incident'));
 delete globalThis.memoryParityFixture;
});


test('Memory family read API switches atomically behind one World Tree parity gate',()=>{
 const storeSource=fs.readFileSync(new URL('../memory/store.js',import.meta.url),'utf8');
 for(const required of [
  'function memoryReadAuthoritySnapshot()',
  "parity.status==='PASS'&&parity.controlMetadata==='PASS'",
  "authority:'WORLD_TREE'",
  "authority:'OWNER_IMPORT'",
  'export function getMemoryReadAuthorityStatus()',
  'export function getMemoryReadSnapshot()',
  'export function getMemoryRecord(id){return clone(memoryReadAuthoritySnapshot()',
  'export function getPermanentMemoryRecords(){const s=memoryReadAuthoritySnapshot()',
  'export function getEffectiveSummarizedUpTo(){return memoryReadAuthoritySnapshot().effectiveSummarizedUpTo;',
  'export function getAllMemoryRecords(){return Object.values(memoryReadAuthoritySnapshot().records',
  'export function getActiveLayerIds(layer){return [...(memoryReadAuthoritySnapshot().activeLayers',
  'export function getActiveMemories(){',
 ])assert.ok(storeSource.includes(required),'Memory cutover contract missing '+required);
 const bridgeSource=fs.readFileSync(new URL('../world-tree/legacy-world-bridge.js',import.meta.url),'utf8');
 assert.ok(bridgeSource.includes('getMemoryOwnerRecords'),'legacy bridge must keep owner/import reads separate');
 assert.ok(bridgeSource.includes('getMemoryOwnerReadControlSnapshot'),'legacy bridge must import owner control metadata');
 assert.ok(bridgeSource.includes('getMemoryReadAuthorityStatus'),'bridge must report the live cutover result');
 const recallSource=fs.readFileSync(new URL('../memory/recall.js',import.meta.url),'utf8');
 assert.equal(recallSource.includes('getMemoryStore'),false,'Memory recall must not bypass the family read gate');
 const hostSource=fs.readFileSync(new URL('../nexus-ui-host.js',import.meta.url),'utf8');
 assert.ok(hostSource.includes('readMemorySnapshot:()=>getMemoryReadSnapshot()'),'Memory inspection must read the switched family projection');
});
