import { RenderCost, WidgetCategory } from './constants.js';
import { VirtualListController } from './virtualization.js';

export function element(doc, tag, { className, text, attrs = {}, dataset = {} } = {}, ...children) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    const attributeOnly = key.startsWith('aria-') || key === 'role' || (node.tagName === 'INPUT' && key === 'list');
    if (!attributeOnly && key in node) {
      try { node[key] = value; continue; }
      catch {}
    }
    node.setAttribute(key, String(value));
  }
  Object.assign(node.dataset, dataset);
  // Callers pass child nodes as trailing arguments (headers with badges, key/value rows); they were silently dropped before.
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

export function makeBadge(doc, text, status = 'ready') {
  return element(doc, 'span', { className: 'nexus-badge', text, dataset: { status } });
}

export function makeHealthPill(doc, { label = 'Healthy', status = 'ready', detail = '' } = {}) {
  const pill = element(doc, 'span', { className: 'nexus-health-pill', attrs: { role: 'status', 'aria-label': detail ? `${label}: ${detail}` : label }, dataset: { status } });
  pill.append(element(doc, 'span', { text: label }));
  if (detail) pill.append(element(doc, 'span', { className: 'nexus-health-pill__detail', text: detail }));
  return pill;
}

export function makeStatusDot(doc, status, label = status) {
  return element(doc, 'span', { className: 'nexus-status-dot', attrs: { role: 'img', 'aria-label': label }, dataset: { status } });
}

export function makeCard(doc, { title, body, status, interactive = false } = {}) {
  const card = element(doc, interactive ? 'button' : 'article', { className: 'nexus-card', attrs: interactive ? { type: 'button' } : {}, dataset: status ? { status } : {} });
  if (title) card.append(element(doc, 'h3', { className: 'nexus-card__title', text: title }));
  if (typeof body === 'string') card.append(element(doc, 'p', { className: 'nexus-card__body', text: body }));
  else if (body) card.append(body);
  return card;
}

export function createButton(doc, { label = 'Button', icon = '', ariaLabel, disabled = false, onPress, scope, className = 'nexus-button', variant = 'secondary', size = 'md' } = {}) {
  const node = element(doc, 'button', { className, text: `${icon ? `${icon} ` : ''}${label}`, attrs: { type: 'button', disabled, 'aria-label': ariaLabel ?? label }, dataset: { variant, size } });
  if (onPress) {
    if (scope) scope.listen(node, 'click', onPress);
    else node.addEventListener('click', onPress);
  }
  return node;
}

export function createTextField(doc, { value = '', placeholder = '', label = 'Text field', type = 'text' } = {}) {
  return element(doc, 'input', { className: 'nexus-input', attrs: { type, value, placeholder, 'aria-label': label } });
}

export function createSelect(doc, { value, label = 'Select', options = [] } = {}) {
  const node = element(doc, 'select', { className: 'nexus-select', attrs: { 'aria-label': label } });
  for (const option of options) {
    const item = element(doc, 'option', { text: option.label ?? String(option.value), attrs: { value: option.value } });
    item.selected = option.value === value;
    node.append(item);
  }
  return node;
}

export function createToggle(doc, { checked = false, label = 'Toggle' } = {}) {
  return element(doc, 'button', { className: 'nexus-toggle', text: label, attrs: { type: 'button', role: 'switch', 'aria-checked': String(Boolean(checked)) }, dataset: { checked: String(Boolean(checked)) } });
}

export function createSlider(doc, { value = 0, min = 0, max = 100, step = 1, label = 'Slider' } = {}) {
  return element(doc, 'input', { className: 'nexus-slider', attrs: { type: 'range', value, min, max, step, 'aria-label': label } });
}

export function createKeyValue(doc, entries = []) {
  const dl = element(doc, 'dl', { className: 'nexus-key-values' });
  for (const entry of entries) dl.append(element(doc, 'dt', { text: entry.key }), element(doc, 'dd', { text: String(entry.value ?? '') }));
  return dl;
}

