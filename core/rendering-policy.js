const SVG_NS='http://www.w3.org/2000/svg';
const STYLE_ID='nexus-extension-rendering-policy';
export const NexusMotionMode=Object.freeze({SYSTEM:'SYSTEM',FULL:'FULL',REDUCED:'REDUCED'});
const MODES=new Set(Object.values(NexusMotionMode));
let currentMode=NexusMotionMode.SYSTEM;
let installed=false;
let lastSnapshot=null;

function normalizeMode(value){
  const mode=String(value??NexusMotionMode.SYSTEM).toUpperCase();
  return MODES.has(mode)?mode:NexusMotionMode.SYSTEM;
}

function prefersReducedMotion(view=globalThis){
  try{return Boolean(view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);}catch{return false;}
}

function probeCapabilities(document=globalThis.document??null){
  let svgSupported=false,smilSupported=false;
  try{
    const svg=document?.createElementNS?.(SVG_NS,'svg');
    svgSupported=Boolean(svg&&String(svg.namespaceURI||SVG_NS)===SVG_NS);
    const animate=document?.createElementNS?.(SVG_NS,'animate');
    smilSupported=Boolean(animate&&(typeof animate.beginElement==='function'||typeof animate.beginElementAt==='function'));
  }catch{}
  let cssAnimationSupported=true;
  try{cssAnimationSupported=globalThis.CSS?.supports?.('animation-name','nexus-policy-probe')!==false;}catch{}
  return{svgSupported,smilSupported,cssAnimationSupported};
}

function resolveState(document=globalThis.document??null){
  const view=document?.defaultView??globalThis;
  const systemReduced=prefersReducedMotion(view);
  const mode=normalizeMode(currentMode);
  const reduced=mode===NexusMotionMode.REDUCED||(mode===NexusMotionMode.SYSTEM&&systemReduced);
  const capabilities=probeCapabilities(document);
  return Object.freeze({
    kind:'NexusRenderingPolicy',
    contractVersion:'1.0.0',
    installed,
    motionMode:mode,
    reducedMotion:reduced,
    animationsEnabled:!reduced&&capabilities.cssAnimationSupported,
    nativeSvgAnimationsEnabled:!reduced&&capabilities.svgSupported&&capabilities.smilSupported,
    svg:Object.freeze({namespace:SVG_NS,supported:capabilities.svgSupported}),
    smil:Object.freeze({supported:capabilities.smilSupported}),
    cssAnimations:Object.freeze({supported:capabilities.cssAnimationSupported}),
    accessibility:Object.freeze({respectsSystemReducedMotion:mode===NexusMotionMode.SYSTEM,systemReducedMotion:systemReduced}),
  });
}

function applyDocumentState(document,snapshot){
  const root=document?.documentElement;
  if(root){
    root.setAttribute?.('data-nexus-rendering-policy','active');
    root.setAttribute?.('data-nexus-motion-mode',String(snapshot.motionMode).toLowerCase());
    root.setAttribute?.('data-nexus-motion',snapshot.reducedMotion?'reduced':'full');
    root.setAttribute?.('data-nexus-svg',snapshot.svg.supported?'native':'unavailable');
    root.setAttribute?.('data-nexus-smil',snapshot.smil.supported?'native':'unavailable');
  }
  if(!document?.createElement||!document?.head)return;
  let style=document.getElementById?.(STYLE_ID);
  if(!style){
    style=document.createElement('style');
    style.id=STYLE_ID;
    style.setAttribute?.('data-nexus-policy','rendering');
    style.textContent=`
html[data-nexus-rendering-policy="active"] [data-nexus-rendering-surface] svg{shape-rendering:geometricPrecision;text-rendering:geometricPrecision}
html[data-nexus-motion="reduced"] [data-nexus-rendering-surface] *,html[data-nexus-motion="reduced"] [data-nexus-rendering-surface] *::before,html[data-nexus-motion="reduced"] [data-nexus-rendering-surface] *::after{scroll-behavior:auto!important;transition-duration:0.001ms!important;animation-duration:0.001ms!important;animation-iteration-count:1!important}
@media (prefers-reduced-motion: reduce){
  html[data-nexus-motion-mode="system"] [data-nexus-rendering-surface] *,html[data-nexus-motion-mode="system"] [data-nexus-rendering-surface] *::before,html[data-nexus-motion-mode="system"] [data-nexus-rendering-surface] *::after{scroll-behavior:auto!important;transition-duration:0.001ms!important;animation-duration:0.001ms!important;animation-iteration-count:1!important}
}
`;
    document.head.append?.(style);
  }
}

