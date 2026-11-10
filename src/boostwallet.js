// A small, journaled Cashu wallet for one mint, built on cashu-ts.
// State is a JSON blob saved through a storage adapter (localStorage in the
// browser, a file in the CLI, memory in tests). Proofs are stored as an encoded
// cashuB token, so a backup is just "copy this token".
//
// Safety rules:
//  - Proofs handed to a melt are journaled as `pendingMelts` (and removed from the
//    spendable balance) BEFORE the mint is asked to pay.
//  - If a melt errors, we ask the mint (NUT-07) whether those proofs were spent.
//    Unspent -> back into the wallet (a "refund"). Pending -> left journaled until
//    reconcile() can settle it from the melt quote state. Spent -> treated as paid.
//  - Paid top-up quotes are journaled as `pendingMints` so a page reload can still
//    collect them.

import { Wallet, getEncodedToken, MintQuoteState } from '@cashu/cashu-ts';

const num = (a) => (typeof a === 'number' ? a : typeof a === 'bigint' ? Number(a) : a?.toNumber ? a.toNumber() : Number(a));
export const sumProofs = (proofs) => proofs.reduce((acc, p) => acc + num(p.amount), 0);

export const memoryStorage = () => {
  let v = null;
  return { load: () => v, save: (s) => { v = s; } };
};

export class BoostWallet {
  /** @param {{mintUrl:string, storage?:{load():string|null, save(s:string):void}, unit?:string}} opts */
  constructor({ mintUrl, storage = memoryStorage(), unit = 'sat' }) {
    this.mintUrl = mintUrl.replace(/\/+$/, '');
    this.storage = storage;
    this.unit = unit;
    this.wallet = new Wallet(this.mintUrl, { unit });
    this.proofs = [];
    this.pendingMints = [];
    this.pendingMelts = [];
    this.history = [];
  }

  async init() {
    await this.wallet.loadMint();
    const raw = this.storage.load();
    if (raw) {
      const s = JSON.parse(raw);
      if (s.mintUrl && s.mintUrl !== this.mintUrl) throw new Error(`Stored wallet belongs to ${s.mintUrl}`);
      this.proofs = s.token ? this.wallet.decodeToken(s.token).proofs : [];
      this.pendingMints = s.pendingMints || [];
      this.pendingMelts = (s.pendingMelts || []).map((m) => ({ ...m, proofs: m.token ? this.wallet.decodeToken(m.token).proofs : [] }));
      this.history = s.history || [];
    }
    return this;
  }

  info() { return this.wallet.getMintInfo(); }

  /** Heuristic: is this a test mint that never moves real sats? */
  isTestMint() {
    const i = this.info();
    const text = `${this.mintUrl} ${i?.name || ''} ${i?.description || ''} ${i?.description_long || ''}`.toLowerCase();
    return /testnut|fakewallet|fake wallet|no real funds|for testing/.test(text);
  }

  encode(proofs) {
    return proofs.length ? getEncodedToken({ mint: this.mintUrl, proofs, unit: this.unit }) : '';
  }

  save() {
    this.storage.save(JSON.stringify({
      v: 1,
      mintUrl: this.mintUrl,
      token: this.encode(this.proofs),
      pendingMints: this.pendingMints,
      pendingMelts: this.pendingMelts.map(({ proofs, ...rest }) => ({ ...rest, token: this.encode(proofs) })),
      history: this.history.slice(-200),
    }));
  }

  balance() { return sumProofs(this.proofs); }
  pendingBalance() { return this.pendingMelts.reduce((a, m) => a + sumProofs(m.proofs), 0); }

  log(entry) { this.history.push({ ts: Date.now(), ...entry }); }

  // ---- funding ------------------------------------------------------------

  async createTopUp(sats) {
    const q = await this.wallet.createMintQuoteBolt11(sats);
    const entry = { quote: q.quote, amount: sats, request: q.request, expiry: q.expiry, created: Date.now() };
    this.pendingMints.push(entry);
    this.save();
    return entry;
  }

  /** Mint every paid top-up quote. Returns sats minted. */
  async collectTopUps() {
    let minted = 0;
    for (const pm of [...this.pendingMints]) {
      let q;
      try { q = await this.wallet.checkMintQuoteBolt11(pm.quote); } catch { continue; }
      if (q.state === MintQuoteState.PAID) {
        const proofs = await this.wallet.mintProofsBolt11(pm.amount, pm.quote);
        this.proofs.push(...proofs);
        minted += sumProofs(proofs);
        this.pendingMints = this.pendingMints.filter((x) => x.quote !== pm.quote);
        this.log({ kind: 'topup', sats: sumProofs(proofs) });
        this.save();
      } else if (q.state === MintQuoteState.ISSUED || (pm.expiry && pm.expiry * 1000 < Date.now() - 3600_000)) {
        this.pendingMints = this.pendingMints.filter((x) => x.quote !== pm.quote);
        this.save();
      }
    }
    return minted;
  }

