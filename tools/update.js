import { proposeUpdate } from '../proposals/bus.js';
export const TOOL_NAME = 'TV2_Update';
export function getDefinition() { return {
    name: TOOL_NAME, displayName: 'Nexus Update', description: 'Stage an update to an existing UID. Existing lorebook keywords are preserved and are never generated or modified by this tool.',
    parameters:{type:'object',properties:{lorebook:{type:'string'},uid:{type:'number'},title:{type:'string'},content:{type:'string'},node_id:{type:'string'},constant:{type:'boolean'},disable:{type:'boolean'}},required:['lorebook','uid']},
    action: async args=>{ const patch={}; for(const k of ['title','content','constant','disable']) if(args[k]!==undefined) patch[k]=args[k]; if(args.node_id!==undefined) patch.targetNodeId=args.node_id; const p=await proposeUpdate(args.lorebook,args.uid,patch,{source:'tool'}); return `Lore Proposal ${p.id} staged: update UID ${args.uid}${args.node_id!==undefined?' + Tree placement':''}.`; }
}; }
