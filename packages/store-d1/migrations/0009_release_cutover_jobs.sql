-- Release sync_jobs rows the old code left active when syncs moved to the sync
-- model (#21). The site switched over at 2026-10-28T16:59:58Z: a run started
-- before that resumes on the new code without the repository id its reports
-- need, so it can never report its end, and nothing reconciles rows any more.
-- Such a row would block new syncs of its repository and count against its
-- requester's quota forever. Rows created after the switch are not touched.
UPDATE sync_jobs
SET status = 'errored',
  error = 'lost: cutover to the sync model',
  finished_at = '2026-10-28T16:59:58.000Z'
WHERE status IN ('queued', 'running')
  AND created_at < '2026-10-28T16:59:58.000Z';
