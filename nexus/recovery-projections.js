// Registry for durable audit projections that depend on canonical commit-journal
// recovery truth. Canonical journal/Ledger state remains authoritative; these
// hooks only reconcile secondary authority/audit stores after disposition.
const projectors = new Map();

export function registerNexusRecoveryProjector(name, projector) {
    const key = String(name || '').trim();
    if (!key || typeof projector !== 'function') throw new Error('Nexus recovery projector requires a name and function.');
    projectors.set(key, projector);
    return () => { if (projectors.get(key) === projector) projectors.delete(key); };
}

export async function projectNexusRecoverySettlement(settlement = {}) {
    const results = [];
    const errors = [];
    for (const [name, projector] of projectors) {
        try { results.push({ name, result: await projector(settlement) }); }
        catch (error) { errors.push({ name, error }); }
    }
    if (errors.length) {
        const error = new Error(`Nexus canonical recovery settled, but ${errors.length} dependent audit projection(s) still require reconciliation.`);
        error.name = 'TV2RecoveryProjectionPending';
        error.projectionErrors = errors.map(row => ({ name: row.name, message: String(row.error?.message || row.error) }));
        error.results = results;
        throw error;
    }
    return results;
}
