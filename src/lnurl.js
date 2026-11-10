// LNURL-pay (LUD-06), Lightning Address (LUD-16), comments (LUD-12) and the
// Podcasting 2.0 `rss::payment` comment convention.

import { isLightningAddress } from './feed.js';

export function lnAddressToUrl(address) {
  if (!isLightningAddress(address)) throw new Error(`Not a Lightning address: ${address}`);
  const [user, domain] = address.trim().toLowerCase().split('@');
  const scheme = /\.onion$/.test(domain) ? 'http' : 'https';
  return `${scheme}://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`;
}

/** Fetch and validate the payRequest for a Lightning address. */
export async function resolveLnAddress(address, { fetch: f = globalThis.fetch } = {}) {
  const url = lnAddressToUrl(address);
  const res = await f(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${address}: LNURL endpoint returned HTTP ${res.status}`);
  const json = await res.json();
  if (json.status === 'ERROR') throw new Error(`${address}: ${json.reason || 'LNURL error'}`);
  if (json.tag !== 'payRequest' || typeof json.callback !== 'string') {
    throw new Error(`${address}: not an LNURL-pay endpoint`);
  }
  const minSendable = Number(json.minSendable);
  const maxSendable = Number(json.maxSendable);
  if (!Number.isFinite(minSendable) || !Number.isFinite(maxSendable) || minSendable > maxSendable) {
    throw new Error(`${address}: invalid min/maxSendable`);
  }
  return {
    address,
    callback: json.callback,
    minSendable,
    maxSendable,
    commentAllowed: Number(json.commentAllowed) || 0,
    metadata: json.metadata,
  };
}

/** Is `sats` inside the LNURL bounds? (bounds are in millisats) */
export function checkBounds(payReq, sats) {
  const msat = sats * 1000;
  if (msat < payReq.minSendable) return `below ${payReq.address} minimum of ${Math.ceil(payReq.minSendable / 1000)} sat`;
  if (msat > payReq.maxSendable) return `above ${payReq.address} maximum of ${Math.floor(payReq.maxSendable / 1000)} sat`;
  return null;
}

/** Cut a comment to commentAllowed characters (LUD-12), by code points. */
export function fitComment(comment, commentAllowed) {
  if (!comment || !commentAllowed) return '';
  const chars = Array.from(comment);
  return chars.length <= commentAllowed ? comment : chars.slice(0, commentAllowed).join('');
}

/**
 * Build a `rss::payment::{action} {url} {message}` comment
 * (https://podcasting2.org/docs/podcast-namespace/examples/value/metadata).
 * `url` should point at the episode/show; we use the item link, else the feed URL.
 */
export function rssPaymentComment({ action = 'boost', url, message = '', senderName }) {
  const msg = [senderName ? `${senderName}:` : '', message].filter(Boolean).join(' ').trim();
  return ['rss::payment::' + action, url || '', msg].filter(Boolean).join(' ');
}

/** Ask the LNURL callback for an invoice of exactly `sats`. */
export async function requestInvoice(payReq, sats, comment, { fetch: f = globalThis.fetch } = {}) {
  const bound = checkBounds(payReq, sats);
  if (bound) throw new Error(bound);
  const u = new URL(payReq.callback);
  u.searchParams.set('amount', String(sats * 1000));
  const c = fitComment(comment, payReq.commentAllowed);
  if (c) u.searchParams.set('comment', c);
  const res = await f(u.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${payReq.address}: invoice request returned HTTP ${res.status}`);
  const json = await res.json();
  if (json.status === 'ERROR') throw new Error(`${payReq.address}: ${json.reason || 'invoice error'}`);
  if (typeof json.pr !== 'string' || !/^ln/i.test(json.pr)) throw new Error(`${payReq.address}: no invoice returned`);
  const invAmt = bolt11AmountSats(json.pr);
  if (invAmt !== null && invAmt !== sats) {
    throw new Error(`${payReq.address}: invoice is for ${invAmt} sat, expected ${sats}`);
  }
  return { pr: json.pr, comment: c };
}

/** Read the amount from a BOLT11 human-readable part, in whole sats (null if amountless or sub-sat). */
export function bolt11AmountSats(pr) {
  const m = String(pr).toLowerCase().match(/^ln(?:bc|tbs|tb|bcrt|sb)(\d+)([munp]?)1/);
  if (!m) return null;
  // amounts in units of 0.1 msat (pico-BTC): 1 BTC = 1e12 pBTC
  const unit = { '': 1_000_000_000_000n, m: 1_000_000_000n, u: 1_000_000n, n: 1_000n, p: 1n }[m[2]];
  const pico = BigInt(m[1]) * unit;
  if (pico % 10_000n !== 0n) return null; // 1 sat = 10_000 pBTC
  return Number(pico / 10_000n);
}
