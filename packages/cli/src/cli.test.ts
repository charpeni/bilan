import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { describeCoverage, main, openInBrowser, openerArgv } from './cli.ts';

/** Run `fn` with `stream.write` captured, returning what was written. */
async function capture(
  stream: NodeJS.WriteStream,
  fn: () => Promise<void> | void,
): Promise<string> {
  const chunks: string[] = [];
  const original = stream.write;
  stream.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof stream.write;
  try {
    await fn();
  } finally {
    stream.write = original;
  }
  return chunks.join('');
}

describe('describeCoverage', () => {
  const since = '2026-08-24T10:00:00.000Z';

  it('names the bound date or full history', () => {
    expect(describeCoverage({ coverageSince: since, openPrsComplete: true, complete: true })).toBe(
      'covers activity since 2026-08-24 (plus all open PRs)',
    );
    expect(describeCoverage({ coverageSince: null, openPrsComplete: true, complete: true })).toBe(
      'covers full history',
    );
    expect(describeCoverage({ coverageSince: null, openPrsComplete: false, complete: true })).toBe(
      'covers full history',
    );
  });

  it('only claims every open PR when the open set is complete', () => {
    expect(describeCoverage({ coverageSince: since, openPrsComplete: false, complete: true })).toBe(
      'covers activity since 2026-08-24 (open PRs partially synced; run again to finish)',
    );
  });

  it('flags a budget-cut run as partial and claims only the stored bound', () => {
    expect(
      describeCoverage({ coverageSince: since, openPrsComplete: false, complete: false }),
    ).toBe('covers activity since 2026-08-24 (partial run; run again to finish)');
    expect(describeCoverage({ coverageSince: null, openPrsComplete: false, complete: false })).toBe(
      'covers full history (partial run; run again to finish)',
    );
  });
});

describe('openerArgv', () => {
  it('builds an argument vector per platform, never a shell string', () => {
    const path = 'my report; rm -rf $HOME.html';
    expect(openerArgv(path, 'darwin')).toEqual(['open', [path]]);
    expect(openerArgv(path, 'win32')).toEqual(['rundll32', ['url.dll,FileProtocolHandler', path]]);
    expect(openerArgv(path, 'linux')).toEqual(['xdg-open', [path]]);
    expect(openerArgv(path, 'freebsd')).toEqual(['xdg-open', [path]]);
  });

  it('passes a path full of cmd metacharacters as one literal argument on Windows', () => {
    const path = 'C:\\Users\\me\\Q3 report & "final" 100%TEMP%.html';
    const [command, args] = openerArgv(path, 'win32');
    expect(command).not.toBe('cmd');
    expect(args).toHaveLength(2);
    expect(args[1]).toBe(path);
    expect(args.filter((a) => a === path)).toHaveLength(1);
  });
});

describe('openInBrowser', () => {
  it('warns instead of throwing when the opener is missing', async () => {
    const stderr = await capture(process.stderr, () =>
      openInBrowser('report.html', ['bilan-no-such-opener-4f2c', ['report.html']]),
    );
    expect(stderr).toMatch(/^could not open report\.html with bilan-no-such-opener-4f2c: .*ENOENT/);
    expect(stderr.trim().split('\n')).toHaveLength(1);
  });
});

describe('package manifest', () => {
  it('bundles the workspace packages, so the published manifest has no runtime dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys(manifest.devDependencies ?? {})).toEqual([
      '@bilan/core',
      '@bilan/store-file',
      '@bilan/ui',
      'esbuild',
    ]);
  });
});

describe('main', () => {
  it.each(['0', '-1', '0.5', 'Infinity', '0x10', '9007199254740992'])(
    'rejects invalid PR budget %s even offline',
    async (value) => {
      await expect(main(['acme/widgets', '--offline', `--max-prs=${value}`])).rejects.toThrow(
        /positive integer/,
      );
    },
  );

  it('documents the 30-day default in --help', async () => {
    const usage = await capture(process.stdout, async () => {
      expect(await main(['--help'])).toBe(0);
    });
    expect(usage).toContain('default: the last 30 days');
    expect(usage).toContain('--full');
  });
});
