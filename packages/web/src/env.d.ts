import type { SessionUser } from './lib/session.ts';
import type { SyncRepoParams } from './workflows/sync-repo.ts';
import type { Runtime } from '@astrojs/cloudflare';

declare global {
  /** Bindings declared in wrangler.jsonc. Keep in sync when adding a binding. */
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    PAYLOADS: R2Bucket;
    CACHE: KVNamespace;
    SYNC_REPO: Workflow<SyncRepoParams>;
    /** URL slug of the GitHub App (`https://github.com/apps/<slug>`), for install links. */
    GITHUB_APP_SLUG: string;
    /**
     * Secret, optional: a no-scope server token, the fallback for public repos
     * a viewer's GitHub App token cannot reach (see `lib/token-source.ts`).
     * Only read when that fallback is taken; nothing needs it at startup.
     */
    GITHUB_TOKEN?: string;
    /** Secret: base64 of 32 random bytes; AES-GCM key for per-user tokens at rest. */
    TOKEN_ENCRYPTION_KEY?: string;
    /** Secret: the GitHub App's client id; login is disabled when unset. */
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
  }

  namespace Cloudflare {
    interface Env extends globalThis.Env {}
  }

  namespace App {
    interface Locals extends Runtime {
      /** Set by `src/middleware.ts` from the `bilan_session` cookie; null when signed out. */
      user: SessionUser | null;
    }
  }
}
