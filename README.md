# Pull the Plug

[![CI](https://github.com/iamsaad640/pull-the-plug/actions/workflows/ci.yml/badge.svg)](https://github.com/iamsaad640/pull-the-plug/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Local HTTP failure tests with before, during, and after assertions.**

Pull the Plug runs your application checks with a provider working, injects a
failure, restores access, and produces a report showing what survived and what
recovered. Start with a mock AI application; then point your own provider client
at the local proxy.

Early release. No third-party dependencies. No keys or paid services needed
for the demo. Requires Node.js 22 or later; CI covers Node 22 and 24.

## Try it

```bash
git clone https://github.com/iamsaad640/pull-the-plug.git
cd pull-the-plug
npm run demo
```

Open `reports/demo/report.html`. The demo starts a mock provider and app,
runs the experiment, and closes both when done.

| Workflow | Baseline | Provider unavailable | Restored |
| --- | --- | --- | --- |
| AI answer with local fallback | Pass | Pass: local fallback | Pass |
| AI answer without fallback | Pass | Fail | Pass |
| App health | Pass | Pass: no provider call | Pass |

The health check does **not** count as survived. It never encounters the fault.
An already-failing baseline is excluded too.

Try different failures:

```bash
node bin/cli.js demo --fault timeout --out reports/timeout
node bin/cli.js demo --fault latency --out reports/latency
```

The demo exits successfully when it demonstrates the expected fallback,
failure, and recovery. Its intentionally failing workflow is not a test error.

## Test your app

Create a config:

```bash
node bin/cli.js init
```

Edit `experiment.json`: set the upstream provider, proxy port, and a check that
represents a useful application result. The template uses an AI API upstream;
change it to your provider.

Configure your application's provider client with `baseURL` set to
`http://127.0.0.1:8787`. The proxy appends incoming paths to the upstream base
path. With upstream `https://api.openai.com/v1`, `/chat/completions` becomes
`/v1/chat/completions`; don't add `/v1` twice.

Start your app in another terminal, then run:

```bash
node bin/cli.js run --config experiment.json --out reports/my-app
```

The runner starts the proxy and makes the checks. Keep the app idle until then.
When finished, restore your app's usual provider base URL. `init` never overwrites
an existing config.

Add assertions beyond HTTP 200, for example `"jsonEquals": {"ok": true}`.
See [configuration and outcomes](docs/configuration.md) for request bodies,
timeouts, response limits, and exit codes.

## What gets tested

| Fault | Behavior |
| --- | --- |
| `unavailable` | Immediate simulated HTTP 503 |
| `timeout` | No response; the client must time out |
| `latency` | Delay before forwarding the request |

Each check runs once in baseline, disruption, and recovery. Reports contain
status, elapsed time, assertion results, and observed fault counters. HTML is
self-contained; JSON is available for scripts. URLs, headers, credentials, and
response bodies are omitted from reports.

Only requests routed through the loopback proxy are affected. HTTPS upstreams
work; the local client-to-proxy connection is HTTP. This version does not change
DNS or firewalls, intercept TLS, support WebSockets, or provide browser CORS.

Fault counters use each check's time window. Background jobs and retries can
affect attribution, so use an isolated test app. Passing supplied assertions
does not establish resilience for every feature or real-world outage. Streaming
responses require completion within the check's timeout and size limit;
streaming-aware assertions are not implemented yet.

Baseline and recovery can make real provider calls and incur your normal costs.
Keep secrets in your app, outside the experiment config. The CLI prints paths
to the generated reports; use separate output directories to retain each run.

## Development and contributions

```bash
npm run check
npm test
```

Tests use local HTTP servers and mock providers. CI also generates the demo
report as a downloadable artifact. No install step or lockfile is needed while
the project has no third-party dependencies.

See [contributing](CONTRIBUTING.md) and the [roadmap](docs/roadmap.md).
Provider-client examples and reproducible integration failures are useful
first contributions.

## Related tools

This tool is useful when an application can route a provider client through a
local endpoint and you want to repeat the same checks during failure and after
restoration. The mock demo verifies the runner's behavior; it does not validate
a real SDK's retries, streaming, or fallback implementation.

[Toxiproxy](https://github.com/Shopify/toxiproxy) simulates network conditions.
[Chaos Mesh](https://github.com/chaos-mesh/chaos-mesh) provides Kubernetes chaos
experiments. Pull the Plug focuses on a small provider-testing workflow with
application assertions and a before/during/after report. It does not claim a
new failure-injection technique.

MIT licensed. The CLI is used from source and is not published to npm.
