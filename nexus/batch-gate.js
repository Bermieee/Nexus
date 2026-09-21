import { deepCopy } from './contracts.js';

/** Deterministic admission control for high-cost Transform jobs. It decides
 * whether an operation can go as one draft, needs a batch-preparation plan, or
 * must wait because batching is disabled. It never makes a model call. */
export class BatchAdmissionGate {
    constructor({ enabled = true, summaryInputTokens = 7000, mergeInputTokens = 9000, maxBatchItems = 10 } = {}) {
        this.config = { enabled: enabled !== false, summaryInputTokens: Math.max(1000, Number(summaryInputTokens) || 7000), mergeInputTokens: Math.max(1000, Number(mergeInputTokens) || 9000), maxBatchItems: Math.max(1, Math.min(50, Number(maxBatchItems) || 10)) };
    }

    inspect({ operation, inputTokens = 0, itemCount = 1, requestedBatch = false } = {}) {
        const op = String(operation || 'unknown');
        const threshold = op === 'merge' ? this.config.mergeInputTokens : this.config.summaryInputTokens;
        const overThreshold = Number(inputTokens) > threshold || Number(itemCount) > this.config.maxBatchItems;
        if (!overThreshold && !requestedBatch) return { mode: 'single', allowed: true, reason: 'within single-draft threshold', threshold, inputTokens: Number(inputTokens), itemCount: Number(itemCount) };
        if (!this.config.enabled) return { mode: 'blocked', allowed: false, reason: 'batch admission is disabled for an oversized transform', threshold, inputTokens: Number(inputTokens), itemCount: Number(itemCount) };
        return { mode: 'batch', allowed: true, reason: requestedBatch ? 'operator requested batching' : 'transform exceeds single-draft threshold', threshold, inputTokens: Number(inputTokens), itemCount: Number(itemCount), maxBatchItems: this.config.maxBatchItems };
    }
    snapshot() { return deepCopy(this.config); }
}
