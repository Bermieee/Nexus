import { getSettings } from '../core/settings.js';
import { getNexusBatchStatus } from '../nexus/batch-layer.js';
import { resolveLorebookBuilderPlanningConfig } from './planning-config.js';

/** Host adapter. Reads live settings once at Builder run start. */
export function getLorebookBuilderPlanningConfig({ semanticResource = 'sidecar' } = {}) {
    return resolveLorebookBuilderPlanningConfig({
        settings: getSettings(),
        batchStatus: (semanticResource === 'sidecar' || semanticResource === 'model-worker') ? getNexusBatchStatus() : {},
        semanticResource,
    });
}
