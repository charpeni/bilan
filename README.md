# bilan

The pulse of a GitHub repository.

bilan turns pull request history into a picture of what is actually happening
in a repository: who is contributing, which parts of the codebase are moving,
how reviews flow and who carries them, and where work gets stuck. It is also a
way to see what AI-assisted coding does to a codebase and a team over time:
how much gets opened, how large the changes are, how fast they merge, how many
carry a real review, and how review load lands on the humans.

Every latency is measured from the moment a pull request became ready for
review, so time spent in draft is never charged to reviewers. bilan reads
pull request metadata only, never code, and never writes to GitHub.

Two ways to use it:

- **CLI**: sync a repository with your own token and get a self-contained
  HTML report you can open or share as a file.
- **Web app**: sign in with GitHub on [bilan.dev](https://bilan.dev), open any
  repository you can read, and share the dashboard link with coworkers who can
  read it too.

## CLI

```sh
npx github-bilan owner/name --open
```

The command syncs the repository into a local cache, writes
`<name>.report.html`, and opens it. Re-running is cheap: the sync is
incremental.

| Flag           | Effect                                                                   |
| -------------- | ------------------------------------------------------------------------ |
| `--open`       | Open the report in the browser when done                                 |
| `--out FILE`   | Report path (default `<name>.report.html`)                               |
| `--since DATE` | Reach further back than the default 30 days                              |
| `--full`       | Walk the entire history                                                  |
| `--max-prs N`  | Stop after N pull requests                                               |
| `--no-cache`   | Ignore the local cache and fetch everything again                        |
| `--offline`    | Render from the cache without contacting GitHub; rejects sync options    |
| `--token T`    | GitHub token; otherwise `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token` |
| `--areas FILE` | List the folders that are areas, nested ones included                    |

`--no-cache` builds a new cache beside the old one (`<name>.json.fresh`) and
only replaces it once the fresh sync finishes; a fresh sync stopped by the rate
limit, `--max-prs` or an interruption keeps the old cache, which the report then
shows, and running `--no-cache` again continues it. One fresh sync of a
repository runs at a time.

`--offline` only renders what is cached, so it rejects the sync options
`--no-cache`, `--full`, `--since`, `--max-prs` and `--token`; tokens in the
environment are ignored.

`--areas` replaces the inferred areas with a JSON file of folder paths from the
repository root, nested ones included:
`{ "known": ["docs", "packages/app", "packages/integrations/node"] }`. A changed
file counts toward the deepest listed folder holding it, other nested files
toward `other`, and files at the root toward `root`. Lockfiles, `.changeset/`
and release or dependency pull requests still count toward no area.

By default a sync covers the last 30 days of activity plus every open pull
request; later runs only widen that coverage. GitHub reports each request's
rate-limit cost, a few points per page of 25 pull requests; long review-request
histories need extra requests. The CLI reports points spent and stops near the
rate limit or at `--max-prs`. The next run first re-checks pull requests updated
since the stopped run began, then continues from where it stopped, so a history
too large for one rate-limit window finishes over several runs. The cache lives in `~/.cache/bilan`, or `$XDG_CACHE_HOME/bilan` when set.
`BILAN_CACHE_DIR` can select a dedicated cache directory; empty values use the default.
An existing directory is only adopted when it is empty or holds a bilan cache
(older ones are recognized by their snapshots); anything else is rejected before
its permissions change. On Unix, cache directories
are owner-only (`0700`), and cache files and HTML exports are written with
owner-only permissions (`0600`), including when replacing older files.

## Web app

The web app, at [bilan.dev](https://bilan.dev), runs on Cloudflare Workers
with D1, R2, KV, and Workflows. Signed out, it shows two built-in example
dashboards ([`withastro/astro`](https://bilan.dev/withastro/astro) and
[`cloudflare/workers-sdk`](https://bilan.dev/cloudflare/workers-sdk)) shipped as
static snapshots, plus the last sync of any public repository bilan already
holds, once the server token confirms it is still public; signing in is needed
to refresh it or sync more history. Private repositories always ask the viewer
to sign in, whether or not bilan holds them. Signed in, it syncs any repository you can read on your own
token into a shared cache, so a coworker who opens the same link sees the
dashboard instantly. A new repository shows a **Start sync** button; following
a link alone does not import its data. Existing dashboards can refresh during
navigation within the app. External links and bookmarks use the **Refresh**
button for stale data.

Access is checked per viewer against GitHub with the viewer's own token;
allowed access and public visibility are cached for up to 15 minutes. Job
progress requires repository access too, even for an old completed job. A
private repository the viewer cannot read is indistinguishable from one that
does not exist. Private data nobody has opened in 90 days is deleted.

Login is a GitHub App with read-only permissions (Pull requests, Metadata).
User tokens expire after eight hours; bilan stores them encrypted and refreshes
them, including mid-sync. Private repositories require the app to be installed
on the organization, once, by an owner; members can request it from the app's
install page. Public repositories need no install.

Installation callbacks without browser-bound OAuth state restart normal
sign-in; their supplied authorization code is never used to create a session.
Authenticated responses are not browser-cacheable, and dynamic responses
disallow framing.

Sync admission is atomic in D1: one active job per repository, at most two
active jobs and 20 starts per account in a rolling 24 hours, and at most 20
active jobs and 200 starts globally. Deepening history still consumes these
budgets; failed attempts count toward the daily budget. A repeated sync of the
same depth has a 10-minute cooldown. The limits live in
`packages/store-d1/src/jobs.ts`.

Whether a repository is syncing is decided by one model, `packages/domain`,
hosted on Durable Objects by the `bilan-domain` Worker: a run is requested,
admitted against those quotas, started on the Workflow, and reports each step
back. A request not admitted within two minutes expires; a run silent for ten
minutes is given up and stopped (a rate-limit pause is announced, and held to
ten minutes after it ends); no run lasts past six hours. `sync_jobs` follows
the model, so the quotas and the job history read what it decided.

### Running it yourself

1. Create a GitHub App with permissions Pull requests: Read-only and Metadata:
   Read-only (and Members: Read-only under organization permissions, to resolve
   team reviewers), "Request user authorization during installation" enabled,
   expiring user tokens enabled, no webhook, and the callback URL of your
   deployment plus `http://localhost:8788/auth/github/callback` for local use.
2. Copy `.env.example` to `.env` at the repository root and fill it in: the
   app's client id, client secret, and slug, and a `TOKEN_ENCRYPTION_KEY`
   (`openssl rand -base64 32`).
3. Deploy. The infrastructure is declared in `alchemy.run.ts`
   ([Alchemy](https://alchemy.run)): the D1 database (migrations are applied on
   every deploy), the R2 bucket, the KV namespace, the sync Workflow, and three
   Workers. `bilan` serves the Astro app; `bilan-sync` hosts the Workflow and
   the nightly cron, since Astro owns the app Worker's entry; `bilan-domain`
   hosts the sync model, reached by the other two through service bindings.

   ```sh
   pnpm alchemy profile edit --add Cloudflare   # once: sign in to Cloudflare
   pnpm run deploy --stage prod
   ```

   The `prod` stage pins the production names (`bilan.dev`, the `bilan` D1
   database, the `bilan-payloads` bucket); fork it before deploying your own.
   Any other stage creates its own resources under generated names.

   `GITHUB_TOKEN`, a classic token with no scopes, is optional: it is used as a
   fallback for public repositories a user token cannot reach, and to confirm a
   repository is still public before showing its dashboard to signed-out
   viewers. Without it, a signed-out viewer only sees a public dashboard in the
   15 minutes after a signed-in viewer's check confirmed it. A token GitHub
   rejects (expired or revoked) is logged and treated as not configured.

Every push to `main` that passes CI is deployed to the `prod` stage by the
`Deploy` workflow. Its `production` environment holds `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and the app's secrets (see the workflow); every deploy
sets the Workers' secrets from them. The deploy gate verifies that the
triggering run was a push to the canonical repository's `main`, not a pull
request or a fork's branch of the same name. Cloudflare credentials are
available only to the deploy step.

Each pull request from a branch of this repository is deployed by the `Preview`
workflow to its own stage, `pr-<number>`, with empty storage, at
`https://bilan-pr-<number>.<account>.workers.dev`, and destroyed when the pull
request closes; a weekly `Preview sweep` removes any stage left behind.
Previews sign in through a separate GitHub App whose callback
URL matches any `workers.dev` subdomain of the account; fork pull requests are
never deployed.

For local development, fill in `.env` as above and run `pnpm dev`. It runs
all three Workers in workerd with local D1, R2, KV, and Workflows on
`http://localhost:8788`, and needs no Cloudflare account. Workflows require
the Workers Paid plan in production.

The built-in examples are regenerated with `pnpm examples:build`, which needs
a GitHub token.

### Payload storage maintenance

Each sync publishes gzip-compressed dashboard snapshots to R2 under
`payload/<repo-id>/<sync-timestamp>.json.gz`. The daily job at 06:00 UTC keeps
the snapshot referenced by D1's `last_synced_at`, regardless of age, and any
snapshot uploaded within the past 48 hours. It deletes older, superseded
snapshots only after verifying that the current snapshot exists in R2. If the
repository row, current reference, or current R2 object is missing, all older
snapshots are kept as possible recovery copies. Unknown key formats are also
left alone. The existing 90-day inactive private repository
cleanup still removes those repositories and all their snapshots.

To review the backlog from the repository root, authenticate with Wrangler
(`wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`) for
the production account, then run:

```sh
pnpm --filter @bilan/web payloads:prune
```

This defaults to a **dry run against production**. It prints each candidate's
compressed size and key, then totals for objects scanned, candidate objects,
and reclaimable bytes. `skippedUnverified` counts old objects kept because no
current snapshot could be verified. It does not run the private repository/session cleanup.
To perform the deletions, re-evaluating candidates against D1:

```sh
pnpm --filter @bilan/web payloads:prune --apply
```

Both paths process up to 1,000 objects at a time and re-read each repository's
current reference before deleting its batch. Errors stop the run; a later run
can safely resume by scanning the remaining objects. Use `--local` to work with
local Wrangler state instead of production, or `--help` for the command options.

## What the numbers mean

The 7-, 30-, 90-, and 180-day views compare headline stats with the immediately
preceding period of the same length. Tiles show the previous value and the
percentage change; review and merge times say whether they are faster or slower.
PR counts stay neutral: less activity is not necessarily better or worse. First
review time also shows how many ready PRs have received a review in each period.
The briefing above the controls always summarises the latest 30 days, independently
of the filters. The stats below follow the selected range, area, contributor, and
bot filters.
Dates use UTC; each period excludes its starting instant and includes its end,
so an event on the shared boundary belongs only to the previous period.

Comparisons require both complete periods: 14 days of history for a 7-day view,
60 for 30, 180 for 90, and 360 for 180. When history is missing, the web dashboard
offers a deeper sync and keeps the selected range and filters; standalone reports
show a CLI command. The sync uses a supported depth beyond the required history
to allow for time spent syncing (full history for 90- and 180-day comparisons).
Interrupted snapshots and all-time views show no comparison. A missing duration
sample shows as unavailable, and a count rising from zero is labelled “New”.

| Metric                   | Window anchor   | Definition                                                                   |
| ------------------------ | --------------- | ---------------------------------------------------------------------------- |
| PRs opened               | created         |                                                                              |
| Merged / closed unmerged | merged / closed |                                                                              |
| Merged PRs by area       | merged          | per area and week, or month over all time; counted in every area touched     |
| Time in draft            | created         | opened → marked ready (draft-opened pull requests only)                      |
| Time to first review     | ready           | ready → first review by someone other than the author                        |
| Time to merge            | merged          | ready → merged                                                               |
| Reviewer turnaround      | review          | review request (or ready, if never requested) → that reviewer's first review |
| Reviews given            | review          | self-reviews excluded                                                        |
| Review threads per PR    | merged          | review threads ÷ pull requests merged, by size                               |
| Approved with no threads | merged          | every review was an approval and no review thread was opened                 |
| Time to approval         | merged          | ready → first approval, by size                                              |

Areas are folders, read from up to 30 changed file paths per pull request; a
pull request touching two areas counts in both. Each top-level folder is an
area, except that a folder touched by more than half the pull requests, such as
`packages/` in a monorepo, is split into its packages: the outermost folders,
at most three deep, holding a sampled `package.json`, `Cargo.toml`, `go.mod` or
`pyproject.toml`, or its subfolders when it holds none. A folder stays whole
when one piece would still hold more than 90% of its pull requests. Lockfiles
and `.changeset/` count toward no area, and neither does a pull request whose
sampled files are only those, manifests and changelogs, as release and
dependency pull requests are. Files at the repository root count as `root`.

A pull request that opened as a draft becomes reviewable at its first
ready-for-review event; later re-drafts are ignored. Each metric is scoped by
its own anchor, so "last 30 days" means what happened in those 30 days rather
than which pull requests were opened in them. Up to 40 reviews are captured per
pull request.

Review depth groups merged pull requests by size, in lines added + deleted:
≤50, 51–250, 251–500, 501–1k, and over 1k. Its thread count is GitHub's total
per pull request, which does not say who opened each thread, so threads opened
by bot reviewers (such as Copilot) count too and overstate human discussion.

Draft transitions are fetched separately from review requests, and review-request histories are paginated without a fixed event limit. Run `--full` to refresh all cached PR metadata after upgrading.

## Development

```sh
pnpm install
pnpm check          # oxfmt, oxlint, tsc, vitest across the workspace
pnpm build          # bundles the dashboard and the CLI (Alchemy builds the web app)
node packages/cli/bin/bilan.mjs owner/name --open
```

| Package                  | Role                                                                        |
| ------------------------ | --------------------------------------------------------------------------- |
| `packages/core`          | GitHub GraphQL client, sync engine, derive step, and metrics; Web APIs only |
| `packages/ui`            | The dashboard as a framework-free module                                    |
| `packages/store-file`    | JSON-file sync store used by the CLI                                        |
| `packages/store-d1`      | Drizzle schema, migrations, and D1 sync store for the web app               |
| `packages/domain`        | Repository syncs as an `@alchemy.run/domain` model, specified by stories    |
| `packages/domain-worker` | The `bilan-domain` Worker: the model on Durable Objects, and its sync API   |
| `packages/web`           | The Astro app on Cloudflare Workers: login, sync workflow, dashboards       |
| `packages/cli`           | The `bilan` command, published as `github-bilan`                            |

Pushing a `vX.Y.Z` tag publishes the CLI to npm through the `Publish` workflow.
The tag must match the version in `packages/cli/package.json` and point to a
commit on `main`; a prerelease version is published under the `next` dist-tag.
A release is published through npm trusted publishing with provenance, or not
at all: no npm token is stored, the package's trusted publisher on npmjs.com
names the repository, the `publish.yml` workflow and the `npm` environment, and
the workflow refuses to publish from a private repository, where npm does not
accept provenance.

## License

MIT.
