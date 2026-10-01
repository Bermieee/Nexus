import { createButton, createKeyValue, element, makeBadge } from './primitives.js';
import { resolveMotionPolicy } from './wave6-presentation.js';
import { createNexusSvgElement, createNexusSvgAnimation, startNexusSvgAnimations, getNexusRenderingPolicy } from '../../core/rendering-policy.js';
import {planWorldTreeLayout} from '../../world-tree/layout.js';
import { NEXUS_BRAND_ICON_DATA_URI } from './nexus-brand.js';

const STATE_ORDER=['READY','STUDYING','ACCEPTED','FAILED','REMOVED'];
const REVEAL_RENDER_PASSES=4;
const WORLD_VIEW_ASPECT=1.04;
const DEFAULT_WORLD_VIEW={x:90,y:-14,width:820,height:788};
const STATE_META={
  READY:{label:'Ready',tone:'ready',color:'#3ce4b1',symbol:'✓'},
  STUDYING:{label:'Studying',tone:'observed',color:'#42c7ff',symbol:'◌'},
  ACCEPTED:{label:'Due',tone:'warning',color:'#f1bb55',symbol:'•'},
  FAILED:{label:'Failed',tone:'warning',color:'#ff677e',symbol:'!'},
  REMOVED:{label:'Removed',tone:'historical',color:'#72899b',symbol:'×'},
};

export function createLoreNeuralRenderState(){
  return{lorebookKey:null,seenHubs:new Set(),seenNodes:new Set(),seenArtifacts:new Set(),seenEdges:new Set(),replayCount:0,animationInitialized:false,revealPassesRemaining:0,selectedNodeId:null,selectedNodeKind:null,hoverNodeId:null,focusHubId:null,viewport:null,panGesture:null,nodeDrag:null,nodePositions:{},leftDrawerOpen:true,leftDrawerView:'world',rightDrawerOpen:true,rightDrawerView:'inspector',workspaceMode:'EXPLORE',trashTreeArmed:false};
}
export function replayLoreNeuralGrowth(state){
  if(!state)return false;
  state.seenHubs?.clear?.();state.seenNodes?.clear?.();state.seenArtifacts?.clear?.();state.seenEdges?.clear?.();
  state.replayCount=Number(state.replayCount??0)+1;
  state.revealPassesRemaining=REVEAL_RENDER_PASSES;
  return true;
}

export function renderLoreNeuralWorkspace(doc,{
  data=null,source=null,selected=null,progress=0,scope=null,inspect=null,renderState=null,refresh=null,motionMode='FULL',tools=null,
}={}){
  const entries=Array.isArray(data?.entries)?data.entries:[],counts=data?.operatorCounts??{},snapshot=selected?.snapshot??null;
  const graphActive=entries.some(row=>['STUDYING','READY','FAILED'].includes(String(row?.operatorState??'').toUpperCase()));
  const root=element(doc,'section',{className:'nexus-lore-neural-workspace',attrs:{'aria-label':'Nexus World Tree'}});
  const left=renderStudyRail(doc,{data,source,counts,progress,selected,renderState,scope,refresh});
  const center=renderGraphPanel(doc,{data,selected,progress,scope,inspect,renderState,refresh,motionMode,tools});
  const right=renderLoreInsightRail(doc,{data,selected,progress,renderState,tools,scope,refresh});
  root.append(center,left,right);
  root.dataset.graphState=graphActive?'populated':entries.length?'armed':snapshot?'loaded':'blank';
  root.dataset.workspaceMode=String(renderState?.workspaceMode??'EXPLORE');
  return root;
}

function renderStudyRail(doc,{data,source,counts,progress,selected,renderState,scope,refresh}={}){
  const rail=element(doc,'aside',{className:'nexus-lore-neural-rail nexus-lore-neural-rail--left nexus-world-drawer',dataset:{open:String(renderState?.leftDrawerOpen!==false),view:String(renderState?.leftDrawerView??'world')}});
  const entries=Array.isArray(data?.entries)?data.entries:[],categoryCounts=semanticCategoryCounts(selected?.snapshot,entries);
  const graph=entries.length?buildLoreGraph({entries,data,selected}):{edges:[],hubs:[],nodes:[],artifacts:[]};
  applyPersistedNodePositions(graph,renderState);

  const tabs=element(doc,'div',{className:'nexus-world-drawer__tabs',attrs:{'aria-label':'World Tree information'}});
  for(const [id,label] of [['world','World'],['categories','Categories'],['source','Source']]){
    const button=element(doc,'button',{className:'nexus-world-drawer__tab',text:label,attrs:{type:'button','aria-pressed':String(renderState?.leftDrawerOpen!==false&&renderState?.leftDrawerView===id)},dataset:{view:id,active:String(renderState?.leftDrawerView===id)}});
    scope?.listen?.(button,'click',()=>toggleDrawer(renderState,'left',id,refresh));
    tabs.append(button);
  }
  const surface=element(doc,'div',{className:'nexus-world-drawer__surface'});
  const view=String(renderState?.leftDrawerView??'world');

  if(view==='world'){
    const overview=panel(doc,'World Overview','Canonical published structure','◉');
    overview.root.classList?.add?.('nexus-world-overview');
    const stats=element(doc,'div',{className:'nexus-world-overview__stats'});
    const stat=(icon,value,label)=>{const row=element(doc,'div',{className:'nexus-world-stat'});row.append(element(doc,'span',{className:'nexus-world-stat__icon',text:icon}),element(doc,'strong',{text:String(value)}),element(doc,'span',{text:label}));return row;};
    stats.append(
      stat('◇',entries.length,'Nodes'),
      stat('✦',categoryCounts.length||presentationClusterCount(entries),'Categories'),
      stat('⇄',graph.edges?.length??0,'Connections'),
      stat('✓',entries.filter(row=>row.retrievalReady).length,'Retrieval-ready')
    );
    overview.body.append(stats);
    const ownerLine=element(doc,'div',{className:'nexus-world-owner-line'});
    ownerLine.append(makeBadge(doc,'WORLD TREE · '+String(source?.operationalState??source?.health??'IDLE'),source?.statusToken??'historical'),element(doc,'span',{className:'nexus-muted',text:String(progress)+'% published-ready'}));
    overview.body.append(ownerLine,renderWorldTreeFilterDock(doc,{inline:true}));
    surface.append(overview.root);
  }else if(view==='categories'){
    const categories=panel(doc,'Categories',categoryCounts.length?'Published source categories':'Presentation clusters until categories are published','⌘');
    if(categoryCounts.length){
      for(const [category,count] of categoryCounts.slice(0,18)){
        const tone=semanticToneForCategory(category),row=element(doc,'div',{className:'nexus-world-category-row',dataset:{tone}});
        row.append(element(doc,'span',{className:'nexus-world-category-dot'}),element(doc,'strong',{text:category}),element(doc,'span',{text:String(count)}));
        categories.body.append(row);
      }
    }else{
      const count=presentationClusterCount(entries);
      for(let index=0;index<count;index++){
        const tone=SEMANTIC_TONES[index%SEMANTIC_TONES.length],row=element(doc,'div',{className:'nexus-world-category-row',dataset:{tone}});
        row.append(element(doc,'span',{className:'nexus-world-category-dot'}),element(doc,'strong',{text:'Cluster '+String(index+1)}),element(doc,'span',{text:'layout'}));
        categories.body.append(row);
      }
      categories.body.append(element(doc,'p',{className:'nexus-muted nexus-world-category-note',text:'Layout-only clusters do not add semantic meaning to Lore.'}));
    }
    surface.append(categories.root);
  }else{
    const stateCard=panel(doc,'Source State','Canonical World Tree publication','◌');
    const stateGrid=element(doc,'div',{className:'nexus-world-study-grid'});
    for(const state of STATE_ORDER){
      const meta=STATE_META[state],row=element(doc,'div',{className:'nexus-world-study-row',dataset:{state}});
      row.append(element(doc,'span',{className:'nexus-lore-state-dot',text:meta.symbol}),element(doc,'span',{text:meta.label}),element(doc,'strong',{text:String(Number(counts?.[state]??0))}));
      stateGrid.append(row);
    }
    stateCard.body.append(stateGrid,createKeyValue(doc,[
      {key:'World revision',value:data?.revision??'—'},
      {key:'Canonical edges',value:Array.isArray(data?.worldEdges)?data.worldEdges.length:0},
      {key:'Source',value:selected?.snapshot?.title??selected?.selection?.title??'Selected Lorebook'},
      {key:'Published nodes',value:entries.length},
    ]));
    surface.append(stateCard.root);
  }

  rail.append(tabs,surface);
  return rail;
}

