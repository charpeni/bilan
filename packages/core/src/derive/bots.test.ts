import { describe, expect, it } from 'vitest';

import { rawPr } from '../testing/fixtures.ts';
import { detectBots } from './bots.ts';

describe('detectBots', () => {
  it('collects app accounts and bot-looking logins from authors and reviewers', () => {
    const bots = detectBots([
      rawPr({ author: 'dependabot[bot]', authorType: 'Bot' }),
      rawPr({ author: 'renovate', authorType: 'User' }),
      rawPr({
        author: 'alice',
        reviews: [
          {
            author: 'coderabbitai[bot]',
            authorType: 'Bot',
            state: 'COMMENTED',
            at: '2026-01-01T11:00:00Z',
          },
        ],
      }),
      rawPr({ author: 'deploy-bot', authorType: 'User' }),
    ]);
    expect([...bots].toSorted()).toEqual([
      'coderabbitai[bot]',
      'dependabot[bot]',
      'deploy-bot',
      'renovate',
    ]);
  });

  it('leaves humans alone', () => {
    expect(detectBots([rawPr({ author: 'robot-fan' }), rawPr({ author: 'bobby' })]).size).toBe(0);
  });
});
