import { deepCopy } from './contracts.js';

function cooldownScope(ticket={}) {
    const meta=ticket?.metadata||{};
    const chatId=meta.nexusChatId ?? meta.chatId ?? null;
    const epoch=Number(meta.nexusChatEpoch);
    if(chatId!=null || (Number.isFinite(epoch)&&epoch>0)) return `chat:${chatId??'none'}|epoch:${Number.isFinite(epoch)&&epoch>0?epoch:'none'}`;
    return 'global';
}
function cooldownKey(ticket={}) { return `${String(ticket?.capability||'unknown')}|${cooldownScope(ticket)}`; }
function normalizeRunRow(value){ if(value&&typeof value==='object')return {at:Number(value.at)||0,correlationId:value.correlationId==null?null:String(value.correlationId)};return {at:Number(value)||0,correlationId:null}; }

/**
 * A deterministic second decision after capability policy.
 * Policy answers "is this kind of call allowed?" Logic Gate answers "should
 * this permitted call run now?" No model is used for either decision.
 */
export class CallCenterLogicGate {
    constructor({ enabled = false, allowAutomatic = false, cooldownMs = 1500, testHarnessEnabled = true } = {}) {
        this.lastRunByCapability = new Map();
        this.configure({ enabled, allowAutomatic, cooldownMs, testHarnessEnabled });
    }

    configure({ enabled = false, allowAutomatic = false, cooldownMs = 1500, testHarnessEnabled = true } = {}) {
        this.config = {
            enabled: enabled === true,
            allowAutomatic: allowAutomatic === true,
            cooldownMs: Math.max(0, Number(cooldownMs) || 0),
            testHarnessEnabled: testHarnessEnabled !== false,
        };
        return this.snapshot();
    }

    inspect(ticket, { now = Date.now(), targetHealth = 'unknown', isTest = false } = {}) {
        const checks = [];
        if (!this.config.enabled) return { allowed: false, reason: 'Call Center is disabled.', checks: [{ name: 'call-center-enabled', passed: false }] };
        checks.push({ name: 'call-center-enabled', passed: true });
        if (ticket.automatic && !this.config.allowAutomatic) return { allowed: false, reason: 'Automatic calls are disabled by the Logic Gate.', checks: [...checks, { name: 'automatic-policy', passed: false }] };
        checks.push({ name: 'automatic-policy', passed: true });
        if (isTest && !this.config.testHarnessEnabled) return { allowed: false, reason: 'The local test harness is disabled.', checks: [...checks, { name: 'test-harness', passed: false }] };
        if (isTest) checks.push({ name: 'test-harness', passed: true });
        if (!isTest && targetHealth === 'unhealthy') return { allowed: false, reason: 'The selected target is unhealthy.', checks: [...checks, { name: 'target-health', passed: false }] };
        checks.push({ name: 'target-health', passed: true, value: targetHealth });
        const key=cooldownKey(ticket),last=normalizeRunRow(this.lastRunByCapability.get(key));
        const sameWorkflow = last.correlationId != null && ticket?.correlationId != null && String(ticket.correlationId) === last.correlationId;
        const remaining = sameWorkflow ? 0 : Math.max(0, this.config.cooldownMs - (now - last.at));
        if (remaining > 0) return { allowed: false, reason: `Cooldown active for ${remaining} ms.`, retryAfterMs: remaining, checks: [...checks, { name: 'cooldown', passed: false, remaining, key }] };
        checks.push({ name: 'cooldown', passed: true, continuation: sameWorkflow, key });
        return { allowed: true, reason: null, checks };
    }

    recordRun(ticket, now = Date.now()) { const key=cooldownKey(ticket),previous=this.lastRunByCapability.has(key)?normalizeRunRow(this.lastRunByCapability.get(key)):null,row={at:Number(now)||Date.now(),correlationId:ticket?.correlationId==null?null:String(ticket.correlationId)};this.lastRunByCapability.set(key,row);return {key,previous,row:{...row}}; }

    rollbackRun(ticket, lease) {
        const key=lease?.key||cooldownKey(ticket);
        const current=normalizeRunRow(this.lastRunByCapability.get(key));
        if(!lease?.row || current.at!==Number(lease.row.at)||current.correlationId!==(lease.row.correlationId??null))return false;
        if(lease.previous)this.lastRunByCapability.set(key,{...lease.previous});else this.lastRunByCapability.delete(key);
        return true;
    }

    exportState() {
        return {
            config: deepCopy(this.config),
            lastRunByCapability: [...this.lastRunByCapability.entries()].map(([key, row]) => [String(key), normalizeRunRow(row)]),
        };
    }

    restoreState(state = {}) {
        const rows = Array.isArray(state?.lastRunByCapability) ? state.lastRunByCapability : [];
        this.lastRunByCapability = new Map(rows
            .filter(row => Array.isArray(row) && row.length >= 2 && String(row[0] || '').trim())
            .map(row => { const rawKey=String(row[0]); const key=rawKey.includes('|chat:')||rawKey.includes('|global')?rawKey:`${rawKey}|global`; return [key,normalizeRunRow(row[1])]; }));
        return this.snapshot();
    }

    snapshot() { return { config: deepCopy(this.config), recentCapabilities: [...this.lastRunByCapability.keys()] }; }
}
