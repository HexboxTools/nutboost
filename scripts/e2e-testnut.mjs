// End-to-end run against the public FakeWallet test mint (no real sats move):
// fund the wallet, boost the demo feed's episode split, print every step.
import { readFile } from 'node:fs/promises';
import { BoostWallet, parseFeed, planBoost, quoteBoost, executeBoost } from '../src/index.js';

const MINT = process.env.MINT || 'https://testnut.cashu.space';
const bw = await new BoostWallet({ mintUrl: MINT }).init();
if (!bw.isTestMint()) throw new Error('refusing: e2e only runs against a test mint');

const top = await bw.createTopUp(200);
console.log('top-up quote', top.quote);
for (let i = 0; i < 40 && bw.balance() === 0; i++) { await bw.collectTopUps(); if (!bw.balance()) await new Promise((r) => setTimeout(r, 1000)); }
console.log('balance after top-up:', bw.balance());

const feed = parseFeed(await readFile(new URL('../docs/demo-feed.xml', import.meta.url), 'utf8'));
const plan = planBoost({ feed, feedUrl: 'https://hexboxtools.github.io/nutboost/demo-feed.xml', itemGuid: 'nutboost-demo-ep1', sats: 50 });
console.log('plan:', plan.lines.map((l) => `${l.recipient.name}=${l.sats}${l.payable ? '' : ' (skip: ' + l.reason + ')'}`).join(', '));
const quoted = await quoteBoost(plan, bw, { message: 'e2e test from nutboost', senderName: 'nutboost-e2e', onProgress: console.log });
console.log('quoted amount', quoted.amount, 'fee reserve', quoted.feeReserve);
const res = await executeBoost(quoted, bw, { onProgress: console.log });
console.log(JSON.stringify(res, null, 2));
// failure path: an invoice the mint can't quote -> nothing taken
const bad = await bw.payInvoice('lnbc1invalid').catch((e) => ({ ok: false, error: e.message }));
console.log('bad invoice ->', bad.ok, bad.error?.slice(0, 80), 'balance', bw.balance());
console.log('final balance', bw.balance(), 'pending', bw.pendingBalance());
