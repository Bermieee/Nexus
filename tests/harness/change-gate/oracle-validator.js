import { CHANGE_GATE_SCENARIOS } from './fixture-definition.js';

function fail(message, details = {}) {
    const error = new Error(message);
    error.details = details;
    throw error;
}

function includesAll(actual = [], expected = []) {
    const set = new Set(actual || []);
    return (expected || []).every(item => set.has(item));
}

/**
 * Synthetic/local oracle validation only.
 *
 * This function is intentionally allowed to call the production classifier
 * directly because its result is only a fast regression signal. It must never
 * be substituted for live SillyTavern acceptance from the command launcher.
 */
export function validateChangeGateFixtureOracles({
    classifyRetrievalChange,
    applyReuseFreshness,
    refreshAfter = 3,
} = {}) {
    if (typeof classifyRetrievalChange !== 'function') {
        throw new Error('validateChangeGateFixtureOracles requires classifyRetrievalChange().');
    }

    const rows = [];
    for (const scenario of CHANGE_GATE_SCENARIOS) {
        if (scenario.id === 'CG-MN-005') {
            if (typeof applyReuseFreshness !== 'function') {
                throw new Error('CG-MN-005 requires applyReuseFreshness().');
            }
            const limit = Math.max(1, Number(refreshAfter) || 3);
            const state = { noChangeStreak: 0 };
            let observed = null;
            const sequence = [];
            for (let index = 0; index < limit + 1; index += 1) {
                const base = classifyRetrievalChange({
                    currentText: scenario.currentText,
                    recentText: scenario.baselineText,
                    hasReusableInjection: true,
                });
                observed = applyReuseFreshness(base, state, limit);
                sequence.push(observed.mode);
            }
            if (observed?.mode !== 'MINOR_CHANGE' || observed?.promotedFrom !== 'NO_CHANGE') {
                fail(`${scenario.id} freshness sequence did not promote NO_CHANGE to MINOR_CHANGE.`, {
                    observed,
                    sequence,
                    limit,
                });
            }
            rows.push({ id: scenario.id, pass: true, observed, sequence });
            continue;
        }

        const observed = classifyRetrievalChange({
            currentText: scenario.currentText,
            recentText: scenario.baselineText,
            hasReusableInjection: scenario.primeReusableInjection,
        });
        const expected = scenario.expected || {};

        if (expected.mode && observed?.mode !== expected.mode) {
            fail(`${scenario.id} expected ${expected.mode} but observed ${observed?.mode}.`, { scenario, observed });
        }
        if (expected.notMode && observed?.mode === expected.notMode) {
            fail(`${scenario.id} must not classify as ${expected.notMode}.`, { scenario, observed });
        }
        if (expected.signals?.length && !includesAll(observed?.signals, expected.signals)) {
            fail(`${scenario.id} is missing expected transition signal(s).`, {
                expectedSignals: expected.signals,
                observedSignals: observed?.signals || [],
                observed,
            });
        }
        if (expected.mustNotSignal?.length && (observed?.signals || []).some(signal => expected.mustNotSignal.includes(signal))) {
            fail(`${scenario.id} emitted a forbidden transition signal.`, {
                forbidden: expected.mustNotSignal,
                observedSignals: observed?.signals || [],
                observed,
            });
        }

        rows.push({ id: scenario.id, pass: true, observed });
    }

    return {
        kind: 'synthetic-change-gate-oracle-validation',
        passed: true,
        scenarioCount: rows.length,
        rows,
    };
}
