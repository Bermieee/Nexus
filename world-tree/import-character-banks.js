import { legacyMemoryWorldNodeId } from './import-memory-bank.js';
import { applyDeterministicWorldTreeContribution } from './intake/runtime.js';
import { stableHash } from './intake/contribution.js';

const clone=value=>value==null?value:structuredClone(value);
const uniq=values=>[...new Set((values??[]).map(v=>String(v??'').trim()).filter(Boolean))];
function safeId(value){return encodeURIComponent(String(value??''));}
function stableObject(value){
  if(Array.isArray(value))return value.map(stableObject);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableObject(value[key])]));
  return value;
}
function ownerBankRecord(bank={}){return clone(bank);}
function stateFingerprint(bank={}){return JSON.stringify({version:'complete-character-bank-v2-intake',bank:stableObject(ownerBankRecord(bank))});}
function characterControlNodeId(chatId){return 'character-control:'+safeId(chatId);}
export function boundCharacterWorldNodeId(avatar){return 'character-card:'+safeId(avatar);}
export function localCharacterWorldNodeId(chatId,bankId){return 'character-local:'+safeId(chatId)+':'+safeId(bankId);}
export function characterStateWorldNodeId(chatId,bankId){return 'character-state:'+safeId(chatId)+':'+safeId(bankId);}

function memoryEdgeSpecs(bank,{chatId,stateNodeId,tree}){
  const refs=new Map();
  for(const ref of bank?.memoryRefs??[]){if(String(ref?.chatId??'')!==String(chatId))continue;const id=String(ref?.id??'').trim();if(id)refs.set(id,id);}
  for(const id of bank?.memoryIds??[])if(String(id??'').trim())refs.set(String(id),String(id));
  const edges=[];
  for(const memoryId of refs.keys()){
    const memoryNodeId=legacyMemoryWorldNodeId(chatId,memoryId);if(!tree.getNode(memoryNodeId,{chatId}))continue;
    edges.push({edgeId:'character-memory-edge:'+safeId(chatId)+':'+safeId(bank.id)+':'+safeId(memoryId),from:stateNodeId,to:memoryNodeId,meaning:'has-memory',authority:'REMEMBERED',subtype:'legacy-explicit-link'});
  }
  return edges;
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
    nodes:[{tempId:characterControlNodeId(chatId),kind:'SUMMARY',label:'Character read control',authority:'CANON',fields:{enabled,importedFrom:'legacy-character-bank-control',importFingerprint:revision}}]};
}
function removedBankContribution(stateNode,tree,{chatId,revision}){
  const bankId=String(stateNode?.data?.sourceBank?.id??''),nodes=[{tempId:stateNode.id,kind:'CHARACTER_STATE',label:String(stateNode.data?.label??bankId??'Character state'),authority:'REMEMBERED',temporalStatus:'SUPERSEDED',fields:{...clone(stateNode.data??{}),sourcePresent:false}}];
  const characterId=String(stateNode?.data?.characterNodeId??''),identity=characterId?tree.getNode(characterId,{chatId}):null;
  if(identity?.scope?.type==='CHAT'&&identity?.data?.importedFrom==='legacy-character-bank')nodes.push({tempId:identity.id,kind:'CHARACTER',label:String(identity.data?.label??bankId??'Character'),authority:'CANON',temporalStatus:'SUPERSEDED',fields:{...clone(identity.data??{}),sourcePresent:false}});
  return{kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:String(chatId)},sourceRefs:[{bankId,revision}],key:'legacy-character-bank:'+safeId(bankId)+':removed:'+revision,mentions:[],nodes,edges:[]};
}
export function importLegacyCharacterBanksToWorldTree(tree,{chatId,banks=[],control={enabled:true}}={}){
  if(!tree?.applyContributionRevision)throw new TypeError('NexusWorldTree instance is required');
  const storyId=String(chatId??'').trim();if(!storyId)throw new TypeError('Character Bank import requires chatId');
  const input=(Array.isArray(banks)?banks:[]).filter(bank=>bank&&String(bank.id??'').trim()).filter(bank=>String(bank.storyId??storyId)===storyId);
  const created=[],updated=[],unchanged=[],edges=[],globalCharacters=[],localCharacters=[],states=[];
  for(const [bankIndex,bank] of input.entries()){
    const contribution=bankContribution(tree,bank,{chatId:storyId,sourceOrder:bankIndex}),bound=Boolean(bank?.cardBinding?.avatar);
    const characterId=bound?boundCharacterWorldNodeId(bank.cardBinding.avatar):localCharacterWorldNodeId(storyId,bank.id),stateId=characterStateWorldNodeId(storyId,bank.id);
    const receipt=applyDeterministicWorldTreeContribution(contribution,{tree,context:{chatId:storyId}});
    if(receipt.noOp)unchanged.push(...[...(!bound?[characterId]:[]),stateId]);else{created.push(...receipt.createdNodeIds);updated.push(...receipt.updatedNodeIds,...receipt.supersededNodeIds);}
    edges.push(...receipt.createdEdgeIds,...receipt.updatedEdgeIds);states.push(stateId);(bound?globalCharacters:localCharacters).push(characterId);
  }
  const liveBankIds=new Set(input.map(bank=>String(bank.id)));
  for(const node of tree.iterateNodes({chatId:storyId,kind:'CHARACTER_STATE'})){
    const bankId=String(node.data?.sourceBank?.id??'');if(node.scope?.chatId!==storyId||node.data?.importedFrom!=='legacy-character-bank'||!bankId||liveBankIds.has(bankId)||node.temporal?.status==='SUPERSEDED')continue;
    const revision=stableHash({removed:true,bankId,worldRevision:tree.revision});
    const receipt=applyDeterministicWorldTreeContribution(removedBankContribution(node,tree,{chatId:storyId,revision}),{tree,context:{chatId:storyId}});
    updated.push(...receipt.updatedNodeIds,...receipt.supersededNodeIds);
  }
  const controlReceipt=applyDeterministicWorldTreeContribution(controlContribution(control,{chatId:storyId}),{tree,context:{chatId:storyId}});
  created.push(...controlReceipt.createdNodeIds);updated.push(...controlReceipt.updatedNodeIds);
  return Object.freeze({kind:'NexusWorldTreeLegacyCharacterImport',chatId:storyId,inputCount:input.length,created:Object.freeze(uniq(created)),updated:Object.freeze(uniq(updated)),unchanged:Object.freeze(uniq(unchanged)),
    edges:Object.freeze(uniq(edges)),globalCharacters:Object.freeze(globalCharacters),localCharacters:Object.freeze(localCharacters),states:Object.freeze(states),controlNodeId:characterControlNodeId(storyId),intakeOwned:true});
}
export function legacyCharacterOwnerRecord(bank={}){return ownerBankRecord(bank);}
export function legacyCharacterControlWorldNodeId(chatId){return characterControlNodeId(chatId);}
