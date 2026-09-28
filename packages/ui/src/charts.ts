import { css, el, fmtDate, fmtDay, num, svgEl } from './utils.ts';

import type { TipRow, Tooltip } from './tooltip.ts';

/**
 * Nice round tick values covering [0, max]. The last tick is rounded *up* past
 * the data, so the top of the scale is never below the tallest mark — otherwise
 * marks draw outside the plot area and land on the title.
 */
export function ticks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let i = 0; i <= Math.round(top / step); i++) out.push(i * step);
  return out;
}

export interface LegendItem {
  name: string;
  color: string;
  shape?: 'line' | 'rect';
}

export function legend(c: HTMLElement, items: LegendItem[]): HTMLElement {
  const box = el('div', { class: 'legend' });
  for (const it of items) {
    const sw = el('i', { class: it.shape ?? 'line' });
    sw.style.background = it.color;
    box.append(el('span', {}, [sw, document.createTextNode(it.name)]));
  }
  c.append(box);
  return box;
}

const setNum = (node: Element, name: string, v: number): void => {
  node.setAttribute(name, String(v));
};

export interface Series {
  name: string;
  color: string;
  values: (number | null)[];
  xLabel?: (x: number) => string;
}

export interface TimeChartOptions {
  xs: number[];
  series: Series[];
  yFmt?: (v: number) => string;
  mode?: 'line' | 'area';
  height?: number;
  tip: Tooltip;
}

/**
 * Multi-series time chart with a snapping crosshair. `mode` is "line" or "area".
 * Every series must share the same x positions (we bucket before calling).
 */