function publishGlobal(){
  const api={
    SVG_NS,
    MotionMode:NexusMotionMode,
    snapshot:getNexusRenderingPolicy,
    setMotionMode:setNexusMotionMode,
    markSurface:markNexusRenderingSurface,
    createSvgElement:createNexusSvgElement,
    createSvgAnimation:createNexusSvgAnimation,
    startSvgAnimations:startNexusSvgAnimations,
  };
  try{globalThis.NexusRenderingPolicy=Object.freeze(api);}catch{}
}

export function installNexusRenderingPolicy({document=globalThis.document??null,motionMode=NexusMotionMode.SYSTEM}={}){
  currentMode=normalizeMode(motionMode);
  installed=true;
  lastSnapshot=resolveState(document);
  applyDocumentState(document,lastSnapshot);
  publishGlobal();
  try{
    const media=document?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
    const listener=()=>{lastSnapshot=resolveState(document);applyDocumentState(document,lastSnapshot);};
    media?.addEventListener?.('change',listener);
  }catch{}
  return lastSnapshot;
}

export function getNexusRenderingPolicy({document=globalThis.document??null}={}){
  lastSnapshot=resolveState(document);
  return lastSnapshot;
}

export function setNexusMotionMode(mode,{document=globalThis.document??null}={}){
  currentMode=normalizeMode(mode);
  lastSnapshot=resolveState(document);
  applyDocumentState(document,lastSnapshot);
  return lastSnapshot;
}

export function markNexusRenderingSurface(node){
  node?.setAttribute?.('data-nexus-rendering-surface','true');
  return node;
}

export function createNexusSvgElement(document,tag,attrs={},children=[]){
  if(!document)throw new TypeError('Nexus SVG creation requires a document');
  const node=typeof document.createElementNS==='function'?document.createElementNS(SVG_NS,String(tag)):document.createElement(String(tag));
  for(const [key,value] of Object.entries(attrs??{}))if(value!=null)node.setAttribute?.(key,String(value));
  for(const child of children??[])if(child!=null)node.append?.(child);
  return node;
}

export function createNexusSvgAnimation(document,{attributeName,from,to,begin=0,dur=400,fill='freeze'}={}){
  const node=createNexusSvgElement(document,'animate',{
    attributeName:String(attributeName),
    from:String(from),
    to:String(to),
    begin:'indefinite',
    dur:String(Math.max(1,Number(dur)||1))+'ms',
    fill:String(fill||'freeze'),
    'data-nexus-start-ms':String(Math.max(0,Number(begin)||0)),
  });
  return node;
}

export function startNexusSvgAnimations(root,{document=root?.ownerDocument??globalThis.document??null}={}){
  const policy=getNexusRenderingPolicy({document});
  if(!policy.nativeSvgAnimationsEnabled)return 0;
  const animations=[];
  const visit=node=>{
    for(const child of node?.children??[]){
      if(String(child?.tagName??'').toLowerCase()==='animate'&&child?.getAttribute?.('data-nexus-start-ms')!=null)animations.push(child);
      visit(child);
    }
  };
  visit(root);
  for(const animation of animations){
    const offsetMs=Math.max(0,Number(animation.getAttribute?.('data-nexus-start-ms'))||0);
    try{
      if(typeof animation.beginElementAt==='function')animation.beginElementAt(offsetMs/1000);
      else if(typeof animation.beginElement==='function'&&offsetMs===0)animation.beginElement();
    }catch{}
  }
  return animations.length;
}
