import {createButton,element} from './primitives.js';

export function renderWorldTreePlacementReview(doc,{state,loreStudy,scope,refresh,notifications}={}){
  const result=state?.result,review=result?.semanticReview;
  if(result?.phase!=='PLACEMENT_REVIEW'||!review)return null;
  if(state.placementChoices?.token!==review.token)state.placementChoices={token:review.token,classificationDecisions:{},gapDecisions:{}};
  const choices=state.placementChoices,categories=review.taxonomy.filter(t=>t.entryPolicy!=='container-only');
  const overlay=element(doc,'div',{className:'nexus-world-placement-overlay nexus-wave12-host-root'});
  Object.assign(overlay.style,{position:'fixed',inset:'0',zIndex:'20000',display:'grid',placeItems:'center',background:'rgba(0,0,0,.5)'});
  const panel=element(doc,'section',{className:'nexus-card',attrs:{role:'dialog','aria-modal':'true','aria-label':'Builder placement review'}});
  Object.assign(panel.style,{width:'min(780px,90vw)',maxHeight:'80vh',overflowY:'auto',padding:'20px',background:'var(--nexus-bg,#071722)'});
  panel.append(element(doc,'h2',{text:'Review Builder placements'}),element(doc,'p',{text:review.classifications.length+' uncertain placement(s) · '+review.proposals.length+' proposed categories. Choose where these belong, or explicitly leave them for later. Your tree is unchanged.'}));
  const select=(label,rows,value,onChange)=>{
    const row=element(doc,'label',{text:label+' '});row.style.display='block';row.style.marginBottom='12px';
    const input=element(doc,'select',{className:'nexus-input',attrs:{'aria-label':label}});
    for(const [id,text] of [['','Choose…'],...rows])input.append(element(doc,'option',{text,attrs:{value:id}}));input.value=value??'';
    const changed=()=>{onChange(input.value);refresh?.();};if(scope?.listen)scope.listen(input,'change',changed);else input.addEventListener('change',changed);
    row.append(input);panel.append(row);
  };
  for(const row of review.classifications){
    panel.append(element(doc,'strong',{text:row.title??row.sourceKey}),element(doc,'p',{text:row.reason??'Placement needs your decision.'}));
    const decision=choices.classificationDecisions[row.sourceKey];
    select('Placement '+row.sourceKey,[...categories.map(t=>['map:'+t.taxonId,t.label]),['defer','Leave unresolved for now'],['exclude','Exclude from this build']],decision?.action==='map'?'map:'+decision.taxonId:decision?.action,value=>{if(!value)delete choices.classificationDecisions[row.sourceKey];else choices.classificationDecisions[row.sourceKey]=value.startsWith('map:')?{action:'map',taxonId:value.slice(4)}:{action:value};});
  }
  for(const proposal of review.proposals){
    panel.append(element(doc,'strong',{text:proposal.label}),element(doc,'p',{text:(proposal.purpose??'')+' · Sources: '+proposal.evidenceSourceKeys.join(', ')}));
    const decision=choices.gapDecisions[proposal.proposalId];
    select('Category proposal '+proposal.proposalId,[...(proposal.fallback?[]:[['approve','Add proposed category']]),...categories.map(t=>['merge:'+t.taxonId,'Place in '+t.label]),['defer','Leave unresolved for now'],['exclude','Exclude these sources from this build']],decision?.action==='merge-into'?'merge:'+decision.taxonId:decision?.action,value=>{if(!value)delete choices.gapDecisions[proposal.proposalId];else choices.gapDecisions[proposal.proposalId]=value.startsWith('merge:')?{action:'merge-into',taxonId:value.slice(6)}:{action:value};});
  }
  if(state.error)panel.append(element(doc,'p',{attrs:{role:'alert'},text:state.error}));
  const complete=review.classifications.every(row=>choices.classificationDecisions[row.sourceKey])&&review.proposals.every(p=>choices.gapDecisions[p.proposalId]);
  panel.append(createButton(doc,{label:state.busy?'Validating…':'Continue to preview',scope,disabled:state.busy||!complete,onPress:async()=>{
    state.busy=true;state.error=null;refresh?.();
    try{state.result=await loreStudy.resumeWorldTreeBuild(result.runId,{review:structuredClone(choices)});notifications?.push?.({message:state.result.phase==='REVIEW'?'Builder placements validated. Review and approve the preview.':'Builder needs further review.',status:state.result.phase==='REVIEW'?'ready':'info'});}
    catch(error){state.error=error.message;}
    finally{state.busy=false;refresh?.();}
  }}),createButton(doc,{label:'Refresh analysis',scope,disabled:state.busy,onPress:async()=>{
    state.busy=true;state.error=null;refresh?.();
    try{state.result=await loreStudy.resumeWorldTreeBuild(result.runId);}
    catch(error){state.error=error.message;}
    finally{state.busy=false;refresh?.();}
  }}),createButton(doc,{label:'Cancel build',scope,disabled:state.busy,onPress:async()=>{
    try{await loreStudy.cancelWorldTreeBuild(result.runId);state.result=null;state.open=false;state.placementChoices=null;refresh?.();}catch(error){state.error=error.message;refresh?.();}
  }}));
  overlay.append(panel);return overlay;
}
