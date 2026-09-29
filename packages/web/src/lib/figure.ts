/**
 * Split a formatted figure into its number and a trailing unit: `1.6h` →
 * `['1.6', 'h']`, `75%` → `['75', '%']`, `<1m` → `['<1', 'm']`. Anything else
 * (a plain count, a dash) comes back whole with an empty unit, so joining the
 * two parts always gives the input back.
 */
export function splitUnit(value: string): [string, string] {
  const match = /^([<>]?[\d.,]+)([a-z%]+)$/i.exec(value);
  const number = match?.[1];
  const unit = match?.[2];
  return number !== undefined && unit !== undefined ? [number, unit] : [value, ''];
}
