import { memoryWorldNodeId } from './memory-schema.js';
import { loreFactWorldNodeId } from './import-lore.js';
import { applyDeterministicWorldTreeContribution } from './intake/runtime.js';
import { stableHash } from './intake/contribution.js';
import { characterOwnerRecord, boundCharacterWorldNodeId, localCharacterWorldNodeId, characterStateWorldNodeId, characterControlWorldNodeId } from './character-schema.js';

const clone=value=>value==null?value:structuredClone(value);
const uniq=values=>[...new Set((values??[]).map(v=>String(v??'').trim()).filter(Boolean))];
const normalized=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
function safeId(value){return encodeURIComponent(String(value??''));}
function nodeAliases(node){const data=node?.data??{};return uniq([data.label,data.name,data.cardName,...(data.aliases??[])]);}
function mentionsAlias(text,alias){const hay=' '+normalized(text)+' ',needle=' '+normalized(alias)+' ';return needle.length>3&&hay.includes(needle);}
function stableObject(value){
  if(Array.isArray(value))return value.map(stableObject);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableObject(value[key])]));
  return value;
}
const ownerBankRecord=characterOwnerRecord;
function stateFingerprint(bank={}){return JSON.stringify({version:'complete-character-bank-v2-intake',bank:stableObject(ownerBankRecord(bank))});}

function memoryEdgeSpecs(bank,{chatId,stateNodeId,tree}){
  const refs=new Map();
  for(const ref of bank?.memoryRefs??[]){if(String(ref?.chatId??'')!==String(chatId))continue;const id=String(ref?.id??'').trim();if(id)refs.set(id,id);}
  for(const id of bank?.memoryIds??[])if(String(id??'').trim())refs.set(String(id),String(id));
  const edges=[];
  for(const memoryId of refs.keys()){
    const memoryNodeId=memoryWorldNodeId(chatId,memoryId);if(!tree.getNode(memoryNodeId,{chatId}))continue;
    edges.push({edgeId:'character-memory-edge:'+safeId(chatId)+':'+safeId(bank.id)+':'+safeId(memoryId),from:stateNodeId,to:memoryNodeId,meaning:'has-memory',authority:'REMEMBERED',subtype:'legacy-explicit-link'});
  }
  return edges;
}

