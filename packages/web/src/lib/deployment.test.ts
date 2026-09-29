import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../../../.github/workflows/deploy.yml', import.meta.url),
  'utf8',
);
// The gate uses equality and conjunction, with the same semantics for these
// string-valued fixtures in GitHub expressions and JavaScript. Fail if its
// shape changes so new expression syntax is reviewed explicitly.
const condition = workflow.match(/^    if: >-\n((?:      .+\n)+)/m)?.[1]?.trim();
const canonical = { full_name: 'charpeni/bilan' };
const successfulPush = {
  conclusion: 'success',
  event: 'push',
  head_branch: 'main',
  head_repository: canonical,
};

describe('deployment provenance', () => {
  it.each([
    ['canonical main push', successfulPush, true],
    [
      'fork pull request named main',
      {
        ...successfulPush,
        event: 'pull_request',
        head_repository: { full_name: 'outsider/bilan' },
      },
      false,
    ],
    ['same-repository pull request', { ...successfulPush, event: 'pull_request' }, false],
    [
      'fork push named main',
      { ...successfulPush, head_repository: { full_name: 'outsider/bilan' } },
      false,
    ],
    ['feature branch push', { ...successfulPush, head_branch: 'feature' }, false],
    ['failed main push', { ...successfulPush, conclusion: 'failure' }, false],
  ])('only deploys trusted CI: %s', (_name, run, expected) => {
    expect(condition).toBeDefined();
    expect(
      runInNewContext(
        `(${condition})`,
        {
          github: { repository: canonical.full_name, event: { workflow_run: run } },
        },
        { timeout: 100 },
      ),
    ).toBe(expected);
  });
});