export function timeChart(
  host: HTMLElement,
  { xs, series, yFmt = num, mode = 'line', height = 230, tip }: TimeChartOptions,
): void {
  const W = host.clientWidth || 800;
  const H = height;
  const pad = { t: 10, r: 14, b: 26, l: 46 };
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    height: H,
    role: 'img',
    'aria-label': host.dataset.label,
  });
  host.append(svg);
  if (!xs.length) {
    host.append(el('div', { class: 'empty', text: 'No data in range' }));
    return;
  }

  const maxY = Math.max(
    1,
    ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)),
  );
  const tks = ticks(maxY);
  const top = tks[tks.length - 1] ?? 1;
  const X = (i: number): number =>
    pad.l +
    (xs.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (xs.length - 1));
  const Y = (v: number): number => H - pad.b - (v / top) * (H - pad.t - pad.b);

  for (const t of tks) {
    svg.append(
      svgEl('line', {
        class: t === 0 ? 'baseline' : 'gridline',
        x1: pad.l,
        x2: W - pad.r,
        y1: Y(t),
        y2: Y(t),
      }),
    );
    svg.append(
      Object.assign(
        svgEl('text', { class: 'tick', x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }),
        { textContent: yFmt(t) },
      ),
    );
  }
  // Label cadence comes from the available width, not a fixed count, so a
  // narrow card thins the axis instead of running its dates together.
  const plotW = W - pad.l - pad.r;
  const stepLbl = Math.max(1, Math.ceil(xs.length / Math.max(2, Math.floor(plotW / 62))));
  const lastIdx = xs.length - 1;
  const labelled: number[] = [];
  for (let i = 0; i <= lastIdx; i += stepLbl) labelled.push(i);
  const lastLabelled = labelled[labelled.length - 1];
  if (lastLabelled !== lastIdx) {
    // Drop the penultimate tick when the always-drawn final one would crowd it.
    // The final label is end-anchored, so it reaches ~a full label-width left of
    // its tick — measure in pixels rather than in tick counts.
    if (lastLabelled !== undefined && X(lastIdx) - X(lastLabelled) < 96) labelled.pop();
    labelled.push(lastIdx);
  }
  for (const i of labelled) {
    const x = xs[i];
    if (x === undefined) continue;
    // The end labels sit on the plot edges, so anchor them inward or they clip.
    const anchor = i === lastIdx ? 'end' : i === 0 ? 'start' : 'middle';
    svg.append(
      Object.assign(
        svgEl('text', { class: 'tick', x: X(i), y: H - pad.b + 16, 'text-anchor': anchor }),
        { textContent: fmtDay(x) },
      ),
    );
  }

  for (const s of series) {
    const pts = s.values
      .map((v, i): [number, number] | null => (v === null ? null : [X(i), Y(v)]))
      .filter((p): p is [number, number] => p !== null);
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    if (mode === 'area') {
      const fill = svgEl('path', {
        d: `${d}L${last[0]},${Y(0)}L${first[0]},${Y(0)}Z`,
        fill: s.color,
        opacity: 0.1,
      });
      svg.append(fill);
    }
    svg.append(
      svgEl('path', {
        d,
        fill: 'none',
        stroke: s.color,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );
    svg.append(
      svgEl('circle', {
        cx: last[0],
        cy: last[1],
        r: 4,
        fill: s.color,
        stroke: css('--surface'),
        'stroke-width': 2,
      }),
    );
  }

  const hair = svgEl('line', { class: 'crosshair', y1: pad.t, y2: H - pad.b, opacity: 0 });
  svg.append(hair);
  const dots = series.map((s) => {
    const c = svgEl('circle', {
      cx: pad.l,
      cy: pad.t,
      r: 4,
      fill: s.color,
      stroke: css('--surface'),
      'stroke-width': 2,
      opacity: 0,
    });
    svg.append(c);
    return c;
  });
  const hit = svgEl('rect', { class: 'hit', x: pad.l, y: 0, width: W - pad.l - pad.r, height: H });
  svg.append(hit);
  const move = (ev: PointerEvent): void => {
    const box = svg.getBoundingClientRect();
    const rel = ((ev.clientX - box.left) / box.width) * W;
    const i = Math.max(
      0,
      Math.min(xs.length - 1, Math.round(((rel - pad.l) / (W - pad.l - pad.r)) * (xs.length - 1))),
    );
    const x = xs[i];
    if (x === undefined) return;
    setNum(hair, 'x1', X(i));
    setNum(hair, 'x2', X(i));
    setNum(hair, 'opacity', 1);
    dots.forEach((c, k) => {
      const v = series[k]?.values[i];
      if (v === null || v === undefined) {
        setNum(c, 'opacity', 0);
        return;
      }
      setNum(c, 'cx', X(i));
      setNum(c, 'cy', Y(v));
      setNum(c, 'opacity', 1);
    });
    const xLabel = series[0]?.xLabel;
    tip.show(
      ev,
      xLabel ? xLabel(x) : `Week of ${fmtDate(x)}`,
      series.map((s) => {
        const v = s.values[i];
        return {
          color: s.color,
          label: s.name,
          value: v === null || v === undefined ? '—' : yFmt(v),
        };
      }),
    );
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => {
    tip.hide();
    setNum(hair, 'opacity', 0);
    dots.forEach((c) => setNum(c, 'opacity', 0));
  });
}

export interface BarRow {
  label: string;
  value: number;
  sub?: string;
}

export interface BarChartOptions<R extends BarRow> {
  rows: R[];
  color: string;
  fmt?: (v: number) => string;
  max?: number | null;
  height?: number | null;
  tip?: ((r: R) => TipRow[]) | null;
  tooltip: Tooltip;
}

/** Horizontal bars: one measure, ranked. Direct-labelled at the tip. */
export function barChart<R extends BarRow>(
  host: HTMLElement,
  { rows, color, fmt = num, max = null, height = null, tip = null, tooltip }: BarChartOptions<R>,
): void {
  if (!rows.length) {
    host.append(el('div', { class: 'empty', text: 'No data in range' }));
    return;
  }
  const rowH = 26;
  const W = host.clientWidth || 700;
  const H = height ?? rows.length * rowH + 8;
  const labelW = Math.min(190, Math.max(...rows.map((r) => r.label.length)) * 7 + 12);
  const pad = { l: labelW, r: 52 };
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    height: H,
    role: 'img',
    'aria-label': host.dataset.label,
  });
  host.append(svg);
  rows.forEach((r, i) => {
    const y = i * rowH + 4;
    const bh = Math.min(18, rowH - 8);
    const w = Math.max(r.value > 0 ? 3 : 0, (r.value / top) * (W - pad.l - pad.r));
    svg.append(
      Object.assign(
        svgEl('text', {
          class: 'tick',
          x: pad.l - 10,
          y: y + bh / 2 + 4,
          'text-anchor': 'end',
          fill: css('--ink-2'),
        }),
        { textContent: r.label },
      ),
    );
    const path = svgEl('path', {
      d: `M${pad.l},${y} h${Math.max(0, w - 4)} a4,4 0 0 1 4,4 v${bh - 8} a4,4 0 0 1 -4,4 h${-Math.max(0, w - 4)} z`,
      fill: color,
      opacity: 0.92,
    });
    svg.append(path);
    svg.append(
      Object.assign(svgEl('text', { class: 'dlabel', x: pad.l + w + 8, y: y + bh / 2 + 4 }), {
        textContent: fmt(r.value),
      }),
    );
    const hit = svgEl('rect', { class: 'hit', x: 0, y: i * rowH, width: W, height: rowH });
    svg.append(hit);
    hit.addEventListener('pointermove', (ev) =>
      tooltip.show(
        ev,
        r.label,
        tip ? tip(r) : [{ color, label: r.sub ?? 'Count', value: fmt(r.value) }],
      ),
    );
    hit.addEventListener('pointerleave', tooltip.hide);
    hit.addEventListener('pointerenter', () => setNum(path, 'opacity', 1));
    hit.addEventListener('pointerleave', () => setNum(path, 'opacity', 0.92));
  });
}

export interface Bin {
  label: string;
  value: number;
  sub?: string;
  edge?: number;
}

export interface ColumnChartOptions {
  bins: Bin[];
  color: string;
  height?: number;
  valueFmt?: (v: number) => string;
  tipTitle?: (b: Bin) => string;
  tooltip: Tooltip;
}

