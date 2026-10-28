# Running bilan yourself

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

   Alchemy keeps what it deployed in a state store on the Cloudflare account,
   the `alchemy-state-store-bilan` Worker. The first `plan` or `deploy` from a
   signed-in machine creates it. CI only uses an existing one: create it first
   with `pnpm alchemy state bootstrap --backend cloudflare --name bilan`.

   `GITHUB_TOKEN`, a classic token with no scopes, is optional: it is used as a
   fallback for public repositories a user token cannot reach, and to confirm a
   repository is still public before showing its dashboard to signed-out
   viewers. Without it, a signed-out viewer only sees a public dashboard in the
   15 minutes after a signed-in viewer's check confirmed it. A token GitHub
   rejects (expired or revoked) is logged and treated as not configured.

## Production deploys and previews

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

## Local development

For local development, fill in `.env` as above and run `pnpm dev`. It runs
all three Workers in workerd with local D1, R2, KV, and Workflows on
`http://localhost:8788`, and needs no Cloudflare account. Workflows require
the Workers Paid plan in production.

The built-in examples are regenerated with `pnpm examples:build`, which needs
a GitHub token.

## Payload storage maintenance

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
