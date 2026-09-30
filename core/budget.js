// Capacity decisions are receipts, never permission to discard the remainder.
const positive=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):fallback;
export function createBudgetManager({emit=()=>{},now=()=>Date.now()}={}){
  const costs=new Map();
  const report=(name,data,level='debug')=>{try{emit('nexus.scatter',name,{...data,jobId:data.id,counts:{allowed:data.allowed,examined:data.examined,total:data.total,deferred:data.deferred},drivers:data.drivers},level);}catch{}};
  return Object.freeze({
    observe(id,{units=1,durationMs=0}={}){
      if(!(units>0)||!(durationMs>=0)||!Number.isFinite(durationMs))return;
      const sample=durationMs/units,prior=costs.get(id);
      costs.set(id,prior==null?sample:prior*0.8+sample*0.2);
    },
    estimate(id,fallback=1){return positive(costs.get(id),positive(fallback,1));},
    beginTurn({deadline=null,now:startedAt=now(),timeMs=1000,promptTokens=4096,worldSize=200}={}){
      const reservations=new Map();
      const clockAtStart=now();
      const availableTime=deadline==null?Math.max(0,Number(timeMs)||0):Math.max(0,Number(deadline)-startedAt);
      return Object.freeze({
        reserve(id,ms){reservations.set(id,Math.max(0,Number(ms)||0));},
        release(id){reservations.delete(id);},
        compute(id,{total,offset=0,defaultUnits=64,defaultWorldSize=200,msPerUnit=1,tokensPerUnit=0,tokenShare=1,multiplier=1,sanityCeiling=1000000}={}){
          if(!Number.isSafeInteger(total)||total<0||!Number.isSafeInteger(offset)||offset<0||offset>total)throw new TypeError('Budget requires a valid total and continuation offset');
          const reserved=[...reservations.entries()].reduce((sum,[key,value])=>sum+(key===id?0:value),0);
          const remainingMs=Math.max(0,availableTime-reserved-Math.max(0,now()-clockAtStart));
          const cost=positive(costs.get(id),positive(msPerUnit,1));
          const scale=Math.sqrt(positive(worldSize,1)/positive(defaultWorldSize,200));
          const desired=Math.max(0,Math.ceil(positive(defaultUnits,64)*scale*Math.max(0,Number(multiplier)||0)));
          const timeUnits=Math.floor(remainingMs/cost);
          const tokenUnits=tokensPerUnit>0?Math.floor(Math.max(0,Number(promptTokens)||0)*Math.max(0,Number(tokenShare)||0)/tokensPerUnit):total;
          const ceiling=Math.floor(positive(sanityCeiling,1000000));
          const requested=Math.min(total-offset,desired,timeUnits,tokenUnits);
          const allowed=Math.min(requested,ceiling),examined=offset+allowed;
          const receipt=Object.freeze({id,allowed,examined,total,deferred:total-examined,complete:examined===total,
            continuation:examined<total?Object.freeze({offset:examined,total}):null,
            ceilingHit:requested>ceiling,drivers:Object.freeze({remainingMs,reservedMs:reserved,msPerUnit:cost,promptTokens,tokenShare,worldSize,multiplier})});
          report('budget.plan',receipt);
          if(receipt.ceilingHit)report('budget.ceiling',{id,total,ceiling,deferred:receipt.deferred},'error');
          return receipt;
        },
      });
    },
  });
}
