import {
  WorldTreeNodeKind,
  WorldTreeScopeType,
  WorldTreeTemporalStatus,
} from './store.js';
import { legacyMemoryWorldNodeId } from './import-memory-bank.js';

const clone=value=>value==null?value:structuredClone(value);
const uniq=values=>[...new Set((values??[]).map(v=>String(v??'').trim()).filter(Boolean))];

function safeId(value){return encodeURIComponent(String(value??''));}
function stableObject(value){
  if(Array.isArray(value))return value.map(stableObject);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableObject(value[key])]));
  return value;
}
function ownerBankRecord(bank={}){return clone(bank);}
function stateFingerprint(bank={}){
  return JSON.stringify({version:'complete-character-bank-v1',bank:stableObject(ownerBankRecord(bank))});
}
function characterControlNodeId(chatId){return 'character-control:'+safeId(chatId);}
function characterControlPayload(control,{chatId}){
  const enabled=control?.enabled!==false;
  const fingerprint=JSON.stringify({enabled});
  return{
    id:characterControlNodeId(chatId),
    kind:WorldTreeNodeKind.SUMMARY,
    parentId:null,
    scope:{type:WorldTreeScopeType.CHAT,chatId:String(chatId)},
    provenance:{sourceType:'NEXUS_CHARACTER_BANK',sourceIds:['character-read-control'],sourceRevisionIds:[fingerprint],importedFrom:'legacy-character-bank-control'},
    temporal:{status:WorldTreeTemporalStatus.CURRENT},
    data:{label:'Character read control',enabled,importedFrom:'legacy-character-bank-control',importFingerprint:fingerprint},
  };
}

export function boundCharacterWorldNodeId(avatar){
  return 'character-card:'+safeId(avatar);
}
export function localCharacterWorldNodeId(chatId,bankId){
  return 'character-local:'+safeId(chatId)+':'+safeId(bankId);
}
export function characterStateWorldNodeId(chatId,bankId){
  return 'character-state:'+safeId(chatId)+':'+safeId(bankId);
}

function characterIdentityPayload(bank,{chatId}){
  const binding=bank?.cardBinding??null;
  const label=String(bank?.character||binding?.name||bank?.id||'Character').trim();
  if(binding?.avatar){
    return {
      node:{
        id:boundCharacterWorldNodeId(binding.avatar),
        kind:WorldTreeNodeKind.CHARACTER,
        scope:{type:WorldTreeScopeType.GLOBAL},
        provenance:{
          sourceType:'SILLYTAVERN_CHARACTER_CARD',
          sourceIds:[String(binding.avatar)],
          sourceRevisionIds:uniq([binding.fingerprint,bank?.cardSync?.fingerprint]),
          importedFrom:'legacy-character-bank',
        },
        temporal:{status:WorldTreeTemporalStatus.CURRENT},
        data:{
          label,
          avatar:String(binding.avatar),
          cardName:String(binding.name||label),
          fingerprint:String(binding.fingerprint||''),
          trackedCharacter:true,
          tracking:'active',
          trackingSource:'bound-character-card',
          importedFrom:'legacy-character-bank',
        },
      },
      identityScope:null,
      sourceEntityId:String(binding.avatar),
    };
  }
  return {
    node:{
      id:localCharacterWorldNodeId(chatId,bank.id),
      kind:WorldTreeNodeKind.CHARACTER,
      scope:{type:WorldTreeScopeType.CHAT,chatId:String(chatId)},
      provenance:{
        sourceType:'NEXUS_CHARACTER_BANK',
        sourceIds:[String(bank.id)],
        sourceRevisionIds:[stateFingerprint(bank)],
        importedFrom:'legacy-character-bank',
      },
      temporal:{status:WorldTreeTemporalStatus.CURRENT},
      data:{label,unboundLegacyCharacter:true,importedFrom:'legacy-character-bank'},
    },
    identityScope:String(chatId),
    sourceEntityId:String(bank.id),
  };
}

