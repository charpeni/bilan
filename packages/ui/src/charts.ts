import { css, el, fitPath, fmtDate, fmtDay, num, svgEl } from './utils.ts';

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

/**
 * Line patterns, so a series never depends on hue alone: solid, dashed (6,3),
 * and dotted (2,3), as SVG `stroke-dasharray` values ('' is solid).
 */
export const DASH = { solid: '', dashed: '6 3', dotted: '2 3' } as const;
export type Dash = (typeof DASH)[keyof typeof DASH];

export interface LegendItem {
  name: string;
  color: string;
  shape?: 'line' | 'rect';
  /** The series' line pattern; solid when omitted. */
  dash?: Dash;
}

/** The swatch's CSS background: the colour, broken into the same dashes as the line. */
function swatch(color: string, dash: Dash | undefined): string {
  const [on, off] = (dash ?? '').split(' ').map(Number);
  if (!on || !off) return color;
  return `repeating-linear-gradient(90deg, ${color} 0 ${on}px, transparent ${on}px ${on + off}px)`;
}

export function legend(c: HTMLElement, items: LegendItem[]): HTMLElement {
  const box = el('div', { class: 'legend' });
  for (const it of items) {
    const sw = el('i', { class: it.shape ?? 'line' });
    sw.style.background = it.shape === 'rect' ? it.color : swatch(it.color, it.dash);
    box.append(el('span', {}, [sw, document.createTextNode(it.name)]));
  }
  c.append(box);
  return box;
}

/** Resting opacity of bars and columns; the hovered one goes to full ink. */
const REST = 0.9;
/** Side of the square point markers on line charts, in px. */
const MARK = 8;
/** Stroke width of every line series, in px. */
const STROKE = 2;
/** Direct labels at the line ends take over from the legend from this viewport width. */
const DIRECT_LABELS_MIN = 768;
/** Vertical room one end label needs, in px. */
const LABEL_GAP = 16;
/** Approximate advance of one character of an end label (12.5px Archivo), in px. */
const LABEL_CHAR = 6.9;

const setNum = (node: Element, name: string, v: number): void => {
  node.setAttribute(name, String(v));
};

export interface Series {
  name: string;
  color: string;
  values: (number | null)[];
  xLabel?: (x: number) => string;
  /** The line pattern; solid when omitted. */
  dash?: Dash;
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
 * Spread end labels so none overlaps the next: each keeps its own y where it
 * can, and a crowded group is pushed apart evenly, inside [lo, hi].
 */
export function spreadLabels(ys: number[], gap: number, lo: number, hi: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).toSorted((a, b) => a.y - b.y);
  const out = order.map((o) => Math.min(hi, Math.max(lo, o.y)));
  for (let k = 1; k < out.length; k++) {
    const prev = out[k - 1] ?? lo;
    if ((out[k] ?? 0) < prev + gap) out[k] = prev + gap;
  }
  const overflow = (out[out.length - 1] ?? hi) - hi;
  if (overflow > 0) {
    for (let k = out.length - 1; k >= 0; k--) {
      const next = k === out.length - 1 ? hi + gap : (out[k + 1] ?? hi);
      out[k] = Math.min(out[k] ?? hi, next - gap);
    }
  }
  const result: number[] = Array.from({ length: ys.length }, () => 0);
  order.forEach((o, k) => {
    result[o.i] = out[k] ?? o.y;
  });
  return result;
}

/**
 * Multi-series time chart with a snapping crosshair. `mode` is "line" or "area".
 * Every series must share the same x positions (we bucket before calling).
 * From 768px wide, and when the plot keeps most of the width, each series is
 * named at its line end and the card's legend is set aside for assistive
 * technology (the host gets `data-direct="1"`).
 */
