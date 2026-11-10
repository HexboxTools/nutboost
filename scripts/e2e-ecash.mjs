// End-to-end, ecash-direct recipients, on the public FakeWallet test mints (no real sats move).
// Spins up a local Nostr relay and a local NUT-18 HTTP receiver, then boosts a feed whose split has:
//   a NUT-18 request on our mint (HTTP POST), a NUT-18 request on ANOTHER mint (cross-mint),
//   a nutzap recipient on our mint, a nutzap recipient on another mint (cross-mint),
//   a NUT-18 request delivered by NIP-17 DM, and a NUT-18 receiver that rejects (refund path).
// Each recipient then redeems what it got, proving the ecash is real and spendable by them only.
import http from 'node:http';
import { Wallet, PaymentRequest, PaymentRequestTransportType, getDecodedToken } from '@cashu/cashu-ts';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import * as nip17 from 'nostr-tools/nip17';
import { bytesToHex } from 'nostr-tools/utils';
import { startRelay } from '../test/helpers/relay.js';
import { BoostWallet, parseFeed, planBoost, quoteBoost, executeBoost, makeNostr } from '../src/index.js';

const A = 'https://testnut.cashu.space';
const B = 'https://testnut.cashudevkit.org';
const log = (...a) => console.log(...a);

const relay = await startRelay();
const nostr = makeNostr({ timeoutMs: 4000 });

// --- NUT-18 HTTP receivers ---------------------------------------------------
const received = { ok: [], rejected: 0 };
const srv = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  if (req.url === '/reject') { received.rejected++; res.writeHead(400); return res.end('{"error":"untrusted_mint"}'); }
  try {
    const p = PaymentRequest.decodePayload(body);
    const w = new Wallet(p.mint); await w.loadMint();
    const got = await w.receive({ mint: p.mint, proofs: p.proofs, unit: 'sat' });
    received.ok.push({ path: req.url, mint: p.mint, sats: got.reduce((a, x) => a + x.amount.toNumber(), 0), memo: p.memo });
    res.writeHead(200); res.end('{}');
  } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const creq = (path, mints) => new PaymentRequest([{ type: PaymentRequestTransportType.POST, target: base + path }], 'nb-' + path.slice(1), undefined, 'sat', mints, 'nutboost e2e', false).toEncodedCreqA();

// --- nutzap recipients (kind:10019 on the local relay) -----------------------
async function nutzapRecipient(mint) {
  const sk = generateSecretKey(); const pk = getPublicKey(sk);
  const p2pkSk = generateSecretKey(); const p2pkPk = getPublicKey(p2pkSk);
  const ev = finalizeEvent({ kind: 10019, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['relay', relay.url], ['mint', mint, 'sat'], ['pubkey', p2pkPk]] }, sk);
  await nostr.publish([relay.url], ev);
  return { npub: nip19.npubEncode(pk), pk, p2pkSkHex: bytesToHex(p2pkSk) };
}
const zapA = await nutzapRecipient(A);
const zapB = await nutzapRecipient(B);

// --- NUT-18 over NIP-17 --------------------------------------------------------
const dmSk = generateSecretKey(); const dmPk = getPublicKey(dmSk);
const creqDm = new PaymentRequest([{ type: PaymentRequestTransportType.NOSTR, target: nip19.nprofileEncode({ pubkey: dmPk, relays: [relay.url] }), tags: [['n', '17']] }], 'nb-dm', undefined, 'sat', [A], 'nutboost e2e dm', false).toEncodedCreqA();

const feedXml = `<?xml version="1.0"?><rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
<title>Ecash Split Test</title><link>https://hexboxtools.github.io/nutboost/</link><podcast:guid>e2e-ecash</podcast:guid>
<podcast:value type="lightning" method="lnaddress">
  <podcast:valueRecipient name="Host (lnaddress)" type="lnaddress" address="hexbox@hexbox-ln.hexboxtools.workers.dev" split="20"/>
  <podcast:valueRecipient name="Cohost (NUT-18, same mint)" type="cashu" address="${creq('/cohost', [A])}" split="20"/>
  <podcast:valueRecipient name="Editor (NUT-18, other mint)" type="cashu" address="${creq('/editor', [B])}" split="15"/>
  <podcast:valueRecipient name="Guest (nutzap, same mint)" type="nutzap" address="${zapA.npub}" split="15"/>
  <podcast:valueRecipient name="Artist (nutzap, other mint)" type="nutzap" address="${zapB.npub}" split="10"/>
  <podcast:valueRecipient name="Producer (NUT-18 via NIP-17)" type="cashu" address="${creqDm}" split="10"/>
  <podcast:valueRecipient name="Grumpy (NUT-18, rejects)" type="cashu" address="${creq('/reject', [A])}" split="10"/>
</podcast:value></channel></rss>`;

