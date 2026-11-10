// Split math for Podcasting 2.0 value blocks, in whole sats.
//
// Rules (from the podcast namespace "value" companion doc):
//  - fee="true" recipients take `split` PERCENT of the total off the top;
//  - everyone else shares the remainder in proportion to their `split` SHARES.
// We work in whole sats (a Cashu sat mint cannot pay fractions), using the
// largest-remainder method so the parts always add up to the total exactly.
// Ties go to the earlier recipient in feed order (deterministic).

import { isPayableByMint } from './feed.js';

// Integer largest remainder: floor(total*w/sum), then hand out what is left by the
// exact integer remainder (total*w) % sum, largest first, ties in feed order. Integer
// arithmetic matters: with floats, 40*72/175 and 40*2/175 have "equal" remainders
// that compare unequal, and the extra sat landed on the wrong recipient.
function largestRemainder(total, weights) {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const out = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, r: (total * w) % sum }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i] += 1;
  return out;
}

const weightOf = (r) => { const n = Math.trunc(Number(r.split)); return Number.isFinite(n) && n > 0 ? n : 0; };
const hasAddress = (r) => String(r.address ?? '').trim() !== '';

/**
 * Same rules as Sovereigncast's `_split_recipients` (the split Hopp and nutsplit use),
 * so a boost from nutboost and a payment through those apps divide the same way:
 *  - recipients without an address are not part of the split (their weight goes to the others);
 *  - fee recipients take their percentage of the total off the top (floor), the rest is shared
 *    by weight; splits are whole numbers (truncated);
 *  - a block of only fee recipients, or fee recipients claiming 100 % or more together
 *    (Hopp audit H-02), is shared by plain weight among those fee recipients.
 * Returns a Map recipient -> sats that adds up to exactly `total` whenever anyone has weight.
 */
function splitMap(total, recipients) {
  const rs = recipients.filter(hasAddress);
  const w = rs.map(weightOf);
  let isFee = rs.map((r) => r.fee === true || r.fee === 'true');
  const hasWeightedShare = w.some((x, i) => !isFee[i] && x > 0);
  const feePct = w.reduce((a, x, i) => (isFee[i] ? a + Math.min(x, 100) : a), 0);
  if (!hasWeightedShare || feePct >= 100) {
    if (hasWeightedShare) for (let i = 0; i < w.length; i++) if (!isFee[i]) w[i] = 0;
    isFee = rs.map(() => false);
  }
  const amt = rs.map((_, i) => (isFee[i] ? Math.floor((total * Math.min(w[i], 100)) / 100) : 0));
  const rest = Math.max(0, total - amt.reduce((a, b) => a + b, 0));
  const idx = rs.map((_, i) => i).filter((i) => !isFee[i] && w[i] > 0);
  const parts = largestRemainder(rest, idx.map((i) => w[i]));
  idx.forEach((i, k) => { amt[i] += parts[k]; });
  return new Map(rs.map((r, i) => [r, amt[i]]));
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
  const all = (recipients || []).filter((r) => weightOf(r) > 0);
  const considered = policy === 'redistribute' ? all.filter(isPayableByMint) : all;

  const sats = splitMap(totalSats, considered);

  const lines = all.map((r) => {
    const s = sats.get(r) ?? 0;
    if (!isPayableByMint(r)) {
      return { recipient: r, sats: policy === 'redistribute' ? 0 : s, payable: false,
        reason: r.type === 'node' ? 'keysend-only (a mint can only pay invoices)' : `unsupported recipient (${r.type || 'no type'})` };
    }
    if (s < minSats) return { recipient: r, sats: s, payable: false, reason: `below minimum (${minSats} sat)` };
    return { recipient: r, sats: s, payable: true };
  });
  const payTotal = lines.filter((l) => l.payable).reduce((a, l) => a + l.sats, 0);
  return { lines, payTotal, keptSats: totalSats - payTotal };
}
