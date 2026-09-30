// Expose owner call boundaries without releasing its existing conflict lease.
export async function* leasedSteps(steps,lease){
  let slot=null,waiter=null,resume=null,closed=false,finished=false;
  const deliver=step=>{slot=step;if(step.done||step.error)finished=true;const wake=waiter;waiter=null;wake?.();};
  const driver=lease(async()=>{
    const iterator=steps();
    try{
      while(!closed){
        const step=await iterator.next();
        if(step.done){deliver(step);return step.value;}
        const boundary=new Promise(resolve=>{resume=resolve;});
        deliver(step);await boundary;
      }
    }finally{await iterator.return?.();}
  }).then(value=>{if(!finished&&!closed)deliver({done:true,value});},error=>{if(!closed)deliver({error});});
  try{
    while(true){
      if(!slot)await new Promise(resolve=>{waiter=resolve;});
      const step=slot;slot=null;
      if(step.error)throw step.error;
      if(step.done){await driver;return step.value;}
      yield step.value;
      const proceed=resume;resume=null;proceed?.();
    }
  }finally{closed=true;resume?.();await driver;}
}
