import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, nip19 } from 'nostr-tools';
import { parseNutzapInfo, chooseRoute, inspectRequest, buildNutzapEvent, parseNostrAddress, podcastTags, deliverPayload, makeNostr, fetchNutzapInfo, isValidEcashRecipient } from '../src/ecash.js';
import { parseFeed, payRoute } from '../src/feed.js';
import { computeSplits } from '../src/split.js';
import { planBoost } from '../src/boost.js';
import { startRelay } from './helpers/relay.js';

const A = 'https://mint-a.test';
const B = 'https://mint-b.test';
const req = ({ mints = [A], amount, unit = 'sat', transports, strict = true, lock } = {}) =>
  new PaymentRequest(transports || [{ type: PaymentRequestTransportType.POST, target: 'https://pay.test/x' }], 'id1', amount, unit, mints, 'd', false, lock, strict ? undefined : true).toEncodedCreqA();

describe('recipient routing', () => {
  it('recognises lightning, NUT-18 and nutzap recipients', () => {
    const npub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    expect(payRoute({ type: 'lnaddress', address: 'a@b.co' })).toBe('lightning');
    expect(payRoute({ type: 'cashu', address: req() })).toBe('nut18');
    expect(payRoute({ type: 'nut18', address: req() })).toBe('nut18');
    expect(payRoute({ type: 'nutzap', address: npub })).toBe('nutzap');
    expect(payRoute({ type: 'nostr', address: 'f'.repeat(64) })).toBe('nutzap');
    expect(payRoute({ type: 'node', address: '02ab' })).toBeNull();
    expect(payRoute({ type: 'cashu', address: 'garbage' })).toBeNull();
    expect(isValidEcashRecipient({ type: 'cashu', address: req() })).toBe(true);
    expect(isValidEcashRecipient({ type: 'nutzap', address: 'npub1bad' })).toBe(false);
  });
  it('splits include ecash recipients as payable', () => {
    const r = computeSplits(100, [{ name: 'a', type: 'cashu', address: req(), split: 1 }, { name: 'k', type: 'node', address: '02', split: 1 }]);
    expect(r.lines.map((l) => l.payable)).toEqual([true, false]);
  });
  it('chooses direct vs cross-mint', () => {
    expect(chooseRoute(A, [A, B])).toEqual({ mode: 'direct' });
    expect(chooseRoute(A + '/', [A])).toEqual({ mode: 'direct' });
    expect(chooseRoute(A, [])).toEqual({ mode: 'direct' });
    expect(chooseRoute(A, [B])).toEqual({ mode: 'crossmint', targetMint: B });
    expect(chooseRoute(A, [B], { strict: false })).toEqual({ mode: 'direct' });
  });
});

describe('NUT-18 requests', () => {
  it('inspects a POST request on our mint', () => {
    const i = inspectRequest(req(), 21, A);
    expect(i.transport).toBe('post');
    expect(i.route.mode).toBe('direct');
    expect(i.amountless).toBe(true);
  });
  it('routes a strict foreign-mint request through a cross-mint', () => {
    expect(inspectRequest(req({ mints: [B] }), 21, A).route).toEqual({ mode: 'crossmint', targetMint: B });
  });
  it('rejects wrong unit, wrong fixed amount, unusable transport', () => {
    expect(() => inspectRequest(req({ unit: 'usd', amount: 5 }), 5, A)).toThrow(/unit usd/);
    expect(() => inspectRequest(req({ amount: 50 }), 21, A)).toThrow(/exactly 50/);
    expect(inspectRequest(req({ amount: 21 }), 21, A).amountless).toBe(false);
    const nostrNo17 = req({ transports: [{ type: PaymentRequestTransportType.NOSTR, target: nip19.nprofileEncode({ pubkey: 'f'.repeat(64) }), tags: [['n', '04']] }] });
    expect(() => inspectRequest(nostrNo17, 1, A)).toThrow(/transport/);
  });
  it('accepts a NIP-17 nostr transport', () => {
    const r = req({ transports: [{ type: PaymentRequestTransportType.NOSTR, target: nip19.nprofileEncode({ pubkey: 'f'.repeat(64), relays: ['wss://r.test'] }), tags: [['n', '17']] }] });
    expect(inspectRequest(r, 1, A).transport).toBe('nostr');
  });
  it('delivers over POST and classifies refusals', async () => {
    const insp = inspectRequest(req(), 21, A);
    const mk = (status) => async () => ({ ok: status < 300, status, text: async () => 'nope' });
    expect(await deliverPayload(insp, '{}', { fetch: mk(200) })).toEqual({ ok: true });
    expect((await deliverPayload(insp, '{}', { fetch: mk(400) })).rejected).toBe(true);
    expect((await deliverPayload(insp, '{}', { fetch: mk(503) })).rejected).toBe(false);
    const down = async () => { throw new Error('ECONNREFUSED'); };
    expect(await deliverPayload(insp, '{}', { fetch: down })).toMatchObject({ ok: false, rejected: false });
  });
  it('reads a show-level <podcast:txt purpose="cashu"> request', () => {
    const c = req();
    const f = parseFeed(`<rss><channel><title>S</title><podcast:txt purpose="cashu">${c}</podcast:txt><podcast:txt purpose="other">x</podcast:txt><item><guid>e1</guid><podcast:txt purpose="cashu">${c}</podcast:txt></item></channel></rss>`);
    expect(f.ecashRequest).toBe(c);
    expect(f.items[0].ecashRequest).toBe(c);
    const p = planBoost({ feed: f, sats: 21, target: 'show' });
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ sats: 21, payable: true });
    expect(() => planBoost({ feed: parseFeed('<rss><channel></channel></rss>'), sats: 1, target: 'show' })).toThrow(/payment request/);
  });
});

