/**
 * SillyTavern Main generation boundary adapter.
 *
 * This module is intentionally dependency-injected so smoke tests can exercise
 * the exact translation without importing SillyTavern itself. Generation Gateway
 * uses it for both policy-cleared Call Tickets and internal model-worker leases.
 * It never imports or addresses Sidecar A/B.
 */

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);
const DEFAULT_RECENT_MESSAGES = 6;
const DEFAULT_RECENT_CHARS = 12_000;
const MAX_RECENT_MESSAGES = 24;
const MAX_RECENT_CHARS = 32_000;
const MAX_RESPONSE_LENGTH = 131_072;

const REASONING_EFFORTS = new Set(['minimal','low','medium','high']);
const REASONING_EFFORT_SOURCES = new Set(['openrouter','deepseek','perplexity','xai','chutes','aimlapi','electronhub','nanogpt','pollinations','custom']);

let hostControlBridgePromise = null;
async function resolveHostControlBridge(eventSource,eventTypes){
    if(eventSource&&eventTypes?.CHAT_COMPLETION_SETTINGS_READY)return {eventSource,eventTypes};
    hostControlBridgePromise ||= import('../../../../../script.js')
        .then(mod=>({eventSource:mod?.eventSource||null,eventTypes:mod?.event_types||null}))
        .catch(()=>({eventSource:null,eventTypes:null}));
    const host=await hostControlBridgePromise;
    return {eventSource:eventSource||host.eventSource,eventTypes:eventTypes||host.eventTypes};
}

function removeListener(source,event,handler){
    if(!source||!event||!handler)return;
    try{if(typeof source.off==='function')source.off(event,handler);else if(typeof source.removeListener==='function')source.removeListener(event,handler);else source.removeEventListener?.(event,handler);}catch{}
}
function addListener(source,event,handler){
    if(!source||!event||typeof source.on!=='function'||typeof handler!=='function')return false;
    source.on(event,handler);return true;
}
function errorText(error){
    const rows=[error?.message,error?.error?.message,error?.response,error?.statusText];
    try{rows.push(JSON.stringify(error));}catch{}
    return rows.filter(Boolean).join(' ').toLowerCase();
}
function controlRejection(error){
    const text=errorText(error);
    if(!/(400|bad request|invalid|unsupported|not supported|unknown)/.test(text))return null;
    if(/response[_ -]?format|json[_ -]?schema|structured/.test(text))return 'json-schema';
    if(/reasoning[_ -]?effort|reasoning|thinking/.test(text))return 'reasoning';
    if(/temperature/.test(text))return 'temperature';
    return null;
}
function workerPromptMatches(eventData,active){
    const expected=clean(active?.prompt);
    if(!expected)return false;
    const messages=Array.isArray(eventData?.messages)?eventData.messages:[];
    if(!messages.length)return false;
    const sample=expected.length>256?`${expected.slice(0,128)}|${expected.slice(-128)}`:expected;
    if(sample.includes('|')){
        const [head,tail]=sample.split('|');
        return messages.some(row=>String(row?.content||'').includes(head)&&String(row?.content||'').includes(tail));
    }
    return messages.some(row=>String(row?.content||'').includes(sample));
}
function applyWorkerControls(eventData,active){
    const controls=active?.controls||{};
    const report={ticketId:active?.ticketId||null,applied:[],skipped:[],before:{},after:{},source:eventData?.chat_completion_source??eventData?.chatCompletionSource??null,model:eventData?.model??null};
    const source=clean(report.source).toLowerCase();
    const desiredEffort=clean(controls.reasoningEffort).toLowerCase();
    if(REASONING_EFFORTS.has(desiredEffort)){
        report.before.reasoningEffort=eventData?.reasoning_effort??eventData?.reasoning?.effort??null;
        if(Object.prototype.hasOwnProperty.call(eventData,'reasoning_effort')||REASONING_EFFORT_SOURCES.has(source)){
            eventData.reasoning_effort=desiredEffort;report.applied.push('reasoning_effort');
        }else report.skipped.push('reasoning_effort:provider-shape-unavailable');
        report.after.reasoningEffort=eventData?.reasoning_effort??eventData?.reasoning?.effort??null;
    }
    if(controls.temperature!==null&&controls.temperature!==undefined&&controls.temperature!==''&&Number.isFinite(Number(controls.temperature))){
        report.before.temperature=eventData?.temperature??null;
        if(Object.prototype.hasOwnProperty.call(eventData,'temperature')){eventData.temperature=Number(controls.temperature);report.applied.push('temperature');}
        else report.skipped.push('temperature:provider-shape-unavailable');
        report.after.temperature=eventData?.temperature??null;
    }
    if(controls.excludeReasoning===true){
        report.before.includeReasoning=eventData?.include_reasoning??eventData?.includeReasoning??null;
        if(Object.prototype.hasOwnProperty.call(eventData,'include_reasoning')){eventData.include_reasoning=false;report.applied.push('include_reasoning=false');}
        else if(Object.prototype.hasOwnProperty.call(eventData,'includeReasoning')){eventData.includeReasoning=false;report.applied.push('includeReasoning=false');}
        else report.skipped.push('include_reasoning:provider-shape-unavailable');
        report.after.includeReasoning=eventData?.include_reasoning??eventData?.includeReasoning??null;
    }
    if(controls.stream===false&&Object.prototype.hasOwnProperty.call(eventData,'stream')){report.before.stream=eventData.stream;eventData.stream=false;report.after.stream=eventData.stream;report.applied.push('stream=false');}
    return report;
}

