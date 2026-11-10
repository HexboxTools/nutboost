import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFeed, parseValueBlocks, effectiveValue, isPayableByMint, decodeXmlEntities } from '../src/feed.js';

const demo = readFileSync(new URL('../docs/demo-feed.xml', import.meta.url), 'utf8');

describe('parseFeed', () => {
  it('reads channel and item value blocks', () => {
    const f = parseFeed(demo);
    expect(f.title).toBe('Nutboost Demo Cast');
    expect(f.guid).toBe('6c0d1f3e-2f6e-5a3b-9a1e-6e7574626f6f');
    expect(f.value.recipients.map((r) => r.split)).toEqual([60, 30, 10]);
    expect(f.items).toHaveLength(2);
    expect(f.items[0].value.recipients.map((r) => r.name)).toEqual(['Host', 'Guest', 'Keysend-only guest']);
    expect(f.items[1].value).toBeNull();
  });
  it('channel lookups ignore item-level tags', () => {
    const xml = `<rss><channel><item><title>Ep</title><podcast:value type="lightning"><podcast:valueRecipient type="lnaddress" address="a@b.co" split="1"/></podcast:value></item><title>Show</title></channel></rss>`;
    const f = parseFeed(xml);
    expect(f.title).toBe('Show');
    expect(f.value).toBeNull();
    expect(f.items[0].value.recipients[0].address).toBe('a@b.co');
  });
  it('item block overrides channel; missing item falls back to channel', () => {
    const f = parseFeed(demo);
    expect(effectiveValue(f, 'nutboost-demo-ep1').source).toBe('item');
    expect(effectiveValue(f, 'nutboost-demo-ep0').source).toBe('channel');
    expect(effectiveValue(f, undefined).value.recipients[0].split).toBe(60);
  });
  it('handles CDATA titles, entities, single quotes and fee flags', () => {
    const xml = `<rss><channel><title><![CDATA[Tom & Jerry's Show]]></title>
      <podcast:value type='lightning' method='lnaddress'>
        <podcast:valueRecipient name="A &amp; B" type="lnaddress" address="x@y.com" split="95"></podcast:valueRecipient>
        <podcast:valueRecipient name='App' type='lnaddress' address='app@y.com' split='5' fee='true' />
      </podcast:value></channel></rss>`;
    const f = parseFeed(xml);
    expect(f.title).toBe("Tom & Jerry's Show");
    expect(f.value.recipients[0].name).toBe('A & B');
    expect(f.value.recipients[1].fee).toBe(true);
  });
  it('prefers the lightning block when several value blocks exist', () => {
    const b = parseValueBlocks(`<podcast:value type="hive"><podcast:valueRecipient type="account" address="h" split="1"/></podcast:value><podcast:value type="lightning"><podcast:valueRecipient type="node" address="02ab" split="1"/></podcast:value>`);
    expect(b).toHaveLength(2);
    const f = parseFeed(`<rss><channel>${'<podcast:value type="hive"></podcast:value><podcast:value type="lightning"><podcast:valueRecipient type="node" address="02ab" split="1"/></podcast:value>'}</channel></rss>`);
    expect(f.value.type).toBe('lightning');
  });
  it('rejects non-RSS input', () => {
    expect(() => parseFeed('<html></html>')).toThrow(/Not an RSS feed/);
  });
  it('decodes numeric entities', () => {
    expect(decodeXmlEntities('&#x1F330; &#65;')).toBe('🌰 A');
  });
  it('knows what a mint can pay', () => {
    expect(isPayableByMint({ type: 'lnaddress', address: 'me@getalby.com' })).toBe(true);
    expect(isPayableByMint({ type: 'node', address: '03ab' })).toBe(false);
    expect(isPayableByMint({ type: 'lnaddress', address: 'not-an-address' })).toBe(false);
  });
});
