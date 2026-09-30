import { ResponsiveMode } from './constants.js';

export function resolveResponsiveMode(width, { wide = 1180, compact = 760 } = {}) {
  if (width >= wide) return ResponsiveMode.WIDE;
  if (width >= compact) return ResponsiveMode.COMPACT;
  return ResponsiveMode.STACKED;
}

export class ResponsiveController {
  constructor({ root, onChange, thresholds, scope }) {
    this.root = root;
    this.onChange = onChange;
    this.thresholds = thresholds;
    this.scope = scope;
    this.mode = null;
  }

  evaluate(width = this.root?.clientWidth || globalThis.innerWidth || 1280) {
    const next = resolveResponsiveMode(width, this.thresholds);
    if (next !== this.mode) {
      this.mode = next;
      this.root?.setAttribute?.('data-layout', next);
      this.onChange?.(next);
    }
    return next;
  }

  mount() {
    this.evaluate();
    if (globalThis.ResizeObserver && this.root) {
      const observer = new ResizeObserver((entries) => this.evaluate(entries[0]?.contentRect?.width));
      this.scope.observer(observer, this.root);
    } else if (globalThis.addEventListener) {
      this.scope.listen(globalThis, 'resize', () => this.evaluate());
    }
  }
}
