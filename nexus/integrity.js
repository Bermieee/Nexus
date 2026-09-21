/** Deterministic structural serialization used for durable review/CAS identities. */
export function stableNormalize(value) {
    if (value === undefined) return { __tv2Undefined: true };
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stableNormalize);
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableNormalize(value[key]);
    return out;
}

export function stableStringify(value) {
    return JSON.stringify(stableNormalize(value));
}

export function fingerprintText(text) {
    // FNV-1a 32-bit is intentionally non-cryptographic. It is a compact change
    // detector, not an authenticity primitive; exact durable values are still
    // retained wherever authority depends on them.
    let hash = 0x811c9dc5;
    const input = String(text ?? '');
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32:${hash.toString(16).padStart(8, '0')}:${input.length}`;
}

export function fingerprintValue(value) { return fingerprintText(stableStringify(value)); }
export function fingerprintFunction(fn) { return typeof fn === 'function' ? fingerprintText(Function.prototype.toString.call(fn)) : null; }

export function descriptorImplementationFingerprint(descriptor = {}) {
    return fingerprintValue({
        name: String(descriptor?.name || ''),
        capability: String(descriptor?.capability || ''),
        mutation: descriptor?.mutation === true,
        metadataContract: descriptor?.metadata?.argumentSchema || null,
        handler: fingerprintFunction(descriptor?.handler),
        execute: fingerprintFunction(descriptor?.execute),
        parse: fingerprintFunction(descriptor?.parse),
        stage: fingerprintFunction(descriptor?.stage),
        operation: fingerprintFunction(descriptor?.operation),
        snapshot: fingerprintFunction(descriptor?.snapshot),
        assumptions: fingerprintFunction(descriptor?.assumptions),
        validate: fingerprintFunction(descriptor?.validate),
    });
}
