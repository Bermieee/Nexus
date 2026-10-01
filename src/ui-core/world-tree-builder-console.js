import {createButton,element,makeBadge} from './primitives.js';

export function renderWorldTreeBuilderConsole(doc,{state,loreStudy,sourceIds=[],book,scope,refresh}={}){
  if(!state?.open)return null;
  const root=element(doc,'section',{className:'nexus-card',attrs:{'aria-label':'World Tree Builder'}});
  const result=state.result;
  root.append(element(doc,'h2',{text:'World Tree Builder'}),element(doc,'p',{text:'Organize this material in the existing world, then review its branching and placement.'}));
  const work=async action=>{
    if(state.busy)return;state.busy=true;state.error=null;refresh?.();
    try{state.result=await action();}catch(error){state.error=error.message;}finally{state.busy=false;refresh?.();}
  };
  if(!result){
    for(const saved of state.recoverable??[])root.append(createButton(doc,{label:'Recover '+saved.phase+' · '+saved.runId,scope,disabled:state.busy,onPress:()=>work(()=>loreStudy.readWorldTreeBuild(saved.runId))}));
    const mode=element(doc,'select',{attrs:{'aria-label':'Build mode'}});
    for(const [value,label] of [['EXTEND','Extend selected material'],['REORGANIZE','Reorganize selected material']]){const option=element(doc,'option',{text:label,attrs:{value}});option.selected=state.mode===value;mode.append(option);}
    scope?.listen?.(mode,'change',()=>{state.mode=mode.value;});
    root.append(mode,createButton(doc,{label:state.busy?'Analyzing…':'Analyze placement',scope,disabled:state.busy||!sourceIds.length,onPress:()=>work(()=>loreStudy.startWorldTreeBuild({sourceIds,mode:state.mode}))}));
  }else{
    root.append(makeBadge(doc,result.phase,result.phase==='COMMITTED'?'ready':'observed'),element(doc,'p',{text:result.phase==='COMMITTED'?'Published organization and layout.':'Preview — published knowledge remains unchanged until Apply.'}));
    const plan=result.plan;
    if(['COMMITTED','CANCELLED'].includes(result.phase))root.append(createButton(doc,{label:'Start another build',scope,disabled:state.busy,onPress:()=>{state.result=null;refresh?.();}}));
    if(result.phase==='COMMITTING')root.append(createButton(doc,{label:'Recover commit',scope,disabled:state.busy,onPress:()=>work(()=>loreStudy.applyWorldTreeBuild(result.runId))}));
    if(result.phase==='ANALYSIS_PAUSED')root.append(createButton(doc,{label:'Resume analysis',scope,disabled:state.busy,onPress:()=>work(()=>loreStudy.resumeWorldTreeBuild(result.runId))}));
    const revise=changes=>work(()=>loreStudy.reviseWorldTreeBuild(result.runId,{planRevision:result.planRevision,changes}));
    if(plan&&['REVIEW','APPROVED'].includes(result.phase)){
      root.append(createButton(doc,{label:'Refresh analysis',scope,disabled:state.busy,onPress:()=>work(()=>loreStudy.resumeWorldTreeBuild(result.runId))}));
      for(const warning of plan.layout?.proposed?.warnings??[])root.append(element(doc,'p',{attrs:{role:'status'},text:'Layout warning: '+warning.kind+' '+(warning.nodes??[]).join(', ')}));
      const groups=plan.organization.groups;
      for(const group of groups){
        const field=element(doc,'label',{text:'Category '});const input=element(doc,'input',{attrs:{value:group.label,'aria-label':'Category '+group.label}});
        scope?.listen?.(input,'change',()=>revise({organization:{...plan.organization,groups:groups.map(g=>g.id===group.id?{...g,label:input.value}:g)}}));field.append(input);root.append(field);
      }
      for(const row of plan.coverage){
        const label=element(doc,'label',{text:row.sourceId+' · '}),select=element(doc,'select',{attrs:{'aria-label':'Placement '+row.sourceId}});
        const placement=plan.organization.placements.find(p=>p.sourceId===row.sourceId);
        for(const [id,text] of [['UNRESOLVED','Unresolved'],['EXCLUDED','Exclude from this build'],...groups.filter(g=>g.id!=='world:nexus').map(g=>[g.id,g.label])]){const option=element(doc,'option',{text,attrs:{value:id}});option.selected=(placement?.parentId??row.disposition)===id;select.append(option);}
        scope?.listen?.(select,'change',()=>{
          const disposition=['UNRESOLVED','EXCLUDED'].includes(select.value)?select.value:'PLACED';
          const placements=plan.organization.placements.filter(p=>p.sourceId!==row.sourceId);if(disposition==='PLACED')placements.push({sourceId:row.sourceId,parentId:select.value});
          return revise({organization:{...plan.organization,placements},coverage:plan.coverage.map(c=>c.sourceId===row.sourceId?{...c,disposition}:c)});
        });label.append(select);root.append(label);
      }
      const unresolved=(plan.identityMatches??[]).filter(m=>m.status==='UNRESOLVED').length;
      if(unresolved)root.append(element(doc,'p',{text:unresolved+' possible identity matches remain separate. Matching names do not merge identities.'}));
      for(const match of plan.identityMatches??[]){
        root.append(element(doc,'p',{text:match.sourceId+' → '+match.candidateId+' · '+match.status}),createButton(doc,{label:'Keep identities separate: '+match.sourceId,scope,disabled:state.busy,onPress:()=>revise({identityMatches:plan.identityMatches.map(m=>m===match?{...m,status:'DISTINCT'}:m)})}));
      }
      for(const link of plan.organization.navigationLinks??[])root.append(element(doc,'p',{text:'Navigation: '+link.from+' → '+link.to}));
      for(const proposal of plan.relationshipProposals??[]){
        root.append(element(doc,'p',{text:'Relationship: '+proposal.from+' '+proposal.relation+' '+proposal.to+' · evidence: '+(proposal.evidence??[]).join(', ')}),createButton(doc,{label:(proposal.approved?'Exclude':'Approve')+' relationship '+proposal.id,scope,disabled:state.busy,onPress:()=>revise({relationshipProposals:plan.relationshipProposals.map(p=>p.id===proposal.id?{...p,approved:!p.approved}:p)})}));
      }
      root.append(createButton(doc,{label:'Apply reviewed build',scope,disabled:state.busy,onPress:()=>work(async()=>{
        if(result.phase==='REVIEW')state.result=await loreStudy.approveWorldTreeBuild(result.runId,{fingerprint:result.fingerprint,by:'operator'});
        return loreStudy.applyWorldTreeBuild(result.runId);
      })}));
    }
    if(result.phase==='LAYOUT_PENDING')root.append(element(doc,'p',{text:'Organization is saved; layout still needs publication.'}),createButton(doc,{label:'Retry layout',scope,disabled:state.busy,onPress:()=>work(()=>loreStudy.retryWorldTreeBuildLayout(result.runId))}),createButton(doc,{label:'Review refreshed layout',scope,disabled:state.busy,onPress:()=>work(()=>loreStudy.reviewWorldTreeBuildLayout(result.runId))}));
    if(result.phase==='LAYOUT_REVIEW'){
      for(const warning of plan.layout?.proposed?.warnings??[])root.append(element(doc,'p',{text:'Layout warning: '+warning.kind}));
      root.append(createButton(doc,{label:'Apply refreshed layout',scope,disabled:state.busy,onPress:()=>work(async()=>{state.result=await loreStudy.approveWorldTreeBuild(result.runId,{fingerprint:result.fingerprint,by:'operator'});return loreStudy.retryWorldTreeBuildLayout(result.runId);})}));
    }
    if(!['COMMITTED','LAYOUT_PENDING','CANCELLED'].includes(result.phase))root.append(createButton(doc,{label:'Cancel build',scope,disabled:state.busy,onPress:()=>work(()=>loreStudy.cancelWorldTreeBuild(result.runId))}));
  }
  if(state.error||result?.error)root.append(element(doc,'p',{attrs:{role:'alert'},text:state.error??result.error}));
  root.append(createButton(doc,{label:'Close Builder',scope,disabled:state.busy,onPress:()=>{state.open=false;refresh?.();}}));
  return root;
}
