import { loreFactWorldNodeId } from './import-lore.js';
import { memoryWorldNodeId } from './memory-schema.js';
import { applyDeterministicWorldTreeContribution } from './intake/runtime.js';
import { stableHash } from './intake/contribution.js';
import { characterOwnerRecord, boundCharacterWorldNodeId, localCharacterWorldNodeId, characterStateWorldNodeId, characterControlWorldNodeId } from './character-schema.js';

const clone=value=>value==null?value:structuredClone(value);
const uniq=values=>[...new Set((values??[]).map(value=>String(value??'').trim()).filter(Boolean))];
const normalized=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
const safeId=value=>encodeURIComponent(String(value??''));
function aliases(node){const data=node?.data??{};return uniq([data.label,data.name,data.cardName,...(data.aliases??[])]);}
function mentionsAlias(text,alias){const hay=' '+normalized(text)+' ',needle=' '+normalized(alias)+' ';return needle.length>3&&hay.includes(needle);}
function stateIdentity(bank,chatId){
  const bound=Boolean(bank?.cardBinding?.avatar);
  return{bound,characterNodeId:bound?boundCharacterWorldNodeId(bank.cardBinding.avatar):localCharacterWorldNodeId(chatId,bank.id),stateNodeId:characterStateWorldNodeId(chatId,bank.id)};
}
function stateRevision(bank,{sourceOrder=0,removed=false}={}){
  return stableHash({kind:'character-state-v1',removed:Boolean(removed),sourceOrder:Number(sourceOrder)||0,bank:characterOwnerRecord(bank)});
}
function semanticEdges(tree,bank,{chatId,characterNodeId,stateNodeId}={}){
  if(bank?.enabled===false)return[];
  const edges=[];
  for(const ref of bank?.linkedRefs??[]){
    const book=String(ref?.book??'').trim(),uid=Number(ref?.uid);if(!book||!Number.isFinite(uid))continue;
    const loreId=loreFactWorldNodeId(book,uid);if(!tree.getNode(loreId,{chatId}))continue;
    edges.push({edgeId:'character-lore-evidence:'+safeId(chatId)+':'+safeId(bank.id)+':'+safeId(book)+':'+safeId(uid),from:stateNodeId,to:loreId,meaning:'derived-from',authority:'REMEMBERED',subtype:'linked-lore'});
  }
  const relationshipText=String(bank?.state?.persistent?.relationships??'').trim();
  if(!relationshipText||!tree.getNode(characterNodeId,{chatId}))return edges;
  const seen=new Set();
  for(const target of tree.iterateNodes({chatId,kind:'CHARACTER'})){
    if(String(target.id)===String(characterNodeId)||target.temporal?.status==='SUPERSEDED')continue;
    if(!aliases(target).some(alias=>mentionsAlias(relationshipText,alias))||seen.has(target.id))continue;seen.add(target.id);
    edges.push({edgeId:'character-state-relationship:'+safeId(chatId)+':'+safeId(bank.id)+'->'+safeId(target.id),from:characterNodeId,to:target.id,meaning:'relationship',authority:'REMEMBERED',subtype:'character-state',sourceField:'persistent.relationships',sourceSnippetHash:stableHash(relationshipText)});
  }
  return edges;
}
function memoryEdges(tree,bank,{chatId,stateNodeId}={}){
  const ids=new Set();
  for(const ref of bank?.memoryRefs??[]){if(String(ref?.chatId??'')===String(chatId)&&String(ref?.id??'').trim())ids.add(String(ref.id));}
  for(const id of bank?.memoryIds??[])if(String(id??'').trim())ids.add(String(id));
  const edges=[];
  for(const id of ids){const nodeId=memoryWorldNodeId(chatId,id);if(tree.getNode(nodeId,{chatId}))edges.push({edgeId:'character-memory-edge:'+safeId(chatId)+':'+safeId(bank.id)+':'+safeId(id),from:stateNodeId,to:nodeId,meaning:'has-memory',authority:'REMEMBERED',subtype:'explicit-link'});}
  return edges;
}
export function buildWorldTreeCharacterStateContribution({tree,bank,chatId,sourceOrder=0,removed=false}={}){
  const story=String(chatId??'').trim(),id=String(bank?.id??'').trim();if(!story||!id)throw new Error('WORLD_TREE_CHARACTER_STATE_IDENTITY_INCOMPLETE');
  const order=Math.max(0,Number(sourceOrder)||0),identity=stateIdentity(bank,story),revision=stateRevision(bank,{sourceOrder:order,removed}),label=String(bank.character||bank?.cardBinding?.name||id||'Character').trim();
  const nodes=[];
  if(!identity.bound){
    nodes.push({tempId:identity.characterNodeId,kind:'CHARACTER',label,authority:'CANON',temporalStatus:removed?'SUPERSEDED':bank.enabled===false?'HISTORICAL':'CURRENT',fields:{
      aliases:uniq([bank.character]),unboundCharacter:true,sourcePresent:!removed,identityProviderId:'NEXUS_WORLD_TREE_OWNER',identitySourceEntityId:id,canonicalOwner:'WORLD_TREE',compatibilityMirror:null,nativeCharacterState:true,
    }});
  }
  nodes.push({tempId:identity.stateNodeId,kind:'CHARACTER_STATE',label,authority:'REMEMBERED',temporalStatus:removed?'SUPERSEDED':bank.enabled===false?'HISTORICAL':'CURRENT',fields:{
    role:String(bank.role||'supporting'),sourceBank:characterOwnerRecord(bank),sourcePresent:!removed,sourceOrder:order,enabled:bank.enabled!==false,state:clone(bank.state??{}),profile:clone(bank.profile??{}),
    fieldProvenance:clone(bank.fieldProvenance??{}),cardSync:clone(bank.cardSync??{}),linkedLoreRefs:clone(bank.linkedRefs??[]),memoryRefs:clone(bank.memoryRefs??[]),memoryIds:uniq(bank.memoryIds),
    characterNodeId:identity.characterNodeId,canonicalOwner:'WORLD_TREE',compatibilityMirror:null,nativeCharacterState:true,
  }});
  const edges=[];
  const identityReady=!identity.bound||Boolean(tree?.getNode?.(identity.characterNodeId,{chatId:story}));
  if(!removed&&identityReady)edges.push({edgeId:'character-state-edge:'+safeId(story)+':'+safeId(id),from:identity.stateNodeId,to:identity.characterNodeId,meaning:'state-of',authority:'REMEMBERED',subtype:'character-state'});
  if(!removed)edges.push(...memoryEdges(tree,bank,{chatId:story,stateNodeId:identity.stateNodeId}));
  return{kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:story},sourceRefs:[{characterStateLineageId:'character-state:'+story+':'+id,characterStateId:id,revision}],key:'character-state:'+safeId(id)+':'+revision,mentions:[],nodes,edges};
}
export function buildWorldTreeCharacterStateSemanticContribution({tree,bank,chatId,removed=false}={}){
  const story=String(chatId??'').trim(),id=String(bank?.id??'').trim();if(!story||!id)throw new Error('WORLD_TREE_CHARACTER_STATE_IDENTITY_INCOMPLETE');
  const identity=stateIdentity(bank,story),edges=removed?[]:semanticEdges(tree,bank,{chatId:story,...identity});
  const revision=stableHash({kind:'character-state-semantic-v1',removed:Boolean(removed),id,enabled:bank.enabled!==false,relationships:String(bank?.state?.persistent?.relationships??''),linkedRefs:bank?.linkedRefs??[],edges:edges.map(edge=>[edge.edgeId,edge.from,edge.to,edge.meaning,edge.subtype])});
  return{kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:story},sourceRefs:[{characterStateSemanticLineageId:'character-state-semantic:'+story+':'+id,characterStateId:id,revision}],key:'character-state-semantic:'+safeId(id)+':'+revision,mentions:[],nodes:[],edges};
}
export function buildWorldTreeCharacterControlContribution({chatId,control={enabled:true}}={}){
  const story=String(chatId??'').trim();if(!story)throw new Error('WORLD_TREE_CHARACTER_CONTROL_CHAT_REQUIRED');
  const enabled=control?.enabled!==false,revision=stableHash({kind:'character-control-v1',enabled});
  return{kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:story},sourceRefs:[{characterStateControlLineageId:'character-control:'+story,revision}],key:'character-control:'+revision,mentions:[],edges:[],
    nodes:[{tempId:characterControlWorldNodeId(story),kind:'SUMMARY',label:'Character read control',authority:'CANON',fields:{enabled,canonicalOwner:'WORLD_TREE',compatibilityMirror:null}}]};
}
export function applyWorldTreeCharacterState({tree,context,banks=[],control={enabled:true}}={}){
  const chatId=String(context?.chatId??context?.chat_id??'').trim();if(!chatId)throw new Error('WORLD_TREE_CHARACTER_STATE_CHAT_REQUIRED');
  const input=(banks??[]).filter(bank=>bank&&String(bank.id??'').trim()).filter(bank=>String(bank.storyId??chatId)===chatId),live=new Set(input.map(bank=>String(bank.id))),receipts=[];
  for(const [index,bank] of input.entries())receipts.push(applyDeterministicWorldTreeContribution(buildWorldTreeCharacterStateContribution({tree,bank,chatId,sourceOrder:index}),{tree,context}));
  for(const bank of input)receipts.push(applyDeterministicWorldTreeContribution(buildWorldTreeCharacterStateSemanticContribution({tree,bank,chatId}),{tree,context}));
  for(const node of tree.iterateNodes({chatId,kind:'CHARACTER_STATE'})){
    const id=String(node.data?.sourceBank?.id??'');if(node.scope?.chatId!==chatId||!id||live.has(id)||node.temporal?.status==='SUPERSEDED')continue;
    if(node.data?.canonicalOwner!=='WORLD_TREE'&&node.data?.importedFrom!=='legacy-character-bank')continue;
    const prior=characterOwnerRecord(node.data.sourceBank??{id,storyId:chatId,character:node.data?.label??id});
    if(node.data?.nativeCharacterState!==true){
      receipts.push(applyDeterministicWorldTreeContribution(buildWorldTreeCharacterStateContribution({tree,bank:prior,chatId,sourceOrder:Number(node.data?.sourceOrder)||0}),{tree,context}));
      receipts.push(applyDeterministicWorldTreeContribution(buildWorldTreeCharacterStateSemanticContribution({tree,bank:prior,chatId}),{tree,context}));
    }
    receipts.push(applyDeterministicWorldTreeContribution(buildWorldTreeCharacterStateContribution({tree,bank:prior,chatId,sourceOrder:Number(node.data?.sourceOrder)||0,removed:true}),{tree,context}));
    receipts.push(applyDeterministicWorldTreeContribution(buildWorldTreeCharacterStateSemanticContribution({tree,bank:prior,chatId,removed:true}),{tree,context}));
  }
  const controlReceipt=applyDeterministicWorldTreeContribution(buildWorldTreeCharacterControlContribution({chatId,control}),{tree,context});
  return Object.freeze({kind:'NexusWorldTreeCharacterStateWrite',chatId,inputCount:input.length,receipts:Object.freeze(receipts),controlReceipt,worldRevision:tree.revision,intakeOwned:true});
}
