// A tiny in-memory Nostr relay for tests and the e2e demo (NIP-01 EVENT/REQ/CLOSE, OK, EOSE).
import { WebSocketServer } from 'ws';
import { verifyEvent } from 'nostr-tools';

const matches = (f, e) =>
  (!f.ids || f.ids.includes(e.id)) && (!f.kinds || f.kinds.includes(e.kind)) &&
  (!f.authors || f.authors.includes(e.pubkey)) && (!f.since || e.created_at >= f.since) &&
  Object.keys(f).filter((k) => k[0] === '#').every((k) => e.tags.some((t) => t[0] === k.slice(1) && f[k].includes(t[1])));

export async function startRelay({ port = 0, reject = false } = {}) {
  const events = [];
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  wss.on('connection', (ws) => {
    const subs = new Map();
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m[0] === 'EVENT') {
        const e = m[1];
        if (reject || !verifyEvent(e)) return ws.send(JSON.stringify(['OK', e?.id, false, reject ? 'blocked: test' : 'invalid: bad signature']));
        if (e.kind >= 10000 && e.kind < 20000) {
          for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === e.kind && events[i].pubkey === e.pubkey) events.splice(i, 1);
        }
        events.push(e);
        ws.send(JSON.stringify(['OK', e.id, true, '']));
        for (const c of wss.clients) for (const [id, fs] of c._subs || []) if (fs.some((f) => matches(f, e))) c.send(JSON.stringify(['EVENT', id, e]));
      } else if (m[0] === 'REQ') {
        const [, id, ...fs] = m;
        subs.set(id, fs);
        for (const e of events) if (fs.some((f) => matches(f, e))) ws.send(JSON.stringify(['EVENT', id, e]));
        ws.send(JSON.stringify(['EOSE', id]));
      } else if (m[0] === 'CLOSE') subs.delete(m[1]);
    });
    ws._subs = subs;
  });
  return { url: `ws://127.0.0.1:${wss.address().port}`, events, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}
