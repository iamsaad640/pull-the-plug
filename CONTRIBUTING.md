# Contributing

Start with a reproducible failure case, an integration example, or a usability
issue. For a larger feature, open an issue describing the application and the
experiment you want to run before adding a new abstraction.

## Local development

Use Node.js 22 or 24. The project has no third-party dependencies.

```bash
git clone https://github.com/iamsaad640/pull-the-plug.git
cd pull-the-plug
npm run check
npm test
npm run demo
```

Keep changes focused. Add a test when behavior changes: exercise the local
proxy and an actual HTTP request where possible. Tests must not require real
provider credentials, external networks, or paid services.

## Invariants

- An invalid baseline cannot count as a successful resilience test.
- A check without an observed fault cannot count as survived.
- Recovery has its own assertions and outcome.
- The proxy uses one explicit upstream and binds to loopback only.
- Cleanup releases timers, sockets, and the listening port.
- Reports exclude URLs, headers, credentials, and response bodies.
- Limitations must be documented alongside new integrations.

Please include what changed, why, and how you tested it in a pull request.
Do not commit generated reports, local experiment configs, or credentials.