/** Columns for a distribution. Buckets are pre-binned; labels go on the axis. */
export function columnChart(
  host: HTMLElement,
  {
    bins,
    color,
    height = 200,
    valueFmt = num,
    tipTitle = (b) => b.label,
    tooltip,
  }: ColumnChartOptions,
): void {
  const W = host.clientWidth || 700;
  const H = height;
  const pad = { t: 12, r: 8, b: 30, l: 42 };
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    height: H,
    role: 'img',
    'aria-label': host.dataset.label,
  });
  host.append(svg);
  if (!bins.length || bins.every((b) => !b.value)) {
    host.append(el('div', { class: 'empty', text: 'No data in range' }));
    return;
  }
  const tks = ticks(Math.max(1, ...bins.map((b) => b.value)));
  const top = tks[tks.length - 1] ?? 1;
  const Y = (v: number): number => H - pad.b - (v / top) * (H - pad.t - pad.b);
  for (const t of tks) {
    svg.append(
      svgEl('line', {
        class: t === 0 ? 'baseline' : 'gridline',
        x1: pad.l,
        x2: W - pad.r,
        y1: Y(t),
        y2: Y(t),
      }),
    );
    svg.append(
      Object.assign(
        svgEl('text', { class: 'tick', x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }),
        { textContent: valueFmt(t) },
      ),
    );
  }
  const band = (W - pad.l - pad.r) / bins.length;
  const bw = Math.min(24, band - 2);
  bins.forEach((b, i) => {
    const x = pad.l + i * band + (band - bw) / 2;
    const y = Y(b.value);
    const h = Math.max(b.value > 0 ? 2 : 0, H - pad.b - y);
    if (h > 0) {
      const r = Math.min(4, h);
      svg.append(
        svgEl('path', {
          d: `M${x},${y + r} a${r},${r} 0 0 1 ${r},${-r} h${bw - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} h${-bw} z`,
          fill: color,
          opacity: 0.92,
        }),
      );
    }
    svg.append(
      Object.assign(
        svgEl('text', { class: 'tick', x: x + bw / 2, y: H - pad.b + 16, 'text-anchor': 'middle' }),
        { textContent: b.label },
      ),
    );
    const hit = svgEl('rect', {
      class: 'hit',
      x: pad.l + i * band,
      y: pad.t,
      width: band,
      height: H - pad.t - pad.b,
    });
    svg.append(hit);
    hit.addEventListener('pointermove', (ev) =>
      tooltip.show(ev, tipTitle(b), [{ color, label: b.sub ?? 'PRs', value: num(b.value) }]),
    );
    hit.addEventListener('pointerleave', tooltip.hide);
  });
}

export interface HeatmapOptions {
  cells: number[][];
  rowLabels: string[];
  colLabels: string[];
  fmt?: (v: number) => string;
  title: string;
  tooltip: Tooltip;
}

/** Day-of-week × hour heatmap, sequential blue. */
export function heatmap(
  host: HTMLElement,
  { cells, rowLabels, colLabels, fmt = num, title, tooltip }: HeatmapOptions,
): void {
  const W = host.clientWidth || 700;
  const pad = { l: 38, t: 18, r: 8, b: 4 };
  const cw = (W - pad.l - pad.r) / colLabels.length;
  const ch = 22;
  const H = pad.t + rowLabels.length * ch + pad.b;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    height: H,
    role: 'img',
    'aria-label': host.dataset.label,
  });
  host.append(svg);
  const max = Math.max(1, ...cells.flat());
  const ramp = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7'].map(
    css,
  );
  colLabels.forEach((l, c) => {
    if (c % 3) return;
    svg.append(
      Object.assign(
        svgEl('text', {
          class: 'tick',
          x: pad.l + c * cw + cw / 2,
          y: 11,
          'text-anchor': 'middle',
        }),
        { textContent: l },
      ),
    );
  });
  rowLabels.forEach((rl, r) => {
    svg.append(
      Object.assign(
        svgEl('text', {
          class: 'tick',
          x: pad.l - 8,
          y: pad.t + r * ch + ch / 2 + 4,
          'text-anchor': 'end',
        }),
        { textContent: rl },
      ),
    );
    colLabels.forEach((cl, c) => {
      const v = cells[r]?.[c] ?? 0;
      const idx = v === 0 ? -1 : Math.min(ramp.length - 1, Math.floor((v / max) * ramp.length));
      const fill = idx < 0 ? css('--grid') : (ramp[idx] ?? '');
      const rect = svgEl('rect', {
        x: pad.l + c * cw + 1,
        y: pad.t + r * ch + 1,
        width: Math.max(1, cw - 2),
        height: ch - 2,
        rx: 3,
        fill,
        opacity: idx < 0 ? 0.45 : 1,
      });
      svg.append(rect);
      rect.style.cursor = 'default';
      rect.addEventListener('pointermove', (ev) =>
        tooltip.show(ev, `${rl}, ${cl}`, [{ color: fill, label: title, value: fmt(v) }]),
      );
      rect.addEventListener('pointerleave', tooltip.hide);
    });
  });
}
