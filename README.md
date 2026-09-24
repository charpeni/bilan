# bilan

Pull-request analytics for any GitHub repository: throughput, cycle time,
review load, and per-contributor breakdowns, anchored to when a PR became
ready for review rather than when it was opened.

Two ways to use it:

- **CLI** (`github-bilan`): sync a repository with your own token and get a
  self-contained HTML report you can open or share as a file.
- **Web app** (`packages/web`, Cloudflare Workers): log in with GitHub, sync
  repos on your token into a shared cache, and share report links with
  coworkers who have access to the same repo.

## CLI

```sh
pnpm dlx github-bilan owner/name --open
```

One command: it syncs the repository into a local cache, writes
`<name>.report.html` (or `--out`), and with `--open` opens it in the browser.
Re-running is cheap because the sync is incremental. `--no-cache` ignores the
local cache and fetches everything again; `--offline` renders from the cache
without touching GitHub.

The token comes from `--token`, then `GITHUB_TOKEN`, then `gh auth token`.
Public repos need any token; private repos need one that can read them.

By default `sync` fetches the last 30 days of activity plus every open PR, and
later runs only widen that: `--since YYYY-MM-DD` reaches further back and
`--full` walks the entire history. `--max-prs N` bounds a run. A full sync
costs roughly one GitHub rate-limit point per PR, out of 5,000 per hour.

## Web app

Sign in with GitHub, open any `owner/name`, and bilan syncs it into a shared
D1/R2 cache. Signed-out visitors only see the example repo.

Access rules: public repos are open to any signed-in viewer; a private repo
is checked against GitHub with the viewer's own token (cached 15 minutes) and
a repo the viewer cannot read is indistinguishable from one that does not
exist. Private repos nobody has opened in 90 days are deleted nightly.

### Auth model

Login is a **GitHub App** (user-to-server OAuth), not an OAuth App:

- Permissions are fixed on the app and read-only (Pull requests: read,
  Metadata: read). There is no `repo` scope to ask for, and nothing bilan
  could write with.
- User tokens expire after 8 hours and come with a 6-month refresh token.
  bilan stores both encrypted, refreshes within five minutes of expiry (also
  mid-sync, since a deep sync can outlast a token), and asks the viewer to sign
  in again once a token can no longer be refreshed or GitHub rejects it.
- A user token reaches only the repos the viewer can see **and** the app is
  installed on. Org access is therefore an install, done once by an owner or
  repo admin from `https://github.com/apps/<slug>/installations/new`; other
  members can request it from that page. No per-user OAuth approval.

Because a user token does not reach repos the app is not installed on, public
repos elsewhere are read with the **server token** (`GITHUB_TOKEN`, a classic
PAT with no scopes; a 25-PR page costs one rate-limit point). Which token a
sync or first read runs on (`packages/web/src/lib/token-source.ts`):

| viewer     | user token sees it | server token sees it | token used     |
| ---------- | ------------------ | -------------------- | -------------- |
| signed in  | yes                | —                    | user           |
| signed in  | no                 | yes, and public      | server         |
| signed in  | no                 | no, or private       | not found      |
| signed out | —                  | example repo         | server         |
| signed out | —                  | anything else        | login required |

One assumption here is unverified against real credentials: that a GitHub App
user token cannot read a public repo the app is not installed on, as the docs
say. If it can, the server fallback simply never triggers.

### Local setup

1. Create a GitHub App (Settings → Developer settings → GitHub Apps → New):
   callback URL `http://localhost:8788/auth/github/callback`, "Request user
   authorization (OAuth) during installation" on, "Expire user authorization
   tokens" on, webhook off, repository permissions Pull requests: Read-only and
   Metadata: Read-only, installable on any account. Generate a client secret.
2. Put the app's URL slug (`https://github.com/apps/<slug>`) in
   `GITHUB_APP_SLUG` in `packages/web/wrangler.jsonc`.
3. `cp packages/web/.dev.vars.example packages/web/.dev.vars` and fill in the
   client id and secret, a no-scope server token, and a token encryption key
   from `openssl rand -base64 32`.
4. Apply the migrations and start the worker:

```sh
cd packages/web
wrangler d1 migrations apply bilan --local
pnpm --filter @bilan/web dev     # astro dev with the Cloudflare runtime
wrangler dev                     # or the built worker, after `pnpm build`
```

Routes: `/auth/github/start?next=/owner/name` starts the login (never with a
scope), `/auth/github/callback` finishes it, `POST /auth/logout` ends the
session, `/me` lists the repos you opened, and `/api/me` reports the
signed-in user. A page that needs a token the viewer no longer has redirects
to the login; the corresponding API calls answer 401.

## What the numbers mean

Timings are anchored to **ready for review**, not to when the PR was opened,
so time spent in draft is never charged to the reviewers. A PR that opened as
a draft has a ready-for-review event as its earliest draft-state event;
anything after the first transition is treated as a re-draft and ignored.

| Metric                   | Window anchor   | Definition                                                                             |
| ------------------------ | --------------- | -------------------------------------------------------------------------------------- |
| PRs opened               | created         | —                                                                                      |
| Merged / closed unmerged | merged / closed | —                                                                                      |
| Time in draft            | created         | opened → marked ready (draft-opened PRs only)                                          |
| Time to first review     | ready           | ready → first review by someone other than the author                                  |
| Time to merge            | merged          | ready → merged                                                                         |
| Reviewer turnaround      | review          | review request (or ready, if never requested) → that reviewer's first review on the PR |
| Reviews given            | review          | self-reviews excluded                                                                  |

The date filter scopes each metric by its own anchor, so "last 30 days" means
_what happened_ in those 30 days rather than _PRs that were opened_ in them.

Known limits: area attribution samples up to 30 changed files per PR, up to 40
reviews are captured per PR, and review timestamps come from submitted reviews
only.

## Development

```sh
pnpm install
pnpm check          # oxfmt, oxlint, tsc, vitest across the workspace
pnpm build          # bundles @bilan/ui and the CLI
node packages/cli/bin/bilan.mjs owner/name --open
```

Layout:

- `packages/core`: GitHub GraphQL client, sync engine, derive step, metrics. Web APIs only, so it runs in Node and in Cloudflare Workers.
- `packages/ui`: the dashboard as a framework-free module, `mount(el, payload)`.
- `packages/store-file`: JSON-file sync store used by the CLI.
- `packages/store-d1`: Drizzle schema, migrations, and D1 sync store for the web app.
- `packages/web`: the Astro + Cloudflare Workers app (login, sync workflow, dashboards).
- `packages/cli`: the `bilan` command, published as `github-bilan`.
