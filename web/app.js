import qrcode from 'qrcode-generator';
import { BoostWallet, parseFeed, planBoost, quoteBoost, executeBoost, effectiveValue, isPayableByMint } from '../src/index.js';

const $ = (id) => document.getElementById(id);
const DEMO_FEED = new URL('demo-feed.xml', location.href).toString();
const DEMO_ADDRESSES = new Set(['hexbox@hexbox-ln.hexboxtools.workers.dev']);
const params = new URLSearchParams(location.search);

let bw = null;
let feed = null;
let feedUrl = '';
let quoted = null;
let lastReceipt = null;
let pollTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const progress = (msg) => { $('progress').textContent = msg || ''; };
const storageFor = (mint) => ({
  load: () => localStorage.getItem('nutboost:' + mint),
  save: (s) => localStorage.setItem('nutboost:' + mint, s),
});

function refreshBalance() {
  $('balance').textContent = bw ? bw.balance().toLocaleString() : '–';
  const p = bw ? bw.pendingBalance() : 0;
  $('pending').textContent = p ? `(+${p} pending)` : '';
}

async function connect(mint) {
  mint = (mint || $('mint').value).trim().replace(/\/+$/, '');
  progress(`Connecting to ${mint}…`);
  try {
    const w = new BoostWallet({ mintUrl: mint, storage: storageFor(mint) });
    await w.init();
    bw = w;
    localStorage.setItem('nutboost:lastMint', mint);
    $('mint').value = mint;
    const test = bw.isTestMint();
    const b = $('banner');
    b.hidden = false;
    b.className = 'banner ' + (test ? 'test' : 'real');
    b.textContent = test
      ? `Test mint (${bw.info()?.name || mint}): invoices are auto-marked paid and nothing real moves. Good for trying it out.`
      : `Real mint (${bw.info()?.name || mint}): real sats. Ecash is custodial with this mint, so keep amounts small.`;
    refreshBalance();
    progress('');
    await bw.reconcile().catch(() => {});
    const minted = await bw.collectTopUps().catch(() => 0);
    if (minted) progress(`Collected ${minted} sat from an earlier top-up.`);
    refreshBalance();
    updateConsent();
  } catch (e) {
    progress('Could not use mint: ' + e.message);
  }
}

// ---- wallet UI ----------------------------------------------------------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.tabpane').forEach((p) => { p.hidden = p.id !== 'tab-' + t.dataset.tab; });
}));

$('connect').onclick = () => connect();

$('topup').onclick = async () => {
  if (!bw) return;
  const sats = parseInt($('topup-amount').value, 10);
  if (!(sats > 0)) return;
  try {
    const q = await bw.createTopUp(sats);
    const qr = qrcode(0, 'L');
    qr.addData(q.request.toUpperCase(), 'Alphanumeric');
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
    $('invoice-text').value = q.request;
    $('invoice').hidden = false;
    $('topup-status').textContent = 'Waiting for payment…';
    clearInterval(pollTimer);
    let tries = 0;
    pollTimer = setInterval(async () => {
      if (++tries > 300) { clearInterval(pollTimer); return; }
      const got = await bw.collectTopUps().catch(() => 0);
      if (got) {
        clearInterval(pollTimer);
        $('topup-status').textContent = `Received ${got} sat ✔`;
        refreshBalance();
      }
    }, 2000);
  } catch (e) { $('topup-status').textContent = e.message; $('invoice').hidden = false; }
};
$('copy-invoice').onclick = () => navigator.clipboard.writeText($('invoice-text').value);

$('receive').onclick = async () => {
  if (!bw) return;
  try {
    const n = await bw.receiveToken($('token-in').value);
    $('token-in').value = '';
    progress(`Received ${n} sat.`);
    refreshBalance();
  } catch (e) { progress('Receive failed: ' + e.message + ' (the token must be from the selected mint)'); }
};

$('export').onclick = async () => {
  if (!bw || !bw.balance()) return;
  if (!confirm(`Export ${bw.balance()} sat as a token and empty this wallet? Copy the token somewhere safe.`)) return;
  const { token } = await bw.exportAll();
  $('token-out').hidden = false;
  $('token-out').value = token;
  refreshBalance();
};

