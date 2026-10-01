import {readWorldGraphReferenceDiagnostics} from './diagnostics.js';
import {createCanonicalWorldTreeReadApi} from '../core/world-tree-api.js';
import {currentNexusLoreSourceRevision} from '../nexus/lore-source-revision.js';
import {NativeGraphNeighborhoodRetriever} from '../nexus/a52/graph-neighborhood-retriever.js';
import {createWorldTreeGraphProvider} from '../nexus/a52/sensory/walker/world-tree-provider.js';

// No saved provider closures or story bodies. Reconstruct a bounded read only
// while the selected generation's canonical source fence is still current.
export function inspectSelectedWorldGraph(selection={},currentChatId=null){
 if(currentChatId==null||String(currentChatId)!==String(selection.chatId))return null;
 const worldTree=createCanonicalWorldTreeReadApi({chatId:selection.chatId});
 return readWorldGraphReferenceDiagnostics(selection,{
  isCurrent:plan=>worldTree.worldRevision===plan.worldRevision&&plan.sourceRevisionRefs.includes(currentNexusLoreSourceRevision(plan.books)),
  readReferences:plan=>{
   const walker=new NativeGraphNeighborhoodRetriever({temporalGraph:{allClaims:()=>[],readReferences:()=>({references:[]})},isSourceRevisionCurrent:ref=>plan.sourceRevisionRefs.includes(String(ref)),limits:{maxDepth:3,maxNodes:96,maxEdges:192,maxCandidates:32,latencyBudgetMs:15}});
   walker.registerProvider(createWorldTreeGraphProvider({worldTree,chatId:selection.chatId,sourceRevisionRefs:plan.sourceRevisionRefs,maxDerivedEdges:384}));
   return walker.referenceSet({intentKind:plan.intentKind,entityRefs:plan.anchorEntityIds},{chatId:selection.chatId,worldRevision:plan.worldRevision,sourceRevisionSet:plan.sourceRevisionRefs});
  },
 });
}
