import {WorldTreeBuilderController} from './world-controller.js';
import {readBuilderWorldContext,adaptWorldContextForBuilder2} from './world-context.js';
import {createNexusWorldBuildStore,createNexusBuilder2PlanStore} from './nexus-plan-store.js';
import {Builder2Pipeline} from './pipeline.js';
import {NexusBuilder2SemanticAdapter} from './nexus-semantic.js';
import {commitWorldBuildThroughNexus} from './nexus-commit-adapter.js';
import {createBuilder2SourceRevision,createBuilder2TreeRevision,builder2Fingerprint} from './contracts.js';
import {getNexusWorldTree,getNexusWorldTreeOwner,requireWorldTreeStoryBinding,readWorldTreeStoryBinding} from '../world-tree/index.js';
import {commitStoryWorldTreeMetadata} from '../world-tree/story-mutation.js';
import {WORLD_BUILD_METADATA_KEY,applyPublishedWorldBuild} from '../world-tree/builder-publication.js';
import {WorldTreeLayoutStore} from '../world-tree/layout-store.js';
import {entryFingerprint} from '../builder/content-signature.js';
import {getNexusLedger} from '../nexus/transaction-service.js';
const commitCanonicalNexusMutation=async(...args)=>(await import('../nexus/mutation-coordinator.js')).commitCanonicalNexusMutation(...args);

