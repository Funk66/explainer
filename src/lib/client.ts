// Browser-side helpers shared by interactive components.

/** Every interactive component root has data-component + data-state="pending|ready|error".
 *  The Playwright checker waits for all of them to leave "pending" and reports errors. */
export function markReady(el: HTMLElement) {
  el.dataset.state = 'ready';
  el.querySelector(':scope > .component-error')?.remove();
}

export function markError(el: HTMLElement, message: string) {
  el.dataset.state = 'error';
  el.dataset.error = message;
  console.error(`[${el.dataset.component}] ${message}`);
  let box = el.querySelector<HTMLElement>(':scope > .component-error');
  if (!box) {
    box = document.createElement('div');
    box.className = 'component-error';
    el.prepend(box);
  }
  box.textContent = `${el.dataset.component} failed to render: ${message}`;
}

export const isDark = () => document.documentElement.dataset.theme === 'ink';

export function onThemeChange(cb: () => void) {
  window.addEventListener('explainer:theme', cb);
}

let probe: HTMLSpanElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
/** Resolve any CSS colour expression (var(), color-mix(), oklch()) to #rrggbb(aa)
 *  so that libraries without modern CSS colour support (Mermaid, ECharts) can use it. */
export function cssColor(expr: string): string {
  if (!probe) {
    probe = document.createElement('span');
    probe.style.display = 'none';
    document.body.append(probe);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  probe.style.color = '';
  probe.style.color = expr;
  const resolved = getComputedStyle(probe).color;
  ctx!.clearRect(0, 0, 1, 1);
  ctx!.fillStyle = resolved;
  ctx!.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx!.getImageData(0, 0, 1, 1).data;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}${a < 255 ? hex(a) : ''}`;
}

export const mix = (v: string, pct: number, base = 'var(--color-base-100)') =>
  cssColor(`color-mix(in oklab, var(${v}) ${pct}%, ${base})`);

/** Categorical palette derived from the active theme. */
export function palette(): string[] {
  return ['--color-primary', '--color-secondary', '--color-accent', '--color-warning', '--color-info', '--color-error', '--color-success', '--color-neutral']
    .map((v) => cssColor(`var(${v})`));
}

export function readJSON<T>(el: HTMLElement, attr: string): T {
  return JSON.parse(el.getAttribute(attr) ?? 'null') as T;
}
