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
import { generateSecretKey, getPublicKey, bytesToHex, hexToBytes } from './ecash.js';

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
    this.pendingEcash = []; // ecash handed to a recipient, delivery not yet confirmed
    this.pendingCross = []; // paid mint quotes at a recipient's mint, not yet minted
    this.stranded = [];     // foreign-mint tokens we could not deliver (exportable)
    this.nostrSkHex = null; // the wallet's own Nostr key: signs nutzaps, refund key for locks
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
      this.pendingEcash = [];
      for (const j of s.pendingEcash || []) {
        let proofs = [];
        try {
          const w = j.mintUrl === this.mintUrl ? this.wallet : await this.#foreignWallet(j.mintUrl);
          proofs = j.token ? w.decodeToken(j.token).proofs : [];
        } catch { /* mint unreachable: keep the token so nothing is lost */ }
        const { token, ...rest } = j;
        this.pendingEcash.push({ ...rest, proofs, token: proofs.length ? undefined : token });
      }
      this.pendingCross = s.pendingCross || [];
      this.stranded = s.stranded || [];
      this.nostrSkHex = s.nostrSkHex || null;
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
      pendingEcash: this.pendingEcash.map(({ proofs, token, ...rest }) => ({ ...rest, token: proofs.length ? getEncodedToken({ mint: rest.mintUrl, proofs, unit: this.unit }) : (token || '') })),
      pendingCross: this.pendingCross,
      stranded: this.stranded,
      nostrSkHex: this.nostrSkHex,
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


  // ---- ecash-direct ---------------------------------------------------------

  /** The wallet's Nostr secret key (created on first use, stored with the wallet). */
  nostrSk() {
    if (!this.nostrSkHex) { this.nostrSkHex = bytesToHex(generateSecretKey()); this.save(); }
    return hexToBytes(this.nostrSkHex);
  }
  nostrPubkey() { return getPublicKey(this.nostrSk()); }
  /** Compressed secp256k1 pubkey used as the NUT-11 refund key on nutzaps we send. */
  refundPubkey() { return '02' + this.nostrPubkey(); }

  inputFeeEstimate(sats) {
    try { return num(this.wallet.getFeesToInclude(sats)); } catch { return 0; }
  }

  /**
   * Take `sats` out of the wallet as fresh proofs for a recipient, journaled until delivery is
   * settled. `request`: a NUT-18 PaymentRequest (enforces its mint/lock rules). `lock`: NUT-11 P2PK options.
   */
  async takeForSend(sats, { request, amountless = true, lock, label, kind = 'ecash', meta } = {}) {
    let res;
    if (request) res = await this.wallet.ops.sendToRequest(request, this.proofs, amountless ? sats : undefined).run();
    else if (lock) res = await this.wallet.ops.send(sats, this.proofs).asP2PK(lock).includeFees(true).run();
    else res = await this.wallet.ops.send(sats, this.proofs).includeFees(true).run();
    const { keep, send } = res;
    const cost = this.balance() - sumProofs(keep);
    this.proofs = keep;
    const j = { id: Math.random().toString(36).slice(2), kind, label, sats, cost, mintUrl: this.mintUrl, created: Date.now(),
      locked: !!(lock || request?.nut10), locktime: lock?.locktime, meta, proofs: send };
    this.pendingEcash.push(j);
    this.save();
    return j;
  }

  /** Journal proofs that live at another mint (after a cross-mint). */
  journalForeign(proofs, { mintUrl, sats, cost, label, kind, locked, locktime, meta }) {
    const j = { id: Math.random().toString(36).slice(2), kind, label, sats, cost, mintUrl, created: Date.now(), locked, locktime, meta, proofs };
    this.pendingEcash.push(j);
    this.save();
    return j;
  }

  /** Delivery confirmed. */
  confirmEcash(j, note) {
    this.pendingEcash = this.pendingEcash.filter((x) => x.id !== j.id);
    this.log({ kind: j.kind, label: j.label, sats: j.sats, cost: j.cost, note });
    this.save();
  }

  /** The payee refused (or we gave up): take unlocked proofs back. Returns sats recovered. */
  async reclaimEcash(j) {
    if (j.locked) {
      // locked to the recipient: only reclaimable via the refund path after locktime
      if (!j.locktime || j.locktime * 1000 > Date.now()) return 0;
    }
    const w = j.mintUrl === this.mintUrl ? this.wallet : await this.#foreignWallet(j.mintUrl);
    if (j.mintUrl !== this.mintUrl) {
      // proofs are at another mint: keep them as an exportable token rather than paying fees to move them back
      const token = getEncodedToken({ mint: j.mintUrl, proofs: j.proofs, unit: this.unit });
      this.stranded.push({ mintUrl: j.mintUrl, sats: sumProofs(j.proofs), token, label: j.label, created: Date.now() });
      this.pendingEcash = this.pendingEcash.filter((x) => x.id !== j.id);
      this.save();
      return 0;
    }
    const fresh = await w.receive(j.proofs, j.locked ? { privkey: this.nostrSkHex } : undefined);
    this.proofs.push(...fresh);
    this.pendingEcash = this.pendingEcash.filter((x) => x.id !== j.id);
    this.log({ kind: 'refund', label: j.label, sats: sumProofs(fresh) });
    this.save();
    return sumProofs(fresh);
  }

  async #foreignWallet(mintUrl) {
    this.foreign ??= new Map();
    if (!this.foreign.has(mintUrl)) {
      const w = new Wallet(mintUrl, { unit: this.unit });
      await w.loadMint();
      this.foreign.set(mintUrl, w);
    }
    return this.foreign.get(mintUrl);
  }

  /** Mint quote at another mint, for a cross-mint. Nothing paid yet. */
  async crossMintQuote(targetMint, sats) {
    const target = await this.#foreignWallet(targetMint);
    // mint enough that the recipient nets `sats` after the target mint's input fee
    let extra = 0;
    try { extra = num(target.getFeesToInclude(sats)); } catch {}
    const mintSats = sats + extra;
    const mq = await target.createMintQuoteBolt11(mintSats);
    const melt = await this.meltQuote(mq.request);
    return { targetMint, sats, mintSats, mintQuote: mq, meltQuote: melt, feeReserve: num(melt.fee_reserve) + extra };
  }

  /**
   * Move `sats` to `targetMint` over Lightning: pay its mint quote from this wallet, then mint
   * there (optionally P2PK-locked). Paid-but-unminted quotes are journaled in `pendingCross`.
   */
  async crossMint(cq, { lock, label } = {}) {
    const target = await this.#foreignWallet(cq.targetMint);
    const pay = await this.payInvoice(cq.mintQuote.request, { meltQuote: cq.meltQuote, expectSats: cq.mintSats ?? cq.sats, label: `cross-mint to ${cq.targetMint} for ${label}` });
    if (!pay.ok) return { ok: false, error: pay.error, state: pay.state, refundedSats: pay.refundedSats };
    const pc = { targetMint: cq.targetMint, quote: cq.mintQuote.quote, sats: cq.mintSats ?? cq.sats, lock, label, created: Date.now() };
    this.pendingCross.push(pc);
    this.save();
    const proofs = await this.#mintForeign(target, pc);
    if (!proofs) return { ok: false, state: 'PENDING', error: `paid ${cq.targetMint} but its quote is not mintable yet; will retry`, feeSats: pay.feeSats };
    return { ok: true, proofs, mintUrl: cq.targetMint, feeSats: pay.feeSats, cost: (cq.mintSats ?? cq.sats) + (pay.feeSats || 0) };
  }

  async #mintForeign(target, pc, waitMs = 60000) {
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      let q;
      try { q = await target.checkMintQuoteBolt11(pc.quote); } catch { q = null; }
      if (q?.state === MintQuoteState.PAID) {
        const out = pc.lock ? { type: 'p2pk', options: pc.lock } : undefined;
        const proofs = await target.mintProofsBolt11(pc.sats, pc.quote, undefined, out);
        this.pendingCross = this.pendingCross.filter((x) => x.quote !== pc.quote);
        this.save();
        return proofs;
      }
      if (q?.state === MintQuoteState.ISSUED) { this.pendingCross = this.pendingCross.filter((x) => x.quote !== pc.quote); this.save(); return null; }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
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
    // cross-mints that were paid but not minted: mint them as stranded tokens for export
    for (const pc of [...this.pendingCross]) {
      try {
        const target = await this.#foreignWallet(pc.targetMint);
        const proofs = await this.#mintForeign(target, pc, 1);
        if (proofs) {
          this.stranded.push({ mintUrl: pc.targetMint, sats: sumProofs(proofs), token: getEncodedToken({ mint: pc.targetMint, proofs, unit: this.unit }), label: pc.label, locked: !!pc.lock, created: Date.now() });
          out.push({ quote: pc.quote, state: 'MINTED_STRANDED' });
        }
      } catch {}
    }
    // ecash handed out but never confirmed: spent -> delivered; unlocked & unspent for 15 min -> reclaim
    for (const j of [...this.pendingEcash]) {
      try {
        const w = j.mintUrl === this.mintUrl ? this.wallet : await this.#foreignWallet(j.mintUrl);
        const st = await w.checkProofsStates(j.proofs);
        if (st.every((x) => x.state === 'SPENT')) { this.confirmEcash(j, 'redeemed by recipient'); out.push({ id: j.id, state: 'DELIVERED' }); continue; }
        if (Date.now() - j.created > 15 * 60_000 && st.every((x) => x.state === 'UNSPENT')) {
          const got = await this.reclaimEcash(j);
          if (got || !this.pendingEcash.includes(j)) out.push({ id: j.id, state: 'RECLAIMED' });
        }
      } catch {}
    }
    this.save();
    return out;
  }
}
