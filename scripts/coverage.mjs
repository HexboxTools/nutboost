// Coverage survey: run the feed doctor over a list of feed URLs (one per line on stdin).
//   node scripts/coverage.mjs < feeds.txt     (prints a summary; writes coverage.json)
// Read-only: plain GETs of each feed with an identifying User-Agent, no LNURL calls.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseFeed, diagnoseFeed } from '../src/index.js';
const urls = [...new Set(readFileSync(0, 'utf8').trim().split('\n').filter(Boolean))];
const UA = 'nutboost-coverage/0.2 (+https://github.com/HexboxTools/nutboost)';
const out = []; let i = 0;
async function one(u) {
  try {
    const r = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { u, err: `HTTP ${r.status}` };
    const d = await diagnoseFeed(parseFeed((await r.text()).slice(0, 8e6)));
    return { u, verdict: d.verdict, share: d.share, problems: d.rows.filter((x) => !x.ok).map((x) => x.problem), keysendNodes: d.rows.filter((x) => x.problem === 'keysend').map((x) => x.address.slice(0, 12)) };
  } catch (e) { return { u, err: String(e.message || e).slice(0, 80) }; }
}
await Promise.all(Array.from({ length: 10 }, async () => { while (i < urls.length) out.push(await one(urls[i++])); }));
writeFileSync('coverage.json', JSON.stringify(out, null, 1));
const ok = out.filter((o) => !o.err), count = (k) => ok.filter((o) => o.verdict === k).length;
const nodes = {}; ok.forEach((o) => o.keysendNodes.forEach((n) => { nodes[n] = (nodes[n] || 0) + 1; }));
const broken = ok.filter((o) => o.problems.includes('broken')).length;
console.log(JSON.stringify({ feeds: urls.length, fetched: ok.length, fully: count('fully-payable'), partly: count('partly-payable'), notPayable: count('not-payable'), noValueBlock: count('no-value-block'), withBrokenRecipient: broken, topKeysendNodes: Object.entries(nodes).sort((a, b) => b[1] - a[1]).slice(0, 5) }, null, 1));
