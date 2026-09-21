const ORDER = Object.freeze(['minimal','low','medium','high']);
const COMPLEX_WORKLOADS = new Set([
  'summaries','summary','summary-promotion','treebuild','tree-build','tree','merge',
  'uid-summarizer','uid-summary','postturn','post-turn','post-turn-extract','notebook','notebook-refresh',
  'lorebook','lore-routing','maintenance'
]);
const LIGHT_WORKLOADS = new Set(['connectivity-test','diagnostics','smart-warm','smart-context-warm']);

function clean(value){return String(value??'').trim().toLowerCase();}
function rank(level){return Math.max(0,ORDER.indexOf(level));}
function atLeast(level,floor){return ORDER[Math.max(rank(level),rank(floor))]||'medium';}
function isStructured({responseFormat=null,structuredValidator=null,prompt='',systemPrompt=''}){
  if(responseFormat==='json_object'||typeof structuredValidator==='function')return true;
  return /\b(?:return|respond|reply|output|emit)\b[\s\S]{0,48}\bjson\b|\bjson[- ]only\b/i.test(`${systemPrompt}\n${prompt}`);
}

/**
 * Auto Sense is the `Auto` reasoning-token setting. It never selects MAX.
 * Explicit user choices are returned unchanged. Auto begins at the cheapest
 * adequate level and escalates only for request shape/size or a bounded retry.
 */
export function resolveAutoReasoningEffort({
  requested='auto', role='', bus='', domain='', phase='', attempt=1,
  inputTokens=0, plannedOutputTokens=0, responseFormat=null,
  structuredValidator=null, prompt='', systemPrompt='', providerCapability=null,
}={}){
  const raw=clean(requested)||'auto';
  if(raw!=='auto'&&raw!=='default'){
    // Provider capability is a physical request boundary. Once Nexus has
    // learned that reasoning is mandatory, an explicit `none` cannot be sent
    // successfully; use the cheapest supported level instead of intentionally
    // provoking another 400 and relying on transport adaptation.
    if(raw==='none'&&providerCapability?.reasoningMandatory===true){
      return Object.freeze({requested:raw,effective:'minimal',auto:false,reason:'explicit-user-selection+provider-requires-reasoning',escalated:true});
    }
    return Object.freeze({requested:raw,effective:raw,auto:false,reason:'explicit-user-selection',escalated:false});
  }

  const workload=clean(domain||bus||role);
  const structured=isStructured({responseFormat,structuredValidator,prompt,systemPrompt});
  const input=Math.max(0,Number(inputTokens)||0), output=Math.max(0,Number(plannedOutputTokens)||0);
  let effective='low';
  const reasons=[];

  if(LIGHT_WORKLOADS.has(workload)){effective='minimal';reasons.push('light-workload');}
  if(COMPLEX_WORKLOADS.has(workload)){effective=atLeast(effective,'medium');reasons.push('complex-workload');}
  if(structured){effective=atLeast(effective,input>=8000?'medium':'low');reasons.push('structured-output');}
  if(input>=12000||output>=4096){effective=atLeast(effective,'medium');reasons.push('request-size');}
  if(input>=26000||output>=8192){effective=atLeast(effective,'high');reasons.push('large-request');}
  if(clean(phase).includes('synthesis')||clean(phase).includes('consensus')){effective=atLeast(effective,'medium');reasons.push('synthesis-phase');}

  const retry=Math.max(1,Number(attempt)||1);
  const retryPhase=/\b(?:fallback|recovery|retry)\b/.test(clean(phase));
  if(retry>1||retryPhase){
    const before=effective;
    effective=ORDER[Math.min(rank(effective)+1,ORDER.length-1)];
    if(effective!==before)reasons.push(retryPhase?'bounded-recovery-escalation':'bounded-retry-escalation');
  }
  if(providerCapability?.reasoningMandatory===true){effective=atLeast(effective,'minimal');reasons.push('provider-requires-reasoning');}

  return Object.freeze({requested:'auto',effective,auto:true,reason:reasons.join('+')||'default-low',escalated:reasons.includes('bounded-retry-escalation')||reasons.includes('bounded-recovery-escalation')});
}

export function reasoningAutoLevels(){return [...ORDER];}
