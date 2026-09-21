import { classes, el } from '../core/dom.js';

/**
 * Shared information/navigation row.
 * Primary copy owns the flexible column. Compact metadata/pills live beneath it.
 * Trailing actions are bounded and never steal the title column.
 * `leading` is retained for API compatibility but intentionally renders as
 * metadata beneath the primary copy rather than as a competing horizontal column.
 */
export function itemRow({
    title = '', meta = '', leading = [], trailing = [], body = [],
    interactive = false, selected = false, onClick,
    className = '', dataset = {}, titleAttr = '', document,
} = {}) {
    const tag = interactive ? 'button' : 'article';
    return el(tag, {
        className: classes('nx-item-row', interactive && 'nx-item-row--interactive', selected && 'is-selected', className),
        type: interactive ? 'button' : undefined,
        title: titleAttr,
        dataset,
        document,
        on: interactive && onClick ? { click: onClick } : undefined,
        attrs: interactive ? { 'aria-pressed': selected ? 'true' : 'false' } : undefined,
    }, [
        el('div', { className: 'nx-item-row__head', document }, [
            el('div', { className: 'nx-item-row__copy', document }, [
                title ? el('strong', { className: 'nx-item-row__title', text: title, document }) : null,
                meta ? el('small', { className: 'nx-item-row__meta', text: meta, document }) : null,
                leading?.length ? el('div', { className: 'nx-item-row__metadata', document }, leading) : null,
            ]),
            trailing?.length ? el('div', { className: 'nx-item-row__trailing', document }, trailing) : null,
        ]),
        body?.length ? el('div', { className: 'nx-item-row__body', document }, body) : null,
    ]);
}
