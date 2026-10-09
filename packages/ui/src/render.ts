import {
  STALE_DAYS,
  areaActivity,
  areaBreakdown,
  busFactor,
  contributorRows,
  cycleTimeTrend,
  headline,
  mergeHeatmap,
  mergeTimeBins,
  oldestOpen,
  openBacklog,
  reviewDepth,
  reviewPairs,
  reviewerRows,
  roster,
  scope,
  sizeBins,
  standouts,
  throughput,
  timeBuckets,
  topReviewers,
  windowed,
} from '@bilan/core';

import { DASH, barChart, columnChart, heatmap, legend, timeChart } from './charts.ts';
import { person, prLink, svgPerson } from './person.ts';
import { table } from './table.ts';
import { HOUR, compact, css, dur, el, fmtDate, fmtUtc, num, pctFmt, plural } from './utils.ts';

import type { Bin } from './charts.ts';
import type { DashboardContext } from './state.ts';
import type { Col } from './table.ts';
import type {
  ContributorRow,
  DepthBand,
  MetricPr,
  Period,
  ReviewerRow,
  TimeUnit,
} from '@bilan/core';

const S1 = (): string => css('--s1');
const S2 = (): string => css('--s2');
const S3 = (): string => css('--s3');
/**
 * Each chart ink keeps one line pattern wherever it appears, so a series reads
 * without its hue: blue is solid, green dashed, brown dotted.
 */
const L1 = (): { color: string; dash: typeof DASH.solid } => ({ color: S1(), dash: DASH.solid });
const L2 = (): { color: string; dash: typeof DASH.dotted } => ({ color: S2(), dash: DASH.dotted });
const L3 = (): { color: string; dash: typeof DASH.dashed } => ({ color: S3(), dash: DASH.dashed });

export function card(cls: string, title: string, desc?: string): HTMLDivElement {
  const c = el('div', { class: `card ${cls}` }, [el('h2', { text: title })]);
  if (desc) c.append(el('p', { class: 'desc', text: desc }));
  return c;
}

/** The node a chart draws into; the card's title becomes the chart's accessible name. */
export function chartHost(c: HTMLElement): HTMLDivElement {
  const h = el('div');
  const title = c.querySelector(':scope > h2')?.textContent;
  if (title) h.dataset.label = title;
  c.append(h);
  return h;
}

/** A mean such as threads per PR, to one decimal. */
const perPr = (v: number | null): string => (v === null ? '—' : v.toFixed(1));

/**
 * Hours as the dashboard's durations (`18h`, `2.4d`, `1.2mo`), years past
 * twelve months (`9.7y`) so an outlier week still fits the axis gutter; a
 * bare `0` on the baseline.
 */
export const hoursFmt = (v: number): string => {
  if (v === 0) return '0';
  const years = v / (365 * 24);
  return years >= 1 ? `${years.toFixed(1)}y` : dur(v * HOUR);
};

/** How the trend charts' descriptions name a bucket. */
const BUCKET_WORDS: Record<TimeUnit, { name: string; every: string; many: string }> = {
  day: { name: 'UTC day', every: 'Daily', many: 'Days' },
  week: { name: 'ISO week', every: 'Weekly', many: 'Weeks' },
};

interface PeriodNames {
  /** The period on its own, in a tooltip. */
  label: (t: number) => string;
  /** The period under its column. */
  tick: (t: number) => string;
  /** What the columns are, above the row labels. */
  title: string;
}