function renderGraphPanel(doc,{data,selected,progress,scope,inspect,renderState,refresh,motionMode='FULL',tools=null}={}){
  const entries=Array.isArray(data?.entries)?data.entries:[],snapshot=selected?.snapshot??null;
  const graphActive=entries.some(row=>['STUDYING','READY','FAILED'].includes(String(row?.operatorState??'').toUpperCase()));
  const systemReduced=prefersReducedMotion(doc),extensionPolicy=getNexusRenderingPolicy({document:doc}),motionPolicy=resolveMotionPolicy(motionMode,{systemReduced}),motionEnabled=motionPolicy.enabled&&extensionPolicy.animationsEnabled,nativeMotion=motionEnabled&&extensionPolicy.nativeSvgAnimationsEnabled;
  const panelRoot=element(doc,'section',{className:'nexus-lore-neural-canvas-card'});
  const head=element(doc,'header',{className:'nexus-lore-neural-canvas-head'});
  const headActions=element(doc,'div',{className:'nexus-lore-neural-canvas-head__actions'});
  const search=element(doc,'input',{className:'nexus-world-tree-search',attrs:{type:'search',placeholder:'Search world tree…','aria-label':'Search world tree',disabled:'disabled',title:'World Tree search · planned'}});
  const futureActions=element(doc,'div',{className:'nexus-lore-future-actions',attrs:{'aria-label':'World Tree tools'}});
  const mergeButton=createButton(doc,{label:'Merge',scope,size:'sm',variant:'secondary',disabled:typeof tools?.merge!=='function',onPress:async()=>{
    if(typeof tools?.merge==='function')await tools.merge();
  }});
  mergeButton.classList?.add?.('nexus-lore-future-action');
  mergeButton.setAttribute?.('title',tools?.merge?'Scan the selected Lorebook for merge candidates':'Merge owner unavailable');
  const builder=tools?.builder??null,builderActive=Boolean(builder?.active),builderBusy=Boolean(builder?.busy);
  if(builderActive){
    const phase=String(builder?.phase??(builderBusy?'ANALYZING':'REVIEW'));
    const builderStatus=element(doc,'span',{className:'nexus-world-builder-status',dataset:{phase:phase.toLowerCase()}});
    builderStatus.append(element(doc,'i'),element(doc,'strong',{text:builderBusy?'BUILDER · ANALYZING':'BUILDER · '+phase.replaceAll('_',' ')}));
    futureActions.append(builderStatus);
    const approve=createButton(doc,{label:builderBusy?'Working…':'Approve',scope,size:'sm',variant:'primary',disabled:builderBusy||!['REVIEW','LAYOUT_REVIEW','LAYOUT_PENDING','APPROVED'].includes(phase),onPress:()=>builder?.approve?.()});
    approve.classList?.add?.('nexus-world-builder-action','is-approve');
    approve.setAttribute?.('title','Approve and publish this Builder proposal');
    const rerun=createButton(doc,{label:'Re-run',scope,size:'sm',variant:'secondary',disabled:builderBusy||builder?.canRerun===false,onPress:()=>builder?.rerun?.()});
    rerun.classList?.add?.('nexus-world-builder-action','is-rerun');
    rerun.setAttribute?.('title','Discard this proposal and run Builder analysis again');
    const trash=createButton(doc,{label:'Trash',scope,size:'sm',variant:'quiet',disabled:builderBusy||builder?.canTrash===false,onPress:()=>builder?.trash?.()});
    trash.classList?.add?.('nexus-world-builder-action','is-trash');
    trash.setAttribute?.('title','Trash this Builder proposal. Published World Tree remains unchanged.');
    futureActions.append(approve,rerun,trash);
    mergeButton.disabled=true;
  }else{
    const rebuildButton=createButton(doc,{label:'Builder',scope,size:'sm',variant:'secondary',disabled:typeof tools?.build!=='function',onPress:()=>tools?.build?.()});
    rebuildButton.classList?.add?.('nexus-lore-future-action');
    rebuildButton.setAttribute?.('title',tools?.build?'Analyze the current World Tree and preview a new organization':'World Tree Builder owner unavailable');
    futureActions.append(mergeButton,rebuildButton);
    if(renderState?.trashTreeArmed){
      const confirmTrash=createButton(doc,{label:'Confirm Trash',scope,size:'sm',variant:'quiet',disabled:typeof tools?.trashTree!=='function',onPress:async()=>{
        if(typeof tools?.trashTree==='function')await tools.trashTree();
        renderState.trashTreeArmed=false;refresh?.();
      }});
      confirmTrash.classList?.add?.('nexus-world-builder-action','is-trash-tree-confirm');
      confirmTrash.setAttribute?.('title','Delete the old Tree structure and Builder layout while preserving authored Lore UIDs');
      const cancelTrash=createButton(doc,{label:'Cancel',scope,size:'sm',variant:'quiet',onPress:()=>{renderState.trashTreeArmed=false;refresh?.();}});
      cancelTrash.classList?.add?.('nexus-world-builder-action','is-trash-tree-cancel');
      futureActions.append(confirmTrash,cancelTrash);
    }else{
      const trashTree=createButton(doc,{label:'Trash Tree',scope,size:'sm',variant:'quiet',disabled:typeof tools?.trashTree!=='function',onPress:()=>{if(renderState){renderState.trashTreeArmed=true;refresh?.();}}});
      trashTree.classList?.add?.('nexus-world-builder-action','is-trash-tree');
      trashTree.setAttribute?.('title',tools?.trashTree?'Remove the old Tree structure and Builder layout; authored Lore UIDs are preserved':'Trash Tree owner unavailable');
      futureActions.append(trashTree);
    }
  }
  const toolRow=element(doc,'div',{className:'nexus-world-tree-tool-row'});
  toolRow.append(futureActions);
  if(graphActive&&renderState){
    const viewMenu=element(doc,'details',{className:'nexus-world-tree-view-menu'});
    const viewSummary=element(doc,'summary',{text:'View'});
    const viewActions=element(doc,'div',{className:'nexus-world-tree-view-actions'});
    viewActions.append(createButton(doc,{label:'Full Graph',scope,size:'sm',variant:'secondary',onPress:()=>{
      renderState.focusHubId=null;renderState.selectedNodeId=null;renderState.selectedNodeKind=null;renderState.viewport=null;refresh?.();
    }}));
    viewActions.append(createButton(doc,{label:'Reset Layout',scope,size:'sm',variant:'secondary',onPress:()=>{
      renderState.nodePositions={};renderState.nodeDrag=null;refresh?.();
    }}));
    viewActions.append(createButton(doc,{label:'Replay Growth',scope,size:'sm',variant:'secondary',disabled:!motionEnabled,onPress:()=>{
      replayLoreNeuralGrowth(renderState);
      refresh?.();
    }}));
    viewMenu.append(viewSummary,viewActions);
    toolRow.append(viewMenu);
  }
  headActions.append(search,toolRow);
  head.append(headActions);panelRoot.append(head);
  if(builderActive&&builder?.error)panelRoot.append(element(doc,'p',{className:'nexus-world-builder-error',attrs:{role:'alert'},text:String(builder.error)}));

  const canvas=element(doc,'div',{className:'nexus-lore-neural-canvas'});
  if(data?.worldTreeOrganizationCleared){
    canvas.append(element(doc,'p',{className:'nexus-muted',text:'Tree cleared. '+entries.length+' Lore sources are preserved. Run Builder to create a new tree.'}));
    panelRoot.append(canvas);return panelRoot;
  }
  if(!entries.length||!graphActive){
    canvas.append(renderEmptyCanvas(doc,{loaded:Boolean(snapshot),accepted:entries.length>0}));
    panelRoot.append(canvas,canvasFooter(doc,entries.length?'World Tree source nodes are published but not yet renderable in the active graph state.':'Load a selected Lorebook into the World Tree to populate source nodes and links.'));
    return panelRoot;
  }

  const graph=buildLoreGraph({entries,data,selected});
  applyCanonicalWorldHierarchy(graph,data);
  if(data?.canonicalWorldNodes?.length&&!renderState?.ownerLayout?.positions){
    const parents=new Map((data.canonicalWorldEdges??[]).filter(e=>e.data?.primaryPlacement).map(e=>[e.to,e.from]));
    const layout=planWorldTreeLayout({nodes:data.canonicalWorldNodes.map(n=>({...n,parentId:parents.get(n.id)??n.parentId})),seed:'world-tree-unbuilt'});
    for(const row of [...graph.hubs,...graph.nodes]){const point=layout.positions[row.canonicalNodeId??row.id];if(point){row.x=point.x+500;row.y=point.y+400;}}
    for(const artifact of graph.artifacts){const source=graph.nodes.find(n=>n.id===artifact.parentId);if(source){artifact.x=source.x+24;artifact.y=source.y+24;}}
  }
  if(renderState)renderState.savePin=tools?.savePin;
  applyPersistedNodePositions(graph,renderState);
  const growth=growthState(renderState,selected,graph);
  const viewBox=formatViewBox(renderState?.viewport??parseViewBox(focusedViewBox(graph,renderState?.focusHubId)));
  const svg=svgEl(doc,'svg',{'viewBox':viewBox,'class':'nexus-lore-neural-svg'+(renderState?.focusHubId?' is-focused':''),'role':'img','aria-label':'Circular Lore source and representation graph','data-focus-hub':renderState?.focusHubId??null});
  applyZoomPresentation(svg,parseViewBox(viewBox));
  const defs=svgEl(doc,'defs');
  const filter=svgEl(doc,'filter',{'id':'nexus-lore-glow','x':'-80%','y':'-80%','width':'260%','height':'260%'});
  filter.append(svgEl(doc,'feGaussianBlur',{'stdDeviation':'4.6','result':'blur'}),svgEl(doc,'feMerge',{},[svgEl(doc,'feMergeNode',{'in':'blur'}),svgEl(doc,'feMergeNode',{'in':'SourceGraphic'})]));
  const coreGradient=svgEl(doc,'radialGradient',{'id':'nexus-world-core-gradient','cx':'42%','cy':'35%','r':'72%'});
  coreGradient.append(svgEl(doc,'stop',{'offset':'0%','stop-color':'#baf6ff'}),svgEl(doc,'stop',{'offset':'18%','stop-color':'#38d9ff'}),svgEl(doc,'stop',{'offset':'55%','stop-color':'#0c65c7'}),svgEl(doc,'stop',{'offset':'100%','stop-color':'#06182b'}));
  defs.append(filter,coreGradient);svg.append(defs);
  svg.append(svgEl(doc,'circle',{'cx':'500','cy':'380','r':'300','class':'nexus-lore-orbit nexus-lore-orbit--outer'}),svgEl(doc,'circle',{'cx':'500','cy':'380','r':'228','class':'nexus-lore-orbit'}),svgEl(doc,'circle',{'cx':'500','cy':'380','r':'148','class':'nexus-lore-orbit nexus-lore-orbit--inner'}));

  for(const edge of graph.edges){
    const isNew=growth.newEdges.has(edge.id),delay=animationDelay(edge,growth);
    const path=svgEl(doc,'path',{
      d:curve(edge.from.x,edge.from.y,edge.to.x,edge.to.y),
      class:'nexus-lore-neural-link nexus-lore-neural-link--'+edge.kind+' '+(isNew?'is-new':'is-steady')+(isNew&&nativeMotion?' has-native-reveal':''),
      'data-state':edge.state,'data-tone':edge.tone??null,'data-wave':edge.wave??null,'data-edge-id':edge.id,'data-from-id':edge.fromId??null,'data-to-id':edge.toId??null,
      'style':'--nexus-link-delay:'+String(delay)+'ms'+(isNew&&nativeMotion?';stroke-dasharray:1;stroke-dashoffset:1;animation:none':''),
      'pathLength':isNew&&nativeMotion?'1':null,
    });
    if(isNew&&nativeMotion)path.append(nativeAnimate(doc,{attributeName:'stroke-dashoffset',from:'1',to:'0',begin:delay,dur:1500}));
    svg.append(path);
  }

  const core=svgEl(doc,'g',{'class':'nexus-lore-core-node'+(renderState?.selectedNodeKind==='core'?' is-selected':''),'data-node-id':'core','tabindex':'0','role':'button','aria-label':'Nexus World Tree core'});
  const coreLabel=svgEl(doc,'text',{'x':'500','y':'428','text-anchor':'middle','class':'nexus-lore-core-node__label'});coreLabel.textContent='NEXUS';
  const coreSub=svgEl(doc,'text',{'x':'500','y':'441','text-anchor':'middle','class':'nexus-lore-core-node__sub'});coreSub.textContent='WORLD TREE';
  core.append(
    svgEl(doc,'circle',{'cx':'500','cy':'380','r':'116','class':'nexus-lore-core-node__halo'}),
    svgEl(doc,'circle',{'cx':'500','cy':'380','r':'94','class':'nexus-lore-core-node__ring nexus-lore-core-node__ring--outer'}),
    svgEl(doc,'circle',{'cx':'500','cy':'380','r':'78','class':'nexus-lore-core-node__ring nexus-lore-core-node__ring--inner'}),
    svgEl(doc,'circle',{'cx':'500','cy':'380','r':'67','class':'nexus-lore-core-node__body'}),
    svgEl(doc,'image',{'href':NEXUS_BRAND_ICON_DATA_URI,'x':'474','y':'354','width':'52','height':'52','preserveAspectRatio':'xMidYMid meet','class':'nexus-lore-core-node__brand'}),
    coreLabel,coreSub
  );
  svg.append(core);
  const activateCore=()=>{if(renderState){renderState.selectedNodeId='core';renderState.selectedNodeKind='core';renderState.focusHubId=null;renderState.viewport=null;}applyGraphInteraction(svg,graph,renderState);};
  scope?.listen?.(core,'click',activateCore);scope?.listen?.(core,'keydown',event=>{if(event?.key==='Enter'||event?.key===' '){event.preventDefault?.();activateCore();}});scope?.listen?.(core,'pointerenter',()=>setGraphHover(svg,graph,renderState,'core'));scope?.listen?.(core,'pointerleave',()=>setGraphHover(svg,graph,renderState,null));

  for(const hub of graph.hubs){
    const isNew=growth.newHubs.has(hub.id),delay=animationDelay(hub,growth);
    const selected=renderState?.selectedNodeId===hub.id;
    const g=svgEl(doc,'g',{'class':'nexus-lore-hub-node '+(isNew?'is-new':'is-steady')+(isNew&&nativeMotion?' has-native-reveal':'')+(selected?' is-selected':''),'data-node-id':hub.id,'data-node-kind':'hub','data-state':hub.state,'data-tone':hub.tone??null,'data-wave':hub.wave??null,'tabindex':'0','role':'button','aria-label':hub.label+' '+hub.count});
    g.setAttribute('style','--nexus-node-delay:'+String(delay)+'ms');
    const halo=svgEl(doc,'circle',{'cx':String(hub.x),'cy':String(hub.y),'r':isNew&&nativeMotion?'5':'58','class':'nexus-lore-hub-node__halo'});
    const body=svgEl(doc,'circle',{'cx':String(hub.x),'cy':String(hub.y),'r':isNew&&nativeMotion?'2':'43','class':'nexus-lore-hub-node__body'});
    const t=svgEl(doc,'text',{'x':String(hub.x),'y':String(hub.y-2),'text-anchor':'middle','class':'nexus-lore-hub-node__title'});t.textContent=hub.label.toUpperCase();
    const count=svgEl(doc,'text',{'x':String(hub.x),'y':String(hub.y+16),'text-anchor':'middle','class':'nexus-lore-hub-node__count'});count.textContent=String(hub.count);
    if(isNew&&nativeMotion){
      halo.append(nativeAnimate(doc,{attributeName:'r',from:'5',to:'58',begin:delay,dur:1250}));
      body.append(nativeAnimate(doc,{attributeName:'r',from:'2',to:'43',begin:delay+120,dur:1100}));
      t.setAttribute('opacity','0');count.setAttribute('opacity','0');
      t.append(nativeAnimate(doc,{attributeName:'opacity',from:'0',to:'1',begin:delay+480,dur:420}));
      count.append(nativeAnimate(doc,{attributeName:'opacity',from:'0',to:'1',begin:delay+540,dur:420}));
    }
    g.append(halo,body,t,count);svg.append(g);
    const activateHub=()=>{settleGrowthReveal(renderState,graph);if(renderState){renderState.selectedNodeId=hub.id;renderState.selectedNodeKind='hub';renderState.focusHubId=null;renderState.rightDrawerOpen=true;renderState.rightDrawerView='inspector';}applyGraphInteraction(svg,graph,renderState);refresh?.();};
    scope?.listen?.(g,'click',event=>{if(consumeSuppressedClick(renderState,hub.id))return;activateHub(event);});scope?.listen?.(g,'keydown',event=>{if(event?.key==='Enter'||event?.key===' '){event.preventDefault?.();activateHub(event);}});
    scope?.listen?.(g,'pointerenter',()=>setGraphHover(svg,graph,renderState,hub.id));scope?.listen?.(g,'pointerleave',()=>setGraphHover(svg,graph,renderState,null));
    installDraggableBubble(g,hub,svg,graph,renderState,scope);
  }

  for(const node of graph.nodes){
    const isNew=growth.newNodes.has(node.id),delay=animationDelay(node,growth);
    const selected=renderState?.selectedNodeId===node.id;
    const g=svgEl(doc,'g',{'class':'nexus-lore-entry-node '+(isNew?'is-new':'is-steady')+(isNew&&nativeMotion?' has-native-reveal':'')+(selected?' is-selected':''),'data-node-id':node.id,'data-node-kind':'source','data-hub-id':node.hubId??null,'data-state':node.state,'data-tone':node.tone??null,'data-wave':node.wave??null,'tabindex':'0','role':'button','aria-label':'Lore source '+node.label+' '+node.state});
    g.setAttribute('style','--nexus-node-delay:'+String(delay)+'ms');
    const representationCount=Array.isArray(node.payload?.representations)?node.payload.representations.length:0;
    const radius=Math.min(14,7.5+(node.artifactCount?Math.log2(node.artifactCount+1)*1.15:0)+(representationCount?1.25:0));
    const halo=svgEl(doc,'circle',{'cx':String(node.x),'cy':String(node.y),'r':isNew&&nativeMotion?'1':String(radius+5),'class':'nexus-lore-entry-node__halo'});
    const body=svgEl(doc,'circle',{'cx':String(node.x),'cy':String(node.y),'r':isNew&&nativeMotion?'0.5':String(radius),'class':'nexus-lore-entry-node__body'});
    if(isNew&&nativeMotion){
      halo.append(nativeAnimate(doc,{attributeName:'r',from:'1',to:String(radius+5),begin:delay,dur:950}));
      body.append(nativeAnimate(doc,{attributeName:'r',from:'0.5',to:String(radius),begin:delay+90,dur:820}));
    }
    const label=svgEl(doc,'text',{'x':String(node.x),'y':String(node.y+2),'text-anchor':'middle','class':'nexus-lore-entry-node__label'});
    label.textContent=bubbleLabel(node.label);
    g.append(halo,body);
    const imageHref=publishedSourceImage(node.sourceMeta);
    if(imageHref){
      g.append(svgEl(doc,'image',{'href':imageHref,'x':String(node.x-radius),'y':String(node.y-radius),'width':String(radius*2),'height':String(radius*2),'preserveAspectRatio':'xMidYMid slice','data-radius':String(radius),'class':'nexus-lore-entry-node__image'}));
      g.append(svgEl(doc,'circle',{'cx':String(node.x),'cy':String(node.y),'r':String(radius),'class':'nexus-lore-entry-node__image-ring'}));
    }
    g.append(label);
    const title=svgEl(doc,'title');title.textContent=node.label+' · '+node.state+(node.artifactCount?' · '+node.artifactCount+' artifacts':'');g.append(title);
    const activate=()=>{settleGrowthReveal(renderState,graph);if(renderState){renderState.selectedNodeId=node.id;renderState.selectedNodeKind='source';renderState.focusHubId=null;renderState.rightDrawerOpen=true;renderState.rightDrawerView='inspector';}applyGraphInteraction(svg,graph,renderState);inspect?.({kind:'nexus-lore-source-node',id:node.id,title:node.label,authority:'LORE_OWNER',payload:node.payload});refresh?.();};
    scope?.listen?.(g,'click',event=>{if(consumeSuppressedClick(renderState,node.id))return;activate(event);});scope?.listen?.(g,'keydown',event=>{if(event?.key==='Enter'||event?.key===' '){event.preventDefault?.();activate(event);}});
    scope?.listen?.(g,'pointerenter',()=>setGraphHover(svg,graph,renderState,node.id));scope?.listen?.(g,'pointerleave',()=>setGraphHover(svg,graph,renderState,null));
    installDraggableBubble(g,node,svg,graph,renderState,scope);
    svg.append(g);
  }
  for(const node of graph.artifacts){
    const isNew=growth.newArtifacts.has(node.id),delay=animationDelay(node,growth);
    const selected=renderState?.selectedNodeId===node.id;
    const g=svgEl(doc,'g',{'class':'nexus-lore-artifact-node '+(isNew?'is-new':'is-steady')+(isNew&&nativeMotion?' has-native-reveal':'')+(selected?' is-selected':''),'data-node-id':node.id,'data-node-kind':'artifact','data-hub-id':node.hubId??null,'data-parent-id':node.parentId??null,'data-state':node.state,'data-tone':node.tone??null,'data-wave':node.wave??null,'tabindex':'0','role':'button','aria-label':'Derived Lore artifact group '+node.label});
    g.setAttribute('style','--nexus-node-delay:'+String(delay)+'ms');
    const radius=Math.min(9,4+Math.log2(Number(node.count??1)+1));
    const body=svgEl(doc,'circle',{'cx':String(node.x),'cy':String(node.y),'r':isNew&&nativeMotion?'0.5':String(radius),'class':'nexus-lore-artifact-node__body'});
    if(isNew&&nativeMotion)body.append(nativeAnimate(doc,{attributeName:'r',from:'0.5',to:String(radius),begin:delay,dur:720}));
    g.append(body);
    const title=svgEl(doc,'title');title.textContent=node.label;g.append(title);svg.append(g);
    const activateArtifact=()=>{settleGrowthReveal(renderState,graph);if(renderState){renderState.selectedNodeId=node.id;renderState.selectedNodeKind='artifact';renderState.focusHubId=null;renderState.rightDrawerOpen=true;renderState.rightDrawerView='inspector';}applyGraphInteraction(svg,graph,renderState);refresh?.();};
    scope?.listen?.(g,'click',event=>{if(consumeSuppressedClick(renderState,node.id))return;activateArtifact(event);});scope?.listen?.(g,'keydown',event=>{if(event?.key==='Enter'||event?.key===' '){event.preventDefault?.();activateArtifact(event);}});
    scope?.listen?.(g,'pointerenter',()=>setGraphHover(svg,graph,renderState,node.id));scope?.listen?.(g,'pointerleave',()=>setGraphHover(svg,graph,renderState,null));
    installDraggableBubble(g,node,svg,graph,renderState,scope);
  }
  applyGraphInteraction(svg,graph,renderState);
  installGraphSandbox(svg,graph,renderState,scope);
  canvas.append(svg);
  if(nativeMotion)scheduleNativeAnimations(svg,doc);
  panelRoot.append(canvas,canvasFooter(doc,graph.visibleSourceCount+' of '+graph.totalSourceCount+' nodes shown · World Tree uses published structure or presentation-only clusters; lifecycle remains owner-reported.'));
  return panelRoot;
}