function semanticEdgeSpecs(tree,bank,{chatId,characterNodeId,stateNodeId}={}){
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
    const matched=nodeAliases(target).some(alias=>mentionsAlias(relationshipText,alias));if(!matched||seen.has(target.id))continue;seen.add(target.id);
    edges.push({edgeId:'character-state-relationship:'+safeId(chatId)+':'+safeId(bank.id)+'->'+safeId(target.id),from:characterNodeId,to:target.id,meaning:'relationship',authority:'REMEMBERED',subtype:'character-state',sourceField:'persistent.relationships',sourceSnippetHash:stableHash(relationshipText)});
  }
  return edges;
}
function bankSemanticContribution(tree,bank,{chatId}={}){
  const bound=Boolean(bank?.cardBinding?.avatar),characterNodeId=bound?boundCharacterWorldNodeId(bank.cardBinding.avatar):localCharacterWorldNodeId(chatId,bank.id),stateNodeId=characterStateWorldNodeId(chatId,bank.id);
  const edges=semanticEdgeSpecs(tree,bank,{chatId,characterNodeId,stateNodeId}),revision=stableHash({bankId:String(bank.id),enabled:bank.enabled!==false,relationship:String(bank?.state?.persistent?.relationships??''),linkedRefs:bank?.linkedRefs??[],edges:edges.map(edge=>[edge.edgeId,edge.from,edge.to,edge.meaning,edge.subtype])});
  return{kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:String(chatId)},sourceRefs:[{bankId:String(bank.id),semantic:'graph-links',revision}],key:'legacy-character-bank-links:'+safeId(bank.id)+':'+revision,mentions:[],nodes:[],edges};
}
function removedBankSemanticContribution(bankId,{chatId,revision}={}){
  return{kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:String(chatId)},sourceRefs:[{bankId:String(bankId),semantic:'graph-links',revision}],key:'legacy-character-bank-links:'+safeId(bankId)+':removed:'+revision,mentions:[],nodes:[],edges:[]};
}
function bankContribution(tree,bank,{chatId,sourceOrder=0}){
  const order=Math.max(0,Number(sourceOrder)||0),bankFingerprint=stateFingerprint(bank);
  const label=String(bank.character||bank?.cardBinding?.name||bank.id||'Character').trim();
  const bound=Boolean(bank?.cardBinding?.avatar),characterNodeId=bound?boundCharacterWorldNodeId(bank.cardBinding.avatar):localCharacterWorldNodeId(chatId,bank.id);
  const cardIdentityReady=!bound||Boolean(tree.getNode(characterNodeId,{chatId})),revision=stableHash({bankFingerprint,sourceOrder:order,cardIdentityReady});
  const stateNodeId=characterStateWorldNodeId(chatId,bank.id),nodes=[];
  if(!bound)nodes.push({tempId:characterNodeId,kind:'CHARACTER',label,authority:'CANON',temporalStatus:bank.enabled===false?'HISTORICAL':'CURRENT',fields:{
    aliases:uniq([bank.character]),unboundLegacyCharacter:true,sourcePresent:true,importedFrom:'legacy-character-bank',identityProviderId:'NEXUS_CHARACTER_BANK',identitySourceEntityId:String(bank.id),
  }});
  nodes.push({tempId:stateNodeId,kind:'CHARACTER_STATE',label,authority:'REMEMBERED',temporalStatus:bank.enabled===false?'HISTORICAL':'CURRENT',fields:{
    role:String(bank.role||'supporting'),sourceBank:ownerBankRecord(bank),sourcePresent:true,sourceOrder:order,enabled:bank.enabled!==false,state:clone(bank.state??{}),profile:clone(bank.profile??{}),
    fieldProvenance:clone(bank.fieldProvenance??{}),cardSync:clone(bank.cardSync??{}),linkedLoreRefs:clone(bank.linkedRefs??[]),memoryRefs:clone(bank.memoryRefs??[]),memoryIds:uniq(bank.memoryIds),
    importedFrom:'legacy-character-bank',importFingerprint:revision,characterNodeId,
  }});
  const edges=[];
  if(cardIdentityReady)edges.push({edgeId:'character-state-edge:'+safeId(chatId)+':'+safeId(bank.id),from:stateNodeId,to:characterNodeId,meaning:'state-of',authority:'REMEMBERED',subtype:'legacy-character-state'});
  edges.push(...memoryEdgeSpecs(bank,{chatId,stateNodeId,tree}));
  return{kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:String(chatId)},sourceRefs:[{bankId:String(bank.id),revision}],key:'legacy-character-bank:'+safeId(bank.id)+':'+revision,mentions:[],nodes,edges};
}
function controlContribution(control,{chatId}){
  const enabled=control?.enabled!==false,revision=stableHash({enabled});
  return{kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:String(chatId)},sourceRefs:[{control:'character-read',revision}],key:'legacy-character-control:'+revision,mentions:[],edges:[],
    nodes:[{tempId:characterControlWorldNodeId(chatId),kind:'SUMMARY',label:'Character read control',authority:'CANON',fields:{enabled,importedFrom:'legacy-character-bank-control',importFingerprint:revision}}]};
}
function removedBankContribution(stateNode,tree,{chatId,revision}){
  const bankId=String(stateNode?.data?.sourceBank?.id??''),nodes=[{tempId:stateNode.id,kind:'CHARACTER_STATE',label:String(stateNode.data?.label??bankId??'Character state'),authority:'REMEMBERED',temporalStatus:'SUPERSEDED',fields:{...clone(stateNode.data??{}),sourcePresent:false}}];
  const characterId=String(stateNode?.data?.characterNodeId??''),identity=characterId?tree.getNode(characterId,{chatId}):null;
  if(identity?.scope?.type==='CHAT'&&identity?.data?.importedFrom==='legacy-character-bank')nodes.push({tempId:identity.id,kind:'CHARACTER',label:String(identity.data?.label??bankId??'Character'),authority:'CANON',temporalStatus:'SUPERSEDED',fields:{...clone(identity.data??{}),sourcePresent:false}});
  return{kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:String(chatId)},sourceRefs:[{bankId,revision}],key:'legacy-character-bank:'+safeId(bankId)+':removed:'+revision,mentions:[],nodes,edges:[]};
}
export function importLegacyCharacterBanksToWorldTree(tree,{chatId,banks=[],control={enabled:true},context=null}={}){
  if(!tree?.applyContributionRevision)throw new TypeError('NexusWorldTree instance is required');
  const storyId=String(chatId??'').trim();if(!storyId)throw new TypeError('Character Bank import requires chatId');
  const origin=context??{chatId:storyId};
  if(String(origin.chatId??origin.chat_id??'')!==storyId)throw new Error('WORLD_TREE_CHARACTER_IMPORT_CHAT_SCOPE_MISMATCH');
  const input=(Array.isArray(banks)?banks:[]).filter(bank=>bank&&String(bank.id??'').trim()).filter(bank=>String(bank.storyId??storyId)===storyId);
  const created=[],updated=[],unchanged=[],edges=[],globalCharacters=[],localCharacters=[],states=[];
  for(const [bankIndex,bank] of input.entries()){
    const contribution=bankContribution(tree,bank,{chatId:storyId,sourceOrder:bankIndex}),bound=Boolean(bank?.cardBinding?.avatar);
    const characterId=bound?boundCharacterWorldNodeId(bank.cardBinding.avatar):localCharacterWorldNodeId(storyId,bank.id),stateId=characterStateWorldNodeId(storyId,bank.id);
    const receipt=applyDeterministicWorldTreeContribution(contribution,{tree,context:origin});
    if(receipt.noOp)unchanged.push(...[...(!bound?[characterId]:[]),stateId]);else{created.push(...receipt.createdNodeIds);updated.push(...receipt.updatedNodeIds,...receipt.supersededNodeIds);}
    edges.push(...receipt.createdEdgeIds,...receipt.updatedEdgeIds);states.push(stateId);(bound?globalCharacters:localCharacters).push(characterId);
  }
  // Semantic graph links run after every identity/state node exists, so relationships
  // between two Character Banks resolve deterministically regardless of source order.
  for(const bank of input){
    const receipt=applyDeterministicWorldTreeContribution(bankSemanticContribution(tree,bank,{chatId:storyId}),{tree,context:origin});
    edges.push(...receipt.createdEdgeIds,...receipt.updatedEdgeIds,...receipt.supersededEdgeIds);
  }
  const liveBankIds=new Set(input.map(bank=>String(bank.id)));
  for(const node of tree.iterateNodes({chatId:storyId,kind:'CHARACTER_STATE'})){
    const bankId=String(node.data?.sourceBank?.id??'');if(node.scope?.chatId!==storyId||node.data?.importedFrom!=='legacy-character-bank'||!bankId||liveBankIds.has(bankId)||node.temporal?.status==='SUPERSEDED')continue;
    const revision=stableHash({removed:true,bankId,worldRevision:tree.revision});
    const receipt=applyDeterministicWorldTreeContribution(removedBankContribution(node,tree,{chatId:storyId,revision}),{tree,context:origin});
    const semanticReceipt=applyDeterministicWorldTreeContribution(removedBankSemanticContribution(bankId,{chatId:storyId,revision}),{tree,context:origin});
    updated.push(...receipt.updatedNodeIds,...receipt.supersededNodeIds);edges.push(...semanticReceipt.supersededEdgeIds);
  }
  const controlReceipt=applyDeterministicWorldTreeContribution(controlContribution(control,{chatId:storyId}),{tree,context:origin});
  created.push(...controlReceipt.createdNodeIds);updated.push(...controlReceipt.updatedNodeIds);
  return Object.freeze({kind:'NexusWorldTreeLegacyCharacterImport',chatId:storyId,inputCount:input.length,created:Object.freeze(uniq(created)),updated:Object.freeze(uniq(updated)),unchanged:Object.freeze(uniq(unchanged)),
    edges:Object.freeze(uniq(edges)),globalCharacters:Object.freeze(globalCharacters),localCharacters:Object.freeze(localCharacters),states:Object.freeze(states),controlNodeId:characterControlWorldNodeId(storyId),intakeOwned:true});
}
export const legacyCharacterOwnerRecord=characterOwnerRecord;
export { boundCharacterWorldNodeId, localCharacterWorldNodeId, characterStateWorldNodeId, characterControlWorldNodeId as legacyCharacterControlWorldNodeId };
