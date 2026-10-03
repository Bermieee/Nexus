// How big the Notebook may be. Sized from the main model's context through core/budget.js, with the
// long-standing 1,400 / 1,800 token sizes as the starting point and a sanity ceiling on top.
import { createBudgetManager } from '../core/budget.js';

export const NOTEBOOK_SIZE_DEFAULTS=Object.freeze({targetTokens:1400,maxTokens:1800});
export const NOTEBOOK_SANITY_CEILING=Object.freeze({floorTokens:400,targetTokens:4000,maxTokens:6000});
// The context size at which the starting sizes apply. Smaller contexts shrink the Notebook, larger grow it.
export const NOTEBOOK_REFERENCE_CONTEXT_TOKENS=16384;
// The share of the main context the Notebook may take.
export const NOTEBOOK_CONTEXT_SHARE=Object.freeze({target:0.1,max:0.13});

const NO_CLOCK_LIMIT=Number.MAX_SAFE_INTEGER;
const sharedManager=createBudgetManager();
const whole=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0?Math.floor(Number(value)):fallback;

export function resolveNotebookBudget({configured={},contextTokens=null,manager=sharedManager,now=0}={}){
  const baseTarget=Math.min(NOTEBOOK_SANITY_CEILING.targetTokens,Math.max(NOTEBOOK_SANITY_CEILING.floorTokens,whole(configured.targetTokens,NOTEBOOK_SIZE_DEFAULTS.targetTokens)));
  const baseMax=Math.min(NOTEBOOK_SANITY_CEILING.maxTokens,Math.max(baseTarget,whole(configured.maxTokens,NOTEBOOK_SIZE_DEFAULTS.maxTokens)));
  const known=Number.isFinite(Number(contextTokens))&&Number(contextTokens)>0;
  const context=known?Number(contextTokens):NOTEBOOK_REFERENCE_CONTEXT_TOKENS;
  const multiplier=known?context/NOTEBOOK_REFERENCE_CONTEXT_TOKENS:1;
  // Time is not the constraint here; the frame is given no clock limit so only tokens decide.
  const frame=manager.beginTurn({now,timeMs:NO_CLOCK_LIMIT,promptTokens:context,worldSize:200});
  const plan=(id,base,share,ceiling)=>frame.compute(id,{total:ceiling,defaultUnits:base,defaultWorldSize:200,msPerUnit:1e-9,tokensPerUnit:1,tokenShare:share,multiplier,sanityCeiling:ceiling});
  const target=plan('notebook.size.target',baseTarget,NOTEBOOK_CONTEXT_SHARE.target,NOTEBOOK_SANITY_CEILING.targetTokens);
  const max=plan('notebook.size.max',baseMax,NOTEBOOK_CONTEXT_SHARE.max,NOTEBOOK_SANITY_CEILING.maxTokens);
  const targetTokens=Math.max(NOTEBOOK_SANITY_CEILING.floorTokens,target.allowed);
  const maxTokens=Math.max(targetTokens,max.allowed);
  return Object.freeze({targetTokens,maxTokens,contextTokens:known?context:null,contextKnown:known,startingTargetTokens:baseTarget,startingMaxTokens:baseMax,ceilingHit:target.ceilingHit||max.ceilingHit});
}