function applyZoomPresentation(svg,viewport){
  const width=Number(viewport?.width)||1000;
  const level=width<=430?'close':width<=680?'detail':'overview';
  svg?.setAttribute?.('data-zoom-level',level);
  return level;
}
function bubbleLabel(value){
  const text=String(value??'').trim();
  return text.length>12?text.slice(0,11)+'…':text;
}

function focusedViewBox(graph,hubId){
  if(!hubId){
    const points=[...(graph?.hubs??[]),...(graph?.nodes??[]),...(graph?.artifacts??[]),{x:500,y:380}];
    if(!points.length)return formatViewBox(DEFAULT_WORLD_VIEW);
    const xs=points.map(p=>p.x).filter(Number.isFinite),ys=points.map(p=>p.y).filter(Number.isFinite);
    const minX=Math.min(...xs)-105,maxX=Math.max(...xs)+105,minY=Math.min(...ys)-105,maxY=Math.max(...ys)+105;
    return formatViewBox({x:minX,y:minY,width:Math.max(360,maxX-minX),height:Math.max(300,maxY-minY)});
  }
  const hub=graph?.hubs?.find?.(row=>row.id===hubId);
  if(!hub)return formatViewBox(DEFAULT_WORLD_VIEW);
  const points=[hub,...(graph.nodes??[]).filter(row=>row.hubId===hubId),...(graph.artifacts??[]).filter(row=>row.hubId===hubId)];
  const xs=points.map(row=>Number(row.x)).filter(Number.isFinite),ys=points.map(row=>Number(row.y)).filter(Number.isFinite);
  if(!xs.length||!ys.length)return formatViewBox(DEFAULT_WORLD_VIEW);
  const padding=105,minX=Math.min(...xs)-padding,maxX=Math.max(...xs)+padding,minY=Math.min(...ys)-padding,maxY=Math.max(...ys)+padding;
  const width=Math.max(360,maxX-minX),height=Math.max(300,maxY-minY),cx=(minX+maxX)/2,cy=(minY+maxY)/2;
  return formatViewBox(clampViewport({x:cx-width/2,y:cy-height/2,width,height}));
}
function parseViewBox(value){
  if(value&&typeof value==='object')return clampViewport(value);
  const [x=DEFAULT_WORLD_VIEW.x,y=DEFAULT_WORLD_VIEW.y,width=DEFAULT_WORLD_VIEW.width,height=DEFAULT_WORLD_VIEW.height]=String(value??formatViewBox(DEFAULT_WORLD_VIEW)).trim().split(/\s+/).map(Number);
  return clampViewport({x,y,width,height});
}
function formatViewBox(view){
  const row=clampViewport(view);
  return[round(row.x),round(row.y),round(row.width),round(row.height)].join(' ');
}
function clampViewport(view){
  const minWidth=220,maxWidth=1600,aspect=WORLD_VIEW_ASPECT;
  let width=Math.max(minWidth,Math.min(maxWidth,Number(view?.width)||DEFAULT_WORLD_VIEW.width));
  let height=width/aspect;
  if(Number(view?.height)>0&&Math.abs(Number(view.height)-height)<40)height=Number(view.height);
  const worldMargin=520,minX=-worldMargin,maxX=1000+worldMargin-width,minY=-worldMargin,maxY=760+worldMargin-height;
  const x=Math.max(minX,Math.min(maxX,Number.isFinite(Number(view?.x))?Number(view.x):DEFAULT_WORLD_VIEW.x)),y=Math.max(minY,Math.min(maxY,Number.isFinite(Number(view?.y))?Number(view.y):DEFAULT_WORLD_VIEW.y));
  return{x,y,width,height};
}
function applyGraphInteraction(svg,graph,state){
  if(!svg)return;
  const selectedId=state?.selectedNodeId??null,hoverId=state?.hoverNodeId??null,focusHubId=state?.focusHubId??null;
  const viewport=state?.viewport??parseViewBox(focusedViewBox(graph,focusHubId));
  svg.setAttribute?.('viewBox',formatViewBox(viewport));
  applyZoomPresentation(svg,viewport);
  if(focusHubId)svg.classList?.add?.('is-focused');else svg.classList?.remove?.('is-focused');
  svg.classList?.toggle?.('has-selection',Boolean(selectedId));
  svg.classList?.toggle?.('has-hover',Boolean(hoverId));
  if(focusHubId)svg.setAttribute?.('data-focus-hub',focusHubId);else svg.removeAttribute?.('data-focus-hub');

  const visit=node=>{
    const nodeId=node?.getAttribute?.('data-node-id')??node?.attributes?.['data-node-id']??null;
    const fromId=node?.getAttribute?.('data-from-id')??node?.attributes?.['data-from-id']??null;
    const toId=node?.getAttribute?.('data-to-id')??node?.attributes?.['data-to-id']??null;
    const selected=Boolean(selectedId&&nodeId===selectedId);
    const connectedEdge=Boolean(selectedId&&(fromId===selectedId||toId===selectedId));
    const selectedNeighbor=Boolean(selectedId&&nodeId&&(graph?.edges??[]).some(edge=>(edge.fromId===selectedId&&edge.toId===nodeId)||(edge.toId===selectedId&&edge.fromId===nodeId)));
    const hovered=Boolean(hoverId&&nodeId===hoverId);
    const hoverConnectedEdge=Boolean(hoverId&&(fromId===hoverId||toId===hoverId));
    const hoverNeighbor=Boolean(hoverId&&nodeId&&(graph?.edges??[]).some(edge=>(edge.fromId===hoverId&&edge.toId===nodeId)||(edge.toId===hoverId&&edge.fromId===nodeId)));
    node?.classList?.toggle?.('is-selected',selected);
    node?.classList?.toggle?.('is-connected',connectedEdge||selectedNeighbor);
    node?.classList?.toggle?.('is-hovered',hovered);
    node?.classList?.toggle?.('is-hover-connected',hoverConnectedEdge||hoverNeighbor);
    node?.classList?.toggle?.('is-muted',Boolean(selectedId&&nodeId&&!selected&&!selectedNeighbor&&nodeId!=='core'));
    for(const child of node?.children??[])visit(child);
  };
  visit(svg);
}
function toggleDrawer(state,side,view,refresh){
  if(!state)return false;
  const openKey=side==='right'?'rightDrawerOpen':'leftDrawerOpen',viewKey=side==='right'?'rightDrawerView':'leftDrawerView';
  const sameView=String(state[viewKey]??'')===String(view);
  if(sameView&&state[openKey]!==false)state[openKey]=false;
  else{state[viewKey]=view;state[openKey]=true;}
  refresh?.();
  return state[openKey]!==false;
}
function setGraphHover(svg,graph,state,id){
  if(!state)return;
  state.hoverNodeId=id??null;
  applyGraphInteraction(svg,graph,state);
}

