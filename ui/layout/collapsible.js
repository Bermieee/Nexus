import { classes, el, append } from '../core/dom.js';
export function collapsible({ title, subtitle = '', summaryEnd = [], body = [], open = false, className = '', document } = {}) {
    const node = el('details', { className: classes('nx-collapsible', className), document });
    node.open = Boolean(open);
    const summary = el('summary', { className: 'nx-collapsible__summary', document });
    const copy = el('span', { className: 'nx-collapsible__copy', document });
    append(copy, el('strong', { text: title ?? '', document }), subtitle ? el('small', { text: subtitle, document }) : null);
    append(summary,
        copy,
        el('span', { className: 'nx-collapsible__end', document }, summaryEnd),
        el('span', { className: 'nx-collapsible__chevron', text: '›', document, attrs: { 'aria-hidden': 'true' } }),
    );
    append(node, summary, el('div', { className: 'nx-collapsible__body', document }, body));
    return node;
}