function characterStatePayload(bank,{chatId,characterNodeId,sourceOrder=0}){
  const order=Math.max(0,Number(sourceOrder)||0);
  const bankFingerprint=stateFingerprint(bank);
  const fingerprint=JSON.stringify({bankFingerprint,sourceOrder:order});
  return {
    id:characterStateWorldNodeId(chatId,bank.id),
    kind:WorldTreeNodeKind.CHARACTER_STATE,
    scope:{type:WorldTreeScopeType.CHAT,chatId:String(chatId)},
    provenance:{
      sourceType:'NEXUS_CHARACTER_BANK',
      sourceIds:[String(bank.id)],
      sourceRevisionIds:[fingerprint],
      provenanceRefs:uniq(Object.values(bank?.fieldProvenance??{}).flatMap(row=>Array.isArray(row)?row:row?[row]:[]).map(row=>typeof row==='string'?row:row?.provenanceRef??row?.sourceRevisionRef??null)),
      importedFrom:'legacy-character-bank',
    },
    temporal:{status:bank.enabled===false?WorldTreeTemporalStatus.HISTORICAL:WorldTreeTemporalStatus.CURRENT},
    data:{
      label:String(bank.character||bank?.cardBinding?.name||bank.id||'Character state'),
      role:String(bank.role||'supporting'),
      sourceBank:ownerBankRecord(bank),
      sourcePresent:true,
      sourceOrder:order,
      enabled:bank.enabled!==false,
      state:clone(bank.state??{}),
      profile:clone(bank.profile??{}),
      fieldProvenance:clone(bank.fieldProvenance??{}),
      cardSync:clone(bank.cardSync??{}),
      linkedLoreRefs:clone(bank.linkedRefs??[]),
      memoryRefs:clone(bank.memoryRefs??[]),
      memoryIds:uniq(bank.memoryIds),
      importedFrom:'legacy-character-bank',
      importFingerprint:fingerprint,
      characterNodeId,
    },
  };
}

function stateEdgePayload({chatId,stateNodeId,characterNodeId,bankId}){
  return {
    id:'character-state-edge:'+safeId(chatId)+':'+safeId(bankId),
    from:stateNodeId,
    to:characterNodeId,
    relation:'STATE_OF',
    scope:{type:WorldTreeScopeType.CHAT,chatId:String(chatId)},
    provenance:{sourceType:'NEXUS_CHARACTER_BANK',sourceIds:[String(bankId)],importedFrom:'legacy-character-bank'},
    temporal:{status:WorldTreeTemporalStatus.CURRENT},
    data:{importedFrom:'legacy-character-bank'},
  };
}

function memoryEdges(bank,{chatId,stateNodeId,tree}){
  const refs=new Map();
  for(const ref of bank?.memoryRefs??[]){
    if(String(ref?.chatId??'')!==String(chatId))continue;
    const id=String(ref?.id??'').trim();if(id)refs.set(id,id);
  }
  for(const id of bank?.memoryIds??[])if(String(id??'').trim())refs.set(String(id),String(id));
  const edges=[];
  for(const memoryId of refs.keys()){
    const memoryNodeId=legacyMemoryWorldNodeId(chatId,memoryId);
    if(!tree.getNode(memoryNodeId,{chatId}))continue;
    edges.push({
      id:'character-memory-edge:'+safeId(chatId)+':'+safeId(bank.id)+':'+safeId(memoryId),
      from:stateNodeId,
      to:memoryNodeId,
      relation:'HAS_MEMORY',
      scope:{type:WorldTreeScopeType.CHAT,chatId:String(chatId)},
      provenance:{sourceType:'NEXUS_CHARACTER_BANK',sourceIds:[String(bank.id),memoryId],importedFrom:'legacy-character-bank'},
      temporal:{status:WorldTreeTemporalStatus.CURRENT},
      data:{explicitLink:true,importedFrom:'legacy-character-bank'},
    });
  }
  return edges;
}

function nodeChanged(existing,payload){
  if(!existing)return true;
  if(existing.temporal?.status!==payload.temporal?.status)return true;
  if(payload.data?.importFingerprint)return existing.data?.importFingerprint!==payload.data.importFingerprint;
  return JSON.stringify(existing.data??{})!==JSON.stringify(payload.data??{});
}

