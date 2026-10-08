# Engineering priorities

Feature expansion is paused following the [external validation](validation.md).
The tested handler did not demonstrate an advantage over a direct mock, and
existing AIMock tooling already provides test-runner integration and faults.
Do not add another test-helper API without demonstrating an unmet need.

The current implementation can inject HTTP faults and compare assertions
across baseline, disruption, and restoration. The mock app verifies that
mechanism. It does not establish that the workflow is useful for real clients.

## Validate one real integration

Use an application with an actual provider SDK and a configurable base URL.
Document the client's version, timeouts, retries, and the application's fallback.
A useful experiment must identify:

- The request that encountered the injected fault.
- Whether the user's operation completed with an acceptable result.
- Whether retry activity continued after the check finished.
- Whether restoring the provider restored normal behavior.

Record the config and reproduction steps. If routing a real client through the
proxy is harder than using an existing tool and test runner, revise the approach
before extending it.

## Known limits that affect conclusions

| Limit | Engineering question |
| --- | --- |
| Fault counts use time windows | How can a check be tied to its own provider requests when background work is active? |
| Checks run once per phase | Which retry and state effects persist into the next phase? |
| The restoration check runs immediately | Can the app recover after a stuck request, exhausted pool, or open circuit? |
| Responses are buffered within a size limit | How should a streaming check distinguish a partial answer from a completed result? |
| Assertions describe app responses | Which conditions establish that a fallback result is usable? |

These are concrete gaps to investigate, not promises that the current tool
already solves them. Add capabilities when a reproducible integration requires
them. An independent rerun after an application fix is stronger evidence of
usefulness than demo views or repository stars.