function applyPersistedNodePositions(graph,state){
  const positions=state?.nodePositions??{};
  for(const row of [...(graph?.hubs??[]),...(graph?.nodes??[]),...(graph?.artifacts??[])]){
    const owner=state?.ownerLayout?.positions?.[row.canonicalNodeId??row.id];
    if(owner&&Number.isFinite(owner.x)&&Number.isFinite(owner.y)){row.x=owner.x+500;row.y=owner.y+400;}
    const saved=positions?.[row.id];
    if(saved&&Number.isFinite(Number(saved.x))&&Number.isFinite(Number(saved.y))){
      row.x=Number(saved.x);row.y=Number(saved.y);
    }
  }
}
function findGraphBubble(target){
  let node=target;
  while(node){
    const id=node?.getAttribute?.('data-node-id')??node?.attributes?.['data-node-id']??null;
    if(id)return node;
    node=node.parentNode;
  }
  return null;
}
function consumeSuppressedClick(state,id){
  if(!state?.suppressClickId||state.suppressClickId!==id)return false;
  state.suppressClickId=null;return true;
}
function graphPointFromPointer(svg,state,event){
  const view=parseViewBox(state?.viewport??svg?.getAttribute?.('viewBox')??svg?.attributes?.viewBox??formatViewBox(DEFAULT_WORLD_VIEW));
  const width=Math.max(1,Number(svg?.clientWidth)||1000),height=Math.max(1,Number(svg?.clientHeight)||760);
  let px=Number(event?.offsetX),py=Number(event?.offsetY);
  try{
    const rect=svg?.getBoundingClientRect?.();
    if(rect&&Number.isFinite(Number(event?.clientX))&&Number.isFinite(Number(event?.clientY))){
      px=Number(event.clientX)-Number(rect.left||0);py=Number(event.clientY)-Number(rect.top||0);
    }
  }catch{}
  if(!Number.isFinite(px))px=Number(event?.clientX)||0;
  if(!Number.isFinite(py))py=Number(event?.clientY)||0;
  px=Math.max(0,Math.min(width,px));py=Math.max(0,Math.min(height,py));
  return{x:view.x+(px/width)*view.width,y:view.y+(py/height)*view.height};
}
function updateGraphGeometry(svg,graph,row){
  const setCirclePosition=node=>{
    const cls=String(node?.getAttribute?.('class')??node?.attributes?.class??'');
    if(node?.tagName?.toLowerCase?.()==='circle'&&(/nexus-lore-(hub|entry|artifact)-node__/.test(cls))){
      node.setAttribute?.('cx',String(row.x));node.setAttribute?.('cy',String(row.y));
    }
    if(node?.tagName?.toLowerCase?.()==='text'&&row.label){
      const clsText=String(node?.getAttribute?.('class')??node?.attributes?.class??'');
      node.setAttribute?.('x',String(row.x));
      if(clsText.includes('nexus-lore-hub-node__title'))node.setAttribute?.('y',String(row.y-2));
      if(clsText.includes('nexus-lore-hub-node__count'))node.setAttribute?.('y',String(row.y+16));
      if(clsText.includes('nexus-lore-entry-node__label'))node.setAttribute?.('y',String(row.y+2));
    }
    if(node?.tagName?.toLowerCase?.()==='image'){
      const clsImage=String(node?.getAttribute?.('class')??node?.attributes?.class??'');
      if(clsImage.includes('nexus-lore-entry-node__image')){
        const radius=Number(node?.getAttribute?.('data-radius')??node?.attributes?.['data-radius']??0)||0;
        node.setAttribute?.('x',String(row.x-radius));node.setAttribute?.('y',String(row.y-radius));
      }
    }
    for(const child of node?.children??[])setCirclePosition(child);
  };
  let bubble=null;
  const visit=node=>{
    const id=node?.getAttribute?.('data-node-id')??node?.attributes?.['data-node-id']??null;
    if(id===row.id)bubble=node;
    for(const child of node?.children??[])visit(child);
  };
  visit(svg);if(bubble)setCirclePosition(bubble);
  for(const edge of graph?.edges??[]){
    if(edge.fromId!==row.id&&edge.toId!==row.id)continue;
    const path=findSvgByData(svg,'data-edge-id',edge.id);
    path?.setAttribute?.('d',curve(edge.from.x,edge.from.y,edge.to.x,edge.to.y));
  }
}
function findSvgByData(root,key,value){
  let found=null;
  const visit=node=>{
    if(found)return;
    const current=node?.getAttribute?.(key)??node?.attributes?.[key]??null;
    if(current===value){found=node;return;}
    for(const child of node?.children??[])visit(child);
  };
  visit(root);return found;
}
function installDraggableBubble(element,row,svg,graph,state,scope){
  if(!element||!row||!state||!scope?.listen)return;
  scope.listen(element,'pointerdown',event=>{
    if(Number(event?.button??0)!==0)return;
    event?.stopPropagation?.();
    const start=graphPointFromPointer(svg,state,event);
    state.nodeDrag={id:row.id,pointerId:event?.pointerId??null,startPointer:start,startX:Number(row.x),startY:Number(row.y),moved:false};
    element.setPointerCapture?.(event?.pointerId);
    element.classList?.add?.('is-dragging');
  });
  scope.listen(element,'pointermove',event=>{
    const drag=state.nodeDrag;if(!drag||drag.id!==row.id)return;
    if(drag.pointerId!=null&&event?.pointerId!=null&&drag.pointerId!==event.pointerId)return;
    event?.stopPropagation?.();
    const point=graphPointFromPointer(svg,state,event),dx=point.x-drag.startPointer.x,dy=point.y-drag.startPointer.y;
    if(Math.hypot(dx,dy)>4)drag.moved=true;
    row.x=Math.max(-500,Math.min(1500,drag.startX+dx));row.y=Math.max(-420,Math.min(1180,drag.startY+dy));
    state.nodePositions[row.id]={x:row.x,y:row.y};
    updateGraphGeometry(svg,graph,row);
  });
  const finish=event=>{
    const drag=state.nodeDrag;if(!drag||drag.id!==row.id)return;
    if(drag.pointerId!=null&&event?.pointerId!=null&&drag.pointerId!==event.pointerId)return;
    event?.stopPropagation?.();
    if(drag.moved)state.suppressClickId=row.id;
    if(drag.moved&&state.savePin)void state.savePin(row.canonicalNodeId??row.id,{x:row.x-500,y:row.y-400});
    state.nodeDrag=null;element.releasePointerCapture?.(event?.pointerId);element.classList?.remove?.('is-dragging');
  };
  scope.listen(element,'pointerup',finish);scope.listen(element,'pointercancel',finish);
}
function installGraphSandbox(svg,graph,state,scope){
  if(!svg||!state||!scope?.listen)return;
  const current=()=>parseViewBox(state.viewport??focusedViewBox(graph,state.focusHubId));
  const apply=view=>{state.viewport=clampViewport(view);svg.setAttribute?.('viewBox',formatViewBox(state.viewport));applyZoomPresentation(svg,state.viewport);};
  scope.listen(svg,'wheel',event=>{
    event?.preventDefault?.();
    const view=current(),delta=Number(event?.deltaY)||0,factor=delta<0?.82:1.22;
    const nextWidth=Math.max(220,Math.min(1600,view.width*factor)),nextHeight=nextWidth/WORLD_VIEW_ASPECT;
    const px=Math.max(0,Math.min(1,(Number(event?.offsetX)||Number(event?.clientX)||0)/Math.max(1,Number(svg.clientWidth)||1000)));
    const py=Math.max(0,Math.min(1,(Number(event?.offsetY)||Number(event?.clientY)||0)/Math.max(1,Number(svg.clientHeight)||760)));
    apply({x:view.x+(view.width-nextWidth)*px,y:view.y+(view.height-nextHeight)*py,width:nextWidth,height:nextHeight});
  });
  scope.listen(svg,'pointerdown',event=>{
    if(Number(event?.button??0)!==0)return;
    if(findGraphBubble(event?.target))return;
    const view=current();
    state.panGesture={pointerId:event?.pointerId??null,startX:Number(event?.clientX)||0,startY:Number(event?.clientY)||0,view};
    svg.setPointerCapture?.(event?.pointerId);
    svg.classList?.add?.('is-panning');
  });
  scope.listen(svg,'pointermove',event=>{
    const drag=state.panGesture;if(!drag)return;
    if(drag.pointerId!=null&&event?.pointerId!=null&&drag.pointerId!==event.pointerId)return;
    const scaleX=drag.view.width/Math.max(1,Number(svg.clientWidth)||1000),scaleY=drag.view.height/Math.max(1,Number(svg.clientHeight)||760);
    const dx=(Number(event?.clientX)||0)-drag.startX,dy=(Number(event?.clientY)||0)-drag.startY;
    apply({x:drag.view.x-dx*scaleX,y:drag.view.y-dy*scaleY,width:drag.view.width,height:drag.view.height});
  });
  const endPan=event=>{
    const drag=state.panGesture;if(!drag)return;
    if(drag.pointerId!=null&&event?.pointerId!=null&&drag.pointerId!==event.pointerId)return;
    state.panGesture=null;svg.releasePointerCapture?.(event?.pointerId);svg.classList?.remove?.('is-panning');
  };
  scope.listen(svg,'pointerup',endPan);scope.listen(svg,'pointercancel',endPan);
}


