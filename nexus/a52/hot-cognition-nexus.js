import { HotSegmentKind, HotFreshness } from './hot-cognition-contracts.js';

function safe(value){
  try { return structuredClone(value); } catch { return value; }
}

export function projectNexusHotSegments(snapshot){
  if(!snapshot?.segments) return Object.freeze({kind:'NexusHotProjection',segments:{}});
  const wanted=[
    HotSegmentKind.SCENE,
    HotSegmentKind.ACTIVE_CAST,
    HotSegmentKind.CONTINUITY,
    HotSegmentKind.RECENT_EPISODE_TAIL,
    HotSegmentKind.GRAPH_NEIGHBORHOOD,
  ];
  const segments={};
  for(const kind of wanted){
    const segment=snapshot.segments[kind];
    if(!segment) continue;
    segments[kind]=Object.freeze({
      kind,
      revision:segment.revision,
      freshness:segment.freshness,
      value:safe(segment.value),
    });
  }
  return Object.freeze({
    kind:'NexusHotProjection',
    snapshotId:snapshot.snapshotId??null,
    chatNamespace:snapshot.chatNamespace??null,
    hotRevision:snapshot.hotRevision??0,
    sceneRevision:snapshot.sceneRevision??0,
    segments:Object.freeze(segments),
  });
}

export function renderNexusHotNotebook(snapshot,{maxChars=6000}={}){
  const projection=projectNexusHotSegments(snapshot);
  const rows=[];
  const push=(label,kind)=>{
    const segment=projection.segments[kind];
    if(!segment||segment.freshness!==HotFreshness.FRESH||segment.value==null) return;
    const text=typeof segment.value==='string'?segment.value:JSON.stringify(segment.value);
    if(text&&text!=='[]'&&text!=='{}') rows.push(`${label}: ${text}`);
  };
  push('Scene',HotSegmentKind.SCENE);
  push('Active cast',HotSegmentKind.ACTIVE_CAST);
  push('Continuity',HotSegmentKind.CONTINUITY);
  push('Recent episode tail',HotSegmentKind.RECENT_EPISODE_TAIL);
  push('Graph neighborhood',HotSegmentKind.GRAPH_NEIGHBORHOOD);
  if(!rows.length) return '';
  const text='[HOT COGNITION]\n'+rows.join('\n');
  return Array.from(text).slice(0,Math.max(0,Number(maxChars)||0)).join('');
}
