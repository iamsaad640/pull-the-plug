import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
async function invoke(args, cwd) {
  try { return { ...await exec(process.execPath, [cli, ...args], { cwd, timeout: 10000 }), code: 0 }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}

test('init creates a usable template and never overwrites an existing config', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pull-the-plug-init-'));
  try {
    assert.equal((await invoke(['init'], cwd)).code, 0);
    const path = join(cwd, 'experiment.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(config.proxy.port, 8787);
    await writeFile(path, 'keep my config');
    assert.equal((await invoke(['init'], cwd)).code, 2);
    assert.equal(await readFile(path, 'utf8'), 'keep my config');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('CLI demo succeeds, writes both reports, and omits request secrets', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pull-the-plug-demo-'));
  try {
    const result = await invoke(['demo', '--out', 'output'], cwd);
    assert.equal(result.code, 0, result.stderr);
    const reportText = await readFile(join(cwd, 'output/report.json'), 'utf8');
    const report = JSON.parse(reportText);
    assert.equal(report.summary.survived, 1);
    assert.equal(report.summary['failed-during-disruption'], 1);
    assert.equal(report.summary['not-exercised'], 1);
    assert.ok(!reportText.includes('http://'));
    assert.ok(!reportText.includes('A cached answer'));
    assert.ok((await readFile(join(cwd, 'output/report.html'), 'utf8')).includes('Fault observed at the proxy'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('CLI rejects ignored or duplicate flags and supports command help', async () => {
  assert.equal((await invoke(['demo', '--config', 'unused.json'])).code, 2);
  assert.equal((await invoke(['demo', '--out', 'one', '--out', 'two'])).code, 2);
  assert.equal((await invoke(['run', '--help'])).code, 0);
});

test('run command reports a real disrupted request and returns failure exit code', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pull-the-plug-run-'));
  const provider = http.createServer((req, res) => res.end('{"ok":true}'));
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  try {
    await writeFile(join(cwd, 'experiment.json'), JSON.stringify({
      name: 'CLI integration', proxy: { port, upstream: `http://127.0.0.1:${provider.address().port}` },
      fault: { type: 'unavailable' }, checks: [{ name: 'Answer', url: `http://127.0.0.1:${port}`, jsonEquals: { ok: true } }]
    }));
    const result = await invoke(['run', '--config', 'experiment.json'], cwd);
    assert.equal(result.code, 1, result.stderr);
    const report = JSON.parse(await readFile(join(cwd, 'reports/run/report.json'), 'utf8'));
    assert.equal(report.verified, true);
    assert.equal(report.workflows[0].outcome, 'failed-during-disruption');
    const rebound = http.createServer();
    await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => rebound.close(resolve));
  } finally {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  }
});
