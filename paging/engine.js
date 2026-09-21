import { activationDecision, terms } from './policy.js';
import { normalizedVector } from './embeddings.js';

function escapeRegex(value){return String(value||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function explicitAliasMatch(query,alias,foldedQuery){
    const needle=String(alias||'').trim();if([...needle].length<3)return false;
    // Most lore aliases do not occur in this turn. Reject those before compiling
    // thousands of Unicode boundary expressions on the foreground wake path.
    // Upper-then-lower folding is a permissive prefilter (e.g. sigma/long-s);
    // the existing Unicode regex remains the final matching authority.
    if(!foldedQuery.includes(needle.toUpperCase().toLowerCase()))return false;
    const phrase=escapeRegex(needle).replace(/\\s+/g,'\\s+');
    try{return new RegExp(`(^|[^\\p{L}\\p{N}_])${phrase}(?=$|[^\\p{L}\\p{N}_])`,'iu').test(String(query||''));}
    catch{return false;}
}

// Derived state only. Canonical records and their visibility policy are inputs.
export class ResidencyIndex {
    constructor(){this.rows=new Map();this.vectors=new Map();this.residency=new Map();this.active=false;this.activatedAt=0;this.scope='';this.profile='';}
    reset(scope,profile){this.rows.clear();this.vectors.clear();this.residency.clear();this.active=false;this.activatedAt=0;this.scope=scope;this.profile=profile;}
    reconcile(rows,{scope,profile,turns,config,now=Date.now(),activation=null}){
        if(scope!==this.scope||profile!==this.profile)this.reset(scope,profile);
        const old=this.rows;this.rows=new Map(rows.map(r=>[r.id,r]));
        for(const [id,v] of this.vectors)if(!this.rows.has(id)||this.rows.get(id).version!==v.version)this.vectors.delete(id);
        for(const id of this.residency.keys())if(!this.rows.has(id))this.residency.delete(id);
        const decision=activation||activationDecision({turns,records:rows.filter(r=>r.kind==='memory').length,wasActive:this.active,activatedAt:this.activatedAt,now},config);
        if(decision.active&&!this.active)this.activatedAt=now;
        this.active=decision.active;this.reason=decision.reason;
        for(const r of rows){
            let state=this.residency.get(r.id);
            if(!state||old.get(r.id)?.version!==r.version)state={state:'WARM',until:now+config.warmTtlMs,lastUsed:0};
            if(r.protected)state={...state,state:'ACTIVE'};
            else if(state.state==='ACTIVE')state={...state,state:'WARM'};
            this.residency.set(r.id,state);
        }
        this.rebalance(config,now);
        return decision;
    }
    rebalance(c,now=Date.now()){
        let count=0,chars=0;
        const rows=[...this.rows.values()].sort((a,b)=>Number(b.protected)-Number(a.protected)||(this.residency.get(b.id)?.lastUsed||0)-(this.residency.get(a.id)?.lastUsed||0)||b.recency-a.recency);
        for(const r of rows){
            const s=this.residency.get(r.id),eligible=this.vectors.has(r.id)&&['memory','lore'].includes(r.kind)&&!r.protected;
            const keep=!this.active||!eligible||s.until>now||(count<c.residentLimit&&chars+r.text.length<=c.residentChars);
            s.state=r.protected?'ACTIVE':keep?'WARM':'SLEEPING';
            if(s.state!=='SLEEPING'){count++;chars+=r.text.length;}
        }
    }
    pending(c){const dimensions=this.vectors.values().next().value?.vector.length||1;const capacity=Math.max(0,Math.floor(4000000/dimensions)-this.vectors.size);return [...this.rows.values()].filter(r=>!this.vectors.has(r.id)&&r.text.length>0&&r.text.length<=c.maxTextChars).slice(0,Math.min(c.batchSize,capacity));}
    put(id,version,vector){const r=this.rows.get(id);if(!r||r.version!==version)return false;const normalized=normalizedVector(vector);const first=this.vectors.values().next().value;if(first&&first.vector.length!==normalized.length)throw new Error('Embedding model changed dimensions; rebuild the index.');if(!this.vectors.has(id)&&(this.vectors.size+1)*normalized.length>4000000)return false;this.vectors.set(id,{version,vector:normalized});return true;}
    wake(query,vector,c,now=Date.now(),deadline=Infinity,diagnostics=null){
        const q=vector?normalizedVector(vector):null,qterms=new Set(terms(query)),nominations=[];
        const foldedQuery=String(query||'').toUpperCase().toLowerCase();
        if(diagnostics){diagnostics.rowsTotal=this.rows.size;diagnostics.rowsScanned=0;diagnostics.vectorDimensions=q?.length||0;diagnostics.deadlineExceeded=false;}
        for(const r of this.rows.values()){
            if(performance.now()>deadline){if(diagnostics)diagnostics.deadlineExceeded=true;return [];}
            if(diagnostics)diagnostics.rowsScanned+=1;
            const stored=this.vectors.get(r.id);
            const explicit=r.aliases?.some(a=>explicitAliasMatch(query,a,foldedQuery))||qterms.has(r.canonicalId);
            let score=-1;
            if(q&&stored?.version===r.version&&stored.vector.length===q.length)score=stored.vector.reduce((n,v,i)=>n+v*q[i],0);
            if(explicit||score>=c.similarityThreshold)nominations.push({id:r.id,version:r.version,score,reason:explicit?'explicit-reference':'vector-similarity'});
        }
        nominations.sort((a,b)=>Number(b.reason==='explicit-reference')-Number(a.reason==='explicit-reference')||b.score-a.score);
        const seen=new Set();
        const selected=nominations.filter(n=>{const r=this.rows.get(n.id),key=r.kind==='lore'?r.canonicalId:r.id;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,c.wakeLimit);
        for(const n of selected){
            const s=this.residency.get(n.id),previousState=s?.state||null;
            if(!s)continue;
            s.state=this.rows.get(n.id).protected?'ACTIVE':'WARM';s.until=Math.max(s.until,now+c.warmTtlMs);s.wokenAt=now;
            n.previousResidency=previousState;n.newResidency=s.state;n.newlyAwakened=previousState==='SLEEPING'&&s.state!=='SLEEPING';
        }
        return selected;
    }
    warmedIds(c,now=Date.now()){return [...this.residency].filter(([,s])=>s.wokenAt!=null&&s.until>now&&s.state!=='SLEEPING').sort((a,b)=>b[1].wokenAt-a[1].wokenAt).slice(0,c.wakeLimit).map(([id])=>id);}
    used(ids,c,now=Date.now()){for(const id of ids){const s=this.residency.get(id);if(s){s.lastUsed=now;s.until=now+c.warmTtlMs;s.state='ACTIVE';}}}
    snapshot(){const counts={ACTIVE:0,WARM:0,SLEEPING:0};for(const s of this.residency.values())counts[s.state]++;return {scope:this.scope,active:this.active,reason:this.reason,total:this.rows.size,indexed:this.vectors.size,...counts};}
    exportVectors(){return [...this.vectors].map(([id,v])=>({id,...v}));}
    restoreVectors(rows){if(!Array.isArray(rows))return;for(const v of rows.slice(0,10000)){try{this.put(v.id,v.version,v.vector);}catch{/* Corrupt derived entries are ignored and rebuilt. */}}}
}
