import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';

const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function cleanHeaders(headers) {
  const result = { ...headers };
  const nominated = String(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase());
  for (const name of [...hopHeaders, ...nominated]) delete result[name];
  return result;
}

/** A loopback-only, fixed-upstream reverse proxy. No system network changes. */
export async function createProxy({ upstream, port = 0, upstreamTimeoutMs = 10000 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Proxy port must be an integer between 0 and 65535.');
  if (!Number.isInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1 || upstreamTimeoutMs > 60000) throw new Error('upstreamTimeoutMs must be between 1 and 60000.');
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error('Upstream must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  let fault = { type: 'none' };
  let counters = { requests: 0, injected: 0, forwarded: 0 };
  const sockets = new Set();
  const timers = new Set();
  const server = http.createServer((req, res) => {
    counters.requests++;
    const active = { ...fault };
    if (active.type !== 'none') counters.injected++;
    if (active.type === 'unavailable') {
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json', 'x-pull-the-plug': 'injected' });
      res.end(JSON.stringify({ error: 'Simulated provider unavailable' }));
      return;
    }
    if (active.type === 'timeout') {
      req.resume();
      // Deliberately send no response. Client timeout or runner cleanup closes it.
      return;
    }
    const forward = () => {
      if (res.destroyed) return;
      counters.forwarded++;
      const client = target.protocol === 'https:' ? https : http;
      const headers = cleanHeaders(req.headers);
      headers.host = target.host;
      const base = target.pathname.replace(/\/$/, '');
      // Preserve the fixed upstream origin even if the incoming path is absolute.
      const path = base + (req.url.startsWith('/') ? req.url : '/' + req.url);
      const outgoing = client.request(target, { method: req.method, path, headers }, incoming => {
        res.writeHead(incoming.statusCode, cleanHeaders(incoming.headers));
        pipeline(incoming, res, () => {});
      });
      outgoing.setTimeout(upstreamTimeoutMs, () => outgoing.destroy(new Error('Upstream timeout')));
      outgoing.on('error', () => {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end('{"error":"Upstream request failed"}');
        } else res.destroy();
      });
      res.on('close', () => outgoing.destroy());
      req.on('aborted', () => outgoing.destroy());
      pipeline(req, outgoing, () => {});
    };
    if (active.type === 'latency') {
      const timer = setTimeout(() => { timers.delete(timer); forward(); }, active.delayMs);
      timers.add(timer);
      res.on('close', () => { clearTimeout(timer); timers.delete(timer); });
    } else forward();
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    setFault(value) {
      if (!['none', 'unavailable', 'timeout', 'latency'].includes(value.type)) throw new Error('Unknown fault type.');
      if (value.type === 'latency' && (!Number.isInteger(value.delayMs) || value.delayMs < 1 || value.delayMs > 60000)) {
        throw new Error('Latency delayMs must be an integer from 1 to 60000.');
      }
      fault = { ...value };
    },
    resetCounters() { counters = { requests: 0, injected: 0, forwarded: 0 }; },
    stats() { return { ...counters }; },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
