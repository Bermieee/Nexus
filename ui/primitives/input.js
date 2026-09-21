import { classes, el, append } from '../core/dom.js';
import { describedBy, labelledBy, uiId } from '../core/a11y.js';

export function input({ label = '', value = '', placeholder = '', type = 'text', help = '', onInput, onChange, disabled = false, className = '', document } = {}) {
    const wrap = el('label', { className: classes('nx-field', className), document });
    const labelNode = label ? el('span', { className: 'nx-field__label', text: label, document }) : null;
    const control = el('input', {
        className: 'nx-input', value, type, disabled, document,
        attrs: { placeholder }, on: { input: onInput, change: onChange },
    });
    if (labelNode) labelledBy(control, labelNode);
    const helpNode = help ? el('span', { className: 'nx-field__help', text: help, id: uiId('nx-help'), document }) : null;
    if (helpNode) describedBy(control, helpNode);
    append(wrap, labelNode, control, helpNode);
    wrap.controlElement = control;
    return wrap;
}

export function textarea({ label = '', value = '', placeholder = '', rows = 4, help = '', onInput, disabled = false, className = '', document } = {}) {
    const wrap = el('label', { className: classes('nx-field', className), document });
    const labelNode = label ? el('span', { className: 'nx-field__label', text: label, document }) : null;
    const control = el('textarea', { className: 'nx-input nx-textarea', text: value, disabled, document, attrs: { placeholder, rows }, on: { input: onInput } });
    if (labelNode) labelledBy(control, labelNode);
    const helpNode = help ? el('span', { className: 'nx-field__help', text: help, document }) : null;
    if (helpNode) describedBy(control, helpNode);
    append(wrap, labelNode, control, helpNode);
    wrap.controlElement = control;
    return wrap;
}
