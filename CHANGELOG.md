# Changes

## 0.2.0 — 2026-09-23

### Fixed

- **Jev decisions never succeeded on a slow network.** The SDK request timeout was hardcoded to 1500 ms and the turn deadline to 3000 ms, but a decision measures ~2.5–3.0 s on this machine, so every call fell back with `jev-unavailable/no-change` and routing silently degraded to the previous model. The SDK timeout is now derived from the deadline (`deadline - 2000 ms`, floor 1000) and both default to 8000 ms, configurable with `JEV_DESKTOP_DEADLINE_MS`.
- **The managed provider claimed to need OpenAI credentials it does not have.** `requires_openai_auth` was hardcoded to `true`, which is wrong once the backend is a relay carrying its own bearer token. It is now derived from the resolved backend, so a relay is `false` and the ChatGPT subscription endpoint stays `true`. `scripts/live-core.mjs` derives it the same way instead of overriding it.
- **Routing picked a model the backend does not serve.** The local fallback catalog is used whenever a backend exposes no readable `/models` (relays commonly implement `/responses` only), and it listed `gpt-5.6-luna`, which the relay rejects with `model_not_found`. The catalog is now pinnable with `JEV_DESKTOP_FALLBACK_MODELS`, and the fast tier can be repointed with `JEV_CODEX_FAST_MODEL`.
- `~/.jev-router.env` now supplies any `JEV_*`/`TYPESAFE_*` key, not just a fixed whitelist, so tier overrides and the catalog pin reach the serving process.

### Added

- An opt-in shadow mode: Jev is still asked on every routable turn, but a fixed baseline model executes and the would-be route is recorded next to it.
- `manage.mjs mode [active|shadow] [baseline-model]`, which reports both the configured and the running value and restarts the service; the setting persists in `~/.jev-router.env`. Mode was deliberately not folded into the plist so no LaunchAgent rewrite is needed.
- `/healthz` and the startup log entry now report `mode`, `shadowBaseline` and `deadlineMs`.
- Shadow decisions keep the executed model in `model` so the session and the next turn's `current_model` stay truthful; the proposal is carried in `wouldBe`, `wouldBeReason` and `wouldBeConfidence`.
- Added public installation, security, contribution, verification, licensing, third-party notice, environment example and GitHub Actions documentation.
- LaunchAgent installation now records the current Node executable instead of relying on a machine-specific path.

## 0.1.0 — 2026-09-22

- Added a loopback standalone adapter for the Codex desktop core with authenticated catalog forwarding.
- Preserved Jev's selection policy, added request-protocol filtering and fresh-session cache handling.
- Added per-account/task/turn pinning, deduplication and atomic metadata-only persistence.
- Added cancellation propagation, finite routing deadline, no API-billing fallback and bounded logs.
- Added launchd startup, reversible scoped config changes, status and restore entry points.
- Added unit/integration tests and live app-server verification; no Codex app bundle or CLI wrapper modifications.
