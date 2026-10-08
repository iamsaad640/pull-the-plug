import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

export function validateChecks(checks) {
  if (!Array.isArray(checks) || !checks.length) throw new Error('At least one check is required.');
  const names = new Set();
  for (const check of checks) {
    if (!check || typeof check !== 'object') throw new Error('Every check must be an object.');
    if (typeof check.name !== 'string' || !check.name.trim() || names.has(check.name)) throw new Error('Check names must be nonempty and unique.');
    names.add(check.name);
    const url = new URL(check.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Check URL must use HTTP(S) without credentials.');
    if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 60000)) throw new Error('Check timeoutMs must be between 1 and 60000.');
    if (check.maxResponseBytes !== undefined && (!Number.isInteger(check.maxResponseBytes) || check.maxResponseBytes < 1 || check.maxResponseBytes > 10485760)) throw new Error('maxResponseBytes must be between 1 and 10485760.');
    const statuses = check.statuses ?? [200];
    if (!Array.isArray(statuses) || !statuses.length || statuses.some(n => !Number.isInteger(n) || n < 100 || n > 599)) throw new Error('statuses must be HTTP status codes.');
    if (check.jsonEquals !== undefined && (check.jsonEquals === null || typeof check.jsonEquals !== 'object' || Array.isArray(check.jsonEquals))) throw new Error('jsonEquals must be an object mapping dot paths to expected values.');
  }
}

async function readBody(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        const error = new Error('Response exceeded the configured size limit');
        error.name = 'ResponseTooLarge';
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

async function runCheck(check) {
  const start = performance.now();
  try {
    const response = await fetch(check.url, {
      method: check.method ?? 'GET',
      headers: check.headers,
      body: check.body === undefined ? undefined : (typeof check.body === 'string' ? check.body : JSON.stringify(check.body)),
      redirect: 'error',
      signal: AbortSignal.timeout(check.timeoutMs ?? 3000)
    });
    // Consume the body within the timeout so a stalled stream cannot pass.
    const body = await readBody(response, check.maxResponseBytes ?? 1048576);
    const reasons = [];
    if (!(check.statuses ?? [200]).includes(response.status)) reasons.push(`Unexpected HTTP ${response.status}`);
    if (check.jsonEquals) {
      try {
        const data = JSON.parse(body);
        for (const [path, expected] of Object.entries(check.jsonEquals)) {
          const actual = path.split('.').reduce((value, key) => value?.[key], data);
          if (!isDeepStrictEqual(actual, expected)) reasons.push(`JSON assertion failed: ${path}`);
        }
      } catch { reasons.push('Response is not valid JSON'); }
    }
    return { name: check.name, pass: reasons.length === 0, status: response.status, durationMs: Math.round(performance.now() - start), reasons };
  } catch (error) {
    return { name: check.name, pass: false, status: null, durationMs: Math.round(performance.now() - start), reasons: [error.name === 'TimeoutError' ? 'Check timed out' : error.name === 'ResponseTooLarge' ? 'Response exceeded size limit' : 'Request failed'] };
  }
}

export async function runExperiment({ name, checks, fault, proxy }) {
  validateChecks(checks);
  // Validate a fault before executing any checks.
  proxy.setFault(fault);
  proxy.setFault({ type: 'none' });
  const phases = [];
  try {
    for (const [phase, activeFault] of [['baseline', { type: 'none' }], ['disruption', fault], ['recovery', { type: 'none' }]]) {
      proxy.setFault(activeFault);
      proxy.resetCounters();
      const results = [];
      for (const check of checks) {
        const before = proxy.stats();
        const result = await runCheck(check);
        const after = proxy.stats();
        result.proxy = Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]]));
        results.push(result);
      }
      phases.push({ name: phase, checks: results, proxy: proxy.stats() });
    }
  } finally { proxy.setFault({ type: 'none' }); }
  const [baseline, disruption, recovery] = phases;
  const verified = disruption.proxy.injected > 0;
  const workflows = checks.map((check, i) => ({
    name: check.name,
    outcome: !baseline.checks[i].pass ? 'invalid-baseline'
      : !verified ? 'unverified'
      : !recovery.checks[i].pass ? 'recovery-failed'
      : disruption.checks[i].proxy.injected === 0 ? 'not-exercised'
      : disruption.checks[i].pass ? 'survived' : 'failed-during-disruption',
    baseline: baseline.checks[i], disruption: disruption.checks[i], recovery: recovery.checks[i]
  }));
  return {
    schemaVersion: 1, name, createdAt: new Date().toISOString(), fault,
    verified, phases, workflows,
    summary: Object.fromEntries(['survived', 'failed-during-disruption', 'recovery-failed', 'invalid-baseline', 'unverified', 'not-exercised'].map(outcome => [outcome, workflows.filter(w => w.outcome === outcome).length]))
  };
}
