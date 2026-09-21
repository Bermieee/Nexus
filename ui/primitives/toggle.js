import { classes, el, append } from '../core/dom.js';
export function toggle({ label = '', checked = false, onChange, disabled = false, className = '', document } = {}) {
    const wrap = el('label', { className: classes('nx-toggle', className), document });
    const control = el('input', { type: 'checkbox', document, disabled, on: { change: onChange } });
    control.checked = Boolean(checked);
    const track = el('span', { className: 'nx-toggle__track', document }, el('span', { className: 'nx-toggle__thumb', document }));
    append(wrap, control, track, label ? el('span', { className: 'nx-toggle__label', text: label, document }) : null);
    wrap.controlElement = control;
    return wrap;
}

export function checkbox({ label = '', checked = false, onChange, disabled = false, className = '', document } = {}) {
    const wrap = el('label', { className: classes('nx-checkbox', className), document });
    const control = el('input', { type: 'checkbox', document, disabled, on: { change: onChange } });
    control.checked = Boolean(checked);
    append(wrap, control, el('span', { text: label, document }));
    wrap.controlElement = control;
    return wrap;
}
