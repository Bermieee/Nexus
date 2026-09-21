import { NexusWorkCoordinator } from './work-coordinator.js';

/**
 * Compatibility name retained for 0.6.x adapters.
 *
 * In 0.6.2 this class no longer owns A/B lanes. It is a thin alias for the
 * Work Coordinator; Sidecar Bus exclusively schedules SC-A/SC-B.
 */
export class ABExecutionEngine extends NexusWorkCoordinator {
    constructor(_options = {}) { super(); }
}
