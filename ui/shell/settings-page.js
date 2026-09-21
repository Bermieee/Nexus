import { classes, el, ensureUiRoot } from '../core/dom.js';
export function settingsPage({ title = 'Settings', subtitle = '', navigation = [], content = [], className = '', document } = {}) {
    return ensureUiRoot(el('section', { className: classes('nx-settings-page', className), document }, [
        el('header', { className: 'nx-page-header', document }, [el('h2', { text: title, document }), subtitle ? el('p', { text: subtitle, document }) : null]),
        el('div', { className: 'nx-settings-page__grid', document }, [
            el('nav', { className: 'nx-settings-page__nav', document }, navigation),
            el('main', { className: 'nx-settings-page__content', document }, content),
        ]),
    ]));
}
