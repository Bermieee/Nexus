import { classes, el, append } from '../core/dom.js';
export function select({ label = '', value = '', options = [], onChange, disabled = false, className = '', document } = {}) {
    const wrap = el('label', { className: classes('nx-field', className), document });
    if (label) append(wrap, el('span', { className: 'nx-field__label', text: label, document }));
    const control = el('select', { className: 'nx-select', disabled, document, on: { change: onChange } });
    for (const option of options) {
        const normalized = typeof option === 'string' ? { value: option, label: option } : option;
        const item = el('option', { value: normalized.value, text: normalized.label ?? normalized.value, disabled: normalized.disabled, document });
        if (String(normalized.value) === String(value)) item.selected = true;
        append(control, item);
    }
    append(wrap, control);
    wrap.controlElement = control;
    return wrap;
}
