import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy } from '../src/proxy.js';
import { runExperiment } from '../src/runner.js';
import { runDemo } from '../src/demo.js';
import { renderReport } from '../src/report.js';

for (const fault of [{ type: 'unavailable' }, { type: 'timeout' }, { type: 'latency', delayMs: 600 }]) {
  test(`demo proves failure, fallback, and recovery for ${fault.type}`, async () => {
    const report = await runDemo(fault);
    assert.equal(report.verified, true);
    assert.equal(report.summary.survived, 1);
    assert.equal(report.summary['not-exercised'], 1);
    assert.equal(report.summary['failed-during-disruption'], 1);
    assert.equal(report.summary['recovery-failed'], 0);
    assert.ok(report.phases[1].proxy.injected >= 2);
    assert.ok(report.phases[2].checks.every(check => check.pass));
  });
}

test('a healthy endpoint that never reaches the proxy cannot establish resilience', async () => {
  const server = http.createServer((req, res) => res.end('{"ok":true}'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const proxy = await createProxy({ upstream: url });
  try {
    const report = await runExperiment({ name: 'No provider calls', proxy, fault: { type: 'unavailable' }, checks: [{ name: 'Health', url }] });
    assert.equal(report.verified, false);
    assert.equal(report.workflows[0].outcome, 'unverified');
    assert.equal(report.summary.survived, 0);
  } finally { await proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('HTTP 200 with an unusable body is an invalid baseline', async () => {
  const server = http.createServer((req, res) => res.end('{"ok":false}'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = await createProxy({ upstream: `http://127.0.0.1:${server.address().port}` });
  try {
    const report = await runExperiment({ name: 'Body assertions', proxy, fault: { type: 'unavailable' }, checks: [{ name: 'Usable answer', url: proxy.url, jsonEquals: { ok: true } }] });
    assert.equal(report.workflows[0].outcome, 'invalid-baseline');
    assert.equal(report.summary.survived, 0);
  } finally { await proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('report escapes user-controlled labels', async () => {
  const report = await runDemo();
  report.name = '<script>alert(1)</script>';
  const html = renderReport(report);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('proxy forwards method, base path, query, headers, and body', async () => {
  let captured;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { method: req.method, path: req.url, token: req.headers.authorization, body: Buffer.concat(chunks).toString() };
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = await createProxy({ upstream: `http://127.0.0.1:${server.address().port}/v1` });
  try {
    const response = await fetch(proxy.url + '/answer?mode=test', { method: 'POST', headers: { authorization: 'Bearer mock-token' }, body: 'request payload' });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(captured, { method: 'POST', path: '/v1/answer?mode=test', token: 'Bearer mock-token', body: 'request payload' });
    assert.deepEqual(proxy.stats(), { requests: 1, injected: 0, forwarded: 1 });
  } finally { await proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a persistent post-disruption failure is identified as recovery-failed', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => { calls++; res.end(JSON.stringify({ ok: calls === 1 })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = await createProxy({ upstream: `http://127.0.0.1:${server.address().port}` });
  try {
    const report = await runExperiment({ name: 'Persistent failure', proxy, fault: { type: 'unavailable' }, checks: [{ name: 'Answer', url: proxy.url, jsonEquals: { ok: true } }] });
    assert.equal(report.workflows[0].outcome, 'recovery-failed');
    assert.equal(report.summary['recovery-failed'], 1);
  } finally { await proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('closing a timeout proxy closes hanging requests and releases its port', async () => {
  const proxy = await createProxy({ upstream: 'http://127.0.0.1:1' });
  proxy.setFault({ type: 'timeout' });
  const url = new URL(proxy.url);
  const pending = fetch(proxy.url, { signal: AbortSignal.timeout(2000) }).then(() => 'unexpected', () => 'closed');
  // Wait for the request's arrival instead of relying on a fixed sleep.
  const deadline = Date.now() + 1000;
  while (!proxy.stats().requests && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(proxy.stats().requests, 1);
  await proxy.close();
  assert.equal(await pending, 'closed');
  const replacement = await createProxy({ upstream: 'http://127.0.0.1:1', port: Number(url.port) });
  await replacement.close();
});

test('oversized response fails its assertion without persisting the payload', async () => {
  const server = http.createServer((req, res) => res.end('private-payload'.repeat(100)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = await createProxy({ upstream: `http://127.0.0.1:${server.address().port}` });
  try {
    const report = await runExperiment({ name: 'Bounded response', proxy, fault: { type: 'unavailable' }, checks: [{ name: 'Answer', url: proxy.url, maxResponseBytes: 64 }] });
    assert.equal(report.workflows[0].outcome, 'invalid-baseline');
    assert.deepEqual(report.workflows[0].baseline.reasons, ['Response exceeded size limit']);
    assert.ok(!JSON.stringify(report).includes('private-payload'));
  } finally { await proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('JSON object assertions ignore key order but preserve array order and value types', async () => {
  const server = http.createServer((req, res) => res.end('{"result":{"b":2,"a":1},"items":[1,2],"count":1}'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = await createProxy({ upstream: `http://127.0.0.1:${server.address().port}` });
  try {
    const report = await runExperiment({ name: 'JSON equality', proxy, fault: { type: 'unavailable' }, checks: [
      { name: 'Object key order', url: proxy.url, jsonEquals: { result: { a: 1, b: 2 } } },
      { name: 'Array order', url: proxy.url, jsonEquals: { items: [2, 1] } },
      { name: 'Value type', url: proxy.url, jsonEquals: { count: '1' } }
    ] });
    assert.equal(report.workflows[0].baseline.pass, true);
    assert.equal(report.workflows[0].outcome, 'failed-during-disruption');
    assert.equal(report.workflows[1].outcome, 'invalid-baseline');
    assert.equal(report.workflows[2].outcome, 'invalid-baseline');
  } finally { await proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
