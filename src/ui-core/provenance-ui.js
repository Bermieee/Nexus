import { Signals } from './constants.js';
import { element } from './primitives.js';

export const KnowledgeActions = Object.freeze({
  SOURCE: 'knowledge.inspectSource',
  PROVENANCE: 'knowledge.inspectProvenance',
  HISTORY: 'knowledge.inspectHistory',
  DEPENDENCIES: 'knowledge.inspectDependencies',
  SETTLEMENT: 'knowledge.inspectSettlement',
  EVIDENCE: 'knowledge.inspectEvidence',
});

const ACTION_METHOD = Object.freeze({
  [KnowledgeActions.SOURCE]: 'inspectSource',
  [KnowledgeActions.PROVENANCE]: 'inspectProvenance',
  [KnowledgeActions.HISTORY]: 'inspectHistory',
  [KnowledgeActions.DEPENDENCIES]: 'inspectDependencies',
  [KnowledgeActions.SETTLEMENT]: 'inspectSettlement',
  [KnowledgeActions.EVIDENCE]: 'inspectEvidence',
});

export function registerKnowledgeInspectionActions(actionRouter, { adapter, signals }) {
  actionRouter.registerSubsystem('knowledge-ui', async (action) => {
    const method = ACTION_METHOD[action.type];
    if (!method) throw new Error(`Unknown knowledge inspection action: ${action.type}`);
    const result = await adapter[method](action.target);
    signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: result }, { source: 'knowledge-ui' });
    return result;
  });
  for (const type of Object.keys(ACTION_METHOD)) {
    actionRouter.registerAction(type, {
      subsystem: 'knowledge-ui',
      permissions: ['knowledge:inspect'],
      validate: (action) => Boolean(action?.target?.id) || 'knowledge-target-required',
    });
  }
}

export function createKnowledgeActionBar(doc, { ref, actionRouter, permissions = ['knowledge:inspect'], scope }) {
  const root = element(doc, 'div', { className: 'a52-knowledge-actions', attrs: { role: 'toolbar', 'aria-label': 'Knowledge inspection actions' } });
  const actions = [
    [KnowledgeActions.SOURCE, 'Source'],
    [KnowledgeActions.PROVENANCE, 'Provenance'],
    [KnowledgeActions.HISTORY, 'History'],
    [KnowledgeActions.DEPENDENCIES, 'Dependencies'],
    [KnowledgeActions.SETTLEMENT, 'Settlement'],
    [KnowledgeActions.EVIDENCE, 'Evidence'],
  ];
  for (const [type, label] of actions) {
    const available = actionRouter?.hasAction?.(type) ?? false;
    const button = element(doc, 'button', { className: 'a52-action-chip', text: label, attrs: { type: 'button', disabled: !available, 'aria-disabled': String(!available), title: available ? label : `${label} unavailable — producer/action not connected` }, dataset: { action: type, availability: available ? 'LIVE' : 'UNAVAILABLE' } });
    const press = () => available ? actionRouter.route({ type, target: ref }, { permissions }) : Promise.resolve({ ok:false, status:'NOT_FOUND', error:'inspection-action-unavailable' });
    if (scope) scope.listen(button, 'click', press); else button.addEventListener('click', press);
    root.append(button);
  }
  return root;
}
