export const TV2_BACKUP_SCHEMA = 'tv2-backup';
export const TV2_BACKUP_SCHEMA_VERSION = 1;

const FORBIDDEN_IMPORT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function assertSafeImportPayload(value, path = '$') {
    if (!value || typeof value !== 'object') return true;
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) assertSafeImportPayload(value[i], `${path}[${i}]`);
        return true;
    }
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_IMPORT_KEYS.has(key)) {
            const error = new Error(`Unsafe import key "${key}" at ${path}. Nexus rejected the settings file.`);
            error.name = 'TV2UnsafeImportPayload';
            throw error;
        }
        assertSafeImportPayload(value[key], `${path}.${key}`);
    }
    return true;
}

export function assertSupportedTv2BackupSchema(payload) {
    if (!payload || payload.schema !== TV2_BACKUP_SCHEMA) return true;
    const version = Number(payload.schemaVersion);
    if (!Number.isInteger(version) || version !== TV2_BACKUP_SCHEMA_VERSION) {
        const error = new Error(`Unsupported Nexus backup schema version: ${payload.schemaVersion ?? '(missing)'}. Expected ${TV2_BACKUP_SCHEMA_VERSION}.`);
        error.name = 'TV2UnsupportedBackupSchema';
        error.expectedSchemaVersion = TV2_BACKUP_SCHEMA_VERSION;
        error.actualSchemaVersion = payload.schemaVersion ?? null;
        throw error;
    }
    return true;
}

export function deepClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function redactSidecarSecrets(settings, includeSecrets = false) {
    const copy = deepClone(settings || {});
    for (const slot of ['A', 'B']) {
        if (!copy.sidecars?.[slot]) continue;
        if (!includeSecrets) copy.sidecars[slot].apiKey = '';
    }
    // Decision Core's TypeSafe credential follows the same explicit backup
    // secret policy as Sidecar keys. OpenRouter Jev stores no duplicate key.
    if (!includeSecrets && copy.decisionCore?.typeSafe) copy.decisionCore.typeSafe.apiKey = '';
    return copy;
}

export function buildTv2BackupPayload({ settings, includeSecrets = false, chatState = null, extensionVersion = '0.4.0' } = {}) {
    return {
        schema: TV2_BACKUP_SCHEMA,
        schemaVersion: TV2_BACKUP_SCHEMA_VERSION,
        extensionVersion,
        exportedAt: new Date().toISOString(),
        includesSecrets: includeSecrets === true,
        settings: redactSidecarSecrets(settings, includeSecrets),
        chatState: chatState ? deepClone(chatState) : null,
        notes: 'Nexus configuration/Tree backup plus optional current-chat Smart Context and recursive Memory Bank state. SillyTavern lorebook contents remain in their World Info files and are not duplicated here.',
    };
}

function looksLikeTv1Settings(value) {
    return !!value && typeof value === 'object' && (
        value.sidecarProfile || value.sidecarAutoRetrieval !== undefined || value.smartContextEnabled !== undefined ||
        value.postTurnEnabled !== undefined || value.globalEnabled !== undefined || value.trackerUids ||
        (value.trees && value.enabledLorebooks)
    );
}

export function unwrapImportPayload(payload) {
    const raw = payload && typeof payload === 'object' ? payload : null;
    if (!raw) return { kind: 'unknown', data: null };
    if (raw.schema === TV2_BACKUP_SCHEMA && raw.settings) return { kind: 'tv2-backup', data: raw };
    if (raw.tv2 && typeof raw.tv2 === 'object') return { kind: 'tv2-settings', data: raw.tv2 };
    if (raw.extension_settings?.tv2 && typeof raw.extension_settings.tv2 === 'object') return { kind: 'tv2-settings', data: raw.extension_settings.tv2 };
    if (raw.tunnelvision && looksLikeTv1Settings(raw.tunnelvision)) return { kind: 'tv1', data: raw.tunnelvision };
    if (raw.extension_settings?.tunnelvision && looksLikeTv1Settings(raw.extension_settings.tunnelvision)) return { kind: 'tv1', data: raw.extension_settings.tunnelvision };
    if (looksLikeTv1Settings(raw)) return { kind: 'tv1', data: raw };
    if (raw.trees && raw.sidecars) return { kind: 'tv2-settings', data: raw };
    return { kind: 'unknown', data: raw };
}

