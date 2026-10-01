import {WorldTreeBuilderController} from './world-controller.js';
import {readBuilderWorldContext,adaptWorldContextForBuilder2} from './world-context.js';
import {createNexusWorldBuildStore,createNexusBuilder2PlanStore} from './nexus-plan-store.js';
import {Builder2Pipeline} from './pipeline.js';
import {NexusBuilder2SemanticAdapter} from './nexus-semantic.js';
import {commitWorldBuildThroughNexus} from './nexus-commit-adapter.js';
import {createBuilder2SourceRevision,createBuilder2TreeRevision,builder2Fingerprint} from './contracts.js';
import {getNexusWorldTree} from '../world-tree/index.js';
import {WORLD_BUILD_METADATA_KEY,applyPublishedWorldBuild} from '../world-tree/builder-publication.js';
import {WorldTreeLayoutStore} from '../world-tree/layout-store.js';
import {planWorldTreeLayout} from '../world-tree/layout.js';
import {entryFingerprint} from '../builder/content-signature.js';
import {getNexusLedger,persistNexusReviewTransaction} from '../nexus/transaction-service.js';
const commitCanonicalNexusMutation=async(...args)=>(await import('../nexus/mutation-coordinator.js')).commitCanonicalNexusMutation(...args);

const LAYOUT_KEY='nexusWorldTreeLayoutV1';
function uiPreview(preview){
  return {...preview,nodes:preview.nodes.map(n=>({id:n.id,kind:n.kind,parentId:n.parentId,label:n.data?.label??n.id,scope:n.scope,temporal:n.temporal,revision:n.revision})),edges:preview.edges.map(e=>({id:e.id,from:e.from,to:e.to,relation:e.relation,scope:e.scope,temporal:e.temporal,data:e.data}))};
}
export function createWorldTreeBuilderHostBindings({getContext,runtime=null,controller=null,layoutStore=null}={}){
  if(!getContext)return {};
  const currentScope=()=>({worldId:'nexus',type:'CHAT',chatId:getContext()?.chatId});
  const hydrate=()=>{
    const context=getContext(),world=getNexusWorldTree();
    if(context?.chatId)applyPublishedWorldBuild(world,context.chatMetadata?.[WORLD_BUILD_METADATA_KEY]);
    return world;
  };
  const layouts=new Map();
  const presentation=()=>{
    if(layoutStore)return layoutStore;
    const context=getContext(),chatId=context?.chatId;if(!chatId)throw Error('Builder requires active chat');
    if(layouts.has(chatId))return layouts.get(chatId);
    let previous=context.chatMetadata?.[LAYOUT_KEY]??null;
    const store=new WorldTreeLayoutStore({save:async state=>{
      if(getContext()?.chatId!==chatId)throw Error('Layout chat changed');
      const ledger=getNexusLedger(),mutation={type:'metadata.set',chatId,key:LAYOUT_KEY,value:state,expected:previous??undefined};
      const assumptions={chatId,layoutFingerprint:builder2Fingerprint(previous)};
      const tx=ledger.begin({type:'world-tree-layout',assumptions,input:{chatId}});
      ledger.executing(tx.id);ledger.parsed(tx.id,{layout:true});ledger.validated(tx.id,{passed:true});ledger.staged(tx.id,{layout:true},{mutationProposal:{type:'metadata.set',draft:mutation,assumptions,approvalRequired:true}});ledger.approve(tx.id,{by:'operator'});
      await persistNexusReviewTransaction(tx.id);
      const result=await commitCanonicalNexusMutation(tx.id,mutation,{context,targetLedger:ledger,currentAssumptions:assumptions,preflight:()=>{const live=getContext();if(live?.chatId!==chatId||live.chatMetadata!==context.chatMetadata||JSON.stringify(live.chatMetadata?.[LAYOUT_KEY]??null)!==JSON.stringify(previous))throw Error('Layout metadata changed');}});
      if(result.state!=='committed')throw Error(`Layout save ${result.state}`);previous=state;
    }});
    if(previous)store.restore(previous);layouts.set(chatId,store);return store;
  };
  const contextReader=async({sourceIds=[],chatId}={})=>{
    const {loadBook}=await import('../lore/store.js');const {assertReadableBook}=await import('../lore/policy.js');
    if(String(getContext()?.chatId)!==String(chatId))throw Error('Builder chat changed');
    const world=hydrate(),requested=new Set(sourceIds),sources=[];
    const nodes=[...world.iterateNodes({chatId})].filter(n=>n.kind==='LORE_FACT'&&requested.has(`${n.data.book}#${Number(n.data.uid)}`));
    const books=new Map();for(const node of nodes){const book=node.data.book;assertReadableBook(book);if(!books.has(book))books.set(book,await loadBook(book));
      const entry=Object.values(books.get(book).entries??{}).find(e=>Number(e.uid)===Number(node.data.uid));
      if(!entry||entry.disable)throw Error(`Selected source missing or disabled: ${book}#${node.data.uid}`);
      sources.push({book,uid:Number(entry.uid),fingerprint:entryFingerprint(entry),content:String(entry.content??''),title:String(entry.comment??entry.key?.[0]??node.data.label),keys:entry.key??[]});
    }
    if(sources.length!==requested.size)throw Error('Selected sources are not all available in the canonical World Tree');
    return readBuilderWorldContext({worldTree:world,chatId,selectedSources:sources,authorizedSourceIds:[...requested]});
  };
  if(!controller&&runtime?.director&&runtime?.coordinator){
    let store;try{store=createNexusWorldBuildStore();}catch(error){return {worldTreeBuilderUnavailableReason:error.message};}
    controller=new WorldTreeBuilderController({context:contextReader,store,currentChatId:()=>getContext()?.chatId,
      analysis:async(context,{runId,analysisRevision=1,mode,signal})=>{
        const semanticStore=createNexusBuilder2PlanStore(),semanticRun=`${runId}:analysis:${analysisRevision}`,adapted=adaptWorldContextForBuilder2(context);
        const semantic=new NexusBuilder2SemanticAdapter({runtime,store:semanticStore,runId:semanticRun});
        const pipeline=new Builder2Pipeline({store:semanticStore,semantic,signal,contextLoader:async()=>adapted,readCurrentAuthority:async()=>{
          const current=adaptWorldContextForBuilder2(await contextReader({sourceIds:context.sources.map(s=>s.sourceId),chatId:context.scope.chatId}));
          return {sourceRevision:createBuilder2SourceRevision(current.worksetSources).revisionId,corpusRevision:createBuilder2SourceRevision(current.corpusSources).revisionId,treeRevision:createBuilder2TreeRevision(current.treeInventory)?.revisionId};
        }});
        const existing=await semanticStore.read(semanticRun);
        const step=existing?await pipeline.resume(semanticRun):await pipeline.startWorldContext(context,{runId:semanticRun,metadata:{reviewFlow:'consolidated',semanticResource:'model-worker',validateOnly:true}});
        const plan=step.plan,byTaxon=new Map();
        for(const taxon of plan.taxonomy?.nodes??[])byTaxon.set(taxon.taxonId,taxon.canonicalNodeId??`world-build-group:${encodeURIComponent(context.scope.chatId)}:${builder2Fingerprint(taxon.taxonId)}`);
        const groups=(plan.taxonomy?.nodes??[]).map(t=>({id:byTaxon.get(t.taxonId),label:t.label,parentId:byTaxon.get(t.parentTaxonId)??'world:nexus'}));
        const placements=[],coverage=[];
        for(const source of context.sources){const decision=(plan.classifications??[]).find(c=>c.sourceKey===source.sourceId),parentId=byTaxon.get(decision?.taxonId);
          if(parentId&&decision.decision==='classified'){placements.push({sourceId:source.sourceId,parentId});coverage.push({sourceId:source.sourceId,disposition:'PLACED'});}
          else coverage.push({sourceId:source.sourceId,disposition:'UNRESOLVED',reason:decision?.reason??'Builder analysis requires placement review'});
        }
        return {organization:{groups,placements},coverage,layout:{mode,seed:context.scope.chatId}};
      },
      mutation:input=>commitWorldBuildThroughNexus({...input,getContext,worldTree:getNexusWorldTree(),ledger:getNexusLedger(),commitMutation:commitCanonicalNexusMutation,persistTransaction:persistNexusReviewTransaction}),
      readCommitted:async plan=>{const context=getContext(),receipt=context?.chatMetadata?.[WORLD_BUILD_METADATA_KEY];if(receipt?.lastRunId!==plan.runId||receipt.lastFingerprint!==plan.review?.approvedFingerprint)return null;applyPublishedWorldBuild(getNexusWorldTree(),receipt);return {state:'committed',worldRevision:getNexusWorldTree().revision,organizationRevision:receipt.revision,replayed:true};},
      layout:{read:scope=>presentation().read(scope),publish:async({scope,organizationFingerprint,worldRevision,expectedLayoutRevision,plan,preview})=>{
        const owner=hydrate(),receipt=getContext()?.chatMetadata?.[WORLD_BUILD_METADATA_KEY];
        const original=(receipt?.lastRunId===plan.runId&&receipt.lastFingerprint===organizationFingerprint);
        const retained=receipt&&(plan.organization.groups.every(g=>g.id==='world:nexus'||owner.getNode(g.id,{chatId:scope.chatId}))&&plan.organization.placements.every(p=>{
          const source=plan.sources.find(s=>s.sourceId===p.sourceId),node=[...owner.iterateNodes({chatId:scope.chatId})].find(n=>n.kind==='LORE_FACT'&&n.data.book===source?.book&&Number(n.data.uid)===Number(source?.uid));
          return node&&receipt.edges.some(e=>e.data?.primaryPlacement&&e.to===node.id&&e.from===p.parentId);
        }));
        if(!original&&!retained)throw Error('Accepted organization changed; create a new build review');
        const layout=plan.layout.proposed;
        if(!layout?.coverage?.complete)throw Error('Reviewed layout is incomplete');
        const current=presentation().read(scope);
        if(current.layout?.buildFingerprint===plan.review.approvedFingerprint)return current;
        if(current.revision!==expectedLayoutRevision)throw Error('Presentation changed; layout requires a new review');
        return presentation().publish({scope,worldRevision:owner.revision,expectedLayoutRevision,layout:{...layout,buildFingerprint:plan.review.approvedFingerprint}});
      }}});
  }
  const commitOperatorMutation=async({type,mutation,context=null,assumptions={}}={})=>{
    const ledger=getNexusLedger(),tx=ledger.begin({type,assumptions,input:{chatId:mutation?.chatId??null,book:mutation?.book??null}});
    ledger.executing(tx.id);ledger.parsed(tx.id,{operation:mutation.type});ledger.validated(tx.id,{passed:true});
    ledger.staged(tx.id,{operation:mutation.type},{mutationProposal:{type:mutation.type,draft:mutation,assumptions,approvalRequired:true}});
    ledger.approve(tx.id,{by:'operator'});await persistNexusReviewTransaction(tx.id);
    return commitCanonicalNexusMutation(tx.id,mutation,{context,targetLedger:ledger,currentAssumptions:assumptions});
  };
  const trashWorldTree=async({book=null}={})=>{
    const context=getContext(),chatId=String(context?.chatId??'').trim(),id=String(book??'').trim();
    if(!chatId)throw Error('Trash Tree requires an active chat.');
    if(!id)throw Error('Trash Tree requires the active Lorebook so authored Lore can be preserved.');
    const {treeBaseline}=await import('../tree/store.js');
    const legacyBaseline=treeBaseline(id);
    if(legacyBaseline){
      const mutation={type:'tree.delete',book:id,expectedTree:legacyBaseline};
      const result=await commitOperatorMutation({type:'world-tree-trash-legacy',mutation,assumptions:{book:id,expectedTree:legacyBaseline}});
      if(result?.state!=='committed')throw Error('Legacy Tree deletion did not commit.');
    }
    for(const key of [WORLD_BUILD_METADATA_KEY,LAYOUT_KEY]){
      if(!Object.prototype.hasOwnProperty.call(context.chatMetadata??{},key))continue;
      const expected=structuredClone(context.chatMetadata[key]);
      const mutation={type:'metadata.set',chatId,key,delete:true,expected};
      const result=await commitOperatorMutation({type:'world-tree-trash-metadata',mutation,context,assumptions:{chatId,key,expected}});
      if(result?.state!=='committed')throw Error('World Tree metadata deletion did not commit for '+key+'.');
    }
    layouts.delete(chatId);
    const world=getNexusWorldTree();
    const snapshot=world.read({chatId,includeOverlays:false,limit:5000});
    for(const edge of snapshot.edges??[]){
      if(edge.scope?.type==='CHAT'&&String(edge.scope?.chatId??'')===chatId&&['BUILDER_ORGANIZATION','BUILDER_RELATIONSHIP'].includes(String(edge.provenance?.sourceType??'')))world.removeEdge(edge.id,{reason:'trash-world-tree'});
    }
    for(const node of [...world.iterateNodes({chatId})]){
      const builderOwned=node.scope?.type==='CHAT'&&String(node.scope?.chatId??'')===chatId&&node.provenance?.sourceType==='BUILDER_ORGANIZATION';
      const legacyGroup=node.scope?.type==='GLOBAL'&&node.kind==='LORE_GROUP'&&String(node.data?.book??'')===id&&node.provenance?.sourceType==='NEXUS_LEGACY_LORE_TREE';
      if(builderOwned||legacyGroup)world.removeNode(node.id,{reason:'trash-world-tree'});
    }
    const {syncLegacyLoreToWorldTree}=await import('../world-tree/legacy-lore-bridge.js');
    await syncLegacyLoreToWorldTree('ui-trash-world-tree');
    return {kind:'NexusWorldTreeTrashReceipt',book:id,chatId,legacyTreeDeleted:Boolean(legacyBaseline),organizationCleared:true,layoutCleared:true,worldRevision:world.revision};
  };

  const publicResult=result=>({...result,preview:result.preview?uiPreview(result.preview):null,plan:result.plan?{...result.plan,sources:result.plan.sources.map(({content,...s})=>s)}:null});
  const call=method=>async(...args)=>publicResult(await controller[method](...args));
  const bindings={readWorldTreeBuilderChatId:()=>getContext()?.chatId,hydrateWorldTreeBuilder:hydrate,readWorldTreeLayout:()=>{hydrate();return presentation().read(currentScope());},
    readWorldTreeBuildSourceIds:book=>[...hydrate().iterateNodes({chatId:getContext()?.chatId})].filter(n=>n.kind==='LORE_FACT'&&(!book||n.data.book===book)).map(n=>`${n.data.book}#${Number(n.data.uid)}`),
    saveWorldTreeLayoutPins:async pins=>{const scope=currentScope(),old=presentation().read(scope);if(!old.layout)throw Error('Apply a build before saving pins');return presentation().publish({scope,worldRevision:hydrate().revision,expectedLayoutRevision:old.revision,layout:{...old.layout,pins:{...old.layout.pins,...pins},positions:{...old.layout.positions,...pins}}});},
    trashWorldTree};
  if(controller)Object.assign(bindings,{startWorldTreeBuild:async input=>publicResult(await controller.start({...input,chatId:getContext()?.chatId})),
    listWorldTreeBuilds:async()=>Promise.all((await controller.list()).map(publicResult)),
    readWorldTreeBuild:call('read'),reviseWorldTreeBuild:call('revise'),approveWorldTreeBuild:call('approve'),applyWorldTreeBuild:call('apply'),cancelWorldTreeBuild:call('cancel'),resumeWorldTreeBuild:call('resume'),retryWorldTreeBuildLayout:call('retryLayout'),reviewWorldTreeBuildLayout:call('reviewLayout')});
  return bindings;
}
