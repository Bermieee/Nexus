import { getTelemetryActivitySnapshot, onTelemetryChange } from './observability/telemetry.js';
import { openTreeWorkspace } from './tree/ui.js';
import { getSchedulerState } from './lifecycle/scheduler.js';
import { getJobQueue } from './core/job-queue.js';
import { getSettings } from './core/settings.js';
import { snapshotMainBridgeStatus, getMainBridgeStatusEventName } from './nexus/main-bridge-status.js';
import { openNexusControlPanel } from './standalone-ui.js';

const POS_KEY='tv2:feed:trigger-pos';
const PANEL_POS_KEY='tv2:feed:panel-pos';
const PANEL_SIZE_KEY='tv2:feed:panel-size';
const CUTOFF_KEY='tv2:feed:cutoff';
const MAX_ITEMS=80;

let initialized=false;
let triggerEl=null;
let panelEl=null;
let bodyEl=null;
let tabsEl=null;
let liveEl=null;
let activeTab='all';
let cutoff=0;
let acknowledgedThrough=0;
let unsubscribe=null;
let feedRenderHandle=null;
let feedRenderHandleKind='';
let pendingFeedAcknowledge=false;

function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
function icon(name){const i=document.createElement('i');i.className=`fa-solid ${name}`;return i;}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function time(ts){try{return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}catch{return'';}}
function words(name){return String(name||'event').replace(/[-_]+/g,' ').replace(/\b\w/g,m=>m.toUpperCase());}
function n(v){const x=Number(v);return Number.isFinite(x)?x:0;}

function kindFor(evt){
    const c=evt.category;
    if(['retrieval','search','tree','smart-context','scene-scanner','lore','memory','summary','memory-recall','scheduler-cycle','batch-bus','character-memory'].includes(c))return'memory';
    if(['tools','proposals','postturn'].includes(c))return'proposals';
    return'system';
}

const USER_EVENT_NAMES = new Set([
    'change-gate','change-gate-scene-delta','scan-accepted','injection-complete','injection-reused',
    'prewarm-complete','manual-pin-added','manual-pin-removed',
    'card-bound','card-context-warmed',
    'tree-import-complete','manual-node-saved','created','proposal-staging-summary',
    'analysis-complete','drain-complete','drain-failed','invocation-success','invocation-failure','failure-fallback',
    'record-created','created','promoted','promotion-check-complete','lore-route-analysis','lore-route-complete','lore-route-failed','step-failed'
]);

const HUMAN_REDUNDANT_EVENTS = new Set([
    // Post-turn emits one authoritative drain/summary after staging. Showing
    // every stage twice (Post-turn + Proposal) turns one analysis into dozens
    // of visually identical feed rows.
    'postturn:proposal-staged',
    // Candidate -> rerank -> injection is one recall action in the human feed.
    'memory-recall:candidate-pool',
    'memory-recall:rerank-complete',
    // Character recognition/scene trigger are developer trace beneath the
    // resulting context warm event.
    'character-memory:card-active-detected',
    'character-memory:card-scene-triggered',
    // The Vector Paging probe already says why ordinary retrieval was retained.
    'retrieval:paging-fallback-execution-refresh',
    // Analysis/checkpoint rows are intermediate state when a later authoritative
    // outcome exists. Keep them in subsystem/System views, not the All story.
    'summary:promotion-check-complete',
    'memory:lore-route-analysis',
]);

function humanRedundant(evt,tab=activeTab){
    const key=`${evt?.category}:${evt?.name}`;
    if(HUMAN_REDUNDANT_EVENTS.has(key))return true;
    // Routine lifecycle plumbing belongs in System. Subsystems already emit the
    // user-meaningful outcome (retrieval injected, post-turn staged, warm ready,
    // summary saved, etc.). Keep failures because they require attention.
    if(evt?.category==='scheduler-cycle'&&evt?.name!=='step-failed')return true;
    if(evt?.category==='workload'&&evt?.name==='job-offloaded')return true;
    // In All, each Proposal is represented by the Post-turn aggregate. The
    // Proposals tab still shows one canonical Proposal enqueue per proposal.
    if(tab==='all'&&evt?.category==='proposals'&&evt?.name==='enqueued')return true;
    if(tab==='all'&&evt?.category==='postturn'&&evt?.name==='analysis-complete')return true;
    // Pin recalculation is implementation detail; prewarm-complete already
    // communicates that Smart Context is ready.
    if(evt?.category==='smart-context'&&evt?.name==='active-pins-updated')return true;
    return false;
}

function visibleForTab(evt,tab=activeTab){
    if(!evt||evt.ts<=cutoff)return false;
    if(tab==='system')return true; // System is the intentionally noisy plumbing tab.
    if(evt.level==='debug')return false;
    if(humanRedundant(evt,tab))return false;
    if(tab==='all'){
        // All is a human-facing story of what Nexus did, not every internal function.
        // Low-level bus/routing/Sidecar lifecycle remains in System + full Diagnostics.
        if(['sidecar-a','sidecar-b','sidecar','bus','routing','scheduler','runtime','lifecycle','settings','multi-bus','queue-dispatcher','nexus-batch','nexus-director'].includes(evt.category))return false;
        if(evt.category==='batch-bus')return ['batch-job-created','batch-job-complete','batch-job-failed','batch-attempt-failed'].includes(evt.name);
        if(evt.category==='workload')return evt.name==='failure-fallback';
        return USER_EVENT_NAMES.has(evt.name)||evt.level==='error'||evt.level==='warn';
    }
    return true;
}
function meaningful(evt){return visibleForTab(evt,activeTab);}

