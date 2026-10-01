// Regenerate the built-in example dashboards served from `public/examples/`.
//
//   pnpm examples:build            (token from GITHUB_TOKEN, else `gh auth token`)
//   pnpm examples:build owner/name (rebuild one of the examples below)
//
// Each example is a full-history sync into a throwaway file store, turned into
// the same payload the web app serves from R2, gzipped next to an `index.json`
// the landing page reads at build time. Runs on Node's own TypeScript support,
// so the workspace sources are imported as they are.
//
// Every file written here is deployed as a static asset anyone can fetch, with
// no access check. Only the repositories in `EXAMPLES` are built, and only
// while GitHub reports them public.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  GithubClient,
  buildPayload,
  createFilterState,
  derive,
  headline,
  lastActivity,
  parseRepo,
  scope,
  sync,
  windowed,
} from '../../core/src/index.ts';
import { FileStore } from '../../store-file/src/index.ts';

/** The repositories shipped as examples; `src/lib/examples.ts` describes them. */
const EXAMPLES = ['withastro/astro', 'cloudflare/workers-sdk'];

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/examples');
const indexPath = join(outDir, 'index.json');

const log = (line) => process.stderr.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('No GitHub token: set GITHUB_TOKEN or sign in with `gh auth login`.');
  }
}

/** Refuse a repository the operator's token can read but the public cannot. */
async function assertPublic(client, repo) {
  const { meta } = await client.repoMeta(repo);
  if (meta.isPrivate) {
    throw new Error(`${repo.owner}/${repo.name} is private; it cannot be published as an example`);
  }
}

/** Walk the whole history, waiting out the rate limit when it runs dry. */
async function fullSync(client, store, repo) {
  for (;;) {
    const result = await sync({
      client,
      store,
      repo,
      mode: 'full',
      onPage: (p) => {
        if (p.pages % 20 === 0 || p.pages === 1) {
          log(
            `  ${repo.owner}/${repo.name}: ${p.pass} page ${p.pages} (${p.fetched} prs) · rate remaining ${p.rateLimit.remaining}`,
          );
        }
      },
    });
    if (result.stoppedBecause !== 'rate-limit') return result;
    const resetAt = result.rateLimit?.resetAt ? Date.parse(result.rateLimit.resetAt) : NaN;
    const wait = Number.isNaN(resetAt) ? 5 * 60_000 : Math.max(resetAt - Date.now(), 0) + 5_000;
    log(`  rate limit reached; waiting ${Math.round(wait / 1000)}s before continuing`);
    await sleep(wait);
  }
}

/** The last-30-days headline, computed exactly as the dashboard's default view. */
function previewOf(payload) {
  const prs = derive(payload.prs);
  const last = lastActivity(prs);
  const state = { ...createFilterState(), range: '30' };
  return headline(windowed(scope(prs, new Set(payload.bots), state, last), last));
}

async function buildExample(client, cacheDir, spec) {
  const repo = parseRepo(spec);
  const label = `${repo.owner}/${repo.name}`;
  const store = new FileStore(join(cacheDir, `${repo.owner}--${repo.name}.json`), label);
  await assertPublic(client, repo);
  log(`syncing ${label} (full history)`);
  const result = await fullSync(client, store, repo);
  if (!result.complete || result.coverageSince !== null) {
    throw new Error(`${label}: the sync did not cover the full history (${result.stoppedBecause})`);
  }
  const [meta, prs] = await Promise.all([store.meta(), store.all()]);
  const payload = buildPayload(meta, prs);
  if (payload.syncedAt === null) throw new Error(`${label}: no syncedAt after the sync`);
  // A full sync can take hours: check again that it is still public before writing it out.
  await assertPublic(client, repo);
  const gz = gzipSync(JSON.stringify(payload), { level: 9 });
  const file = `${repo.owner}--${repo.name}.json.gz`;
  writeFileSync(join(outDir, file), gz);
  log(
    `wrote ${file}: ${payload.prs.length} PRs, ${(gz.byteLength / 1e6).toFixed(2)} MB gzipped, ${result.pointsSpent} points spent`,
  );
  return {
    owner: repo.owner,
    name: repo.name,
    repo: payload.repo,
    snapshotAt: payload.syncedAt,
    prs: payload.prs.length,
    coverageSince: payload.coverageSince,
    openPrsSyncedAt: payload.openPrsSyncedAt,
    preview: previewOf(payload),
    sizeBytes: gz.byteLength,
  };
}

async function main() {
  const only = process.argv.slice(2);
  const unknown = only.filter(
    (spec) => !EXAMPLES.some((example) => example.toLowerCase() === spec.toLowerCase()),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Not an example: ${unknown.join(', ')}. Add it to EXAMPLES first (examples: ${EXAMPLES.join(', ')}).`,
    );
  }
  const token = resolveToken();
  const client = new GithubClient({
    token,
    onRetry: (attempt, wait, error) =>
      log(`  retry ${attempt} in ${wait}ms: ${String(error).slice(0, 160)}`),
  });
  const cacheDir = process.env.BILAN_CACHE_DIR
    ? join(process.env.BILAN_CACHE_DIR, 'examples')
    : mkdtempSync(join(tmpdir(), 'bilan-examples-'));
  mkdirSync(outDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  /** Entries already in the index, kept for repos not rebuilt in this run. */
  let previous = [];
  try {
    previous = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    // First run: nothing to keep.
  }
  const targets = only.length > 0 ? only : EXAMPLES;
  const built = [];
  for (const spec of targets) built.push(await buildExample(client, cacheDir, spec));

  const byRepo = new Map(previous.map((entry) => [entry.repo.toLowerCase(), entry]));
  for (const entry of built) byRepo.set(entry.repo.toLowerCase(), entry);
  const index = EXAMPLES.map((spec) => byRepo.get(spec.toLowerCase())).filter(Boolean);
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const total = index.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  log(
    `wrote index.json: ${index.length} examples, ${(total / 1e6).toFixed(2)} MB gzipped in total`,
  );
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
