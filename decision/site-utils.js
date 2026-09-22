function stableValue(value){
  if(Array.isArray(value))return value.map(stableValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableValue(value[key])]));
  return value;
}
export function cleanDecisionText(value){return String(value??'').replace(/\r/g,'').trim();}
export function clipDecisionText(value,max=12000){
  const text=cleanDecisionText(value);
  const cap=Math.max(256,Number(max)||12000);
  return text.length<=cap?text:`${text.slice(0,cap)}\n[bounded: ${text.length-cap} chars omitted]`;
}
export function stableDecisionFingerprint(prefix,payload){
  const text=JSON.stringify(stableValue(payload));
  let hash=0x811c9dc5;
  for(let i=0;i<text.length;i+=1){hash^=text.charCodeAt(i);hash=Math.imul(hash,0x01000193)>>>0;}
  return `${String(prefix||'decision')}-${hash.toString(16).padStart(8,'0')}-${text.length}`;
}
export async function resolveDecisionFingerprint(context,prefix,payload){
  if(typeof context?.getCurrentFingerprint==='function')return String(await context.getCurrentFingerprint());
  return stableDecisionFingerprint(prefix,payload);
}
