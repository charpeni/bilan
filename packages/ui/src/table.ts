import { el, num } from './utils.ts';

export type SortValue = string | number | null | undefined;

/**
 * A table column. `val` returns the sort value; `fmt` renders it. Both are
 * declared as methods so column-specific formatters such as `dur` or `pctFmt`
 * (which accept a narrower value type) remain assignable.
 */
export interface Col<T> {
  key: string;
  label: string;
  help?: string;
  cls?: string;
  bar?: boolean;
  val(r: T): SortValue;
  fmt?(v: SortValue, r: T): string;
}

const render = <T>(c: Col<T>, v: SortValue, r: T): string =>
  c.fmt ? c.fmt(v, r) : num(typeof v === 'number' ? v : null);

/** Sortable table. cols: {key,label,fmt,val,bar?} — `val` returns the sort number. */
export function table<T>(host: HTMLElement, cols: Col<T>[], rows: T[], initial: string): void {
  let sortKey = initial;
  let asc = false;
  const wrap = el('div', { class: 'tablewrap' });
  const tbl = el('table');
  const thead = el('thead');
  const tr = el('tr');
  for (const c of cols) {
    const th = el('th', { text: c.label, title: c.help ?? c.label });
    th.addEventListener('click', () => {
      if (sortKey === c.key) asc = !asc;
      else {
        sortKey = c.key;
        asc = false;
      }
      draw();
    });
    tr.append(th);
  }
  thead.append(tr);
  tbl.append(thead);
  const tbody = el('tbody');
  tbl.append(tbody);
  wrap.append(tbl);
  host.append(wrap);

  function draw(): void {
    for (const [i, c] of cols.entries()) {
      const th = tr.children[i];
      if (!th) continue;
      if (c.key === sortKey) th.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    }
    const col = cols.find((c) => c.key === sortKey);
    if (!col) return;
    const sorted = rows.toSorted((a, b) => {
      const va = col.val(a);
      const vb = col.val(b);
      const na = va === null || va === undefined;
      const nb = vb === null || vb === undefined;
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'string') {
        return asc ? va.localeCompare(String(vb)) : String(vb).localeCompare(va);
      }
      return asc ? Number(va) - Number(vb) : Number(vb) - Number(va);
    });
    tbody.textContent = '';
    for (const r of sorted) {
      const line = el('tr');
      for (const c of cols) {
        const v = c.val(r);
        const td = el('td', { class: c.cls ?? '' });
        if (c.bar) {
          td.classList.add('bar-cell');
          const max = Math.max(1, ...rows.map((x) => Number(c.val(x) ?? 0)));
          const fill = el('div', { class: 'fill' });
          fill.style.width = `${(Number(v ?? 0) / max) * 100}%`;
          td.append(fill);
          td.append(el('span', { text: render(c, v, r) }));
        } else {
          td.textContent = render(c, v, r);
        }
        line.append(td);
      }
      tbody.append(line);
    }
  }
  draw();
}
