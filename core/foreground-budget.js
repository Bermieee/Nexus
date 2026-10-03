// Per-session measurements, never durable story state or invented allowances.
export function createForegroundBudgetTracker({now=()=>performance.now()}={}){
  const samples=new Map();
  return{
    async run(id,execute){
      const start=now();
      try{return await execute();}
      finally{const elapsed=Math.max(0,now()-start),rows=samples.get(id)??[];rows.push(elapsed);samples.set(id,rows.slice(-8));}
    },
    reservations(ids=[]){
      return[...new Set(ids)].flatMap(id=>{const rows=samples.get(id);return rows?.length?[{id,ms:rows.reduce((sum,value)=>sum+value,0)/rows.length}]:[];});
    },
  };
}
export function sensoryPromptRoom({contextTokens,outletTokens=0}={}){
  if(contextTokens==null||!Number.isFinite(Number(contextTokens))||Number(contextTokens)<=0)return null;
  const tokens=Number(contextTokens),outlet=Number(outletTokens);
  return{contextTokens:tokens,tokenShare:Number.isFinite(outlet)&&outlet>0?Math.min(1,outlet/tokens):1};
}
