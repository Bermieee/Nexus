import { proposeCreate } from '../proposals/bus.js';
export const TOOL_NAME = 'TV2_Remember';
export function getDefinition() { return {
    name: TOOL_NAME, displayName: 'Nexus Remember', description: 'Stage a new lore memory as a Lore Proposal. Nexus does not generate lorebook keywords; new entries are created with no new keys.',
    parameters: { type: 'object', properties: { lorebook:{type:'string'}, title:{type:'string'}, content:{type:'string'}, node_id:{type:'string'}, constant:{type:'boolean'} }, required:['lorebook','title','content'] },
    action: async args => { const p=await proposeCreate(args.lorebook,{title:args.title,content:args.content,targetNodeId:args.node_id||null,constant:args.constant===true},{source:'tool'}); return `Lore Proposal ${p.id} staged: create "${args.title}"${args.node_id?` in Tree node ${args.node_id}`:''}.`; }
}; }