// ---- feed UI ------------------------------------------------------------
async function fetchFeed(url) {
  try {
    const r = await fetch(url, { headers: { accept: 'application/rss+xml, application/xml, text/xml, */*' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } catch (e) {
    throw new Error(`Couldn't fetch the feed from this page (${e.message}). The host probably doesn't allow cross-origin reads. Open the feed, copy the XML, and use "Paste the XML".`);
  }
}

function showFeed() {
  $('feed-info').hidden = false;
  $('feed-title').textContent = feed.title || '(untitled feed)';
  const sel = $('episode');
  sel.innerHTML = '<option value="">Whole show (channel split)</option>' +
    feed.items.slice(0, 200).map((i) => `<option value="${esc(i.guid)}">${esc(i.title)}${i.value ? ' ★' : ''}</option>`).join('');
  const want = params.get('episode');
  if (want && feed.items.some((i) => i.guid === want)) sel.value = want;
  else if (feed.items[0]?.value) sel.value = feed.items[0].guid;
  renderSplits();
  updateShare();
  updateConsent();
}

function currentPlan() {
  const sats = parseInt($('amount').value, 10) || 0;
  return planBoost({ feed, feedUrl, itemGuid: $('episode').value || undefined, sats, unpayable: $('redistribute').checked ? 'redistribute' : 'skip' });
}

function renderSplits() {
  quoted = null; $('send').disabled = true; $('quote-table').hidden = true;
  if (!feed) return;
  let plan;
  try { plan = currentPlan(); } catch (e) { $('splits').innerHTML = `<tr><td colspan="5">${esc(e.message)}</td></tr>`; return; }
  const total = plan.lines.reduce((a, l) => a + l.recipient.split, 0) || 1;
  $('splits').innerHTML = plan.lines.map((l) => `<tr>
    <td><b>${esc(l.recipient.name)}</b><br><span class="muted">${esc(l.recipient.address.length > 40 ? l.recipient.address.slice(0, 20) + '…' : l.recipient.address)}</span></td>
    <td>${esc(l.recipient.type)}${l.recipient.fee ? ' · fee' : ''}</td>
    <td class="num">${l.recipient.fee ? l.recipient.split + '%' : Math.round((l.recipient.split / total) * 1000) / 10 + '%'}</td>
    <td class="num">${l.sats}</td>
    <td>${l.payable ? '<span class="pill ok">payable</span>' : `<span class="pill bad" title="${esc(l.reason)}">skip</span>`}</td></tr>`).join('') +
    `<tr><td colspan="3"><b>Paid to recipients</b>${plan.keptSats ? ` · you keep ${plan.keptSats} sat` : ''}</td><td class="num"><b>${plan.payTotal}</b></td><td></td></tr>`;
}

async function loadFeed(url) {
  progress('Loading feed…');
  try {
    const xml = await fetchFeed(url);
    feed = parseFeed(xml);
    feedUrl = url;
    $('feed-url').value = url;
    showFeed();
    progress('');
  } catch (e) { progress(e.message); }
}

$('load-feed').onclick = () => loadFeed($('feed-url').value.trim());
$('demo-feed').onclick = () => loadFeed(DEMO_FEED);
$('parse-xml').onclick = () => {
  try { feed = parseFeed($('feed-xml').value); feedUrl = $('feed-url').value.trim(); showFeed(); progress(''); }
  catch (e) { progress(e.message); }
};
['episode', 'amount', 'redistribute'].forEach((id) => $(id).addEventListener('input', renderSplits));
$('episode').addEventListener('change', () => { renderSplits(); updateShare(); updateConsent(); });

function needsConsent() {
  if (!bw || !feed || !bw.isTestMint()) return false;
  const v = effectiveValue(feed, $('episode').value || undefined).value;
  return (v?.recipients || []).filter(isPayableByMint).some((r) => !DEMO_ADDRESSES.has(r.address.toLowerCase()));
}
function updateConsent() { $('testmint-consent-wrap').hidden = !needsConsent(); }

// ---- boost --------------------------------------------------------------
$('quote').onclick = async () => {
  if (!bw) return progress('Choose a mint first.');
  if (!feed) return progress('Load a feed first.');
  if (needsConsent() && !$('testmint-consent').checked) return progress('Tick the test-mint box first. It will ask real Lightning addresses for invoices.');
  $('quote').disabled = true; $('send').disabled = true;
  try {
    const plan = currentPlan();
    if (!plan.payTotal) throw new Error('Nothing payable at this amount.');
    quoted = await quoteBoost(plan, bw, { message: $('message').value.trim(), senderName: $('sender').value.trim(), onProgress: progress });
    renderQuote();
    const ok = quoted.quotes.some((q) => !q.skipped);
    $('send').disabled = !ok || bw.balance() < quoted.maxCost;
    progress(!ok ? 'No recipient could be quoted.' : bw.balance() < quoted.maxCost ? `Top up first: you need up to ${quoted.maxCost} sat, and the wallet has ${bw.balance()}.` : 'Check the quote, then send.');
  } catch (e) { progress(e.message); }
  $('quote').disabled = false;
};

function renderQuote(results) {
  const tb = $('quote-table').querySelector('tbody');
  tb.innerHTML = quoted.quotes.map((q, i) => {
    const r = results?.[i];
    const st = r ? r.status : q.skipped ? 'skip' : 'quoted';
    const cls = st === 'paid' ? 'ok' : st === 'quoted' ? '' : 'bad';
    const why = r?.reason || q.reason || '';
    return `<tr><td>${esc(q.line.recipient.name)}</td><td class="num">${q.line.sats}</td><td class="num">${q.feeReserve ?? '–'}</td>
      <td><span class="pill ${cls}" title="${esc(why)}">${esc(st)}</span> <span class="muted">${esc(why).slice(0, 80)}</span></td></tr>`;
  }).join('');
  $('maxcost').textContent = `${quoted.maxCost} sat (${quoted.amount} to recipients + up to ${quoted.feeReserve} Lightning fee reserve, plus any mint input fee)`;
  $('quote-table').hidden = false;
}

$('send').onclick = async () => {
  if (!quoted) return;
  $('send').disabled = true; $('quote').disabled = true;
  try {
    const res = await executeBoost(quoted, bw, { onProgress: progress });
    renderQuote(res.results);
    refreshBalance();
    progress(`Boosted ${res.paidSats} sat to ${res.results.filter((r) => r.status === 'paid').length} recipient(s), with ${res.feeSats} sat in fees. Anything that failed went back into your wallet.`);
    lastReceipt = { app: 'nutboost', feed: feedUrl, podcast: feed.title, at: new Date().toISOString(), mint: bw.mintUrl, ...res };
    $('receipt').hidden = false;
  } catch (e) { progress('Boost failed: ' + e.message); }
  quoted = null;
  $('quote').disabled = false;
};

$('download-receipt').onclick = () => {
  const blob = new Blob([JSON.stringify(lastReceipt, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'nutboost-receipt.json' });
  a.click();
};

// ---- share --------------------------------------------------------------
function updateShare() {
  const u = new URL(location.href.split('?')[0].split('#')[0]);
  if (feedUrl) u.searchParams.set('feed', feedUrl);
  if ($('episode').value) u.searchParams.set('episode', $('episode').value);
  $('share-link').value = u.toString();
  $('embed').value = `<a href="${u}" target="_blank" rel="noopener">⚡🌰 Boost this show with ecash</a>`;
}
$('copy-link').onclick = () => navigator.clipboard.writeText($('share-link').value);

// ---- boot ---------------------------------------------------------------
const startMint = params.get('mint') || localStorage.getItem('nutboost:lastMint') || $('mint').value;
connect(startMint);
updateShare();
if (params.get('feed')) loadFeed(params.get('feed'));
if (params.get('amount')) $('amount').value = params.get('amount');
