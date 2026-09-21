// Compatibility marker for historical Builder UI automation: you remain authoritative over root categories
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function clean(value){return String(value??'').trim();}
function aliases(value){return [...new Set(String(value??'').split(/[\n,;]+/).map(clean).filter(Boolean))];}
function selected(a,b){return String(a??'')===String(b??'')?' selected':'';}
function disabled(flag){return flag?' disabled':'';}
function slug(value){return clean(value).toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,32)||'run';}

function reviewGuideHtml({step='Review',title='',done='',you='',next=''}={}){
  return `<section class="tv2-b2-review-guide"><div class="tv2-b2-review-step">${esc(step)}</div><div><b>${esc(title)}</b><small><strong>Builder did:</strong> ${esc(done)}</small></div><div><small><strong>Your part:</strong> ${esc(you)}</small><small><strong>Next:</strong> ${esc(next)}</small></div></section>`;
}
function statHtml(value,label){return `<span class="tv2-b2-stat"><b>${esc(value)}</b><small>${esc(label)}</small></span>`;}

export function builder2LaunchControlsHtml({requestedMode='auto',validateOnly=false,compact=false}={}){
  return `<details class="tv2-builder2-advanced${compact?' is-compact':''}"><summary>Advanced Builder controls</summary><div class="tv2-builder2-launch"><label>Builder mode<select class="text_pole tv2-b2-launch-mode"><option value="auto"${selected(requestedMode,'auto')}>Auto</option><option value="full"${selected(requestedMode,'full')}>Full</option><option value="incremental"${selected(requestedMode,'incremental')}>Incremental</option><option value="repair"${selected(requestedMode,'repair')}>Repair</option></select></label><label class="tv2-b2-launch-validate"><input type="checkbox" class="tv2-b2-launch-validate-only"${validateOnly?' checked':''}><span><b>Validate only</b><small>Analyze + preview; never stage or commit.</small></span></label><small class="tv2-b2-launch-note">Semantic packing, batching, token targets, and routing remain automatic unless changed in Nexus expert settings.</small></div></details>`;
}

export function readBuilder2LaunchOptions(root,{requestedMode='auto',validateOnly=false}={}){
  return {requestedMode:clean(root?.querySelector?.('.tv2-b2-launch-mode')?.value||requestedMode||'auto').toLowerCase(),validateOnly:root?.querySelector?.('.tv2-b2-launch-validate-only')?.checked===true||(!root?.querySelector?.('.tv2-b2-launch-validate-only')&&validateOnly===true)};
}

