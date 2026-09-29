import { brief, change } from '@bilan/core';

import { person, prUrl } from './person.ts';
import { coversDays } from './range.ts';
import { DAY, dur, el, fmtDate, num, svgEl } from './utils.ts';

import type { Range } from './range.ts';
import type { DashboardContext } from './state.ts';

/** A piece of a brief line: text, or a login to show as a profile link. */
export type Frag = string | { who: string };
/** A line of the brief: plain text, or text with people in it. */
export type Line = string | Frag[];

interface BriefLink {
  n: number;
  t: string;
  meta: Frag[];
}

export interface BriefItem {
  tag: string;
  title: string;
  body: Line[];
  watch: boolean;
  links?: BriefLink[];
}

/** A PR's author as a fragment; a PR without one (deleted account) prints a dash. */
const author = (login: string | null): Frag[] => (login === null ? ['—'] : [{ who: login }]);

/** `a, b, c` over fragment runs. */
const joinFrags = (runs: Frag[][], sep: string): Frag[] =>
  runs.flatMap((run, i) => (i ? [sep, ...run] : run));

/** Where the reader's choice to open the brief is kept. */
export const BRIEF_EXPANDED_KEY = 'bilan.brief.expanded';

export interface BriefSummary {
  /** The one line shown while the brief is collapsed. */
  headline: string;
  /** How many further items are flagged "worth a look" beyond the one shown. */
  more: number;
}

/**
 * What the collapsed brief says: the first item flagged "worth a look" (the
 * items are already ordered flagged-first), else the throughput headline;
 * and how many more flagged items wait behind it.
 */
export function briefSummaryLine(items: readonly BriefItem[]): BriefSummary {
  const flagged = items.filter((it) => it.watch);
  const lead = flagged[0] ?? items.find((it) => it.tag === 'Throughput') ?? items[0];
  return { headline: lead?.title ?? '', more: flagged.length ? flagged.length - 1 : 0 };
}

/** `· 3 more worth a look`, or nothing. */
export const moreText = (more: number): string => (more > 0 ? `· ${more} more worth a look` : '');