function display(evt){
    const d=evt.data||{};
    const fail=evt.level==='error'||String(evt.name).includes('failed')||String(evt.name).includes('failure');
    const warn=evt.level==='warn';
    const map={
        retrieval:{icon:'fa-diagram-project',color:'#8b5cf6',verb:'Retrieval'},
        search:{icon:'fa-magnifying-glass',color:'#e84393',verb:'Search'},
        tree:{icon:'fa-folder-tree',color:'#00b894',verb:'Tree'},
        'smart-context':{icon:'fa-thumbtack',color:'#00cec9',verb:'Smart Context'},
        'scene-scanner':{icon:'fa-crosshairs',color:'#74b9ff',verb:'Scene Scanner'},
        'character-memory':{icon:'fa-address-card',color:'#74b9ff',verb:'Character Card'},
        lore:{icon:'fa-book-open',color:'#f0946c',verb:'Lore'},
        tools:{icon:'fa-screwdriver-wrench',color:'#0984e3',verb:'Tool'},
        proposals:{icon:'fa-inbox',color:'#fdcb6e',verb:'Proposal'},
        postturn:{icon:'fa-brain',color:'#a29bfe',verb:'Post-turn'},
        memory:{icon:'fa-layer-group',color:'#9b59b6',verb:'Memory Bank'},
        summary:{icon:'fa-compress',color:'#8e44ad',verb:'Summary'},
        'memory-recall':{icon:'fa-clock-rotate-left',color:'#16a085',verb:'Memory Recall'},
        'scheduler-cycle':{icon:'fa-calendar-check',color:'#7f8c8d',verb:'Lifecycle'},
        'sidecar-a':{icon:'fa-microchip',color:'#74b9ff',verb:'SC-A'},
        'sidecar-b':{icon:'fa-microchip',color:'#55efc4',verb:'SC-B'},
        sidecar:{icon:'fa-microchip',color:'#74b9ff',verb:'Sidecar'},
        workload:{icon:'fa-route',color:'#81ecec',verb:'Workload'},
        routing:{icon:'fa-route',color:'#81ecec',verb:'Routing'},
        'multi-bus':{icon:'fa-code-branch',color:'#6c5ce7',verb:'Multi-Sidecar'},
        'batch-bus':{icon:'fa-layer-group',color:'#d4af37',verb:'Batch Fire'},
        'vector-paging':{icon:'fa-share-nodes',color:'#9b59b6',verb:'Vector Paging'},
        bus:{icon:'fa-shuffle',color:'#636e72',verb:'Bus'},
    };
    const base=map[evt.category]||{icon:'fa-circle-info',color:'#b2bec3',verb:words(evt.category)};
    if(evt.category==='memory'&&evt.name==='lore-route-recovery-required')return{...base,icon:'fa-triangle-exclamation',color:'#d63031',verb:'Memory Bank recovery required'};
    if(fail)return{...base,icon:'fa-triangle-exclamation',color:'#d63031',verb:`${base.verb} failed`};
    if(warn)return{...base,color:'#e17055'};
    return base;
}