function taxonEditorHtml(node,nodes){
  const protectedNode=node.protection==='locked'||node.protection==='protected';
  const parentOptions=[`<option value=""${!node.parentTaxonId?' selected':''}>Top level</option>`,...nodes.filter(n=>n.taxonId!==node.taxonId).map(n=>`<option value="${esc(n.taxonId)}"${selected(n.taxonId,node.parentTaxonId)}>${esc(n.label)} · ${esc(n.taxonId)}</option>`)].join('');
  const mergeOptions=nodes.filter(n=>n.taxonId!==node.taxonId).map(n=>`<option value="${esc(n.taxonId)}">${esc(n.label)} · ${esc(n.taxonId)}</option>`).join('');
  return `<div class="tv2-b2-tax-editor"><div class="tv2-b2-tax-head"><code>${esc(node.taxonId)}</code><span class="tv2-b2-tax-origin">${esc(node.origin||'builder')}</span><span class="tv2-b2-decision-state">${esc(node.protection||'normal')}</span></div><div class="tv2-b2-tax-fields"><label>Label<input class="text_pole tv2-b2-tax-label" value="${esc(node.label)}" aria-label="Taxon label"${protectedNode?' disabled':''}></label><label>Purpose<input class="text_pole tv2-b2-tax-purpose" value="${esc(node.purpose||'')}" placeholder="Purpose" aria-label="Taxon purpose"></label><label>Aliases<input class="text_pole tv2-b2-tax-aliases" value="${esc((node.aliases||[]).join(', '))}" placeholder="comma separated" aria-label="Taxon aliases"></label><label>Parent<select class="text_pole tv2-b2-tax-parent"${protectedNode?' disabled':''}>${parentOptions}</select></label><label>Can hold entries<select class="text_pole tv2-b2-tax-entry-policy"${protectedNode?' disabled':''}><option value="allow"${selected(node.entryPolicy,'allow')}>Yes — entries may live here</option><option value="container-only"${selected(node.entryPolicy,'container-only')}>No — grouping only</option></select></label><label>Protection<select class="text_pole tv2-b2-tax-protection"${protectedNode?' disabled':''}><option value="normal"${selected(node.protection,'normal')}>Normal</option><option value="protected"${selected(node.protection,'protected')}>Protected</option><option value="locked"${selected(node.protection,'locked')}>Locked</option></select></label></div><div class="tv2-b2-tax-actions"><button type="button" class="menu_button tv2-b2-tax-add-child" data-taxon="${esc(node.taxonId)}" title="Add child / split">Add subcategory</button><select class="text_pole tv2-b2-tax-merge-target" aria-label="Merge target"${protectedNode||!mergeOptions?' disabled':''}>${mergeOptions||'<option value="">No target</option>'}</select><button type="button" class="menu_button tv2-b2-tax-merge" data-taxon="${esc(node.taxonId)}"${disabled(protectedNode||!mergeOptions)}>Merge category</button><button type="button" class="menu_button danger tv2-b2-tax-delete" data-taxon="${esc(node.taxonId)}"${disabled(protectedNode)}>Delete</button></div>${protectedNode?'<small class="tv2-b2-tax-protected-note">Protected/locked categories cannot be renamed, moved, deleted, merged, downgraded, or have their entry policy changed. Purpose, aliases, and child additions remain editable.</small>':''}</div>`;
}
function taxonRowHtml(node,nodes){
  const protectedNode=node.protection==='locked'||node.protection==='protected';
  const parent=nodes.find(n=>n.taxonId===node.parentTaxonId);
  return `<details class="tv2-builder2-tax-row${protectedNode?' is-protected':''}" data-taxon="${esc(node.taxonId)}"><summary><span class="tv2-b2-tax-summary-main"><b>${esc(node.label)}</b><small>${esc(node.purpose||'No purpose supplied')}</small></span><span class="tv2-b2-tax-summary-meta">${parent?`under ${esc(parent.label)}`:'top level'} · ${node.entryPolicy==='container-only'?'grouping only':'holds entries'}${protectedNode?' · protected':''}</span></summary><div class="tv2-b2-tax-editor-host" data-hydrated="false"></div></details>`;
}

export function builder2TaxonomyReviewMarkup(result={}){
  const nodes=structuredClone(result.taxonomy?.nodes||[]),roots=nodes.filter(n=>!n.parentTaxonId).length,protectedCount=nodes.filter(n=>['locked','protected'].includes(n.protection)).length;
  return `<div class="tv2-builder2-review">${reviewGuideHtml({step:'Step 1 of 6',title:'Category Plan',done:'analyzed the lorebook and drafted a reusable category structure.',you:'scan the category names. Open only the categories you want to edit; you do not need to inspect every field.',next:'Builder will place entries automatically and ask only about ambiguous ones.'})}<div class="tv2-b2-review-head"><div><b>Category Plan</b><p>This is the structure Builder intends to use. Nothing is written yet. Category editors stay collapsed until you open them so large plans remain responsive.</p></div><button type="button" class="menu_button tv2-b2-tax-add-root">Add top-level category</button></div><div class="tv2-b2-review-stats">${statHtml(nodes.length,'categories')}${statHtml(roots,'top level')}${statHtml(protectedCount,'protected')}</div><label class="tv2-b2-tax-filter-wrap"><span>Find a category</span><input class="text_pole tv2-b2-tax-filter" type="search" placeholder="Filter by label, purpose, or parent…"></label><div class="tv2-b2-taxonomy-grid">${nodes.map(n=>taxonRowHtml(n,nodes)).join('')}</div></div>`;
}

