import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NexusWorldTree } from '../world-tree/store.js';
import { boundCharacterWorldNodeId, importLegacyCharacterBanksToWorldTree, characterStateWorldNodeId, localCharacterWorldNodeId } from '../world-tree/import-character-banks.js';
import { buildWorldTreeCardContribution, runWorldTreeCardContributionJob } from '../world-tree/card-contribution.js';
import { drainWorldTreeContributions, readWorldTreeContributionQueue } from '../world-tree/intake/runtime.js';

const context=()=>({chatId:'chat-a',chatMetadata:{},saveMetadataDebounced(){}});
const bank=(binding=true)=>({id:'bank-1',storyId:'chat-a',enabled:true,character:'Mara',role:'supporting',sceneAware:true,cardBinding:binding?{avatar:'mara.png',name:'Mara',fingerprint:'fp1'}:null,linkedRefs:[],memoryIds:[],memoryRefs:[],profile:{},state:{},stateProposals:[],changeHistory:[],fieldProvenance:{},cardSync:{},tracking:{}});
const card=(fingerprint='fp1',name='Mara',description='Mara owns the Ember Tavern and is called Captain Mara.')=>({avatar:'mara.png',name,description,personality:'',scenario:'',firstMessage:'',characterVersion:'1',tags:['Innkeeper'],fingerprint});
function globalNode(tree,id,label,kind='ENTITY'){tree.upsertNode({id,kind,scope:{type:'GLOBAL'},provenance:{sourceType:'TEST',sourceIds:[id]},temporal:{status:'CURRENT'},data:{label,aliases:[label]}});}
function extraction(relation='owns',target='Ember Tavern',snippet='owns the Ember Tavern'){return{aliases:['Captain Mara'],facts:[{field:'description',relation,target,targetKind:'ENTITY',subtype:null,snippet}]};}

test('card contribution contains one stable global tracked identity and only hashed source snippets',()=>{
  const input=buildWorldTreeCardContribution({bank:bank(),card:card(),extraction:extraction()});
  assert.equal(input.nodes[0].tempId,boundCharacterWorldNodeId('mara.png'));assert.equal(input.nodes[0].kind,'CHARACTER');assert.equal(input.nodes[0].fields.trackedCharacter,true);
  assert.ok(input.nodes[0].fields.aliases.includes('Captain Mara'));assert.ok(input.edges.every(edge=>edge.authority==='CARD'));assert.ok(input.edges.some(edge=>edge.sourceField==='description'&&edge.sourceSnippetHash));
  const serialized=JSON.stringify(input);assert.equal(serialized.includes('owns the Ember Tavern and is called'),false,'raw card body must not be persisted in the contribution');
});

test('post-card job queues one contribution per revision and same revision short-circuits before another model call',async()=>{
  const tree=new NexusWorldTree(),ctx=context();globalNode(tree,'place:ember','Ember Tavern','LOCATION');globalNode(tree,'role:innkeeper','Innkeeper');
  let calls=0;const enqueue=()=>({promise:Promise.resolve({structuredPayload:(calls++,extraction())})});
  const first=await runWorldTreeCardContributionJob({context:ctx,tree,banks:[bank()],cards:[card()],enqueueSidecar:enqueue});
  assert.equal(first.queuedCount,1);assert.equal(calls,1);assert.equal(readWorldTreeContributionQueue({context:ctx}).length,1);
  const drain=await drainWorldTreeContributions({context:ctx,tree,isFresh:()=>true});assert.equal(drain.appliedCount,1);
  const node=tree.getNode(boundCharacterWorldNodeId('mara.png'));assert.equal(node.kind,'CHARACTER');assert.equal(node.data.trackedCharacter,true);
  assert.equal(tree.identityRegistry.resolveMention({label:'Captain Mara',entityType:'CHARACTER'}).entity?.entityId,node.id);
  const second=await runWorldTreeCardContributionJob({context:ctx,tree,banks:[bank()],cards:[card()],enqueueSidecar:enqueue});assert.equal(second.skipped,true);assert.equal(calls,1);
});

test('card revision supersedes prior card-owned fact edges instead of deleting them',async()=>{
  const tree=new NexusWorldTree(),ctx=context();globalNode(tree,'place:ember','Ember Tavern','LOCATION');globalNode(tree,'group:guild','Guild');
  let response=extraction();const enqueue=()=>({promise:Promise.resolve({structuredPayload:response})});
  await runWorldTreeCardContributionJob({context:ctx,tree,banks:[bank()],cards:[card('fp1')],enqueueSidecar:enqueue});await drainWorldTreeContributions({context:ctx,tree});
  const prior=tree.read({limit:5000}).edges.find(edge=>edge.data?.sourceField==='description'&&edge.temporal.status==='CURRENT');assert(prior);assert.equal(prior.data.sourceSnippetHash.length,8);
  response={aliases:['Captain Mara'],facts:[{field:'description',relation:'member-of',target:'Guild',targetKind:'ENTITY',subtype:null,snippet:'member of the Guild'}]};
  const revisedCard=card('fp2','Mara','Mara is a member of the Guild and is called Captain Mara.');
  await runWorldTreeCardContributionJob({context:ctx,tree,banks:[bank()],cards:[revisedCard],enqueueSidecar:enqueue});await drainWorldTreeContributions({context:ctx,tree});
  assert.equal(tree.getEdge(prior.id)?.temporal.status,'SUPERSEDED');assert.ok(tree.read({limit:5000}).edges.some(edge=>edge.relation==='member-of'&&edge.temporal.status==='CURRENT'));
});

