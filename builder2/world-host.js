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
      const result=await commitCanonicalNexusMutation(tx.id,mutation,{context,targetLedger:ledger,currentAssumptions:assumptions});
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
    const store=createNexusWorldBuildStore();
    controller=new WorldTreeBuilderController({context:contextReader,store,currentChatId:()=>getContext()?.chatId,
      analysis:async(context,{runId,mode,signal})=>{
        const semanticStore=createNexusBuilder2PlanStore(),semanticRun=`${runId}:analysis`,adapted=adaptWorldContextForBuilder2(context);
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
      layout:{read:scope=>presentation().read(scope),publish:async({scope,worldRevision,expectedLayoutRevision,plan,preview})=>{
        const owner=hydrate();if(owner.revision!==worldRevision)throw Error('Layout world revision changed');
        const layout=plan.layout.proposed;
        if(!layout?.coverage?.complete)throw Error('Reviewed layout is incomplete');
        return presentation().publish({scope,worldRevision,expectedLayoutRevision,layout});
      }}});
  }
  const publicResult=result=>({...result,preview:result.preview?uiPreview(result.preview):null,plan:result.plan?{...result.plan,sources:result.plan.sources.map(({content,...s})=>s)}:null});
  const call=method=>async(...args)=>publicResult(await controller[method](...args));
  const bindings={readWorldTreeBuilderChatId:()=>getContext()?.chatId,hydrateWorldTreeBuilder:hydrate,readWorldTreeLayout:()=>{hydrate();return presentation().read(currentScope());},
    saveWorldTreeLayoutPins:async pins=>{const scope=currentScope(),old=presentation().read(scope);if(!old.layout)throw Error('Apply a build before saving pins');return presentation().publish({scope,worldRevision:hydrate().revision,expectedLayoutRevision:old.revision,layout:{...old.layout,pins:{...old.layout.pins,...pins},positions:{...old.layout.positions,...pins}}});}};
  if(controller)Object.assign(bindings,{startWorldTreeBuild:async input=>publicResult(await controller.start({...input,chatId:getContext()?.chatId})),
    readWorldTreeBuild:call('read'),reviseWorldTreeBuild:call('revise'),approveWorldTreeBuild:call('approve'),applyWorldTreeBuild:call('apply'),cancelWorldTreeBuild:call('cancel'),resumeWorldTreeBuild:call('resume'),retryWorldTreeBuildLayout:call('retryLayout')});
  return bindings;
}
