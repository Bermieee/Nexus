import { classes, el, append } from '../core/dom.js';
import { button } from '../primitives/button.js';
export function modal({ title = '', body = [], actions = [], open = false, onClose, className = '', document } = {}) {
    const dialog = el('dialog', { className: classes('nexus-ui', 'nx-modal', className), document });
    const close = button({ label: 'Close', variant: 'ghost', size: 'sm', onClick: () => { dialog.close?.(); onClose?.(); }, document });
    append(dialog,
        el('header', { className: 'nx-modal__header', document }, [el('h2', { text: title, document }), close]),
        el('div', { className: 'nx-modal__body', document }, body),
        actions?.length ? el('footer', { className: 'nx-modal__footer', document }, actions) : null,
    );
    dialog.openDialog = () => { if (!dialog.open) dialog.showModal?.(); };
    dialog.closeDialog = () => { if (dialog.open) dialog.close?.(); };
    if (open) queueMicrotask(() => { try { dialog.openDialog(); } catch {} });
    return dialog;
}