function renderEmptyCanvas(doc){
  const empty=element(doc,'div',{className:'nexus-lore-neural-empty'});
  const rings=element(doc,'div',{className:'nexus-lore-neural-empty__rings'});
  rings.append(element(doc,'span'),element(doc,'span'),element(doc,'span'));
  const core=element(doc,'div',{className:'nexus-lore-neural-empty__core',attrs:{'aria-label':'World Tree core'}});
  empty.append(rings,core);
  return empty;
}

function renderSelectedWorldTreeNodePanel(doc,{graph,renderState}={}){
  const selectedId=renderState?.selectedNodeId??null;
  const all=[...(graph?.hubs??[]),...(graph?.nodes??[]),...(graph?.artifacts??[])];
  const selectedNode=all.find(row=>row.id===selectedId)??null;
  const isHub=selectedNode&&(graph?.hubs??[]).includes(selectedNode);
  const isArtifact=selectedNode&&(graph?.artifacts??[]).includes(selectedNode);
  const kind=isHub?'Cluster':isArtifact?'Derived artifact':'Source UID';
  const detail=panel(doc,selectedNode&&(isHub||isArtifact)?'Selected Node':'Selected UID',selectedNode?kind+' · graph selection':'World Tree selection','◉');
  detail.root.classList?.add?.('nexus-lore-selected-detail','nexus-world-tree-uid-panel');
  if(!selectedNode){
    detail.body.append(element(doc,'p',{className:'nexus-muted',text:'Select a World Tree node to inspect its published UID information.'}));
    return detail;
  }
  detail.root.dataset.tone=selectedNode.tone??'cyan';
  const hero=element(doc,'div',{className:'nexus-lore-selected-detail__hero'});
  const heroCopy=element(doc,'div');
  heroCopy.append(element(doc,'strong',{text:selectedNode.label??selectedNode.id}),element(doc,'span',{className:'nexus-muted',text:kind}));
  hero.append(element(doc,'span',{className:'nexus-lore-selected-detail__orb',dataset:{tone:selectedNode.tone??'cyan'}}),heroCopy);
  detail.body.append(hero);
  if(isHub){
    detail.body.append(createKeyValue(doc,[
      {key:'Node ID',value:selectedNode.id},
      {key:'Label',value:selectedNode.label},
      {key:'Grouping',value:selectedNode.presentationOnly?'Presentation-only cluster':'Published semantic category'},
      {key:'Sources',value:selectedNode.count??0},
    ]));
    if(selectedNode.presentationOnly)detail.body.append(element(doc,'p',{className:'nexus-muted',text:'Layout-only cluster; no Lore category meaning is added.'}));
  }else if(isArtifact){
    const parent=(graph?.nodes??[]).find(row=>row.id===selectedNode.parentId);
    detail.body.append(createKeyValue(doc,[
      {key:'Node ID',value:selectedNode.id},
      {key:'Parent UID',value:parent?.payload?.uid??parent?.id??'NO_EVIDENCE'},
      {key:'Parent source',value:parent?.label??'NO_EVIDENCE'},
      {key:'Derived refs',value:selectedNode.count??0},
      {key:'Owner state',value:selectedNode.state??'NO_EVIDENCE'},
    ]));
  }else{
    const row=selectedNode.payload??{},meta=selectedNode.sourceMeta??null,tree=sourceTreePath(meta);
    detail.body.append(createKeyValue(doc,[
      {key:'UID',value:row.uid??selectedNode.id},
      {key:'Title',value:selectedNode.label??'NO_EVIDENCE'},
      {key:'Category',value:selectedNode.category??'NO_EVIDENCE'},
      {key:'Owner state',value:selectedNode.state??'NO_EVIDENCE'},
      {key:'Revision',value:row.sourceRevisionId??'NO_EVIDENCE'},
      {key:'Representations',value:Array.isArray(row.representations)?row.representations.length:0},
      {key:'Derived refs',value:Array.isArray(row.artifactIds)?row.artifactIds.length:0},
      {key:'Tree path',value:tree.length?tree.join(' › '):'NO_EVIDENCE'},
    ]));
  }
  return detail;
}

function renderWorldTreeFilterDock(doc,{inline=false}={}){
  const dock=element(doc,'div',{className:'nexus-world-tree-filter-dock'+(inline?' is-inline':''),attrs:{'aria-label':'World Tree filters'}});
  dock.append(element(doc,'strong',{className:'nexus-world-tree-filter-dock__title',text:'Filters'}));
  const rows=[
    ['Connections',true,false],
    ['Colors',true,false],
    ['Depth',false,true],
    ['Unknown',true,true],
  ];
  for(const [label,on,planned] of rows){
    const row=element(doc,'span',{className:'nexus-world-filter-chip'+(planned?' is-planned':'')});
    row.append(element(doc,'span',{text:label}),element(doc,'span',{className:'nexus-world-filter-toggle'+(on?' is-on':''),attrs:{role:'switch','aria-checked':String(on),'aria-disabled':'true'},title:planned?'Planned World Tree control':'Visual shell placeholder'}));
    dock.append(row);
  }
  return dock;
}