function summaryFor(evt){
    const d=evt.data||{};
    switch(`${evt.category}:${evt.name}`){
        case'scene-scanner:scan-accepted': {
            const participants=Array.isArray(d.participants)&&d.participants.length?d.participants.join(', '):'no named participants';
            const location=d.location?` · ${d.location}`:'';
            return `${participants}${location}${d.degraded?' · degraded':''}`;
        }
        case'retrieval:change-gate-scene-delta': {
            const mode=String(d.mode||'').replaceAll('_',' ');
            const signals=[...(d.hardSignals||[]),...(d.softSignals||[])].map(x=>String(x).replace(/-boundary$/,'').replaceAll('-',' '));
            return `${mode}${signals.length?` · ${signals.join(', ')}`:d.reason?` · ${d.reason}`:''}`.trim();
        }
        case'retrieval:change-gate': {
            const mode=String(d.mode||'').replaceAll('_',' ');
            const rawPlan=String(d.retrievalPlan?.mode||'');
            const planLabel={INITIAL_FULL:'Full retrieval',FULL_REROUTE:'Full reroute',TARGETED_REFRESH:'Targeted refresh',REUSE:'Reuse'}[rawPlan]||rawPlan.replaceAll('_',' ');
            const signals=Array.isArray(d.hardSignals)&&d.hardSignals.length?d.hardSignals.map(x=>String(x).replace(/-boundary$/,'').replaceAll('-',' ')).join(', '):'';
            return `${mode}${planLabel?` · ${planLabel}`:''}${signals?` · ${signals}`:d.reason?` · ${d.reason}`:''}`.trim();
        }
        case'retrieval:region-scan-complete': return `${n(d.selectedCount??d.regionCount??d.regionRefs?.length??d.regions?.length)} region${n(d.selectedCount??d.regionCount??d.regionRefs?.length??d.regions?.length)===1?'':'s'} selected`;
        case'retrieval:node-scan-complete': return `${n(d.selectedCount??d.nodeCount??d.nodeRefs?.length??d.nodes?.length)} node${n(d.selectedCount??d.nodeCount??d.nodeRefs?.length??d.nodes?.length)===1?'':'s'} selected`;
        case'retrieval:injection-candidates-resolved': return `${n(d.candidateCount??d.candidates?.length)} injection candidates`;
        case'retrieval:injection-review-complete': return `${n(d.selectedCount??d.selected?.length)} entries approved`;
        case'retrieval:injection-complete': return `${n(d.entryCount??d.renderedEntryCount??d.refs?.length??d.selectedCount??d.entries?.length)} entries injected${(d.estimatedInjectionTokens??d.estimatedTokens)!=null?` · ≈${n(d.estimatedInjectionTokens??d.estimatedTokens).toLocaleString()} tok`:''}`;
        case'retrieval:injection-reused': return `Reused proven injection${d.entryCount!=null?` · ${n(d.entryCount)} entries`:''}`;
        case'search:tree-search-complete': return `${n(d.resultCount??d.results?.length)} Tree search result${n(d.resultCount??d.results?.length)===1?'':'s'}`;
        case'smart-context:prewarm-complete': return `${n(d.count??d.candidateCount??d.warmCount)} warm candidate${n(d.count??d.candidateCount??d.warmCount)===1?'':'s'} ready`;
        case'smart-context:deterministic-pool-ready': return `${n(d.count??d.candidateCount)} deterministic candidates`;
        case'smart-context:active-pins-updated': return `${n(d.count??d.pinCount??d.pins?.length)} active pin${n(d.count??d.pinCount??d.pins?.length)===1?'':'s'}`;
        case'smart-context:manual-pin-added': return `${d.book||'Lore'} · UID ${d.uid??'?'}`;
        case'smart-context:manual-pin-removed': return `${d.book||'Lore'} · UID ${d.uid??'?'}`;
        case'character-memory:card-bound': return `${d.character||d.cardName||'Character'} bound${d.linkedCount!=null?` · ${n(d.linkedCount)} lore link${n(d.linkedCount)===1?'':'s'}`:''}`;
        case'character-memory:card-active-detected': return `${d.character||d.cardName||'Character'} recognized as active ST card`;
        case'character-memory:card-scene-triggered': return `${d.character||d.cardName||'Character'} entered scene${d.linkedCount!=null?` · ${n(d.linkedCount)} linked lore`:''}`;
        case'character-memory:card-context-warmed': return `${d.character||'Character'} influenced Smart Context · ${n(d.linkedCount??d.refs?.length)} lore ref${n(d.linkedCount??d.refs?.length)===1?'':'s'} warm`;
        case'tree:created': return `${d.book||'Lorebook'} Tree created`;
        case'tree:tree-import-complete': return `${n(d.count)} Tree${n(d.count)===1?'':'s'} imported`;
        case'tree:manual-node-saved': return `${d.book||'Lore'} · node saved`;
        case'tools:invocation-start': return `${d.toolName||d.name||'Tool'} running…`;
        case'tools:invocation-success': return `${d.toolName||d.name||'Tool'} completed`;
        case'tools:invocation-failure': return `${d.toolName||d.name||'Tool'} · ${d.error?.message||d.error||'failed'}`;
        case'proposals:enqueued': return `${d.type||d.operation||'Lore'} proposal staged`;
        case'memory:record-created': return `Layer ${n(d.layer)} memory saved${d.turnRange?` · messages ${d.turnRange[0]}–${d.turnRange[1]}`:''}`;
        case'summary:created': return `Layer 0 summary created${d.turnRange?` · messages ${d.turnRange[0]}–${d.turnRange[1]}`:''}`;
        case'summary:promoted': return `Layer ${n(d.sourceLayer)} → ${n(d.targetLayer)} · ${n(d.childIds?.length)} memories compressed`;
        case'memory:lore-route-analysis': return `${n(d.operationCount)} lore operation${n(d.operationCount)===1?'':'s'} proposed from memory`;
        case'memory:lore-route-complete': return `${n(d.stagedCount)} lore proposal${n(d.stagedCount)===1?'':'s'} staged from memory`;
        case'memory:lore-route-saga-reconciled': return `${n(d.count??d.results?.length)} Lore Route recovery owner${n(d.count??d.results?.length)===1?'':'s'} reconciled`;
        case'memory:lore-route-recovery-required': {const rows=Array.isArray(d.results)?d.results:[];const reasons=[...new Set(rows.map(row=>row?.reason).filter(Boolean))];return `${n(d.count??rows.length)} Lore Route recovery owner${n(d.count??rows.length)===1?'':'s'} still unresolved${reasons.length?` · ${reasons.join(', ')}`:''}`;}
        case'memory-recall:candidate-pool': return `${n(d.candidateCount)} historical memory candidate${n(d.candidateCount)===1?'':'s'}`;
        case'memory-recall:rerank-complete': return `${n(d.selectedCount)} historical memories selected`;
        case'memory-recall:injection-complete': return `${n(d.selectedCount)} historical memories injected${d.estimatedTokens!=null?` · ≈${n(d.estimatedTokens).toLocaleString()} tok`:''}`;
        case'maintenance:housekeeper-complete': return `${n(d.findingCount)} finding${n(d.findingCount)===1?'':'s'} · ${n(d.adviceCount)} suggestion${n(d.adviceCount)===1?'':'s'}${d.memoryIssueCount!=null?` · ${n(d.memoryIssueCount)} memory issue${n(d.memoryIssueCount)===1?'':'s'}`:''}`;
        case'vector-paging:lore-cooling-result': return `Lore cooling · ${n(d.entriesSlept)} slept · ${n(d.protectedEntries)} protected · ${n(d.budgetResidentEntries)} budget-resident · logical only`;
        case'vector-paging:lore-wake-probe': {
            const vector=`vector ${d.queryVector?.availability||'unknown'}${d.queryVector?.cache?` (${d.queryVector.cache})`:''}`;
            if(d.fallbackReason){
                const stage=d.timing?.stage?` at ${String(d.timing.stage).replaceAll('-',' ')}`:'';
                const elapsed=d.timing?.elapsedMs!=null?` · ${n(d.timing.elapsedMs)}ms/${n(d.timing.activeBudgetMs)}ms`:'';
                return `${String(d.fallbackReason).replaceAll('-',' ')}${stage} · ${vector} · ordinary retrieval retained${elapsed}`;
            }
            return `${d.exclusionEnforced?'Paging active':'Observation'} · ${vector}${d.newlyAwakenedCount!=null?` · ${n(d.newlyAwakenedCount)} awakened`:''}`;
        }
        case'vector-paging:lore-wake-selection': return `${n(d.passedRetrievalCount)} vector nomination${n(d.passedRetrievalCount)===1?'':'s'} survived retrieval review`;
        case'vector-paging:lore-wake-outcome': return `${n(d.enteredInjectionCount)} vector nomination${n(d.enteredInjectionCount)===1?'':'s'} entered final injection`;
        case'vector-paging:memory-wake-probe': return `${d.probe||'probe'} · memory · vector ${d.queryVector?.availability||'unknown'} (${d.queryVector?.cache||'n/a'}) · ${d.exclusionEnforced?'paging exclusion enforced':`ordinary retrieval${d.fallbackReason?` · ${String(d.fallbackReason).replaceAll('-',' ')}`:''}`}`;
        case'vector-paging:memory-wake-selection': return `${n(d.passedRetrievalCount)} vector memory nomination${n(d.passedRetrievalCount)===1?'':'s'} survived semantic selection`;
        case'vector-paging:memory-wake-outcome': return `${n(d.enteredInjectionCount)} vector memory nomination${n(d.enteredInjectionCount)===1?'':'s'} entered final memory injection`;
        case'vector-paging:lore-index-provider-error': return `Lore index provider error · automatic retry stopped${d.reason?` · ${d.reason}`:''}`;
        case'vector-paging:lore-index-retry-scheduled': return `Lore index retry · ${Math.round(n(d.delayMs)/1000)}s${d.reason?` · ${d.reason}`:''}`;
        case'scheduler-cycle:cycle-start': return `${d.manual?'Manual':'Automatic'} lifecycle cycle started`;
        case'scheduler-cycle:step-running': return `${words(d.task||'step')} running${d.slot?` · SC-${d.slot}`:''}`;
        case'scheduler-cycle:step-complete': {
            const task=String(d.task||'step');
            if(task==='post-turn')return `Post-turn complete · ${n(d.stagedCount)} staged${n(d.operationCount)?` / ${n(d.operationCount)} found`:''}${d.slot?` · SC-${d.slot}`:''}`;
            if(task==='lore-routing')return `Lore routing complete · ${n(d.proposalCount)} proposal${n(d.proposalCount)===1?'':'s'} from ${n(d.memoryCount)} memor${n(d.memoryCount)===1?'y':'ies'}${d.slot?` · SC-${d.slot}`:''}`;
            if(task==='smart-warm')return `Smart Context warm complete · ${n(d.count)} warm ref${n(d.count)===1?'':'s'}${d.cached?' · cached':''}`;
            if(task==='summary')return `Summary complete${d.createdCount!=null?` · ${n(d.createdCount)} created`:d.turnRange?` · messages ${d.turnRange[0]}–${d.turnRange[1]}`:''}${d.slot?` · SC-${d.slot}`:''}`;
            if(task==='promotion')return `Promotion complete · ${n(d.promotions)} promoted${d.slot?` · SC-${d.slot}`:''}`;
            return `${words(task)} complete${d.slot?` · SC-${d.slot}`:''}`;
        }
        case'scheduler-cycle:step-skipped': return `${words(d.task||'step')} skipped · ${d.reason||'nothing to process'}`;
        case'scheduler-cycle:step-failed': return `${words(d.task||'step')} failed${d.error?` · ${String(d.error).slice(0,120)}`:''}`;
        case'scheduler-cycle:cycle-complete': return `${d.status||'complete'} · ${n(d.durationMs)/1000}s`;
        case'postturn:proposal-staged': return `${d.type||d.operation||'Lore'} proposal staged`;
        case'postturn:analysis-complete': {const c=n(d.operationCount??d.operations?.length??d.proposalCount??d.count);return `${c} proposed operation${c===1?'':'s'} found`;}
        case'postturn:proposal-staging-summary': return `${n(d.stagedCount)} staged · ${n(d.failedCount)} rejected`;
        case'postturn:drain-complete': {const types=Object.entries(d.operationTypes||{}).map(([k,v])=>`${n(v)} ${k}`).join(' · ');return `${n(d.stagedCount)} staged${types?` · ${types}`:''}${n(d.failedCount)?` · ${n(d.failedCount)} rejected`:''}`;}
        case'postturn:parent-recovery-quarantined': return `${n(d.count||d.recoveryResults?.length||1)} historical recovery owner${n(d.count||d.recoveryResults?.length||1)===1?'':'s'} quarantined · later unaffected turns may continue`;
        case'routing:route-success': return `${d.role||'job'} → SC-${d.slot||'?'}`;
        case'workload:job-offloaded': return `${d.role||'job'} → SC-${d.assignedSlot||'?'} · idle offload`;
        case'batch-bus:batch-job-created': return `${n(d.batchCount)} batches queued${d.dualIdleScatter?' · A+B fired together':''}`;
        case'batch-bus:batch-job-complete': return `${n(d.completedCount)}/${n(d.batchCount)} batches complete · ${(d.slotsUsed||[]).map(slot=>`SC-${slot}`).join(' + ')||'worker pool'}${n(d.failedCount)?` · ${n(d.failedCount)} failed`:''}`;
        case'batch-bus:batch-job-failed': return `${n(d.batchCount)}-batch retrieval failed`;
        case'batch-bus:batch-attempt-failed': return `Batch ${n(d.batchNumber)}/${n(d.batchCount)} failed on SC-${d.slot||'?'}${d.willRetry?` · retrying SC-${d.nextSlot||'?'}`:''}`;
    }
    if(evt.name==='request-success'||evt.name==='request-failure'||evt.name==='request-start'){
        const slot=d.slot?`SC-${d.slot}`:'';
        const model=d.model||'';
        const usage=d.usage||d.usageNormalized||{};
        const total=usage.totalTokens??d.totalTokens;
        return [slot,model,total!=null?`${n(total).toLocaleString()} tok`:null].filter(Boolean).join(' · ')||words(evt.name);
    }
    const err=d.error?.message||d.error;
    if(err)return `${words(evt.name)} · ${String(err).slice(0,160)}`;
    const label=d.book||d.role||d.label||d.model||d.state||'';
    return `${words(evt.name)}${label?` · ${label}`:''}`;
}

