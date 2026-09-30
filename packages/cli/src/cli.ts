import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  DEFAULT_COVERAGE_DAYS,
  GithubClient,
  buildPayload,
  defaultSince,
  parseRepo,
  sync,
} from '@bilan/core';
import { FileStore, writePrivateFile } from '@bilan/store-file';

import { secureCacheDirectory, storePath } from './paths.ts';
import { renderReport } from './report.ts';
import { resolveToken } from './token.ts';

import type { AreaRules, RepoRef, SyncResult } from '@bilan/core';

const USAGE = `bilan — the pulse of a GitHub repository

Usage:
  bilan <owner/name> [options]

Syncs the repository into a local cache, then writes a self-contained HTML report.

Options:
  --open             Open the report in the browser when done
  --out FILE         Where to write the report (default: <name>.report.html)
  --no-cache         Ignore the local cache and fetch everything again
  --offline          Do not talk to GitHub; render whatever is already cached
  --full             Walk the entire history (every PR, no --since cutoff)
  --since DATE       Sync activity since DATE (by last update) plus every open PR;
                     default: the last ${DEFAULT_COVERAGE_DAYS} days. Coverage only ever widens
  --max-prs N        Stop after N pull requests in this run
  --token T          GitHub token (default: GITHUB_TOKEN, then \`gh auth token\`)
  --areas FILE       JSON file { "known": ["dir", ...] } overriding area attribution
  -h, --help         Show this help

The cache lives in $BILAN_CACHE_DIR or ~/.cache/bilan.
`;

const log = (line: string) => process.stderr.write(`${line}\n`);

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      open: { type: 'boolean', default: false },
      out: { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      since: { type: 'string' },
      'max-prs': { type: 'string' },
      token: { type: 'string' },
      areas: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [repoArg, extra] = positionals;
  if (values.help || repoArg === undefined) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  if (['sync', 'report', 'open'].includes(repoArg)) {
    throw new Error(`There are no subcommands any more: run \`bilan ${extra ?? '<owner/name>'}\`.`);
  }
  if (extra !== undefined) throw new Error(`Unexpected argument "${extra}".\n\n${USAGE}`);
  if (values['no-cache'] && values.offline) {
    throw new Error('--no-cache and --offline contradict each other.');
  }
  const repo = parseRepo(repoArg);
  const maxPrs = values['max-prs'] === undefined ? undefined : Number(values['max-prs']);
  if (
    maxPrs !== undefined &&
    (!/^\d+$/.test(values['max-prs']!) || !Number.isSafeInteger(maxPrs) || maxPrs <= 0)
  ) {
    throw new Error('--max-prs must be a positive integer');
  }

  if (!values.offline) {
    await runSync(repo, {
      full: values.full,
      maxPrs,
      since: values.since === undefined ? undefined : new Date(values.since),
      token: values.token,
      fresh: values['no-cache'],
    });
  }
  const out = await runReport(repo, { out: values.out, areas: values.areas });
  if (values.open) await openInBrowser(out);
  return 0;
}

interface SyncOptions {
  full: boolean;
  maxPrs: number | undefined;
  since: Date | undefined;
  token: string | undefined;
  /** Start from an empty cache instead of syncing incrementally. */
  fresh: boolean;
}