function renderLoreInsightRail(doc,{data,selected,renderState,tools=null,scope=null,refresh=null}={}){
  const rail=element(doc,'aside',{className:'nexus-lore-neural-rail nexus-lore-neural-rail--right nexus-inspector-drawer',dataset:{open:String(renderState?.rightDrawerOpen!==false),view:String(renderState?.rightDrawerView??'connections')}});
  const entries=data?.entries??[];
  const graph=entries.length?buildLoreGraph({entries,data,selected}):{hubs:[],nodes:[],artifacts:[],edges:[]};
  applyPersistedNodePositions(graph,renderState);
  const selectedId=renderState?.selectedNodeId??null;
  const all=[...(graph.hubs??[]),...(graph.nodes??[]),...(graph.artifacts??[])];
  const selectedNode=all.find(row=>row.id===selectedId)??null;
  const isHub=selectedNode&&(graph.hubs??[]).includes(selectedNode),isArtifact=selectedNode&&(graph.artifacts??[]).includes(selectedNode),isSource=Boolean(selectedNode&&!isHub&&!isArtifact);
  const connectionCount=selectedNode?(graph.edges??[]).filter(edge=>edge.fromId===selectedNode.id||edge.toId===selectedNode.id).length:0;

  const handle=element(doc,'button',{className:'nexus-inspector-drawer__handle',attrs:{type:'button','aria-label':renderState?.rightDrawerOpen===false?'Open inspector':'Collapse inspector','aria-expanded':String(renderState?.rightDrawerOpen!==false)}});
  handle.append(element(doc,'span',{text:renderState?.rightDrawerOpen===false?'INSPECTOR':'›'}));
  scope?.listen?.(handle,'click',()=>{
    renderState.rightDrawerOpen=renderState?.rightDrawerOpen===false;
    refresh?.();
  });

  const surface=element(doc,'section',{className:'nexus-inspector-window',attrs:{'aria-label':'World Tree inspector'}});
  const top=element(doc,'header',{className:'nexus-inspector-window__top'});
  const crumb=element(doc,'div',{className:'nexus-inspector-window__crumb'});
  crumb.append(element(doc,'span',{className:'nexus-inspector-window__dot',dataset:{tone:selectedNode?.tone??'cyan'}}),element(doc,'strong',{text:selectedNode?(isSource?'Source UID':isHub?'World category':'Derived artifact'):'World Inspector'}));
  const collapse=element(doc,'button',{className:'nexus-inspector-window__collapse',text:'×',attrs:{type:'button','aria-label':'Collapse inspector'}});
  scope?.listen?.(collapse,'click',()=>{renderState.rightDrawerOpen=false;refresh?.();});
  top.append(crumb,collapse);
  surface.append(top);

  if(selectedNode){
    const exact=selectedNode.sourceMeta??null,row=selectedNode.payload??{},category=selectedNode.category??(isHub?'Cluster':isArtifact?'Derived':'NO_EVIDENCE');
    const hero=element(doc,'section',{className:'nexus-inspector-window__hero',dataset:{tone:selectedNode.tone??'cyan'}});
    const orb=element(doc,'span',{className:'nexus-inspector-window__orb',dataset:{tone:selectedNode.tone??'cyan'}});
    const heroCopy=element(doc,'div',{className:'nexus-inspector-window__hero-copy'});
    heroCopy.append(element(doc,'h3',{text:selectedNode.label??selectedNode.id}),makeBadge(doc,category,isSource?'observed':'historical'));
    hero.append(orb,heroCopy);
    if(isSource&&typeof tools?.openUidSummarizer==='function'){
      const summarize=createButton(doc,{label:'Summarize',scope,size:'sm',variant:'secondary',onPress:()=>{
        tools.openUidSummarizer({
          uid:row.uid??selectedNode.id,title:selectedNode.label??selectedNode.id,category,
          ownerState:selectedNode.state??null,retrievalReady:row.retrievalReady===true,revision:row.sourceRevisionId??null,
          representations:Array.isArray(row.representations)?row.representations.length:0,
          derivedRefs:Array.isArray(row.artifactIds)?row.artifactIds.length:0,
          keys:Array.isArray(exact?.metadata?.keys)?[...exact.metadata.keys]:Array.isArray(exact?.key)?[...exact.key]:[],
        });
        refresh?.();
      }});
      summarize.classList?.add?.('nexus-inspector-window__summarize');
      hero.append(summarize);
    }
    surface.append(hero);

    if(isSource){
      const authored=String(exact?.content??exact?.text??'').trim();
      if(authored)surface.append(element(doc,'blockquote',{className:'nexus-inspector-window__excerpt',text:authored.length>560?authored.slice(0,557)+'…':authored}));
      const facts=createKeyValue(doc,[
        {key:'UID',value:row.uid??selectedNode.id},{key:'Owner state',value:selectedNode.state??'NO_EVIDENCE'},
        {key:'Retrieval-ready',value:row.retrievalReady?'Yes':'No'},{key:'Revision',value:row.sourceRevisionId??'NO_EVIDENCE'},
      ]);
      facts.classList?.add?.('nexus-inspector-window__facts');
      surface.append(facts);
      const metrics=element(doc,'div',{className:'nexus-inspector-window__metrics'});
      for(const [label,value] of [['Connections',connectionCount],['Representations',Array.isArray(row.representations)?row.representations.length:0],['Derived refs',Array.isArray(row.artifactIds)?row.artifactIds.length:0]]){
        const metric=element(doc,'div',{className:'nexus-inspector-window__metric'});metric.append(element(doc,'strong',{text:String(value)}),element(doc,'span',{text:label}));metrics.append(metric);
      }
      surface.append(metrics);
    }else if(isHub){
      const facts=createKeyValue(doc,[
        {key:'Grouping',value:selectedNode.presentationOnly?'Presentation-only cluster':'Published semantic category'},
        {key:'Sources',value:selectedNode.count??0},{key:'Node ID',value:selectedNode.id},{key:'Connections',value:connectionCount},
      ]);
      facts.classList?.add?.('nexus-inspector-window__facts');surface.append(facts);
    }else{
      const parent=(graph.nodes??[]).find(item=>item.id===selectedNode.parentId);
      const facts=createKeyValue(doc,[
        {key:'Parent UID',value:parent?.payload?.uid??parent?.id??'NO_EVIDENCE'},{key:'Parent source',value:parent?.label??'NO_EVIDENCE'},
        {key:'Derived refs',value:selectedNode.count??0},{key:'Owner state',value:selectedNode.state??'NO_EVIDENCE'},
      ]);
      facts.classList?.add?.('nexus-inspector-window__facts');surface.append(facts);
    }

    const tabBar=element(doc,'div',{className:'nexus-inspector-window__tabs',attrs:{role:'tablist','aria-label':'Inspector context'}});
    const allowed=[
      ['connections','Connections',true,connectionCount],
      ['scene','Scene Intelligence',isSource,null],
      ['details','Details',true,null],
    ];
    const current=allowed.some(([id,,enabled])=>enabled&&id===renderState?.rightDrawerView)?renderState.rightDrawerView:'connections';
    if(current!==renderState?.rightDrawerView)renderState.rightDrawerView=current;
    for(const [id,label,enabled,badge] of allowed){
      const btn=element(doc,'button',{className:'nexus-inspector-window__tab',attrs:{type:'button',role:'tab','aria-selected':String(current===id),disabled:enabled?null:'disabled'},dataset:{active:String(current===id),view:id}});
      btn.append(element(doc,'span',{text:label}));
      if(badge!=null)btn.append(element(doc,'span',{className:'nexus-inspector-window__tab-count',text:String(badge)}));
      scope?.listen?.(btn,'click',()=>{if(enabled){renderState.rightDrawerView=id;renderState.rightDrawerOpen=true;refresh?.();}});
      tabBar.append(btn);
    }
    surface.append(tabBar);

    const content=element(doc,'div',{className:'nexus-inspector-window__content',dataset:{view:current}});
    if(current==='connections'){
      const lookup=new Map([['core',{label:'World core',kind:'Core'}],...(graph.hubs??[]).map(item=>[item.id,{label:item.label,kind:'Cluster'}]),...(graph.nodes??[]).map(item=>[item.id,{label:item.label,kind:'Source UID'}]),...(graph.artifacts??[]).map(item=>[item.id,{label:item.label,kind:'Derived'}])]);
      const direct=(graph.edges??[]).filter(edge=>edge.fromId===selectedNode.id||edge.toId===selectedNode.id).slice(0,28);
      if(direct.length){
        const list=element(doc,'div',{className:'nexus-inspector-window__connection-list'});
        for(const edge of direct){
          const otherId=edge.fromId===selectedNode.id?edge.toId:edge.fromId,other=lookup.get(otherId)??{label:otherId,kind:'Node'};
          const relation=element(doc,'div',{className:'nexus-inspector-window__connection',dataset:{tone:edge.tone??selectedNode.tone??'cyan'}});
          relation.append(element(doc,'span',{className:'nexus-inspector-window__connection-orb'}),element(doc,'div',{className:'nexus-inspector-window__connection-copy'}));
          const copy=relation.children?.[1];copy?.append?.(element(doc,'strong',{text:other.label}),element(doc,'span',{text:other.kind}));
          list.append(relation);
        }
        content.append(list);
      }else content.append(element(doc,'p',{className:'nexus-muted',text:'No direct graph connections are published for this selection.'}));
    }else if(current==='scene'){
      if(isSource){
        const sceneFacts=createKeyValue(doc,[
          {key:'Narrative role',value:'Not yet published'},{key:'Active thread',value:'Not yet published'},
          {key:'Scene relevance',value:'Not yet published'},{key:'Relationship impact',value:'Not yet published'},
        ]);
        content.append(sceneFacts,element(doc,'p',{className:'nexus-muted',text:'Scene Intelligence will populate this from its own evidence stream. Lore text is not used to invent scene state.'}));
      }else content.append(element(doc,'p',{className:'nexus-muted',text:'Scene Intelligence applies to selectable source UIDs.'}));
    }else{
      content.append(createKeyValue(doc,[
        {key:'Node ID',value:selectedNode.id},{key:'Kind',value:isSource?'Source UID':isHub?'World category':'Derived artifact'},
        {key:'Tone',value:selectedNode.tone??'cyan'},{key:'Depth',value:selectedNode.depth??'—'},
        {key:'World revision',value:data?.revision??'—'},
      ]));
    }
    surface.append(content);
  }else{
    const empty=element(doc,'div',{className:'nexus-inspector-window__empty'});
    empty.append(element(doc,'span',{className:'nexus-inspector-window__empty-orb'}),element(doc,'strong',{text:'Select a World Tree node'}),element(doc,'span',{text:'UID details, graph connections, and Scene Intelligence will appear here.'}));
    surface.append(empty);
  }

  rail.append(handle,surface);
  return rail;
}

