import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/** GitHub users who signed in. `id` is GitHub's numeric user id. */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  login: text('login').notNull(),
  avatarUrl: text('avatar_url'),
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  /** Hex SHA-256 of the session cookie's value, never the value itself; see `createSession`. */
  id: text('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
});

export const userTokens = sqliteTable('user_tokens', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  encryptedToken: text('encrypted_token').notNull(),
  /** Unused since the GitHub App login: a GitHub App ignores OAuth scopes. Kept so no data migration is needed. */
  scopes: text('scopes'),
  /** GitHub App user tokens expire (8 h); both are null when expiry is disabled on the app. */
  encryptedRefreshToken: text('encrypted_refresh_token'),
  /** ISO instant the access token expires, or null when it does not. */
  expiresAt: text('expires_at'),
  /** ISO instant the refresh token expires (6 months), or null. */
  refreshExpiresAt: text('refresh_expires_at'),
  createdAt: text('created_at').notNull(),
});

/** One row per synced repository. `id` is GitHub's GraphQL node id. */
export const repos = sqliteTable(
  'repos',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),
    defaultBranch: text('default_branch'),
    totalPrs: integer('total_prs'),
    lastSyncedAt: text('last_synced_at'),
    lastFullSyncAt: text('last_full_sync_at'),
    /** See `RepoMeta.coverageSince`; null is full history (or never synced). */
    coverageSince: text('coverage_since'),
    /** See `RepoMeta.openPrsSyncedAt`; null until a run has walked every open PR. */
    openPrsSyncedAt: text('open_prs_synced_at'),
    /** See `RepoMeta.interrupted`: set by `markStarted`, null once a complete `markSynced` ran. */
    syncStartedAt: text('sync_started_at'),
    /** See `RepoMeta.reconciledAt`: the `sync_started_at` of the last complete run. */
    reconciledAt: text('reconciled_at'),
    /** JSON-encoded `AreaRules`, or null to infer areas from the file samples. */
    areasOverride: text('areas_override'),
  },
  (t) => [unique('repos_owner_name').on(t.owner, t.name)],
);

/** The compacted `RawPr` per PR, stored as JSON text. */
export const pullRequests = sqliteTable(
  'pull_requests',
  {
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    updatedAt: text('updated_at').notNull(),
    data: text('data').notNull(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.number] })],
);

export const syncJobs = sqliteTable(
  'sync_jobs',
  {
    /** The workflow instance id. */
    id: text('id').primaryKey(),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    requestedBy: integer('requested_by').references(() => users.id, { onDelete: 'set null' }),
    mode: text('mode').notNull(),
    maxPrs: integer('max_prs'),
    status: text('status').notNull(),
    pointsSpent: integer('points_spent').notNull().default(0),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
    /** Heartbeat: set when the run starts and after every page step. */
    progressAt: text('progress_at'),
  },
  (t) => [
    index('sync_jobs_repo_created').on(t.repoId, t.createdAt),
    index('sync_jobs_user_created').on(t.requestedBy, t.createdAt),
    index('sync_jobs_status_user').on(t.status, t.requestedBy),
    index('sync_jobs_created').on(t.createdAt),
  ],
);

export const repoViews = sqliteTable(
  'repo_views',
  {
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastViewedAt: text('last_viewed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.userId] })],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type UserToken = typeof userTokens.$inferSelect;
export type RepoView = typeof repoViews.$inferSelect;
export type Repo = typeof repos.$inferSelect;
export type NewRepo = typeof repos.$inferInsert;
export type SyncJob = typeof syncJobs.$inferSelect;
export type NewSyncJob = typeof syncJobs.$inferInsert;