export function wireBuilder2TaxonomyEditor(container,result={}){
  if(!container)return;
  let draft=structuredClone(result.taxonomy?.nodes||[]);let counter=0;
  const grid=container.querySelector('.tv2-b2-taxonomy-grid');if(!grid)return;
  const sync=()=>{const byId=new Map(draft.map(n=>[String(n.taxonId),n]));for(const row of grid.querySelectorAll('.tv2-builder2-tax-row')){const n=byId.get(String(row.dataset.taxon));if(!n)continue;const label=row.querySelector('.tv2-b2-tax-label');if(!label)continue;n.label=clean(label.value||n.label);n.purpose=clean(row.querySelector('.tv2-b2-tax-purpose')?.value||'');n.aliases=aliases(row.querySelector('.tv2-b2-tax-aliases')?.value||'');n.parentTaxonId=clean(row.querySelector('.tv2-b2-tax-parent')?.value)||null;n.entryPolicy=clean(row.querySelector('.tv2-b2-tax-entry-policy')?.value||n.entryPolicy||'allow');n.protection=clean(row.querySelector('.tv2-b2-tax-protection')?.value||n.protection||'normal');}};
  const hydrateRow=row=>{const host=row?.querySelector('.tv2-b2-tax-editor-host');if(!host||host.dataset.hydrated==='true')return;const n=draft.find(x=>String(x.taxonId)===String(row.dataset.taxon));if(!n)return;host.innerHTML=taxonEditorHtml(n,draft);host.dataset.hydrated='true';bindRow(row);};
  const filterRows=()=>{const q=clean(container.querySelector('.tv2-b2-tax-filter')?.value).toLowerCase();const byId=new Map(draft.map(n=>[n.taxonId,n]));for(const row of grid.querySelectorAll('.tv2-builder2-tax-row')){const n=byId.get(String(row.dataset.taxon));const parent=byId.get(n?.parentTaxonId);const hay=`${n?.label||''} ${n?.purpose||''} ${(n?.aliases||[]).join(' ')} ${parent?.label||''}`.toLowerCase();row.hidden=!!q&&!hay.includes(q);}};
  const rerender=(openId=null)=>{sync();grid.innerHTML=draft.map(n=>taxonRowHtml(n,draft)).join('');bind();filterRows();if(openId){const row=[...grid.querySelectorAll('.tv2-builder2-tax-row')].find(el=>String(el.dataset.taxon)===String(openId));if(row){row.open=true;hydrateRow(row);row.scrollIntoView?.({block:'nearest'});}}};
  const add=(parentTaxonId=null)=>{sync();let id;do{id=`user:${slug(result.runId||result.book)}:${++counter}`;}while(draft.some(n=>n.taxonId===id));draft.push({taxonId:id,parentTaxonId:clean(parentTaxonId)||null,label:'New Category',purpose:'',aliases:[],evidenceSourceKeys:[],origin:'user',protection:'normal',entryPolicy:'allow',canonicalNodeId:null,metadata:{operatorCreated:true}});rerender(id);};
  const remove=(id)=>{sync();const n=draft.find(x=>x.taxonId===id);if(!n||n.protection==='locked'||n.protection==='protected')return;for(const child of draft)if(child.parentTaxonId===id)child.parentTaxonId=n.parentTaxonId||null;draft=draft.filter(x=>x.taxonId!==id);rerender();};
  const merge=(id,target)=>{sync();const source=draft.find(x=>x.taxonId===id),dest=draft.find(x=>x.taxonId===target);if(!source||!dest||source===dest||source.protection==='locked'||source.protection==='protected')return;const ancestors=new Set();let p=dest;while(p?.parentTaxonId){ancestors.add(p.parentTaxonId);p=draft.find(x=>x.taxonId===p.parentTaxonId);}if(ancestors.has(source.taxonId))dest.parentTaxonId=source.parentTaxonId||null;for(const child of draft)if(child.parentTaxonId===source.taxonId&&child.taxonId!==dest.taxonId)child.parentTaxonId=dest.taxonId;dest.aliases=[...new Set([...(dest.aliases||[]),source.label,...(source.aliases||[])].map(clean).filter(Boolean))];dest.evidenceSourceKeys=[...new Set([...(dest.evidenceSourceKeys||[]),...(source.evidenceSourceKeys||[])].map(clean).filter(Boolean))];if(!dest.purpose&&source.purpose)dest.purpose=source.purpose;draft=draft.filter(x=>x.taxonId!==source.taxonId);rerender(dest.taxonId);};
  const bindRow=row=>{row.querySelector('.tv2-b2-tax-add-child')?.addEventListener('click',()=>add(row.dataset.taxon));row.querySelector('.tv2-b2-tax-delete')?.addEventListener('click',()=>remove(String(row.dataset.taxon||'')));row.querySelector('.tv2-b2-tax-merge')?.addEventListener('click',()=>{const target=clean(row.querySelector('.tv2-b2-tax-merge-target')?.value);if(target)merge(String(row.dataset.taxon||''),target);});};
  const bind=()=>{for(const row of grid.querySelectorAll('.tv2-builder2-tax-row'))row.addEventListener('toggle',()=>{if(row.open)hydrateRow(row);});};
  container.querySelector('.tv2-b2-tax-add-root')?.addEventListener('click',()=>add(null));
  container.querySelector('.tv2-b2-tax-filter')?.addEventListener('input',filterRows);
  container.__tv2Builder2TaxonomySync=sync;container.__tv2Builder2TaxonomyDraft=()=>structuredClone(draft);bind();
}

