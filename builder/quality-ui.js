// Render source/model-provided labels as text, never markup.
export function renderBuilderQualityReport(container,preview,{active=true,edited=false}={}){
    const issues=(preview?.conflicts||[]).filter(row=>String(row.type||'').startsWith('builder-quality-'));
    container.hidden=!active||!issues.length;
    const signature=JSON.stringify([active,edited,issues]);if(container.dataset.signature===signature)return;
    container.dataset.signature=signature;container.replaceChildren();
    if(container.hidden)return;
    const details=document.createElement('details');details.open=true;
    const summary=document.createElement('summary');summary.textContent=`Organization review: ${issues.length} finding(s)`;details.append(summary);
    const note=document.createElement('p');note.textContent=edited?'These findings refer to the staged draft. They will be recalculated when your edits are staged.':'Entry coverage passed. Review these organizational findings before approving; a finding can be intentional.';details.append(note);
    const list=document.createElement('ul');
    for(const issue of issues){const item=document.createElement('li');item.textContent=String(issue.reason||'Review this placement.');list.append(item);}
    details.append(list);container.append(details);
}
