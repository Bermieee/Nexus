// Nexus mutation resource admission.
// Resource-scoped, all-or-none, cancellable, fairness-aware. Not a global FIFO.

const holders = new Map();
const waiting = new Map();
const activeAuthorities = new WeakMap();
let requestSequence = 0;

const DEFAULT_HOLDER_WARN_MS = 15_000;
const DEFAULT_HOLDER_LEASE_MS = 120_000;
const DEFAULT_AGING_MS = 1_000;
const DEFAULT_MAX_BYPASSES = 8;
const AUTHORITY_PHASES = new Set(['granted', 'revalidating', 'committing', 'persisting', 'finalizing', 'committed', 'failed']);

function nowMs() { return Date.now(); }
function keyOf(resource) {
  const key = String(resource || '').trim();
  if (!key) throw new Error('Nexus mutation lease requires a resource key.');
  return key;
}
function canonicalResourceSet(resources) {
  const input = Array.isArray(resources) ? resources : [resources];
  const keys = [...new Set(input.map(keyOf))].sort();
  if (!keys.length) throw new Error('Nexus mutation lease requires at least one resource.');
  return keys;
}
function makeAbortError(message = 'Nexus mutation lease wait was cancelled.') {
  const error = new Error(message); error.name = 'TV2MutationLeaseCancelled'; error.cancelled = true; error.deferred = true; return error;
}
function makeTimeoutError(request) {
  const error = new Error(`Nexus mutation lease wait timed out for ${request.resources.join(', ')}.`);
  error.name = 'TV2MutationLeaseWaitTimeout'; error.deferred = true; error.resources = [...request.resources]; error.ownerId = request.ownerId; return error;
}
function makeAuthorityRequiredError() {
  const error = new Error('Canonical mutation engine requires active coordinator-issued resource authority.');
  error.name = 'TV2MutationAuthorityRequired';
  return error;
}
function makeAuthorityScopeError(requiredResources, heldResources) {
  const missing = requiredResources.filter(resource => !heldResources.includes(resource));
  const error = new Error(`Mutation authority does not cover required resource(s): ${missing.join(', ')}`);
  error.name = 'TV2MutationAuthorityScopeMismatch';
  error.requiredResources = [...requiredResources];
  error.heldResources = [...heldResources];
  return error;
}
function effectivePriority(request, now = nowMs()) {
  const agingMs = Math.max(1, Number(request.agingMs) || DEFAULT_AGING_MS);
  const ageBoost = Math.floor(Math.max(0, now - request.queuedAt) / agingMs);
  return Number(request.priority || 0) + ageBoost;
}
function requestBlockedByHolder(request) { return request.resources.some(resource => holders.has(resource)); }
function sharesResource(a, b) { return a.resources.some(resource => b.resources.includes(resource)); }
function rankRequests(items, now = nowMs()) {
  return [...items].sort((a,b) => {
    const pd = effectivePriority(b, now) - effectivePriority(a, now);
    if (pd) return pd;
    if (a.queuedAt !== b.queuedAt) return a.queuedAt - b.queuedAt;
    return a.sequence - b.sequence;
  });
}
function cleanupWaitHooks(request) {
  if (request.abortSignal && request.abortListener) { try { request.abortSignal.removeEventListener('abort', request.abortListener); } catch {} }
  request.abortListener = null;
  if (request.timeoutHandle != null) clearTimeout(request.timeoutHandle);
  request.timeoutHandle = null;
  if (request.holderTimeoutHandle != null) clearTimeout(request.holderTimeoutHandle);
  request.holderTimeoutHandle = null;
}
function rejectWaiting(request, error) {
  if (!request || request.state !== 'waiting') return false;
  request.state = 'cancelled'; request.cancelledAt = nowMs(); waiting.delete(request.id); cleanupWaitHooks(request); request.reject(error); pumpAdmissions(); return true;
}
function releaseRequest(request) {
  if (!request || request.state !== 'held') return false;
  request.state = 'released'; request.releasedAt = nowMs();
  cleanupWaitHooks(request);
  if (request.authority) activeAuthorities.delete(request.authority);
  for (const resource of request.resources) if (holders.get(resource) === request) holders.delete(resource);
  pumpAdmissions(); return true;
}
function expireHeldRequest(request) {
  if (!request || request.state !== 'held') return false;
  const phase = request.diagnosticPhase || 'granted';
  request.state = 'expired'; request.releasedAt = nowMs(); request.expiredAt = request.releasedAt;
  if (request.authority) activeAuthorities.delete(request.authority);
  for (const resource of request.resources) if (holders.get(resource) === request) holders.delete(resource);
  cleanupWaitHooks(request);
  try {
    request.onLeaseExpired?.({
      requestId: request.id, ownerId: request.ownerId, transactionId: request.transactionId,
      operation: request.operation, resources: [...request.resources], phase,
      journalStarted: request.journalStarted === true,
      physicalPersistenceBegun: request.physicalPersistenceBegun === true,
      expiredAt: request.expiredAt,
    });
  } catch {}
  pumpAdmissions();
  return true;
}
function createLease(request) {
  let released = false;
  let lease = null;
  lease = Object.freeze({
    id: request.id,
    ownerId: request.ownerId,
    operation: request.operation,
    resources: Object.freeze([...request.resources]),
    priority: request.priority,
    foreground: request.foreground,
    queuedAt: request.queuedAt,
    grantedAt: request.grantedAt,
    release() {
      if (released) return false;
      released = true;
      return releaseRequest(request);
    },
  });
  request.authority = lease;
  activeAuthorities.set(lease, request);
  return lease;
}
function grant(request) {
  if (!request || request.state !== 'waiting' || requestBlockedByHolder(request)) return false;
  request.state = 'held'; request.grantedAt = nowMs();
  request.diagnosticPhase = 'granted'; request.phaseUpdatedAt = request.grantedAt;
  waiting.delete(request.id); cleanupWaitHooks(request);
  for (const resource of request.resources) holders.set(resource, request);
  if (request.holderLeaseMs > 0) request.holderTimeoutHandle = setTimeout(() => expireHeldRequest(request), request.holderLeaseMs);
  for (const other of waiting.values()) {
    if (other.state === 'waiting' && sharesResource(other, request)) other.bypassCount += 1;
  }
  request.resolve(createLease(request)); return true;
}