function filteredEvents(snapshot=null){
    const source=(snapshot||getTelemetryActivitySnapshot()).events.filter(evt=>evt&&evt.ts>cutoff);
    if(activeTab==='system')return source.slice(-MAX_ITEMS).reverse();
    const all=source.filter(meaningful);
    return all.filter(evt=>activeTab==='all'||kindFor(evt)===activeTab).slice(-MAX_ITEMS).reverse();
}

function eventRefs(evt){
    const d=evt.data||{};
    for(const key of ['refs','selected','candidates','entries'])if(Array.isArray(d[key])&&d[key].length)return d[key];
    return [];
}
function humanDetail(evt){
    const d=evt.data||{};
    const refs=eventRefs(evt);
    const blocks=[];
    if(refs.length){
        blocks.push(`<div class="tv2-feed-memory-list">${refs.map(ref=>`<div class="tv2-feed-memory-card">
          <div><b>${esc(ref.title||`UID ${ref.uid??'?'}`)}</b>${ref.nodeLabel&&ref.nodeLabel!==ref.title?`<span>${esc(ref.nodeLabel)}</span>`:''}<small>${esc(ref.book||'')} · UID ${esc(ref.uid??'?')}</small></div>
          ${String(ref.source||'').includes('pin')?'<em>PIN</em>':''}
        </div>`).join('')}</div>`);
    }
    if(d.reasoning||d.regionalReasoning||d.nodeReasoning||d.injectionReasoning){
        const reason=d.reasoning||d.injectionReasoning||d.nodeReasoning||d.regionalReasoning;
        blocks.push(`<div class="tv2-feed-reason"><b>Why</b><span>${esc(reason)}</span></div>`);
    }
    if(evt.category==='character-memory'&&['card-bound','card-active-detected','card-scene-triggered','card-context-warmed'].includes(evt.name)){
        const why = evt.name==='card-context-warmed'
            ? `Character Bank ${d.bankId||''} contributed linked lore because ${String(d.trigger||'character context').replaceAll('-',' ')}.`
            : evt.name==='card-scene-triggered'
                ? `Scene text matched the bound Character Bank${d.role?` (${d.role})`:''}.`
                : evt.name==='card-active-detected'
                    ? `The active SillyTavern avatar matched this Character Bank binding.`
                    : `SillyTavern card identity is bound to Character Bank ${d.bankId||''}.`;
        blocks.push(`<div class="tv2-feed-reason"><b>Trace</b><span>${esc(why)}</span></div>`);
    }
    if(evt.name==='deterministic-pool-ready'){
        blocks.push(`<div class="tv2-feed-statline"><b>${n(d.searchedCount)} searched</b><span>→</span><b>${n(d.candidateCount)} shortlisted</b><span>· ${n(d.prunedCount)} pruned</span></div>`);
    }
    if(!blocks.length)return '';
    return `<div class="tv2-feed-human-detail">${blocks.join('')}</div>`;
}

