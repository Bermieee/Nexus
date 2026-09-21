import { el } from '../core/dom.js';
export function searchField({ value = '', placeholder = 'Search…', onInput, document } = {}) {
    const wrap = el('label', { className: 'nx-search', document });
    wrap.append(el('span', { className: 'nx-search__icon', text: '⌕', document }));
    const control = el('input', { className: 'nx-search__input', type: 'search', value, document, attrs: { placeholder, 'aria-label': placeholder }, on: { input: onInput } });
    wrap.append(control); wrap.controlElement = control; return wrap;
}
