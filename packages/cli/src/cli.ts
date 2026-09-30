import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import { parseArgs } from 'node:util';

import {
  DEFAULT_COVERAGE_DAYS,
  GithubClient,
  buildPayload,
  defaultSince,
  parseRepo,
  sync,
} from '@bilan/core';
import { FileStore } from '@bilan/store-file';

import { readAreaRules } from './areas.ts';
import { validateReportPath, writeReport } from './output.ts';
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
  --offline          Do not talk to GitHub; render whatever is already cached.
                     Sync options (--no-cache, --full, --since, --max-prs, --token) are rejected
  --full             Walk the entire history (every PR, no --since cutoff)
  --since DATE       Sync activity since DATE (by last update) plus every open PR;
                     default: the last ${DEFAULT_COVERAGE_DAYS} days. Coverage only ever widens
  --max-prs N        Stop after N pull requests in this run
  --token T          GitHub token (default: GITHUB_TOKEN, GH_TOKEN, then \`gh auth token\`)
  --areas FILE       JSON file { "known": ["dir", ...] } overriding area attribution
  -h, --help         Show this help
  -v, --version      Show the installed version

The cache lives in $BILAN_CACHE_DIR or ~/.cache/bilan.
`;

const log = (line: string) => process.stderr.write(`${line}\n`);
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

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
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  const [repoArg, extra] = positionals;
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (values.help || repoArg === undefined) {
    (values.help ? process.stdout : process.stderr).write(USAGE);
    return values.help ? 0 : 1;
  }
  if (['sync', 'report', 'open'].includes(repoArg)) {
    throw new Error(`There are no subcommands any more: run \`bilan ${extra ?? '<owner/name>'}\`.`);
  }
  if (extra !== undefined) throw new Error(`Unexpected argument "${extra}".\n\n${USAGE}`);
  if (values['no-cache'] && values.offline) {
    throw new Error('--no-cache and --offline contradict each other.');
  }
  if (values.offline) {
    const syncOnly = (['full', 'since', 'max-prs', 'token'] as const).filter(
      (option) => values[option] !== undefined && values[option] !== false,
    );
    if (syncOnly.length > 0) {
      throw new Error(
        `--offline does not sync, so it cannot be combined with ${syncOnly.map((option) => `--${option}`).join(', ')}.`,
      );
    }
  }
  const repo = parseRepo(repoArg);
  if (values.full && values.since !== undefined)
    throw new Error('--full and --since cannot be combined.');
  const since = parseSince(values.since);
  const areas = readAreaRules(values.areas);
  const maxPrs = values['max-prs'] === undefined ? undefined : Number(values['max-prs']);
  if (
    maxPrs !== undefined &&
    (!/^\d+$/.test(values['max-prs']!) || !Number.isSafeInteger(maxPrs) || maxPrs <= 0)
  ) {
    throw new Error('--max-prs must be a positive integer');
  }

  const target = values.out ?? `${repo.name}.report.html`;
  validateReportPath(target);
  if (!values.offline) {
    await runSync(repo, {
      full: values.full,
      maxPrs,
      since,
      token: values.token,
      fresh: values['no-cache'],
    });
  }
  const out = await runReport(repo, { out: target, areas });
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

function parseSince(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  const calendarDate = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    ) ||
    !Number.isFinite(date.getTime()) ||
    !Number.isFinite(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== value.slice(0, 10) ||
    date.getTime() > Date.now()
  ) {
    throw new Error(
      '--since must be a valid ISO date or timestamp, such as 2025-01-01, and cannot be in the future',
    );
  }
  return date;
}