export function collectBuilder2TaxonomyNodes(container,result={}){
  container?.__tv2Builder2TaxonomySync?.();
  if(typeof container?.__tv2Builder2TaxonomyDraft==='function')return container.__tv2Builder2TaxonomyDraft();
  return structuredClone(result.taxonomy?.nodes||[]);
}

export function builder2ClassificationReviewMarkup(result={}){
  const summary=result.summary||{},pending=result.pending||[];
  return `<div class="tv2-builder2-review">${reviewGuideHtml({step:'Step 2 of 6',title:'Placement Review',done:`placed ${Number(summary.autoPlacedCount)||0} clear matches automatically and stopped on ${pending.length} ambiguous entr${pending.length===1?'y':'ies'}.`,you:'choose a category only when you are confident. “Decide later” is safe and now lets this run continue.',next:'Builder checks for missing categories, then validates the final Tree.'})}<div class="tv2-b2-review-head"><div><b>Placement Review</b><p>These are the exceptions, not the whole lorebook. Deferred entries are remembered for a later Builder run. If an entry already has a Tree home, deferring preserves it; otherwise the entry stays unplaced for now.</p></div></div><div class="tv2-b2-review-stats">${statHtml(summary.worksetCount??pending.length,'entries in this run')}${statHtml(summary.autoPlacedCount??0,'placed automatically')}${statHtml(pending.length,'need review')}${summary.priorDeferredCount?statHtml(summary.priorDeferredCount,'deferred before'):''}</div>${pending.map(row=>{const current=row.currentPlacement?.path?.join(' / ')||row.currentPlacement?.label||'';const deferLabel=current?'Decide later — keep current placement':'Decide later — leave unplaced';return `<details class="tv2-builder2-decision tv2-b2-decision-card" data-source-key="${esc(row.sourceKey)}"><summary><span><b>${esc(row.title)}</b><small>${row.uid!=null?`UID ${Number(row.uid)} · `:''}${(row.candidates||[]).length} plausible categor${(row.candidates||[]).length===1?'y':'ies'}${current?` · currently ${esc(current)}`:''}</small></span><span class="tv2-b2-decision-state">Review</span></summary><div class="tv2-b2-decision-body"><p>${esc(row.reason||'Builder found more than one defensible placement.')}</p><label>Decision<select class="text_pole tv2-b2-classification" data-source-key="${esc(row.sourceKey)}"><option value="__defer__" selected>${esc(deferLabel)}</option>${(row.candidates||[]).map(c=>`<option value="${esc(c.taxonId)}">${esc(c.label||c.taxonId)}${c.confidence!=null?` · ${Math.round(Number(c.confidence)*100)}%`:''}</option>`).join('')}<option value="__gap__">None fit — category structure is missing something</option></select></label></div></details>`;}).join('')}</div>`;
}

