import { describe, expect, it } from 'vitest';

import { renderReport } from './report.ts';

import type { Payload } from '@bilan/core';

const payload: Payload = {
  repo: 'acme/<widgets>',
  syncedAt: '2026-02-01T00:00:00Z',
  coverageSince: null,
  openPrsSyncedAt: '2026-02-01T00:00:00Z',
  areas: ['src', 'other', 'root'],
  bots: [],
  prs: [],
};

describe('renderReport', () => {
  const html = renderReport(payload, { css: 'body{color:red}', js: 'var BilanUI = {mount(){}};' });

  it('inlines the assets and embeds the payload', () => {
    expect(html).toContain('<style>\nbody{color:red}\n</style>');
    expect(html).toContain('var BilanUI = {mount(){}};');
    expect(html).toContain('<script id="payload" type="application/json">');
    expect(html).toContain('BilanUI.mount(');
  });

  it('escapes the title and the payload', () => {
    expect(html).toContain('<title>acme/&lt;widgets&gt; · bilan</title>');
    expect(html).toContain('"repo":"acme/\\u003cwidgets>"');
  });
});