async function runSync(repo: RepoRef, options: SyncOptions): Promise<SyncResult> {
  if (options.since !== undefined && Number.isNaN(options.since.getTime())) {
    throw new Error('--since must be a date like 2025-01-01');
  }
  const { token, source } = await resolveToken(options.token);
  const client = new GithubClient({
    token,
    onRetry: (attempt, wait, error) =>
      log(`  retry ${attempt} in ${wait}ms: ${String(error).slice(0, 160)}`),
  });
  secureCacheDirectory();
  const path = storePath(repo);
  if (options.fresh) rmSync(path, { force: true });
  const store = new FileStore(path, `${repo.owner}/${repo.name}`);
  log(`syncing ${repo.owner}/${repo.name} with token from ${source}`);

  const since = options.full ? undefined : (options.since ?? defaultSince());
  const result = await sync({
    client,
    store,
    repo,
    mode: options.full ? 'full' : 'incremental',
    ...(options.maxPrs === undefined ? {} : { maxPrs: options.maxPrs }),
    ...(since === undefined ? {} : { since }),
    onPage: (p) =>
      log(
        `${p.pass === 'open' ? 'open page' : 'page'} ${p.pages} (${p.fetched} prs, ${p.changedOnPage} changed) · rate remaining ${p.rateLimit.remaining}`,
      ),
  });

  const why: Record<SyncResult['stoppedBecause'], string> = {
    exhausted: 'reached the end of history',
    'already-synced': 'reached already-synced history (use --full to force)',
    'max-prs': 'reached --max-prs',
    since: 'reached --since',
    'rate-limit': `rate limit low, resets at ${result.rateLimit?.resetAt ?? 'unknown'}`,
  };
  const open = result.openPass;
  log(
    `${why[result.stoppedBecause]}${open === null ? '' : ` · open PRs: ${open.fetched} on ${open.pages} pages`} · ${result.pointsSpent} points spent`,
  );
  log(`done: ${store.size} PRs cached in ${path} · ${describeCoverage(result)}`);
  return result;
}

/**
 * The "done:" line's coverage clause. Full history implies every open PR too.
 * A run cut short by the budget only claims the coverage bound the store now
 * holds and says so: rows past where it stopped may still be stale until a
 * run finishes.
 */
export function describeCoverage({
  coverageSince,
  openPrsComplete,
  complete,
}: Pick<SyncResult, 'coverageSince' | 'openPrsComplete' | 'complete'>): string {
  const bound =
    coverageSince === null
      ? 'covers full history'
      : `covers activity since ${coverageSince.slice(0, 10)}`;
  if (!complete) return `${bound} (partial run; run again to finish)`;
  if (coverageSince === null) return bound;
  const open = openPrsComplete
    ? 'plus all open PRs'
    : 'open PRs partially synced; run again to finish';
  return `${bound} (${open})`;
}

interface ReportOptions {
  out: string | undefined;
  areas: string | undefined;
}

async function runReport(repo: RepoRef, options: ReportOptions): Promise<string> {
  secureCacheDirectory();
  const path = storePath(repo);
  const store = new FileStore(path, `${repo.owner}/${repo.name}`);
  if (store.size === 0) {
    throw new Error(
      `Nothing cached for ${repo.owner}/${repo.name}. Run without --offline to sync it first.`,
    );
  }
  const areas =
    options.areas === undefined
      ? undefined
      : (JSON.parse(readFileSync(options.areas, 'utf8')) as AreaRules);
  const [meta, prs] = await Promise.all([store.meta(), store.all()]);
  const payload = buildPayload(meta, prs, areas === undefined ? {} : { areas });
  const html = renderReport(payload);
  const target = options.out ?? `${repo.name}.report.html`;
  writePrivateFile(target, html);
  log(`wrote ${target} (${(html.length / 1e6).toFixed(2)} MB, ${payload.prs.length} PRs)`);
  return target;
}

/** The platform's opener as `[command, args]`, never joined into a shell string. */
export function openerArgv(
  path: string,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  if (platform === 'darwin') return ['open', [path]];
  // Not `cmd /c start`: cmd would expand `%VAR%` and split on `&`, `^`, `|`
  // inside the path. rundll32 hands the argument to ShellExecute as is.
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', path]];
  return ['xdg-open', [path]];
}

/**
 * Hand the report to the desktop opener without blocking on it. A missing
 * opener (headless Linux, say) is a one-line warning, never a failure.
 */
export function openInBrowser(
  path: string,
  argv: [string, string[]] = openerArgv(path),
): Promise<void> {
  const [command, args] = argv;
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', (error) => {
      log(`could not open ${path} with ${command}: ${error.message}`);
      resolve();
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
