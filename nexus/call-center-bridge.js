import { enqueueBusJob } from '../sidecar/bus.js';
/**
 * Compatibility surface retained for older callers. The historical UI
 * switchboard was metadata-only and never changed dispatch. The separate
 * model-worker rail may now lease idle Main capacity, but tool calls truthfully
 * remain on Nexus service through Function Gateway authority.
 */
export function callCenterToolRouteFor(_domain) {
    return 'nexus-service';
}

/**
 * This compatibility helper deliberately stays on the established Sidecar bus.
 *
 * The Call Center owns Main-originated tool tickets; it is not the model-worker
 * dispatcher and is not a replacement dispatcher for lore transforms. Keeping
 * this helper separate prevents Call Center policy/cooldown from becoming a
 * choke point for UID summaries and merge drafts.
 */
export async function dispatchSidecarDraft({ stage, prompt, systemPrompt, options = {} } = {}) {
    const job = enqueueBusJob(stage, { ...options, prompt, systemPrompt });
    return {
        state: 'completed',
        target: 'sidecar-bus',
        result: await job.promise,
        jobId: job.id,
        batch: { mode: 'sidecar-bus' },
    };
}
