import { el } from './utils.ts';

export interface TipRow {
  color?: string;
  label: string;
  value: string;
}

export interface PointerLike {
  clientX: number;
  clientY: number;
}

export interface Tooltip {
  show(ev: PointerLike, title: string, rows: TipRow[]): void;
  hide(): void;
}

export function createTooltip(tt: HTMLElement): Tooltip {
  const show = (ev: PointerLike, title: string, rows: TipRow[]): void => {
    tt.textContent = '';
    tt.append(el('div', { class: 'h', text: title }));
    for (const r of rows) {
      const row = el('div', { class: 'row' });
      if (r.color) {
        const key = el('i');
        key.style.background = r.color;
        row.append(key);
      }
      row.append(document.createTextNode(r.label));
      row.append(el('b', { text: r.value }));
      tt.append(row);
    }
    tt.dataset.open = '1';
    const pad = 14;
    const r = tt.getBoundingClientRect();
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
    tt.style.left = `${Math.max(8, x)}px`;
    tt.style.top = `${Math.max(8, y)}px`;
  };
  const hide = (): void => {
    tt.dataset.open = '0';
  };
  return { show, hide };
}
