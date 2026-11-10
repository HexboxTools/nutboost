// Feed doctor: tells a podcaster whether web listeners and plain wallets can pay their
// value block, and what to change if they can't. Read-only: it never requests an invoice.
import { payRoute, isLightningAddress } from './feed.js';
import { resolveLnAddress } from './lnurl.js';

const PUBKEY = /^(02|03)[0-9a-f]{64}$/i;

/** Check one recipient's shape (no network). */
export function diagnoseRecipient(r) {
  const route = payRoute(r);
  if (route) return { ok: true, route };
  const addr = (r.address || '').trim();
  if (r.type === 'node') {
    if (!addr || addr === 'null' || !PUBKEY.test(addr)) {
      return { ok: false, problem: 'broken', reason: `node address "${addr || '(empty)'}" is not a Lightning node key, so nobody can pay this share` };
    }
    return { ok: false, problem: 'keysend', reason: 'keysend-only: Cashu mints, web wallets and most custodial wallets can only pay invoices' };
  }
  if (r.type === 'lnaddress' && !isLightningAddress(addr)) {
    return { ok: false, problem: 'broken', reason: `"${addr}" is not a valid Lightning address` };
  }
  return { ok: false, problem: 'unsupported', reason: `unsupported recipient type "${r.type || '(none)'}"` };
}

/** Diagnose a parsed feed. With `live`, each Lightning address's LNURL endpoint is fetched (GET only). */
export async function diagnoseFeed(feed, { live = false, fetch: f = globalThis.fetch } = {}) {
  const block = feed.value || feed.items.find((i) => i.value?.recipients?.length)?.value;
  const recipients = (block?.recipients || []).filter((r) => !(r.fee === true || r.fee === 'true'));
  const total = recipients.reduce((a, r) => a + (Number(r.split) || 0), 0);
  const rows = [];
  for (const r of recipients) {
    const d = diagnoseRecipient(r);
    if (d.ok && live && d.route === 'lightning') {
      try { await resolveLnAddress(r.address, { fetch: f }); } catch (e) { Object.assign(d, { ok: false, problem: 'unreachable', reason: e.message }); }
    }
    rows.push({ name: r.name, type: r.type, address: r.address, split: Number(r.split) || 0, ...d });
  }
  const payable = rows.filter((x) => x.ok).reduce((a, x) => a + x.split, 0);
  const share = total ? payable / total : 0;
  const verdict = !recipients.length ? 'no-value-block' : share >= 1 ? 'fully-payable' : share > 0 ? 'partly-payable' : 'not-payable';
  return { title: feed.title, verdict, share, rows, fixes: fixesFor(rows, verdict) };
}

function fixesFor(rows, verdict) {
  const fixes = [];
  if (verdict === 'no-value-block') fixes.push('Add a <podcast:value type="lightning" method="lnaddress"> block with at least one Lightning address.');
  if (rows.some((x) => x.problem === 'keysend')) {
    fixes.push('Add a Lightning address for each keysend recipient, e.g. <podcast:valueRecipient type="lnaddress" address="you@yourwallet.com" .../>. '
      + 'Podcasting 2.0 recommends lnaddress recipients; split-aware apps that prefer keysend can keep using a separate node block.');
  }
  if (rows.some((x) => x.problem === 'broken')) fixes.push('Fix or remove recipients with an empty/"null"/invalid address: their share cannot be paid by any app.');
  if (rows.some((x) => x.problem === 'unreachable')) fixes.push('A Lightning address did not answer its LNURL endpoint; check it in any wallet before relying on it.');
  return fixes;
}
