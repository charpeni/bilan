import { env } from 'cloudflare:workers';

import { getDb } from '../../../lib/db.ts';
import { json, loginRequired } from '../../../lib/http.ts';
import { isSettledJobStatus, jobVisibility } from '../../../lib/job-visibility.ts';
import { countStoredPrs, getJob } from '../../../lib/jobs.ts';

import type { APIRoute } from 'astro';

const unknownJob = () => json({ message: 'unknown job' }, 404);

/**
 * A job's status is decided from its row alone (`jobVisibility`): the
 * viewer's own jobs are readable, everything else (another user's job, an
 * unknown id) answers the same 404, or 401 signed out. GitHub is never
 * asked, so a job id can never be turned into a probe, and a GitHub outage
 * never changes the answer.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  const id = params.id as string;
  const db = getDb(env);
  const user = locals.user;
  const job = await getJob(db, id);

  const visibility = jobVisibility({ job, user });
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
  // `prsStored`: rows written for the repo so far, which the page shows as progress.
  const settled = isSettledJobStatus(job.status);
  const prsStored = await countStoredPrs(db, job.repoId);
  return json({ ...job, settled, prsStored, workflow }, 200, {
    'cache-control': 'no-store',
  });
};
