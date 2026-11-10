import { describe, it, expect } from 'vitest';
import { diagnoseRecipient, diagnoseFeed } from '../src/doctor.js';
import { parseFeed } from '../src/feed.js';

const feedXml = (recips) => `<rss><channel><title>T</title><podcast:value type="lightning" method="keysend">${recips}</podcast:value><item><title>e</title><guid>g</guid></item></channel></rss>`;

describe('doctor', () => {
  it('flags keysend, null and valid recipients', () => {
    expect(diagnoseRecipient({ type: 'lnaddress', address: 'a@b.com' })).toMatchObject({ ok: true, route: 'lightning' });
    expect(diagnoseRecipient({ type: 'node', address: '03' + 'a'.repeat(64) })).toMatchObject({ ok: false, problem: 'keysend' });
    expect(diagnoseRecipient({ type: 'node', address: 'null' })).toMatchObject({ ok: false, problem: 'broken' });
    expect(diagnoseRecipient({ type: 'lnaddress', address: 'nope' })).toMatchObject({ ok: false, problem: 'broken' });
  });
  it('computes share and fixes', async () => {
    const feed = parseFeed(feedXml(`<podcast:valueRecipient name="A" type="node" address="03${'b'.repeat(64)}" split="75"/><podcast:valueRecipient name="B" type="lnaddress" address="b@x.com" split="25"/><podcast:valueRecipient name="App" type="lnaddress" address="f@x.com" split="1" fee="true"/>`));
    const d = await diagnoseFeed(feed);
    expect(d.verdict).toBe('partly-payable');
    expect(d.share).toBeCloseTo(0.25);
    expect(d.fixes.join(' ')).toMatch(/Lightning address/);
  });
  it('live mode marks an unreachable lnaddress', async () => {
    const feed = parseFeed(feedXml(`<podcast:valueRecipient name="B" type="lnaddress" address="b@x.com" split="100"/>`));
    const d = await diagnoseFeed(feed, { live: true, fetch: async () => ({ ok: false, status: 404 }) });
    expect(d.verdict).toBe('not-payable');
    expect(d.rows[0].problem).toBe('unreachable');
  });
  it('reports a feed with no value block', async () => {
    const d = await diagnoseFeed(parseFeed('<rss><channel><title>x</title></channel></rss>'));
    expect(d.verdict).toBe('no-value-block');
  });
});
