import { describe, it, expect } from 'vitest';
import { Amount } from '@cashu/cashu-ts';
import { readFileSync } from 'node:fs';
import { BoostWallet } from '../src/boostwallet.js';
import { parseFeed, planBoost, quoteBoost, executeBoost } from '../src/index.js';

const proof = (amount, i) => ({ id: '00', amount: Amount.from(amount), secret: 's' + i + Math.random(), C: '02' });

/** BoostWallet with the cashu-ts Wallet swapped for a scripted fake. */
function fakeWallet({ meltFails = false, proofState = 'UNSPENT', feeReserve = 1 } = {}) {
  const bw = new BoostWallet({ mintUrl: 'https://mint.test' });
  bw.encode = () => '';
  bw.proofs = [proof(64, 1), proof(32, 2), proof(4, 3)];
  const calls = { melts: [] };
  bw.wallet = {
    createMeltQuoteBolt11: async (pr) => {
      const sats = Number(pr.match(/^lnbc(\d+)n/)[1]) / 10;
      return { quote: 'q-' + pr, amount: Amount.from(sats), fee_reserve: Amount.from(feeReserve), expiry: Date.now() / 1000 + 600 };
    },
    send: async (amt, proofs) => {
      // naive: send everything, keep a change proof of the difference
      const total = proofs.reduce((a, p) => a + p.amount.toNumber(), 0);
      const need = amt.toNumber();
      return { send: [proof(need, 's')], keep: total > need ? [proof(total - need, 'k')] : [] };
    },
    meltProofsBolt11: async (mq, send) => {
      calls.melts.push(mq.quote);
      if (meltFails === true || (typeof meltFails === 'function' && meltFails(mq))) throw new Error('route not found');
      return { quote: { state: 'PAID' }, change: [proof(feeReserve, 'c')] };
    },
    checkProofsStates: async (ps) => ps.map(() => ({ state: proofState })),
  };
  return { bw, calls };
}

const feed = parseFeed(readFileSync(new URL('../docs/demo-feed.xml', import.meta.url), 'utf8'));
const lnFetch = async (url) => {
  if (url.includes('/.well-known/lnurlp/')) return { ok: true, json: async () => ({ tag: 'payRequest', callback: 'https://cb.test/pay', minSendable: 1000, maxSendable: 1e9, commentAllowed: 200 }) };
  const amt = Number(new URL(url).searchParams.get('amount')) / 1000;
  return { ok: true, json: async () => ({ pr: `lnbc${amt * 10}n1pfake${Math.random().toString(36).slice(2)}` }) };
};

describe('BoostWallet.payInvoice', () => {
  it('pays and keeps the change', async () => {
    const { bw } = fakeWallet();
    const r = await bw.payInvoice('lnbc210n1pabc');
    expect(r).toMatchObject({ ok: true, paidSats: 21 });
    expect(bw.balance()).toBe(100 - 22 + 1);
    expect(bw.pendingMelts).toHaveLength(0);
  });
  it('refunds proofs the mint did not spend when the melt fails', async () => {
    const { bw } = fakeWallet({ meltFails: true, proofState: 'UNSPENT' });
    const r = await bw.payInvoice('lnbc210n1pabc');
    expect(r.state).toBe('REFUNDED');
    expect(r.refundedSats).toBe(22);
    expect(bw.balance()).toBe(100);
    expect(bw.pendingMelts).toHaveLength(0);
  });
  it('keeps proofs journaled when the mint says they are pending', async () => {
    const { bw } = fakeWallet({ meltFails: true, proofState: 'PENDING' });
    const r = await bw.payInvoice('lnbc210n1pabc');
    expect(r.state).toBe('PENDING');
    expect(bw.balance()).toBe(78);
    expect(bw.pendingBalance()).toBe(22);
  });
  it('refuses when balance cannot cover amount + fee reserve', async () => {
    const { bw, calls } = fakeWallet();
    const r = await bw.payInvoice('lnbc1000n1pabc');
    expect(r.state).toBe('REFUSED');
    expect(calls.melts).toHaveLength(0);
    expect(bw.balance()).toBe(100);
  });
  it('refuses a quote for an unexpected amount', async () => {
    const { bw } = fakeWallet();
    const r = await bw.payInvoice('lnbc210n1pabc', { expectSats: 20 });
    expect(r.state).toBe('REFUSED');
  });
});

describe('boost flow', () => {
  it('quotes and pays each payable split, skipping keysend', async () => {
    const { bw, calls } = fakeWallet();
    const plan = planBoost({ feed, feedUrl: 'https://x/feed.xml', itemGuid: 'nutboost-demo-ep1', sats: 50 });
    const q = await quoteBoost(plan, bw, { message: 'hi', fetch: lnFetch });
    expect(q.amount).toBe(45);
    expect(q.feeReserve).toBe(2);
    const res = await executeBoost(q, bw);
    expect(res.results.map((r) => r.status)).toEqual(['paid', 'paid', 'skipped']);
    expect(res.paidSats).toBe(45);
    expect(calls.melts).toHaveLength(2);
    expect(res.results[0].boostagram).toMatchObject({ action: 'boost', podcast: 'Nutboost Demo Cast', episode_guid: 'nutboost-demo-ep1', value_msat: 25000, value_msat_total: 45000, message: 'hi', app_name: 'nutboost' });
  });
  it('a failed split is refunded and the others still go through', async () => {
    let n = 0;
    const { bw } = fakeWallet({ meltFails: () => ++n === 1 });
    const plan = planBoost({ feed, feedUrl: 'https://x/feed.xml', itemGuid: 'nutboost-demo-ep1', sats: 50 });
    const res = await executeBoost(await quoteBoost(plan, bw, { fetch: lnFetch }), bw);
    expect(res.results.map((r) => r.status)).toEqual(['refunded', 'paid', 'skipped']);
    expect(res.paidSats).toBe(20);
    expect(bw.balance()).toBe(100 - 21 + 1);
  });
  it('reports a recipient whose LNURL fails without paying anyone extra', async () => {
    const { bw } = fakeWallet();
    const plan = planBoost({ feed, feedUrl: 'https://x/feed.xml', sats: 100 });
    const badFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const q = await quoteBoost(plan, bw, { fetch: badFetch });
    expect(q.quotes.every((x) => x.skipped)).toBe(true);
    expect(q.maxCost).toBe(0);
  });
});
