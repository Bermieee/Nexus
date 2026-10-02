export const WORLD_TREE_EDGE_MEANINGS=Object.freeze([
  'is-a','part-of','located-in','member-of','owns','relationship','present-in','at','about','mentions','remembers','derived-from','supersedes',
  'contains','state-of','has-memory','promoted-into',
]);

const STANDARD=new Set(WORLD_TREE_EDGE_MEANINGS);
const LEGACY=Object.freeze({
  IS_A:'is-a',PART_OF:'part-of',LOCATED_IN:'located-in',MEMBER_OF:'member-of',OWNS:'owns',RELATIONSHIP:'relationship',
  PRESENT_IN:'present-in',PRESENT_AT:'at',AT:'at',ABOUT:'about',MENTIONS:'mentions',REMEMBERS:'remembers',DERIVED_FROM:'derived-from',
  SUPERSEDES:'supersedes',CONTAINS:'contains',STATE_OF:'state-of',HAS_MEMORY:'has-memory',PROMOTED_INTO:'promoted-into',
});
const clean=value=>String(value??'').trim();

export function canonicalWorldTreeEdgeMeaning(value){
  const raw=clean(value);if(!raw)return'';
  const legacyKey=raw.toUpperCase().replace(/[\s-]+/g,'_');
  if(LEGACY[legacyKey])return LEGACY[legacyKey];
  // Preserve unknown saved relation names verbatim during staged enforcement.
  // Only the known legacy/canonical vocabulary is translated on read.
  return raw;
}
export function isStandardWorldTreeEdgeMeaning(value){return STANDARD.has(canonicalWorldTreeEdgeMeaning(value));}
export function inspectWorldTreeEdgeMeaning(value){
  const input=clean(value),meaning=canonicalWorldTreeEdgeMeaning(input);
  return Object.freeze({input,meaning,standard:STANDARD.has(meaning),translated:input!==meaning});
}
