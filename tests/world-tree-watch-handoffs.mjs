import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusWorldTree } from '../world-tree/store.js';
import { syncWorldTreeWatchList, readWorldTreeWatchList, resolveWorldTreeWatchMention } from '../world-tree/watch-list.js';

test('Hot ACTIVE_THREADS producer rows become watch horizons', () => {
    const tree = new NexusWorldTree();
    syncWorldTreeWatchList({tree,chatId:'story-a',currentTurn:4,hotSnapshot:{segments:{ACTIVE_THREADS:{value:[{threadId:'thread-7',objective:'Find the Back room',unresolvedQuestion:'Where is the door?'}]}}}});
    const rows=readWorldTreeWatchList({tree,chatId:'story-a'});
    assert.equal(rows.length,1);
    assert.equal(rows[0].label,'Find the Back room');
    assert.ok(rows[0].sourceRefs.some(ref=>ref.includes('thread-7')));
});
test('resolving a watched mention does not consume a watch before contribution acceptance', () => {
    const tree=new NexusWorldTree();
    tree.upsertNode({id:'location:ember',kind:'LOCATION',scope:{type:'CHAT',chatId:'story-a'},provenance:{sourceType:'TEST',sourceIds:['ember']},temporal:{status:'CURRENT'},data:{label:'Ember Tavern'}});
    syncWorldTreeWatchList({tree,chatId:'story-a',currentTurn:1,sceneScan:{references:{locations:[{name:'Ember Tavern',relation:'planned-destination'}]}}});
    const match=resolveWorldTreeWatchMention({tree,chatId:'story-a',currentTurn:2,mention:{text:'Ember Tavern',kindHint:'LOCATION'}});
    assert.equal(match.node.id,'location:ember');
    assert.equal(readWorldTreeWatchList({tree,chatId:'story-a'}).length,1);
    assert.equal(tree.listDecisionRecords({chatId:'story-a',site:'worldtree.watch'}).length,0);
});