test('an unresolved global card fact does not reject the character identity revision',async()=>{
  const tree=new NexusWorldTree(),ctx=context();const enqueue=()=>({promise:Promise.resolve({structuredPayload:{aliases:[],facts:[{field:'description',relation:'owns',target:'Unknown Tavern',targetKind:'ENTITY',subtype:null,snippet:'owns the Unknown Tavern'}]}})});
  const unknown=card('fp-unknown','Mara','Mara owns the Unknown Tavern.');
  const produced=await runWorldTreeCardContributionJob({context:ctx,tree,banks:[bank()],cards:[unknown],enqueueSidecar:enqueue});assert.equal(produced.queuedCount,1);
  const drained=await drainWorldTreeContributions({context:ctx,tree});assert.equal(drained.appliedCount,1);assert.equal(drained.rejectedCount,0);
  assert.ok(tree.getNode(boundCharacterWorldNodeId('mara.png')));assert.equal(tree.read({limit:5000}).edges.some(edge=>edge.data?.sourceField==='description'),false);
});

test('authoritative card rename updates the same identity and keeps the old label resolvable',async()=>{
  const tree=new NexusWorldTree(),ctx=context();let response={aliases:[],facts:[]};const enqueue=()=>({promise:Promise.resolve({structuredPayload:response})});
  await runWorldTreeCardContributionJob({context:ctx,tree,banks:[bank()],cards:[card('fp1','Mara','')],enqueueSidecar:enqueue});await drainWorldTreeContributions({context:ctx,tree});
  await runWorldTreeCardContributionJob({context:ctx,tree,banks:[bank()],cards:[card('fp2','Captain Mara','')],enqueueSidecar:enqueue});await drainWorldTreeContributions({context:ctx,tree});
  const id=boundCharacterWorldNodeId('mara.png');assert.equal(tree.getNode(id).data.label,'Captain Mara');assert.equal(tree.identityRegistry.resolveMention({label:'Mara',entityType:'CHARACTER'}).entity?.entityId,id);
});

test('invalid model extraction is dropped atomically with no partial card mutation',async()=>{
  const tree=new NexusWorldTree(),ctx=context(),before=tree.revision;
  const enqueue=()=>({promise:Promise.resolve({structuredPayload:{aliases:[],facts:[{field:'description',relation:'owns',target:'Ember Tavern',targetKind:'ENTITY',snippet:'hallucinated text'}]}})});
  const result=await runWorldTreeCardContributionJob({context:ctx,tree,banks:[bank()],cards:[card()],enqueueSidecar:enqueue});
  assert.equal(result.failed,true);assert.equal(readWorldTreeContributionQueue({context:ctx}).length,0);assert.equal(tree.revision,before);
});

test('a removed unbound bank can restore its prior revision because intake replays a historical lineage key',()=>{
  const tree=new NexusWorldTree(),source=bank(false);importLegacyCharacterBanksToWorldTree(tree,{chatId:'chat-a',banks:[source],control:{enabled:true}});
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'chat-a',banks:[],control:{enabled:true}});
  assert.equal(tree.getNode(characterStateWorldNodeId('chat-a','bank-1'),{chatId:'chat-a'}).temporal.status,'SUPERSEDED');
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'chat-a',banks:[source],control:{enabled:true}});
  assert.equal(tree.getNode(characterStateWorldNodeId('chat-a','bank-1'),{chatId:'chat-a'}).temporal.status,'CURRENT');
});

test('legacy Character Bank import is intake-owned, keeps unbound identity/state chat-local, and never directly mutates the tree',()=>{
  const tree=new NexusWorldTree(),source=bank(false);importLegacyCharacterBanksToWorldTree(tree,{chatId:'chat-a',banks:[source],control:{enabled:true}});
  assert.equal(tree.getNode(localCharacterWorldNodeId('chat-a','bank-1'),{chatId:'chat-a'}).scope.type,'CHAT');assert.equal(tree.getNode(characterStateWorldNodeId('chat-a','bank-1'),{chatId:'chat-a'}).scope.type,'CHAT');
  const code=fs.readFileSync(new URL('../world-tree/import-character-banks.js',import.meta.url),'utf8');assert.ok(code.includes('applyDeterministicWorldTreeContribution'));assert.equal(code.includes('tree.upsertNode('),false);assert.equal(code.includes('tree.linkEdge('),false);
});

test('scheduler exposes worldtree.contribute.card before intake and intake waits for it',()=>{
  const jobs=fs.readFileSync(new URL('../scheduler/jobs.js',import.meta.url),'utf8');assert.ok(jobs.includes("id:'worldtree.contribute.card'"));assert.ok(jobs.includes("'worldtree.contribute.card','postturn.review'"));
});
