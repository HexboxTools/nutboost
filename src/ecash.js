// Ecash-direct recipients: shares paid as Cashu ecash, not over Lightning.
//
// Recipient types understood in a <podcast:valueRecipient>:
//   type="cashu"  (aliases: nut18, creq)   address = a NUT-18 payment request (creqA… / CREQB1…)
//                                          delivered by its HTTP POST or Nostr (NIP-17) transport
//   type="nutzap" (aliases: nostr, npub)   address = npub… or hex pubkey; paid as a NIP-61 nutzap
//                                          (P2PK-locked ecash, published as kind:9321)
// and at show / episode level:
//   <podcast:txt purpose="cashu">creqA…</podcast:txt>   the show's own NUT-18 request, e.g. a
//                                                       nutsplit server that splits server-side.
//
// Neither type is in the Podcasting 2.0 spec yet (valueRecipient `type` is an open slug); they
// follow the CASHU_STREAMING proposal used by Hopp / Sovereigncast / nutsplit for show level.
//
// If a recipient doesn't accept our mint, the share is moved across by Lightning ("cross-mint"):
// we melt our ecash to pay a mint quote at one of *their* mints, then mint the share there
// (already P2PK-locked for nutzaps).

import { decodePaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import { nip19, finalizeEvent, getPublicKey, verifyEvent, generateSecretKey } from 'nostr-tools';
import * as nip17 from 'nostr-tools/nip17';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

export const ECASH_TYPES = {
  cashu: 'nut18', nut18: 'nut18', creq: 'nut18',
  nutzap: 'nutzap', nostr: 'nutzap', npub: 'nutzap',
};
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social'];

export const ecashKind = (recipient) => ECASH_TYPES[recipient?.type] || null;

export const normMint = (u) => String(u || '').trim().replace(/\/+$/, '');

/** npub / nprofile / 64-hex -> { pubkey, relays } */
export function parseNostrAddress(addr) {
  const a = String(addr || '').trim();
  if (/^[0-9a-f]{64}$/i.test(a)) return { pubkey: a.toLowerCase(), relays: [] };
  const d = nip19.decode(a.replace(/^nostr:/, ''));
  if (d.type === 'npub') return { pubkey: d.data, relays: [] };
  if (d.type === 'nprofile') return { pubkey: d.data.pubkey, relays: d.data.relays || [] };
  throw new Error('not an npub/nprofile/hex pubkey');
}

export function isValidEcashRecipient(recipient) {
  const k = ecashKind(recipient);
  if (!k) return false;
  try {
    if (k === 'nut18') { decodePaymentRequest(recipient.address); return true; }
    parseNostrAddress(recipient.address);
    return true;
  } catch { return false; }
}

/** Parse a NIP-61 kind:10019 nutzap-info event. */
export function parseNutzapInfo(ev) {
  if (!ev || ev.kind !== 10019) throw new Error('not a kind:10019 event');
  const tag = (n) => ev.tags.filter((t) => t[0] === n);
  const relays = tag('relay').map((t) => t[1]).filter(Boolean);
  const mints = tag('mint').filter((t) => t[1] && (t.length < 3 || t.slice(2).includes('sat'))).map((t) => normMint(t[1]));
  const pk = tag('pubkey')[0]?.[1];
  if (!pk) throw new Error('nutzap info has no pubkey');
  if (!mints.length) throw new Error('nutzap info lists no sat mints');
  const p2pk = pk.length === 64 ? '02' + pk : pk; // NIP-61: prefix with 02 for Cashu
  return { pubkey: ev.pubkey, p2pk, mints, relays };
}

/**
 * Decide how to reach a recipient that accepts `mints` (strict or advisory).
 * @returns {{mode:'direct'} | {mode:'crossmint', targetMint:string}}
 */
export function chooseRoute(ourMint, mints, { strict = true } = {}) {
  const ours = normMint(ourMint);
  const list = (mints || []).map(normMint);
  if (!list.length || list.includes(ours) || !strict) return { mode: 'direct' };
  return { mode: 'crossmint', targetMint: list[0] };
}

/** Inspect a NUT-18 request for paying `sats` from `ourMint`. Throws with a readable reason. */
export function inspectRequest(creq, sats, ourMint) {
  const pr = decodePaymentRequest(creq.trim());
  if (pr.unit && pr.unit !== 'sat') throw new Error(`request is for unit ${pr.unit}, not sat`);
  const fixed = pr.amount != null ? Number(pr.amount.toString()) : null;
  if (fixed != null && fixed !== sats) throw new Error(`request is for exactly ${fixed} sat, share is ${sats}`);
  const post = pr.getTransport(PaymentRequestTransportType.POST);
  const nostr = pr.getTransport(PaymentRequestTransportType.NOSTR);
  const usableNostr = nostr && (!nostr.tags?.length || nostr.tags.some((t) => t[0] === 'n' && t[1] === '17'));
  if (!post && !usableNostr) throw new Error('request has no transport nutboost can use (needs HTTP POST or NIP-17)');
  const strict = pr.isMintListStrict !== false;
  const route = chooseRoute(ourMint, pr.mints, { strict });
  if (pr.nut10 && route.mode === 'crossmint') throw new Error('locked request on a mint we do not use: not supported yet');
  return { pr, transport: post ? 'post' : 'nostr', post, nostr, route, amountless: fixed == null, lockedRequest: !!pr.nut10 };
}

/** Build and sign a NIP-61 nutzap (kind:9321). Proof amounts are written as numbers. */
export function buildNutzapEvent({ proofs, mintUrl, recipientPubkey, content = '', senderSk, extraTags = [], createdAt }) {
  const tags = [
    ...proofs.map((p) => ['proof', JSON.stringify(proofToJson(p))]),
    ['unit', 'sat'],
    ['u', normMint(mintUrl)],
    ['p', recipientPubkey],
    ...extraTags,
  ];
  return finalizeEvent({ kind: 9321, created_at: createdAt ?? Math.floor(Date.now() / 1000), content, tags }, senderSk);
}

export function proofToJson(p) {
  const out = { id: p.id, amount: Number(p.amount?.toString?.() ?? p.amount), secret: p.secret, C: p.C };
  if (p.dleq) out.dleq = p.dleq;
  if (p.witness) out.witness = p.witness;
  return out;
}

/** Podcast-aware tags for a nutzap (NIP-73 external ids, as Hopp/nutsplit read them). */
export function podcastTags({ podcastGuid, itemGuid, episodeTitle, ts }) {
  const t = [];
  if (podcastGuid) t.push(['i', `podcast:guid:${podcastGuid}`]);
  if (itemGuid) t.push(['i', `podcast:item:guid:${itemGuid}`], ['episode_guid', itemGuid]);
  if (episodeTitle) t.push(['episode', episodeTitle]);
  if (ts != null) t.push(['ts', String(ts)]);
  return t;
}

/** Minimal Nostr client used by nutboost (overridable in tests). Uses the global WebSocket. */
export function makeNostr({ timeoutMs = 6000 } = {}) {
  const once = (url, frames, onMsg) => new Promise((resolve) => {
    let ws; let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws?.close(); } catch {} resolve(v); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try { ws = new WebSocket(url); } catch { clearTimeout(timer); return resolve(null); }
    ws.onopen = () => frames.forEach((f) => ws.send(JSON.stringify(f)));
    ws.onerror = () => { clearTimeout(timer); finish(null); };
    ws.onmessage = (m) => { let d; try { d = JSON.parse(m.data); } catch { return; } const r = onMsg(d); if (r !== undefined) { clearTimeout(timer); finish(r); } };
  });
  return {
    async query(relays, filter) {
      const sub = 'nb' + Math.random().toString(36).slice(2, 8);
      const results = await Promise.all(relays.map((u) => {
        const evs = [];
        return once(u, [['REQ', sub, filter]], (d) => {
          if (d[0] === 'EVENT' && d[1] === sub) evs.push(d[2]);
          if (d[0] === 'EOSE' && d[1] === sub) return evs;
          return undefined;
        }).then((r) => r || evs);
      }));
      const byId = new Map();
      results.flat().filter((e) => e && verifyEvent(e)).forEach((e) => byId.set(e.id, e));
      return [...byId.values()];
    },
    async publish(relays, ev) {
      const res = await Promise.all(relays.map((u) => once(u, [['EVENT', ev]], (d) => (d[0] === 'OK' && d[1] === ev.id ? { url: u, ok: !!d[2], msg: d[3] } : undefined))));
      return relays.map((u, i) => res[i] || { url: u, ok: false, msg: 'timeout' });
    },
  };
}