function clean(value) { return String(value ?? '').trim(); }
function positiveInt(value, fallback = null, max = Number.MAX_SAFE_INTEGER) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(max, Math.max(1, Math.floor(n)));
}
function deepCopy(value) {
    if (value === undefined) return undefined;
    try { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch { return null; }
}

function normalizePromptMessages(messages = []) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    for (const row of messages) {
        if (!row || typeof row !== 'object') continue;
        const role = clean(row.role).toLowerCase();
        const content = clean(row.content);
        if (!ALLOWED_ROLES.has(role) || !content) continue;
        const message = { role, content };
        const name = clean(row.name);
        if (name) message.name = name.slice(0, 128);
        out.push(message);
    }
    return out;
}

function recentContextMessages(readChat, policy = {}) {
    if (clean(policy.mode).toLowerCase() !== 'recent') return [];
    const maxMessages = positiveInt(policy.maxMessages, DEFAULT_RECENT_MESSAGES, MAX_RECENT_MESSAGES);
    const maxChars = positiveInt(policy.maxChars, DEFAULT_RECENT_CHARS, MAX_RECENT_CHARS);
    const includeSystem = policy.includeSystem === true;
    const rows = typeof readChat === 'function' ? readChat() : [];
    if (!Array.isArray(rows) || !rows.length) return [];

    const selected = [];
    let chars = 0;
    for (let i = rows.length - 1; i >= 0 && selected.length < maxMessages; i -= 1) {
        const row = rows[i];
        if (!row || (!includeSystem && row.is_system === true)) continue;
        const content = clean(row.mes ?? row.content);
        if (!content) continue;
        const role = row.is_system === true ? 'system' : row.is_user === true ? 'user' : 'assistant';
        const remaining = maxChars - chars;
        if (remaining <= 0) break;
        // Prefer newest context. If the oldest included row would exceed the
        // cap, retain only its tail because that is closest to the later turns.
        const bounded = content.length > remaining ? content.slice(-remaining) : content;
        selected.push({ role, content: bounded });
        chars += bounded.length;
    }
    return selected.reverse();
}

