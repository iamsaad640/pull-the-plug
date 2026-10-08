#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createProxy } from '../src/proxy.js';
import { runExperiment } from '../src/runner.js';
import { runDemo } from '../src/demo.js';
import { saveReport } from '../src/report.js';

const usage = `Pull the Plug — test what survives a provider failure.

  node bin/cli.js demo [--fault unavailable|timeout|latency] [--out reports/demo]
  node bin/cli.js init [--config experiment.json]
  node bin/cli.js run --config experiment.json [--out reports/run]

For run: start your app first and route the selected provider base URL through
the local proxy port configured in experiment.json. See README.md.
Exit codes: 0 = all verified checks survived; 1 = a workflow failed;
            2 = invalid setup, baseline, or an unobserved fault.
Demo exits 0 when it successfully demonstrates the expected failure.`;

function parse(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--fault', '--config'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid option. Use --help.');
    if (Object.hasOwn(values, args[i].slice(2))) throw new Error('Duplicate option: ' + args[i]);
    values[args[i].slice(2)] = args[i + 1];
  }
  return values;
}

let activeProxy;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  if (activeProxy) await activeProxy.close();
  process.exit(signal === 'SIGINT' ? 130 : 143);
});
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help' || args.includes('--help')) {
    console.log(usage);
  } else {
    const options = parse(args);
    const allowed = { demo: ['fault', 'out'], run: ['config', 'out'], init: ['config'] }[command];
    if (!allowed) throw new Error('Unknown command. Use --help.');
    for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`--${key} is not supported for ${command}.`);
    if (command === 'init') {
      const path = resolve(options.config ?? 'experiment.json');
      const template = await readFile(new URL('../experiment.example.json', import.meta.url), 'utf8');
      await writeFile(path, template, { flag: 'wx' });
      console.log('Created ' + path + '\nEdit the upstream and app checks, then configure your provider base URL.');
    } else {
      let report;
      if (command === 'demo') {
        const type = options.fault ?? 'unavailable';
        if (!['unavailable', 'timeout', 'latency'].includes(type)) throw new Error('Unknown demo fault.');
        report = await runDemo(type === 'latency' ? { type, delayMs: 600 } : { type });
      } else if (command === 'run') {
        if (!options.config) throw new Error('--config is required.');
        const config = JSON.parse(await readFile(resolve(options.config), 'utf8'));
        if (!config.proxy || !Number.isInteger(config.proxy.port) || config.proxy.port < 1 || config.proxy.port > 65535) throw new Error('proxy.port must be a fixed port between 1 and 65535.');
        if (!config.fault || config.fault.type === 'none') throw new Error('Configure a disruption fault.');
        activeProxy = await createProxy(config.proxy);
        console.log('Provider proxy: ' + activeProxy.url);
        try { report = await runExperiment({ name: config.name ?? 'Provider disruption', checks: config.checks, fault: config.fault, proxy: activeProxy }); }
        finally { await activeProxy.close(); activeProxy = undefined; }
      } else throw new Error('Unknown command. Use --help.');
      const files = await saveReport(report, options.out ?? `reports/${command}`);
      console.log('\n' + report.name);
      for (const workflow of report.workflows) console.log(`  ${workflow.name}: ${workflow.outcome}`);
      console.log(`\nFault observed: ${report.verified ? 'yes' : 'no'}\nHTML: ${files.html}\nJSON: ${files.json}`);
      process.exitCode = !report.verified || report.summary['invalid-baseline'] ? 2
        : command === 'demo' ? (report.summary['failed-during-disruption'] === 1 && report.summary.survived === 1 && report.summary['not-exercised'] === 1 ? 0 : 1)
        : report.summary['not-exercised'] ? 2
        : report.summary['failed-during-disruption'] || report.summary['recovery-failed'] ? 1 : 0;
    }
  }
} catch (error) {
  console.error('Pull the Plug: ' + error.message);
  if (activeProxy) await activeProxy.close();
  process.exitCode = 2;
}
