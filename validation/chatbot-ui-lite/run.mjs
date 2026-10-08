// Source-level validation of an external application's actual edge handler.
// No Next.js server, real provider, external network, or application bug fixes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createProxy } from '../../src/proxy.js';
import { runExperiment } from '../../src/runner.js';

const sourceRoot = new URL('./upstream/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', sourceRoot), 'utf8'));
for (const file of manifest.files) {
  const bytes = await readFile(new URL(file.path, sourceRoot));
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(sha, file.blobSha, `Upstream snapshot changed: ${file.path}`);
}
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64');
const readSource = name => readFile(new URL(name, sourceRoot), 'utf8');
const typesUrl = moduleUrl(await readSource('types.ts'));
const parserUrl = moduleUrl(await readSource('parser.ts'));
// Wire TS aliases and type-only imports; preserve function bodies byte-for-byte.
const utilsUrl = moduleUrl((await readSource('utils.ts'))
  .replace('import { Message, OpenAIModel } from "@/types";', `import { OpenAIModel } from "${typesUrl}";`)
  .replace('import { createParser, ParsedEvent, ReconnectInterval } from "eventsource-parser";', `import { createParser } from "${parserUrl}";`));
const handlerUrl = moduleUrl((await readSource('chat.ts'))
  .replace('import { Message } from "@/types";', '')
  .replace('import { OpenAIStream } from "@/utils";', `import { OpenAIStream } from "${utilsUrl}";`));
const { default: handler } = await import(handlerUrl);

const nativeFetch = globalThis.fetch;
const originalKey = process.env.OPENAI_API_KEY;
const originalError = console.error;
process.env.OPENAI_API_KEY = 'local-validation-only';
let expectedErrorLogs = 0;
console.error = () => { expectedErrorLogs++; };

const content = 'Hello from upstream.';
const healthyBody = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
const request = () => new Request('http://local.test/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
});
function routeFetch(providerFetch) {
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://api.openai.com/v1/chat/completions') return providerFetch(input, init);
    if (new URL(url).hostname !== '127.0.0.1') throw new Error('External network prohibited during validation');
    return nativeFetch(input, init);
  };
}
async function serve(fn) {
  const server = http.createServer(fn);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

const start = performance.now();
let provider;
let proxy;
let app;
let mode = 'healthy';
let providerCalls = 0;
const results = {};
try {
  // Baseline comparison: existing Node assertions with a direct fetch mock.
  let unitMode = 'healthy';
  let unitCalls = 0;
  routeFetch(async () => {
    unitCalls++;
    return unitMode === 'unavailable'
      ? new Response('{"error":"provider unavailable"}', { status: 503 })
      : new Response(healthyBody, { headers: { 'content-type': 'text/event-stream' } });
  });
  let response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), content);
  unitMode = 'unavailable';
  response = await handler(request());
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Error');
  unitMode = 'healthy';
  response = await handler(request());
  assert.equal(await response.text(), content);
  results.directMock = { baseline: 200, disruption: 500, recovery: 200, calls: unitCalls };

  // Socket-level comparison: forward the hardcoded URL in the test harness.
  provider = await serve((req, res) => {
    providerCalls++;
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(mode === 'truncated' ? healthyBody.replace('data: [DONE]\n\n', '') : healthyBody);
  });
  proxy = await createProxy({ upstream: provider.url + '/v1' });
  routeFetch((input, init) => nativeFetch(proxy.url + '/chat/completions', init));
  app = await serve(async (req, res) => {
    let reader;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const result = await handler(new Request(app.url + req.url, {
        method: req.method, headers: req.headers, body: Buffer.concat(chunks)
      }));
      if (res.destroyed) { await result.body?.cancel(); return; }
      res.writeHead(result.status, Object.fromEntries(result.headers));
      reader = result.body.getReader();
      res.on('close', () => { reader.cancel().catch(() => {}); });
      while (true) {
        const { value, done } = await reader.read();
        if (done || res.destroyed) break;
        res.write(value);
      }
      res.end();
    } catch { res.destroy(); }
  });
  const checks = [{ name: 'External chat handler', url: app.url + '/api/chat', method: 'POST', headers: { 'content-type': 'application/json' }, body: { messages: [{ role: 'user', content: 'Hello' }] }, timeoutMs: 300 }];
  const report = await runExperiment({ name: 'Chatbot UI Lite source validation', checks, fault: { type: 'unavailable' }, proxy });
  assert.equal(report.workflows[0].outcome, 'failed-during-disruption');
  assert.deepEqual(report.phases.map(p => p.checks[0].status), [200, 500, 200]);
  assert.equal(report.phases[1].proxy.injected, 1);
  results.proxy = { baseline: 200, disruption: 500, recovery: 200, injectedRequests: report.phases[1].proxy.injected, upstreamRequests: providerCalls };

  // EOF without [DONE]: actual upstream source never closes its output stream.
  mode = 'truncated';
  const truncated = await runExperiment({ name: 'Incomplete upstream stream', checks, fault: { type: 'unavailable' }, proxy });
  assert.equal(truncated.workflows[0].outcome, 'invalid-baseline');
  assert.equal(truncated.workflows[0].baseline.pass, false);
  assert.ok(truncated.workflows[0].baseline.durationMs >= 250);
  mode = 'healthy';
  const recovered = await nativeFetch(app.url + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }), signal: AbortSignal.timeout(1000) });
  assert.equal(await recovered.text(), content);
  results.truncatedStream = { outputDidNotComplete: true, observedBy: 'bounded response-body read', healthyAfterRestoration: true };
  results.scope = { actualAppFunctionBodies: true, endpointRewriteInHarness: true, fullNextApplicationStarted: false, realProviderSDKUsed: false, externalCalls: 0 };
  results.appCommit = manifest.appCommit;
  results.expectedErrorLogs = expectedErrorLogs;
  results.elapsedMs = Math.round(performance.now() - start);
  console.log(JSON.stringify(results, null, 2));
} finally {
  globalThis.fetch = nativeFetch;
  console.error = originalError;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  if (app) await app.close();
  if (proxy) await proxy.close();
  if (provider) await provider.close();
}
