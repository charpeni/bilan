import * as Schema from 'effect/Schema';

/**
 * Whose GitHub token the run reads with: the server's, or a signed-in user's
 * (resolved again inside every step, since user tokens expire).
 */
export const TokenSource = Schema.Union([
  Schema.TaggedStruct('Server', {}),
  Schema.TaggedStruct('User', { userId: Schema.Int }),
]);
export type TokenSource = typeof TokenSource.Type;

/** How far back a run guarantees activity; `all` walks the whole history. */
export const SyncDepth = Schema.Literals(['30d', '90d', '180d', 'all']);
export type SyncDepth = typeof SyncDepth.Type;

/**
 * What a run is asked to do, in the model's words. The repository is known
 * by its id alone (the aggregate's key): the model's history outlives the
 * repository's 90-day retention, so it keeps no name. The runner looks the
 * name up when it starts a run.
 */
export const SyncRun = Schema.Struct({
  /** Recorded by runs requested before names were dropped; nothing reads them. */
  owner: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  mode: Schema.Literals(['incremental', 'full']),
  depth: SyncDepth,
  /** ISO bound the run walks back to; null for full history. */
  since: Schema.NullOr(Schema.String),
  maxPrs: Schema.NullOr(Schema.Int),
  tokenSource: TokenSource,
});
export type SyncRun = typeof SyncRun.Type;
