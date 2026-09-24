import { getRepoById } from '@bilan/store-d1';
import { env } from 'cloudflare:workers';

import { getDb } from '../../../lib/db.ts';
import { json, loginRequired } from '../../../lib/http.ts';
import { isSettledJobStatus, jobVisibility } from '../../../lib/job-visibility.ts';
import { getJob } from '../../../lib/jobs.ts';
import { isExampleRepo } from '../../../lib/stale.ts';

import type { APIRoute } from 'astro';

const unknownJob = () => json({ message: 'unknown job' }, 404);

/**
 * A job's status is decided from its row alone (`jobVisibility`): the
 * viewer's own jobs and the example repo's are readable, everything else
 * (another user's job, an unknown id) answers the same 404, or 401 signed
 * out. GitHub is never asked, so a job id can never be turned into a probe,
 * and a GitHub outage never changes the answer.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  const id = params.id as string;
  const db = getDb(env);
  const user = locals.user;
  const job = await getJob(db, id);
  // Rows keep the casing they were first asked for, so the example repo is
  // matched by name (case-insensitively) on the job's own row. Its visibility
  // travels along: only a public example repo's jobs are readable by anyone.
  const repo = job === undefined ? undefined : await getRepoById(db, job.repoId);
  const exampleRepo =
    repo && isExampleRepo(env, repo.owner, repo.name)
      ? { id: repo.id, isPrivate: repo.isPrivate }
      : null;

  const visibility = jobVisibility({ job, user, exampleRepo });
  if (visibility === 'login-required') return loginRequired();
  if (visibility === 'unknown' || job === undefined) return unknownJob();

  let workflow: { status: string; error?: { name: string; message: string } } | null = null;
  try {
    const status = await (await env.SYNC_REPO.get(id)).status();
    workflow = status.error
      ? { status: status.status, error: status.error }
      : { status: status.status };
  } catch {
    // The instance may be gone once its retention window passes; the row is the record.
  }
  // `settled`: a payload was published (`complete`, or `partial` for a budget-cut run).
  return json({ ...job, settled: isSettledJobStatus(job.status), workflow }, 200, {
    'cache-control': 'no-store',
  });
};
