import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceNexusWorldTree } from '../world-tree/index.js';
import { SchedulerGather } from '../scheduler/gather.js';
import { SidecarScheduler } from '../scheduler/sidecars.js';
test('late scheduler results belong to canonical ephemeral overlays and never export',async()=>{
 const tree=replaceNexusWorldTree(),scheduler=new SidecarScheduler();
 const scope={chatId:'late-chat',revision:1};const gather=new SchedulerGather([{id:'one',accept:()=>true}],{scope,deadline:0,late:scheduler.lateResults});
 assert.equal((await gather.accept('one',{value:'private-held-evidence'})).verdict,'LATE');
 assert.equal(scheduler.lateResults.size,1);assert([...tree.overlays.values()].some(row=>row.data?.value?.payload?.value==='private-held-evidence'));
 assert(!JSON.stringify(tree.exportState()).includes('private-held-evidence'));
 replaceNexusWorldTree();assert.equal(scheduler.lateResults.size,0);
});
test('chat clearing removes held results without touching other ephemeral owners',()=>{
 const tree=replaceNexusWorldTree(),scheduler=new SidecarScheduler();
 tree.addEphemeralOverlay({id:'unrelated',kind:'RUNTIME',chatId:'late-chat',nodeIds:['world:nexus'],generationId:'unrelated',data:{keep:true}});
 scheduler.lateResults.set('key',{scope:{chatId:'late-chat'},payload:{value:'held'}});scheduler.clear();
 assert.equal(scheduler.lateResults.size,0);assert(tree.overlays.has('unrelated'));
});
