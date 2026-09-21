import { logEvent } from '../observability/telemetry.js';

const runs = new Map();
const numericFields = [
  'semanticModelCalls','taxonomyApprovalCycles','taxonomyRevisionCycles','gapCycles','reclassificationPasses',
  'unresolvedClassifications','reviewFrequency','operatorParentCorrections','operatorCategoryCorrections',
  'wrongBranchCorrections','repeatedIdenticalSemanticRounds','semanticInputTokens','semanticOutputTokens',
  'estimatedCost','shadowDecisions','shadowTypedDecisions','shadowAgreements','shadowDisagreements',
  'staleResultRejections','insufficientEvidenceDeferrals','reviewAnswers','falseConfidentClassifications',
  'criticalMisplacements',
];

function blank(runId=''){
  return {
    runId:String(runId||''),startedAt:Date.now(),updatedAt:Date.now(),finishedAt:null,wallClockMs:0,
    ...Object.fromEntries(numericFields.map(key=>[key,0])),
    authoritativeStages:{},sites:{},events:[],
  };
}
function row(runId){const id=String(runId||'');if(!runs.has(id))runs.set(id,blank(id));return runs.get(id);}
function finite(value){const n=Number(value);return Number.isFinite(n)?n:0;}
function boundedPush(target,value,max=120){target.push(value);if(target.length>max)target.splice(0,target.length-max);}
function publicCopy(value){return JSON.parse(JSON.stringify(value));}

export function beginBuilder2DecisionBenchmark(runId, metadata={}){
  const current=row(runId);current.startedAt=current.startedAt||Date.now();current.updatedAt=Date.now();current.metadata={...(current.metadata||{}),...metadata};return publicCopy(current);
}

export function recordBuilder2BenchmarkEvent(runId,type,details={}){
  const current=row(runId);current.updatedAt=Date.now();
  boundedPush(current.events,{at:current.updatedAt,type:String(type||'event'),...details});
  logEvent('builder2','decision-benchmark',{runId:String(runId||''),type:String(type||'event'),...details},'debug');
  return publicCopy(current);
}

export function recordBuilder2AuthoritativeSemanticWork(runId,{stage='unknown',calls=1,inputTokens=0,outputTokens=0,cost=0,recovered=0}={}){
  const current=row(runId);const count=Math.max(0,finite(calls));current.semanticModelCalls+=count;current.semanticInputTokens+=Math.max(0,finite(inputTokens));current.semanticOutputTokens+=Math.max(0,finite(outputTokens));current.estimatedCost+=Math.max(0,finite(cost));
  const key=String(stage||'unknown');current.authoritativeStages[key]=(current.authoritativeStages[key]||0)+count;current.updatedAt=Date.now();
  boundedPush(current.events,{at:current.updatedAt,type:'authoritative-semantic-work',stage:key,calls:count,recovered:Math.max(0,finite(recovered)),inputTokens:Math.max(0,finite(inputTokens)),outputTokens:Math.max(0,finite(outputTokens)),cost:Math.max(0,finite(cost))});
  return publicCopy(current);
}

export function recordBuilder2Cycle(runId,kind,amount=1,details={}){
  const current=row(runId);const map={taxonomyApproval:'taxonomyApprovalCycles',taxonomyRevision:'taxonomyRevisionCycles',gap:'gapCycles',reclassification:'reclassificationPasses',review:'reviewFrequency',operatorParentCorrection:'operatorParentCorrections',operatorCategoryCorrection:'operatorCategoryCorrections',wrongBranchCorrection:'wrongBranchCorrections',nonProgress:'repeatedIdenticalSemanticRounds',unresolved:'unresolvedClassifications'};const field=map[kind];if(field)current[field]+=Math.max(0,finite(amount));current.updatedAt=Date.now();boundedPush(current.events,{at:current.updatedAt,type:`cycle:${kind}`,amount:Math.max(0,finite(amount)),...details});return publicCopy(current);
}

export function recordBuilder2DecisionShadow(runId,siteId,result,{authoritativeChoice=null,operatorChoice=null,insufficientEvidence=false}={}){
  const current=row(runId);const site=String(siteId||'unknown');current.shadowDecisions+=1;current.sites[site]??={count:0,typed:0,agreement:0,disagreement:0,review:0,stale:0,insufficientEvidence:0,inputTokens:0,outputTokens:0,cost:0};const stats=current.sites[site];stats.count+=1;
  if(insufficientEvidence){current.insufficientEvidenceDeferrals+=1;stats.insufficientEvidence+=1;}
  if(result?.stale){current.staleResultRejections+=1;stats.stale+=1;}
  if(result?.providerClass==='typed-decision'){current.shadowTypedDecisions+=1;stats.typed+=1;}
  const answerChoice=Object.values(result?.answers||{}).find(answer=>answer?.type==='choice')?.choice??null;
  if(answerChoice==='REVIEW'){current.reviewAnswers+=1;stats.review+=1;}
  const reference=operatorChoice??authoritativeChoice;
  if(reference!=null&&answerChoice!=null){if(String(reference)===String(answerChoice)){current.shadowAgreements+=1;stats.agreement+=1;}else{current.shadowDisagreements+=1;stats.disagreement+=1;}}
  const usage=result?.usage||{};const input=Math.max(0,finite(usage.inputTokens)),output=Math.max(0,finite(usage.outputTokens)),cost=Math.max(0,finite(usage.cost));stats.inputTokens+=input;stats.outputTokens+=output;stats.cost+=cost;
  current.updatedAt=Date.now();boundedPush(current.events,{at:current.updatedAt,type:'shadow-decision',site,ok:result?.ok===true,stale:result?.stale===true,providerClass:result?.providerClass||null,answerChoice,authoritativeChoice,operatorChoice,inputTokens:input,outputTokens:output,cost,insufficientEvidence});
  return publicCopy(current);
}

export function finishBuilder2DecisionBenchmark(runId,details={}){const current=row(runId);current.finishedAt=Date.now();current.updatedAt=current.finishedAt;current.wallClockMs=Math.max(0,current.finishedAt-current.startedAt);current.final={...(current.final||{}),...details};logEvent('builder2','decision-benchmark-final',publicCopy(current),'info');return publicCopy(current);}
export function getBuilder2DecisionBenchmark(runId){return publicCopy(row(runId));}
export function listBuilder2DecisionBenchmarks(){return [...runs.values()].map(publicCopy);}
export function clearBuilder2DecisionBenchmarks(){runs.clear();}
