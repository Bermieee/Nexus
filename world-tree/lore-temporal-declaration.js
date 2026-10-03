// Whether an authored lore entry declares any timeline state of its own.
// Mirrors the fields world-tree/import-lore.js reads when it stamps a status, so a
// stored UNRESOLVED can be told apart: the importer's default (nothing declared)
// versus a state the source explicitly declared.
const list=value=>Array.isArray(value)?value:(value==null?[]:[value]);
const present=value=>list(value).some(row=>String(row??'').trim());

export function loreEntryDeclaresTemporalState(entry={}){
  const temporal=entry?.extensions?.nexusTemporal??entry?.nexusTemporal??{};
  const metadata=entry?.metadata??{};
  const rawStatus=temporal.status??entry?.temporalStatus??entry?.status??metadata?.temporalStatus??metadata?.status??null;
  return String(rawStatus??'').trim()!==''
    ||present(temporal.supersededBy??entry?.supersededBy)
    ||present(temporal.supersedes??entry?.supersedes)
    ||present(temporal.contradictedBy??entry?.contradictedBy)
    ||entry?.historical===true||metadata?.historical===true
    ||(temporal.validFrom??entry?.validFrom)!=null
    ||(temporal.validUntil??entry?.validUntil)!=null
    ||(temporal.reason??entry?.temporalReason)!=null;
}