export function collectBuilder2ClassificationDecisions(container){const decisions={};for(const el of container?.querySelectorAll?.('.tv2-b2-classification')||[]){const value=clean(el.value);decisions[el.dataset.sourceKey]=value==='__defer__'?{action:'defer'}:value==='__gap__'?{action:'gap'}:{action:'map',taxonId:value};}return decisions;}

function gapTargetOptions(taxa=[]){return (taxa||[]).filter(t=>t.entryPolicy!=='container-only').map(t=>`<option value="${esc(t.taxonId)}">${esc(t.label||t.taxonId)}</option>`).join('');}
export function builder2GapReviewMarkup(result={}){
  const proposals=result.proposals||[],summary=result.summary||{},taxa=(result.taxonomy||[]).filter(t=>t.entryPolicy!=='container-only');
  return `<div class="tv2-builder2-review">${reviewGuideHtml({step:'Step 3 of 6',title:'Unplaced Entries',done:'found entries that do not fit the approved category structure cleanly.',you:'create a category, place into an existing one, mark true dividers as structural, or safely defer.',next:'Builder will run structural cleanup and the final quality check.'})}<div class="tv2-b2-review-head"><div><b>Unplaced Entries</b><p>Nothing here is forced. “Decide later” records an intentional deferral and lets Builder continue; the entry returns on a later Builder run.</p></div></div><div class="tv2-b2-review-stats">${statHtml(summary.sourceCount??proposals.reduce((n,p)=>n+(p.evidenceSourceKeys||[]).length,0),'entries affected')}${statHtml(proposals.length,'decisions')}${summary.fallbackCount?statHtml(summary.fallbackCount,'manual-only gaps'):''}</div>${proposals.map(row=>{const fallback=row.fallback===true;return `<article class="tv2-builder2-decision tv2-b2-gap-row" data-proposal-id="${esc(row.proposalId)}"><span><b>${fallback?'Uncovered gap · ':''}${esc(row.label)}</b><small>${esc(row.purpose||'')} · ${(row.evidenceSourceKeys||[]).length} source(s)${fallback?` · Builder could not safely invent a category here`:''}</small></span><div class="tv2-b2-gap-controls"><select class="text_pole tv2-b2-gap-action" data-proposal-id="${esc(row.proposalId)}"><option value="defer" selected>Decide later — continue safely</option>${fallback?'':`<option value="approve">Create this category</option>`}<option value="merge-into">Place in existing category</option><option value="exclude">Mark as divider / structural</option></select><select class="text_pole tv2-b2-gap-target" data-proposal-id="${esc(row.proposalId)}" data-loaded="false" hidden disabled><option value="">Choose existing category…</option></select></div></article>`;}).join('')}</div>`;
}
export function wireBuilder2GapReview(container,result={}){
  if(!container)return;const template=gapTargetOptions((result.taxonomy||[]).filter(t=>t.entryPolicy!=='container-only'));
  const sync=action=>{const id=action.dataset.proposalId,target=container.querySelector(`.tv2-b2-gap-target[data-proposal-id="${CSS.escape(id)}"]`),needs=action.value==='merge-into';if(!target)return;if(needs&&target.dataset.loaded!=='true'){target.insertAdjacentHTML('beforeend',template);target.dataset.loaded='true';}target.hidden=!needs;target.disabled=!needs;};
  for(const action of container.querySelectorAll('.tv2-b2-gap-action')){action.addEventListener('change',()=>sync(action));sync(action);}
}
export function collectBuilder2GapDecisions(container){
  const decisions={};for(const el of container?.querySelectorAll?.('.tv2-b2-gap-action')||[]){const action=clean(el.value||'defer'),id=clean(el.dataset.proposalId);const target=container.querySelector(`.tv2-b2-gap-target[data-proposal-id="${CSS.escape(id)}"]`);decisions[id]=action==='merge-into'?{action,taxonId:clean(target?.value)}:{action};}return decisions;
}

