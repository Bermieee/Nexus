function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
        return out;
    }
    return value;
}

// Deliberately named fingerprint rather than hash: this is a compact deterministic
// stale-plan/version signal, not a cryptographic integrity primitive.
export function fingerprint(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(stable(value));
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `fnv1a32:${h.toString(16).padStart(8, '0')}:${text.length}`;
}

export function entryFingerprint(entry = {}) {
    return fingerprint({
        uid: Number(entry?.uid),
        title: String(entry?.comment || ''),
        content: String(entry?.content || ''),
        keys: Array.isArray(entry?.key) ? entry.key.map(String) : [],
        disable: entry?.disable === true,
        constant: entry?.constant === true,
        selective: entry?.selective === true,
    });
}
