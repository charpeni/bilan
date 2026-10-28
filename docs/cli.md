# CLI reference

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

## Fresh syncs and offline reports

`--no-cache` builds a new cache beside the old one (`<name>.json.fresh`) and
only replaces it once the fresh sync finishes; a fresh sync stopped by the rate
limit, `--max-prs` or an interruption keeps the old cache, which the report then
shows, and running `--no-cache` again continues it. One fresh sync of a
repository runs at a time.

`--offline` only renders what is cached, so it rejects the sync options
`--no-cache`, `--full`, `--since`, `--max-prs` and `--token`; tokens in the
environment are ignored.

## Areas

`--areas` replaces the inferred areas with a JSON file of folder paths from the
repository root, nested ones included:
`{ "known": ["docs", "packages/app", "packages/integrations/node"] }`. A changed
file counts toward the deepest listed folder holding it, other nested files
toward `other`, and files at the root toward `root`. Lockfiles, `.changeset/`
and release or dependency pull requests still count toward no area.

## Coverage, rate limits, and the cache

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
