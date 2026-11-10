// Plan, quote and pay a Value4Value boost across a podcast's split recipients.

import { effectiveValue, isPayableByMint, payRoute } from './feed.js';
import { inspectRequest, parseNostrAddress, fetchNutzapInfo, chooseRoute, buildNutzapEvent, podcastTags, deliverPayload, makeNostr, DEFAULT_RELAYS } from './ecash.js';
import { computeSplits } from './split.js';
import { resolveLnAddress, requestInvoice, rssPaymentComment, checkBounds } from './lnurl.js';

export const APP_NAME = 'nutboost';
export const APP_VERSION = '0.2.0';

/** Which recipients get how much. Pure; no network. */
export function planBoost({ feed, feedUrl, itemGuid, sats, unpayable = 'skip', target = 'splits' }) {
  const eff = effectiveValue(feed, itemGuid);
  const { item } = eff;
  let { value, source } = eff;
  if (target === 'show') {
    // pay the show's own NUT-18 request in one payment; its server splits (e.g. nutsplit)
    const creq = item?.ecashRequest || feed.ecashRequest;
    if (!creq) throw new Error('This feed has no <podcast:txt purpose="cashu"> payment request');
    value = { type: 'lightning', recipients: [{ name: feed.title ? `${feed.title} (show ecash request)` : 'Show ecash request', type: 'cashu', address: creq, split: 1, fee: false }] };
    source = 'show-request';
  }
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
export async function quoteBoost(plan, bw, opts = {}) {
  const { message = '', senderName = '', fetch: f = globalThis.fetch, onProgress } = opts;
  const url = plan.item?.link || plan.feed.link || plan.feedUrl;
  const comment = rssPaymentComment({ action: 'boost', url, message, senderName });
  const quotes = [];
  const nostr = opts.nostr || makeNostr();
  for (const line of plan.lines) {
    if (!line.payable) { quotes.push({ line, skipped: true, reason: line.reason }); continue; }
    const route = payRoute(line.recipient);
    try {
      if (route === 'lightning') {
        onProgress?.(`Resolving ${line.recipient.address}…`);
        const pay = await resolveLnAddress(line.recipient.address, { fetch: f });
        const bound = checkBounds(pay, line.sats);
        if (bound) { quotes.push({ line, skipped: true, reason: bound }); continue; }
        const inv = await requestInvoice(pay, line.sats, comment, { fetch: f });
        onProgress?.(`Quoting ${line.sats} sat to ${line.recipient.name} at the mint…`);
        const mq = await bw.meltQuote(inv.pr);
        const amount = mq.amount.toNumber();
        if (amount !== line.sats) throw new Error(`mint quote is for ${amount} sat, expected ${line.sats}`);
        quotes.push({ line, route, pr: inv.pr, comment: inv.comment, meltQuote: mq, feeReserve: mq.fee_reserve.toNumber(),
          boostagram: boostagram(plan, line, { message, senderName }) });
      } else if (route === 'nut18') {
        const insp = inspectRequest(line.recipient.address, line.sats, bw.mintUrl);
        const q = { line, route, insp, boostagram: boostagram(plan, line, { message, senderName }), memo: comment };
        if (insp.route.mode === 'crossmint') {
          onProgress?.(`${line.recipient.name} takes ecash from ${insp.route.targetMint} only: quoting a cross-mint…`);
          q.cross = await bw.crossMintQuote(insp.route.targetMint, line.sats);
          q.feeReserve = q.cross.feeReserve;
          q.via = `ecash via ${insp.route.targetMint} (cross-mint)`;
        } else { q.feeReserve = bw.inputFeeEstimate(line.sats); q.via = `ecash (NUT-18 ${insp.transport})`; }
        quotes.push(q);
      } else if (route === 'nutzap') {
        const { pubkey, relays } = parseNostrAddress(line.recipient.address);
        onProgress?.(`Looking up ${line.recipient.name}'s nutzap info (kind:10019)…`);
        const info = await fetchNutzapInfo(pubkey, { relays: [...new Set([...relays, ...(opts.relays || DEFAULT_RELAYS)])], nostr });
        const r = chooseRoute(bw.mintUrl, info.mints, { strict: true });
        const q = { line, route, info, boostagram: boostagram(plan, line, { message, senderName }), content: message ? `${senderName ? senderName + ': ' : ''}${message}` : '' };
        if (r.mode === 'crossmint') {
          onProgress?.(`${line.recipient.name} accepts nutzaps at ${r.targetMint}: quoting a cross-mint…`);
          q.cross = await bw.crossMintQuote(r.targetMint, line.sats);
          q.feeReserve = q.cross.feeReserve;
          q.via = `nutzap via ${r.targetMint} (cross-mint)`;
        } else { q.feeReserve = bw.inputFeeEstimate(line.sats); q.via = 'nutzap (NIP-61)'; }
        quotes.push(q);
      } else {
        quotes.push({ line, skipped: true, reason: 'unsupported recipient' });
      }
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
export async function executeBoost(quoted, bw, opts = {}) {
  const { onProgress } = opts;
  const results = [];
  for (const q of quoted.quotes) {
    if (q.skipped) { results.push({ name: q.line.recipient.name, address: q.line.recipient.address, sats: q.line.sats, status: 'skipped', reason: q.reason }); continue; }
    onProgress?.(`Paying ${q.line.sats} sat to ${q.line.recipient.name}…`);
    let r;
    try {
      if (q.route === 'nut18') r = await payNut18(q, bw, opts, quoted.plan);
      else if (q.route === 'nutzap') r = await payNutzap(q, bw, opts, quoted.plan);
      else r = await bw.payInvoice(q.pr, { meltQuote: q.meltQuote, expectSats: q.line.sats, label: `${q.line.recipient.name} <${q.line.recipient.address}>` });
    } catch (e) {
      r = { ok: false, state: 'ERROR', error: e?.message || String(e) };
    }
    results.push({ name: q.line.recipient.name, address: q.line.recipient.address, sats: q.line.sats,
      route: q.route || 'lightning', via: q.via, eventId: r.eventId,
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

const short = (r) => `${r.name} <${r.address.slice(0, 24)}${r.address.length > 24 ? '…' : ''}>`;

/** Pay one share to a NUT-18 payment request (HTTP POST or NIP-17 transport). */
async function payNut18(q, bw, opts, plan) {
  const { insp } = q;
  const label = short(q.line.recipient);
  let j; let mintUrl; let proofs;
  if (q.cross) {
    const c = await bw.crossMint(q.cross, { label });
    if (!c.ok) return { ok: false, state: c.state || 'ERROR', error: c.error, refundedSats: c.refundedSats };
    j = bw.journalForeign(c.proofs, { mintUrl: c.mintUrl, sats: q.line.sats, cost: c.cost, label, kind: 'nut18', locked: false });
    mintUrl = c.mintUrl; proofs = c.proofs;
  } else {
    j = await bw.takeForSend(q.line.sats, { request: insp.pr, amountless: insp.amountless, label, kind: 'nut18' });
    mintUrl = bw.mintUrl; proofs = j.proofs;
  }
  const body = insp.pr.encodePayload(mintUrl, proofs, { memo: q.memo });
  const d = await deliverPayload(insp, body, { fetch: opts.fetch || globalThis.fetch, nostr: opts.nostr || makeNostr(), senderSk: bw.nostrSk() });
  if (d.ok) { bw.confirmEcash(j, `delivered via ${insp.transport}`); return { ok: true, state: 'PAID', feeSats: Math.max(0, j.cost - q.line.sats) }; }
  if (d.rejected && !j.locked) {
    const back = await bw.reclaimEcash(j);
    return { ok: false, state: back ? 'REFUNDED' : 'STRANDED', error: d.error, refundedSats: back };
  }
  return { ok: false, state: 'PENDING', error: `${d.error}; proofs kept journaled until the mint shows them spent or they can be reclaimed` };
}

/** Pay one share as a NIP-61 nutzap: P2PK-lock to the recipient (30-day refund to us), publish kind:9321. */
async function payNutzap(q, bw, opts, plan) {
  const label = short(q.line.recipient);
  const locktime = Math.floor(Date.now() / 1000) + 30 * 86400;
  const lock = { pubkey: q.info.p2pk, locktime, refundKeys: [bw.refundPubkey()] };
  let j; let mintUrl;
  if (q.cross) {
    const c = await bw.crossMint(q.cross, { lock, label });
    if (!c.ok) return { ok: false, state: c.state || 'ERROR', error: c.error, refundedSats: c.refundedSats };
    j = bw.journalForeign(c.proofs, { mintUrl: c.mintUrl, sats: q.line.sats, cost: c.cost, label, kind: 'nutzap', locked: true, locktime });
    mintUrl = c.mintUrl;
  } else {
    j = await bw.takeForSend(q.line.sats, { lock, label, kind: 'nutzap' });
    mintUrl = bw.mintUrl;
  }
  const ev = buildNutzapEvent({
    proofs: j.proofs, mintUrl, recipientPubkey: q.info.pubkey, content: q.content, senderSk: bw.nostrSk(),
    extraTags: podcastTags({ podcastGuid: plan.feed.guid, itemGuid: plan.item?.guid, episodeTitle: plan.item?.title }),
  });
  j.meta = { event: ev, relays: q.info.relays.length ? q.info.relays : DEFAULT_RELAYS };
  bw.save();
  const nostr = opts.nostr || makeNostr();
  const acks = await nostr.publish(j.meta.relays, ev);
  if (acks.some((a) => a.ok)) { bw.confirmEcash(j, `nutzap ${ev.id}`); return { ok: true, state: 'PAID', eventId: ev.id, feeSats: Math.max(0, j.cost - q.line.sats) }; }
  return { ok: false, state: 'PENDING', eventId: ev.id, error: 'no relay accepted the nutzap; it stays journaled and will be republished (or refunded after 30 days)' };
}

/** Republish nutzaps that no relay accepted yet. */
export async function retryNutzaps(bw, { nostr = makeNostr() } = {}) {
  const out = [];
  for (const j of [...bw.pendingEcash].filter((x) => x.kind === 'nutzap' && x.meta?.event)) {
    const acks = await nostr.publish(j.meta.relays, j.meta.event);
    if (acks.some((a) => a.ok)) { bw.confirmEcash(j, `nutzap ${j.meta.event.id} (republished)`); out.push({ id: j.meta.event.id, ok: true }); }
    else out.push({ id: j.meta.event.id, ok: false });
  }
  return out;
}

export { isPayableByMint };
