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

/** What a run is asked to do: everything `SyncRunner.start` needs, in the model's words. */
export const SyncRun = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  mode: Schema.Literals(['incremental', 'full']),
  /** How far back to guarantee activity, as the web app names it (`30d`, `all`, ...). */
  depth: Schema.String,
  /** ISO bound the run walks back to; null for full history. */
  since: Schema.NullOr(Schema.String),
  maxPrs: Schema.NullOr(Schema.Int),
  tokenSource: TokenSource,
});
export type SyncRun = typeof SyncRun.Type;
