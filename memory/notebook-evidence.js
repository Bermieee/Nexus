// An update is accepted only when it cites a message that was in the scene it was asked about.
export const NOTEBOOK_REJECTION=Object.freeze({
  NO_EVIDENCE:'NO_VALID_EVIDENCE',
  UNSUPPORTED:'UNSUPPORTED_ADDITION',
  OVER_BUDGET:'OVER_BUDGET',
});

export const NOTEBOOK_REJECTION_TEXT=Object.freeze({
  [NOTEBOOK_REJECTION.NO_EVIDENCE]:'The update cited no recent message ([M#]), so the existing Notebook was kept.',
  [NOTEBOOK_REJECTION.UNSUPPORTED]:'The update marked an unsupported addition, so the existing Notebook was kept.',
  [NOTEBOOK_REJECTION.OVER_BUDGET]:'The update was larger than the Notebook budget allows, so the existing Notebook was kept.',
});

export function validateNotebookEvidence(payload,scene){
  if(!payload?.changed)return{valid:true};
  const available=new Set((String(scene??'').match(/\[M\d+\b/g)||[]).map(token=>token.slice(1)));
  const cited=(payload.evidence||[]).map(value=>String(value).match(/M\d+/i)?.[0]?.toUpperCase()).filter(Boolean);
  if(!cited.some(id=>available.has(id)))return{valid:false,code:NOTEBOOK_REJECTION.NO_EVIDENCE,reason:NOTEBOOK_REJECTION_TEXT[NOTEBOOK_REJECTION.NO_EVIDENCE]};
  const admitted=`${payload.reason||''}\n${payload.notebook||''}`.toLowerCase();
  if(/non[- ]canonical addition|unsupported (?:addition|fact)|invented canon/.test(admitted))return{valid:false,code:NOTEBOOK_REJECTION.UNSUPPORTED,reason:NOTEBOOK_REJECTION_TEXT[NOTEBOOK_REJECTION.UNSUPPORTED]};
  return{valid:true};
}

export class NotebookRejectedError extends Error{
  constructor(code,reason){super(reason);this.name='NexusNotebookRejected';this.code=code;}
}
