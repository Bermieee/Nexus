// What the NOTEBOOK outlet sends for a turn. The prompt and the Notebook tab both build it here,
// so what the operator reads is what the model gets. Pure: the caller supplies the document, the
// Hot Cognition text, the budget and the clock-free facts about the chat.
import { estimateContentTokens } from '../observability/token-estimator.js';

const clean=value=>String(value??'').trim();
const CORE_BLOCK=/\b(?:current|scene|location|date|time|cast|character|goal|need|thread|hook|unresolved|directive|constraint|next)\b/i;

function splitBlocks(text){return clean(text).split(/\n\s*\n/).map(block=>block.trim()).filter(Boolean);}

// Keeps the blocks that matter most inside the cap, core state first. Returns what it held back
// so the caller can say so; nothing is deleted from the stored document.
export function briefNotebookBlocks(text,{maxTokens=700,estimate=estimateContentTokens}={}){
  const cap=Math.max(100,Math.min(6000,Math.floor(Number(maxTokens)||700))),raw=clean(text);
  if(!raw)return{brief:'',blocks:0,kept:0,heldBack:0};
  const blocks=splitBlocks(raw),core=blocks.filter(block=>CORE_BLOCK.test(block)),rest=blocks.filter(block=>!CORE_BLOCK.test(block));
  const fill=ordered=>{
    const kept=[];let brief='';
    for(const block of ordered){const next=brief?`${brief}\n\n${block}`:block;if(estimate(next)>cap)break;brief=next;kept.push(block);}
    return{brief,kept:kept.length};
  };
  let result=fill([...core,...rest]);
  if(!result.brief)result=fill(blocks);
  if(!result.brief)return{brief:raw.slice(0,cap*4),blocks:blocks.length,kept:1,heldBack:Math.max(0,blocks.length-1),truncated:true};
  return{brief:result.brief,blocks:blocks.length,kept:result.kept,heldBack:blocks.length-result.kept};
}

export function buildNotebookColdStartBrief(text,{maxTokens=700}={}){return briefNotebookBlocks(text,{maxTokens}).brief;}

const COLD_HEADER='Nexus COLD START BRIEF — NOTEBOOK CORE\nThis is one-time setup state for the first response in a new opening. It tracks current direction, timeline, active people, and unresolved hooks. It is not canonical lore; current user direction and canonical lore remain authoritative.';
const ROLLING_HEADER='Nexus ROLLING NOTEBOOK — CURRENT WORLD STATE\nThis is the single current collaborative working-state document. It tracks current goals, needs, scene direction, and unresolved planning between turns. It is not canonical lore; follow it unless the immediate user message deliberately changes it.';

export function composeNotebookOutlet({doc=null,hotText='',coldOpening=false,coldStart=null,budget=null,estimate=estimateContentTokens}={}){
  const text=clean(doc?.text),hot=clean(hotText);
  if(!text&&!hot)return Object.freeze({empty:true,content:'',notebookText:'',hotText:'',coldStart:false,compaction:null,tokens:0});
  let notebookText='',useColdBrief=false,compaction=null;
  if(text){
    useColdBrief=coldStart?.enabled!==false&&coldOpening===true;
    const fullTokens=estimate(text);
    let body=text;
    if(useColdBrief){
      const cap=Number(coldStart?.maxTokens)||700,brief=briefNotebookBlocks(text,{maxTokens:cap,estimate});
      body=brief.brief;
      if(brief.heldBack>0)compaction={compacted:true,reason:'cold-start-brief',fullTokens,sentTokens:estimate(body),budgetTokens:cap,heldBackBlocks:brief.heldBack};
    }else if(budget&&fullTokens>budget.maxTokens){
      const brief=briefNotebookBlocks(text,{maxTokens:budget.targetTokens,estimate});
      body=brief.brief;
      compaction={compacted:true,reason:'over-budget',fullTokens,sentTokens:estimate(body),budgetTokens:budget.maxTokens,heldBackBlocks:brief.heldBack,truncated:brief.truncated===true};
    }
    // The note names the held-back state so it is never silently absent from the prompt.
    const note=compaction?.heldBackBlocks>0?`\n\n[Notebook compacted for this turn: ${compaction.heldBackBlocks} lower-priority block${compaction.heldBackBlocks===1?'':'s'} held back. The full Notebook is unchanged.]`:'';
    notebookText=`${useColdBrief?COLD_HEADER:ROLLING_HEADER}\n\n${body}${note}`;
  }
  const content=[notebookText,hot].filter(Boolean).join('\n\n');
  return Object.freeze({empty:false,content,notebookText,hotText:hot,coldStart:useColdBrief,compaction:compaction?Object.freeze(compaction):null,tokens:estimate(content)});
}
