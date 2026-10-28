import * as Schema from 'effect/Schema';

/** A repository, by GitHub's GraphQL node id: the `repos.id` bilan already keys it by. */
export const RepoId = Schema.String.pipe(Schema.brand('RepoId'));
export type RepoId = typeof RepoId.Type;

/** One sync run: the Workflow instance id and the `sync_jobs.id`. */
export const JobId = Schema.String.pipe(Schema.brand('JobId'));
export type JobId = typeof JobId.Type;
