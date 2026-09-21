export function buildLoreEditorPatch({
    title = '',
    content = '',
    keywords = '',
    enabled = true,
    constant = false,
    targetNodeId = '',
    fallbackNodeId = null,
} = {}) {
    const keys = [...new Set(String(keywords || '').split(/[\n,;]+/).map(value => value.trim()).filter(Boolean))];
    const nodeValue = String(targetNodeId || '').trim();
    return {
        title: String(title || '').trim(),
        content: String(content || '').trim(),
        keys,
        disable: enabled !== true,
        constant: constant === true,
        targetNodeId: nodeValue || fallbackNodeId,
    };
}
