# Jev Router Desktop Adapter

An unofficial, local adapter that brings per-turn [Jev Router](https://github.com/gargpratyush/jev-router) model selection to the Codex desktop app on macOS.

The adapter listens only on loopback, asks Jev which available model is appropriate for the latest user turn, rewrites the model field, and forwards the request to the signed-in ChatGPT subscription endpoint used by Codex.

> This project is independent from OpenAI, TypeSafe AI, and the upstream Jev Router project. It modifies user-level Codex configuration and should be reviewed before installation.

## Highlights

- Per-turn model routing while preserving manual model selections.
- Official ChatGPT/Codex subscription upstream support.
- Stable model pinning across retries, tool continuations, and service restarts.
- Active and shadow modes for safe evaluation.
- Bounded metadata-only state and logs; no prompt or response bodies are persisted.
- Reversible Codex configuration edits with conflict detection.
- User-level LaunchAgent with login startup and crash recovery.

## Architecture

```text
Codex desktop core
    │  Responses API request (`model: jev-router`)
    ▼
127.0.0.1:43127
    ├─ latest user prompt + model catalog ──► TypeSafe Jev decision API
    └─ rewritten model request ─────────────► ChatGPT subscription endpoint
```

Jev receives the latest user prompt, current model, approximate context size, and candidate model identifiers/descriptions. The adapter does not send Jev the OpenAI authorization token or the full conversation. Secrets included in the latest prompt are still part of that prompt and would be sent to Jev.

## Requirements

- macOS with the Codex desktop app installed.
- Node.js 24.5 or newer.
- A working Codex configuration at `~/.codex/config.toml`.
- A signed-in ChatGPT account with Codex access.
- A Jev/TypeSafe API key.

The desktop app and Codex configuration formats can change. The adapter is tested against the versions listed in [VERIFICATION.md](VERIFICATION.md), but compatibility is not guaranteed for future releases.

## Install

```bash
git clone https://github.com/crazyooo/jev-router-desktop-adapter.git
cd jev-router-desktop-adapter
npm ci --ignore-scripts --prefix upstream
printf 'JEV_API_KEY=%s\n' 'replace-me' > ~/.jev-router.env
chmod 600 ~/.jev-router.env
node scripts/manage.mjs install-service
node scripts/manage.mjs enable
```

Restart the Codex desktop app after enabling the provider. New tasks should default to **Jev Router**. Existing tasks may retain their previous provider or concrete model until explicitly changed.

The LaunchAgent records the Node executable used during installation, so it does not depend on an interactive shell or a particular Node version manager.

## Daily use

```bash
node scripts/manage.mjs status
node scripts/manage.mjs mode
node scripts/manage.mjs mode shadow gpt-5.6-terra
node scripts/manage.mjs mode active
node scripts/manage.mjs restart
```

Selecting a concrete model passes that choice through unchanged. Selecting **Jev Router** enables automatic routing again. A turn's retries and tool continuations remain pinned to the same chosen model.

The two `.command` files in the repository provide Finder-friendly shortcuts for status and rollback on macOS.

## Routing modes

### Active

Jev's chosen model executes. If Jev is unavailable or times out, the adapter keeps the previous available model, or uses the configured strong default on a fresh task.

### Shadow

Jev is queried, but a fixed baseline model executes. Status records show both the proposed model and the model that actually ran. Use this mode to evaluate routing quality without handing execution control to Jev.

```bash
node scripts/manage.mjs mode shadow gpt-5.6-terra
```

## Configuration

The adapter reads `JEV_*` and `TYPESAFE_*` values from `~/.jev-router.env`. See [jev-router.env.example](jev-router.env.example).

Important settings:

| Variable | Purpose | Default |
| --- | --- | --- |
| `JEV_API_KEY` | Jev/TypeSafe decision API credential | required for routing |
| `JEV_DESKTOP_MODE` | `active` or `shadow` | `active` |
| `JEV_DESKTOP_BASELINE` | Model executed in shadow mode | strong default |
| `JEV_DESKTOP_DEADLINE_MS` | Maximum routing-decision time | `8000` |
| `JEV_CODEX_FAST_MODEL` | Override the fast-tier model mapping | upstream default |
| `JEV_ALLOW_FABLE` | Permit the long-context tier | disabled |

The adapter intentionally does not support third-party relay services or custom model providers. It performs no protocol conversion or model-name translation and only forwards Codex Responses API traffic to the official ChatGPT subscription endpoint.

## Data and privacy

- Listener: `127.0.0.1:43127`; browser Origin requests and non-local Host headers are rejected.
- State: `~/Library/Application Support/jev-router-desktop/state.json`.
- Logs: `~/Library/Logs/jev-router-desktop/events.jsonl`.
- Rollback manifest: `~/Library/Application Support/jev-router-desktop/installation.json`.
- Task and account identifiers are hashed.
- State stores model, reason, confidence, timing, and bounded task/turn identifiers only.
- Logs do not store prompts, tool results, authorization headers, or raw request bodies.
- The service never retries a model response request or replays a tool invocation.

Review [SECURITY.md](SECURITY.md) before using the adapter with sensitive work.

## Disable and remove

Restore the previous Codex provider and model:

```bash
node scripts/manage.mjs disable
```

Restart the Codex desktop app, wait for active tasks to finish, then unload the service:

```bash
node scripts/manage.mjs stop
```

The service plist and metadata are retained for recovery. Running `install-service` enables startup again.

## Development

```bash
npm ci --ignore-scripts --prefix upstream
npm test
```

The live suite exercises the bundled Codex core and consumes normal model usage plus a small number of Jev decisions:

```bash
node scripts/live-core.mjs --full
```

## Upstream provenance

The `upstream/` directory preserves selected source files from `jev-router@0.3.0`, licensed under MIT. The adapter also uses `@typesafe-ai/sdk@0.6.0`, licensed under MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT — see [LICENSE](LICENSE).
