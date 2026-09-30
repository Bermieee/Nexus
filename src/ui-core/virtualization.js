export function computeVirtualWindow({ count, itemSize, viewportSize, scrollOffset, overscan = 4 }) {
  const safeCount = Math.max(0, Number(count) || 0);
  const safeItem = Math.max(1, Number(itemSize) || 1);
  const safeViewport = Math.max(0, Number(viewportSize) || 0);
  const maxStart = Math.max(0, safeCount - 1);
  const visibleStart = Math.min(maxStart, Math.max(0, Math.floor((Number(scrollOffset) || 0) / safeItem)));
  const visibleCount = Math.ceil(safeViewport / safeItem);
  const start = Math.max(0, visibleStart - overscan);
  const end = Math.min(safeCount, visibleStart + visibleCount + overscan);
  return Object.freeze({ start, end, offset: start * safeItem, totalSize: safeCount * safeItem });
}

export class VirtualListController {
  constructor({ host, items = [], itemSize = 40, overscan = 5, renderItem, keyForItem, scope }) {
    this.host = host;
    this.items = items;
    this.itemSize = itemSize;
    this.overscan = overscan;
    this.renderItem = renderItem;
    this.keyForItem = keyForItem ?? ((item, index) => item?.id ?? index);
    this.scope = scope;
    this.viewport = null;
    this.canvas = null;
  }

  mount() {
    const doc = this.host.ownerDocument;
    this.viewport = doc.createElement('div');
    this.viewport.className = 'a52-virtual-list';
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('role', 'list');
    this.canvas = doc.createElement('div');
    this.canvas.className = 'a52-virtual-list__canvas';
    this.viewport.append(this.canvas);
    this.host.replaceChildren(this.viewport);
    this.scope.listen(this.viewport, 'scroll', () => this.render());
    this.render();
  }

  setItems(items) { this.items = items ?? []; this.render(); }

  render() {
    if (!this.viewport) return;
    const viewportSize = this.viewport.clientHeight || 360;
    const window = computeVirtualWindow({
      count: this.items.length,
      itemSize: this.itemSize,
      viewportSize,
      scrollOffset: this.viewport.scrollTop,
      overscan: this.overscan,
    });
    this.canvas.style.height = `${window.totalSize}px`;
    const doc = this.host.ownerDocument;
    const fragment = doc.createDocumentFragment();
    for (let index = window.start; index < window.end; index++) {
      const item = this.items[index];
      const row = doc.createElement('div');
      row.className = 'a52-virtual-list__row';
      row.dataset.key = String(this.keyForItem(item, index));
      row.style.transform = `translateY(${index * this.itemSize}px)`;
      row.style.height = `${this.itemSize}px`;
      row.setAttribute('role', 'listitem');
      const rendered = this.renderItem(item, index, doc);
      if (typeof rendered === 'string') row.textContent = rendered;
      else if (rendered) row.append(rendered);
      fragment.append(row);
    }
    this.canvas.replaceChildren(fragment);
  }
}
