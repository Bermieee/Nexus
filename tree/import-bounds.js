export const TREE_IMPORT_LIMITS=Object.freeze({maxDepth:256,maxNodes:50000,maxTextChars:16_000_000});

export function assertTreeImportWithinBounds(tree,limits=TREE_IMPORT_LIMITS){
    if(!tree||typeof tree!=='object')throw new Error('Tree import entry is not an object.');
    if(!tree.root||typeof tree.root!=='object')throw new Error('Tree import has no root node.');
    const maxDepth=Math.max(1,Number(limits?.maxDepth)||TREE_IMPORT_LIMITS.maxDepth);
    const maxNodes=Math.max(1,Number(limits?.maxNodes)||TREE_IMPORT_LIMITS.maxNodes);
    const maxTextChars=Math.max(1024,Number(limits?.maxTextChars)||TREE_IMPORT_LIMITS.maxTextChars);
    let nodes=0,textChars=String(tree.lorebookName||'').length,deepest=0;
    const stack=[{node:tree.root,depth:1}];
    while(stack.length){
        const {node,depth}=stack.pop();
        if(!node||typeof node!=='object')throw new Error('Tree import contains a non-object node.');
        if(depth>maxDepth){const error=new Error(`Tree import exceeds the safe maximum depth of ${maxDepth}.`);error.name='TV2TreeImportBounds';throw error;}
        deepest=Math.max(deepest,depth);
        nodes++;if(nodes>maxNodes){const error=new Error(`Tree import exceeds the safe maximum node count of ${maxNodes}.`);error.name='TV2TreeImportBounds';throw error;}
        textChars+=String(node.id||'').length+String(node.label||'').length+String(node.summary||'').length;
        for(const value of Array.isArray(node.keywords)?node.keywords:[])textChars+=String(value||'').length;
        if(textChars>maxTextChars){const error=new Error(`Tree import exceeds the safe text-size bound of ${maxTextChars} characters.`);error.name='TV2TreeImportBounds';throw error;}
        const children=Array.isArray(node.children)?node.children:[];
        for(let i=children.length-1;i>=0;i--)stack.push({node:children[i],depth:depth+1});
    }
    return {nodes,deepest,maxDepth,maxTextChars,textChars};
}