/** Fetch the newest kind:10019 for a pubkey. */
export async function fetchNutzapInfo(pubkey, { relays = DEFAULT_RELAYS, nostr = makeNostr() } = {}) {
  const evs = await nostr.query(relays, { kinds: [10019], authors: [pubkey], limit: 5 });
  const ev = evs.filter((e) => e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0];
  if (!ev) throw new Error('recipient has no nutzap info (kind:10019) on the relays checked');
  return parseNutzapInfo(ev);
}

/** Deliver a NUT-18 payload over its transport. Returns {ok, rejected?, error?}. */
export async function deliverPayload(insp, body, { fetch: f = globalThis.fetch, nostr = makeNostr(), senderSk } = {}) {
  if (insp.transport === 'post') {
    let res;
    try {
      res = await f(insp.post.target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    } catch (e) { return { ok: false, rejected: false, error: 'network: ' + (e?.message || e) }; }
    if (res.ok) return { ok: true };
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch {}
    // 4xx = the payee refused the payload: safe to take the proofs back. 5xx/other: unknown.
    return { ok: false, rejected: res.status >= 400 && res.status < 500, error: `HTTP ${res.status} ${detail}`.trim() };
  }
  const { pubkey, relays } = parseNostrAddress(insp.nostr.target);
  const wrap = nip17.wrapEvent(senderSk, { publicKey: pubkey }, body);
  const acks = await nostr.publish(relays.length ? relays : DEFAULT_RELAYS, wrap);
  return acks.some((a) => a.ok) ? { ok: true, relays: acks.filter((a) => a.ok).map((a) => a.url) } : { ok: false, rejected: false, error: 'no relay accepted the DM' };
}

export { getPublicKey, generateSecretKey, bytesToHex, hexToBytes };