export function buildSillyTavernGenerationRequest(request = {}, { readChat = null } = {}) {
    const args = request?.arguments && typeof request.arguments === 'object' ? request.arguments : {};
    const contextPolicy = request?.contextPolicy && typeof request.contextPolicy === 'object' ? request.contextPolicy : {};
    const responsePolicy = request?.responsePolicy && typeof request.responsePolicy === 'object' ? request.responsePolicy : {};

    const suppliedMessages = normalizePromptMessages(args.messages);
    const promptText = clean(args.prompt ?? args.instruction ?? args.query);
    if (!suppliedMessages.length && !promptText) throw new Error('Nexus → Main ticket requires arguments.prompt, arguments.instruction, arguments.query, or arguments.messages.');

    const context = recentContextMessages(readChat, contextPolicy);
    let prompt;
    if (suppliedMessages.length || context.length) {
        prompt = [...context, ...suppliedMessages];
        if (promptText) prompt.push({ role: 'user', content: promptText });
    } else {
        prompt = promptText;
    }

    const responseLength = positiveInt(
        responsePolicy.responseLength ?? responsePolicy.maxTokens ?? args.responseLength,
        null,
        MAX_RESPONSE_LENGTH,
    );
    const jsonSchema = responsePolicy.jsonSchema && typeof responsePolicy.jsonSchema === 'object' && !Array.isArray(responsePolicy.jsonSchema)
        ? deepCopy(responsePolicy.jsonSchema)
        : null;

    return {
        prompt,
        // Intentionally omit `api`: generateRaw then uses SillyTavern's current
        // Main connection. A Call Ticket may not switch providers behind policy.
        instructOverride: responsePolicy.instructOverride === true,
        quietToLoud: responsePolicy.quietToLoud === true,
        systemPrompt: clean(args.systemPrompt ?? responsePolicy.systemPrompt),
        responseLength,
        trimNames: responsePolicy.trimNames !== false,
        prefill: clean(args.prefill ?? responsePolicy.prefill),
        jsonSchema,
    };
}

