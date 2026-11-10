import { describe, it, expect } from 'vitest';
import { lnAddressToUrl, resolveLnAddress, requestInvoice, fitComment, rssPaymentComment, bolt11AmountSats, checkBounds } from '../src/lnurl.js';

const jsonFetch = (routes) => async (url) => {
  const key = Object.keys(routes).find((k) => url.startsWith(k));
  if (!key) return { ok: false, status: 404, json: async () => ({}) };
  const body = typeof routes[key] === 'function' ? routes[key](url) : routes[key];
  return { ok: true, status: 200, json: async () => body };
};

describe('lnurl', () => {
  it('maps a lightning address to its well-known URL', () => {
    expect(lnAddressToUrl('Alice@Example.com')).toBe('https://example.com/.well-known/lnurlp/alice');
    expect(() => lnAddressToUrl('nope')).toThrow();
  });
  it('resolves a payRequest and validates it', async () => {
    const f = jsonFetch({ 'https://ex.com/.well-known/lnurlp/a': { tag: 'payRequest', callback: 'https://ex.com/cb', minSendable: 1000, maxSendable: 1e9, commentAllowed: 10 } });
    const p = await resolveLnAddress('a@ex.com', { fetch: f });
    expect(p.commentAllowed).toBe(10);
    const bad = jsonFetch({ 'https://ex.com/.well-known/lnurlp/a': { tag: 'withdrawRequest' } });
    await expect(resolveLnAddress('a@ex.com', { fetch: bad })).rejects.toThrow(/not an LNURL-pay/);
    const err = jsonFetch({ 'https://ex.com/.well-known/lnurlp/a': { status: 'ERROR', reason: 'no such user' } });
    await expect(resolveLnAddress('a@ex.com', { fetch: err })).rejects.toThrow(/no such user/);
  });
  it('requests an invoice for exactly the share, with a trimmed comment', async () => {
    let seen;
    const f = jsonFetch({ 'https://ex.com/cb': (u) => { seen = new URL(u); return { pr: 'lnbc210n1pxyz' }; } });
    const pay = { address: 'a@ex.com', callback: 'https://ex.com/cb?tag=x', minSendable: 1000, maxSendable: 1e9, commentAllowed: 5 };
    const r = await requestInvoice(pay, 21, 'hello world', { fetch: f });
    expect(seen.searchParams.get('amount')).toBe('21000');
    expect(seen.searchParams.get('comment')).toBe('hello');
    expect(seen.searchParams.get('tag')).toBe('x');
    expect(r.pr).toBe('lnbc210n1pxyz');
  });
  it('refuses an invoice for the wrong amount', async () => {
    const f = jsonFetch({ 'https://ex.com/cb': { pr: 'lnbc1u1pxyz' } });
    const pay = { address: 'a@ex.com', callback: 'https://ex.com/cb', minSendable: 1000, maxSendable: 1e9, commentAllowed: 0 };
    await expect(requestInvoice(pay, 21, '', { fetch: f })).rejects.toThrow(/expected 21/);
  });
  it('omits the comment when the provider allows none', async () => {
    let seen;
    const f = jsonFetch({ 'https://ex.com/cb': (u) => { seen = new URL(u); return { pr: 'lnbc210n1pxyz' }; } });
    await requestInvoice({ address: 'a@ex.com', callback: 'https://ex.com/cb', minSendable: 1000, maxSendable: 1e9, commentAllowed: 0 }, 21, 'hi', { fetch: f });
    expect(seen.searchParams.has('comment')).toBe(false);
  });
  it('checks bounds in millisats', () => {
    const p = { address: 'a@ex.com', minSendable: 10000, maxSendable: 100000 };
    expect(checkBounds(p, 5)).toMatch(/minimum of 10/);
    expect(checkBounds(p, 101)).toMatch(/maximum of 100/);
    expect(checkBounds(p, 50)).toBeNull();
  });
  it('fits comments by code point', () => {
    expect(fitComment('🌰🌰🌰', 2)).toBe('🌰🌰');
    expect(fitComment('abc', 0)).toBe('');
  });
  it('builds rss::payment comments', () => {
    expect(rssPaymentComment({ url: 'https://x.co/ep', message: 'Great!', senderName: 'sam' })).toBe('rss::payment::boost https://x.co/ep sam: Great!');
    expect(rssPaymentComment({ url: 'https://x.co' })).toBe('rss::payment::boost https://x.co');
  });
  it('reads bolt11 amounts', () => {
    expect(bolt11AmountSats('lnbc210n1p4')).toBe(21);
    expect(bolt11AmountSats('lnbc2500u1p4')).toBe(250000);
    expect(bolt11AmountSats('lnbc1m1p4')).toBe(100000);
    expect(bolt11AmountSats('lntbs10n1p4')).toBe(1);
    expect(bolt11AmountSats('lnbc15p1p4')).toBeNull();
    expect(bolt11AmountSats('lnbc1pvjluez')).toBeNull();
  });
});
