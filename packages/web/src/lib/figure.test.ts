import { describe, expect, it } from 'vitest';

import { splitUnit } from './figure.ts';

describe('splitUnit', () => {
  it('separates a trailing unit from the number', () => {
    expect(splitUnit('1.6h')).toEqual(['1.6', 'h']);
    expect(splitUnit('13d')).toEqual(['13', 'd']);
    expect(splitUnit('1.2mo')).toEqual(['1.2', 'mo']);
    expect(splitUnit('75%')).toEqual(['75', '%']);
    expect(splitUnit('<1m')).toEqual(['<1', 'm']);
  });

  it('leaves plain counts and placeholders whole', () => {
    expect(splitUnit('139')).toEqual(['139', '']);
    expect(splitUnit('1,071')).toEqual(['1,071', '']);
    expect(splitUnit('—')).toEqual(['—', '']);
  });

  it('always joins back to the input', () => {
    for (const v of ['2m', '21h', '100%', '9,812', '—', '4.8d']) {
      expect(splitUnit(v).join('')).toBe(v);
    }
  });
});
