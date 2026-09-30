function rotr(x,n){return(x>>>n)|(x<<(32-n));}
const K=[
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
// UTF-8 as the original code-point loop produced it: well-formed text through TextEncoder (identical bytes), and text with
// a lone surrogate through the loop, which encodes the surrogate as three bytes where TextEncoder would substitute U+FFFD.
// Hashes are persisted identities, so both paths must give the bytes the loop always gave (asserted by tests).
const utf8Encoder=typeof TextEncoder==='function'?new TextEncoder():null;
const LONE_SURROGATE=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function isWellFormed(text){return typeof text.isWellFormed==='function'?text.isWellFormed():!LONE_SURROGATE.test(text);}
function codePointUtf8(text){const out=[];for(const ch of text){const cp=ch.codePointAt(0);if(cp<=0x7f)out.push(cp);else if(cp<=0x7ff)out.push(0xc0|(cp>>6),0x80|(cp&0x3f));else if(cp<=0xffff)out.push(0xe0|(cp>>12),0x80|((cp>>6)&0x3f),0x80|(cp&0x3f));else out.push(0xf0|(cp>>18),0x80|((cp>>12)&0x3f),0x80|((cp>>6)&0x3f),0x80|(cp&0x3f));}return out;}
function encodeUtf8(value){const text=String(value);return utf8Encoder&&isWellFormed(text)?utf8Encoder.encode(text):Uint8Array.from(codePointUtf8(text));}
export function utf8Bytes(value){return Array.from(encodeUtf8(value));}
export function utf8ByteLength(value){return encodeUtf8(value).length;}
export function sha256Hex(value){const input=encodeUtf8(value);const len=input.length,bitLen=len*8,total=Math.ceil((len+9)/64)*64,bytes=new Uint8Array(total);bytes.set(input);bytes[len]=0x80;const hi=Math.floor(bitLen/0x100000000),lo=bitLen>>>0;for(let i=0;i<4;i++){bytes[total-8+i]=(hi>>>((3-i)*8))&0xff;bytes[total-4+i]=(lo>>>((3-i)*8))&0xff;}let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;const w=new Uint32Array(64);for(let offset=0;offset<bytes.length;offset+=64){for(let i=0;i<16;i++){const j=offset+i*4;w[i]=((bytes[j]<<24)|(bytes[j+1]<<16)|(bytes[j+2]<<8)|bytes[j+3])>>>0;}for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2],s0=rotr(x,7)^rotr(x,18)^(x>>>3),s1=rotr(y,17)^rotr(y,19)^(y>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;for(let i=0;i<64;i++){const S1=rotr(e,6)^rotr(e,11)^rotr(e,25),ch=(e&f)^((~e)&g),t1=(h+S1+ch+K[i]+w[i])>>>0,S0=rotr(a,2)^rotr(a,13)^rotr(a,22),maj=(a&b)^(a&c)^(b&c),t2=(S0+maj)>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;h4=(h4+e)>>>0;h5=(h5+f)>>>0;h6=(h6+g)>>>0;h7=(h7+h)>>>0;}return[h0,h1,h2,h3,h4,h5,h6,h7].map(x=>x.toString(16).padStart(8,'0')).join('');}
export function stableObject(value){if(Array.isArray(value))return value.map(stableObject);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stableObject(value[k])]));return value;}
export function stableJson(value){return JSON.stringify(stableObject(value));}
export function stableHash(value,{length=64,alreadyString=false}={}){const text=alreadyString?String(value):typeof value==='string'?value:stableJson(value);return sha256Hex(text).slice(0,length);}
export function monotonicNow(){const perf=globalThis?.performance;return typeof perf?.now==='function'?perf.now():Date.now();}
