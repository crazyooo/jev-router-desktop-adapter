# Verification

## Reference environment

- macOS on Apple Silicon
- Codex desktop bundled core `0.155.0-alpha.9.2`
- Node.js `24.20.0`
- `jev-router@0.3.0`
- `@typesafe-ai/sdk@0.6.0`

## Automated coverage

The test suite covers:

- catalog injection without hiding manual model choices;
- per-turn routing, deduplication, and tool-continuation pinning;
- concurrent task and account isolation;
- manual overrides and Jev failure fallback;
- finite routing deadlines and cancellation propagation;
- metadata-only persistence, retention bounds, and failed-write rollback;
- Responses Lite compatibility filtering;
- active and shadow mode behavior;
- ChatGPT subscription authentication requirements;
- reversible, conflict-aware Codex configuration edits.

Run:

```bash
npm ci --ignore-scripts --prefix upstream
npm test
```

## Live integration coverage

The live harness has verified:

- model discovery through the desktop app's bundled Codex core;
- a successful first-turn Jev decision and model rewrite;
- parallel tasks with independent decisions;
- a real tool call and continuation pinned to one model;
- manual model passthrough;
- interruption and cancellation propagation;
- service restart during a tool loop with persisted routing state;
- actual provider rollback followed by a successful direct request;
- LaunchAgent crash recovery without state loss.

Run the live suite only on a test configuration. It consumes model quota and Jev decisions:

```bash
node scripts/live-core.mjs --full
```

## Boundaries

- Native model-selector rendering is not covered by automated UI tests.
- Physical sleep/wake and a real logout/login have not been exercised.
- Codex desktop internals are not a stable public API and may require future compatibility changes.
- Third-party relay services and custom model providers are not supported.
