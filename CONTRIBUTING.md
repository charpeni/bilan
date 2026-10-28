# Contributing

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

How the web app fits together is in [docs/architecture.md](docs/architecture.md);
running your own deployment, in [docs/self-hosting.md](docs/self-hosting.md).

## Releasing the CLI

Pushing a `vX.Y.Z` tag publishes the CLI to npm through the `Publish` workflow.
The tag must match the version in `packages/cli/package.json` and point to a
commit on `main`; a prerelease version is published under the `next` dist-tag.
A release is published through npm trusted publishing with provenance, or not
at all: no npm token is stored, the package's trusted publisher on npmjs.com
names the repository, the `publish.yml` workflow and the `npm` environment, and
the workflow refuses to publish from a private repository, where npm does not
accept provenance.
