// Headless-browser check of the web UI with ecash-direct recipients (test mints, local relay + receiver).
// usage: node scripts/ui-ecash-check.mjs [pageUrl]   (needs puppeteer-core + Chrome; dev only)
import http from 'node:http';
import { Wallet, PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { startRelay } from '../test/helpers/relay.js';
import { makeNostr } from '../src/ecash.js';
const puppeteer = (await import(process.env.PUPPETEER || 'puppeteer-core')).default;

const page = process.argv[2] || 'http://localhost:8765/';
const relay = await startRelay();
const got = [];
const srv = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let b = ''; for await (const c of req) b += c;
  const p = PaymentRequest.decodePayload(b); const w = new Wallet(p.mint); await w.loadMint();
  const r = await w.receive({ mint: p.mint, proofs: p.proofs, unit: 'sat' }); got.push(r.reduce((a, x) => a + x.amount.toNumber(), 0));
  res.writeHead(200); res.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const creq = new PaymentRequest([{ type: PaymentRequestTransportType.POST, target: `http://127.0.0.1:${srv.address().port}/pay` }], 'ui', undefined, 'sat', ['https://testnut.cashu.space'], 'ui', false).toEncodedCreqA();
const sk = generateSecretKey(); const pk = getPublicKey(sk);
await makeNostr().publish([relay.url], finalizeEvent({ kind: 10019, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['relay', relay.url], ['mint', 'https://testnut.cashu.space', 'sat'], ['pubkey', getPublicKey(generateSecretKey())]] }, sk));
const xml = `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>UI Ecash Test</title>
<podcast:value type="lightning"><podcast:valueRecipient name="Host" type="lnaddress" address="hexbox@hexbox-ln.hexboxtools.workers.dev" split="50"/>
<podcast:valueRecipient name="Cohost (NUT-18)" type="cashu" address="${creq}" split="30"/>
<podcast:valueRecipient name="Guest (nutzap)" type="nutzap" address="${nip19.nprofileEncode({ pubkey: pk, relays: [relay.url] })}" split="20"/></podcast:value></channel></rss>`;

const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const p = await b.newPage(); await p.setViewport({ width: 1100, height: 900 });
await p.goto(page, { waitUntil: 'networkidle2' });
await p.waitForFunction(() => document.getElementById('balance').textContent !== '–', { timeout: 30000 });
await p.click('#topup');
await p.waitForFunction(() => /Received/.test(document.getElementById('topup-status').textContent), { timeout: 60000 });
await p.$eval('#feed-xml', (e, v) => { e.value = v; }, xml);
await p.$eval('details', (e) => { e.open = true; });
await p.click('#parse-xml');
await p.click('#testmint-consent');
await p.click('#quote');
await p.waitForFunction(() => !document.getElementById('send').disabled || /No recipient|Top up/.test(document.getElementById('progress').textContent), { timeout: 60000 });
await p.click('#send');
await p.waitForFunction(() => /Boosted|failed/.test(document.getElementById('progress').textContent), { timeout: 60000 });
console.log('UI:', await p.$eval('#progress', (e) => e.textContent));
console.log('rows:', await p.$$eval('#quote-table tbody tr', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')).join(' | ')));
const zaps = await makeNostr().query([relay.url], { kinds: [9321], '#p': [pk] });
console.log('NUT-18 receiver got', got, '· nutzaps on relay', zaps.length);
await p.screenshot({ path: process.env.SHOT || '/tmp/ui-ecash.png', fullPage: true });
await b.close(); await relay.close(); srv.close(); process.exit(0);
