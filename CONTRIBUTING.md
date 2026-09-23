# Contributing

Contributions are welcome, especially compatibility fixes for newer Codex desktop releases.

## Setup

```bash
git clone https://github.com/crazyooo/jev-router-desktop-adapter.git
cd jev-router-desktop-adapter
npm ci --ignore-scripts --prefix upstream
npm test
```

## Guidelines

- Keep the listener loopback-only.
- Do not log prompts, responses, tool results, authorization headers, or raw request bodies.
- Preserve manual model choices and per-turn pinning.
- Keep configuration changes reversible and conflict-aware.
- Add tests for routing, authentication, persistence, and rollback changes.
- Never include live credentials or private Codex configuration in fixtures.

Live tests consume real model usage and Jev decisions. State clearly when a pull request requires them; ordinary unit tests should remain local and deterministic.