function fairnessReservations(now = nowMs()) {
  const reservations = new Map();
  for (const request of rankRequests(waiting.values(), now)) {
    if (request.state !== 'waiting') continue;
    if (request.bypassCount < request.maxBypasses) continue;
    // Fairness may reserve a conflict set only when the aged request is actually
    // grantable as a whole. A waiter blocked on B must never functionally reserve
    // a currently-free A while it continues waiting for B; that would recreate a
    // partial hold without a real lease and violate all-or-none admission.
    if (requestBlockedByHolder(request)) continue;
    for (const resource of request.resources) if (!reservations.has(resource)) reservations.set(resource, request);
  }
  return reservations;
}
function blockedByReservation(request, reservations) {
  for (const resource of request.resources) {
    const owner = reservations.get(resource);
    if (owner && owner !== request) return true;
  }
  return false;
}
function pumpAdmissions() {
  if (!waiting.size) return;
  const now = nowMs();
  const candidates = rankRequests(waiting.values(), now);
  const reservations = fairnessReservations(now);
  for (const request of candidates) {
    if (request.state !== 'waiting') continue;
    if (requestBlockedByHolder(request)) continue;
    if (blockedByReservation(request, reservations)) continue;
    grant(request);
  }
}

export function assertNexusMutationAuthority(authority, requiredResources) {
  if (!authority || typeof authority !== 'object') throw makeAuthorityRequiredError();
  const request = activeAuthorities.get(authority);
  if (!request || request.state !== 'held' || request.authority !== authority) throw makeAuthorityRequiredError();

  const required = canonicalResourceSet(requiredResources);
  const held = [...request.resources];
  const missing = required.filter(resource => !held.includes(resource));
  if (missing.length) throw makeAuthorityScopeError(required, held);

  if (required.some(resource => holders.get(resource) !== request)) {
    throw makeAuthorityRequiredError();
  }
  return authority;
}

export function updateNexusMutationAuthorityPhase(authority, phase, metadata = {}) {
  if (!authority || typeof authority !== 'object') throw makeAuthorityRequiredError();
  const request = activeAuthorities.get(authority);
  if (!request || request.state !== 'held' || request.authority !== authority) throw makeAuthorityRequiredError();
  const normalized = String(phase || '').trim().toLowerCase();
  if (!AUTHORITY_PHASES.has(normalized)) throw new Error(`Unknown Nexus mutation authority phase: ${phase}`);
  request.diagnosticPhase = normalized;
  request.phaseUpdatedAt = nowMs();
  if (metadata.transactionId != null) request.transactionId = String(metadata.transactionId);
  if (metadata.journalId != null) request.journalId = String(metadata.journalId);
  if (metadata.journalStarted === true) request.journalStarted = true;
  if (metadata.physicalPersistenceBegun === true) request.physicalPersistenceBegun = true;
  return authority;
}