const SEMANTIC_TONES=['violet','green','blue','amber','magenta','teal','cyan'];
const MAX_VISIBLE_SOURCE_NODES=54;
const TARGET_NODES_PER_HUB=8;
const CENTER_TRUNK_START_MS=650;
const HUB_BLOOM_START_MS=1750;
const SOURCE_INNER_START_MS=3200;
const SOURCE_RING_GAP_MS=900;
const SOURCE_SLOT_GAP_MS=220;
const ARTIFACT_LAG_MS=1150;

function buildLoreGraph({entries,data,selected}={}){
  const allVisible=entries.filter(row=>String(row.operatorState??'')!=='REMOVED');
  const visible=stableLoreSources(allVisible).slice(0,MAX_VISIBLE_SOURCE_NODES);
  const exactByUid=exactSourceMap(selected?.snapshot);
  const decorated=visible.map((row,index)=>{
    const exact=exactByUid.get(String(row.uid??index))??null;
    const canonicalParent=['LORE_GROUP','LORE_SOURCE'].includes(String(row?.worldParentKind??'').toUpperCase())?String(row?.worldParentLabel??'').trim():null;
    return{
      row,index,exact,
      category:canonicalParent||publishedSemanticCategory(exact),
      groupKey:canonicalParent?String(row.worldParentId??canonicalParent):null,
      label:publishedSourceTitle(exact,row.title??row.label??row.uid??row.sourceId??'Lore source'),
    };
  });
  const revisions=[...new Set(decorated.map(item=>Number(item.row?.createdRevision)).filter(value=>Number.isFinite(value)&&value>0))].sort((a,b)=>a-b);
  const growthRank=new Map(revisions.map((revision,index)=>[revision,index]));
  const replayDelayFor=row=>{
    const revision=Number(row?.createdRevision),rank=growthRank.get(revision);
    return Number.isFinite(rank)?900+rank*180:null;
  };

  const semantic=decorated.some(item=>item.category);
  const grouped=semantic?semanticTopologyGroups(decorated,Boolean(data?.canonicalWorldNodes)):neutralTopologyGroups(decorated);
  const hubs=[],nodes=[],artifacts=[],edges=[],center={x:500,y:380};
  const hubRadius=grouped.length<=2?220:grouped.length<=4?240:258;

  grouped.forEach((group,index)=>{
    const angle=(-Math.PI/2)+(index/Math.max(1,grouped.length))*Math.PI*2;
    const tone=group.tone??SEMANTIC_TONES[index%SEMANTIC_TONES.length];
    const hub={
      id:group.id,state:group.kind==='semantic'?'SEMANTIC':'STRUCTURE',tone,label:group.label,count:group.items.length,
      canonicalNodeId:group.canonicalNodeId??null,
      presentationOnly:group.kind!=='semantic',wave:index,
      x:center.x+Math.cos(angle)*hubRadius,y:center.y+Math.sin(angle)*hubRadius,
      depth:1,
      delay:Math.max(500,Math.min(...group.items.map(item=>replayDelayFor(item.row)??HUB_BLOOM_START_MS))-260),
      incrementalDelay:100+(index%3)*90,
    };
    hubs.push(hub);
    edges.push({
      id:'edge:hub:'+hub.id,from:center,to:hub,fromId:'core',toId:hub.id,state:hub.state,tone,kind:'hub',wave:index,depth:0,
      delay:CENTER_TRUNK_START_MS,incrementalDelay:40+(index%3)*70,
    });

    group.items.forEach((item,rowIndex)=>{
      const row=item.row,sourceState=String(row.operatorState??'ACCEPTED');
      const ring=Math.floor(rowIndex/4),slot=rowIndex%4,ringSize=Math.min(4,group.items.length-ring*4);
      const slotOffset=ringSize<=1?0:(slot/(ringSize-1)-.5)*Math.min(1.18,.46+ringSize*.13);
      const nodeAngle=angle+slotOffset;
      const hash=hashText(String(row.uid??row.sourceId??rowIndex)),jitter=(hash%13)-6;
      const radius=76+ring*44+jitter;
      const artifactCount=Number(row.artifactIds?.length??0);
      const nodeDepth=2+ring;
      const nodeDelay=replayDelayFor(row)??(SOURCE_INNER_START_MS+ring*SOURCE_RING_GAP_MS+slot*SOURCE_SLOT_GAP_MS);
      const incrementalNodeDelay=180+(ring*4+slot%4)*62;
      const node={
        id:String(row.sourceId??row.uid??sourceState+':'+rowIndex),label:item.label,state:sourceState,tone,category:item.category,sourceMeta:item.exact??null,wave:index,hubId:hub.id,depth:nodeDepth,
        x:hub.x+Math.cos(nodeAngle)*radius,y:hub.y+Math.sin(nodeAngle)*radius,
        artifactCount,delay:nodeDelay,incrementalDelay:incrementalNodeDelay,payload:row,
      };
      nodes.push(node);
      edges.push({
        id:'edge:source:'+node.id,from:hub,to:node,fromId:hub.id,toId:node.id,state:sourceState,tone,kind:'source',wave:index,depth:nodeDepth-1,
        delay:Math.max(HUB_BLOOM_START_MS+420,nodeDelay-360),
        incrementalDelay:Math.max(80,incrementalNodeDelay-90),
      });

      if(artifactCount>0){
        const artifactAngle=nodeAngle+(rowIndex%2===0?.30:-.30),artifactRadius=30+Math.min(10,Math.log2(artifactCount+1)*2);
        const artifact={
          id:'artifact-group:'+node.id,
          label:artifactCount===1?String(row.artifactIds?.[0]??'derived artifact'):String(artifactCount)+' derived refs',
          count:artifactCount,state:sourceState,tone,wave:index,hubId:hub.id,parentId:node.id,depth:nodeDepth+1,
          x:node.x+Math.cos(artifactAngle)*artifactRadius,y:node.y+Math.sin(artifactAngle)*artifactRadius,
          delay:node.delay+ARTIFACT_LAG_MS,incrementalDelay:node.incrementalDelay+190,
        };
        artifacts.push(artifact);
        edges.push({
          id:'edge:artifact:'+artifact.id,from:node,to:artifact,fromId:node.id,toId:artifact.id,state:sourceState,tone,kind:'artifact',wave:index,depth:nodeDepth,
          delay:artifact.delay-240,incrementalDelay:artifact.incrementalDelay-75,
        });
      }
    });
  });

  return{
    hubs,nodes,artifacts,edges,semantic,
    totalSourceCount:allVisible.length,
    visibleSourceCount:visible.length,
    presentationClusterCount:grouped.filter(group=>group.kind!=='semantic').length,
  };
}

function stableLoreSources(rows=[]){
  return [...rows].sort((a,b)=>{
    const aRevision=Number(a?.createdRevision),bRevision=Number(b?.createdRevision);
    const aHas=Number.isFinite(aRevision)&&aRevision>0,bHas=Number.isFinite(bRevision)&&bRevision>0;
    if(aHas&&bHas&&aRevision!==bRevision)return aRevision-bRevision;
    if(aHas!==bHas)return aHas?-1:1;
    const aKey=String(a?.uid??a?.sourceId??''),bKey=String(b?.uid??b?.sourceId??'');
    const hashDelta=hashText(aKey)-hashText(bKey);
    return hashDelta||aKey.localeCompare(bKey);
  });
}
function semanticToneForCategory(category,index=0){
  const value=String(category??'').trim().toLowerCase();
  if(/character|person|npc|actor/.test(value))return'violet';
  if(/faction|guild|organization|organisation|group|house/.test(value))return'blue';
  if(/place|location|region|world|city|floor|dungeon/.test(value))return'green';
  if(/event|incident|battle|quest/.test(value))return'amber';
  if(/timeline|time|era|date|history/.test(value))return'magenta';
  if(/memory|memory shard|recollection/.test(value))return'cyan';
  if(/concept|idea|rule|system/.test(value))return'violet';
  return SEMANTIC_TONES[index%SEMANTIC_TONES.length];
}

export function applyCanonicalWorldHierarchy(graph,data){
  const world=new Map((data?.canonicalWorldNodes??[]).map(n=>[n.id,n]));if(!world.size)return;
  const hubs=new Map(graph.hubs.filter(h=>h.canonicalNodeId).map(h=>[h.canonicalNodeId,h]));
  for(const node of world.values())if(node.kind==='LORE_GROUP'&&!hubs.has(node.id)){
    const hub={id:'hub:canonical:'+node.id,canonicalNodeId:node.id,label:node.label??node.data?.label??node.id,count:0,x:500,y:400,kind:'semantic',items:[],tone:semanticToneForCategory(node.label,hubs.size),state:'READY',wave:0};
    hubs.set(node.id,hub);graph.hubs.push(hub);
  }
  for(const hub of [...hubs.values()]){
    const seen=new Set();let parent=world.get(hub.canonicalNodeId)?.parentId;
    while(parent&&parent!=='world:nexus'&&!seen.has(parent)){
      seen.add(parent);const node=world.get(parent);if(!node)break;
      if(!hubs.has(parent)){
        const ancestor={...hub,id:'hub:canonical:'+parent,canonicalNodeId:parent,label:node.label,count:0,x:500,y:400};
        hubs.set(parent,ancestor);graph.hubs.push(ancestor);
      }
      parent=node.parentId;
    }
  }
  const core=graph.edges.find(e=>e.kind==='hub')?.from??{x:500,y:400};
  graph.edges=graph.edges.filter(e=>e.kind!=='hub');
  for(const hub of graph.hubs){
    const parent=hubs.get(world.get(hub.canonicalNodeId)?.parentId)??core;
    graph.edges.push({id:'edge:hub:'+hub.id,from:parent,to:hub,fromId:parent.id??'core',toId:hub.id,kind:'hub',tone:hub.tone,state:hub.state,depth:0,delay:0,wave:hub.wave});
  }
}

