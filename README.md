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
- **Web app**: sign in with GitHub, open any repository you can read, and
  share the dashboard link with coworkers who can read it too.

## CLI

```sh
npx github-bilan owner/name --open
```

The command syncs the repository into a local cache, writes
`<name>.report.html`, and opens it. Re-running is cheap: the sync is
incremental.

| Flag           | Effect                                                       |
| -------------- | ------------------------------------------------------------ |
| `--open`       | Open the report in the browser when done                     |
| `--out FILE`   | Report path (default `<name>.report.html`)                   |
| `--since DATE` | Reach further back than the default 30 days                  |
| `--full`       | Walk the entire history                                      |
| `--max-prs N`  | Stop after N pull requests                                   |
| `--no-cache`   | Ignore the local cache and fetch everything again            |
| `--offline`    | Render from the cache without contacting GitHub              |
| `--token T`    | GitHub token; otherwise `GITHUB_TOKEN`, then `gh auth token` |
| `--areas FILE` | Override how changed paths map to areas                      |

By default a sync covers the last 30 days of activity plus every open pull
request; later runs only widen that coverage. A 25-PR page costs one GitHub
rate-limit point, so even a full history of a large repository fits in one
hour's budget. The cache lives in `~/.cache/bilan`.

## Web app

The web app runs on Cloudflare Workers with D1, R2, KV, and Workflows. Signed
out, it shows two built-in example dashboards (`withastro/astro` and
`cloudflare/workers-sdk`) shipped as static snapshots. Signed in, it syncs any
repository you can read on your own token into a shared cache, so a coworker
who opens the same link sees the dashboard instantly.

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

### Running it yourself

1. Create a GitHub App with permissions Pull requests: Read-only and Metadata:
   Read-only (and Members: Read-only under organization permissions, to resolve
   team reviewers), "Request user authorization during installation" enabled,
   expiring user tokens enabled, no webhook, and the callback URL of your
   deployment plus `http://localhost:8788/auth/github/callback` for local use.
2. Put the app's slug in `GITHUB_APP_SLUG` in `packages/web/wrangler.jsonc`.
3. Create the Cloudflare resources and record their ids in `wrangler.jsonc`:

   ```sh
   cd packages/web
   npx wrangler d1 create bilan
   npx wrangler r2 bucket create bilan-payloads
   npx wrangler kv namespace create CACHE
   ```

4. Set the secrets and deploy:

   ```sh
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY
   npx wrangler d1 migrations apply bilan --remote
   cd ../.. && pnpm run deploy
   ```

   The deploy runs through turbo, which builds the dashboard and its
   dependencies before `wrangler deploy`.

   `GITHUB_TOKEN`, a classic token with no scopes, is optional: it is only used
   as a fallback for public repositories a user token cannot reach.

Every push to `main` that passes CI is deployed by the `Deploy` workflow,
which applies pending D1 migrations and then runs `wrangler deploy`. It needs
two repository secrets: `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare Workers"
template plus D1 Edit) and `CLOUDFLARE_ACCOUNT_ID`.
The deploy gate verifies that the triggering run was a push to the canonical
repository's `main`, not a pull request or a fork's branch of the same name.
Cloudflare credentials are available only to the migration and deploy steps.

For local development, copy `packages/web/.dev.vars.example` to `.dev.vars`,
fill in the values, run `npx wrangler d1 migrations apply bilan --local`, then
`pnpm --filter @bilan/web dev`. Workflows require the Workers Paid plan.

The built-in examples are regenerated with `pnpm examples:build`, which needs
a GitHub token.

## What the numbers mean

| Metric                   | Window anchor   | Definition                                                                   |
| ------------------------ | --------------- | ---------------------------------------------------------------------------- |
| PRs opened               | created         |                                                                              |
| Merged / closed unmerged | merged / closed |                                                                              |
| Time in draft            | created         | opened → marked ready (draft-opened pull requests only)                      |
| Time to first review     | ready           | ready → first review by someone other than the author                        |
| Time to merge            | merged          | ready → merged                                                               |
| Reviewer turnaround      | review          | review request (or ready, if never requested) → that reviewer's first review |
| Reviews given            | review          | self-reviews excluded                                                        |

A pull request that opened as a draft becomes reviewable at its first
ready-for-review event; later re-drafts are ignored. Each metric is scoped by
its own anchor, so "last 30 days" means what happened in those 30 days rather
than which pull requests were opened in them. Area attribution samples up to 30
changed files per pull request, and up to 40 reviews are captured per pull
request.

## Development

```sh
pnpm install
pnpm check          # oxfmt, oxlint, tsc, vitest across the workspace
pnpm build          # bundles the dashboard, the CLI, and the web app
node packages/cli/bin/bilan.mjs owner/name --open
```

| Package               | Role                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `packages/core`       | GitHub GraphQL client, sync engine, derive step, and metrics; Web APIs only |
| `packages/ui`         | The dashboard as a framework-free module                                    |
| `packages/store-file` | JSON-file sync store used by the CLI                                        |
| `packages/store-d1`   | Drizzle schema, migrations, and D1 sync store for the web app               |
| `packages/web`        | The Astro app on Cloudflare Workers: login, sync workflow, dashboards       |
| `packages/cli`        | The `bilan` command, published as `github-bilan`                            |

## License

MIT.
