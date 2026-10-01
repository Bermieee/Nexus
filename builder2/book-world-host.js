import {WorldTreeBuilderController} from './world-controller.js';
import {readBuilderWorldContext} from './world-context.js';
import {createNexusWorldBuildStore} from './nexus-plan-store.js';
import {builder2Fingerprint} from './contracts.js';
import {entryFingerprint} from '../builder/content-signature.js';
import {NexusWorldTree} from '../world-tree/store.js';
import {importLegacyLoreBookToWorldTree,loreGroupWorldNodeId,loreBookWorldNodeId} from '../world-tree/import-lore.js';
import {semanticSnapshot} from '../tree/model.js';
import {lorebookOperatorReviewScope,operatorReviewScopeProjection} from '../nexus/review-scope.js';

const ROOT='__nexus_world_root__';
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const publicResult=result=>({...result,preview:result.preview?{...result.preview,nodes:result.preview.nodes.map(n=>({id:n.id,kind:n.kind,parentId:n.parentId,label:n.data?.label??n.id,book:n.data?.book,uid:n.data?.uid,scope:n.scope,temporal:n.temporal,revision:n.revision}))}:null});

// Explicit book authoring is separate from generation's story binding. Its
// projection contains one book, and writes use the existing book review scope,
// Tree lock, recovery journal and verified settings persistence.
export function createLorebookWorldTreeBuilderHost({loadBook,readTree,assertReadableBook,assertWritableBook,ledger,commitMutation,analysis=null,store=null}={}){
  let selected=null,selectionRequest=0;
  const binding=()=>selected?{kind:'lorebook',book:selected.book}:null;
  const requireSelected=(book=null,expected=null)=>{
    if(!selected||book!=null&&book!==selected.book)throw Error('Select and load this Lorebook for authoring first');
    if(expected&&!same(binding(),expected))throw Error('Selected authoring Lorebook changed');
    return binding();
  };
  function refreshProjection(data=selected?.data){
    const book=selected.book,tree=readTree(book),world=new NexusWorldTree();
    assertReadableBook(book);
    importLegacyLoreBookToWorldTree(world,{book,data,legacyTree:tree?.nexusWorldTreeBuild?.cleared?null:tree});
    const wrapper=loreGroupWorldNodeId(book,ROOT);
    for(const node of [...world.iterateNodes()])if(node.parentId===wrapper)world.upsertNode({...node,parentId:loreBookWorldNodeId(book)});
    world.removeNode(wrapper);
    selected={...selected,data:structuredClone(data),tree:structuredClone(tree),world};
    return world;
  }
  const contextReader=async({sourceIds=[]}={})=>{
    const captured=requireSelected(),book=captured.book,request=selectionRequest;
    if(sourceIds.some(id=>!String(id).startsWith(book+'#')))throw Error('Source is outside the selected authoring Lorebook');
    assertReadableBook(book);const data=await loadBook(book);requireSelected(null,captured);
    if(request!==selectionRequest)throw Error('Selected authoring Lorebook changed during source read');
    const world=refreshProjection(data),requested=new Set(sourceIds),sources=Object.values(data.entries??{}).filter(e=>!e.disable&&requested.has(book+'#'+Number(e.uid))).map(e=>({book,uid:Number(e.uid),content:String(e.content??''),title:String(e.comment??e.key?.[0]??e.uid),keys:e.key??[],fingerprint:entryFingerprint(e)}));
    if(sources.length!==requested.size)throw Error('Selected authoring sources changed or are missing');
    const context=readBuilderWorldContext({worldTree:world,selectedSources:sources,authorizedSourceIds:sourceIds});
    context.binding=captured;context.sourceFence=builder2Fingerprint({sources:context.sourceFence,tree:semanticSnapshot(selected.tree),binding:captured});return context;
  };
  const commit=async(tree,{expected=selected?.tree,preflight=null,by='operator'}={})=>{
    const captured=requireSelected(),book=captured.book,request=selectionRequest,prior=semanticSnapshot(expected),reviewScope=lorebookOperatorReviewScope(book);
    assertWritableBook(book);
    const assumptions={book,operatorReviewScope:reviewScope.identity,worldTreeAuthoring:captured};
    const mutation={type:'tree.replace',book,tree:structuredClone(tree),expectedTree:prior,loreDependency:true};
    const tx=ledger.begin({type:'world-tree-book-authoring',assumptions,input:{book},metadata:{source:'explicit-operator-command',reviewScope:operatorReviewScopeProjection(reviewScope)}});
    ledger.executing(tx.id);ledger.parsed(tx.id,{operation:mutation.type});ledger.validated(tx.id,{passed:true});
    ledger.staged(tx.id,{operation:mutation.type},{mutationProposal:{type:mutation.type,draft:mutation,assumptions,approvalRequired:true}});ledger.approve(tx.id,{by});
    const assertCurrent=()=>{requireSelected(null,captured);if(request!==selectionRequest)throw Error('Selected authoring Lorebook changed before write');assertWritableBook(book);if(!same(semanticSnapshot(readTree(book)),prior))throw Error('Authoring Tree changed before write');};
    const result=await commitMutation(tx.id,mutation,{targetLedger:ledger,currentAssumptions:()=>{assertCurrent();return assumptions;},afterIntent:assertCurrent,preflight:async()=>{assertCurrent();await preflight?.();assertCurrent();}});
    if(result?.state!=='committed')throw Error('Authoring Tree write did not commit: '+String(result?.state));
    requireSelected(null,captured);if(request!==selectionRequest)throw Error('Selected authoring Lorebook changed during write');refreshProjection();return result;
  };
  const localId=(book,id)=>id.startsWith('lore-group:'+encodeURIComponent(book)+':')?decodeURIComponent(id.slice(('lore-group:'+encodeURIComponent(book)+':').length)):id;
  function treeForPlan(plan){
    const book=plan.binding.book,root={id:ROOT,label:book,entryUids:[],children:[]},groups=new Map();
    for(const group of plan.organization.groups)if(group.id!=='world:nexus')groups.set(group.id,{id:localId(book,group.id),label:group.label,entryUids:[],children:[]});
    for(const group of plan.organization.groups){const node=groups.get(group.id);if(node)(groups.get(group.parentId)??root).children.push(node);}
    for(const row of plan.organization.placements){const source=plan.sources.find(s=>s.sourceId===row.sourceId);(groups.get(row.parentId)??root).entryUids.push(source.uid);}
    return {lorebookName:book,version:2,root,nexusWorldTreeBuild:{book,cleared:false,runId:plan.runId,fingerprint:plan.review.approvedFingerprint},nexusWorldTreeLayout:selected.tree?.nexusWorldTreeLayout??null};
  }
  const layoutRead=()=>structuredClone(selected?.tree?.nexusWorldTreeLayout??{revision:0,scope:{type:'GLOBAL'},layout:null});
  let controller=null;
  if(analysis)controller=new WorldTreeBuilderController({store:store??createNexusWorldBuildStore(),currentChatId:()=>null,context:contextReader,analysis:(context,options)=>analysis(context,options,{contextReader}),
    mutation:async({plan,assertFresh})=>{requireSelected(null,plan.binding);await commit(treeForPlan(plan),{preflight:assertFresh,by:plan.review.by});return {state:'committed',worldRevision:selected.world.revision};},
    readCommitted:async plan=>{requireSelected(null,plan.binding);const receipt=readTree(selected.book)?.nexusWorldTreeBuild;if(receipt?.runId===plan.runId&&receipt.fingerprint===plan.review.approvedFingerprint){refreshProjection();return {state:'committed',worldRevision:selected.world.revision,replayed:true};}return null;},
    layout:{read:layoutRead,publish:async({expectedLayoutRevision,plan,worldRevision,organizationFingerprint})=>{
      requireSelected(null,plan.binding);refreshProjection();const old=layoutRead(),receipt=selected.tree?.nexusWorldTreeBuild;
      if(receipt?.runId!==plan.runId||receipt.fingerprint!==organizationFingerprint)throw Error('Authoring organization changed before layout');
      if(old.revision!==expectedLayoutRevision)throw Error('Stale authoring layout revision');
      const next={scope:{type:'GLOBAL'},worldRevision,revision:old.revision+1,layout:structuredClone(plan.layout.proposed)};
      await commit({...selected.tree,nexusWorldTreeLayout:next});return next;
    }}});
  const bindings={
    readWorldTreeAuthoringBinding:binding,
    readWorldTreeBuilderChatId:()=>null,
    loadWorldTreeSource:async({id,book:idBook}={})=>{
      const book=String(id??idBook??'').trim();if(!book||book.startsWith('---'))throw Error('Select a Lorebook to load');
      assertReadableBook(book);const request=++selectionRequest,data=await loadBook(book);
      if(request!==selectionRequest)throw Error('Selected authoring Lorebook changed during load');
      selected={book,data};refreshProjection(data);
      return {book,entryCount:Object.values(data.entries??{}).filter(e=>!e.disable).length,worldRevision:selected.world.revision};
    },
    readWorldTreeAuthoringModel:()=>{if(!selected)return null;refreshProjection();return {...selected.world.readUiModel(),worldTreeOrganizationCleared:selected.tree?.nexusWorldTreeBuild?.cleared===true,authoringBinding:binding()};},
    readWorldTreeLayout:()=>{requireSelected();refreshProjection();return layoutRead();},
    readWorldTreeBuildSourceIds:book=>{requireSelected(book);return [...selected.world.iterateNodes()].filter(n=>n.kind==='LORE_FACT'&&!n.data?.disabled).map(n=>selected.book+'#'+n.data.uid);},
    trashWorldTree:async({book}={})=>{requireSelected(book);refreshProjection();await commit({lorebookName:selected.book,version:2,root:{id:ROOT,label:selected.book,entryUids:[],children:[]},nexusWorldTreeBuild:{book:selected.book,cleared:true},nexusWorldTreeLayout:null});return {book:selected.book,organizationCleared:true,layoutCleared:true};},
    saveWorldTreeLayoutPins:async pins=>{requireSelected();refreshProjection();const old=layoutRead();if(!old.layout)throw Error('Apply a build before saving pins');for(const id of Object.keys(pins))if(!selected.world.getNode(id))throw Error('Pin is outside the selected authoring Lorebook');const next={...old,revision:old.revision+1,layout:{...old.layout,pins:{...old.layout.pins,...pins},positions:{...old.layout.positions,...pins}}};await commit({...selected.tree,nexusWorldTreeLayout:next});return next;},
  };
  if(controller){
    bindings.startWorldTreeBuild=async input=>{requireSelected();assertWritableBook(selected.book);return publicResult(await controller.start({...input,chatId:null}));};
    for(const [method,action] of Object.entries({readWorldTreeBuild:'read',reviseWorldTreeBuild:'revise',approveWorldTreeBuild:'approve',applyWorldTreeBuild:'apply',cancelWorldTreeBuild:'cancel',resumeWorldTreeBuild:'resume',retryWorldTreeBuildLayout:'retryLayout',reviewWorldTreeBuildLayout:'reviewLayout'}))bindings[method]=async(id,...args)=>{const run=await controller.read(id);requireSelected();if((run.sourceIds??[]).some(source=>!source.startsWith(selected.book+'#')))throw Error('Review is outside the selected authoring Lorebook');if(run.plan?.binding)requireSelected(null,run.plan.binding);return publicResult(await controller[action](id,...args));};
    bindings.listWorldTreeBuilds=async()=>{const captured=requireSelected();return (await controller.list()).filter(r=>same(r.plan?.binding,captured)).map(publicResult);};
  }
  return bindings;
}
