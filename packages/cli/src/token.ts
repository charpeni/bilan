import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * `--token`, then `GITHUB_TOKEN`, then whatever `gh auth token` reports.
 * Returns the token and where it came from, for the progress output.
 */
export async function resolveToken(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token: string; source: string }> {
  if (explicit) return { token: explicit, source: '--token' };
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, source: 'GITHUB_TOKEN' };
  if (env.GH_TOKEN) return { token: env.GH_TOKEN, source: 'GH_TOKEN' };
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token']);
    const token = stdout.trim();
    if (token) return { token, source: 'gh auth token' };
  } catch {
    // gh is not installed or not logged in; fall through.
  }
  throw new Error('No GitHub token found. Pass --token, set GITHUB_TOKEN, or run `gh auth login`.');
}
