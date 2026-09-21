import { deepCopy } from './contracts.js';

/**
 * External capability resolution only. The Registry answers "what is this?"
 * and returns a descriptor; Policy/Logic Gates separately answer whether it may
 * run. Internal worker jobs do not use this Registry.
 */
export class CapabilityRegistry {
    constructor(entries = []) {
        this.entries = new Map();
        for (const entry of entries || []) this.register(entry.name || entry.capability, entry);
    }

    register(name, descriptor = {}) {
        const key = String(name || descriptor.capability || '').trim().toLowerCase();
        if (!key) throw new Error('A Nexus capability requires a registry name.');
        const mutation = descriptor.mutation === true;
        if (!mutation && typeof descriptor.handler !== 'function') throw new Error(`Read-only Nexus capability "${key}" requires a handler.`);
        if (mutation && typeof descriptor.stage !== 'function') throw new Error(`Mutation Nexus capability "${key}" requires a stage hook; a generic handler cannot perform protected mutation work.`);
        const normalized = {
            name: key,
            capability: String(descriptor.capability || key),
            mutation,
            handler: mutation ? null : descriptor.handler,
            execute: mutation && typeof descriptor.execute === 'function' ? descriptor.execute : null,
            parse: mutation && typeof descriptor.parse === 'function' ? descriptor.parse : null,
            stage: mutation ? descriptor.stage : null,
            operation: mutation && typeof descriptor.operation === 'function' ? descriptor.operation : null,
            // Legacy commit hooks are retained only as inert descriptor metadata.
            // Function Gateway never executes them; canonical physical mutation is
            // owned by the Nexus mutation coordinator.
            commit: mutation && typeof descriptor.commit === 'function' ? descriptor.commit : null,
            snapshot: typeof descriptor.snapshot === 'function' ? descriptor.snapshot : null,
            assumptions: typeof descriptor.assumptions === 'function' ? descriptor.assumptions : null,
            validate: typeof descriptor.validate === 'function' ? descriptor.validate : null,
            metadata: deepCopy(descriptor.metadata || {}),
        };
        this.entries.set(key, normalized);
        return () => this.entries.delete(key);
    }

    has(name) { return this.entries.has(String(name || '').trim().toLowerCase()); }

    resolve(name) {
        const entry = this.entries.get(String(name || '').trim().toLowerCase());
        if (!entry) return null;
        return { ...entry, metadata: deepCopy(entry.metadata) };
    }

    list() {
        return [...this.entries.values()].map(entry => ({
            name: entry.name,
            capability: entry.capability,
            mutation: entry.mutation,
            metadata: deepCopy(entry.metadata),
        }));
    }
}
