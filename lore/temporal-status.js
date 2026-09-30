import { KnowledgeStatus } from '../nexus/a52/contracts.js';

const ALLOWED=new Set([
  KnowledgeStatus.CURRENT,
  KnowledgeStatus.HISTORICAL,
  KnowledgeStatus.SUPERSEDED,
  KnowledgeStatus.CONTRADICTED,
  KnowledgeStatus.UNRESOLVED,
  KnowledgeStatus.UNCERTAIN,
]);

export function readLoreTemporalMetadata(entry={}){
  const raw=entry?.extensions?.nexusTemporal??{};
  const status=String(raw.status??'CURRENT').trim().toUpperCase();
  return Object.freeze({
    status:ALLOWED.has(status)?status:KnowledgeStatus.CURRENT,
    supersededBy:raw.supersededBy??null,
    note:raw.note==null?null:String(raw.note),
  });
}

export function withLoreTemporalMetadata(entry,{status=KnowledgeStatus.CURRENT,supersededBy=null,note=null}={}){
  const normalized=String(status??KnowledgeStatus.CURRENT).trim().toUpperCase();
  if(!ALLOWED.has(normalized)) throw new TypeError('Unsupported lore temporal status: '+status);
  if(normalized===KnowledgeStatus.SUPERSEDED&&supersededBy==null) throw new TypeError('SUPERSEDED lore requires supersededBy');
  const next=structuredClone(entry??{});
  next.extensions={...(next.extensions??{})};
  next.extensions.nexusTemporal={
    status:normalized,
    ...(supersededBy==null?{}:{supersededBy}),
    ...(note==null?{}:{note:String(note)}),
  };
  return next;
}
