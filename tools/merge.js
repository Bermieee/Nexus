import { proposeMerge } from '../proposals/bus.js';
import { loadBook } from '../lore/store.js';
import { getTree } from '../tree/store.js';
import { currentNodeForUid } from '../tree/ops.js';
import { rankMergePairsCooperative } from './merge-similarity.js';
import { logEvent } from '../observability/telemetry.js';
import { assertReadableBook } from '../lore/policy.js';
export const TOOL_NAME='TV2_Merge';

export async function scanMergeCandidates(lorebook,{targetUid=null,thresholdPercent=35,limit=25}={}){
    const book=String(lorebook||'').trim();if(!book)throw new Error('Merge scan requires a lorebook.');assertReadableBook(book);
    const data=await loadBook(book);const tree=getTree(book);
    const entries=Object.values(data?.entries||{}).map(e=>({uid:Number(e?.uid),title:e?.comment||'',content:e?.content||'',disable:e?.disable===true}));
    const nodeForUid=uid=>currentNodeForUid(tree,uid)?.id||null;
    const rows=await rankMergePairsCooperative(entries,{targetUid,thresholdPercent,limit,nodeForUid});
    const decorated=rows.map(r=>({...r,nodeLabelA:currentNodeForUid(tree,r.uidA)?.label||'Root / Unassigned',nodeLabelB:currentNodeForUid(tree,r.uidB)?.label||'Root / Unassigned'}));
    logEvent('tools','merge-scan-complete',{book,targetUid:targetUid===null?null:Number(targetUid),thresholdPercent:Number(thresholdPercent)||0,limit:Number(limit)||25,resultCount:decorated.length,top:decorated.slice(0,10).map(r=>({uidA:r.uidA,uidB:r.uidB,percent:r.percent}))},'info');
    return decorated;
}

function formatScan(book,rows){
    if(!rows.length)return `Merge scan for "${book}": no candidates met the requested similarity threshold.`;
    return [`Merge scan for "${book}" — ${rows.length} candidate pair(s):`,...rows.map((r,i)=>`${i+1}. ${r.percent}% · UID ${r.uidA} “${r.titleA||'Untitled'}” ↔ UID ${r.uidB} “${r.titleB||'Untitled'}” · title ${r.titlePercent}% · content ${r.contentPercent}%${r.sameNode?` · same Tree node (${r.nodeLabelA})`:''}`)].join('\n');
}

export function getDefinition(){return{
    name:TOOL_NAME,displayName:'Nexus Merge',description:'Read-only scan lore UIDs for merge similarity percentages, or stage a proposal-first merge. Scan mode never mutates lore.',
    parameters:{type:'object',properties:{mode:{type:'string',enum:['scan','propose']},lorebook:{type:'string'},scan_uid:{type:'number',description:'Optional target UID. Omit to scan all active UID pairs.'},threshold_percent:{type:'number',minimum:0,maximum:100},limit:{type:'number',minimum:1,maximum:500},keep_uid:{type:'number'},remove_uid:{type:'number'},merged_title:{type:'string'},merged_content:{type:'string'},hard_delete:{type:'boolean'},tree_policy:{type:'string',enum:['keep','removed']},target_node_id:{type:'string'}},required:['lorebook']},
    action:async a=>{
        const hasPair=Number.isFinite(Number(a.keep_uid))&&Number.isFinite(Number(a.remove_uid));
        const mode=a.mode||(hasPair?'propose':'scan');
        if(mode==='scan'){
            const rows=await scanMergeCandidates(a.lorebook,{targetUid:a.scan_uid??null,thresholdPercent:a.threshold_percent??35,limit:a.limit??25});
            return formatScan(a.lorebook,rows);
        }
        if(!hasPair)throw new Error('Merge proposal mode requires keep_uid and remove_uid.');
        const p=await proposeMerge(a.lorebook,a.keep_uid,a.remove_uid,{title:a.merged_title,content:a.merged_content,hardDelete:a.hard_delete===true,treePolicy:a.tree_policy||'keep',targetNodeId:a.target_node_id||null},{source:'tool'});
        return `Lore Proposal ${p.id} staged: merge UID ${a.remove_uid} → ${a.keep_uid}.`;
    }
};}
