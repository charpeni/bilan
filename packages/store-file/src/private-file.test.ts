import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writePrivateFile } from './private-file.ts';

const directories: string[] = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'bilan-private-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('private reports', () => {
  it.skipIf(process.platform === 'win32')('creates and replaces an export with mode 0600', () => {
    const directory = temporaryDirectory();
    const target = join(directory, 'report.html');
    writePrivateFile(target, 'private report');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    chmodSync(target, 0o644);
    writePrivateFile(target, 'updated private report');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, 'utf8')).toBe('updated private report');
    expect(readdirSync(directory)).toEqual(['report.html']);
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow a symlink when replacing an export',
    () => {
      const directory = temporaryDirectory();
      const victim = join(directory, 'unrelated.txt');
      const target = join(directory, 'report.html');
      writeFileSync(victim, 'keep');
      symlinkSync(victim, target);
      writePrivateFile(target, 'report');
      expect(readFileSync(victim, 'utf8')).toBe('keep');
      expect(readFileSync(target, 'utf8')).toBe('report');
      expect(statSync(target).mode & 0o777).toBe(0o600);
    },
  );
});