describe('nutzaps (NIP-61)', () => {
  const sk = generateSecretKey(); const pk = getPublicKey(sk);
  const p2 = getPublicKey(generateSecretKey());
  const info = finalizeEvent({ kind: 10019, created_at: 1, content: '', tags: [['relay', 'wss://r.test'], ['mint', A, 'sat'], ['mint', B, 'usd'], ['pubkey', p2]] }, sk);
  it('parses kind:10019 and prefixes the P2PK key', () => {
    const i = parseNutzapInfo(info);
    expect(i).toMatchObject({ pubkey: pk, p2pk: '02' + p2, mints: [A], relays: ['wss://r.test'] });
    expect(() => parseNutzapInfo({ ...info, kind: 1 })).toThrow();
  });
  it('parses npub, nprofile and hex', () => {
    expect(parseNostrAddress(nip19.npubEncode(pk)).pubkey).toBe(pk);
    expect(parseNostrAddress(nip19.nprofileEncode({ pubkey: pk, relays: ['wss://x'] })).relays).toEqual(['wss://x']);
    expect(parseNostrAddress(pk.toUpperCase()).pubkey).toBe(pk);
  });
  it('builds a signed kind:9321 with proofs as numbers', () => {
    const ev = buildNutzapEvent({ proofs: [{ id: '00ab', amount: { toString: () => '8' }, secret: '["P2PK",{}]', C: '02cc', dleq: { e: '1', s: '2', r: '3' } }],
      mintUrl: A + '/', recipientPubkey: pk, content: 'great show', senderSk: generateSecretKey(), extraTags: podcastTags({ podcastGuid: 'g', itemGuid: 'i' }) });
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.kind).toBe(9321);
    const proof = JSON.parse(ev.tags.find((t) => t[0] === 'proof')[1]);
    expect(proof.amount).toBe(8);
    expect(proof.dleq).toBeTruthy();
    expect(ev.tags).toContainEqual(['u', A]);
    expect(ev.tags).toContainEqual(['p', pk]);
    expect(ev.tags).toContainEqual(['i', 'podcast:guid:g']);
    expect(ev.tags).toContainEqual(['i', 'podcast:item:guid:i']);
  });

  let relay;
  beforeAll(async () => { relay = await startRelay(); });
  afterAll(async () => { await relay?.close(); });
  it('publishes and finds nutzap info through a relay', async () => {
    const nostr = makeNostr({ timeoutMs: 2000 });
    const acks = await nostr.publish([relay.url], info);
    expect(acks[0].ok).toBe(true);
    const got = await fetchNutzapInfo(pk, { relays: [relay.url], nostr });
    expect(got.p2pk).toBe('02' + p2);
    await expect(fetchNutzapInfo(getPublicKey(generateSecretKey()), { relays: [relay.url], nostr })).rejects.toThrow(/no nutzap info/);
  });
  it('reports relay refusals', async () => {
    const bad = await startRelay({ reject: true });
    const acks = await makeNostr({ timeoutMs: 2000 }).publish([bad.url], info);
    expect(acks[0]).toMatchObject({ ok: false });
    await bad.close();
  });
});
