// Split math for Podcasting 2.0 value blocks, in whole sats.
//
// Rules (from the podcast namespace "value" companion doc):
//  - fee="true" recipients take `split` PERCENT of the total off the top;
//  - everyone else shares the remainder in proportion to their `split` SHARES.
// We work in whole sats (a Cashu sat mint cannot pay fractions), using the
// largest-remainder method so the parts always add up to the total exactly.
// Ties go to the earlier recipient in feed order (deterministic).

import { isPayableByMint } from './feed.js';

function largestRemainder(total, weights) {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map((x) => Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i] += 1;
  return out;
}

/**
 * Compute how many sats each recipient gets.
 * @param {number} totalSats  whole sats the listener wants to boost
 * @param {Array} recipients  from parseValueBlocks()
 * @param {{unpayable?: 'skip'|'redistribute', minSats?: number}} [opts]
 *   unpayable='skip' (default): shares of recipients a mint cannot pay (keysend `node`
 *   recipients) are computed and shown but not charged - the listener keeps them.
 *   unpayable='redistribute': they are left out of the math, so payable recipients
 *   share the full amount.
 * @returns {{lines: Array<{recipient, sats:number, payable:boolean, reason?:string}>, payTotal:number, keptSats:number}}
 */
export function computeSplits(totalSats, recipients, opts = {}) {
  const policy = opts.unpayable || 'skip';
  const minSats = opts.minSats ?? 1;
  if (!Number.isInteger(totalSats) || totalSats < 0) throw new Error('totalSats must be a non-negative integer');
  const all = (recipients || []).filter((r) => r.split > 0);
  const considered = policy === 'redistribute' ? all.filter(isPayableByMint) : all;

  const sats = new Map();
  const fees = considered.filter((r) => r.fee);
  const shares = considered.filter((r) => !r.fee);
  let feeTotal = 0;
  // fee recipients: percent of total, floor, but never exceed total
  const feeAmounts = fees.map((r) => Math.floor((totalSats * Math.min(r.split, 100)) / 100));
  for (let i = 0; i < fees.length; i++) {
    const amt = Math.min(feeAmounts[i], totalSats - feeTotal);
    sats.set(fees[i], amt);
    feeTotal += amt;
  }
  const rest = totalSats - feeTotal;
  if (shares.length) {
    const parts = largestRemainder(rest, shares.map((r) => r.split));
    shares.forEach((r, i) => sats.set(r, parts[i]));
  } else if (fees.length && rest > 0) {
    // only fee recipients: hand the remainder to them by their percentages
    const parts = largestRemainder(rest, fees.map((r) => r.split));
    fees.forEach((r, i) => sats.set(r, sats.get(r) + parts[i]));
  }

  const lines = all.map((r) => {
    const s = sats.get(r) ?? 0;
    if (!isPayableByMint(r)) {
      return { recipient: r, sats: policy === 'redistribute' ? 0 : s, payable: false,
        reason: r.type === 'node' ? 'keysend-only (a mint can only pay invoices)' : 'unsupported recipient type' };
    }
    if (s < minSats) return { recipient: r, sats: s, payable: false, reason: `below minimum (${minSats} sat)` };
    return { recipient: r, sats: s, payable: true };
  });
  const payTotal = lines.filter((l) => l.payable).reduce((a, l) => a + l.sats, 0);
  return { lines, payTotal, keptSats: totalSats - payTotal };
}
