import { describe, it, expect } from 'vitest';
import { computeSplits } from '../src/split.js';

const ln = (name, split, extra = {}) => ({ name, type: 'lnaddress', address: `${name.toLowerCase()}@ex.com`, split, ...extra });
const node = (name, split) => ({ name, type: 'node', address: '03' + 'a'.repeat(64), split });
const sats = (r) => r.lines.map((l) => l.sats);

describe('computeSplits', () => {
  it('splits by shares and always sums to the total', () => {
    for (let total = 0; total <= 500; total++) {
      const r = computeSplits(total, [ln('A', 1), ln('B', 1), ln('C', 1)]);
      expect(r.lines.reduce((a, l) => a + l.sats, 0)).toBe(total);
    }
  });
  it('largest remainder, ties to feed order', () => {
    expect(sats(computeSplits(10, [ln('A', 1), ln('B', 1), ln('C', 1)]))).toEqual([4, 3, 3]);
    expect(sats(computeSplits(21, [ln('A', 80), ln('B', 20)]))).toEqual([17, 4]);
    expect(sats(computeSplits(100, [ln('A', 50), ln('B', 40), ln('C', 10)]))).toEqual([50, 40, 10]);
  });
  it('shares need not add to 100', () => {
    expect(sats(computeSplits(100, [ln('A', 3), ln('B', 1)]))).toEqual([75, 25]);
  });
  it('fee recipients take a percentage off the top', () => {
    const r = computeSplits(1000, [ln('Host', 50), ln('Cohost', 50), ln('App', 2, { fee: true })]);
    expect(sats(r)).toEqual([490, 490, 20]);
    expect(r.payTotal).toBe(1000);
  });
  it('skips keysend recipients by default and the listener keeps their share', () => {
    const r = computeSplits(100, [ln('A', 50), ln('B', 40), node('K', 10)]);
    expect(sats(r)).toEqual([50, 40, 10]);
    expect(r.lines[2].payable).toBe(false);
    expect(r.payTotal).toBe(90);
    expect(r.keptSats).toBe(10);
  });
  it('can redistribute unpayable shares instead', () => {
    const r = computeSplits(100, [ln('A', 50), ln('B', 40), node('K', 10)], { unpayable: 'redistribute' });
    expect(sats(r)).toEqual([56, 44, 0]);
    expect(r.payTotal).toBe(100);
  });
  it('marks dust below the minimum as unpayable', () => {
    const r = computeSplits(10, [ln('A', 99), ln('B', 1)]);
    expect(sats(r)).toEqual([10, 0]);
    expect(r.lines[1].payable).toBe(false);
    expect(r.payTotal).toBe(10);
  });
  it('ignores zero/invalid splits', () => {
    expect(computeSplits(10, [ln('A', 0), ln('B', 5)]).lines).toHaveLength(1);
  });
  it('rejects fractional totals', () => {
    expect(() => computeSplits(1.5, [ln('A', 1)])).toThrow();
  });
});
