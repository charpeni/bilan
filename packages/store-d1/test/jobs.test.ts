import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { upsertUser } from '../src/auth.ts';
import { createDb } from '../src/db.ts';
import { admitSyncJob, beginSyncJob, SYNC_CAPACITY } from '../src/jobs.ts';
import { upsertRepo } from '../src/repos.ts';
import { syncJobs } from '../src/schema.ts';

import type { SyncAdmission } from '../src/jobs.ts';

const db = createDb(env.DB);
const now = '2026-09-29T12:00:00.000Z';
let seq = 1000;

beforeEach(async () => {
  await db.delete(syncJobs);
});

async function candidate(userId = ++seq): Promise<SyncAdmission> {
  const n = ++seq;
  await upsertUser(db, { id: userId, login: `user-${userId}`, avatarUrl: null, now });
  await upsertRepo(db, { id: `R_${n}`, owner: 'acme', name: `repo-${n}`, isPrivate: true });
  return {
    id: `job-${n}`,
    repoId: `R_${n}`,
    requestedBy: userId,
    mode: 'incremental',
    maxPrs: null,
    createdAt: now,
    cooldownAfter: null,
  };
}

async function finish(id: string, status = 'complete'): Promise<void> {
  await db.update(syncJobs).set({ status, finishedAt: now }).where(eq(syncJobs.id, id));
}

describe('atomic sync admission', () => {
  it('fences a delayed workflow after its reservation has been retired and replaced', async () => {
    const original = await candidate();
    expect(await admitSyncJob(db, original)).toBe(true);
    await finish(original.id, 'errored');
    const replacement = { ...original, id: 'replacement' };
    expect(await admitSyncJob(db, replacement)).toBe(true);
    expect(await beginSyncJob(db, original.id, now)).toBeUndefined();
    expect(await beginSyncJob(db, replacement.id, now)).toMatchObject({
      id: 'replacement',
      status: 'running',
    });
    expect(
      (await db.select().from(syncJobs).where(eq(syncJobs.id, original.id)).get())?.status,
    ).toBe('errored');
  });
  it('reserves a repository exactly once under concurrent requests', async () => {
    const job = await candidate();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => admitSyncJob(db, { ...job, id: `${job.id}-${i}` })),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(syncJobs)).toHaveLength(1);
  });

  it('limits concurrent jobs across repositories for one user', async () => {
    const first = await candidate();
    const jobs = [first];
    for (let i = 0; i < SYNC_CAPACITY.userConcurrent; i++)
      jobs.push(await candidate(first.requestedBy));
    const results = await Promise.all(jobs.map((job) => admitSyncJob(db, job)));
    expect(results.filter(Boolean)).toHaveLength(SYNC_CAPACITY.userConcurrent);
    expect(await admitSyncJob(db, await candidate())).toBe(true);
  });

  it('releases concurrent capacity on completion and failure, but keeps the daily charge', async () => {
    const first = await candidate();
    for (let i = 0; i < SYNC_CAPACITY.userDaily; i++) {
      const next = { ...first, id: `${first.id}-${i}` };
      expect(await admitSyncJob(db, next)).toBe(true);
      await finish(next.id, i % 2 === 0 ? 'complete' : 'errored');
    }
    // Deeper work has no repo cooldown, but cannot bypass the account budget.
    expect(await admitSyncJob(db, { ...first, id: 'daily-blocked', cooldownAfter: null })).toBe(
      false,
    );
    expect(
      await admitSyncJob(db, {
        ...first,
        id: 'next-day',
        createdAt: '2026-09-30T12:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('enforces a global concurrency cap across users', async () => {
    const jobs: SyncAdmission[] = [];
    for (let i = 0; i <= SYNC_CAPACITY.globalConcurrent; i++) jobs.push(await candidate());
    const results = await Promise.all(jobs.map((job) => admitSyncJob(db, job)));
    expect(results.filter(Boolean)).toHaveLength(SYNC_CAPACITY.globalConcurrent);
  });

  it('enforces the rolling global daily budget even for a new user', async () => {
    const seed = await candidate();
    const rows = Array.from({ length: SYNC_CAPACITY.globalDaily }, (_, i) => ({
      id: `historic-${i}`,
      repoId: seed.repoId,
      requestedBy: seed.requestedBy,
      mode: 'incremental',
      status: 'complete',
      createdAt: now,
      finishedAt: now,
    }));
    // Stay within D1's bound-parameter limit while arranging historic usage.
    for (let i = 0; i < rows.length; i += 10)
      await db.insert(syncJobs).values(rows.slice(i, i + 10));
    expect(await admitSyncJob(db, await candidate())).toBe(false);
  });

  it('enforces the repository cooldown in D1 while allowing a deeper sync', async () => {
    const first = await candidate();
    expect(await admitSyncJob(db, first)).toBe(true);
    await finish(first.id);
    const again = { ...first, id: 'again', cooldownAfter: '2026-09-29T11:50:00.000Z' };
    expect(await admitSyncJob(db, again)).toBe(false);
    expect(await admitSyncJob(db, { ...again, cooldownAfter: null })).toBe(true);
    await finish(again.id);
    expect(
      await admitSyncJob(db, {
        ...again,
        id: 'after-cooldown',
        cooldownAfter: '2026-09-29T12:00:00.000Z',
        createdAt: '2026-09-29T12:10:00.000Z',
      }),
    ).toBe(true);
  });
});
