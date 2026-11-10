// Differential fuzz of nutboost's split math against the Sovereigncast split as ported in
// apeirs/nutsplit (MIT; Sovereigncast is the reference Hopp uses). Not vendored: pass the path
// to a checkout's src/split.ts. Node >= 23.6 runs the TypeScript directly.
//   git clone --depth 1 https://github.com/apeirs/nutsplit /tmp/nutsplit
//   node scripts/splitdiff.mjs /tmp/nutsplit/src/split.ts 100000
import { pathToFileURL } from 'node:url';
import { computeSplits } from '../src/split.js';
const [ref, nArg] = process.argv.slice(2);
if (!ref) { console.error('usage: node scripts/splitdiff.mjs <nutsplit/src/split.ts> [cases]'); process.exit(2); }
const { splitRecipients } = await import(pathToFileURL(ref).href);
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const N = Number(nArg) || 100000; let bad = 0;
for (let t = 0; t < N; t++) {
  const recips = Array.from({ length: ri(1, 6) }, (_, i) => {
    const fee = rnd() < 0.25;
    return { name: 'r' + i, type: 'lnaddress', address: rnd() < 0.05 ? '' : `r${i}@ex.com`,
      split: fee ? ri(0, rnd() < 0.15 ? 120 : 10) : ri(0, rnd() < 0.5 ? 100 : 5), fee };
  });
  const amt = ri(1, rnd() < 0.5 ? 50 : 5000);
  const ours = new Map(computeSplits(amt, recips, { minSats: 0 }).lines.map((l) => [l.recipient.name, l.sats]));
  const theirs = new Map(splitRecipients(recips, amt).map((s) => [s.recipient.name, s.amount]));
  if (recips.some((r) => (ours.get(r.name) ?? 0) !== (theirs.get(r.name) ?? 0))) {
    if (bad++ < 3) console.log(JSON.stringify({ amt, recips, ours: [...ours], theirs: [...theirs] }));
  }
}
console.log(`${N} random value blocks, ${bad} disagreements`);
process.exit(bad ? 1 : 0);