function currentJobStateMap(){
    try{return new Map(getJobQueue(getSettings().jobs).snapshot().map(job=>[job.id,job.state]));}catch{return new Map();}
}
function jobIdForEvent(evt){const d=evt?.data||{};if(evt?.category==='scheduler'&&d.id)return String(d.id);return d.jobId?String(d.jobId):d.childJobId?String(d.childJobId):null;}
function terminalPhaseMap(snapshot=null){
    const out=new Map();
    const terminal = (evt, state) => ({ ts: Number(evt?.ts || 0), state });
    for(const evt of (snapshot||getTelemetryActivitySnapshot()).events||[]){
        const d=evt?.data||{};
        if(evt.category==='scheduler-cycle'&&['step-complete','step-skipped','step-failed'].includes(evt.name)&&d.cycleId&&d.task){
            const state=evt.name==='step-failed'?'failed':evt.name==='step-skipped'?'skipped':'complete';
            out.set(`cycle:${d.cycleId}:${d.task}`,terminal(evt,state));
        }
        if(evt.category==='scheduler-cycle'&&['cycle-complete','cycle-failed'].includes(evt.name)&&d.cycleId){
            const state=evt.name==='cycle-failed'||d.status==='failed'?'failed':d.status==='partial'?'warn':'complete';
            out.set(`cycle:${d.cycleId}`,terminal(evt,state));
        }
        if(evt.category==='batch-bus'&&['batch-job-complete','batch-job-failed'].includes(evt.name)&&d.parentJobId){
            out.set(`batch:${d.parentJobId}`,terminal(evt,evt.name==='batch-job-failed'?'failed':'complete'));
        }
    }
    return out;
}
function resolvedTerminalState(value, eventTs){return value&&value.ts>eventTs?value.state:null;}
function reconciledState(evt,states,terminals){
    const base=stateForEvent(evt),d=evt?.data||{};
    const id=jobIdForEvent(evt),current=id?states.get(id):null;
    if(base==='running'&&current==='succeeded')return'complete';
    if(base==='running'&&current==='failed')return'failed';
    if(base==='running'&&current==='cancelled')return'cancelled';
    if(base==='running'&&evt.category==='scheduler-cycle'&&d.cycleId&&d.task){
        const terminal=resolvedTerminalState(terminals.get(`cycle:${d.cycleId}:${d.task}`),evt.ts);
        if(terminal)return terminal;
    }
    if(base==='running'&&evt.category==='scheduler-cycle'&&evt.name==='cycle-start'&&d.cycleId){
        const terminal=resolvedTerminalState(terminals.get(`cycle:${d.cycleId}`),evt.ts);
        if(terminal)return terminal;
    }
    if(base==='running'&&evt.category==='batch-bus'&&d.parentJobId){
        const terminal=resolvedTerminalState(terminals.get(`batch:${d.parentJobId}`),evt.ts);
        if(terminal)return terminal;
    }
    return base;
}
function liveStatusHtml(snapshot=null,jobStates=null){const snap=snapshot||getTelemetryActivitySnapshot(),main=snapshotMainBridgeStatus(),jobs=[...(jobStates||currentJobStateMap()).values()];const running=jobs.filter(x=>x==='running').length,queued=jobs.filter(x=>x==='queued').length;const a=snap.sidecars?.A?.active?'working':'idle',b=snap.sidecars?.B?.active?'working':'idle',mainLabel=main.mode==='active'?'active':main.mode==='ready'?'ready':main.mode==='partial'?'partial':main.mode==='disabled'?'disabled':'disconnected',tokens=n(snap.sidecars?.A?.totalTokens)+n(snap.sidecars?.B?.totalTokens);return `<span data-state="${main.mode}"><b>Main</b> ${mainLabel}</span><span class="tv2-runtime-separator">•</span><span><b>A</b> ${a}</span><span class="tv2-runtime-separator">•</span><span><b>B</b> ${b}</span><span><b>Running</b> ${running}</span><span><b>Queued</b> ${queued}</span><span class="tv2-feed-token-use" title="Sidecar token total for this browser session"><b>Tokens</b> ${tokens.toLocaleString()}</span>`;}
function stateForEvent(evt){
    const name=String(evt?.name||'').toLowerCase();
    if(evt?.level==='error'||name.includes('failed')||name.includes('failure'))return'failed';
    if(evt?.level==='warn')return'warn';
    // Proposal enqueue is a terminal staging event, not an executing workload.
    if(evt?.category==='proposals'&&name==='enqueued')return'complete';
    if(name.includes('running')||name.includes('start')||name.includes('queued')||name.includes('requested')||name.includes('enqueued'))return'running';
    if(name.includes('cancelled'))return'cancelled';
    if(name.includes('skipped'))return'skipped';
    if(name.includes('complete')||name.includes('success')||name.includes('created')||name.includes('promoted')||name.includes('staged'))return'complete';
    return'idle';
}

