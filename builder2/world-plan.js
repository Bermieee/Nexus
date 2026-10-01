import { builder2Fingerprint } from './contracts.js';

export const WORLD_BUILD_CONTRACT = 'nexus-world-tree-builder/v1';
const dispositions = new Set(['PLACED', 'UNRESOLVED', 'EXCLUDED']);
const statuses = new Set(['READY', 'STUDYING', 'DUE', 'FAILED', 'REMOVED']);
const temporalStatuses = new Set(['CURRENT','HISTORICAL','SUPERSEDED','CONTRADICTED','UNCERTAIN','UNRESOLVED']);
export function worldBuildSourceId(book, uid) {
  if (!String(book ?? '').trim() || !Number.isFinite(Number(uid))) throw new TypeError('World build source requires book and numeric UID');
  return `${String(book)}#${Number(uid)}`;
}
export function createWorldBuildPlan(input = {}) {
  const data = structuredClone(input);
  return {
    contract: WORLD_BUILD_CONTRACT, runId: data.runId ?? null, planRevision: data.planRevision ?? 0,
    scope: data.scope ?? null, sourceFence: data.sourceFence ?? null,
    worldRevision: data.worldRevision ?? null, layoutRevision: data.layoutRevision ?? 0,binding:data.binding??null,
    mode: data.mode ?? 'EXTEND', sources: (data.sources ?? []).map(({content,...source}) => ({...source, sourceId: worldBuildSourceId(source.book, source.uid)})),
    organization: {groups: [], placements: [], navigationLinks: [], ...data.organization},
    identityMatches: data.identityMatches ?? [], relationshipProposals: data.relationshipProposals ?? [],
    layout: {seed: data.runId, pins: {}, ...data.layout}, coverage: data.coverage ?? [],
    review: data.review ?? null, phase: data.phase ?? 'DRAFT',
  };
}
export function worldBuildFingerprint(plan) {
  // Execution state and approval receipts do not change the reviewed proposal.
  const {phase, review, outcome, error, ...proposal} = plan;
  return builder2Fingerprint(proposal);
}
export function validateWorldBuildPlan(plan) {
  const errors = [];
  const fail = message => errors.push(message);
  if (plan?.contract !== WORLD_BUILD_CONTRACT) fail('Invalid world build contract');
  if (!plan?.runId) fail('Missing run identity');
  if (!Number.isInteger(plan?.planRevision) || plan.planRevision < 0) fail('Invalid plan revision');
  if (!['EXTEND','REORGANIZE'].includes(plan?.mode)) fail('Invalid build mode');
  const validScope = scope => scope?.type === 'GLOBAL' || (scope?.type === 'CHAT' && !!scope.chatId);
  if (!validScope(plan?.scope)) fail('Missing build scope');
  if (plan?.worldRevision == null || !plan?.sourceFence) fail('Missing authority fences');
  const sources = new Map();
  for (const source of plan?.sources ?? []) {
    let id;
    try { id = worldBuildSourceId(source.book,source.uid); } catch { fail('Invalid source identity'); continue; }
    if (source.sourceId !== id || sources.has(id)) fail(`Invalid or duplicate source ${id}`);
    if (!source.fingerprint) fail(`Missing source fingerprint ${id}`);
    sources.set(id, source);
  }
  const groups = new Map();
  for (const group of plan?.organization?.groups ?? []) {
    if (!group.id || groups.has(group.id) || !String(group.label ?? '').trim()) fail('Invalid or duplicate group');
    if (statuses.has(String(group.label).trim().toUpperCase()) || group.kind === 'PROCESSING_STATUS') fail('Processing status is not a category');
    groups.set(group.id, group);
  }
  for (const group of groups.values()) {
    const visited = new Set([group.id]); let parent = group.parentId;
    while (parent && groups.has(parent)) {
      if (visited.has(parent)) { fail(`Organization cycle at ${group.id}`); break; }
      visited.add(parent); parent = groups.get(parent).parentId;
    }
  }
  const placements = new Map();
  for (const row of plan?.organization?.placements ?? []) {
    if (!sources.has(row.sourceId) || placements.has(row.sourceId) || !row.parentId) fail(`Invalid or duplicate placement ${row.sourceId}`);
    placements.set(row.sourceId,row);
  }
  const coverage = new Map();
  for (const row of plan?.coverage ?? []) {
    if (!sources.has(row.sourceId) || coverage.has(row.sourceId) || !dispositions.has(row.disposition)) fail(`Invalid source disposition ${row.sourceId}`);
    coverage.set(row.sourceId,row);
    if ((row.disposition === 'PLACED') !== placements.has(row.sourceId)) fail(`Disposition/placement mismatch ${row.sourceId}`);
  }
  for (const id of sources.keys()) if (!coverage.has(id)) fail(`Missing source disposition ${id}`);
  const relationshipIds = new Set();
  for (const row of plan?.relationshipProposals ?? []) {
    if (!row.id || relationshipIds.has(row.id) || !row.from || !row.to || !row.relation) fail('Invalid relationship identity');
    relationshipIds.add(row.id);
    if (!Array.isArray(row.evidence) || !row.evidence.length || row.evidence.some(id => !sources.has(id))) fail(`Missing relationship evidence ${row.id}`);
    if (!validScope(row.scope) || (row.scope.type === 'CHAT' && row.scope.chatId !== plan.scope?.chatId) || (plan.scope?.type === 'CHAT' && row.scope.type === 'GLOBAL')) fail(`Relationship scope mismatch ${row.id}`);
    if (!temporalStatuses.has(row.temporal?.status)) fail(`Missing temporal meaning ${row.id}`);
    if (row.kind === 'LAYOUT' || row.kind === 'NAVIGATION') fail('Presentation links cannot assert facts');
  }
  return {valid: errors.length === 0, errors};
}
