function clampMs(value,min,max,fallback){
  const n=Number(value);
  return Number.isFinite(n)?Math.max(min,Math.min(max,Math.floor(n))):fallback;
}
function snapshot(value){
  try{return JSON.stringify(value??null);}catch{return String(value??'');}
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/**
 * Wait for foreground-critical work while treating the short deadline as a
 * no-progress watchdog instead of an absolute lifecycle completion deadline.
 * A separate hard cap still guarantees the user's generation cannot hang
 * forever. The caller remains responsible for cancelling unfinished work.
 */
export async function awaitForegroundProgress(workPromise,{
  stallTimeoutMs=15000,
  hardTimeoutMs=60000,
  pollMs=100,
  getProgress=()=>null,
  onProgress=null,
  isActiveWork=null,
  now=()=>Date.now(),
}={}){
  const stallMs=clampMs(stallTimeoutMs,10,60000,15000);
  const hardMs=Math.max(stallMs,clampMs(hardTimeoutMs,stallMs,300000,60000));
  const poll=clampMs(pollMs,1,1000,100);
  const startedAt=now();
  let lastProgressAt=startedAt;
  let progressChanges=0;
  let activeDeferrals=0;
  let lastProgress=snapshot(getProgress());
  let settled=false,value,error;
  Promise.resolve(workPromise).then(v=>{settled=true;value=v;},e=>{settled=true;error=e;});

  while(!settled){
    const current=now();
    const hardElapsed=current-startedAt;
    const stallElapsed=current-lastProgressAt;
    if(hardElapsed>=hardMs){
      return {completed:false,timeout:true,timeoutKind:'hard-cap',elapsedMs:hardElapsed,stallElapsedMs:stallElapsed,progressChanges,activeDeferrals};
    }
    if(stallElapsed>=stallMs){
      let active=false;
      try{active=typeof isActiveWork==='function'&&isActiveWork()===true;}catch{}
      if(active){
        // HOTFIX46.7: the short watchdog detects orchestration stalls, not a
        // provider call that is visibly still executing. Renew only the short
        // lease while generation-scoped work is RUNNING; the absolute hard cap
        // remains unchanged and still terminates a hung provider.
        lastProgressAt=current;
        activeDeferrals++;
        // Do not fall through with the stale pre-renewal stallElapsed value,
        // otherwise the sleep budget is zero and a long provider call spins a
        // tight polling loop until completion/hard-cap. Yield normally after
        // renewing the short lease; the hard cap is re-evaluated next pass.
        await sleep(Math.min(poll,Math.max(1,hardMs-hardElapsed)));
        continue;
      }else{
        return {completed:false,timeout:true,timeoutKind:'stall',elapsedMs:hardElapsed,stallElapsedMs:stallElapsed,progressChanges,activeDeferrals};
      }
    }
    await sleep(Math.min(poll,hardMs-hardElapsed,stallMs-stallElapsed));
    if(settled)break;
    const next=snapshot(getProgress());
    if(next!==lastProgress){
      lastProgress=next;
      lastProgressAt=now();
      progressChanges++;
      try{onProgress?.({progressChanges,elapsedMs:lastProgressAt-startedAt,progress:getProgress()});}catch{}
    }
  }
  if(error)throw error;
  return {completed:true,timeout:false,value,elapsedMs:now()-startedAt,progressChanges,activeDeferrals};
}