function row(evt,states,terminals){
    const spec=display(evt);
    const details=JSON.stringify(evt.data||{},null,2);
    const human=humanDetail(evt);
    const state=reconciledState(evt,states,terminals);
    return `<details class="tv2-feed-item tv2-feed-${esc(evt.level)}" data-state="${state}">
      <summary>
        <span class="tv2-feed-state-dot" data-state="${state}" title="${state}"></span>
        <span class="tv2-feed-item-icon" style="color:${spec.color}"><i class="fa-solid ${spec.icon}"></i></span>
        <span class="tv2-feed-item-body"><span class="tv2-feed-item-line"><b style="color:${spec.color}">${esc(spec.verb)}</b> <span>${esc(summaryFor(evt))}</span></span></span>
        <span class="tv2-feed-item-time">${esc(time(evt.ts))}</span>
      </summary>
      ${human}
      <details class="tv2-feed-dev"><summary>Developer details</summary><pre>${esc(details)}</pre></details>
    </details>`;
}

function render(snapshot=null){
    if(!bodyEl)return;
    const snap=snapshot||getTelemetryActivitySnapshot();
    const events=filteredEvents(snap);
    const states=currentJobStateMap();
    const terminals=terminalPhaseMap(snap);
    if(liveEl)liveEl.innerHTML=liveStatusHtml(snap,states);
    bodyEl.innerHTML=events.length?events.map(evt=>row(evt,states,terminals)).join(''):`<div class="tv2-feed-empty"><i class="fa-solid fa-satellite-dish"></i><span>No ${activeTab==='all'?'activity':activeTab} yet</span><small>Nexus activity will appear here.</small></div>`;
    tabsEl?.querySelectorAll('.tv2-feed-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===activeTab));
    updateTrigger(snap);
}

function updateTrigger(snapshot=null){
    if(!triggerEl)return;
    const snap=snapshot||getTelemetryActivitySnapshot({metadataOnly:true});
    let visible=0,unseen=0;
    for(const evt of snap.events){
        if(!visibleForTab(evt,'all'))continue;
        visible++;
        if(evt.ts>acknowledgedThrough)unseen++;
    }
    triggerEl.dataset.count=String(Math.min(99,unseen));
    const a=snap.sidecars?.A?.active;const b=snap.sidecars?.B?.active;const scheduler=getSchedulerState();
    const running=!!(a||b||scheduler.active);
    const failed=!running&&(scheduler.last?.status==='failed'||scheduler.last?.status==='partial'||snap.sidecars?.A?.last?.ok===false||snap.sidecars?.B?.last?.ok===false);
    const state=failed?'failed':running?'running':'idle';
    triggerEl.dataset.state=state;
    if(panelEl)panelEl.dataset.state=state;
    triggerEl.title=`Nexus Activity Feed · ${state} · ${unseen} unseen · ${visible} visible event${visible===1?'':'s'}`;
    triggerEl.classList.toggle('tv2-feed-active',running);
    triggerEl.classList.toggle('tv2-feed-failed',failed);
}

function scheduleFeedRender({ acknowledge = false } = {}) {
    if (acknowledge) pendingFeedAcknowledge = true;
    if (feedRenderHandle != null) return;
    const run = () => {
        feedRenderHandle = null;
        feedRenderHandleKind = '';
        const snap = getTelemetryActivitySnapshot();
        if (pendingFeedAcknowledge) {
            acknowledgeVisibleFeed(snap);
            pendingFeedAcknowledge = false;
        }
        render(snap);
    };
    if (typeof requestAnimationFrame === 'function') {
        feedRenderHandleKind = 'raf';
        feedRenderHandle = requestAnimationFrame(run);
    } else {
        feedRenderHandleKind = 'timeout';
        feedRenderHandle = setTimeout(run, 16);
    }
}

function acknowledgeVisibleFeed(snapshot=null){
    const events=(snapshot||getTelemetryActivitySnapshot({metadataOnly:true})).events.filter(evt=>visibleForTab(evt,'all'));
    if(events.length)acknowledgedThrough=Math.max(acknowledgedThrough,...events.map(evt=>Number(evt.ts)||0));
    else acknowledgedThrough=Math.max(acknowledgedThrough,Date.now());
}

function clearVisibleFeed(){
    cutoff=Date.now();
    acknowledgedThrough=Math.max(acknowledgedThrough,cutoff);
    try{localStorage.setItem(CUTOFF_KEY,String(cutoff));}catch{}
}

function persistPanel(){
    if(!panelEl)return;
    try{localStorage.setItem(PANEL_POS_KEY,JSON.stringify({left:panelEl.style.left,top:panelEl.style.top}));localStorage.setItem(PANEL_SIZE_KEY,JSON.stringify({width:panelEl.style.width,height:panelEl.style.height}));}catch{}
}

function placePanel(){
    if(!panelEl||panelEl.dataset.dragPinned==='true')return;
    const tr=triggerEl?.getBoundingClientRect();
    const width=panelEl.getBoundingClientRect().width||340;
    const height=panelEl.getBoundingClientRect().height||420;
    let left=(tr?.left??window.innerWidth-50)-width-10;
    if(left<8)left=(tr?.right??50)+10;
    let top=(tr?.top??window.innerHeight-50)-Math.min(height-50,300);
    left=Math.max(8,Math.min(window.innerWidth-width-8,left));
    top=Math.max(8,Math.min(window.innerHeight-height-8,top));
    panelEl.style.left=`${left}px`;panelEl.style.top=`${top}px`;
}

// A saved dragged position can become invalid after a display/layout change.
// Never leave a successfully opened Feed invisible outside the viewport.
function ensurePanelVisible(){
    if(!panelEl)return;
    const rect=panelEl.getBoundingClientRect();
    const outside=rect.right<16||rect.bottom<16||rect.left>window.innerWidth-16||rect.top>window.innerHeight-16;
    if(outside){delete panelEl.dataset.dragPinned;placePanel();persistPanel();}
}

function createTrigger(){
    triggerEl=el('div','tv2-feed-trigger');
    triggerEl.dataset.count='0';triggerEl.appendChild(icon('fa-satellite-dish'));
    // Nexus floating UI lives outside the SillyTavern Extensions drawer. Keep
    // its pointer/click events from bubbling into host click-away handlers; a
    // drag or Feed click must not dismiss the Extensions drawer.
    const containHostDismiss=e=>e.stopPropagation();
    triggerEl.addEventListener('pointerdown',containHostDismiss);
    triggerEl.addEventListener('mousedown',containHostDismiss);
    triggerEl.addEventListener('click',containHostDismiss);
    try{const saved=JSON.parse(localStorage.getItem(POS_KEY)||'null');if(saved?.left&&saved?.top){triggerEl.style.left=saved.left;triggerEl.style.top=saved.top;triggerEl.style.right='auto';triggerEl.style.bottom='auto';}}catch{}
    let dragging=false,ox=0,oy=0,lastPointerToggleAt=0;
    triggerEl.addEventListener('pointerdown',e=>{dragging=false;const r=triggerEl.getBoundingClientRect();ox=e.clientX-r.left;oy=e.clientY-r.top;triggerEl.setPointerCapture(e.pointerId);});
    triggerEl.addEventListener('pointermove',e=>{if(!triggerEl.hasPointerCapture(e.pointerId))return;const r=triggerEl.getBoundingClientRect();if(!dragging&&(Math.abs(e.clientX-r.left-ox)>4||Math.abs(e.clientY-r.top-oy)>4))dragging=true;if(!dragging)return;const x=Math.max(0,Math.min(window.innerWidth-r.width,e.clientX-ox));const y=Math.max(0,Math.min(window.innerHeight-r.height,e.clientY-oy));triggerEl.style.left=`${x}px`;triggerEl.style.top=`${y}px`;triggerEl.style.right='auto';triggerEl.style.bottom='auto';});
    triggerEl.addEventListener('pointerup',e=>{if(triggerEl.hasPointerCapture(e.pointerId))triggerEl.releasePointerCapture(e.pointerId);if(dragging){try{localStorage.setItem(POS_KEY,JSON.stringify({left:triggerEl.style.left,top:triggerEl.style.top}));}catch{}dragging=false;return;}lastPointerToggleAt=Date.now();togglePanel();});
    // Pointer capture can occasionally lose pointerup while SillyTavern is
    // reflowing a panel. Keep a normal click path as a one-shot fallback, but
    // suppress the synthetic click immediately following a successful pointerup.
    triggerEl.addEventListener('click',()=>{if(Date.now()-lastPointerToggleAt<350)return;togglePanel();});
    document.body.appendChild(triggerEl);
}

function createPanel(){
    panelEl=el('div','tv2-feed-panel');
    try{const pos=JSON.parse(localStorage.getItem(PANEL_POS_KEY)||'null');if(pos?.left&&pos?.top){panelEl.style.left=pos.left;panelEl.style.top=pos.top;panelEl.dataset.dragPinned='true';}const size=JSON.parse(localStorage.getItem(PANEL_SIZE_KEY)||'null');if(size?.width)panelEl.style.width=size.width;if(size?.height)panelEl.style.height=size.height;}catch{}
    const header=el('div','tv2-feed-header');
    const title=el('span','tv2-feed-title');title.append(icon('fa-satellite-dish'),' Nexus Feed');header.appendChild(title);
    const actions=el('span','tv2-feed-actions');
    const nexus=el('button','tv2-feed-btn');nexus.title='Open Nexus controls';nexus.appendChild(icon('fa-sliders'));nexus.addEventListener('click',e=>{e.stopPropagation();openNexusControlPanel();});
    const tree=el('button','tv2-feed-btn');tree.title='Open Tree editor';tree.appendChild(icon('fa-folder-tree'));tree.addEventListener('click',e=>{e.stopPropagation();openTreeWorkspace();});
    const clear=el('button','tv2-feed-btn');clear.title='Clear feed view';clear.appendChild(icon('fa-trash-can'));clear.addEventListener('click',e=>{e.stopPropagation();clearVisibleFeed();render();});
    const close=el('button','tv2-feed-btn');close.title='Close';close.appendChild(icon('fa-xmark'));close.addEventListener('click',e=>{e.stopPropagation();panelEl.classList.remove('open');});
    actions.append(nexus,tree,clear,close);header.appendChild(actions);panelEl.appendChild(header);
    tabsEl=el('div','tv2-feed-tabs');
    for(const [id,label] of [['all','All'],['memory','Memory'],['proposals','Proposals'],['system','System']]){const b=el('button','tv2-feed-tab',label);b.dataset.tab=id;b.addEventListener('click',()=>{activeTab=id;render();});tabsEl.appendChild(b);}panelEl.appendChild(tabsEl);
    liveEl=el('div','tv2-feed-live');liveEl.innerHTML=liveStatusHtml();panelEl.appendChild(liveEl);
    window.addEventListener(getMainBridgeStatusEventName(),()=>{if(liveEl)liveEl.innerHTML=liveStatusHtml();});
    bodyEl=el('div','tv2-feed-body');panelEl.appendChild(bodyEl);
    // The Feed panel is also a body-level floating surface. Consume its
    // pointer/click bubbling for the same reason as the trigger above. Child
    // controls still receive their own events before bubbling stops here.
    const containHostDismiss=e=>e.stopPropagation();
    panelEl.addEventListener('pointerdown',containHostDismiss);
    panelEl.addEventListener('mousedown',containHostDismiss);
    panelEl.addEventListener('click',containHostDismiss);
    document.body.appendChild(panelEl);

    let dragging=false,ox=0,oy=0;
    header.addEventListener('pointerdown',e=>{if(e.target.closest('button'))return;dragging=false;const r=panelEl.getBoundingClientRect();ox=e.clientX-r.left;oy=e.clientY-r.top;header.setPointerCapture(e.pointerId);});
    header.addEventListener('pointermove',e=>{if(!header.hasPointerCapture(e.pointerId))return;const r=panelEl.getBoundingClientRect();if(!dragging&&(Math.abs(e.clientX-r.left-ox)>4||Math.abs(e.clientY-r.top-oy)>4))dragging=true;if(!dragging)return;const x=Math.max(0,Math.min(window.innerWidth-r.width,e.clientX-ox));const y=Math.max(0,Math.min(window.innerHeight-r.height,e.clientY-oy));panelEl.style.left=`${x}px`;panelEl.style.top=`${y}px`;panelEl.dataset.dragPinned='true';});
    header.addEventListener('pointerup',e=>{if(header.hasPointerCapture(e.pointerId))header.releasePointerCapture(e.pointerId);if(dragging){persistPanel();dragging=false;}});
    panelEl.addEventListener('pointerup',persistPanel);
}

function togglePanel(){
    const opening=!panelEl.classList.contains('open');
    panelEl.classList.toggle('open',opening);
    // Closing only hides the panel. Refreshing creates the session cutoff;
    // the explicit Clear button still resets the visible timeline.
    if(opening){acknowledgeVisibleFeed();placePanel();ensurePanelVisible();render();}
}

export function openActivityFeed(){if(!initialized)initActivityFeed();panelEl?.classList.add('open');acknowledgeVisibleFeed();placePanel();ensurePanelVisible();render();}

export function initActivityFeed(){
    if(initialized)return;initialized=true;
    // The Feed is a view of this tab session. Full telemetry remains available
    // in Diagnostics; refreshing the tab starts the visible Feed clean.
    clearVisibleFeed();
    createTrigger();createPanel();render();
    unsubscribe=onTelemetryChange(()=>{if(panelEl?.classList.contains('open'))scheduleFeedRender({acknowledge:true});else updateTrigger();});
    window.addEventListener('resize',()=>{if(panelEl?.classList.contains('open')&&panelEl.dataset.dragPinned!=='true')placePanel();});
}

export function destroyActivityFeed(){
    unsubscribe?.();unsubscribe=null;
    if(feedRenderHandle!=null){
        if(feedRenderHandleKind==='raf'&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(feedRenderHandle);
        else clearTimeout(feedRenderHandle);
    }
    feedRenderHandle=null;feedRenderHandleKind='';pendingFeedAcknowledge=false;
    triggerEl?.remove();panelEl?.remove();triggerEl=panelEl=bodyEl=tabsEl=liveEl=null;initialized=false;
}
