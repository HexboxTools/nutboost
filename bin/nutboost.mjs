#!/usr/bin/env node
// nutboost CLI: plan or pay a Value4Value boost from a Cashu token.
//   nutboost plan --feed <url|file> [--episode <guid>] --sats 100
//   nutboost doctor --feed <url|file> [--live]   (creator check: can web/ecash listeners pay this feed?)
//   nutboost pay  --feed <url|file> ... --show   (one payment to the show's NUT-18 request; its server splits)
//   nutboost pay  --feed <url|file> [--episode <guid>] --sats 100 --token cashuB... [--message "hi"] [--name sam]
// `pay` receives the token at its mint, pays every Lightning-address split, and prints
// the leftover as a new token. Nothing is stored on disk: keep the printed token.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getTokenMetadata } from '@cashu/cashu-ts';
import { BoostWallet, parseFeed, planBoost, quoteBoost, executeBoost, diagnoseFeed } from '../src/index.js';

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    feed: { type: 'string' }, episode: { type: 'string' }, sats: { type: 'string' },
    token: { type: 'string' }, message: { type: 'string', default: '' }, name: { type: 'string', default: '' },
    redistribute: { type: 'boolean', default: false }, show: { type: 'boolean', default: false }, live: { type: 'boolean', default: false }, yes: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  },
});
const cmd = positionals[0];
if (cmd === 'doctor' && a.feed) {
  const src = /^https?:\/\//.test(a.feed) ? await (await fetch(a.feed)).text() : await readFile(a.feed, 'utf8');
  const d = await diagnoseFeed(parseFeed(src), { live: a.live });
  console.log(`${d.title}: ${d.verdict} (${Math.round(d.share * 100)}% of the split payable from Cashu / any invoice wallet)`);
  for (const r of d.rows) console.log(`  ${r.ok ? 'OK  ' : 'FIX '} ${String(r.split).padStart(4)}  ${r.name || ''} <${r.address}> ${r.ok ? r.route : r.reason}`);
  for (const f of d.fixes) console.log(`  -> ${f}`);
  process.exit(d.verdict === 'fully-payable' ? 0 : 2);
}
if (a.help || !['plan', 'pay'].includes(cmd) || !a.feed || !a.sats) {
  console.log('usage: nutboost doctor --feed <url|file> [--live]\n       nutboost plan|pay --feed <url|file> --sats <n> [--episode <guid>] [--token cashuB…] [--message txt] [--name txt] [--redistribute] [--show] [--yes]\n       --show pays the feed\'s own <podcast:txt purpose="cashu"> request in one payment; its server (e.g. nutsplit) splits it');
  process.exit(cmd ? 1 : 0);
}
const xml = /^https?:\/\//.test(a.feed) ? await (await fetch(a.feed)).text() : await readFile(a.feed, 'utf8');
const feed = parseFeed(xml);
const plan = planBoost({ feed, feedUrl: /^https?:/.test(a.feed) ? a.feed : undefined, itemGuid: a.episode, sats: parseInt(a.sats, 10), unpayable: a.redistribute ? 'redistribute' : 'skip', target: a.show ? 'show' : 'splits' });
console.log(`${feed.title} · ${plan.item ? plan.item.title : 'channel split'} (${plan.source} value block)`);
for (const l of plan.lines) console.log(`  ${String(l.sats).padStart(7)} sat  ${l.recipient.name} <${l.recipient.address}>${l.payable ? '' : '  SKIP: ' + l.reason}`);
console.log(`  ${String(plan.payTotal).padStart(7)} sat  to recipients${plan.keptSats ? `, ${plan.keptSats} kept` : ''}`);
if (cmd === 'plan') process.exit(0);

if (!a.token) { console.error('pay needs --token'); process.exit(1); }
const mint = getTokenMetadata(a.token).mint;
const bw = await new BoostWallet({ mintUrl: mint }).init();
console.log(`mint: ${mint}${bw.isTestMint() ? ' (test mint, nothing real moves)' : ''}`);
await bw.receiveToken(a.token);
console.log(`received ${bw.balance()} sat`);
let leftover = () => { const t = bw.encode(bw.proofs); if (t) console.log(`\nLEFTOVER TOKEN (${bw.balance()} sat). Keep it:\n${t}`); };
try {
  const q = await quoteBoost(plan, bw, { message: a.message, senderName: a.name, onProgress: (m) => console.log('  ' + m) });
  console.log(`max cost ${q.maxCost} sat (${q.amount} + ${q.feeReserve} fee reserve)`);
  if (!a.yes) { console.log('dry run: add --yes to pay'); leftover(); process.exit(0); }
  const res = await executeBoost(q, bw, { onProgress: (m) => console.log('  ' + m) });
  for (const r of res.results) console.log(`  ${r.status.padEnd(9)} ${r.sats} sat ${r.name}${r.reason ? ' (' + r.reason + ')' : ''}`);
  console.log(`paid ${res.paidSats} sat, fees ${res.feeSats} sat`);
} finally { leftover(); }
