// Minimal, dependency-free parser for the Podcasting 2.0 <podcast:value> block.
// Works the same in Node and the browser (no DOMParser needed).
// Spec: https://podcasting2.org/docs/podcast-namespace/tags/value

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

export function parseAttributes(tag) {
  const attrs = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1]] = decodeXmlEntities(m[3] ?? m[4] ?? '');
  return attrs;
}

function firstText(xml, tagName) {
  const re = new RegExp(`<${tagName}(\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'i');
  const m = xml.match(re);
  return m ? decodeXmlEntities(stripCdata(m[2]).trim()) : undefined;
}

/** Remove nested <item> elements so channel-level lookups don't see item data. */
function channelOnly(xml) {
  return xml.replace(/<item[\s>][\s\S]*?<\/item>/gi, '');
}

/** Parse every <podcast:value> block found in an XML fragment (not descending into items). */
export function parseValueBlocks(fragment) {
  const blocks = [];
  const re = /<podcast:value(\s[^>]*)?(\/>|>([\s\S]*?)<\/podcast:value>)/gi;
  let m;
  while ((m = re.exec(fragment))) {
    const attrs = parseAttributes(m[1] || '');
    const inner = m[3] || '';
    const recipients = [];
    const rr = /<podcast:valueRecipient(\s[^>]*?)\/?>/gi;
    let r;
    while ((r = rr.exec(inner))) {
      const a = parseAttributes(r[1] || '');
      const split = Number.parseFloat(a.split);
      recipients.push({
        name: a.name || a.address || 'recipient',
        type: (a.type || '').toLowerCase(),
        address: (a.address || '').trim(),
        split: Number.isFinite(split) && split > 0 ? split : 0,
        fee: String(a.fee).toLowerCase() === 'true',
        customKey: a.customKey,
        customValue: a.customValue,
      });
    }
    blocks.push({
      type: (attrs.type || '').toLowerCase(),
      method: (attrs.method || '').toLowerCase(),
      suggested: attrs.suggested,
      recipients,
    });
  }
  return blocks;
}

/** Choose the Lightning value block (type="lightning") out of several, if present. */
export function pickLightningBlock(blocks) {
  return blocks.find((b) => b.type === 'lightning') || null;
}

/**
 * Parse a podcast RSS feed.
 * @param {string} xml
 * @returns {{title?:string, guid?:string, link?:string, value: object|null, items: Array<{title?:string, guid?:string, link?:string, enclosure?:string, value: object|null}>}}
 */
export function parseFeed(xml) {
  if (typeof xml !== 'string' || !/<rss[\s>]|<channel[\s>]/i.test(xml)) {
    throw new Error('Not an RSS feed (no <rss> or <channel> element found)');
  }
  const channel = channelOnly(xml);
  const items = [];
  const ir = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = ir.exec(xml))) {
    const body = m[1];
    const enc = body.match(/<enclosure(\s[^>]*?)\/?>/i);
    items.push({
      title: firstText(body, 'title'),
      guid: firstText(body, 'guid'),
      link: firstText(body, 'link'),
      enclosure: enc ? parseAttributes(enc[1]).url : undefined,
      value: pickLightningBlock(parseValueBlocks(body)),
    });
  }
  return {
    title: firstText(channel, 'title'),
    guid: firstText(channel, 'podcast:guid'),
    link: firstText(channel, 'link'),
    value: pickLightningBlock(parseValueBlocks(channel)),
    items,
  };
}

/** Item-level value block overrides the channel one (per the spec). */
export function effectiveValue(feed, itemGuid) {
  if (itemGuid) {
    const item = feed.items.find((i) => i.guid === itemGuid);
    if (item?.value?.recipients?.length) return { source: 'item', item, value: item.value };
    if (item) return { source: 'channel', item, value: feed.value };
  }
  return { source: 'channel', item: undefined, value: feed.value };
}

const LNADDR = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export function isLightningAddress(s) {
  return typeof s === 'string' && LNADDR.test(s.trim());
}

/** Can a Cashu mint pay this recipient? Mints pay BOLT11 invoices, so we need an LNURL-pay target. */
export function isPayableByMint(recipient) {
  return recipient.type === 'lnaddress' && isLightningAddress(recipient.address);
}
