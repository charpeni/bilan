# How bilan.dev works

## The stack

[bilan.dev](https://bilan.dev) runs on [Cloudflare](https://workers.cloudflare.com):
Workers, D1, R2, KV, Workflows, and Durable Objects.

- **[Alchemy](https://alchemy.run)** declares all of it in TypeScript
  (`alchemy.run.ts` and `infra/`), deploys it, applies D1 migrations, and
  gives every pull request its own preview stage.
- **[Effect](https://effect.website)** powers the sync model: the
  `@alchemy.run/domain` model in `packages/domain` and the `bilan-domain`
  Worker that hosts it on Durable Objects (`packages/domain-worker`).
- The Astro app and the browser code stay plain TypeScript.

Three Workers make up the app:

- `bilan` serves the Astro app;
- `bilan-sync` hosts the sync Workflow and the nightly cron, since Astro owns
  the app Worker's entry;
- `bilan-domain` hosts the sync model, reached by the other two through service
  bindings, with no public URL.

The CLI shares the sync engine and the dashboard (`packages/core`,
`packages/ui`) and needs none of this: it runs on Node with a local cache.

## What viewers see

Signed out, the web app shows two built-in example
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

## Access and privacy

Access is checked per viewer against GitHub with the viewer's own token;
allowed access and public visibility are cached for up to 15 minutes. Job
progress requires repository access too, even for an old completed job. A
private repository the viewer cannot read is indistinguishable from one that
does not exist. Private data nobody has opened in 90 days is deleted. The sync
model's own history (when each sync ran, which account asked, how it ended)
outlives that deletion, so it records repositories and accounts by GitHub's
ids only, never by name.

Login is a GitHub App with read-only permissions (Pull requests, Metadata).
User tokens expire after eight hours; bilan stores them encrypted and refreshes
them, including mid-sync. Private repositories require the app to be installed
on the organization, once, by an owner; members can request it from the app's
install page. Public repositories need no install.

Installation callbacks without browser-bound OAuth state restart normal
sign-in; their supplied authorization code is never used to create a session.
Authenticated responses are not browser-cacheable, and dynamic responses
disallow framing.

## Sync admission

Sync admission is atomic in D1: one active job per repository, at most two
active jobs and 20 starts per account in a rolling 24 hours, and at most 20
active jobs and 200 starts globally. Deepening history still consumes these
budgets; failed attempts count toward the daily budget. A repeated sync of the
same depth has a 10-minute cooldown. The limits live in
`packages/store-d1/src/jobs.ts`.

## The sync model

Whether a repository is syncing is decided by one model, `packages/domain`,
hosted on Durable Objects by the `bilan-domain` Worker: a run is requested,
admitted against those quotas, started on the Workflow, and reports each step
back. A request not admitted within two minutes expires; a run silent for ten
minutes is given up and stopped (a rate-limit pause is announced, and held to
ten minutes after it ends); no run lasts past six hours. `sync_jobs` follows
the model, so the quotas and the job history read what it decided. A page
following a sync gets a Server-Sent Event each time the model's status
changes (`/api/repos/:owner/:name/live`), behind the same access check as the
dashboard, and reads the job again on each one. bilan-domain reads the status
every two seconds for an open stream, sends only the phase, and ends the
stream with the run, or after ten minutes.
