import * as Domain from '@alchemy.run/domain';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

import { SyncAdmitted } from './AdmitSync.command.ts';
import { ExpireAdmission } from './ExpireAdmission.command.ts';
import { ExpireStalledSync } from './ExpireStalledSync.command.ts';
import { ExpireSync } from './ExpireSync.command.ts';
import { SyncStarted } from './MarkSyncStarted.command.ts';
import { SyncPaused } from './PauseSync.command.ts';
import { SyncProgressed } from './RecordSyncProgress.command.ts';
import { RepoSync } from './RepoSync.aggregate.ts';
import { SyncRequested } from './RequestSync.command.ts';

import type { JobId, RepoId } from './RepoSync.id.ts';
import type * as Duration from 'effect/Duration';

/** How long a request may wait between asking and being admitted or released. */
export const ADMISSION_WINDOW = '2 minutes';
/** How long a run may go without reporting before it is given up. */
export const STALL_WINDOW = '10 minutes';
/** How long a run may last at most, pauses included. */
export const RUN_LIMIT = '6 hours';

type When = { readonly after: Duration.Input } | { readonly at: DateTime.Utc };

/**
 * Whenever a request or a run waits on something outside the model, schedule
 * the deadline that gives up on it. Each deadline carries what it is about, so
 * `RepoSync` ignores one that no longer applies: nothing is ever cancelled.
 * Deterministic command ids make a redelivered event schedule the same command.
 */
export class SyncDeadlines extends Domain.Policy('SyncDeadlines', {
  from: RepoSync,
  on: [SyncRequested, SyncAdmitted, SyncStarted, SyncProgressed, SyncPaused],
}) {}

export const SyncDeadlinesLive = SyncDeadlines.toLayer(
  Effect.gen(function* () {
    const repos = yield* RepoSync;
    /** A fresh stall check, about the run as of the event at `beat`. */
    const checkStall = (repo: RepoId, jobId: JobId, beat: number, when: When) =>
      repos.schedule(repo, new ExpireStalledSync({ jobId, beat }), {
        ...when,
        commandId: `stall:${jobId}:${beat}`,
      });
    return Effect.fn(function* ({ source, event, envelope }) {
      switch (event._tag) {
        case 'SyncRequested':
          return yield* repos.schedule(source, new ExpireAdmission({ jobId: event.jobId }), {
            after: ADMISSION_WINDOW,
            commandId: `admission:${event.jobId}`,
          });
        case 'SyncAdmitted':
          yield* repos.schedule(source, new ExpireSync({ jobId: event.jobId }), {
            after: RUN_LIMIT,
            commandId: `limit:${event.jobId}`,
          });
          return yield* checkStall(source.id, event.jobId, envelope.seq, { after: STALL_WINDOW });
        case 'SyncStarted':
        case 'SyncProgressed':
          return yield* checkStall(source.id, event.jobId, envelope.seq, { after: STALL_WINDOW });
        case 'SyncPaused':
          // Quiet until the rate limit resets, then held to the usual window.
          return yield* checkStall(source.id, event.jobId, envelope.seq, {
            at: DateTime.addDuration(event.until, STALL_WINDOW),
          });
      }
    });
  }),
);
