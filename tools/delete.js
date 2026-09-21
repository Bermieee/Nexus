import { proposeDelete } from '../proposals/bus.js';
export const TOOL_NAME = 'TV2_Delete';
export function getDefinition(){return{
    name:TOOL_NAME,displayName:'Nexus Delete',description:'Stage a soft-disable or hard-delete Lore Proposal. Approval also removes the UID from the Tree.',
    parameters:{type:'object',properties:{lorebook:{type:'string'},uid:{type:'number'},hard_delete:{type:'boolean'},reason:{type:'string'}},required:['lorebook','uid']},
    action:async args=>{const p=await proposeDelete(args.lorebook,args.uid,{hardDelete:args.hard_delete===true,reason:args.reason||''},{source:'tool'});return `Lore Proposal ${p.id} staged: ${args.hard_delete?'hard delete':'disable'} UID ${args.uid} + remove Tree assignment.`;}
};}
