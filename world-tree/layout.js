function fraction(value){let hash=2166136261;for(const c of String(value)){hash=Math.imul(hash^c.charCodeAt(0),16777619)>>>0;}return hash/4294967296;}
const finite=p=>Number.isFinite(p?.x)&&Number.isFinite(p?.y);
export function planWorldTreeLayout({nodes=[],organization={},relationships=[],previousLayout=null,pins={},seed='nexus',mode='EXTEND'}={}){
  const positions={},branches={},warnings=[],byId=new Map(nodes.map(n=>[n.id,n])),children=new Map(),weights=new Map();
  for(const node of nodes){const parent=node.parentId??null;const list=children.get(parent)??[];list.push(node.id);children.set(parent,list);}
  const weight=(id,seen=new Set())=>{if(seen.has(id))throw Error('Layout organization cycle');if(weights.has(id))return weights.get(id);const next=new Set(seen).add(id);const count=1+(children.get(id)??[]).reduce((sum,child)=>sum+weight(child,next),0);weights.set(id,count);return count;};
  for(const node of nodes)weight(node.id);
  const savedPins={...previousLayout?.pins,...pins};
  for(const [id,pin] of Object.entries(savedPins)){if(!byId.has(id))continue;if(!finite(pin))throw Error(`Invalid pin ${id}`);positions[id]={x:pin.x,y:pin.y};}
  if(mode==='EXTEND')for(const [id,point] of Object.entries(previousLayout?.positions??{}))if(byId.has(id)&&!positions[id]&&finite(point))positions[id]={x:point.x,y:point.y};
  const roots=nodes.filter(n=>!n.parentId||!byId.has(n.parentId)).map(n=>n.id).sort();
  const place=(id,angle,span,depth,parent)=>{
    const variation=fraction(`${seed}:${id}`),distance=depth===0?0:65+Math.sqrt(weights.get(id))*20+variation*24;
    if(!positions[id])positions[id]={x:parent.x+Math.cos(angle)*distance,y:parent.y+Math.sin(angle)*distance};
    branches[id]={angle,span,weight:weights.get(id),depth};
    const list=(children.get(id)??[]).sort(),total=list.reduce((sum,child)=>sum+weights.get(child),0);let cursor=angle-span/2;
    for(const child of list){const childSpan=span*weights.get(child)/total,offset=(fraction(`${seed}:angle:${child}`)-0.5)*childSpan*0.22;place(child,cursor+childSpan/2+offset,Math.min(childSpan,Math.PI*1.3),depth+1,positions[id]);cursor+=childSpan;}
  };
  roots.forEach((id,i)=>place(id,fraction(`${seed}:root`)*Math.PI*2+i*Math.PI*2/Math.max(1,roots.length),Math.PI*2,0,{x:i*220,y:0}));
  const ids=[...byId.keys()].sort(),fixed=new Set(Object.keys(positions).filter(id=>savedPins[id]||(mode==='EXTEND'&&previousLayout?.positions?.[id])));
  // Only newly placed, unpinned nodes move. Work is capped even when geometry is impossible.
  let comparisons=0;
  for(let pass=0;pass<8&&comparisons<200000;pass++){
    let moved=false;
    for(let i=0;i<ids.length&&comparisons<200000;i++)for(let j=i+1;j<ids.length&&comparisons<200000;j++){
      comparisons++;const a=positions[ids[i]],b=positions[ids[j]],dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy);
      if(d>=34||fixed.has(ids[i])&&fixed.has(ids[j]))continue;
      const target=fixed.has(ids[j])?a:b,targetId=fixed.has(ids[j])?ids[i]:ids[j];if(fixed.has(targetId))continue;
      const angle=d?Math.atan2(dy,dx):fraction(`${seed}:overlap:${targetId}`)*Math.PI*2;
      const sign=target===a?-1:1;target.x+=Math.cos(angle)*(35-d)*sign;target.y+=Math.sin(angle)*(35-d)*sign;moved=true;
    }
    if(!moved)break;
  }
  for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length&&warnings.length<64;j++)if(Math.hypot(positions[ids[i]].x-positions[ids[j]].x,positions[ids[i]].y-positions[ids[j]].y)<34)warnings.push({kind:'OVERLAP',nodes:[ids[i],ids[j]]});
  if(comparisons>=200000)warnings.push({kind:'COLLISION_CHECK_BOUNDED'});
  return {positions,branches,pins:Object.fromEntries(Object.entries(savedPins).filter(([id])=>byId.has(id))),coverage:{total:nodes.length,placed:Object.keys(positions).length,complete:Object.keys(positions).length===nodes.length},warnings,seed};
}
