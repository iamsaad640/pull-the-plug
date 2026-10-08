import http from 'node:http';
import { createProxy } from './proxy.js';
import { runExperiment } from './runner.js';

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }

export async function runDemo(fault = { type: 'unavailable' }) {
  const provider = await serve((req, res) => json(res, 200, { answer: 'A useful answer from the mock provider.' }));
  let proxy;
  let app;
  try {
    proxy = await createProxy({ upstream: provider.url });
    app = await serve(async (req, res) => {
      if (req.url === '/health') return json(res, 200, { ok: true });
      try {
        const response = await fetch(proxy.url + '/answer', { signal: AbortSignal.timeout(250) });
        if (!response.ok) throw new Error('Provider unavailable');
        const answer = await response.json();
        json(res, 200, { ok: true, source: 'provider', answer: answer.answer });
      } catch {
        if (req.url === '/with-fallback') json(res, 200, { ok: true, source: 'local-fallback', answer: 'A cached answer.' });
        else json(res, 502, { ok: false });
      }
    });
    return await runExperiment({
      name: 'One provider down. What still works?', fault, proxy,
      checks: [
        { name: 'AI answer with local fallback', url: app.url + '/with-fallback', jsonEquals: { ok: true } },
        { name: 'AI answer without fallback', url: app.url + '/without-fallback', jsonEquals: { ok: true } },
        { name: 'App health', url: app.url + '/health', jsonEquals: { ok: true } }
      ]
    });
  } finally {
    if (app) await app.close();
    if (proxy) await proxy.close();
    await provider.close();
  }
}
