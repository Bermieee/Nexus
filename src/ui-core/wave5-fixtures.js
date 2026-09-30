import { KnowledgeStatus } from './constants.js';
import { ProductHealth } from './wave5-product-model.js';

export const Wave5Fixture = Object.freeze({
  HEALTHY: 'healthy-active-story',
  BACKGROUND: 'background-work',
  UNCERTAINTY: 'legitimate-uncertainty',
  DEGRADED: 'degraded-subsystem',
  CONFLICT: 'conflict',
  NO_SCENE: 'no-active-scene',
  LARGE_WORLD: 'large-world',
});

export function createWave5ProductFixture(name = Wave5Fixture.HEALTHY) {
  const snapshot = baseFixture();
  snapshot.fixtureId = `wave5.${name}`;

  switch (name) {
    case Wave5Fixture.BACKGROUND:
      snapshot.runtime.background = { ...snapshot.runtime.background, state: 'ACTIVE', completed: 8, total: 14, userMessage: 'Studying lore · 8 of 14 batches complete.' };
      snapshot.brain.components = snapshot.brain.components.map((item) => item.id === 'background' ? { ...item, status: ProductHealth.STUDYING, detail: 'Studying 14 batches' } : item);
      break;
    case Wave5Fixture.UNCERTAINTY:
      snapshot.recentChanges = [{ title: 'Uncertainty preserved', detail: 'Sun Blade location remains unresolved.' }];
      break;
    case Wave5Fixture.DEGRADED:
      snapshot.brain.overall = ProductHealth.DEGRADED;
      snapshot.brain.components = snapshot.brain.components.map((item) => item.id === 'coprocessor' ? { ...item, status: ProductHealth.UNAVAILABLE, detail: 'Optional specialists unavailable' } : item);
      snapshot.coprocessor.available = false;
      break;
    case Wave5Fixture.CONFLICT:
      snapshot.notifications.unshift({ id: 'notice-conflict', status: 'warning', title: 'Conflict found', message: "Two credible sources disagree about the Sun Blade's fate." });
      break;
    case Wave5Fixture.NO_SCENE:
      snapshot.scene = null;
      snapshot.brain.components = snapshot.brain.components.map((item) => item.id === 'scene' ? { ...item, status: ProductHealth.IDLE, detail: 'No active scene' } : item);
      break;
    case Wave5Fixture.LARGE_WORLD:
      snapshot.world.counts = { knowledgeArtifacts: 10000, activeEntities: 1381, unresolvedThreads: 196 };
      snapshot.memory.experiences = 12481;
      snapshot.memory.reflections = 1402;
      snapshot.lore.count = 10621;
      snapshot.runtime.backingCounts = { workLedgerTasks: 12000, sceneEpisodes: 1000, uiExtensions: 128 };
      break;
    case Wave5Fixture.HEALTHY:
      break;
    default:
      throw new Error(`Unknown Wave 5 fixture: ${name}`);
  }

  return structuredCloneSafe(snapshot);
}

