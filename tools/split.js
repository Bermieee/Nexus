import { proposeSplit } from '../proposals/bus.js';
export const TOOL_NAME='TV2_Split';
export function getDefinition(){return{
    name:TOOL_NAME,displayName:'Nexus Split',description:'Stage a split of one lore UID into two. The new entry inherits the original Tree node unless another node is supplied. No new lorebook keywords are generated.',
    parameters:{type:'object',properties:{lorebook:{type:'string'},uid:{type:'number'},keep_title:{type:'string'},keep_content:{type:'string'},new_title:{type:'string'},new_content:{type:'string'},new_node_id:{type:'string'}},required:['lorebook','uid','keep_content','new_title','new_content']},
    action:async a=>{const p=await proposeSplit(a.lorebook,a.uid,{keepTitle:a.keep_title,keepContent:a.keep_content,newTitle:a.new_title,newContent:a.new_content,newTargetNodeId:a.new_node_id||null},{source:'tool'});return `Lore Proposal ${p.id} staged: split UID ${a.uid}.`;}
};}
