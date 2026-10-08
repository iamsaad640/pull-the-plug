# Configuration and interpreting results

## Useful checks

HTTP status alone may hide an unusable response. Add JSON assertions that
describe a meaningful success condition in your application:

```json
{
  "name": "Search gives a usable answer",
  "url": "http://127.0.0.1:3000/api/search",
  "method": "POST",
  "headers": { "content-type": "application/json" },
  "body": { "query": "What is our refund policy?" },
  "timeoutMs": 3000,
  "statuses": [200],
  "jsonEquals": { "ok": true, "result.usable": true }
}
```

`jsonEquals` supports dot-separated property paths and deep equality.
Object key order is ignored; array order and value types must match.
Assertions apply identically in baseline, disruption, and recovery phases.
Each check runs once per phase, sequentially. Response bodies are limited to 1 MiB by default; set `maxResponseBytes` to an integer up to 10 MiB when needed. This release does not measure
answer quality, retry budgets, recovery time distributions, or load resilience.

Real provider requests happen in baseline and recovery. They may consume your
usual quota or incur normal provider charges. Keep credentials in your app;
the example contains none. The proxy forwards headers but does not persist
request bodies or credentials. Reports omit URLs, headers, and response bodies.

## Faults

| Configuration | Effect |
| --- | --- |
| `{"type":"unavailable"}` | Immediate simulated HTTP 503 |
| `{"type":"timeout"}` | No response until the client times out or cleanup closes the connection |
| `{"type":"latency","delayMs":1000}` | Wait before forwarding the request |

Only traffic explicitly routed through the proxy is affected. The upstream
is fixed by configuration; the proxy is not a general-purpose forward proxy.
The runner resets the fault after its phases and closes the proxy afterward.
It never edits system routes, DNS, firewalls, or your application files.

## Reading the results

| Outcome | Meaning |
| --- | --- |
| `survived` | Baseline, disruption, and recovery assertions passed, with an injected request observed during the disruption check window |
| `failed-during-disruption` | Baseline passed, disruption failed, and recovery passed |
| `recovery-failed` | Baseline passed but the restoration check failed |
| `invalid-baseline` | The check did not pass before disruption; no resilience conclusion |
| `unverified` | No injected requests observed anywhere in the disruption phase |
| `not-exercised` | No injected request observed during this check's window |

Counters are temporal, not distributed traces. Unrelated background requests
can affect attribution. Use an isolated app instance without background jobs
when interpreting check-level results. Retries can outlive a check timeout;
this runner does not cancel work inside your app or drain its job queues.

The CLI writes `report.html` and `report.json` to the selected output directory,
overwriting earlier reports there. Use separate output directories to retain runs.

For `run`, exit code `0` means all checks survived an observed fault; `1` means
a workflow failed during disruption or restoration; `2` means invalid setup,
an invalid baseline, or missing fault coverage. Mixed failure and missing-coverage
runs return `2`; inspect the JSON for both. `demo` returns `0` when it demonstrates
the expected failure/fallback/no-provider-call pattern.