const bw = await new BoostWallet({ mintUrl: A }).init();
if (!bw.isTestMint()) throw new Error('test mints only');
await bw.createTopUp(500);
for (let i = 0; i < 40 && !bw.balance(); i++) { await bw.collectTopUps(); if (!bw.balance()) await new Promise((r) => setTimeout(r, 1000)); }
log('wallet funded with', bw.balance(), 'test sat');

const plan = planBoost({ feed: parseFeed(feedXml), feedUrl: 'https://example.invalid/e2e.xml', sats: 200 });
log('plan:', plan.lines.map((l) => `${l.recipient.name}=${l.sats}`).join(' | '));
const quoted = await quoteBoost(plan, bw, { message: 'ecash e2e', senderName: 'nutboost', nostr, relays: [relay.url], onProgress: (m) => log('  ' + m) });
log('quoted', quoted.amount, 'sat, max fees', quoted.feeReserve);
const res = await executeBoost(quoted, bw, { nostr, onProgress: (m) => log('  ' + m) });
for (const r of res.results) log(`  ${r.status.padEnd(9)} ${String(r.sats).padStart(3)} ${r.name} via ${r.via || r.route}${r.eventId ? ' event ' + r.eventId.slice(0, 12) : ''}${r.reason ? ' — ' + r.reason.slice(0, 70) : ''}`);
log('paid', res.paidSats, 'fees', res.feeSats, 'balance', bw.balance(), 'pending', bw.pendingEcash.length);

// --- recipients redeem ----------------------------------------------------------
log('NUT-18 receivers got:', JSON.stringify(received.ok), 'rejected:', received.rejected);
for (const z of [zapA, zapB]) {
  const evs = await nostr.query([relay.url], { kinds: [9321], '#p': [z.pk] });
  for (const e of evs) {
    const mint = e.tags.find((t) => t[0] === 'u')[1];
    const proofs = e.tags.filter((t) => t[0] === 'proof').map((t) => JSON.parse(t[1]));
    const w = new Wallet(mint); await w.loadMint();
    const stolen = await w.receive({ mint, proofs, unit: 'sat' }).then(() => 'SPENDABLE BY ANYONE (bad)').catch(() => 'locked (good)');
    const got = await w.receive({ mint, proofs, unit: 'sat' }, { privkey: z.p2pkSkHex });
    log(`nutzap ${e.id.slice(0, 12)} @${mint}: without key -> ${stolen}; recipient redeemed ${got.reduce((a, x) => a + x.amount.toNumber(), 0)} sat; content="${e.content}"; tags=${e.tags.filter((t) => t[0] !== 'proof').map((t) => t[0]).join(',')}`);
  }
}
{
  const wraps = await nostr.query([relay.url], { kinds: [1059], '#p': [dmPk] });
  for (const wrap of wraps) {
    const rumor = nip17.unwrapEvent(wrap, dmSk);
    const p = PaymentRequest.decodePayload(rumor.content);
    const w = new Wallet(p.mint); await w.loadMint();
    const got = await w.receive({ mint: p.mint, proofs: p.proofs, unit: 'sat' });
    log(`NIP-17 DM payment id=${p.id}: recipient redeemed ${got.reduce((a, x) => a + x.amount.toNumber(), 0)} sat`);
  }
}

// --- show-level request (one payment; the show's server splits) ---------------------
const showXml = `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Show With Server</title><podcast:txt purpose="cashu">${creq('/show', [A])}</podcast:txt>
<podcast:value type="lightning"><podcast:valueRecipient name="Host" type="node" address="02${'a'.repeat(64)}" split="100"/></podcast:value></channel></rss>`;
const sp = planBoost({ feed: parseFeed(showXml), sats: 21, target: 'show' });
const sres = await executeBoost(await quoteBoost(sp, bw, { nostr }), bw, { nostr });
log('show-level request:', sres.results.map((r) => `${r.status} ${r.sats} ${r.name}`).join(', '));
log('final balance', bw.balance(), 'pending ecash', bw.pendingEcash.length, 'stranded', bw.stranded.length);
await relay.close(); srv.close();
process.exit(0);
