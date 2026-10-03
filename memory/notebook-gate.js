// Whether an automatic refresh is worth running. Three steps, cheapest first:
//   1. rule: nothing new since the last refresh, or only trivial new text, is not a material change;
//   2. Decision Core (registered site notebook.material-change.v1), advisory;
//   3. if Decision Core cannot answer, the rule's answer stands and the refresh runs.
// A manual Refresh never asks.
export const NOTEBOOK_GATE_REASON=Object.freeze({
  MANUAL:'manual-refresh',
  FIRST_EVIDENCE:'first-evidence',
  NEW_MESSAGES:'new-messages',
  NO_NEW_MESSAGES:'no-new-messages-since-last-refresh',
  TRIVIAL_TEXT:'only-trivial-new-text',
  DECISION_NO_CHANGE:'decision-core-no-material-change',
});

export const NOTEBOOK_TRIVIAL_NEW_TEXT_CHARS=80;

export function evidenceThrough(evidence){
  return(evidence||[]).reduce((max,row)=>{const id=Number(String(row?.evidenceId??row?.id??'').replace(/^M/i,''));return Number.isFinite(id)&&id>max?id:max;},-1);
}

export function ruleNotebookMaterialChange({evidence=[],lastRefresh=null,fingerprint='',minChars=NOTEBOOK_TRIVIAL_NEW_TEXT_CHARS}={}){
  const through=Number.isFinite(Number(lastRefresh?.evidenceThrough))?Number(lastRefresh.evidenceThrough):-1;
  const hadRefresh=lastRefresh?.outcome!=null;
  if(hadRefresh&&through>=0&&fingerprint&&lastRefresh.fingerprint===fingerprint)return{material:false,reason:NOTEBOOK_GATE_REASON.NO_NEW_MESSAGES};
  const fresh=(evidence||[]).filter(row=>{const id=Number(String(row?.evidenceId??row?.id??'').replace(/^M/i,''));return!Number.isFinite(id)||id>through;});
  if(hadRefresh&&through>=0&&!fresh.length)return{material:false,reason:NOTEBOOK_GATE_REASON.NO_NEW_MESSAGES};
  const chars=fresh.reduce((sum,row)=>sum+String(row?.text??'').trim().length,0);
  if(hadRefresh&&through>=0&&chars<minChars)return{material:false,reason:NOTEBOOK_GATE_REASON.TRIVIAL_TEXT};
  return{material:true,reason:hadRefresh?NOTEBOOK_GATE_REASON.NEW_MESSAGES:NOTEBOOK_GATE_REASON.FIRST_EVIDENCE};
}

export async function decideNotebookRefresh({manual=false,evidence=[],lastRefresh=null,fingerprint='',assist=null}={}){
  if(manual)return{run:true,source:'manual',reason:NOTEBOOK_GATE_REASON.MANUAL};
  const rule=ruleNotebookMaterialChange({evidence,lastRefresh,fingerprint});
  if(!rule.material)return{run:false,source:'rule',reason:rule.reason};
  let verdict=null,error=null;
  try{verdict=typeof assist==='function'?await assist():null;}catch(caught){error=caught;}
  if(verdict?.handled&&verdict.material===false)return{run:false,source:'decision-core',reason:NOTEBOOK_GATE_REASON.DECISION_NO_CHANGE,verdict};
  if(verdict?.handled)return{run:true,source:'decision-core',reason:rule.reason,verdict};
  return{run:true,source:'rule-fallback',reason:rule.reason,degraded:error!=null,error:error?.message??null};
}

const GATE_TEXT=Object.freeze({
  [NOTEBOOK_GATE_REASON.NO_NEW_MESSAGES]:'Nothing new in the chat since the last refresh.',
  [NOTEBOOK_GATE_REASON.TRIVIAL_TEXT]:'Only a few words of new text since the last refresh.',
  [NOTEBOOK_GATE_REASON.DECISION_NO_CHANGE]:'The new messages do not change the working state.',
});
export function describeGateReason(reason){return GATE_TEXT[reason]??String(reason??'');}