const LAYOUT_KEY='nexusWorldTreeLayoutV1';
function uiPreview(preview){
  return {...preview,nodes:preview.nodes.map(n=>({id:n.id,kind:n.kind,parentId:n.parentId,label:n.data?.label??n.id,scope:n.scope,temporal:n.temporal,revision:n.revision})),edges:preview.edges.map(e=>({id:e.id,from:e.from,to:e.to,relation:e.relation,scope:e.scope,temporal:e.temporal,data:e.data}))};
}
export function createWorldTreeBuilderHostBindings({getContext,runtime=null,controller=null,layoutStore=null,ledger=getNexusLedger(),commitMutation=commitCanonicalNexusMutation,readBinding=requireWorldTreeStoryBinding}={}){
  if(!getContext)return {};
  const currentScope=()=>({worldId:'nexus',type:'CHAT',chatId:getContext()?.chatId});
  const hydrate=()=>{readBinding();return getNexusWorldTree();};
  const commitMetadata=input=>commitStoryWorldTreeMetadata({...input,getContext,readBinding,ledger,commitMutation});
  const layouts=new Map();
  const presentation=()=>{
    if(layoutStore)return layoutStore;
    const binding=readBinding(),context=getContext(),chatId=binding.chatId;
    const publication=context.chatMetadata?.[WORLD_BUILD_METADATA_KEY];
    const organizationFingerprint=builder2Fingerprint(publication??null);
    const cacheKey=JSON.stringify([binding,publication?.revision??0,publication?.lastRunId??null]);
    if(layouts.has(cacheKey))return layouts.get(cacheKey);
    let previous=context.chatMetadata?.[LAYOUT_KEY]??null;
    const store=new WorldTreeLayoutStore({save:async state=>{
      if(getContext()?.chatId!==chatId)throw Error('Layout chat changed');
      const value={...state,binding};
      const result=await commitMetadata({key:LAYOUT_KEY,value,expected:previous,type:'world-tree-layout',preflight:()=>{
        readBinding({write:true,expected:binding});
        if(builder2Fingerprint(getContext()?.chatMetadata?.[WORLD_BUILD_METADATA_KEY]??null)!==organizationFingerprint)throw Error('Layout organization changed');
      }});
      if(result.state!=='committed')throw Error(`Layout save ${result.state}`);previous=value;

    }});
    if(previous&&JSON.stringify(previous.binding)===JSON.stringify(binding)&&JSON.stringify(previous)!==publication?.clearedLayoutFingerprint)store.restore(previous);layouts.set(cacheKey,store);return store;
  };
  const contextReader=async({sourceIds=[],chatId}={})=>{
    const binding=readBinding();
    if(sourceIds.some(id=>!String(id).startsWith(binding.book+'#')))throw Error('Builder source is outside the active story binding');
    const {loadBook}=await import('../lore/store.js');const {assertReadableBook}=await import('../lore/policy.js');
    readBinding({expected:binding});
    if(String(getContext()?.chatId)!==String(chatId))throw Error('Builder chat changed');
    const world=hydrate(),requested=new Set(sourceIds),sources=[];
    const nodes=[...world.iterateNodes({chatId})].filter(n=>n.kind==='LORE_FACT'&&requested.has(`${n.data.book}#${Number(n.data.uid)}`));
    const books=new Map();for(const node of nodes){const book=node.data.book;assertReadableBook(book);if(!books.has(book))books.set(book,await loadBook(book));
      const entry=Object.values(books.get(book).entries??{}).find(e=>Number(e.uid)===Number(node.data.uid));
      if(!entry||entry.disable)throw Error(`Selected source missing or disabled: ${book}#${node.data.uid}`);
      sources.push({book,uid:Number(entry.uid),fingerprint:entryFingerprint(entry),content:String(entry.content??''),title:String(entry.comment??entry.key?.[0]??node.data.label),keys:entry.key??[]});
    }
    if(sources.length!==requested.size)throw Error('Selected sources are not all available in the canonical World Tree');
    readBinding({expected:binding});
    const result=readBuilderWorldContext({worldTree:world,chatId,selectedSources:sources,authorizedSourceIds:[...requested]});
    result.binding=binding;result.sourceFence=builder2Fingerprint({sourceFence:result.sourceFence,binding});return result;
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
      mutation:input=>commitWorldBuildThroughNexus({...input,getContext,worldTree:getNexusWorldTreeOwner(),ledger,commitMutation,readBinding}),
      readCommitted:async plan=>{const binding=readBinding({write:true,expected:plan.binding??undefined}),context=getContext(),receipt=context?.chatMetadata?.[WORLD_BUILD_METADATA_KEY];if(plan.scope.chatId!==binding.chatId||receipt?.chatId!==binding.chatId||receipt?.book!==binding.book||JSON.stringify(receipt.binding)!==JSON.stringify(binding)||receipt?.lastRunId!==plan.runId||receipt.lastFingerprint!==plan.review?.approvedFingerprint)return null;applyPublishedWorldBuild(getNexusWorldTreeOwner(),receipt);return {state:'committed',worldRevision:getNexusWorldTree().revision,organizationRevision:receipt.revision,replayed:true};},
      layout:{read:scope=>presentation().read(scope),publish:async({scope,organizationFingerprint,worldRevision,expectedLayoutRevision,plan,preview})=>{
        readBinding({write:true,expected:plan.binding??undefined});
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
  const trashWorldTree=async({book=null}={})=>{
    const binding=readBinding({book,write:true}),context=getContext();
    const prior=context.chatMetadata?.[WORLD_BUILD_METADATA_KEY]??null;
    const alreadyCleared=prior?.cleared===true&&prior.chatId===binding.chatId&&prior.book===binding.book;
    if(!alreadyCleared){
      const value={contract:'nexus-world-tree-organization/v1',chatId:binding.chatId,book:binding.book,binding,
        revision:(prior?.revision??0)+1,cleared:true,nodes:[],edges:[],
        clearedLayoutFingerprint:JSON.stringify(context.chatMetadata?.[LAYOUT_KEY]??null)};
      const result=await commitMetadata({key:WORLD_BUILD_METADATA_KEY,value,expected:prior,type:'world-tree-trash',preflight:()=>readBinding({write:true,expected:binding})});
      if(result?.state!=='committed')throw Error('World Tree organization clear did not commit');
    }
    layouts.clear();
    const view=hydrate();
    if([...view.iterateNodes({chatId:binding.chatId})].some(n=>n.kind==='LORE_GROUP'))throw Error('World Tree organization clear is not reflected in the story read');
    return {kind:'NexusWorldTreeTrashReceipt',book:binding.book,chatId:binding.chatId,legacyTreeDeleted:false,
      organizationCleared:true,layoutCleared:true,alreadyCleared,worldRevision:view.revision};
  };

  const publicResult=result=>({...result,preview:result.preview?uiPreview(result.preview):null,plan:result.plan?{...result.plan,sources:result.plan.sources.map(({content,...s})=>s)}:null});
  const assertRecord=async id=>{const binding=readBinding();const record=await controller.read(id);readBinding({expected:binding});if(String(record.chatId)!==binding.chatId||(record.sourceIds??record.plan?.sources?.map(s=>s.sourceId)??[]).some(id=>!String(id).startsWith(binding.book+'#')))throw Error('Builder review is outside the active story binding');return record;};
  const call=method=>async(...args)=>{const record=await assertRecord(args[0]);if(!['read','resume','cancel'].includes(method))readBinding({write:true,expected:record.plan?.binding??undefined});return publicResult(await controller[method](...args));};
  const bindings={readWorldTreeBuilderChatId:()=>getContext()?.chatId,readWorldTreeStoryBinding,hydrateWorldTreeBuilder:hydrate,readWorldTreeLayout:()=>{hydrate();return presentation().read(currentScope());},
    readWorldTreeBuildSourceIds:book=>{const binding=readBinding({book});return [...hydrate().iterateNodes({chatId:binding.chatId})].filter(n=>n.kind==='LORE_FACT'&&n.data.book===binding.book).map(n=>`${n.data.book}#${Number(n.data.uid)}`);},
    saveWorldTreeLayoutPins:async pins=>{readBinding({write:true});for(const id of Object.keys(pins??{}))if(!hydrate().getNode(id,{chatId:getContext()?.chatId}))throw Error('Pin is outside the active story binding');const scope=currentScope(),old=presentation().read(scope);if(!old.layout)throw Error('Apply a build before saving pins');return presentation().publish({scope,worldRevision:hydrate().revision,expectedLayoutRevision:old.revision,layout:{...old.layout,pins:{...old.layout.pins,...pins},positions:{...old.layout.positions,...pins}}});},
    trashWorldTree};
  if(controller)Object.assign(bindings,{startWorldTreeBuild:async input=>{const binding=readBinding({write:true});if(input?.sourceIds?.some(id=>!String(id).startsWith(binding.book+'#')))throw Error('Builder source is outside the active story binding');return publicResult(await controller.start({...input,chatId:binding.chatId}));},
    listWorldTreeBuilds:async()=>{const binding=readBinding();return (await controller.list()).filter(r=>r.chatId===binding.chatId&&(r.sourceIds??[]).every(id=>String(id).startsWith(binding.book+'#'))).map(publicResult);},
    readWorldTreeBuild:call('read'),reviseWorldTreeBuild:call('revise'),approveWorldTreeBuild:call('approve'),applyWorldTreeBuild:call('apply'),cancelWorldTreeBuild:call('cancel'),resumeWorldTreeBuild:call('resume'),retryWorldTreeBuildLayout:call('retryLayout'),reviewWorldTreeBuildLayout:call('reviewLayout')});
  return bindings;
}