export function builder2PreviewOverrideMarkup(result={}){
  const rows=result.previewPlacements||[],taxa=(result.taxonomy||[]).filter(t=>t.entryPolicy!=='container-only');if(!rows.length||!taxa.length)return'';
  return `<section class="tv2-builder2-preview-overrides"><div class="tv2-b2-review-head"><div><b>Final placement adjustments</b><p>Move an entry before commit or reset a previous manual move. Builder reruns the final checks locally before staging.</p></div></div>${rows.map(row=>`<div class="tv2-builder2-decision tv2-b2-preview-row" data-source-key="${esc(row.sourceKey)}"><span><b>UID ${Number(row.uid)} · ${esc(row.title||row.sourceKey)}</b><small>${row.manualOverride?'Manual override active':'Builder placement'}${row.afterPath?.length?` · ${esc(row.afterPath.join(' / '))}`:''}</small></span><select class="text_pole tv2-b2-preview-target">${taxa.map(t=>`<option value="${esc(t.taxonId)}"${selected(t.taxonId,row.currentTaxonId)}>${esc(t.label||t.taxonId)}</option>`).join('')}</select><button type="button" class="menu_button tv2-b2-preview-apply">Apply placement</button><button type="button" class="menu_button tv2-b2-preview-reset"${disabled(!row.manualOverride)}>Reset</button></div>`).join('')}</section>`;
}

export function wireBuilder2PreviewOverrides(container,{onApply=null,onReset=null,onError=null}={}){
  if(!container)return;const run=async(button,fn)=>{if(typeof fn!=='function')return;const row=button.closest('.tv2-b2-preview-row'),sourceKey=clean(row?.dataset.sourceKey);if(!sourceKey)return;for(const b of container.querySelectorAll('.tv2-b2-preview-apply,.tv2-b2-preview-reset'))b.disabled=true;try{await fn({sourceKey,taxonId:clean(row.querySelector('.tv2-b2-preview-target')?.value)});}catch(error){onError?.(error);for(const b of container.querySelectorAll('.tv2-b2-preview-apply,.tv2-b2-preview-reset'))b.disabled=false;}};container.querySelectorAll('.tv2-b2-preview-apply').forEach(b=>b.addEventListener('click',()=>run(b,onApply)));container.querySelectorAll('.tv2-b2-preview-reset').forEach(b=>b.addEventListener('click',()=>run(b,({sourceKey})=>onReset?.({sourceKey}))));
}

