# bilan

The pulse of a GitHub repository.

Powered by [Effect](https://effect.website) and [Alchemy](https://alchemy.run)
on [Cloudflare](https://workers.cloudflare.com).

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

Caching, rate limits, and custom areas are covered in the
[CLI reference](https://github.com/charpeni/bilan/blob/main/docs/cli.md).

## Web app

Open [bilan.dev](https://bilan.dev) to see two example dashboards
([`withastro/astro`](https://bilan.dev/withastro/astro) and
[`cloudflare/workers-sdk`](https://bilan.dev/cloudflare/workers-sdk)) and any
public repository bilan already holds. Sign in with GitHub to sync a
repository you can read; the dashboard link works for any coworker who can
read it too.

- Sign-in is a GitHub App with read-only access to pull requests and
  repository metadata. Private repositories need the app installed on the
  organization once.
- Every viewer is checked against GitHub with their own access: a private
  repository you cannot read looks the same as one that does not exist.
- Private data nobody has opened in 90 days is deleted.

## What the numbers mean

Each metric is anchored to its own event, so "last 30 days" counts what
happened in those 30 days. The 7-, 30-, 90-, and 180-day views compare each
headline number with the period before. Areas are the folders, or monorepo
packages, that pull requests change.

Every metric's exact definition is in
[What the numbers mean](https://github.com/charpeni/bilan/blob/main/docs/metrics.md).

## Documentation

- [CLI reference](https://github.com/charpeni/bilan/blob/main/docs/cli.md): every option, the cache, and rate limits.
- [What the numbers mean](https://github.com/charpeni/bilan/blob/main/docs/metrics.md): how each metric is measured.
- [How bilan.dev works](https://github.com/charpeni/bilan/blob/main/docs/architecture.md): the stack, access and
  privacy, sync quotas, and the sync model.
- [Running bilan yourself](https://github.com/charpeni/bilan/blob/main/docs/self-hosting.md): deploying with
  Alchemy, previews, local development, and storage maintenance.
- [Contributing](https://github.com/charpeni/bilan/blob/main/CONTRIBUTING.md): building, testing, the packages, and
  releasing the CLI.

## License

MIT.