export function importLegacyCharacterBanksToWorldTree(tree,{chatId,banks=[],control={enabled:true}}={}){
  if(!tree?.upsertNode)throw new TypeError('NexusWorldTree instance is required');
  const storyId=String(chatId??'').trim();
  if(!storyId)throw new TypeError('Character Bank import requires chatId');
  const input=(Array.isArray(banks)?banks:[])
    .filter(bank=>bank&&String(bank.id??'').trim())
    .filter(bank=>String(bank.storyId??storyId)===storyId);
  const created=[],updated=[],unchanged=[],edges=[],globalCharacters=[],localCharacters=[],states=[];

  for(const [bankIndex,bank] of input.entries()){
    const identity=characterIdentityPayload(bank,{chatId:storyId});
    const characterExisting=tree.getNode(identity.node.id,{chatId:storyId});
    if(nodeChanged(characterExisting,identity.node)){
      tree.upsertNode(identity.node);
      (characterExisting?updated:created).push(identity.node.id);
    }else unchanged.push(identity.node.id);
    if(identity.node.scope.type===WorldTreeScopeType.GLOBAL)globalCharacters.push(identity.node.id);
    else localCharacters.push(identity.node.id);

    try{
      tree.registerIdentity({
        nodeId:identity.node.id,
        canonicalLabel:identity.node.data.label,
        entityType:'CHARACTER',
        aliases:uniq([bank?.cardBinding?.name,bank?.character]),
        providerId:identity.node.scope.type===WorldTreeScopeType.GLOBAL?'SILLYTAVERN_CHARACTER_CARD':'NEXUS_CHARACTER_BANK',
        sourceEntityId:identity.sourceEntityId,
        authorityOrigin:'OWNER_EXPLICIT',
      });
    }catch{}

    const state=characterStatePayload(bank,{chatId:storyId,characterNodeId:identity.node.id,sourceOrder:bankIndex});
    const stateExisting=tree.getNode(state.id,{chatId:storyId});
    if(nodeChanged(stateExisting,state)){
      tree.upsertNode(state);
      (stateExisting?updated:created).push(state.id);
    }else unchanged.push(state.id);
    states.push(state.id);

    const stateEdge=stateEdgePayload({chatId:storyId,stateNodeId:state.id,characterNodeId:identity.node.id,bankId:bank.id});
    if(!tree.getEdge(stateEdge.id,{chatId:storyId}))tree.linkEdge(stateEdge);
    edges.push(stateEdge.id);

    for(const edge of memoryEdges(bank,{chatId:storyId,stateNodeId:state.id,tree})){
      if(!tree.getEdge(edge.id,{chatId:storyId}))tree.linkEdge(edge);
      edges.push(edge.id);
    }
  }

  const liveStateIds=new Set(input.map(bank=>characterStateWorldNodeId(storyId,bank.id)));
  for(const node of tree.iterateNodes({chatId:storyId,kind:WorldTreeNodeKind.CHARACTER_STATE})){
    if(node.scope?.chatId!==storyId||node.data?.importedFrom!=='legacy-character-bank'||liveStateIds.has(node.id)||node.data?.sourcePresent===false)continue;
    tree.upsertNode({...node,temporal:{...node.temporal,status:WorldTreeTemporalStatus.SUPERSEDED,reason:'legacy-character-source-removed'},data:{...node.data,sourcePresent:false}});
    updated.push(node.id);
    const characterId=node.data?.characterNodeId,identity=characterId?tree.getNode(characterId,{chatId:storyId}):null;
    if(identity?.scope?.type===WorldTreeScopeType.CHAT&&identity?.data?.importedFrom==='legacy-character-bank'){
      tree.upsertNode({...identity,temporal:{...identity.temporal,status:WorldTreeTemporalStatus.SUPERSEDED,reason:'legacy-character-source-removed'},data:{...identity.data,sourcePresent:false}});
      updated.push(identity.id);
    }
  }
  const controlPayload=characterControlPayload(control,{chatId:storyId});
  const controlExisting=tree.getNode(controlPayload.id,{chatId:storyId});
  if(!controlExisting||controlExisting.data?.importFingerprint!==controlPayload.data.importFingerprint)tree.upsertNode(controlPayload);

  return Object.freeze({
    kind:'NexusWorldTreeLegacyCharacterImport',
    chatId:storyId,
    inputCount:input.length,
    created:Object.freeze(created),
    updated:Object.freeze(updated),
    unchanged:Object.freeze(unchanged),
    edges:Object.freeze(edges),
    globalCharacters:Object.freeze(globalCharacters),
    localCharacters:Object.freeze(localCharacters),
    states:Object.freeze(states),
    controlNodeId:controlPayload.id,
  });
}

export function legacyCharacterOwnerRecord(bank={}){return ownerBankRecord(bank);}
export function legacyCharacterControlWorldNodeId(chatId){return characterControlNodeId(chatId);}