/** Periods are UTC buckets, so they are named in UTC. */
const PERIOD_NAMES: Record<Period, PeriodNames> = {
  day: {
    label: (t) => fmtUtc(t, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
    tick: (t) => fmtUtc(t, { month: 'short', day: 'numeric' }),
    title: 'Day',
  },
  week: {
    label: (t) => `week of ${fmtUtc(t, { month: 'short', day: 'numeric', year: 'numeric' })}`,
    tick: (t) => fmtUtc(t, { month: 'short', day: 'numeric' }),
    title: 'Week of',
  },
  month: {
    label: (t) => fmtUtc(t, { month: 'short', year: 'numeric' }),
    tick: (t) => fmtUtc(t, { month: 'short', year: 'numeric' }),
    title: 'Month',
  },
};

interface Insight {
  text: string;
  /** Plain text, or text with a PR link in it. */
  detail: string | (Node | string)[];
  bad: boolean;
}

export function render(ctx: DashboardContext): void {
  const { root, data, prs, last: LAST, tip, bots } = ctx;
  const w = windowed(scope(prs, bots, ctx.state, LAST), LAST);
  const { merged, opened, winReviews, stillOpen } = w;
  const app = root.querySelector<HTMLElement>('#app');
  if (!app) return;
  app.textContent = '';
  tip.hide();

  const note = root.querySelector('#scope-note');
  if (note) {
    // Full history already holds every open PR; a bounded sync says whether its open pass finished.
    const coverage =
      data.coverageSince === null
        ? 'full history'
        : `covers activity since ${fmtDate(Date.parse(data.coverageSince))} · ${data.interrupted || data.openPrsSyncedAt === null ? 'open PRs partially synced' : 'plus all open PRs'}`;
    const freshness = data.interrupted
      ? data.reconciledAt == null
        ? 'No complete sync yet'
        : `Last complete sync: ${new Date(data.reconciledAt).toLocaleString()}`
      : new Date(data.syncedAt ?? 0).toLocaleString();
    note.textContent = `${prs.length.toLocaleString()} PRs synced · ${freshness} · ${coverage}`;
  }

  /* ---- headline tiles ---- */
  const H = headline(w);
  const tiles = el('div', { class: 'tiles' });
  // The frame clips the tiles' outer separators, so a short last row is plain surface.
  const frame = el('div', { class: 'tiles-frame' }, [tiles]);
  // Seven equal readings: the brief's sentence above them provides the lead.
  const tile = (k: string, v: string, d: string): void => {
    const t = el('div', { class: 'tile' }, [el('div', { class: 'k', text: k })]);
    t.append(el('div', { class: 'v', text: v }));
    if (d) t.append(el('div', { class: 'd', text: d }));
    tiles.append(t);
  };
  tile('PRs opened', H.opened.toLocaleString(), plural(H.authors, 'author'));
  tile('Merged', H.merged.toLocaleString(), `${pctFmt(H.mergedShare)} of resolved`);
  tile('Closed unmerged', H.rejected.toLocaleString(), `${H.stillOpen} still open`);
  tile('Median time to merge', dur(H.medMerge), `p90 ${dur(H.p90Merge)} · from ready`);
  tile('Median time to first review', dur(H.medFirst), `${pctFmt(H.reviewedShare)} ever reviewed`);
  tile('Median time in draft', dur(H.medReady), `${pctFmt(H.draftShare)} opened as draft`);
  tile('Reviews given', H.reviews.toLocaleString(), plural(H.reviewers, 'reviewer'));
  app.append(frame);

  const grid = el('div', { class: 'grid' });
  app.append(grid);

  /* ---- time buckets shared by the trend charts ---- */
  // Seven days would be two partial weeks, so that range is read day by day.
  const bucket: TimeUnit = ctx.state.range === '7' ? 'day' : 'week';
  const words = BUCKET_WORDS[bucket];
  const tb = timeBuckets(w, LAST, bucket);
  const xs = tb.starts;
  // A day is named outright in the crosshair; a week keeps the chart's `Week of …`.
  const xLabel = bucket === 'day' ? PERIOD_NAMES.day.label : undefined;

  /* 1. throughput */
  {
    const t = throughput(w, tb);
    const c = card(
      'twothirds',
      'Throughput',
      `PRs opened, merged, and closed without merging, bucketed by ${words.name}. The last point is the current, partial ${bucket}.`,
    );
    legend(c, [
      { name: 'Opened', ...L1() },
      { name: 'Merged', ...L3() },
      { name: 'Closed unmerged', ...L2() },
    ]);
    const h = chartHost(c);
    grid.append(c);
    queueMicrotask(() =>
      timeChart(h, {
        xs,
        xLabel,
        mode: 'line',
        series: [
          { name: 'Opened', ...L1(), values: t.opened },
          { name: 'Merged', ...L3(), values: t.merged },
          { name: 'Closed unmerged', ...L2(), values: t.closed },
        ],
        tip,
      }),
    );
  }

  /* 2. open backlog */
  {
    const backlog = openBacklog(w, tb);
    const c = card(
      'third',
      'Open PR backlog',
      `PRs still open at the end of each ${bucket}, and how many of those were still drafts. Drafts are counted from the ready-for-review event, so they are part of the open line, not in addition to it.`,
    );
    legend(c, [
      { name: 'Open', ...L1() },
      { name: 'Drafts', ...L2() },
    ]);
    const h = chartHost(c);
    grid.append(c);
    queueMicrotask(() =>
      timeChart(h, {
        xs,
        xLabel,
        mode: 'area',
        series: [
          { name: 'Open', ...L1(), values: backlog.open },
          { name: 'Drafts', ...L2(), values: backlog.drafts },
        ],
        tip,
      }),
    );
  }

  /* 3. cycle-time trend */
  {
    const trend = cycleTimeTrend(w, tb);
    const c = card(
      '',
      'Cycle time trend',
      `${words.every} median time from ready-for-review to first review, and to merge. ${words.many} with no data are skipped; the last point is the current, partial ${bucket}.`,
    );
    legend(c, [
      { name: 'Ready → first review', ...L2() },
      { name: 'Ready → merged', ...L3() },
    ]);
    const h = chartHost(c);
    grid.append(c);
    queueMicrotask(() =>
      timeChart(h, {
        xs,
        xLabel,
        mode: 'line',
        yFmt: hoursFmt,
        series: [
          { name: 'Ready → first review', ...L2(), values: trend.toFirst },
          { name: 'Ready → merged', ...L3(), values: trend.toMerge },
        ],
        tip,
      }),
    );
  }

  /* 4. time-to-merge distribution */
  {
    const bins: Bin[] = mergeTimeBins(merged).map((b) => ({
      label: b.label,
      value: b.value,
      sub: 'PRs merged',
      edge: b.edge,
    }));
    const c = card(
      'half',
      'Time to merge',
      'Ready-for-review to merge, for PRs merged in range. The long tail is where review debt hides.',
    );
    const h = chartHost(c);
    grid.append(c);
    queueMicrotask(() => columnChart(h, { bins, color: S3(), tooltip: tip }));
  }

  /* 5. PR size distribution */
  {
    const bins: Bin[] = sizeBins(opened).map((b) => ({
      label: b.label,
      value: b.value,
      sub: 'PRs opened',
    }));
    const c = card('half', 'PR size', 'Lines added + deleted per PR opened in range.');
    const h = chartHost(c);
    grid.append(c);
    queueMicrotask(() => columnChart(h, { bins, color: S1(), tooltip: tip }));
  }

  /* 6. areas */
  {
    const rows = areaBreakdown(merged)
      .slice(0, 20)
      .map(([label, value]) => ({
        label,
        value,
        sub: 'Merged PRs',
      }));
    const c = card(
      'half',
      'Where the work lands',
      'Merged PRs in the 20 busiest areas. An area is a top-level folder, or a package of the folder most PRs share. A PR touching two areas counts in both; areas come from a sample of up to 30 changed files.',
    );
    const h = chartHost(c);
    grid.append(c);
    queueMicrotask(() => barChart(h, { rows, color: S1(), paths: true, tooltip: tip }));
  }

  /* 7. merge timing heatmap */
  {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
    // Core gives day × hour; the chart reads hours down the side and days across.
    const byDay = mergeHeatmap(merged);
    const cells = hours.map((_, h) => days.map((__, d) => byDay[d]?.[h] ?? 0));
    const c = card(
      'half',
      'When PRs get merged',
      'Local time of merge. Stronger blue means more merges.',
    );
    const h = chartHost(c);
    grid.append(c);
    queueMicrotask(() =>
      heatmap(h, {
        cells,
        rowLabels: hours,
        colLabels: days,
        rowHeight: 8,
        rowStep: 3,
        tipTitle: (hour, day) => `${day}, ${hour}`,
        title: 'Merges',
        tooltip: tip,
      }),
    );
  }

  /* 8. area activity over time */
  {
    // Weeks would run to hundreds of columns over a whole history.
    const unit: Period = ctx.state.range === 'all' ? 'month' : bucket;
    const names = PERIOD_NAMES[unit];
    const { periods, rows } = areaActivity(w, unit);
    const c = card(
      '',
      'Where the work moves',
      `Merged PRs per ${unit} in the busiest areas, with each area's total in range. Color follows the square root of the count, so quieter areas still show beside the busiest. With an area selected, the other rows are areas its PRs also touched. The last column is the current, partial ${unit}.`,
    );
    const h = chartHost(c);
    grid.append(c);
    queueMicrotask(() =>
      heatmap(h, {
        cells: rows.map((r) => r.counts),
        rowLabels: rows.map((r) => r.area),
        colLabels: periods.map(names.label),
        colAxis: periods.map(names.tick),
        colTitle: names.title,
        totals: rows.map((r) => r.total),
        scale: 'sqrt',
        paths: true,
        title: 'Merged PRs',
        tooltip: tip,
      }),
    );
  }

  /* ---- per-person aggregation (authoring + reviewing in one row) ---- */
  const people = roster(w);

  /* 9. contributor table */
  {
    const c = card(
      '',
      'Contributors',
      'Authoring and reviewing side by side. Sort by any column. Durations start at ready-for-review, so draft time is not charged to review latency.',
    );
    const h = chartHost(c);
    grid.append(c);
    const cols: Col<ContributorRow>[] = [
      {
        key: 'login',
        label: 'Contributor',
        val: (r) => r.login,
        fmt: (v) => String(v ?? ''),
        node: (v) => person(String(v ?? ''), bots),
      },
      { key: 'opened', label: 'Opened', val: (r) => r.opened, bar: true },
      { key: 'merged', label: 'Merged', val: (r) => r.merged },
      { key: 'closed', label: 'Closed', val: (r) => r.closed, cls: 'dim' },
      { key: 'open', label: 'Open', val: (r) => r.open, cls: 'dim' },
      { key: 'rate', label: 'Merge rate', val: (r) => r.mergeRate, fmt: pctFmt },
      {
        key: 'draft',
        label: 'Med. draft',
        help: 'Median time from opening a draft to marking it ready',
        val: (r) => r.medDraft,
        fmt: dur,
        cls: 'dim',
      },
      { key: 'first', label: 'Med. to 1st review', val: (r) => r.medFirst, fmt: dur },
      { key: 'merge', label: 'Med. to merge', val: (r) => r.medMerge, fmt: dur },
      { key: 'p90', label: 'p90 to merge', val: (r) => r.p90Merge, fmt: dur, cls: 'dim' },
      {
        key: 'size',
        label: 'Med. size',
        help: 'Median lines added + deleted',
        val: (r) => r.medSize,
        fmt: (v) => (typeof v === 'number' ? compact(v) : '—'),
      },
      { key: 'add', label: '+ lines', val: (r) => r.add, fmt: compact, cls: 'dim' },
      { key: 'del', label: '− lines', val: (r) => r.del, fmt: compact, cls: 'dim' },
      { key: 'areas', label: 'Areas', val: (r) => r.areas, cls: 'dim' },
      { key: 'given', label: 'Reviews given', val: (r) => r.reviewsGiven, bar: true },
      {
        key: 'ratio',
        label: 'Review : PR',
        help: 'Reviews given per PR opened — balance of giving vs. asking',
        val: (r) => r.reviewRatio,
        fmt: (v) => (typeof v === 'number' ? v.toFixed(1) : '—'),
      },
    ];
    table(h, cols, contributorRows(people), 'opened');
  }

  /* 10. reviewer table */
  {
    const reviewers = reviewerRows(people, winReviews.length);
    const c = card(
      'twothirds',
      'Reviewers',
      "Review volume, verdict mix, and turnaround. Turnaround runs from the review request (or ready-for-review) to that reviewer's first review on the PR.",
    );
    const h = chartHost(c);
    grid.append(c);
    const cols: Col<ReviewerRow>[] = [
      {
        key: 'login',
        label: 'Reviewer',
        val: (r) => r.login,
        fmt: (v) => String(v ?? ''),
        node: (v) => person(String(v ?? ''), bots),
      },
      { key: 'given', label: 'Reviews', val: (r) => r.reviews, bar: true },
      { key: 'prs', label: 'PRs reviewed', val: (r) => r.prsReviewed },
      { key: 'share', label: 'Share', val: (r) => r.share, fmt: pctFmt, cls: 'dim' },
      { key: 'appr', label: 'Approved', val: (r) => r.approvals },
      { key: 'chg', label: 'Changes req.', val: (r) => r.changesReq },
      { key: 'cmt', label: 'Comment only', val: (r) => r.commentsOnly, cls: 'dim' },
      {
        key: 'strict',
        label: 'Pushback rate',
        help: "Share of this reviewer's reviews that requested changes",
        val: (r) => r.pushback,
        fmt: (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—'),
      },
      { key: 'resp', label: 'Med. turnaround', val: (r) => r.medTurnaround, fmt: dur },
      { key: 'p90', label: 'p90 turnaround', val: (r) => r.p90Turnaround, fmt: dur, cls: 'dim' },
      { key: 'authors', label: 'Authors helped', val: (r) => r.authorsHelped, cls: 'dim' },
    ];
    table(h, cols, reviewers, 'given');
    if (!reviewers.length) h.append(el('div', { class: 'empty', text: 'No reviews in range' }));
  }

  /* 11. review concentration */
  {
    const rows = topReviewers(people).map((r) => ({
      label: String(r.login),
      labelNodes: () => [svgPerson(String(r.login), bots)],
      value: r.reviews,
      rec: r,
    }));
    const c = card('third', 'Top reviewers', 'Who carries the review load.');
    const h = chartHost(c);
    grid.append(c);
    queueMicrotask(() =>
      barChart(h, {
        rows,
        color: S2(),
        tip: (r) => [
          { color: S2(), label: 'Reviews', value: num(r.value) },
          { label: 'PRs reviewed', value: num(r.rec.prsReviewed) },
          { label: 'Median turnaround', value: dur(r.rec.medTurnaround) },
        ],
        tooltip: tip,
      }),
    );
  }

  /* 12. review depth by PR size */
  {
    const bands = reviewDepth(w);
    const c = card(
      'split',
      'Review depth by PR size',
      'Review threads per PR merged in range, by lines added + deleted: scrutiny should grow with the change. Approved, no threads: every review was an approval and nobody opened a review thread. Threads opened by bot reviewers count too, since GitHub does not say who opened a thread, so these figures overstate human discussion.',
    );
    const h = chartHost(c);
    const t = chartHost(c);
    grid.append(c);
    const bins = bands.map((b) => ({ label: b.label, value: b.threads ?? 0, band: b }));
    queueMicrotask(() =>
      columnChart(h, {
        bins,
        color: S2(),
        // Ticks run in quarters below one thread per PR.
        valueFmt: (v) => String(Math.round(v * 100) / 100),
        tip: ({ band }) => [
          { color: S2(), label: 'Threads per PR', value: perPr(band.threads) },
          { label: 'PRs merged', value: num(band.merged) },
          { label: 'Approved, no threads', value: pctFmt(band.quietShare) },
        ],
        // Zero threads is a reading, not a gap: the chart is empty only when nothing merged.
        empty: !merged.length,
        tooltip: tip,
      }),
    );
    if (merged.length) {
      const cols: Col<DepthBand>[] = [
        { key: 'band', label: 'Lines changed', val: (b) => b.edge, fmt: (_, b) => b.label },
        { key: 'merged', label: 'Merged', val: (b) => b.merged },
        {
          key: 'quiet',
          label: 'Approved, no threads',
          help: 'Share of merged PRs whose reviews were all approvals, with no review thread',
          val: (b) => b.quietShare,
          fmt: pctFmt,
          bar: true,
        },
        {
          key: 'threads',
          label: 'Threads / PR',
          help: 'Mean review threads per merged PR',
          val: (b) => b.threads,
          fmt: perPr,
        },
        {
          key: 'appr',
          label: 'Med. to approval',
          help: 'Median time from ready-for-review to the first approval',
          val: (b) => b.medApproval,
          fmt: dur,
        },
      ];
      table(t, cols, bands, 'band', true);
    }
  }

  /* 13. collaboration pairs */
  {
    const rows = reviewPairs(winReviews).map((p) => ({
      label: `${p.reviewer} → ${p.author}`,
      labelNodes: () => [
        svgPerson(p.reviewer, bots),
        document.createTextNode(' → '),
        svgPerson(p.author, bots),
      ],
      value: p.reviews,
      sub: 'Reviews',
    }));
    const c = card(
      'half',
      'Strongest review pairs',
      'Reviewer → author. Heavy concentration here means knowledge is pooling in pairs.',
    );
    const h = chartHost(c);
    grid.append(c);
    queueMicrotask(() => barChart(h, { rows, color: S3(), tooltip: tip }));
  }

  /* 14. area ownership / bus factor */
  {
    const rows = busFactor(merged).map((r) => ({
      label: r.area,
      value: r.bus,
      total: r.total,
      contributors: r.contributors,
      top: r.top,
      topShare: r.topShare,
    }));
    const c = card(
      'half',
      'Bus factor by area',
      'How many people it takes to account for half the merged PRs in an area. 1 means one person carries it. Areas with fewer than 5 merged PRs are omitted.',
    );
    const h = chartHost(c);
    grid.append(c);
    queueMicrotask(() =>
      barChart(h, {
        rows,
        color: S2(),
        fmt: (v) => String(v),
        tip: (r) => [
          { color: S2(), label: 'Bus factor', value: String(r.value) },
          { label: 'Contributors', value: num(r.contributors) },
          { label: 'Merged PRs', value: num(r.total) },
          { label: `Top: ${r.top}`, value: pctFmt(r.topShare) },
        ],
        paths: true,
        tooltip: tip,
      }),
    );
  }

  /* 15. insights */
  {
    const s = standouts(w, people);
    const candidates: (Insight | false | 0)[] = [
      s.merged && {
        text: `${pctFmt(s.unreviewedShare)} of merged PRs had no review from anyone else`,
        detail: `${s.unreviewed} of ${s.merged} merges`,
        bad: s.merged ? s.unreviewedShare > 0.25 : false,
      },
      s.merged && {
        text: `${pctFmt(s.approvedShare)} of merged PRs carried an explicit approval`,
        detail: `${s.approved} of ${s.merged}`,
        bad: s.approvedShare < 0.6,
      },
      s.merged && {
        text: `${pctFmt(s.selfMergedShare)} of merges were done by the PR author`,
        detail: 'Self-merge is fine with prior approval, worth watching without one',
        bad: false,
      },
      s.reviewers >= 3 && {
        text: `The top 3 reviewers give ${pctFmt(s.top3Share)} of all reviews`,
        detail: `${s.reviewers} people reviewed at all`,
        bad: s.top3Share > 0.5,
      },
      s.merged && {
        text: `${pctFmt(s.fastShare)} of PRs merged within an hour of becoming ready`,
        detail: `${s.fast} PRs — usually trivial or pre-reviewed`,
        bad: false,
      },
      s.opened && {
        text: `${pctFmt(s.draftShare)} of PRs were opened as drafts`,
        detail: `median ${dur(s.medReady)} spent in draft`,
        bad: false,
      },
      s.merged && {
        text: `${pctFmt(s.weekendShare)} of merges happened on a weekend`,
        detail: `${s.weekendMerges} merges on Sat/Sun`,
        bad: s.weekendShare > 0.1,
      },
      s.stale && {
        text: `${s.stale} open PRs are older than ${STALE_DAYS} days`,
        detail: s.oldest
          ? [
              'oldest is ',
              prLink(data.repo, s.oldest.n, `#${s.oldest.n}`),
              `, opened ${fmtDate(s.oldest.c)}`,
            ]
          : '',
        bad: s.stale > 20,
      },
      s.reverts && {
        text: `${s.reverts} revert PRs opened in range`,
        detail: `${pctFmt(s.revertShare)} of all PRs opened`,
        bad: s.revertShare > 0.03,
      },
      s.readied && {
        text: `${pctFmt(s.firstWithinDayShare)} of PRs got their first review within a day`,
        detail: `p90 wait is ${dur(s.p90First)}`,
        bad: false,
      },
    ];
    const items = candidates.filter((it): it is Insight => Boolean(it));

    const c = card(
      'half',
      'What stands out',
      'Computed against the current filters. Amber items are the ones worth a second look.',
    );
    const list = el('ul', { class: 'insights' });
    for (const it of items) {
      const dot = el('span', { class: 'ico' });
      dot.style.cssText = `width:7px;height:7px;margin-top:6px;background:${it.bad ? css('--warning') : css('--s1')}`;
      const body = el('div', {}, [el('b', { text: it.text })]);
      if (it.detail) body.append(el('div', { class: 'mono' }, it.detail));
      list.append(el('li', {}, [dot, body]));
    }
    c.append(list);
    grid.append(c);
  }

  /* 16. oldest open PRs */
  {
    const rows = oldestOpen(stillOpen);
    const c = card(
      'half',
      'Oldest open PRs',
      'Sorted by age. These are where the backlog actually lives.',
    );
    const h = chartHost(c);
    grid.append(c);
    if (!rows.length) h.append(el('div', { class: 'empty', text: 'Nothing open in range' }));
    else {
      const cols: Col<MetricPr>[] = [
        {
          key: 'title',
          label: 'PR',
          val: (p) => p.t,
          fmt: (v, p) => {
            const t = String(v);
            return `#${p.n} ${t.length > 54 ? `${t.slice(0, 54)}…` : t}`;
          },
          node: (v, p) => {
            const t = String(v);
            return prLink(data.repo, p.n, `#${p.n} ${t.length > 54 ? `${t.slice(0, 54)}…` : t}`);
          },
        },
        {
          key: 'author',
          label: 'Author',
          val: (p) => p.a ?? '—',
          fmt: (v) => String(v ?? ''),
          node: (v, p) => (p.a === null ? document.createTextNode('—') : person(p.a, bots)),
        },
        { key: 'age', label: 'Age', val: (p) => LAST - p.c, fmt: dur },
        {
          key: 'draft',
          label: 'State',
          val: (p) => (p.dr ? 1 : 0),
          fmt: (v) => (v ? 'draft' : 'ready'),
          cls: 'dim',
        },
        { key: 'rev', label: 'Reviews', val: (p) => p.rv.length },
        { key: 'size', label: 'Size', val: (p) => p.size, fmt: compact, cls: 'dim' },
      ];
      table(h, cols, rows, 'age');
    }
  }
}
