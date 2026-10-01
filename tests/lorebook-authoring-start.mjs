import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../lore/authoring-source.js').catch(()=>({}));
function fixture(){
  const books=new Map([['Existing',{entries:{1:{uid:1,content:'Keep this'}}}]]),enabled=[],created=[];
  const source=api.createLorebookAuthoringSource({listNames:()=>[...books.keys()],canRead:()=>true,assertReady:()=>true,loadBook:async name=>structuredClone(books.get(name)),enableBook:async name=>enabled.push(name),createBook:async name=>{created.push(name);books.set(name,{entries:{}});return true;}});
  return {source,books,enabled,created};
}
test('the starting picker lists host books even before any book is managed or any chat exists',async()=>{
  const {source,enabled}=fixture();assert.deepEqual(source.list(),['Existing']);assert.equal((await source.load('Existing')).book,'Existing');assert.deepEqual(enabled,['Existing']);
});
test('a new empty book can be created and loaded without a chat or an existing book',async()=>{
  const {source,books,created,enabled}=fixture(),prior=structuredClone(books.get('Existing'));
  const result=await source.create('Fresh world');assert.equal(result.book,'Fresh world');assert.deepEqual(result.data.entries,{});assert.deepEqual(created,['Fresh world']);assert.deepEqual(enabled,['Fresh world']);assert.deepEqual(books.get('Existing'),prior);
});
test('creation refuses collisions and invalid names before any physical write',async()=>{
  const {source,created}=fixture();for(const name of ['existing','EXÍSTING','','../Existing','bad/name'])await assert.rejects(()=>source.create(name),/exists|name/i);assert.equal(created.length,0);
});

test('permission denial and a host collision never enable or overwrite a book',async()=>{
  let writes=0,reads=0,enables=0;const dependencies={listNames:()=>['Existing'],canRead:()=>false,assertReady:()=>true,loadBook:async()=>{reads++;return {entries:{}};},enableBook:async()=>enables++,createBook:async()=>{writes++;return false;}};
  const denied=api.createLorebookAuthoringSource(dependencies);assert.deepEqual(denied.list(),[]);await assert.rejects(()=>denied.load('Existing'),/cannot be read/);await assert.rejects(()=>denied.create('New'),/cannot be read/);assert.equal(writes+reads+enables,0);
  const collision=api.createLorebookAuthoringSource({...dependencies,canRead:()=>true});await assert.rejects(()=>collision.create('New'),/not created/);assert.equal(writes,1);assert.equal(reads+enables,0);
});
