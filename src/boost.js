// Plan, quote and pay a Value4Value boost across a podcast's split recipients.

import { effectiveValue, isPayableByMint } from './feed.js';
import { computeSplits } from './split.js';
import { resolveLnAddress, requestInvoice, rssPaymentComment, checkBounds } from './lnurl.js';

export const APP_NAME = 'nutboost';
export const APP_VERSION = '0.1.0';

/** Which recipients get how much. Pure; no network. */
export function planBoost({ feed, feedUrl, itemGuid, sats, unpayable = 'skip' }) {
  const { value, item, source } = effectiveValue(feed, itemGuid);
  if (!value || !value.recipients?.length) throw new Error('This feed has no Lightning <podcast:value> block');
  const split = computeSplits(sats, value.recipients, { unpayable });
  return { feed, feedUrl, item, source, sats, unpayable, ...split };
}

/**
 * Boostagram metadata in the shape of the TLV record 7629169 (bLIP-10), one per recipient.
 * Lightning-address payments can't carry TLVs, so this travels as a short
 * `rss::payment::boost` comment and is kept in full in the local receipt.
 */
export function boostagram(plan, line, { message = '', senderName = '' } = {}) {
  return {
    action: 'boost',
    app_name: APP_NAME,
    app_version: APP_VERSION,
    podcast: plan.feed.title,
    guid: plan.feed.guid,
    url: plan.feedUrl,
    episode: plan.item?.title,
    episode_guid: plan.item?.guid,
    name: line.recipient.name,
    value_msat: line.sats * 1000,
    value_msat_total: plan.payTotal * 1000,
    sender_name: senderName || undefined,
    message: message || undefined,
    ts: undefined,
  };
}

/**
 * For every payable line: resolve the Lightning address, request an invoice for
 * exactly its share (with the rss::payment comment) and get a melt quote.
 * Nothing is paid here. Per-line failures are reported, not thrown.
 */
export async function quoteBoost(plan, bw, { message = '', senderName = '', fetch: f = globalThis.fetch, onProgress } = {}) {
  const url = plan.item?.link || plan.feed.link || plan.feedUrl;
  const comment = rssPaymentComment({ action: 'boost', url, message, senderName });
  const quotes = [];
  for (const line of plan.lines) {
    if (!line.payable) { quotes.push({ line, skipped: true, reason: line.reason }); continue; }
    try {
      onProgress?.(`Resolving ${line.recipient.address}…`);
      const pay = await resolveLnAddress(line.recipient.address, { fetch: f });
      const bound = checkBounds(pay, line.sats);
      if (bound) { quotes.push({ line, skipped: true, reason: bound }); continue; }
      const inv = await requestInvoice(pay, line.sats, comment, { fetch: f });
      onProgress?.(`Quoting ${line.sats} sat to ${line.recipient.name} at the mint…`);
      const mq = await bw.meltQuote(inv.pr);
      const amount = mq.amount.toNumber();
      if (amount !== line.sats) throw new Error(`mint quote is for ${amount} sat, expected ${line.sats}`);
      quotes.push({ line, pr: inv.pr, comment: inv.comment, meltQuote: mq, feeReserve: mq.fee_reserve.toNumber(),
        boostagram: boostagram(plan, line, { message, senderName }) });
    } catch (e) {
      quotes.push({ line, skipped: true, reason: e?.message || String(e) });
    }
  }
  const payable = quotes.filter((q) => !q.skipped);
  const amount = payable.reduce((a, q) => a + q.line.sats, 0);
  const feeReserve = payable.reduce((a, q) => a + q.feeReserve, 0);
  return { plan, quotes, amount, feeReserve, maxCost: amount + feeReserve };
}

/**
 * Pay every quoted line, one melt per recipient. A failed line is refunded to the
 * wallet (see BoostWallet.payInvoice); the rest still go through.
 */
export async function executeBoost(quoted, bw, { onProgress } = {}) {
  const results = [];
  for (const q of quoted.quotes) {
    if (q.skipped) { results.push({ name: q.line.recipient.name, address: q.line.recipient.address, sats: q.line.sats, status: 'skipped', reason: q.reason }); continue; }
    onProgress?.(`Paying ${q.line.sats} sat to ${q.line.recipient.name}…`);
    let r;
    try {
      r = await bw.payInvoice(q.pr, { meltQuote: q.meltQuote, expectSats: q.line.sats, label: `${q.line.recipient.name} <${q.line.recipient.address}>` });
    } catch (e) {
      r = { ok: false, state: 'ERROR', error: e?.message || String(e) };
    }
    results.push({ name: q.line.recipient.name, address: q.line.recipient.address, sats: q.line.sats,
      status: r.ok ? 'paid' : (r.state === 'REFUNDED' ? 'refunded' : r.state.toLowerCase()), feeSats: r.feeSats,
      reason: r.error, boostagram: q.boostagram ? { ...q.boostagram, ts: Math.floor(Date.now() / 1000) } : undefined });
  }
  const paid = results.filter((r) => r.status === 'paid');
  return {
    results,
    paidSats: paid.reduce((a, r) => a + r.sats, 0),
    feeSats: paid.reduce((a, r) => a + (r.feeSats || 0), 0),
    balance: bw.balance(),
  };
}

export { isPayableByMint };