function reconciliationReviewMarkup(result={}){
  return `<div class="tv2-builder2-review"><div class="tv2-b2-review-head"><div><b>Tree Cleanup</b><p>Builder found category structure that may need cleanup. Review only the proposed structural changes below.</p></div></div>${(result.reconciliation?.proposals||[]).map(row=>`<label class="tv2-builder2-decision"><span><b>${esc(row.action||'proposal')} · ${esc(row.issueId)}</b><small>${esc(row.reason||JSON.stringify(row.taxonIds||[]))}</small></span><select class="text_pole tv2-b2-reconcile" data-issue-id="${esc(row.issueId)}" data-action="${esc(row.action)}"><option value="exclude">Mark as divider / structural</option><option value="apply">Apply ${esc(row.action)}</option></select></label>`).join('')}</div>`;
}
function qualityReviewMarkup(result={}){
  const q=result.report||{},taxa=result.taxonomy||[];
  const fallback=(q.blockers||[]).filter(row=>row?.type==='unresolved-classification'&&row?.sourceKey).map(row=>({sourceKey:row.sourceKey,title:row.sourceKey,decision:row.decision||'unresolved',reason:''}));
  const unresolved=(result.unresolved||[]).length?result.unresolved:fallback;
  const rows=unresolved.map(row=>`<div class="tv2-builder2-decision tv2-b2-quality-row"><span><b>${row.uid!=null?`UID ${Number(row.uid)} · `:''}${esc(row.title||row.sourceKey)}</b><small>${esc(row.decision||'unresolved')}${row.reason?` · ${esc(row.reason)}`:''}</small></span><select class="text_pole tv2-b2-quality-resolution" data-source-key="${esc(row.sourceKey)}"><option value="__defer__" selected>Choose resolution…</option>${taxa.map(t=>`<option value="${esc(t.taxonId)}">Place in ${esc(t.label||t.taxonId)}</option>`).join('')}<option value="__exclude__">Structural / non-semantic — keep out of Tree</option></select></div>`).join('');
  return `<div class="tv2-builder2-review"><div class="tv2-b2-review-head"><div><b>Final Check · ${q.passed?'READY':'NEEDS ATTENTION'}</b><p>${q.passed?'Every entry has a valid final disposition.':'Resolve the remaining entries here before Builder can make the final Tree.'}</p></div></div>${rows||((q.blockers||[]).length?`<p>${(q.blockers||[]).map(x=>esc(x.blockerId||x.type||JSON.stringify(x))).join('<br>')}</p>`:'<p>No hard blockers. Heuristic signals do not block materialization.</p>')}${(q.signals||[]).length?`<small>${(q.signals||[]).map(x=>esc(x.signalId||x.type)).join(' · ')}</small>`:''}</div>`;
}

/** Shared Builder2 review renderer used by both the standalone Builder and Tree workspace. */
export function builder2ReviewMarkup(result={}, {previewHtml=''}={}){
  const kind=String(result.reviewKind||'');
  if(kind==='taxonomy-review')return builder2TaxonomyReviewMarkup(result);
  if(kind==='classification-review')return builder2ClassificationReviewMarkup(result);
  if(kind==='gap-review')return builder2GapReviewMarkup(result);
  if(kind==='reconciliation-review')return reconciliationReviewMarkup(result);
  if(kind==='quality-review')return qualityReviewMarkup(result);
  if(kind==='preview')return `${previewHtml||''}${builder2PreviewOverrideMarkup(result)}`;
  return '<div class="tv2-empty">Builder 2 returned an unknown review stage.</div>';
}

/** Shared Builder2 review-state collector used by every legitimate launch context. */
export function collectBuilder2ReviewDecision(container,result={}){
  const kind=String(result.reviewKind||'');
  if(kind==='taxonomy-review')return{approved:true,nodes:collectBuilder2TaxonomyNodes(container,result)};
  if(kind==='classification-review')return{decisions:collectBuilder2ClassificationDecisions(container)};
  if(kind==='gap-review')return{decisions:collectBuilder2GapDecisions(container)};
  if(kind==='reconciliation-review'){
    const decisions={};for(const el of container?.querySelectorAll?.('.tv2-b2-reconcile')||[])decisions[el.dataset.issueId]=el.value==='apply'?{action:el.dataset.action}:{action:'reject'};return{decisions};
  }
  if(kind==='quality-review'){
    const decisions={};for(const el of container?.querySelectorAll?.('.tv2-b2-quality-resolution')||[]){const value=String(el.value||'__defer__'),sourceKey=String(el.dataset.sourceKey||'');decisions[sourceKey]=value==='__defer__'?{action:'defer'}:value==='__exclude__'?{action:'exclude'}:{action:'map',taxonId:value};}return{approved:true,decisions};
  }
  return{};
}
