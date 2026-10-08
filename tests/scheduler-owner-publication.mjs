import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
function ownerFunction(path,name){const source=fs.readFileSync(new URL(path,import.meta.url),'utf8');const start=source.indexOf('export async function '+name+'(');assert.ok(start>=0);const body=source.slice(start),end=/^}\r?\n/m.exec(body);assert.ok(end);return body.slice(0,end.index+end[0].length);}
test('automatic no-lore settlement uses the real canonical coordinator admission hook',async()=>{
 const source=fs.readFileSync(new URL('../nexus/mutation-coordinator.js',import.meta.url),'utf8').replace(/^import[\s\S]*?;\r?\n/gm,'');
 const coordinator=await import(data(`const transactionService={getNexusLedger:()=>({read:()=>({id:'tx',state:'staged'})})};const resolveNexusMutationResources=()=>['chat:one'];`+source));
 globalThis.publicationCoordinator=coordinator;
 const prefix=`const context={chatId:'one',chatMetadata:{}};const getContext=()=>context;const memory={id:'m',version:'one'};const getMemoryRecord=()=>memory;const memoryRecordVersion=()=> 'one';const captureNexusWorkScope=()=>({});const isNexusWorkScopeFresh=()=>true;const automaticNoopAssumptions=()=>({});const beginLoreRoutingTransaction=()=>({id:'tx'});const finalizeLoreRoutingTransaction=()=>({state:'staged'});const getMemoryStore=()=>({records:{m:memory}});const previewMemoryRouteState=()=>({store:{records:{m:memory}}});const memoryFacadeWorldTreeMutation=()=>({type:'metadata.set',chatId:'one',key:'nexus_world_tree_chat_state_v1'});const getMemoryOwnerReadControlSnapshot=()=>({});const commitCanonicalNexusMutation=(...args)=>globalThis.publicationCoordinator.commitCanonicalNexusMutation(...args);const failNexusTransaction=async()=>{};const logEvent=()=>{};`;
 const owner=await import(data(prefix+ownerFunction('../memory/lore-router.js','settleAutomaticLoreRoutingNoop')));let admissions=0;
 try{const result=await owner.settleAutomaticLoreRoutingNoop('m',{schedulerPublish:async(candidate,validate)=>{admissions++;assert.equal(validate(candidate),true);throw new Error('admission denied');}});assert.equal(admissions,1);assert.equal(result.deferred,true);assert.equal(result.error,'admission denied');}finally{delete globalThis.publicationCoordinator;}
});
test('evaluated-window consumption cannot change host metadata before scheduler admission',async()=>{
 const metadata={pending:['message']};globalThis.publicationContext={chatId:'one',chatMetadata:metadata};
 const owner=await import(data(`const getContext=()=>globalThis.publicationContext;`+ownerFunction('../postturn/pipeline.js','consumePostTurnEvaluatedWindow')));
 let admissions=0;
 try{await assert.rejects(owner.consumePostTurnEvaluatedWindow({sourceStart:0,targetIndex:0,schedulerPublish:async(value,validate)=>{admissions++;assert.equal(validate(value),true);throw new Error('admission denied');}}),/admission denied/);assert.equal(admissions,1);assert.deepEqual(metadata,{pending:['message']});}finally{delete globalThis.publicationContext;}
});