export function createSillyTavernGenerationAdapter({ generateRaw, readChat = null, onActivity = null, cancelGeneration = null, eventSource = null, eventTypes = null, onWorkerControl = null } = {}) {
    if (typeof generateRaw !== 'function') throw new Error('SillyTavern Generation adapter requires generateRaw().');
    const activity = typeof onActivity === 'function' ? onActivity : null;
    const cancel = typeof cancelGeneration === 'function' ? cancelGeneration : null;
    const controlObserver = typeof onWorkerControl === 'function' ? onWorkerControl : null;
    let controlEventSource=eventSource||null;
    let controlEventTypes=eventTypes||null;
    let settingsEvent=controlEventTypes?.CHAT_COMPLETION_SETTINGS_READY||null;
    let listenerInstalled=false;
    let activeWorker = null;
    const settingsHandler = eventData => {
        if(!activeWorker||!workerPromptMatches(eventData,activeWorker))return;
        activeWorker.controlReport=applyWorkerControls(eventData,activeWorker);
        try{controlObserver?.({...activeWorker.controlReport,requested:deepCopy(activeWorker.controls)});}catch{}
    };
    const ensureWorkerControlListener=async()=>{
        if(listenerInstalled)return true;
        const bridge=await resolveHostControlBridge(controlEventSource,controlEventTypes);
        controlEventSource=bridge.eventSource;controlEventTypes=bridge.eventTypes;
        settingsEvent=controlEventTypes?.CHAT_COMPLETION_SETTINGS_READY||null;
        listenerInstalled=addListener(controlEventSource,settingsEvent,settingsHandler);
        return listenerInstalled;
    };

    const adapter = async function dispatchSillyTavernMain(request = {}, ticket = {}, { signal = null } = {}) {
        const ticketId = clean(request.ticketId || ticket?.id || 'unknown');
        const internalWorker=request?.metadata?.internalModelWorker === true;
        const source = internalWorker ? `model-worker:${ticketId}` : `call-center:${ticketId}`;
        const generationRequest = buildSillyTavernGenerationRequest(request, { readChat });
        const workerControls=request?.responsePolicy?.workerControls&&typeof request.responsePolicy.workerControls==='object'?deepCopy(request.responsePolicy.workerControls):null;
        activity?.(true, 'generation-gateway-started', source);
        let cancellationRequested = false;
        const onAbort = () => {
            cancellationRequested = true;
            if (signal?.reason?.cancelPhysical !== false) { try { cancel?.(); } catch {} }
        };
        if (signal?.aborted) onAbort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
        const state=internalWorker?{ticketId,prompt:typeof generationRequest.prompt==='string'?generationRequest.prompt:JSON.stringify(generationRequest.prompt),controls:workerControls||{},controlReport:null,adaptation:null}:null;
        if(state){await ensureWorkerControlListener();activeWorker=state;}
        const execute=async requestShape=>{
            const result=await generateRaw(requestShape);
            if(signal?.aborted||cancellationRequested)throw signal?.reason||Object.assign(new Error('Nexus Main generation cancelled.'),{name:'AbortError'});
            return result;
        };
        try {
            let result;
            try{result=await execute(generationRequest);}
            catch(error){
                if(signal?.aborted||cancellationRequested)throw signal?.reason||error;
                const rejected=internalWorker?controlRejection(error):null;
                if(rejected==='json-schema'&&generationRequest.jsonSchema){
                    state.adaptation='retry-without-json-schema';
                    controlObserver?.({ticketId,adaptation:state.adaptation,error:error?.message||String(error)});
                    result=await execute({...generationRequest,jsonSchema:null});
                }else if(rejected==='reasoning'&&state?.controls?.reasoningEffort){
                    state.adaptation='retry-without-reasoning-override';
                    state.controls={...state.controls,reasoningEffort:null};
                    controlObserver?.({ticketId,adaptation:state.adaptation,error:error?.message||String(error)});
                    result=await execute(generationRequest);
                }else if(rejected==='temperature'&&state?.controls?.temperature!==null&&state?.controls?.temperature!==undefined&&state?.controls?.temperature!==''&&Number.isFinite(Number(state.controls.temperature))){
                    state.adaptation='retry-without-temperature-override';
                    state.controls={...state.controls,temperature:null};
                    controlObserver?.({ticketId,adaptation:state.adaptation,error:error?.message||String(error)});
                    result=await execute(generationRequest);
                }else throw error;
            }
            if(!internalWorker)return result;
            if(listenerInstalled&&!state?.controlReport){
                state.controlReport={ticketId,applied:[],skipped:['settings-ready:not-observed'],before:{},after:{},source:null,model:null};
                try{controlObserver?.({...state.controlReport,requested:deepCopy(state.controls)});}catch{}
            }
            return {text:String(result??''),raw:result,tv2MainWorker:{
                controls:state?.controlReport||null,
                adaptation:state?.adaptation||null,
                jsonSchemaRequested:!!generationRequest.jsonSchema,
                jsonSchemaPassedToST:!!generationRequest.jsonSchema&&state?.adaptation!=='retry-without-json-schema',
                settingsReadyObserved:!!state?.controlReport&&!state.controlReport.skipped?.includes?.('settings-ready:not-observed'),
            }};
        } catch(error) {
            if(internalWorker&&error&&typeof error==='object'){
                try{error.tv2MainWorker={
                    controls:state?.controlReport||null,
                    adaptation:state?.adaptation||null,
                    jsonSchemaRequested:!!generationRequest.jsonSchema,
                    jsonSchemaPassedToST:!!generationRequest.jsonSchema&&state?.adaptation!=='retry-without-json-schema',
                    settingsReadyObserved:!!state?.controlReport&&!state.controlReport.skipped?.includes?.('settings-ready:not-observed'),
                };}catch{}
            }
            throw error;
        } finally {
            if(activeWorker===state)activeWorker=null;
            signal?.removeEventListener?.('abort', onAbort);
            activity?.(false, 'generation-gateway-ended', source);
        }
    };
    adapter.dispose=()=>{removeListener(controlEventSource,settingsEvent,settingsHandler);activeWorker=null;listenerInstalled=false;};
    Object.defineProperty(adapter,'workerControlListenerInstalled',{get:()=>listenerInstalled});
    return adapter;
}