  async receiveToken(token) {
    const proofs = await this.wallet.receive(token.trim());
    this.proofs.push(...proofs);
    this.log({ kind: 'receive', sats: sumProofs(proofs) });
    this.save();
    return sumProofs(proofs);
  }

  /** Export the whole balance as one token and empty the wallet (the token is the money). */
  async exportAll() {
    const token = this.encode(this.proofs);
    const sats = this.balance();
    this.proofs = [];
    this.log({ kind: 'export', sats });
    this.save();
    return { token, sats };
  }

  // ---- paying ---------------------------------------------------------------

  async meltQuote(pr) { return this.wallet.createMeltQuoteBolt11(pr); }

  /**
   * Pay a BOLT11 invoice from the wallet.
   * @returns {{ok:boolean, state:string, paidSats?:number, feeSats?:number, error?:string, refundedSats?:number}}
   */
  async payInvoice(pr, { meltQuote, expectSats, label } = {}) {
    let mq = meltQuote;
    if (!mq || (mq.expiry && mq.expiry * 1000 < Date.now() + 5000)) mq = await this.meltQuote(pr);
    const amount = num(mq.amount);
    if (expectSats != null && amount !== expectSats) {
      return { ok: false, state: 'REFUSED', error: `mint quote is for ${amount} sat, expected ${expectSats}` };
    }
    const need = amount + num(mq.fee_reserve);
    if (this.balance() < need) return { ok: false, state: 'REFUSED', error: `needs ${need} sat (incl. fee reserve), wallet has ${this.balance()}` };

    const { keep, send } = await this.wallet.send(mq.amount.add(mq.fee_reserve), this.proofs, { includeFees: true });
    const sent = sumProofs(send);
    // journal first
    this.proofs = keep;
    const journal = { quote: mq.quote, label, amount, created: Date.now(), proofs: send };
    this.pendingMelts.push(journal);
    this.save();

    try {
      const res = await this.wallet.meltProofsBolt11(mq, send);
      const state = res.quote?.state || 'PAID';
      if (state !== 'PAID') {
        // PENDING (or async): proofs stay journaled; reconcile() settles them later
        this.save();
        return { ok: false, state, error: 'payment pending at the mint; will reconcile' };
      }
      const change = res.change || [];
      this.proofs.push(...change);
      this.pendingMelts = this.pendingMelts.filter((m) => m !== journal);
      const spent = sent - sumProofs(change);
      this.log({ kind: 'melt', label, sats: amount, cost: spent });
      this.save();
      return { ok: true, state, paidSats: amount, feeSats: spent - amount };
    } catch (e) {
      const outcome = await this.#settleFailedMelt(journal);
      return { ok: outcome === 'PAID', state: outcome, error: e?.message || String(e),
        refundedSats: outcome === 'REFUNDED' ? sent : 0 };
    }
  }

  /** After a melt error: ask the mint about the proofs, refund the unspent ones. */
  async #settleFailedMelt(journal) {
    let states;
    try { states = await this.wallet.checkProofsStates(journal.proofs); } catch { this.save(); return 'UNKNOWN'; }
    const spent = states.filter((s) => s.state === 'SPENT').length;
    const pending = states.filter((s) => s.state === 'PENDING').length;
    if (pending) { this.save(); return 'PENDING'; }
    this.pendingMelts = this.pendingMelts.filter((m) => m !== journal);
    if (!spent) {
      this.proofs.push(...journal.proofs);
      this.log({ kind: 'refund', label: journal.label, sats: sumProofs(journal.proofs) });
      this.save();
      return 'REFUNDED';
    }
    // some/all spent: return any unspent ones, treat as paid
    const unspent = journal.proofs.filter((_, i) => states[i].state === 'UNSPENT');
    this.proofs.push(...unspent);
    this.log({ kind: 'melt', label: journal.label, sats: journal.amount, note: 'settled after error' });
    this.save();
    return 'PAID';
  }

  /** Settle journaled melts (e.g. after a reload). */
  async reconcile() {
    const out = [];
    for (const j of [...this.pendingMelts]) {
      let q;
      try { q = await this.wallet.checkMeltQuoteBolt11(j.quote); } catch { continue; }
      if (q.state === 'PAID') {
        this.pendingMelts = this.pendingMelts.filter((m) => m !== j);
        this.log({ kind: 'melt', label: j.label, sats: j.amount, note: 'reconciled' });
        out.push({ quote: j.quote, state: 'PAID' });
      } else if (q.state === 'UNPAID') {
        out.push({ quote: j.quote, state: await this.#settleFailedMelt(j) });
      } else out.push({ quote: j.quote, state: q.state });
    }
    this.save();
    return out;
  }
}