export function mapTv1SidecarProfile(profile = {}, llmCallTimeout = null) {
    const format = ['openai', 'anthropic', 'google'].includes(String(profile.format || '').toLowerCase())
        ? String(profile.format).toLowerCase()
        : 'openai';
    const legacyMax = Number(profile.maxTokens);
    const timeout = Number(llmCallTimeout);
    return {
        enabled: profile.enabled === true,
        endpoint: String(profile.endpoint || ''),
        apiKey: String(profile.apiKey || ''),
        model: String(profile.model || ''),
        format,
        // Nexus intentionally does not inherit TV1's generic output ceiling.
        // Anthropic requires max_tokens, so preserve a valid TV1 value only there.
        providerMaxTokens: format === 'anthropic' && Number.isFinite(legacyMax) && legacyMax > 0 ? legacyMax : null,
        temperature: Number.isFinite(Number(profile.temperature)) ? Number(profile.temperature) : 0.3,
        reasoningEffort: 'max',
        timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : 120000,
    };
}

export function translateTv1Settings(source = {}) {
    const mapped = {
        enabled: source.globalEnabled !== false,
        trees: deepClone(source.trees || {}),
        selectedLorebook: source.selectedLorebook || null,
        enabledLorebooks: deepClone(source.enabledLorebooks || {}),
        bookPermissions: deepClone(source.bookPermissions || {}),
        bookInjectionModes: Object.fromEntries(Object.entries(source.bookInjectionModes || {}).map(([book,mode])=>[book, String(mode).toLowerCase()==='native'?'st':'tv2'])),
        bookDescriptions: deepClone(source.bookDescriptions || {}),
        sidecarA: mapTv1SidecarProfile(source.sidecarProfile || {}, source.llmCallTimeout),
        retrieval: {
            enabled: source.sidecarAutoRetrieval === true,
            contextMessages: Number(source.sidecarContextMessages) > 0 ? Number(source.sidecarContextMessages) : 10,
            regionPreviewDepth: Number(source.collapsedDepth) >= 0 ? Math.min(4, Number(source.collapsedDepth)) : 2,
        },
        smartContext: {
            enabled: source.smartContextEnabled === true,
            contextMessages: Number(source.smartContextLookback) > 0 ? Number(source.smartContextLookback) : 8,
        },
        postTurn: {
            enabled: source.postTurnEnabled === true || source.sidecarPostGenWriter === true,
            contextMessages: Number(source.sidecarWriterContextMessages) > 0 ? Number(source.sidecarWriterContextMessages) : 10,
        },
    };

    const skipped = [];
    const legacyCaps = {
        sidecarMaxTokens: Number(source.sidecarProfile?.maxTokens) || null,
        retrievalInjectionTokens: Number(source.sidecarMaxInjectionTokens) || null,
        smartContextMaxEntries: Number(source.smartContextMaxEntries) || null,
        smartContextMaxChars: Number(source.smartContextMaxChars) || null,
        writerMaxOps: Number(source.sidecarWriterMaxOps) || null,
        totalInjectionBudget: Number(source.totalInjectionBudget) || null,
    };
    if (Object.values(legacyCaps).some(v => Number(v) > 0)) {
        skipped.push({ field: 'legacyCaps', reason: 'Nexus does not inherit TV1 arbitrary caps/restrictions; actual use is measured in telemetry.', values: legacyCaps });
    }
    if (source.trackerUids && Object.keys(source.trackerUids).length) skipped.push({ field: 'trackerUids', reason: 'Nexus tracker pipeline is not implemented yet.' });
    if (source.embeddingProfile?.enabled) skipped.push({ field: 'embeddingProfile', reason: 'Nexus embedding worker is not implemented yet.' });
    if (source.worldStateEnabled) skipped.push({ field: 'worldState', reason: 'Nexus world-state worker is not implemented yet.' });
    if (source.autoSummaryEnabled) skipped.push({ field: 'autoSummary', reason: 'Legacy summary state is not automatically imported into the v0.4 recursive Memory Bank.' });
    if (source.lifecycleEnabled) skipped.push({ field: 'memoryLifecycle', reason: 'Nexus maintenance worker is not implemented yet.' });

    return { mapped, skipped };
}
