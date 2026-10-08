# Roadmap

The current release tests HTTP provider failures through an explicit local
proxy. The next work is guided by successful integrations and reruns.

## Next

- Validate endpoint setup with three external Node applications.
- Add runnable provider-client examples with documented retry behavior.
- Improve fault attribution when an app makes background requests.
- Add streaming-aware assertions for AI responses.
- Test interruption and long-running application retries across platforms.

## Later, if integrations justify it

- Compare saved runs and show changes after a fallback fix.
- Run multi-provider experiment matrices.
- Package a GitHub Action with a reproducible mock example.
- Add a network-isolation adapter for clients without endpoint overrides.

No automatic dependency scanner is planned for the first release. Configuration
discovery cannot establish what an application does when a provider fails.

## Release gates

Before calling the project a public beta, five developers should try it without
live help: four complete the demo in two minutes, three integrate an app in
15 minutes, and two rerun after finding an issue or verifying a real fallback.
These are proposed targets, not measured results.
