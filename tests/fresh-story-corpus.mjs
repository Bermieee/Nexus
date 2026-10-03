import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {configureWorldTreeContextProvider,replaceNexusWorldTree} from '../world-tree/index.js';
import {worldTreeStoryBinding} from '../world-tree/story-binding.js';
import {attachWorldTreeStoryBook} from '../world-tree/story-attachment.js';

const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const url=new URL('../lore/corpus-authority.js',import.meta.url);
const stubs={
 '../../../../st-context.js':'export const getContext=()=>globalThis.corpusFixture.context;',
 '../core/settings.js':'export const getSettings=()=>({selectedLorebook:"Foreign"});',
 './active-books.js':'export const getManagedBooks=()=>["Book","Foreign"];export const getActiveBooks=()=>globalThis.corpusFixture.scope.readBooks;export const getStoryScopeStatus=()=>globalThis.corpusFixture.scope;',
};
const code=fs.readFileSync(url,'utf8').replace(/from '([^']+)'/g,(_,name)=>`from '${stubs[name]?data(stubs[name]):new URL(name,url).href}'`);
const {captureLoreCorpus}=await import(data(code));
test.afterEach(()=>{configureWorldTreeContextProvider(null);delete globalThis.corpusFixture;});
test('story retrieval cannot use an inferred, copied or multi-book scope',()=>{
 replaceNexusWorldTree();const context={chatId:'fresh',chatMetadata:{}};
 globalThis.corpusFixture={context,scope:{configured:false,mode:'inferred-single-st-book',readBooks:['Book'],writeBooks:['Book']}};
 configureWorldTreeContextProvider(()=>context,()=>globalThis.corpusFixture.scope);
 for(const scope of [globalThis.corpusFixture.scope,{configured:true,chatKey:'foreign-chat',readBooks:['Book'],writeBooks:['Book']},{configured:true,chatKey:'fresh',readBooks:['Book','Foreign'],writeBooks:['Book','Foreign']}]){
  globalThis.corpusFixture.scope=scope;
  assert.equal(worldTreeStoryBinding(context,scope),null);
  const corpus=captureLoreCorpus();assert.deepEqual(corpus.books,[]);assert.equal(corpus.source,'unbound-story');
 }
});
test('an explicit story binding admits only its book while authoring remains separate',()=>{
 const context={chatId:'fresh',chatMetadata:{}};
 globalThis.corpusFixture={context,scope:{configured:true,chatKey:'fresh',revision:1,readBooks:['Book'],writeBooks:['Book'],primaryWriteBook:'Book'}};
 configureWorldTreeContextProvider(()=>context,()=>globalThis.corpusFixture.scope);
 assert.deepEqual(captureLoreCorpus().books,['Book']);
 assert.deepEqual(captureLoreCorpus({books:['Foreign','Book']}).books,['Book']);
 assert.equal(context.chatMetadata.tv2_story_scope_v1,undefined,'reads must never attach a story implicitly');
 assert.deepEqual(captureLoreCorpus({purpose:'maintenance',context:{chatId:null}}).books,['Foreign']);
});

test('explicit attachment uses the real Story Scope service and remains exact after reload',async()=>{
 const context={chatId:'fresh',chatMetadata:{}};
 globalThis.corpusFixture={context,scope:{configured:false,readBooks:['Foreign'],writeBooks:['Foreign']}};
 const serviceUrl=new URL('../lore/story-scope.js',import.meta.url);
 const serviceStubs={
  '../../../../st-context.js':'export const getContext=()=>globalThis.corpusFixture.context;',
  '../../../../world-info.js':'export const selected_world_info=["Foreign"];',
  '../observability/telemetry.js':'export const logEvent=()=>{};',
  '../nexus/lore-source-revision.js':'export const bumpNexusLoreSourceRevision=()=>{};',
  '../nexus/host-durability.js':'export async function mutateChatMetadataDurably(context,label,options,mutate){await Promise.resolve();return mutate();}',
 };
 const source=fs.readFileSync(serviceUrl,'utf8').replace(/from '([^']+)'/g,(_,name)=>`from '${serviceStubs[name]?data(serviceStubs[name]):new URL(name,serviceUrl).href}'`);
 const service=await import(data(source));
 await attachWorldTreeStoryBook({book:'Book',getContext:()=>context,getManagedBooks:()=>['Book','Foreign'],configureCurrentStoryScope:service.configureCurrentStoryScope});
 assert.deepEqual(context.chatMetadata.tv2_story_scope_v1.readBooks,['Book']);
 assert.deepEqual(context.chatMetadata.tv2_story_scope_v1.writeBooks,['Book']);
 globalThis.corpusFixture.context={...context,chatMetadata:structuredClone(context.chatMetadata)};
 globalThis.corpusFixture.scope=service.getCurrentStoryScope({managedBooks:['Book','Foreign']});
 configureWorldTreeContextProvider(()=>globalThis.corpusFixture.context,()=>globalThis.corpusFixture.scope);
 assert.deepEqual(captureLoreCorpus().books,['Book']);
 assert.equal(worldTreeStoryBinding(globalThis.corpusFixture.context,globalThis.corpusFixture.scope).book,'Book');
 globalThis.corpusFixture.context.chatId='copied-story';
 globalThis.corpusFixture.scope=service.getCurrentStoryScope({managedBooks:['Book','Foreign']});
 assert.deepEqual(captureLoreCorpus().books,[]);
});
