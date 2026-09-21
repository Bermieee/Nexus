import { el, append } from '../core/dom.js';
export function tooltip({ trigger, content, placement = 'top', document } = {}) {
    const wrap = el('span', { className: `nx-tooltip nx-tooltip--${placement}`, document });
    const tip = el('span', { className: 'nx-tooltip__content', text: content ?? '', role: 'tooltip', document });
    append(wrap, trigger, tip);
    return wrap;
}
