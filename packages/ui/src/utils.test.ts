import { afterEach, describe, expect, it, vi } from 'vitest';

import { fitPair, fitPath, fitText, holdHeight } from './utils.ts';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A node happy-dom measures `px` tall. */
const measured = (px: number): HTMLElement => {
  const node = document.createElement('div');
  vi.spyOn(node, 'offsetHeight', 'get').mockReturnValue(px);
  return node;
};

describe('holdHeight', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('holds the height through the microtasks the rebuild queued, then lets go', async () => {
    const node = measured(6000);
    const seen: string[] = [];
    holdHeight(node, () => {
      node.textContent = '';
      queueMicrotask(() => seen.push(node.style.minHeight));
    });
    expect(node.style.minHeight).toBe('6000px');
    await flush();
    expect(seen).toEqual(['6000px']);
    expect(node.style.minHeight).toBe('');
  });

  it('gives back a min-height the node already had', async () => {
    const node = measured(6000);
    node.style.minHeight = '40px';
    holdHeight(node, () => {});
    await flush();
    expect(node.style.minHeight).toBe('40px');
  });

  it('lets go when the rebuild throws', async () => {
    const node = measured(6000);
    expect(() =>
      holdHeight(node, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    await flush();
    expect(node.style.minHeight).toBe('');
  });
});

describe('fitText', () => {
  it('keeps text that fits, and cuts its end otherwise', () => {
    expect(fitText('jamesopstad', 11)).toBe('jamesopstad');
    expect(fitText('jamesopstad', 8)).toBe('jamesop…');
  });
});

describe('fitPair', () => {
  it('keeps a pair that fits whole', () => {
    expect(fitPair('workers-devprod', 'petebacondarwin', 30)).toEqual([
      'workers-devprod',
      'petebacondarwin',
    ]);
  });

  it('cuts the longer name first, leaving a short one whole', () => {
    expect(fitPair('bob', 'carol-from-the-platform-team', 20)).toEqual([
      'bob',
      'carol-from-the-p…',
    ]);
    expect(fitPair('carol-from-the-platform-team', 'bob', 20)).toEqual([
      'carol-from-the-p…',
      'bob',
    ]);
  });

  it('splits the room when both names are long', () => {
    expect(fitPair('workers-devprod', 'petebacondarwin', 22)).toEqual([
      'workers-de…',
      'petebacond…',
    ]);
  });
});

describe('fitPath', () => {
  it('keeps a path that fits whole', () => {
    expect(fitPath('packages/integrations/node', 30)).toEqual(['packages/integrations/', 'node']);
    expect(fitPath('root', 30)).toEqual(['', 'root']);
  });

  it('drops leading folders before the name', () => {
    expect(fitPath('packages/integrations/cloudflare', 25)).toEqual([
      '…/integrations/',
      'cloudflare',
    ]);
    expect(fitPath('packages/language-tools/language-server', 25)).toEqual([
      '…/',
      'language-server',
    ]);
  });

  it('cuts a name that cannot fit on its own', () => {
    expect(fitPath('packages/edge-preview-authenticated-proxy', 12)).toEqual(['', 'edge-previe…']);
  });
});
