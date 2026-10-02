import test from 'node:test';
import assert from 'node:assert/strict';

import { NexusWorldTree } from '../world-tree/store.js';
import { applyWorldTreeContribution, drainWorldTreeContributions } from '../world-tree/intake/runtime.js';
import { buildWorldTreeCardContribution } from '../world-tree/card-contribution.js';
import {
  importLegacyCharacterBanksToWorldTree,
  boundCharacterWorldNodeId,
  characterStateWorldNodeId,
} from '../world-tree/import-character-banks.js';
import { importLegacyLoreBookToWorldTree, loreFactWorldNodeId } from '../world-tree/import-lore.js';
import { importLegacyMemoryRecordsToWorldTree, legacyMemoryWorldNodeId } from '../world-tree/import-memory-bank.js';
import { buildWorldTreeMemoryContribution } from '../world-tree/memory-contribution.js';
import { buildWorldTreeSceneContribution, buildWorldTreeSceneCoPresenceContribution } from '../world-tree/scene-contribution.js';
import { runCharacterMemoryJob } from '../world-tree/character-memory.js';
import { createCanonicalWorldTreeReadApi } from '../core/world-tree-api.js';
import { createWorldTreeGraphProvider } from '../nexus/a52/sensory/walker/world-tree-provider.js';

const context=()=>({
  chatId:'chat-a',
  chatMetadata:{},
  chat:[
    {is_user:true,mes:'Mara and Lili enter the Ember Tavern.',swipe_id:0},
    {is_user:false,mes:'Lili tells Mara she will guard the caravan. Mara says she trusts Lili.',swipe_id:0},
  ],
  saveMetadataDebounced(){},
});

const card=(name,avatar)=>({avatar,name,fingerprint:'card-'+name.toLowerCase(),characterVersion:'1',tags:[]});
const bank=(id,character,avatar,relationships='')=>({
  id,storyId:'chat-a',enabled:true,character,role:'supporting',sceneAware:true,
  cardBinding:{avatar,name:character,fingerprint:'card-'+character.toLowerCase(),boundAt:1,lastScannedAt:1},
  linkedRefs:character==='Mara'?[{book:'World',uid:7,title:'Alliance Chronicle',nodeId:'people',nodeLabel:'People',path:['People']}]:[],
  memoryIds:[],memoryRefs:[],
  profile:{personality:character==='Mara'?'careful':'steady',appearance:'',clothingArmor:''},
  state:{
    baseline:{personality:character==='Mara'?'careful':'steady'},
    persistent:{relationships,goalsMotivations:character==='Mara'?'Protect the caravan.':'Keep the caravan safe.'},
    temporary:{mood:'focused',sceneId:'scene-1',sourceRevision:'scene-r1',updatedAt:1},
  },
  stateProposals:[],changeHistory:[],fieldProvenance:{},cardSync:{},
  tracking:{personality:true,relationships:true,status:true,goals:true,behavior:true},
});

