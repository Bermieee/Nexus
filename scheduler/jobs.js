import { isOwnerStep, ownerSteps } from './owner-steps.js';
import { NEXUS_JOB_KIND, NEXUS_JOB_ROUTE } from '../nexus/contracts.js';
const LANES=new Set(['foreground','postTurn','background']);
export function registerJob(spec){
  if(!spec?.id||!LANES.has(spec.lane)||typeof spec.inputs!=='function'||typeof spec.steps!=='function'||typeof spec.accept!=='function'||typeof spec.onResult!=='function')throw new TypeError('Invalid scheduler job registration');
  return Object.freeze({...spec,trigger:Object.freeze({...spec.trigger})});
}

// Summary/promotion/routing stay one dependent branch for 6a parity. Splitting
// its authority or treating promotion as an independent job would change output.
const row=(id,type,name,kind,priority,policy,due,reason,skipReason,extra=()=>({}))=>Object.freeze({
  id,type,name,kind,priority,policy,due,reason,skipReason,extra,lane:'postTurn',needsSidecar:type!=='character-bank-refresh',trigger:Object.freeze({everyTurn:true}),
});
export const LIFECYCLE_JOBS=Object.freeze([
  row('context.warm','smart-warm','Smart Warm relevance rescore',NEXUS_JOB_KIND.INSPECT,80,'smartWarm',
    c=>c.smartWarmDue&&(c.assistantTurnAdvanced||c.level!=='none'||c.smartWarmStale),
    c=>c.assistantTurnAdvanced?'completed assistant turn requires local relevance rescore':c.smartWarmStale?'warm context is stale':`scene change is ${c.level}`,
    c=>!c.smartWarmDue?'smart-warm cadence not due':'no completed assistant turn, scene change, or stale warm cache'),
  row('postturn.review','post-turn-extract','Post-turn extraction',NEXUS_JOB_KIND.ADD,70,'postTurn',c=>c.postTurnDue,()=> 'post-turn cadence is due',()=> 'cadence not due',()=>({transactionRequired:true})),
  row('notebook.refresh','notebook-refresh','Rolling Notebook refresh',NEXUS_JOB_KIND.TRANSFORM,65,'notebook',c=>c.notebookDue,c=>c.notebookDueReason||'generation-end Notebook refresh is due',c=>c.notebookDueReason||'Notebook refresh not due',()=>({transactionRequired:true})),
  row('characters.reconcile','character-bank-refresh','Character Bank scene reconciliation',NEXUS_JOB_KIND.ROUTE,60,'characterBanks',c=>c.characterBankActorsChanged,()=> 'Character Bank active set changed',()=> 'Character Bank active set unchanged',c=>({transactionRequired:false,metadata:{activeActors:c.characterBankActiveActors},route:NEXUS_JOB_ROUTE.LOCAL})),
  row('memory.summary','summary','Summary boundary',NEXUS_JOB_KIND.TRANSFORM,55,'summaries',c=>c.summaryDue,()=> 'summary boundary is due',()=> 'summary boundary not due',()=>({transactionRequired:true})),
  row('memory.promotion','summary-promotion','Recursive Summary promotion',NEXUS_JOB_KIND.TRANSFORM,52,'promotion',c=>c.promotionDue,()=> 'recursive promotion is due',()=> 'recursive promotion not due',(c,g)=>({transactionRequired:true,dependencies:g.summaries&&c.summaryDue?['summary']:[]})),
  row('memory.loreRouting','lore-routing','Summary to Lore routing',NEXUS_JOB_KIND.ROUTE,50,'loreRouting',c=>c.loreRoutingDue,()=> 'unrouted memory is due for canonical lore review',()=> 'no lore routing work is due',(c,g)=>({transactionRequired:true,dependencies:g.promotion&&c.promotionDue?['summary-promotion']:g.summaries&&c.summaryDue?['summary']:[]})),
  row('maintenance.housekeeper','maintenance','Maintenance pass',NEXUS_JOB_KIND.INSPECT,25,'maintenance',c=>c.maintenanceDue,c=>c.maintenanceDueReason||'maintenance timer or mutation threshold is due',c=>c.maintenanceDueReason||'maintenance not due'),
]);
const byId=new Map(LIFECYCLE_JOBS.map(row=>[row.id,row]));
export const SCENE_POST_TURN_JOBS=Object.freeze([
  Object.freeze({id:'scene.observe',priority:100,needsSidecar:true,trigger:Object.freeze({gate:['MINOR','MAJOR'],onEdit:true})}),
  Object.freeze({id:'greenroom.infer',priority:90,needsSidecar:true,trigger:Object.freeze({gate:['MINOR','MAJOR'],onEdit:true})}),
]);
export const POST_TURN_JOBS=Object.freeze([
  ...SCENE_POST_TURN_JOBS,
  byId.get('postturn.review'),byId.get('notebook.refresh'),byId.get('context.warm'),byId.get('maintenance.housekeeper'),
  Object.freeze({id:'memory.summaryBranch',priority:byId.get('memory.summary').priority,needsSidecar:true}),
]);

export function createPostTurnJobTable(executors,{inputs={}}={}){
  return POST_TURN_JOBS.filter(row=>typeof executors[row.id]==='function').map(row=>registerJob({
    ...row,lane:'postTurn',trigger:row.trigger??{everyTurn:true},inputs:scope=>({scope,...inputs[row.id]}),
    planningReason:inputs[row.id]?.reasonCode??'EXISTING_LIFECYCLE_DUE',
    dependencies:row.id==='greenroom.infer'&&executors['scene.observe']?['scene.observe']:[],
    async *steps(input,ctx){
      if(!ctx.enqueue){
        const execution=executors[row.id](input,ctx);
        const result=typeof execution?.next==='function'?yield* execution:await execution;
        yield ctx.checkpoint({complete:true});return result;
      }
      return yield* ownerSteps(async({enqueue})=>{
        const execution=executors[row.id](input,{...ctx,enqueue});
        if(typeof execution?.next!=='function')return await execution;
        let step=await execution.next();
        try{while(!step.done){await enqueue.checkpoint(step.value);step=await execution.next();}return step.value;}
        finally{await execution.return?.();}
      },{enqueue:ctx.enqueue,input,savedState:ctx.savedState});
    },
    accept:value=>isOwnerStep(value)?value.accept():value!==undefined,
    onResult:value=>isOwnerStep(value)&&value.kind==='PUBLICATION'?value.publish():undefined,
  }));
}
