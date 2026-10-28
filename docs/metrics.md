# What the numbers mean

## Period comparisons

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

## Metrics

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

## Areas

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

## Drafts, anchors, and review depth

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