function semanticTopologyGroups(items=[],canonical=false){
  const byCategory=new Map();
  for(const item of items){
    const label=item.category??'Other Lore';
    const key=item.groupKey??String(label);
    if(!byCategory.has(key))byCategory.set(key,{label,rows:[]});
    byCategory.get(key).rows.push(item);
  }
  let categories=[...byCategory.entries()].sort((a,b)=>b[1].rows.length-a[1].rows.length||String(a[1].label).localeCompare(String(b[1].label)));
  if(!canonical&&categories.length>7){
    const keep=categories.slice(0,6),other=categories.slice(6).flatMap(([,entry])=>entry.rows);
    categories=[...keep,['other-lore',{label:'Other Lore',rows:other}]];
  }
  const groups=[];
  categories.forEach(([groupKey,entry],categoryIndex)=>{
    const category=entry.label,rows=entry.rows;
    const chunks=canonical?[rows]:chunkTopologyRows(rows,TARGET_NODES_PER_HUB);
    chunks.forEach((chunk,chunkIndex)=>{
      const suffix=chunks.length>1?' · '+String(chunkIndex+1):'';
      groups.push({
        id:'hub:category:'+groupKey+':'+chunkIndex,
        canonicalNodeId:canonical?groupKey:null,
        kind:'semantic',
        label:String(category)+suffix,
        tone:semanticToneForCategory(category,categoryIndex),
        items:chunk,
      });
    });
  });
  return groups;
}
function neutralTopologyGroups(items=[]){
  if(!items.length)return[];
  const desired=Math.max(1,Math.min(8,Math.ceil(items.length/TARGET_NODES_PER_HUB)));
  const groupSize=Math.ceil(items.length/desired),groups=[];
  for(let index=0;index<desired;index++){
    const chunk=items.slice(index*groupSize,(index+1)*groupSize);
    if(!chunk.length)continue;
    groups.push({
      id:'hub:structure:'+index,
      kind:'structure',
      label:'Cluster '+String(index+1),
      tone:SEMANTIC_TONES[index%SEMANTIC_TONES.length],
      items:chunk,
    });
  }
  return groups;
}
function chunkTopologyRows(rows=[],maxSize=TARGET_NODES_PER_HUB){
  const result=[];
  for(let index=0;index<rows.length;index+=maxSize)result.push(rows.slice(index,index+maxSize));
  return result;
}
function presentationClusterCount(entries=[]){
  const count=Math.min(MAX_VISIBLE_SOURCE_NODES,entries.filter(row=>String(row?.operatorState??'')!=='REMOVED').length);
  return count?Math.max(1,Math.min(8,Math.ceil(count/TARGET_NODES_PER_HUB))):0;
}

function exactSourceMap(snapshot){
  return new Map((snapshot?.entries??[]).map((entry,index)=>[String(entry?.uid??index),entry]));
}
function sourceTreePath(entry){
  const value=entry?.metadata?.treePath??entry?.treePath??entry?.metadata?.path??null;
  if(Array.isArray(value))return value.filter(Boolean).map(x=>String(x).trim()).filter(Boolean).slice(0,8);
  if(typeof value==='string')return value.split(/[\\/>]+/).map(x=>x.trim()).filter(Boolean).slice(0,8);
  return[];
}
function publishedSemanticCategory(entry){
  const explicit=entry?.metadata?.category??entry?.category??entry?.metadata?.type??entry?.type??null;
  const value=explicit??sourceTreePath(entry)[0]??null;
  return value?String(value).trim().slice(0,28):null;
}
function publishedSourceTitle(entry,fallback){
  return shortLabel(entry?.title??entry?.comment??entry?.name??entry?.metadata?.title??entry?.metadata?.name??fallback);
}
function publishedSourceImage(entry){
  const value=entry?.image??entry?.avatar??entry?.thumbnail??entry?.metadata?.image??entry?.metadata?.avatar??entry?.metadata?.thumbnail??null;
  if(typeof value!=='string')return null;
  const normalized=value.trim();
  if(!normalized||/^(?:javascript|vbscript):/i.test(normalized))return null;
  return /^(?:https?:|data:image\/|blob:|\/|\.\.?\/)/i.test(normalized)?normalized:null;
}
function shortGraphRevision(value){
  if(value==null||value==='')return'NO_EVIDENCE';
  const text=String(value);
  if(text.length<=20)return text;
  const split=text.indexOf(':');
  if(split>0&&split<14){
    const prefix=text.slice(0,split+1),id=text.slice(split+1);
    return prefix+id.slice(0,8)+'…'+id.slice(-4);
  }
  return text.slice(0,10)+'…'+text.slice(-5);
}
function semanticCategoryCounts(snapshot,entries=[]){
  const exactByUid=exactSourceMap(snapshot),counts=new Map();
  entries.forEach((row,index)=>{
    const category=publishedSemanticCategory(exactByUid.get(String(row?.uid??index)));
    if(category)counts.set(category,(counts.get(category)??0)+1);
  });
  return[...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
}

function growthState(state,selected,graph){
  const key=String(selected?.snapshot?.id??selected?.selection?.lorebookId??'unselected');
  if(!state)return{
    initialBuild:true,
    newHubs:new Set(graph.hubs.map(row=>row.id)),newNodes:new Set(graph.nodes.map(row=>row.id)),
    newArtifacts:new Set(graph.artifacts.map(row=>row.id)),newEdges:new Set(graph.edges.map(row=>row.id)),
  };
  let reset=false;
  if(state.animationInitialized!==true){
    state.animationInitialized=true;reset=true;state.revealPassesRemaining=REVEAL_RENDER_PASSES;
    state.seenHubs?.clear?.();state.seenNodes?.clear?.();state.seenArtifacts?.clear?.();state.seenEdges?.clear?.();
  }
  if(state.lorebookKey!==key){
    state.lorebookKey=key;reset=true;state.revealPassesRemaining=REVEAL_RENDER_PASSES;
    state.seenHubs?.clear?.();state.seenNodes?.clear?.();state.seenArtifacts?.clear?.();state.seenEdges?.clear?.();
  }
  const hadGraph=Boolean(state.seenHubs?.size||state.seenNodes?.size||state.seenEdges?.size);
  const classify=(rows,seen)=>{const fresh=new Set();for(const row of rows){if(!seen.has(row.id))fresh.add(row.id);seen.add(row.id);}trimSeen(seen,192);return fresh;};
  const revealAll=Number(state.revealPassesRemaining??0)>0;
  const reveal=(rows,seen)=>{const fresh=revealAll?new Set(rows.map(row=>row.id)):classify(rows,seen);for(const row of rows)seen.add(row.id);trimSeen(seen,192);return fresh;};
  const result={
    initialBuild:revealAll||reset||!hadGraph,
    newHubs:reveal(graph.hubs,state.seenHubs),
    newNodes:reveal(graph.nodes,state.seenNodes),
    newArtifacts:reveal(graph.artifacts,state.seenArtifacts),
    newEdges:reveal(graph.edges,state.seenEdges),
  };
  if(revealAll)state.revealPassesRemaining=Math.max(0,Number(state.revealPassesRemaining)-1);
  return result;
}
function settleGrowthReveal(state,graph){
  if(!state)return false;
  state.animationInitialized=true;
  state.revealPassesRemaining=0;
  for(const [rows,seen] of [[graph?.hubs,state.seenHubs],[graph?.nodes,state.seenNodes],[graph?.artifacts,state.seenArtifacts],[graph?.edges,state.seenEdges]]){
    for(const row of rows??[])seen?.add?.(row.id);
    if(seen)trimSeen(seen,192);
  }
  return true;
}
function animationDelay(row,growth){
  return Number(growth?.initialBuild?row?.delay:row?.incrementalDelay) || 0;
}
function nativeAnimate(doc,{attributeName,from,to,begin=0,dur=400}={}){
  return createNexusSvgAnimation(doc,{attributeName,from,to,begin,dur});
}
function startNativeAnimations(root){
  return startNexusSvgAnimations(root,{document:root?.ownerDocument??globalThis.document??null});
}
function scheduleNativeAnimations(root,doc){
  const start=()=>startNativeAnimations(root);
  const enqueue=doc?.defaultView?.queueMicrotask??globalThis.queueMicrotask;
  if(typeof enqueue==='function'){enqueue(start);return true;}
  Promise.resolve().then(start);
  return true;
}
function readSvgAttr(node,key){
  try{return node?.getAttribute?.(key)??node?.attributes?.[key]??null;}catch{return node?.attributes?.[key]??null;}
}
function prefersReducedMotion(doc){
  try{
    const view=doc?.defaultView??globalThis;
    return Boolean(view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  }catch{return false;}
}

function trimSeen(set,max){while(set.size>max)set.delete(set.values().next().value);}

function canvasFooter(doc,text){
  const footer=element(doc,'footer',{className:'nexus-lore-neural-canvas-footer'});
  footer.append(element(doc,'span',{text:'◉ Click bubble = glow / inspect'}),element(doc,'span',{text:'Drag background = pan · Drag bubble = move · Wheel = zoom'}),element(doc,'span',{text}));
  return footer;
}

function panel(doc,title,subtitle,icon){
  const root=element(doc,'section',{className:'nexus-lore-neural-panel'}),head=element(doc,'header',{className:'nexus-lore-neural-panel__head'}),copy=element(doc,'div');
  copy.append(element(doc,'h3',{text:title}),element(doc,'p',{className:'nexus-muted',text:subtitle}));
  head.append(element(doc,'span',{className:'nexus-lore-neural-panel__icon',text:icon}),copy);
  const body=element(doc,'div',{className:'nexus-lore-neural-panel__body'});root.append(head,body);return{root,body};
}

function svgEl(doc,tag,attrs={},children=[]){
  return createNexusSvgElement(doc,tag,attrs,children);
}

function curve(x1,y1,x2,y2){
  const dx=x2-x1,dy=y2-y1,len=Math.max(1,Math.hypot(dx,dy)),nx=-dy/len,ny=dx/len,bend=Math.min(62,len*.19);
  const c1x=x1+dx*.32+nx*bend,c1y=y1+dy*.32+ny*bend;
  const c2x=x1+dx*.68+nx*bend*.55,c2y=y1+dy*.68+ny*bend*.55;
  return'M '+round(x1)+' '+round(y1)+' C '+round(c1x)+' '+round(c1y)+' '+round(c2x)+' '+round(c2y)+' '+round(x2)+' '+round(y2);
}
function round(value){return Math.round(Number(value)*10)/10;}
function shortLabel(value){const s=String(value??'Lore source').replace(/^lore:/i,'').replace(/[_-]+/g,' ');return s.length>28?s.slice(0,25)+'…':s;}
function hashText(value){let h=2166136261;for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
