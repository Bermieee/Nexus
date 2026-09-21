/** Nexus activation bootstrap. Keep dependency-free so module-load failures can be reported cleanly. */
function describeActivationError(error) {
    if (error instanceof Error) {
        const name = String(error.name || 'Error').trim();
        const message = String(error.message || '').trim();
        return message ? `${name}: ${message}` : name;
    }
    if (error && typeof error === 'object') {
        const type = String(error.type || '').trim();
        const target = error.target || error.currentTarget;
        const url = String(target?.src || target?.href || '').trim();
        const message = String(error.message || error.reason?.message || '').trim();
        if (message) return message;
        if (type && url) return `${type} while loading ${url}`;
        if (url) return `Module load failed: ${url}`;
        if (type) return `Module load event: ${type}`;
        try {
            const json = JSON.stringify(error);
            if (json && json !== '{}') return json;
        } catch {}
        return 'Unknown module-load event';
    }
    const text = String(error ?? '').trim();
    return text && text !== '[object Event]' ? text : 'Unknown activation failure';
}

import('./index.js').catch(error => {
    const message = describeActivationError(error);
    console.error(`[Nexus] Activation failed: ${message}`, error);
    try { globalThis.toastr?.error(message, 'Nexus activation failed'); } catch {}
});