export function acquireNexusMutationResources(resources, {
  ownerId = null, operation = 'mutation', priority = 0, foreground = false, signal = null,
  waitTimeoutMs = 0, holderWarnMs = DEFAULT_HOLDER_WARN_MS, holderLeaseMs = DEFAULT_HOLDER_LEASE_MS, agingMs = DEFAULT_AGING_MS,
  maxBypasses = DEFAULT_MAX_BYPASSES, onLeaseExpired = null,
} = {}) {
  const keys = canonicalResourceSet(resources);
  if (signal?.aborted) return Promise.reject(makeAbortError());
  const id = `tv2_mutation_lease_${nowMs()}_${++requestSequence}`;
  const request = {
    id,
    sequence: requestSequence,
    resources: keys,
    ownerId: ownerId == null ? null : String(ownerId),
    operation: String(operation || 'mutation'),
    priority: Number(priority) || 0,
    foreground: foreground === true,
    queuedAt: nowMs(),
    grantedAt: null,
    releasedAt: null,
    cancelledAt: null,
    holderWarnMs: Math.max(0, Number(holderWarnMs) || DEFAULT_HOLDER_WARN_MS),
    holderLeaseMs: Math.max(0, Number.isFinite(Number(holderLeaseMs)) ? Number(holderLeaseMs) : DEFAULT_HOLDER_LEASE_MS),
    agingMs: Math.max(1, Number(agingMs) || DEFAULT_AGING_MS),
    maxBypasses: Math.max(0, Number.isFinite(Number(maxBypasses)) ? Number(maxBypasses) : DEFAULT_MAX_BYPASSES),
    bypassCount: 0,
    abortSignal: signal || null,
    abortListener: null,
    timeoutHandle: null,
    holderTimeoutHandle: null,
    onLeaseExpired: typeof onLeaseExpired === 'function' ? onLeaseExpired : null,
    state: 'waiting',
    diagnosticPhase: 'waiting',
    phaseUpdatedAt: null,
    transactionId: ownerId == null ? null : String(ownerId),
    journalId: null,
    journalStarted: false,
    physicalPersistenceBegun: false,
    resolve: null,
    reject: null,
    authority: null,
  };
  const promise = new Promise((resolve,reject)=>{ request.resolve=resolve; request.reject=reject; });
  if (signal) { request.abortListener = () => rejectWaiting(request, makeAbortError()); signal.addEventListener('abort', request.abortListener, {once:true}); }
  const timeout = Math.max(0, Number(waitTimeoutMs) || 0);
  if (timeout > 0) request.timeoutHandle = setTimeout(() => rejectWaiting(request, makeTimeoutError(request)), timeout);
  waiting.set(id, request); pumpAdmissions(); return promise;
}
export async function withNexusMutationResources(resources, task, options = {}) {
  if (typeof task !== 'function') throw new TypeError('Nexus mutation lease requires a task function.');
  const lease = await acquireNexusMutationResources(resources, options);
  try { if (options?.signal?.aborted) throw makeAbortError(); return await task(lease); }
  finally { lease.release(); }
}
export async function withNexusMutationLock(resource, task, options = {}) { return withNexusMutationResources([resource], task, options); }
export function lorebookMutationResource(book) { return `lorebook:${String(book || '').trim()}`; }
export function treeMutationResource(book) { return `tree:${String(book || '').trim()}`; }
export function loreMutationResource(book) { return `lore:${String(book || '').trim()}`; }
export function metadataMutationResource(chatId, key = null) {
  const chat = String(chatId ?? '').trim();
  if (!chat) throw new Error('Nexus metadata mutation resource requires an explicit chat identity.');
  const suffix = key == null || String(key).trim() === '' ? '' : `:${String(key).trim()}`;
  return `metadata:${chat}${suffix}`;
}
export function getNexusMutationLockSnapshot() { return [...holders.keys()].sort(); }
export function getNexusMutationLeaseSnapshot({now=nowMs()}={}) {
  const uniqueHolders = [...new Set(holders.values())];
  return {
    heldResources:[...holders.keys()].sort(),
    holders:uniqueHolders.map(r=>({
      requestId:r.id,ownerId:r.ownerId,transactionId:r.transactionId,journalId:r.journalId,
      operation:r.operation,resources:[...r.resources],priority:r.priority,foreground:r.foreground,
      queuedAt:r.queuedAt,grantedAt:r.grantedAt,leaseAgeMs:r.grantedAt==null?0:Math.max(0,now-r.grantedAt),
      phase:r.diagnosticPhase||'granted',phaseUpdatedAt:r.phaseUpdatedAt,
      phaseAgeMs:r.phaseUpdatedAt==null?0:Math.max(0,now-r.phaseUpdatedAt),
      journalStarted:r.journalStarted===true,physicalPersistenceBegun:r.physicalPersistenceBegun===true,holderLeaseMs:r.holderLeaseMs,
      suspect:r.grantedAt!=null&&r.holderWarnMs>0&&(now-r.grantedAt)>=r.holderWarnMs,state:r.state
    })),
    waiters:[...waiting.values()].map(r=>({
      requestId:r.id,ownerId:r.ownerId,transactionId:r.transactionId,operation:r.operation,resources:[...r.resources],
      priority:r.priority,effectivePriority:effectivePriority(r,now),foreground:r.foreground,queuedAt:r.queuedAt,
      waitMs:Math.max(0,now-r.queuedAt),phase:'waiting',bypassCount:r.bypassCount,maxBypasses:r.maxBypasses,
      fairnessReserved:r.bypassCount>=r.maxBypasses,
      blockedBy:r.resources.map(resource=>holders.get(resource)).filter(Boolean).map(h=>({requestId:h.id,ownerId:h.ownerId,operation:h.operation,resources:[...h.resources]})),
      state:r.state
    }))
  };
}
