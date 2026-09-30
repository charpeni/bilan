import { accessSync, constants, existsSync, lstatSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { writePrivateFile } from '@bilan/store-file';

export function validateReportPath(path: string): void {
  if (!path) throw new Error('--out must name a report file');
  if (existsSync(path) && lstatSync(path).isDirectory())
    throw new Error(`--out "${path}" is a directory; choose a file`);
  const parent = dirname(path);
  try {
    if (!statSync(parent).isDirectory()) throw new Error('Parent is not a directory');
    accessSync(parent, constants.W_OK | constants.X_OK);
  } catch (cause) {
    throw new Error(
      `Cannot write --out "${path}": its parent directory must exist and be writable`,
      { cause },
    );
  }
}

export function writeReport(path: string, html: string): void {
  try {
    writePrivateFile(path, html);
  } catch (cause) {
    const code =
      cause !== null && typeof cause === 'object' && 'code' in cause
        ? String(cause.code)
        : 'file write failed';
    throw new Error(`Could not write --out "${path}": ${code}`, { cause });
  }
}
