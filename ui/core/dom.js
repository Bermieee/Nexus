function documentFor(doc) {
    const resolved = doc || globalThis.document;
    if (!resolved?.createElement) throw new Error('Nexus UI requires a DOM Document');
    return resolved;
}

export function classes(...values) {
    return values.flat(Infinity).filter(Boolean).join(' ');
}

export function append(parent, ...children) {
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        if (typeof child === 'string' || typeof child === 'number') {
            parent.append(parent.ownerDocument.createTextNode(String(child)));
        } else {
            parent.append(child);
        }
    }
    return parent;
}

export function el(tag, options = {}, children = []) {
    const doc = documentFor(options.document);
    const node = doc.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.id) node.id = options.id;
    if (options.text !== undefined) node.textContent = String(options.text);
    if (options.html !== undefined) node.innerHTML = String(options.html);
    if (options.title) node.title = options.title;
    if (options.hidden !== undefined) node.hidden = Boolean(options.hidden);
    if (options.disabled !== undefined) node.disabled = Boolean(options.disabled);
    if (options.value !== undefined) node.value = String(options.value);
    if (options.type) node.type = options.type;
    if (options.name) node.name = options.name;
    if (options.role) node.setAttribute('role', options.role);
    if (options.tabIndex !== undefined) node.tabIndex = options.tabIndex;
    if (options.dataset) for (const [key, value] of Object.entries(options.dataset)) {
        if (value !== undefined && value !== null) node.dataset[key] = String(value);
    }
    if (options.attrs) for (const [key, value] of Object.entries(options.attrs)) {
        if (value === false || value === null || value === undefined) continue;
        if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
    }
    if (options.on) for (const [event, handler] of Object.entries(options.on)) {
        if (typeof handler === 'function') node.addEventListener(event, handler);
    }
    append(node, children);
    return node;
}

export function clear(node) {
    node.replaceChildren();
    return node;
}

export function mount(target, content) {
    clear(target);
    append(target, content);
    return target;
}

export function text(value, { className = '', document } = {}) {
    return el('span', { className, text: value ?? '', document });
}

export function icon(className, { label = '', document } = {}) {
    return el('i', {
        className,
        document,
        attrs: label ? { 'aria-label': label } : { 'aria-hidden': 'true' },
    });
}

export function ensureUiRoot(node) {
    node?.classList?.add('nexus-ui');
    return node;
}