function baseFixture() {
  return {
    source: 'DETERMINISTIC_FIXTURE',
    fixtureId: 'wave5.healthy-active-story',
    story: {
      id: 'story-akira-world',
      title: 'Mushoku Tensei — Akira Kagenou World',
    },
    brain: {
      overall: ProductHealth.READY,
      components: [
        { id: 'scene', label: 'Scene', status: ProductHealth.READY, detail: 'Active' },
        { id: 'memory', label: 'Memory', status: ProductHealth.LEARNING, detail: 'Learning' },
        { id: 'lore', label: 'Lore', status: ProductHealth.CURRENT, detail: 'Up to date' },
        { id: 'background', label: 'Background', status: ProductHealth.STUDYING, detail: 'Studying 3 items' },
        { id: 'coprocessor', label: 'Coprocessor', status: ProductHealth.READY, detail: 'Available' },
      ],
    },
    scene: {
      id: 'scene-east-tower-workshop-184',
      revision: 27,
      title: 'East Tower — 6F Workshop',
      location: 'East Tower — 6F Workshop',
      narrativeTime: 'Evening',
      cast: [
        { id: 'akira', name: 'Akira', confidence: 0.99 },
        { id: 'nanahoshi', name: 'Nanahoshi', confidence: 0.98 },
      ],
      atmosphere: { label: 'Quiet · tense · focused', authority: KnowledgeStatus.INFERRED, inferred: true, confidence: 0.78 },
      activeThreads: ['Summoning-circle recalibration', 'Mana-channel testing', 'Darius meeting pending'],
      recentChange: 'Akira preparing to leave',
      boundary: { state: 'CONTINUING', confidence: 0.96, supportingSignals: ['RELATIONSHIP_SIGNAL', 'VIBE_CHANGED', 'PREFETCH_RECOMMENDED'] },
      episodeRelation: { relation: 'CONTINUES', targetSceneId: 'scene-east-tower-workshop-183', label: 'Continues previous workshop scene' },
      temporal: { interpretation: 'Same evening', authority: KnowledgeStatus.INFERRED, confidence: 0.9 },
      spatial: { interpretation: 'East Tower, sixth-floor workshop', authority: KnowledgeStatus.OBSERVED, confidence: 0.99 },
      prefetch: { recommended: true, reason: 'Active research threads remain unresolved' },
    },
    characters: [
      {
        id: 'nanahoshi', name: 'Nanahoshi Shizuka', location: 'East Tower Workshop',
        state: ['Focused', 'Physically stable'],
        relationship: { subject: 'Akira', label: 'Growing trust', authority: KnowledgeStatus.INFERRED, confidence: 0.81, evidenceCount: 4 },
        threads: ['Summoning recalibration', 'Mana-channel research'],
        historyCount: 7, reflections: 2, unresolvedContradictions: 0,
      },
      {
        id: 'akira', name: 'Akira Kagenou', location: 'East Tower Workshop',
        state: ['Preparing to leave', 'Steady'],
        relationship: { subject: 'Nanahoshi', label: 'Increasing mutual trust', authority: KnowledgeStatus.INFERRED, confidence: 0.81, evidenceCount: 4 },
        threads: ['Darius meeting pending', 'Mana-channel verification'],
        historyCount: 5, reflections: 1, unresolvedContradictions: 0,
      },
    ],
    lore: {
      count: 621,
      sourceStatus: 'All sources current',
      tree: [
        { name: 'Characters', children: ['Akira', 'Nanahoshi', 'Darius'] },
        { name: 'Locations', children: ['East Tower', 'Academy'] },
        { name: 'Magic', children: ['Summoning'] },
      ],
      understanding: { facts: 17, relationships: 5, historicalStates: 3, unresolvedQuestions: 1, authority: KnowledgeStatus.INFERRED },
      changeImpact: { changedClaims: 2, changedRestrictions: 1, rebuiltRetrievalRepresentations: 3, reevaluationRequired: 1, unaffectedDerivedArtifacts: 17, source: 'FIXTURE' },
    },
    memory: {
      experiences: 12481,
      reflections: 402,
      recent: ['Summoning circle recalibrated', 'Akira left for Professor Darius', 'Mana-channel symptoms stabilized'],
      important: ['Akira ↔ Nanahoshi bond', 'Seven-month summoning error', '47-question research list'],
      unresolved: ['Pocket removal terms'],
      learning: {
        subject: 'Akira ↔ Nanahoshi', pattern: 'Increasing mutual trust', evidenceCount: 4,
        evidence: ['episode-12', 'episode-19', 'episode-28', 'episode-41'], authority: KnowledgeStatus.INFERRED,
        confidence: 0.81, contradictingEvidence: [],
      },
      reconsolidation: { experiences: 4, reason: 'Repeatedly recalled together', changed: 'Retrieval organization', canonicalTruthChanged: false },
    },
    world: {
      counts: { knowledgeArtifacts: 1842, activeEntities: 381, unresolvedThreads: 96 },
      entities: [
        { id: 'ember-tavern', name: 'Ember Tavern', current: 'Destroyed', history: ['Intact', 'Damaged', 'Destroyed'], authority: KnowledgeStatus.CURRENT },
        { id: 'sun-blade', name: 'Sun Blade', current: 'Unknown', history: ['Left at Ember Tavern'], authority: KnowledgeStatus.UNRESOLVED },
        { id: 'mara', name: 'Mara', current: 'Tavern ruins', history: [], authority: KnowledgeStatus.CURRENT },
      ],
      unresolved: ['Sun Blade fate'],
      conflict: {
        id: 'sun-blade-location-conflict', subject: 'Sun Blade', current: 'Unknown', historical: 'Left at Ember Tavern',
        reason: 'Destruction and removal evidence disagree.', settlement: KnowledgeStatus.UNRESOLVED,
        evidence: [
          { id: 'evidence-a', claim: 'Destroyed in fire', authority: 'CREDIBLE' },
          { id: 'evidence-b', claim: 'Removed before fire', authority: 'CREDIBLE' },
        ],
      },
    },
    coprocessor: {
      available: true,
      assistCount: 4,
      specialists: [
        { name: 'Historian', resultClass: 'REQUIRED', state: 'COMPLETE', latencyMs: 42 },
        { name: 'Graph Walker', resultClass: 'OPPORTUNISTIC', state: 'COMPLETE', latencyMs: 31 },
        { name: 'Truth', resultClass: 'REQUIRED', state: 'COMPLETE', latencyMs: 54 },
        { name: 'Green Room', resultClass: 'OPPORTUNISTIC', state: 'BACKGROUND', latencyMs: 190 },
      ],
      foregroundQuorum: true,
      contextSealed: true,
    },
    precision: {
      funnel: [
        { label: 'Recalled', count: 42 },
        { label: 'Verified', count: 31 },
        { label: 'Shortlisted', count: 18 },
        { label: 'Ranked', count: 6 },
        { label: 'Used', count: 4 },
      ],
    },
    runtime: {
      background: { label: 'Lore Study', completed: 8, total: 14, state: 'PARKED', userMessage: 'Background study paused while foreground generation runs.' },
      foreground: { active: true, label: 'Foreground generation' },
      timeline: ['Generation started', 'Yield requested', 'Slice committed', 'Checkpoint 8', 'PARKED', 'Foreground work running', 'RESUMED', 'Batch 9 / 14'],
      backingCounts: { workLedgerTasks: 12000, sceneEpisodes: 1000, uiExtensions: 100 },
    },
    promptPlan: {
      source: 'FIXTURE',
      totalTokens: 18200,
      reusableTokens: 11800,
      updatedTokens: 6400,
      segments: [
        ['Current Scene', 2420], ['Character State', 4110], ['World State', 1850], ['Relevant Lore', 3060], ['Memory', 2800], ['Unresolved', 900], ['Recent Narrative', 3100],
      ],
      advanced: { modelProfile: 'fixture-profile', revisionPolicy: 'NO_CHANGE / PATCH / REBUILD', cacheEligible: true, integrity: 'FIXTURE_ONLY' },
    },
    activity: [
      { key: 'scene', status: 'complete', message: 'Scene updated' },
      { key: 'truth', status: 'complete', message: 'Current truth checked' },
      { key: 'memory', status: 'complete', message: '6 relevant memories recalled' },
      { key: 'context', status: 'complete', message: 'Context prepared' },
      { key: 'lore-study', status: 'active', message: 'Studying 12 lore entries' },
      { key: 'memory-consolidation', status: 'active', message: 'Consolidating 3 memories' },
    ],
    notifications: [
      { id: 'notice-lore', status: 'ready', title: 'Lore changed', message: 'Your edit affected 3 learned facts and 1 relationship.' },
      { id: 'notice-memory', status: 'ready', title: 'Memory updated', message: 'A recurring relationship pattern became eligible for reflection.' },
      { id: 'notice-study', status: 'ready', title: 'Background study complete', message: '142 lore entries analyzed.' },
    ],
    recentChanges: [
      { title: 'Scene updated', detail: 'Akira is preparing to leave the workshop.' },
      { title: 'Memory learned', detail: 'Mutual trust pattern remains inferred from four experiences.' },
    ],
  };
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
