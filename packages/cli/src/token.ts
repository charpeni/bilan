import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const checked = (value: string, source: string): { token: string; source: string } => {
  const token = value.trim();
  if (!token || /\s/.test(token))
    throw new Error(`${source} must contain a non-empty token without whitespace`);
  return { token, source };
};

/**
 * `--token`, then `GITHUB_TOKEN`, `GH_TOKEN`, and `gh auth token`.
 * Returns the token and where it came from, for the progress output.
 */
export async function resolveToken(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token: string; source: string }> {
  if (explicit !== undefined) return checked(explicit, '--token');
  if (env.GITHUB_TOKEN?.trim()) return checked(env.GITHUB_TOKEN, 'GITHUB_TOKEN');
  if (env.GH_TOKEN?.trim()) return checked(env.GH_TOKEN, 'GH_TOKEN');
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    const token = stdout.trim();
    if (token) return checked(token, 'gh auth token');
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'killed' in error && error.killed) {
      throw new Error('Timed out waiting for gh auth token. Pass --token or set GITHUB_TOKEN.', {
        cause: error,
      });
    }
    // gh is not installed or not logged in; fall through.
  }
  throw new Error('No GitHub token found. Pass --token, set GITHUB_TOKEN, or run `gh auth login`.');
}