export function createProgressBar(doc, { value = 0, label = 'Progress' } = {}) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  const wrap = element(doc, 'div', { className: 'nexus-progress' });
  const bar = element(doc, 'div', { className: 'nexus-progress__bar', attrs: { role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': safe } });
  const fill = element(doc, 'div', { className: 'nexus-progress__fill' });
  fill.style.width = `${safe}%`;
  bar.append(fill);
  wrap.append(bar, element(doc, 'span', { text: `${safe}%` }));
  return wrap;
}

export function createProgressRing(doc, { value = 0, label = 'Progress' } = {}) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  return element(doc, 'div', { className: 'nexus-progress-ring', text: `${safe}%`, attrs: { role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': safe }, dataset: { value: String(safe) } });
}

export function createTimeline(doc, items = []) {
  const list = element(doc, 'ol', { className: 'nexus-timeline' });
  items.forEach((item) => list.append(element(doc, 'li', { text: item.label ?? String(item) })));
  return list;
}

export function createDataTable(doc, { columns = [], rows = [], caption = 'Data table' } = {}) {
  const table = element(doc, 'table', { className: 'nexus-data-table' });
  table.append(element(doc, 'caption', { text: caption }));
  const head = element(doc, 'thead');
  const headRow = element(doc, 'tr');
  columns.forEach((column) => headRow.append(element(doc, 'th', { text: column.label ?? column.key, attrs: { scope: 'col' } })));
  head.append(headRow);
  const body = element(doc, 'tbody');
  rows.forEach((row) => {
    const tr = element(doc, 'tr');
    columns.forEach((column) => tr.append(element(doc, 'td', { text: String(row[column.key] ?? '') })));
    body.append(tr);
  });
  table.append(head, body);
  return table;
}

export function createTabs(doc, { tabs = [], activeId } = {}) {
  const root = element(doc, 'div', { className: 'nexus-tabs' });
  const list = element(doc, 'div', { attrs: { role: 'tablist' } });
  for (const tab of tabs) {
    const active = tab.id === activeId;
    list.append(element(doc, 'button', { text: tab.label, attrs: { type: 'button', role: 'tab', 'aria-selected': String(active), tabindex: active ? 0 : -1 }, dataset: { tabId: tab.id } }));
  }
  root.append(list);
  return root;
}

export function createAccordion(doc, { title = 'Section', expanded = false, content = '' } = {}) {
  const details = element(doc, 'details', { className: 'nexus-accordion' });
  details.open = expanded;
  details.append(element(doc, 'summary', { text: title }));
  const body = element(doc, 'div', { className: 'nexus-accordion__body' });
  if (typeof content === 'string') body.textContent = content;
  else if (content) body.append(content);
  details.append(body);
  return details;
}

export function createSplitPane(doc, { primary = '', secondary = '' } = {}) {
  const root = element(doc, 'div', { className: 'nexus-split-pane' });
  const a = element(doc, 'section', { className: 'nexus-split-pane__primary' });
  const b = element(doc, 'section', { className: 'nexus-split-pane__secondary' });
  if (typeof primary === 'string') a.textContent = primary; else if (primary) a.append(primary);
  if (typeof secondary === 'string') b.textContent = secondary; else if (secondary) b.append(secondary);
  root.append(a, b);
  return root;
}

export function createStateMessage(doc, { kind = 'ready', title = kind, message = '' } = {}) {
  const root = element(doc, 'div', { className: 'nexus-state-message', attrs: { role: kind === 'error' ? 'alert' : 'status' }, dataset: { status: kind } });
  root.append(element(doc, 'strong', { text: title }), element(doc, 'span', { text: message }));
  return root;
}

function domWidget(widgetId, category, renderCostClass, renderer) {
  return {
    widgetId, version: '1.0.0', category, propsSchema: { type: 'object' },
    supportedActions: [], subscriptions: [], permissions: [], renderCostClass,
    create({ host, props, scope }) {
      const render = (next = props) => host.replaceChildren(renderer(host.ownerDocument, next, scope));
      return { mount: () => render(props), update: (next) => render(next) };
    },
  };
}

export function registerPrimitiveWidgets(registry) {
  const P = WidgetCategory.PRIMITIVE;
  const S = WidgetCategory.STRUCTURAL;
  const cheap = RenderCost.CHEAP;
  const normal = RenderCost.NORMAL;

  registry.register(domWidget('primitive.Button', P, cheap, (doc, p, scope) => createButton(doc, { ...p, scope })));
  registry.register(domWidget('primitive.IconButton', P, cheap, (doc, p, scope) => createButton(doc, { ...p, label: p.label ?? '', ariaLabel: p.ariaLabel ?? p.title ?? 'Icon button', scope, className: 'nexus-icon-button' })));
  registry.register(domWidget('primitive.Badge', P, cheap, (doc, p) => makeBadge(doc, p.text ?? p.label ?? '', p.status)));
  registry.register(domWidget('primitive.HealthPill', P, cheap, (doc, p) => makeHealthPill(doc, p)));
  registry.register(domWidget('primitive.StatusDot', P, cheap, (doc, p) => makeStatusDot(doc, p.status ?? 'ready', p.label)));
  registry.register(domWidget('primitive.TextField', P, cheap, (doc, p) => createTextField(doc, p)));
  registry.register(domWidget('primitive.SearchField', P, cheap, (doc, p) => createTextField(doc, { ...p, type: 'search', label: p.label ?? 'Search' })));
  registry.register(domWidget('primitive.Select', P, cheap, (doc, p) => createSelect(doc, p)));
  registry.register(domWidget('primitive.Toggle', P, cheap, (doc, p) => createToggle(doc, p)));
  registry.register(domWidget('primitive.Slider', P, cheap, (doc, p) => createSlider(doc, p)));

  registry.register(domWidget('information.Card', S, normal, (doc, p) => makeCard(doc, p)));
  registry.register(domWidget('information.StatCard', S, normal, (doc, p) => makeCard(doc, { title: p.title, body: `${p.value ?? '—'}${p.unit ? ` ${p.unit}` : ''}`, status: p.status })));
  registry.register(domWidget('information.KeyValue', S, cheap, (doc, p) => createKeyValue(doc, p.entries ?? [])));
  registry.register(domWidget('information.ProgressBar', S, cheap, (doc, p) => createProgressBar(doc, p)));
  registry.register(domWidget('information.ProgressRing', S, cheap, (doc, p) => createProgressRing(doc, p)));
  registry.register(domWidget('information.Timeline', S, normal, (doc, p) => createTimeline(doc, p.items ?? [])));
  registry.register(domWidget('information.DataTable', S, normal, (doc, p) => createDataTable(doc, p)));

  registry.register({ widgetId: 'information.VirtualList', version: '1.0.0', category: S, propsSchema: { type: 'object', required: ['items'] }, supportedActions: [], subscriptions: [], permissions: [], renderCostClass: normal,
    create({ host, props, scope }) {
      const controller = new VirtualListController({ host, items: props.items, itemSize: props.itemSize ?? 40, renderItem: props.renderItem ?? ((item) => String(item)), scope });
      return { mount: () => controller.mount(), update(next) { controller.setItems(next.items); } };
    },
  });

  registry.register(domWidget('container.Panel', S, normal, (doc, p) => makeCard(doc, { title: p.title, body: p.content ?? '' })));
  registry.register(domWidget('container.Section', S, normal, (doc, p) => { const section = element(doc, 'section', { className: 'nexus-section' }); if (p.title) section.append(element(doc, 'h2', { text: p.title })); if (p.content) typeof p.content === 'string' ? section.append(element(doc, 'p', { text: p.content })) : section.append(p.content); return section; }));
  registry.register(domWidget('container.Tabs', S, normal, (doc, p) => createTabs(doc, p)));
  registry.register(domWidget('container.Accordion', S, normal, (doc, p) => createAccordion(doc, p)));
  registry.register(domWidget('container.SplitPane', S, normal, (doc, p) => createSplitPane(doc, p)));
  registry.register(domWidget('container.Drawer', S, normal, (doc, p) => { const node = element(doc, 'aside', { className: 'nexus-drawer-contract', attrs: { 'aria-label': p.title ?? 'Drawer' } }); node.textContent = p.content ?? ''; return node; }));
  registry.register(domWidget('container.Modal', S, normal, (doc, p) => { const node = element(doc, 'section', { className: 'nexus-modal-contract', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': p.title ?? 'Modal' } }); node.textContent = p.content ?? ''; return node; }));
  registry.register(domWidget('feedback.Toast', S, cheap, (doc, p) => createStateMessage(doc, { ...p, kind: p.status ?? 'ready' })));
  registry.register(domWidget('feedback.Banner', S, cheap, (doc, p) => createStateMessage(doc, { ...p, kind: p.status ?? 'ready' })));
  registry.register(domWidget('feedback.LoadingState', S, cheap, (doc, p) => createStateMessage(doc, { kind: 'loading', title: p.title ?? 'Loading', message: p.message ?? '' })));
  registry.register(domWidget('feedback.EmptyState', S, cheap, (doc, p) => createStateMessage(doc, { kind: 'empty', title: p.title ?? 'Nothing here yet', message: p.message ?? '' })));
  registry.register(domWidget('feedback.ErrorState', S, cheap, (doc, p) => createStateMessage(doc, { kind: 'error', title: p.title ?? 'Unable to load', message: p.message ?? '' })));
}
