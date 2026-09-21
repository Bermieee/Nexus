const normalize=value=>String(value||'').trim().replace(/\s+/g,' ').toLocaleLowerCase();

export function canonicalEntityTitle(title='') {
    return String(title).trim().replace(/\s+[-\u2013\u2014:]\s+(?:identity(?:\s*&\s*role)?|appearance|relationships?|profile|biography|current status|status|personality|clothing|gear|skills?)\b.*$/i,'').trim();
}

// Only explicit source declarations supply aliases. Activation keys, spelling
// prefixes, frequency and longer labels are not evidence of the same entity.
export function sourceDeclaredAliases(inventory) {
    const source=new Map((inventory?._sourceEntries||[]).map(row=>[row.ref,String(row.content||'')]));
    const result=[];
    for(const entry of inventory?.activeEntries||[]) {
        const canonical=canonicalEntityTitle(entry.title);if(!canonical)continue;
        for(const line of (source.get(entry.ref)||'').split(/\r?\n/)) {
            const match=line.match(/^\s*(?:[-*]\s*)?(?:Aliases?|Also known as)\s*:\s*(.+)$/i);
            if(!match)continue;
            for(const raw of match[1].split(/[,;|]/)) {
                const alias=raw.trim().replace(/^["']|["']$/g,'');
                if(alias.length<2||alias.length>120||/^(none|unknown|n\/a)$/i.test(alias)||normalize(alias)===normalize(canonical))continue;
                result.push({alias,canonical,ref:entry.ref});
            }
        }
    }
    return result;
}

export function reconcileCanonicalPlacementPaths({placements=[],lorebookInventory=null,existingTree=null}={}) {
    const rows=placements.map(row=>({...row,path:Array.isArray(row.path)?[...row.path]:row.path}));
    const labels=new Map();
    for(const row of rows)if(normalize(row.path?.[0])==='characters'&&row.path?.[1])labels.set(normalize(row.path[1]),row.path[1]);
    const existing=(existingTree?.root?.children||[]).find(node=>normalize(node.label)==='characters');
    const existingLabels=new Set((existing?.children||[]).map(node=>normalize(node.label)));
    for(const node of existing?.children||[])labels.set(normalize(node.label),node.label);
    const anchors=new Set((lorebookInventory?.activeEntries||[]).map(entry=>normalize(canonicalEntityTitle(entry.title))));
    const candidates=new Map();
    for(const declaration of sourceDeclaredAliases(lorebookInventory)) {
        const alias=normalize(declaration.alias),canonical=normalize(declaration.canonical);
        if(!labels.has(alias)||anchors.has(alias)||existingLabels.has(alias))continue;
        if(!candidates.has(alias))candidates.set(alias,new Map());
        candidates.get(alias).set(canonical,declaration);
    }
    const aliases=[];
    for(const row of rows) {
        if(normalize(row.path?.[0])!=='characters')continue;
        const from=String(row.path[1]||''),choices=candidates.get(normalize(from));
        if(choices?.size!==1)continue;
        const [canonical,declaration]=[...choices][0],to=labels.get(canonical);
        if(!to)continue;
        row.path[1]=to;aliases.push({ref:row.ref,from,to,evidenceRef:declaration.ref,reason:'explicit-source-alias'});
    }
    return {placements:rows,aliases};
}
