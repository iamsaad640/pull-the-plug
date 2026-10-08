# Chatbot UI Lite source-level validation

Run from the repository root with Node.js 24:

```bash
npm run validate:external
```

No install, API key, paid provider, or external network call is required. Node's
TypeScript stripping API may print an experimental warning.

The harness invokes the original chat handler, OpenAIStream function, and SSE
parser from the pinned sources in `upstream/manifest.json`. It verifies their
Git blob hashes before running. Original MIT license texts are included.
Import aliases and type-only imports are adapted to load the source in Node;
application function bodies are preserved. The hardcoded OpenAI URL is routed
by a test-only fetch wrapper, because this app has no endpoint setting there.

It compares a direct fetch mock with a local provider, proxy, and HTTP adapter:
both produce successful baseline, HTTP 500 during provider unavailability,
and successful recovery. It also verifies that EOF without an SSE `[DONE]`
leaves this snapshot's output stream incomplete and that a bounded body read
detects it. The mock provider creates that incomplete stream; the proxy does
not implement stream truncation.

This does not start Next.js, exercise a real provider SDK, reproduce browser
behavior, establish an upstream bug's novelty, or measure developer setup time.
See [the assessment](../../docs/validation.md) for findings and alternatives.
