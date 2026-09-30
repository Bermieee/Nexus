export function installRovingFocus(container, scope, { selector = '[data-roving-item]' } = {}) {
  scope.listen(container, 'keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const items = [...container.querySelectorAll(selector)].filter((item) => !item.disabled && item.offsetParent !== null);
    if (!items.length) return;
    const current = Math.max(0, items.indexOf(container.ownerDocument.activeElement));
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (current + 1) % items.length;
    else next = (current - 1 + items.length) % items.length;
    event.preventDefault();
    items[next].focus();
  });
}

export function trapFocus(container, event) {
  if (event.key !== 'Tab') return;
  const focusable = [...container.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.disabled && node.offsetParent !== null);
  if (!focusable.length) { event.preventDefault(); container.focus?.(); return; }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && container.ownerDocument.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && container.ownerDocument.activeElement === last) { event.preventDefault(); first.focus(); }
}

export function describeState(status) {
  return String(status ?? 'unknown').replaceAll('_', ' ').toLowerCase();
}
