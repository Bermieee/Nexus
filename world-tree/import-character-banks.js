import {
  WorldTreeNodeKind,
  WorldTreeScopeType,
  WorldTreeTemporalStatus,
} from './store.js';
import { legacyMemoryWorldNodeId } from './import-memory-bank.js';

const clone=value=>value==null?value:structuredClone(value);
const uniq=values=>[...new Set((values??[]).map(v=>String(v??'').trim()).filter(Boolean))];

function safeId(value){return encodeURIComponent(String(value??''));}
function stateFingerprint(bank={}){
  return JSON.stringify({
    id:String(bank.id??''),
    storyId:String(bank.storyId??''),
    character:String(bank.character??''),
    role:String(bank.role??''),
    enabled:bank.enabled!==false,
    cardBinding:bank.cardBinding??null,
    linkedRefs:bank.linkedRefs??[],
    memoryIds:bank.memoryIds??[],
    memoryRefs:bank.memoryRefs??[],
    state:bank.state??null,
    fieldProvenance:bank.fieldProvenance??{},
    updatedAt:bank.updatedAt??null,
  });
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

function characterStatePayload(bank,{chatId,characterNodeId}){
  const fingerprint=stateFingerprint(bank);
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

export function importLegacyCharacterBanksToWorldTree(tree,{chatId,banks=[]}={}){
  if(!tree?.upsertNode)throw new TypeError('NexusWorldTree instance is required');
  const storyId=String(chatId??'').trim();
  if(!storyId)throw new TypeError('Character Bank import requires chatId');
  const input=(Array.isArray(banks)?banks:[])
    .filter(bank=>bank&&String(bank.id??'').trim())
    .filter(bank=>String(bank.storyId??storyId)===storyId);
  const created=[],updated=[],unchanged=[],edges=[],globalCharacters=[],localCharacters=[],states=[];

  for(const bank of input){
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

    const state=characterStatePayload(bank,{chatId:storyId,characterNodeId:identity.node.id});
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
  });
}