const sceneRecord=(maraId,liliId)=>({
  sceneId:'scene-1',revision:1,lifecycle:'OPEN',sourceRange:{start:0,end:1},sourceRevisionRefs:['scene-r1'],
  fields:{
    activeCast:{value:[
      {characterId:'Mara',label:'Mara',canonicalEntityId:maraId,trackedCharacter:true,state:'PRESENT'},
      {characterId:'Lili',label:'Lili',canonicalEntityId:liliId,trackedCharacter:true,state:'PRESENT'},
    ]},
    location:{value:{location:'Ember Tavern'}},
    immediateObjects:{value:[]},
    activeThreads:{value:[{threadId:'guard the caravan'}]},
    activeObjectives:{value:[]},
    narrativeTime:{value:'evening'},
    atmosphere:{value:{activity:'conversation',focus:'caravan safety',relationshipFocus:true}},
  },
});
const sceneView=(record,maraId,liliId)=>({
  chatId:'chat-a',sceneId:record.sceneId,revision:record.revision,lifecycle:record.lifecycle,
  participants:['Mara','Lili'],
  participantRefs:[
    {id:'Mara',label:'Mara',canonicalEntityId:maraId,trackedCharacter:true},
    {id:'Lili',label:'Lili',canonicalEntityId:liliId,trackedCharacter:true},
  ],
  location:'Ember Tavern',objects:[],threads:['guard the caravan'],objectives:[],
  activity:'conversation',focus:'caravan safety',narrativeTime:'evening',relationshipFocus:true,sourceRevisionRefs:['scene-r1'],
});
function sidecar(){
  return(_stage,options)=>{
    const mara=String(options?.label??'').includes('Mara');
    return{promise:Promise.resolve({structuredPayload:{
      summary:mara?'Mara remembers that Lili promised to guard the caravan and that she trusted her.':'Lili remembers promising Mara that she would guard the caravan.',
      importance:'normal',knownBy:['Mara','Lili'],about:['Mara','Lili'],mentions:[],
    }})};
  };
}
function budget(){return{beginTurn(){return{compute(_id,{total}){return{allowed:total,deferred:0,total,complete:true};}};}};}