const readExpanded = (): boolean => {
  try {
    return localStorage.getItem(BRIEF_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
};
const writeExpanded = (expanded: boolean): void => {
  try {
    localStorage.setItem(BRIEF_EXPANDED_KEY, expanded ? '1' : '0');
  } catch {
    /* storage may be unavailable; the choice still applies to this page */
  }
};

/** Mirrors the original's implicit `null -> 0` coercion in arithmetic comparisons. */
const n0 = (v: number | null): number => v ?? 0;
const pctInt = (v: number): string => `${Math.round(v * 100)}%`;
/** "+12%", "−12%", "flat", or "new"; `unsigned` drops the sign. */
const changeFmt = (now: number, before: number, unsigned = false): string => {
  const d = change(now, before);
  if (d === null) return 'new';
  if (d === 0) return 'flat';
  return `${unsigned ? '' : d > 0 ? '+' : '−'}${Math.abs(d)}%`;
};

/** The brief compares the last 30 days with the 30 before, so it needs this much history. */
export const BRIEF_COMPARE_DAYS = 60;

/**
 * Whether the payload holds enough history for the brief's "vs the previous
 * 30 days" comparisons. With the default 30-day coverage the previous period is
 * simply not there, and every delta would read as "new" or +100%. The check is
 * strict (no display slack): 59 days of coverage is a truncated previous period.
 */
export const canCompare = (coverageSince: string | null, last: number): boolean =>
  coversDays(coverageSince, last, BRIEF_COMPARE_DAYS);

export const COMPARE_NOTE = `Comparisons appear once ${BRIEF_COMPARE_DAYS} days are synced.`;

/** The range a host syncs to make the comparisons possible: the smallest one past 60 days. */
export const COMPARE_RANGE = '90' satisfies Range;

/**
 * A fixed "last 30 days vs the 30 before" read-out at the top of the page.
 * It deliberately ignores the filter row: it is the same briefing for every
 * reader, regenerated from the data on each build. Bots are excluded except
 * in the automation item, which is about them. When the payload does not
 * reach back 60 days, the current period is read out on its own: no deltas,
 * no "before" figures. First-ever claims ("new contributors") need the whole
 * history, so they only appear when coverage is full.
 */
export function renderBrief(ctx: DashboardContext): void {
  const { root, data, prs, bots, last: LAST } = ctx;
  const host = root.querySelector<HTMLElement>('#brief');
  if (!host) return;
  host.textContent = '';
  const frag = (f: Frag): Node | string => (typeof f === 'string' ? f : person(f.who, bots));
  const line = (l: Line): (Node | string)[] => (typeof l === 'string' ? [l] : l.map(frag));
  const compare = canCompare(data.coverageSince, LAST);
  /** `text` only when the previous period is there to compare against. */
  const vs = (text: string): string => (compare ? text : '');
  /** Full history: the only state in which "never seen before" can be claimed. */
  const fullHistory = data.coverageSince === null;

  const { cur: A, prev: B, reviewLoad, automation, areas, backlog, churn } = brief(prs, bots, LAST);
  const items: BriefItem[] = [];

  /* throughput */
  {
    const dm = (B.merged.length ? A.merged.length / B.merged.length : 0) - 1;
    items.push({
      tag: 'Throughput',
      title: compare
        ? `${num(A.merged.length)} PRs merged, ${changeFmt(A.merged.length, B.merged.length)} on the previous 30 days`
        : `${num(A.merged.length)} PRs merged in the last 30 days`,
      body: [
        `${num(A.opened.length)} opened by ${A.authors} authors${vs(` (${B.authors} before)`)}. ${num(A.closed.length)} closed without merging.`,
      ],
      watch: compare && (dm < -0.15 || A.authors < B.authors * 0.8),
    });
  }

  /* size */
  {
    const grew = compare && (n0(A.medSize) > n0(B.medSize) * 1.5 || A.xl > B.xl + 0.04);
    items.push({
      tag: 'PR size',
      title: `The median PR is ${num(A.medSize)} lines${vs(`, ${n0(A.medSize) >= n0(B.medSize) ? 'up from' : 'down from'} ${num(B.medSize)}`)}`,
      body: [
        `${pctInt(A.xl)} of PRs change more than 1,000 lines${vs(` (${pctInt(B.xl)} before)`)}.`,
        `Small PRs (≤100 lines) get a first review in ${dur(A.small.first)} and merge in ${dur(A.small.merge)}. PRs over 1,000 lines wait ${dur(A.large.first)} and ${dur(A.large.merge)}.`,
      ],
      watch: grew,
    });
  }

  /* review speed */
  {
    const slower = (compare && n0(A.medFirst) > n0(B.medFirst) * 1.25) || A.within1d < 0.7;
    items.push({
      tag: 'Review speed',
      title: `Median first review in ${dur(A.medFirst)}${vs(` (was ${dur(B.medFirst)})`)}`,
      body: [
        `${pctInt(A.within1d)} of ready PRs got a review within a day${vs(` (${pctInt(B.within1d)} before)`)}.`,
        `Median time to merge is ${dur(A.medMerge)}${vs(` (was ${dur(B.medMerge)})`)}; ${pctInt(A.overWeek)} of merges took over a week${vs(` (${pctInt(B.overWeek)} before)`)}.`,
      ],
      watch: slower,
    });
  }

  /* review load */
  {
    const { top, top3Share, imbalance, drop } = reviewLoad;
    const body: Line[] = [
      [
        ...joinFrags(
          top.slice(0, 3).map(([w, n]): Frag[] => [{ who: w }, ` (${n})`]),
          ', ',
        ),
        `. ${top.length} people reviewed in total.`,
      ],
    ];
    if (imbalance.length) {
      body.push([
        'Opened a lot, reviewed little: ',
        ...joinFrags(
          imbalance.map((i): Frag[] => [
            { who: i.who },
            ` (${i.opened} PRs opened, ${i.reviews} reviews)`,
          ]),
          '; ',
        ),
        '.',
      ]);
    }
    if (compare && drop) {
      body.push([{ who: drop.who }, ` gave ${drop.now} reviews, down from ${drop.before}.`]);
    }
    items.push({
      tag: 'Review load',
      title: `The top 3 reviewers gave ${pctInt(top3Share)} of all reviews`,
      body,
      watch: top3Share >= 0.45,
    });
  }

  /* review depth */
  {
    items.push({
      tag: 'Review depth',
      title:
        A.changesReq < 0.05
          ? `Reviews rarely block: ${pctInt(A.changesReq)} requested changes`
          : `${pctInt(A.changesReq)} of reviews requested changes`,
      body: [
        `${pctInt(A.commentOnly)} of reviews were comment-only${vs(` (${pctInt(B.commentOnly)} before)`)}, so discussion happens in comments rather than verdicts.`,
        `${pctInt(A.approvedMerges)} of merged PRs carried an approval.`,
      ],
      watch: false,
    });
  }

  /* automation */
  if (automation) {
    const { who, opened: n, before, merged, topMerger } = automation;
    const body: Line[] = [
      `${pctInt(automation.mergedShare)} merged, median ${dur(automation.medLead)} from open to merge, median ${num(automation.medSize)} lines. That is about 1 in ${automation.oneIn} of all PRs opened.`,
    ];
    if (topMerger) {
      body.push([{ who: topMerger.who }, ` merged ${topMerger.merged} of the ${merged}.`]);
    }
    items.push({
      tag: 'Automation',
      title: `${who} opened ${n} PRs${vs(` (${before} in the previous 30 days)`)}`,
      body,
      watch: topMerger !== null && (merged ? topMerger.merged / merged : 0) >= 0.6,
    });
  }

  /* areas: every figure here is a move against the previous period */
  if (compare && areas) {
    const { up, down, firstBy } = areas;
    const body = [
      `${down.area} ${down.d < 0 ? 'fell' : 'grew'} ${changeFmt(down.now, down.before, true)} (${down.before} → ${down.now}).`,
    ];
    const slowest = firstBy[0];
    const fastest = firstBy[firstBy.length - 1];
    if (firstBy.length >= 2 && slowest && fastest) {
      body.push(
        `Slowest first review: ${slowest.area} (${dur(slowest.v)}). Fastest: ${fastest.area} (${dur(fastest.v)}).`,
      );
    }
    items.push({
      tag: 'Where work lands',
      title: `${up.area} merges ${up.d >= 0 ? 'up' : 'down'} ${changeFmt(up.now, up.before, true)} (${up.before} → ${up.now})`,
      body,
      watch: false,
    });
  }

  /* backlog */
  {
    const { open, drafts, oldDrafts, owner, waiting, approved } = backlog;
    const body: Line[] = [
      [
        `${oldDrafts} drafts are older than 30 days`,
        ...(owner ? ['; ', { who: owner.who }, ` owns ${owner.drafts} of them`] : []),
        '.',
      ],
    ];
    body.push(
      waiting.length
        ? `${waiting.length} ready PR${waiting.length > 1 ? 's have' : ' has'} waited over 2 days without a review:`
        : 'No ready PR has waited more than 2 days without a review.',
    );
    items.push({
      tag: 'Backlog',
      title: `${open} open PRs, ${drafts} of them drafts`,
      body,
      links: waiting
        .slice(0, 5)
        .map((p) => ({ n: p.n, t: p.t, meta: [...author(p.a), ` · ${dur(LAST - p.r)}`] })),
      watch: waiting.length > 0,
    });

    if (approved.length) {
      items.push({
        tag: 'Backlog',
        title: `${approved.length} approved PR${approved.length > 1 ? 's' : ''} not merged after 3+ days`,
        body: ['Approved work that is sitting still. It goes stale and picks up conflicts.'],
        links: approved.slice(0, 5).map(({ pr, since }) => ({
          n: pr.n,
          t: pr.t,
          meta: [...author(pr.a), ` · approved ${dur(since)} ago`],
        })),
        watch: true,
      });
    }
  }

  /* churn & other signals */
  {
    const { closed, quick, closer, reverts, revertsBefore, newcomers, busiest } = churn;
    const dow = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const body: Line[] = [];
    if (closed) {
      body.push([
        `${quick} of ${closed} unmerged closes happened within a day of opening`,
        ...(closer ? ['; ', { who: closer.who }, ` closed the most (${closer.closed})`] : []),
        '.',
      ]);
    }
    // "New contributor" is a first-ever claim: with bounded coverage an author
    // whose earlier PRs fell outside the window would look new, so it is
    // omitted rather than mislabelled.
    const firstEver: Frag[] = fullHistory
      ? newcomers.length
        ? [' New contributors: ', ...joinFrags(newcomers.map(author), ', '), '.']
        : [' No new contributors.']
      : [];
    body.push([
      `${reverts} revert${reverts === 1 ? '' : 's'}${vs(` (${revertsBefore} before)`)}.`,
      ...firstEver,
    ]);
    if (busiest) {
      body.push(`${dow[busiest.day]} is the busiest merge day (${busiest.merges} merges).`);
    }
    items.push({
      tag: 'Other signals',
      title: 'Churn, reverts and rhythm',
      body,
      watch: compare && reverts > revertsBefore + 2,
    });
  }

  /* ---- render ---- */
  // Flagged items lead; the rest keep their fixed order.
  const ordered = [...items.filter((i) => i.watch), ...items.filter((i) => !i.watch)];
  const head = el('div', { class: 'brief-head' }, [el('h2', { text: 'Last 30 days at a glance' })]);
  // Collapsed by default to one line; the reader's choice to open it is kept.
  const summary = briefSummaryLine(ordered);
  const summaryText = el('span', { class: 'brief-summary-text', text: summary.headline });
  const summaryMore = el('span', { class: 'brief-summary-more', text: moreText(summary.more) });
  const toggle = el('button', {
    type: 'button',
    class: 'brief-toggle',
    'aria-expanded': 'false',
    'aria-controls': 'brief-body',
  });
  head.append(el('div', { class: 'brief-summary' }, [summaryText, summaryMore, toggle]));
  const body = el('div', { class: 'brief-body', id: 'brief-body' });
  body.append(
    el('p', {
      class: 'desc',
      text: `${fmtDate(LAST - 30 * DAY)} – ${fmtDate(LAST)}${vs(', compared with the 30 days before')}. Bots excluded except under Automation. The filters below do not change this section.`,
    }),
  );
  let expanded = readExpanded();
  const apply = (): void => {
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? 'Show less' : 'Show more';
    body.hidden = !expanded;
    summaryText.hidden = expanded;
    summaryMore.hidden = expanded || summary.more === 0;
    host.dataset.expanded = expanded ? '1' : '0';
  };
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    writeExpanded(expanded);
    apply();
  });
  if (!compare) {
    const row = el('div', { class: 'brief-compare' }, [
      el('p', { class: 'desc brief-compare-note', text: COMPARE_NOTE }),
    ]);
    // The smallest range button that reaches back 60 days; its busy state and
    // progress are shared with that button (see `mount`).
    const { requestMore } = ctx;
    if (requestMore) {
      const btn = el('button', {
        type: 'button',
        class: 'brief-load',
        'data-load-range': COMPARE_RANGE,
        text: `Sync ${COMPARE_RANGE} days`,
      });
      btn.addEventListener('click', () => requestMore(COMPARE_RANGE));
      row.append(btn);
    }
    body.append(row);
  }
  const grid = el('div', { class: 'brief-grid' });
  for (const it of ordered) {
    const card = el('article', { class: 'ins' });
    const top = el('div', { class: 'ins-top' }, [el('span', { class: 'ins-tag', text: it.tag })]);
    if (it.watch) {
      const flag = el('span', { class: 'ins-flag' });
      const ico = svgEl('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': 'true',
      });
      ico.append(svgEl('path', { d: 'M8 1.5 15 14H1z', class: 'flag-tri' }));
      ico.append(svgEl('path', { d: 'M8 6v4M8 11.6v.4', class: 'flag-mark' }));
      flag.append(ico, document.createTextNode('Worth a look'));
      top.append(flag);
    }
    card.append(top, el('h3', { text: it.title }));
    for (const l of it.body) card.append(el('p', {}, line(l)));
    if (it.links?.length) {
      const ul = el('ul', { class: 'ins-links' });
      for (const l of it.links) {
        const a = el('a', {
          href: prUrl(data.repo, l.n),
          target: '_blank',
          rel: 'noopener',
          text: `#${l.n} ${l.t.length > 48 ? `${l.t.slice(0, 48)}…` : l.t}`,
        });
        ul.append(el('li', {}, [a, el('span', { class: 'ins-meta' }, l.meta.map(frag))]));
      }
      card.append(ul);
    }
    grid.append(card);
  }
  body.append(grid);
  host.append(head, body);
  apply();
}
