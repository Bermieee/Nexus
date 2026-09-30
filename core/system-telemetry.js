import { projectNexusDiagnosticTelemetryFromObservability } from '../nexus/diagnostics-source.js';

// Only metadata survives before queueing. The existing logger remains the one
// telemetry stream; no generation caller waits for persistence or UI listeners.
export function createSystemTelemetryHook({emit,schedule=fn=>setTimeout(fn,0),maxPending=256,batchSize=16}={}){
  const pending=[];let scheduled=false;
  const capacity=Math.max(1,Math.min(256,Number(maxPending)||256));
  const batch=Math.max(1,Math.min(16,Number(batchSize)||16));
  function arm(){
    if(scheduled||!pending.length)return;
    scheduled=true;
    try{schedule(flush);}catch{scheduled=false;pending.length=0;}
  }
  function flush(){
    scheduled=false;
    for(let i=0;i<batch&&pending.length;i++){
      const record=pending.shift();
      try{emit(record.category,record.name,record.data,record.level);}catch{}
    }
    arm();
  }
  return function logSystemEvent(category,name,data={},level='info'){
    try{
      const event=projectNexusDiagnosticTelemetryFromObservability({events:[{category,name,data,level,ts:Date.now()}]}).events[0];
      if(!event)return false;
      if(pending.length>=capacity)pending.shift();
      pending.push({category,name:event.name,level:event.level,data:{...event.data,...event.data.selection}});
      arm();return true;
    }catch{return false;}
  };
}