async function runSync(repo: RepoRef, options: SyncOptions): Promise<SyncResult> {
  const { token, source } = await resolveToken(options.token);
  const client = new GithubClient({
    token,
    onRetry: (attempt, wait, error) =>
      log(`  retry ${attempt} in ${wait}ms: ${String(error).slice(0, 160)}`),
  });
  secureCacheDirectory();
  const path = storePath(repo);
  const staging = options.fresh ? `${path}.${randomUUID()}.fresh` : path;
  const existed = existsSync(path);
  const ownerDirectory = dirname(path);
  const ownerExisted = existsSync(ownerDirectory);
  const store = new FileStore(staging, `${repo.owner}/${repo.name}`);
  log(`syncing ${repo.owner}/${repo.name} with token from ${source}`);

  const since = options.full ? undefined : (options.since ?? defaultSince());
  let result: SyncResult;
  try {
    result = await sync({
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
    if (options.fresh) {
      if (!result.complete && result.fetched === 0) {
        throw new Error(
          `Fresh sync stopped before fetching data; GitHub's rate limit resets at ${result.rateLimit?.resetAt ?? 'an unknown time'}.`,
        );
      }
      renameSync(staging, path);
      rmSync(`${path}.journal`, { force: true });
    }
  } catch (error) {
    if (!options.fresh && !existed && store.size === 0) {
      rmSync(path, { force: true });
      rmSync(`${path}.journal`, { force: true });
    }
    throw error;
  } finally {
    if (options.fresh) {
      rmSync(staging, { force: true });
      rmSync(`${staging}.journal`, { force: true });
    }
    if (!ownerExisted && existsSync(ownerDirectory) && readdirSync(ownerDirectory).length === 0) {
      rmdirSync(ownerDirectory);
    }
  }

  const why: Record<SyncResult['stoppedBecause'], string> = {
    exhausted: 'reached the end of history',
    'already-synced': 'reached already-synced history (use --full to force)',
    'max-prs': 'reached --max-prs',
    since: 'reached --since',
    'rate-limit': `rate limit low, resets at ${result.rateLimit?.resetAt ?? 'unknown'}`,
  };
  const open = result.openPass;
  log(
    `${why[result.stoppedBecause]}${open === null ? '' : ` · open PRs: ${open.fetched} on ${open.pages} pages (${why[open.stoppedBecause]})`} · ${result.pointsSpent} points spent`,
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
  areas: AreaRules | undefined;
}

async function runReport(repo: RepoRef, options: ReportOptions): Promise<string> {
  secureCacheDirectory();
  const path = storePath(repo);
  const store = new FileStore(path, `${repo.owner}/${repo.name}`);
  const [meta, prs] = await Promise.all([store.meta(), store.all()]);
  if (store.size === 0 && meta.syncedAt === null) {
    throw new Error(
      `Nothing cached for ${repo.owner}/${repo.name}. Run without --offline to sync it first.`,
    );
  }
  const areas = options.areas;
  if (meta.interrupted) {
    log(
      'Partial sync: some cached pull requests may be missing or stale. Run without --offline to finish syncing.',
    );
  }
  const payload = buildPayload(meta, prs, areas === undefined ? {} : { areas });
  const html = renderReport(payload);
  const target = options.out ?? `${repo.name}.report.html`;
  writeReport(target, html);
  log(`wrote ${target} (${(html.length / 1e6).toFixed(2)} MB, ${payload.prs.length} PRs)`);
  return target;
}

/** The platform's opener as `[command, args]`, never joined into a shell string. */
export function openerArgv(
  path: string,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  const absolute = (platform === 'win32' ? win32 : posix).resolve(path);
  if (platform === 'darwin') return ['open', [absolute]];
  // Not `cmd /c start`: cmd would expand `%VAR%` and split on `&`, `^`, `|`
  // inside the path. rundll32 hands the argument to ShellExecute as is.
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', absolute]];
  return ['xdg-open', [absolute]];
}

/**
 * Check short-lived desktop launchers for failure, then detach after two
 * seconds if the launcher stays open with the browser. Report errors as warnings.
 */
export function openInBrowser(
  path: string,
  argv: [string, string[]] = openerArgv(path),
): Promise<void> {
  const [command, args] = argv;
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    let finished = false;
    const finish = (error?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) log(`could not open ${path} with ${command}: ${error}`);
      child.unref();
      resolve();
    };
    const timer = setTimeout(() => finish(), 2_000);
    child.once('error', (error) => {
      finish(error.message);
    });
    child.once('exit', (code, signal) => {
      finish(
        code === 0 ? undefined : signal ? `terminated by ${signal}` : `exited with code ${code}`,
      );
    });
  });
}
