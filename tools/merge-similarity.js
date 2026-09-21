const STOPWORDS=new Set(`the a an and or but if then than to of in on at by for with from into onto over under as is are was were be been being it its this that these those he she they them his her their you your we our i me my do does did not no yes can could would should will just very more most much many some any all each every about after before during through between within without here there where when who whom whose which what why how have has had having says said tell told asks asked looks looked turns turned nod nods nodded smile smiles smiled scene turn roleplay character characters entry entries lore lorebook memory summary`.split(/\s+/));
function normalize(v){return String(v??'').toLowerCase().replace(/[’']/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();}
function tokens(v){const raw=normalize(v).match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)||[],out=[];for(const token of raw){if(/^[a-z0-9'_-]+$/i.test(token)){const t=token.toLowerCase();if(t.length>=3&&!STOPWORDS.has(t))out.push(t);continue;}const chars=[...token.toLowerCase()].filter(ch=>/[\p{L}\p{N}]/u.test(ch));if(chars.length<=4){if(chars.length)out.push(chars.join(''));continue;}for(let i=0;i<=chars.length-3&&i<96;i++)out.push(chars.slice(i,i+3).join(''));}return out;}
function countsFromTokens(list){const m=new Map();for(const t of list)m.set(t,(m.get(t)||0)+1);return m;}
function vectorFeatures(value){const list=tokens(value),counts=countsFromTokens(list),set=new Set(list);let norm=0;for(const n of counts.values())norm+=n*n;return {counts,set,norm:Math.sqrt(norm)};}
function cosineFeatures(A,B){if(!A?.counts?.size||!B?.counts?.size||!A.norm||!B.norm)return 0;let dot=0;const small=A.counts.size<=B.counts.size?A.counts:B.counts,big=small===A.counts?B.counts:A.counts;for(const [k,n] of small)dot+=n*(big.get(k)||0);return dot/(A.norm*B.norm);}
function jaccardFeatures(A,B){if(!A?.set?.size||!B?.set?.size)return 0;const small=A.set.size<=B.set.size?A.set:B.set,big=small===A.set?B.set:A.set;let hit=0;for(const x of small)if(big.has(x))hit++;return hit/(A.set.size+B.set.size-hit);}
export function prepareMergeEntry(entry={}){return {uid:Number(entry?.uid),title:String(entry?.title??entry?.comment??''),content:String(entry?.content??''),disable:entry?.disable===true,titleFeatures:vectorFeatures(entry?.title??entry?.comment??''),contentFeatures:vectorFeatures(entry?.content??'')};}
function clamp(v,min=0,max=1){return Math.max(min,Math.min(max,v));}
export function scorePreparedMergePair(a,b,{sameNode=false}={}){
    const A=a?.titleFeatures?a:prepareMergeEntry(a),B=b?.titleFeatures?b:prepareMergeEntry(b);
    const title=Math.max(cosineFeatures(A.titleFeatures,B.titleFeatures),jaccardFeatures(A.titleFeatures,B.titleFeatures));
    const content=(cosineFeatures(A.contentFeatures,B.contentFeatures)*0.78)+(jaccardFeatures(A.contentFeatures,B.contentFeatures)*0.22);
    const nodeBonus=sameNode?0.05:0;
    const score=clamp((title*0.30)+(content*0.65)+nodeBonus);
    return {percent:Math.round(score*1000)/10,titlePercent:Math.round(title*1000)/10,contentPercent:Math.round(content*1000)/10,sameNode:!!sameNode};
}
export function scoreMergePair(a,b,options={}){return scorePreparedMergePair(prepareMergeEntry(a),prepareMergeEntry(b),options);}
function preparedRows(entries){return (entries||[]).map(prepareMergeEntry).filter(e=>Number.isFinite(e.uid)&&!e.disable);}
function compareMergeRows(x,y){return y.percent-x.percent||x.uidA-y.uidA||x.uidB-y.uidB;}
function retainTopK(out,row,cap){
    let lo=0,hi=out.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(compareMergeRows(row,out[mid])<0)hi=mid;else lo=mid+1;}
    out.splice(lo,0,row);
    if(out.length>cap)out.pop();
}
function rankPreparedPairs(rows,{targetUid=null,thresholdPercent=35,limit=25,nodeForUid=null}={}){
    const target=targetUid===null||targetUid===undefined||targetUid===''?null:Number(targetUid);
    const threshold=Math.max(0,Math.min(100,Number(thresholdPercent)||0));
    const cap=Math.max(1,Math.min(500,Number(limit)||25));
    const out=[];
    for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
        const a=rows[i],b=rows[j];if(target!==null&&a.uid!==target&&b.uid!==target)continue;
        const nodeA=typeof nodeForUid==='function'?nodeForUid(a.uid):null,nodeB=typeof nodeForUid==='function'?nodeForUid(b.uid):null;
        const scored=scorePreparedMergePair(a,b,{sameNode:!!nodeA&&nodeA===nodeB});
        if(scored.percent<threshold)continue;
        retainTopK(out,{uidA:a.uid,titleA:a.title,uidB:b.uid,titleB:b.title,nodeA,nodeB,...scored},cap);
    }
    return out;
}
export function rankMergePairs(entries,options={}){return rankPreparedPairs(preparedRows(entries),options);}
export async function rankMergePairsCooperative(entries,options={}){
    const rows=preparedRows(entries);
    const target=options.targetUid===null||options.targetUid===undefined||options.targetUid===''?null:Number(options.targetUid);
    const threshold=Math.max(0,Math.min(100,Number(options.thresholdPercent)||0));
    const cap=Math.max(1,Math.min(500,Number(options.limit)||25));
    const nodeForUid=options.nodeForUid;
    const yieldEvery=Math.max(128,Number(options.yieldEvery)||1024);
    const yieldFn=typeof options.yieldFn==='function'?options.yieldFn:()=>new Promise(resolve=>setTimeout(resolve,0));
    const out=[];let comparisons=0;
    for(let i=0;i<rows.length;i++){
        for(let j=i+1;j<rows.length;j++){
            const a=rows[i],b=rows[j];if(target!==null&&a.uid!==target&&b.uid!==target)continue;
            const nodeA=typeof nodeForUid==='function'?nodeForUid(a.uid):null,nodeB=typeof nodeForUid==='function'?nodeForUid(b.uid):null;
            const scored=scorePreparedMergePair(a,b,{sameNode:!!nodeA&&nodeA===nodeB});
            if(scored.percent>=threshold)retainTopK(out,{uidA:a.uid,titleA:a.title,uidB:b.uid,titleB:b.title,nodeA,nodeB,...scored},cap);
            comparisons++;if(comparisons%yieldEvery===0)await yieldFn();
        }
    }
    return out;
}

export function rankProposalTargets(proposal,{entries=[],thresholdPercent=20,limit=6,nodeForUid=null,proposedNodeId=null}={}){
    const source={
        title:String(proposal?.title??proposal?.comment??''),
        content:String(proposal?.content??''),
    };
    const threshold=Math.max(0,Math.min(100,Number(thresholdPercent)||0));
    const cap=Math.max(1,Math.min(50,Number(limit)||6));
    const rows=[],preparedSource=prepareMergeEntry(source);
    for(const raw of entries||[]){
        const uid=Number(raw?.uid);if(!Number.isFinite(uid)||raw?.disable===true)continue;
        const target={title:String(raw?.title??raw?.comment??''),content:String(raw?.content??'')};
        const targetNode=typeof nodeForUid==='function'?nodeForUid(uid):null;
        const scored=scorePreparedMergePair(preparedSource,prepareMergeEntry(target),{sameNode:!!proposedNodeId&&!!targetNode&&proposedNodeId===targetNode});
        if(scored.percent<threshold)continue;
        rows.push({uid,title:target.title,nodeId:targetNode,...scored});
    }
    rows.sort((a,b)=>b.percent-a.percent||a.uid-b.uid);
    return rows.slice(0,cap);
}