export function timeChart(
  host: HTMLElement,
  { xs, series, yFmt = num, mode = 'line', height = 230, tip }: TimeChartOptions,
): void {
  const W = host.clientWidth || 800;
  const H = height;
  const labelW = Math.ceil(Math.max(0, ...series.map((s) => s.name.length)) * LABEL_CHAR) + 24;
  const wide =
    typeof window.matchMedia === 'function' &&
    window.matchMedia(`(min-width: ${DIRECT_LABELS_MIN}px)`).matches;
  const direct = wide && series.length > 1 && W - 46 - labelW >= W * 0.55;
  host.dataset.direct = direct ? '1' : '0';
  const pad = { t: 10, r: direct ? labelW : 14, b: 26, l: 46 };
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

  const ends: { s: Series; x: number; y: number }[] = [];
  for (const s of series) {
    const pts = s.values
      .map((v, i): [number, number] | null => (v === null ? null : [X(i), Y(v)]))
      .filter((p): p is [number, number] => p !== null);
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) continue;
    ends.push({ s, x: last[0], y: last[1] });
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    if (mode === 'area') {
      const fill = svgEl('path', {
        d: `${d}L${last[0]},${Y(0)}L${first[0]},${Y(0)}Z`,
        fill: s.color,
        opacity: 0.08,
      });
      svg.append(fill);
    }
    svg.append(
      svgEl('path', {
        d,
        fill: 'none',
        stroke: s.color,
        'stroke-width': STROKE,
        'stroke-dasharray': s.dash || null,
        'stroke-linejoin': 'miter',
        'stroke-linecap': 'butt',
      }),
    );
    // The latest point gets a square marker, as on a plotted datasheet curve.
    svg.append(
      svgEl('rect', {
        x: last[0] - MARK / 2,
        y: last[1] - MARK / 2,
        width: MARK,
        height: MARK,
        fill: s.color,
        stroke: css('--page'),
        'stroke-width': 2,
      }),
    );
  }

  // Direct labels: each series named in the right gutter, level with its last
  // point where there is room, joined to it by a leader in its colour and dash.
  if (direct && ends.length) {
    const gx = W - pad.r;
    const ys = spreadLabels(
      ends.map((e) => e.y),
      LABEL_GAP,
      pad.t + 4,
      H - pad.b - 2,
    );
    ends.forEach((e, k) => {
      const ly = ys[k] ?? e.y;
      svg.append(
        svgEl('path', {
          class: 'leader',
          d: `M${(e.x + MARK / 2 + 2).toFixed(1)},${e.y.toFixed(1)}L${(gx + 8).toFixed(1)},${ly.toFixed(1)}L${(gx + 16).toFixed(1)},${ly.toFixed(1)}`,
          fill: 'none',
          stroke: e.s.color,
          'stroke-width': 1.5,
          'stroke-dasharray': e.s.dash || null,
        }),
      );
      const label = svgEl('text', {
        class: 'elabel',
        x: gx + 20,
        y: ly + 4.5,
        'aria-hidden': 'true',
      });
      label.textContent = e.s.name;
      svg.append(label);
    });
  }

  const hair = svgEl('line', { class: 'crosshair', y1: pad.t, y2: H - pad.b, opacity: 0 });
  svg.append(hair);
  const dots = series.map((s) => {
    const c = svgEl('rect', {
      x: pad.l - MARK / 2,
      y: pad.t - MARK / 2,
      width: MARK,
      height: MARK,
      fill: s.color,
      stroke: css('--page'),
      'stroke-width': 1.5,
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
      setNum(c, 'x', X(i) - MARK / 2);
      setNum(c, 'y', Y(v) - MARK / 2);
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

/** Approximate advance of one character of a row label (12.5px Archivo), in px. */
const ROW_CHAR = 7;

/**
 * Set a folder path in `text`, cut to `chars` characters: its name in a
 * darker ink than its folders, so a column of paths reads by their ends.
 */
function pathLabel(text: SVGTextElement, path: string, chars: number): void {
  const [dir, name] = fitPath(path, chars);
  // Inline styles, as `.tick` would override fill attributes.
  text.style.fill = 'var(--ink-2)';
  if (dir) {
    text.append(
      Object.assign(svgEl('tspan', { style: 'fill: var(--muted)' }), { textContent: dir }),
    );
  }
  text.append(name);
}

export interface BarRow {
  label: string;
  value: number;
  sub?: string;
  /**
   * The label's content when it holds links (people): text nodes and SVG
   * anchors whose text, concatenated, equals `label`. `label` still sizes the
   * gutter and names the tooltip.
   */
  labelNodes?: () => Node[];
}

export interface BarChartOptions<R extends BarRow> {
  rows: R[];
  color: string;
  fmt?: (v: number) => string;
  max?: number | null;
  height?: number | null;
  tip?: ((r: R) => TipRow[]) | null;
  /** The labels are folder paths: the gutter may grow, and they are cut from the front. */
  paths?: boolean;
  tooltip: Tooltip;
}

/** Horizontal bars: one measure, ranked. Direct-labelled at the tip. */
export function barChart<R extends BarRow>(
  host: HTMLElement,
  {
    rows,
    color,
    fmt = num,
    max = null,
    height = null,
    tip = null,
    paths = false,
    tooltip,
  }: BarChartOptions<R>,
): void {
  if (!rows.length) {
    host.append(el('div', { class: 'empty', text: 'No data in range' }));
    return;
  }
  const rowH = 26;
  const W = host.clientWidth || 700;
  const H = height ?? rows.length * rowH + 8;
  // Paths keep their tails when cut, so they may take more of a wide chart.
  const cap = paths ? Math.max(190, W * 0.4) : 190;
  const labelW = Math.min(cap, Math.max(...rows.map((r) => r.label.length)) * ROW_CHAR + 12);
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
    // A thin, square-ended bar centred in its row.
    const bh = 12;
    const y = i * rowH + (rowH - bh) / 2;
    const w = Math.max(r.value > 0 ? 3 : 0, (r.value / top) * (W - pad.l - pad.r));
    // Names, not figures: the bar labels are set in the grotesk, the axes in the monospace.
    const label = svgEl('text', {
      class: 'tick blabel',
      x: pad.l - 10,
      y: y + bh / 2 + 4,
      'text-anchor': 'end',
      fill: css('--ink-2'),
    });
    if (r.labelNodes) label.append(...r.labelNodes());
    else if (paths) pathLabel(label, r.label, Math.floor((labelW - 12) / ROW_CHAR));
    else label.textContent = r.label;
    svg.append(label);
    const path = svgEl('path', {
      class: 'mark',
      d: `M${pad.l},${y} h${w} v${bh} h${-w} z`,
      fill: color,
      opacity: REST,
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
    hit.addEventListener('pointerleave', () => setNum(path, 'opacity', REST));
  });
}

export interface Bin {
  label: string;
  value: number;
  sub?: string;
  edge?: number;
}

export interface ColumnChartOptions<B extends Bin> {
  bins: B[];
  color: string;
  height?: number;
  valueFmt?: (v: number) => string;
  tipTitle?: (b: B) => string;
  /** The tooltip's rows; `sub` and the count when omitted. */
  tip?: ((b: B) => TipRow[]) | null;
  /** Nothing to draw; by default, when every bin is zero (a count). A rate passes its own. */
  empty?: boolean;
  tooltip: Tooltip;
}

/** Columns for a distribution. Buckets are pre-binned; labels go on the axis. */
export function columnChart<B extends Bin>(
  host: HTMLElement,
  {
    bins,
    color,
    height = 200,
    valueFmt = num,
    tipTitle = (b) => b.label,
    tip = null,
    empty = bins.every((b) => !b.value),
    tooltip,
  }: ColumnChartOptions<B>,
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
  if (!bins.length || empty) {
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
  const bw = Math.min(18, band - 2);
  bins.forEach((b, i) => {
    const x = pad.l + i * band + (band - bw) / 2;
    const y = Y(b.value);
    const h = Math.max(b.value > 0 ? 2 : 0, H - pad.b - y);
    let column: SVGPathElement | null = null;
    if (h > 0) {
      column = svgEl('path', {
        class: 'mark',
        d: `M${x},${H - pad.b - h} h${bw} v${h} h${-bw} z`,
        fill: color,
        opacity: REST,
      });
      svg.append(column);
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
      tooltip.show(
        ev,
        tipTitle(b),
        tip ? tip(b) : [{ color, label: b.sub ?? 'PRs', value: num(b.value) }],
      ),
    );
    hit.addEventListener('pointerleave', tooltip.hide);
    if (column) {
      const mark = column;
      hit.addEventListener('pointerenter', () => setNum(mark, 'opacity', 1));
      hit.addEventListener('pointerleave', () => setNum(mark, 'opacity', REST));
    }
  });
}

export interface HeatmapOptions {
  cells: number[][];
  rowLabels: string[];
  colLabels: string[];
  fmt?: (v: number) => string;
  title: string;
  tooltip: Tooltip;
  /** Row height in px; 22 by default, tighter when there are many rows (hours). */
  rowHeight?: number;
  /** Label every nth row / column (1: all of them). */
  rowStep?: number;
  colStep?: number;
  /** The tooltip's title for a cell; `row, col` by default. */
  tipTitle?: (rowLabel: string, colLabel: string) => string;
  /**
   * A title per column, set from its left edge: as many as fit, at a regular
   * step that ends on the latest. Replaces the centred `colLabels` on the axis.
   */
  colAxis?: string[];
  /** What the columns are (`Week of`), above the row labels. */
  colTitle?: string;
  /** A total per row, in a column at the right. */
  totals?: number[];
  /**
   * How a count maps onto the ramp: linear, or by its square root, which
   * keeps small counts visible beside one dominant row.
   */
  scale?: 'linear' | 'sqrt';
  /** The row labels are folder paths: the gutter fits them, cut from the front past a share of the width. */
  paths?: boolean;
}

/** Advance of one character of an axis label (12px monospace), in px. */
const TICK_CHAR = 7.2;
/** Width of the totals column, in px. */
const TOTAL_W = 48;

/** Sequential-blue heatmap (hour × day of week, area × period); an empty cell is plain `--heat-0`. */
export function heatmap(
  host: HTMLElement,
  {
    cells,
    rowLabels,
    colLabels,
    fmt = num,
    title,
    tooltip,
    rowHeight = 22,
    rowStep = 1,
    colStep = 1,
    tipTitle = (rl, cl) => `${rl}, ${cl}`,
    colAxis,
    colTitle,
    totals,
    scale = 'linear',
    paths = false,
  }: HeatmapOptions,
): void {
  if (!rowLabels.length || !colLabels.length) {
    host.append(el('div', { class: 'empty', text: 'No data in range' }));
    return;
  }
  const W = host.clientWidth || 700;
  // The row labels' column also holds the columns' title, whole.
  const titleW = (colTitle ?? '').length * TICK_CHAR + 12;
  const gutter = paths
    ? Math.max(
        titleW,
        Math.min(
          Math.max(...rowLabels.map((l) => l.length)) * ROW_CHAR + 12,
          Math.max(110, W * 0.3),
        ),
      )
    : Math.max(44, titleW);
  const pad = { l: gutter, t: 18, r: totals ? TOTAL_W : 8, b: 4 };
  const cw = (W - pad.l - pad.r) / colLabels.length;
  // Gaps between cells only while the cells stay wide enough to read.
  const inset = cw < 5 ? 0 : 1;
  const ch = rowHeight;
  const H = pad.t + rowLabels.length * ch + pad.b;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    height: H,
    role: 'img',
    'aria-label': host.dataset.label,
  });
  host.append(svg);
  const level = scale === 'sqrt' ? Math.sqrt : (v: number): number => v;
  const max = Math.max(1, ...cells.flat());
  const ramp = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7'].map(
    css,
  );
  const tick = (attrs: Record<string, string | number>, text: string): void => {
    svg.append(Object.assign(svgEl('text', { class: 'tick', ...attrs }), { textContent: text }));
  };
  if (colTitle) tick({ x: pad.l - 10, y: 11, 'text-anchor': 'end' }, colTitle);
  if (colAxis) {
    const width = (l: string): number => l.length * TICK_CHAR;
    // Titles stop short of the totals' own title.
    const right = totals ? W - 2 - width('Total') - 6 : W - pad.r;
    const step = Math.max(1, Math.ceil((Math.max(...colAxis.map(width)) + 8) / cw));
    let last = colAxis.length - 1;
    while (last > 0 && pad.l + last * cw + inset + width(colAxis[last] ?? '') > right) last--;
    for (let c = last % step; c <= last; c += step) {
      tick({ x: pad.l + c * cw + inset, y: 11, 'text-anchor': 'start' }, colAxis[c] ?? '');
    }
  } else {
    colLabels.forEach((l, c) => {
      if (c % colStep) return;
      tick({ x: pad.l + c * cw + cw / 2, y: 11, 'text-anchor': 'middle' }, l);
    });
  }
  if (totals) tick({ x: W - 2, y: 11, 'text-anchor': 'end' }, 'Total');
  rowLabels.forEach((rl, r) => {
    const y = pad.t + r * ch + ch / 2 + 4;
    if (paths) {
      const label = svgEl('text', { class: 'tick blabel', x: pad.l - 10, y, 'text-anchor': 'end' });
      pathLabel(label, rl, Math.floor((pad.l - 12) / ROW_CHAR));
      svg.append(label);
    } else if (r % rowStep === 0) {
      tick({ x: pad.l - 8, y, 'text-anchor': 'end' }, rl);
    }
    const total = totals?.[r];
    if (total !== undefined) {
      svg.append(
        Object.assign(svgEl('text', { class: 'dlabel', x: W - 2, y, 'text-anchor': 'end' }), {
          textContent: fmt(total),
        }),
      );
    }
    colLabels.forEach((cl, c) => {
      const v = cells[r]?.[c] ?? 0;
      const idx =
        v === 0 ? -1 : Math.min(ramp.length - 1, Math.floor((level(v) / level(max)) * ramp.length));
      const fill = idx < 0 ? css('--heat-0') : (ramp[idx] ?? '');
      const rect = svgEl('rect', {
        x: pad.l + c * cw + inset,
        y: pad.t + r * ch + 1,
        width: Math.max(1, cw - 2 * inset),
        height: ch - 2,
        fill,
      });
      svg.append(rect);
      rect.style.cursor = 'default';
      rect.addEventListener('pointermove', (ev) =>
        tooltip.show(ev, tipTitle(rl, cl), [{ color: fill, label: title, value: fmt(v) }]),
      );
      rect.addEventListener('pointerenter', () => {
        rect.setAttribute('stroke', css('--ink'));
        rect.setAttribute('stroke-width', '1.5');
      });
      rect.addEventListener('pointerleave', () => {
        rect.removeAttribute('stroke');
        rect.removeAttribute('stroke-width');
      });
      rect.addEventListener('pointerleave', tooltip.hide);
    });
  });
}