test('durable character, relationship, scene, memory and lore subsystems form one traversable World Tree branch',async()=>{
  const tree=new NexusWorldTree(),ctx=context();
  const maraCard=card('Mara','mara.png'),liliCard=card('Lili','lili.png');
  await applyWorldTreeContribution(buildWorldTreeCardContribution({bank:{id:'mara-bank'},card:maraCard,extraction:{aliases:[],facts:[]}}),{tree,context:ctx});
  await applyWorldTreeContribution(buildWorldTreeCardContribution({bank:{id:'lili-bank'},card:liliCard,extraction:{aliases:[],facts:[]}}),{tree,context:ctx});
  const maraId=boundCharacterWorldNodeId('mara.png'),liliId=boundCharacterWorldNodeId('lili.png');

  const loreData={name:'World',entries:{'7':{uid:7,comment:'Alliance Chronicle',content:'Mara and Lili protect the caravan together.',key:['Alliance Chronicle','Mara','Lili'],constant:false,selective:false,disable:false,order:1}}};
  const loreTree={version:3,book:'World',lastBuilt:1,root:{id:'root',label:'ROOT',summary:'World',keywords:['world'],entryUids:[],children:[{id:'people',label:'People',summary:'Allies',keywords:['allies'],entryUids:[7],children:[]}]}};
  importLegacyLoreBookToWorldTree(tree,{book:'World',data:loreData,legacyTree:loreTree});

  const maraBank=bank('mara-bank','Mara','mara.png','Mara trusts Lili and relies on her judgment.');
  const liliBank=bank('lili-bank','Lili','lili.png','Lili is committed to protecting Mara and the caravan.');
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'chat-a',banks:[maraBank,liliBank],control:{enabled:true}});

  const rawScene=sceneRecord(maraId,liliId),view=sceneView(rawScene,maraId,liliId);
  await applyWorldTreeContribution(buildWorldTreeSceneContribution({scene:view,tree}),{tree,context:ctx});
  await applyWorldTreeContribution(buildWorldTreeSceneCoPresenceContribution({chatId:'chat-a',scenes:[view]}),{tree,context:ctx});

  const generalMemory={
    id:'general-1',layer:0,
    text:'At the Ember Tavern, Lili promised Mara she would guard the caravan. Mara said she trusts Lili.',
    turnRange:[0,1],assistantTurnRange:[0,1],sourceMessageIds:['message:0','message:1'],sourceFingerprint:'general-r1',
    characters:['Mara','Lili'],locations:['Ember Tavern'],dates:[],topics:['Alliance Chronicle'],threads:[],
    childIds:[],parentId:null,promotedTo:null,routeState:'unrouted',routeProposalIds:[],routeReasoning:'',routeEvaluation:{status:'PENDING'},
    createdAt:1,updatedAt:2,permanent:false,locked:false,
  };
  importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[generalMemory],control:{activeLayers:[[generalMemory.id]]}});
  await applyWorldTreeContribution(buildWorldTreeMemoryContribution({
    record:generalMemory,chatId:'chat-a',
    extraction:{relationships:[{from:'Mara',to:'Lili',subtype:'trusts',snippet:'Mara said she trusts Lili'}]},
  }),{tree,context:ctx});

  await runCharacterMemoryJob({
    context:ctx,tree,gate:{mode:'MINOR'},sceneState:{chatId:'chat-a',history:[],current:rawScene},sceneView:view,
    enqueueSidecar:sidecar(),budgetManager:budget(),
  });
  await drainWorldTreeContributions({context:ctx,tree});

  const snapshot=tree.read({chatId:'chat-a',limit:5000}),currentEdges=snapshot.edges.filter(edge=>edge.temporal.status==='CURRENT');
  const stateId=characterStateWorldNodeId('chat-a','mara-bank'),loreId=loreFactWorldNodeId('World',7),generalId=legacyMemoryWorldNodeId('chat-a','general-1');
  const maraMemory=[...tree.iterateNodes({chatId:'chat-a',kind:'CHARACTER_MEMORY'})].find(node=>node.data?.character===maraId);
  const sceneNode=[...tree.iterateNodes({chatId:'chat-a',kind:'SCENE'})].find(node=>node.data?.sceneIdentity==='scene-1'||node.data?.sceneId==='scene-1');
  const location=[...tree.iterateNodes({chatId:'chat-a',kind:'LOCATION'})].find(node=>node.data?.label==='Ember Tavern');

  assert.ok(maraMemory&&sceneNode&&location);
  assert.ok(currentEdges.some(edge=>edge.from===stateId&&edge.to===loreId&&edge.relation==='derived-from'));
  assert.ok(currentEdges.some(edge=>edge.from===maraId&&edge.to===liliId&&edge.relation==='relationship'));
  assert.ok(currentEdges.some(edge=>edge.from===maraId&&edge.to===sceneNode.id&&edge.relation==='present-in'));
  assert.ok(currentEdges.some(edge=>edge.from===sceneNode.id&&edge.to===location.id&&edge.relation==='at'));
  assert.ok(currentEdges.some(edge=>edge.from===maraId&&edge.to===maraMemory.id&&edge.relation==='remembers'));
  assert.ok(currentEdges.some(edge=>edge.from===maraMemory.id&&edge.to===generalId&&edge.relation==='derived-from'));
  assert.ok(currentEdges.some(edge=>edge.from===generalId&&edge.to===loreId&&edge.relation==='mentions'));

  const read=createCanonicalWorldTreeReadApi({chatId:'chat-a',worldTree:tree});
  const loreProjection=read.getNode(loreId),memoryProjection=read.getNode(generalId);
  assert.ok(loreProjection);assert.equal(loreProjection.canonicalId,loreId);
  assert.ok(memoryProjection);assert.equal(memoryProjection.canonicalId,generalId);
  const provider=createWorldTreeGraphProvider({worldTree:read,chatId:'chat-a'});
  const walked=provider.query({anchorEntityIds:[maraId],maxDepth:3,maxEdges:192});
  const touched=new Set(walked.flatMap(edge=>[edge.fromEntityId,edge.toEntityId]));
  for(const expected of [liliId,stateId,loreProjection.id,sceneNode.id,location.id,maraMemory.id,memoryProjection.id]){
    assert.ok(touched.has(expected),'Walker should reach '+expected+' from the Mara World Tree anchor');
  }
  assert.ok(walked.some(edge=>edge.edgeMeaning==='relationship'&&edge.relationshipRefs?.includes('character-state')));
  assert.ok(walked.some(edge=>edge.edgeMeaning==='relationship'&&edge.relationshipRefs?.includes('trusts')));
});
