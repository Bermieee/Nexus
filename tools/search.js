import { getActiveBooks, isBookInCurrentStory } from '../lore/active-books.js';
import { getTree } from '../tree/store.js';
import { findNode } from '../tree/model.js';
import { formatTreeOverview, searchTree, resolveNodeEntries } from '../retrieval/search-engine.js';
import { assertReadableBook } from '../lore/policy.js';
import { getContext } from '../../../../st-context.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh } from '../nexus/work-scope.js';

export const TOOL_NAME = 'TV2_Search';

function selectedBooks(book) {
    if (String(book || '').trim()) { const name=String(book).trim(); assertReadableBook(name); if(!isBookInCurrentStory(name,{access:'read'}))throw new Error(`Lorebook "${name}" is outside the current Story Scope.`); return [name]; }
    return getActiveBooks({ requireTree: true, access: 'read' });
}

function formatResults(rows, { includeContent = false, maxChars = 24000 } = {}) {
    if (!rows.length) return 'No matching Tree/lore entries.';
    const blocks = rows.map(row => {
        const header = `[${row.book} | UID ${row.uid}] ${row.title || 'Untitled'}\nTree: ${(row.path || []).join(' > ') || row.nodeLabel || row.nodeId || 'unknown'}${Number.isFinite(Number(row.score)) ? `\nSearch score: ${Number(row.score).toFixed(2)}` : ''}`;
        return includeContent ? `${header}\n${row.content || ''}` : header;
    });
    const out=[];let used=0;
    for(const block of blocks){const chars=Array.from(block);const remaining=Math.max(0,maxChars-used);if(!remaining)break;const text=chars.length>remaining?`${chars.slice(0,Math.max(0,remaining-32)).join('')}\n… [result truncated]`:block;out.push(text);used+=Array.from(text).length+8;if(chars.length>remaining)break;}
    if(out.length<blocks.length)out.push(`… [${blocks.length-out.length} additional result(s) omitted by Search safety bound]`);
    return out.join('\n\n---\n\n');
}

export function getDefinition() {
    return {
        name: TOOL_NAME,
        displayName: 'Nexus Search',
        description: 'Read and search the Nexus Tree. Supports cross-lorebook search, Tree overview/navigation, and exact node retrieval. Never mutates canon.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['overview', 'children', 'search', 'retrieve'],
                    description: 'overview = show Tree index; children = show one node and immediate children; search = ranked text search inside Tree; retrieve = get exact entries from selected Tree node(s).',
                },
                lorebook: { type: 'string', description: 'Optional lorebook. Omit to operate across all active Nexus Tree lorebooks.' },
                node_id: { type: 'string', description: 'Optional Tree node ID for children/retrieve/search scope.' },
                node_ids: { type: 'array', items: { type: 'string' }, description: 'Optional list of Tree node IDs for retrieve/search scope.' },
                query: { type: 'string', description: 'Text query for ranked Tree/lore search.' },
                limit: { type: 'number', description: 'Optional maximum number of search results. Defaults to 20; use 0 only when an explicitly unbounded result set is required.' },
                include_content: { type: 'boolean', description: 'For search results, include full lore content (default false).' },
            },
            required: ['action'],
        },
        action: async args => {
            const scope=captureNexusWorkScope(getContext(),{includeRevision:true,kind:'chat'});
            const fresh=()=>isNexusWorkScopeFresh(scope,getContext());
            const stale=()=> 'Search cancelled because the active chat or Story Scope changed while the read was in flight.';
            const books = selectedBooks(args.lorebook);
            if (!books.length) return 'No active Nexus Trees are available.';
            const action = String(args.action || 'search').toLowerCase();
            const nodeIds = [...new Set([...(Array.isArray(args.node_ids) ? args.node_ids : []), ...(args.node_id ? [args.node_id] : [])].map(String))];
            if (books.length > 1 && nodeIds.length && ['children','retrieve','search'].includes(action)) {
                return 'Bare node_id/node_ids are ambiguous across multiple lorebooks. Specify lorebook when addressing Tree nodes.';
            }

            if (action === 'overview') {
                return fresh() ? (formatTreeOverview(books, { includeSummaries: true, maxDepth: 8, maxNodes: 200, maxChars: 24000 }) || 'No Tree structure available.') : stale();
            }

            if (action === 'children') {
                if (!args.node_id) return 'children requires node_id.';
                for (const book of books) {
                    const tree = getTree(book);
                    const node = tree ? findNode(tree.root, args.node_id) : null;
                    if (!node) continue;
                    const lines = [`Lorebook: ${book}`, `[${node.id}] ${node.label} (${(node.entryUids || []).length} direct entries)`];
                    if (node.summary) lines.push(`Summary: ${node.summary}`);
                    const children=node.children||[];
                    const requested=Number(args.limit);
                    const childLimit=Number.isFinite(requested)&&requested>0?Math.max(1,Math.floor(requested)):100;
                    for (const child of children.slice(0,childLimit)) lines.push(`- [${child.id}] ${child.label} (${(child.entryUids || []).length} direct)`);
                    if(children.length>childLimit)lines.push(`… ${children.length-childLimit} additional immediate child node(s) omitted; increase limit to inspect more.`);
                    return lines.join('\n');
                }
                return `Tree node ${args.node_id} was not found.`;
            }

            if (action === 'retrieve') {
                if (!nodeIds.length) return 'retrieve requires node_id or node_ids.';
                const rows = await resolveNodeEntries({ books, nodeIds, maxEntries: 20 });
                if(!fresh())return stale();
                return formatResults(rows, { includeContent: true, maxChars: 24000 });
            }

            const rows = await searchTree({
                query: args.query || '',
                books,
                nodeIds,
                limit: Object.prototype.hasOwnProperty.call(args,'limit') ? Math.max(0,Number(args.limit)||0) : 20,
                includeContent: args.include_content === true,
            });
            if(!fresh())return stale();
            return formatResults(rows, { includeContent: args.include_content === true, maxChars: 24000 });
        },
    };
}
