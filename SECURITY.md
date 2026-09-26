# Security policy

## Reporting

Please report suspected vulnerabilities privately through GitHub's security advisory feature. Do not include live API keys, access tokens, prompts, or private Codex configuration in a public issue.

## Trust boundary

This adapter runs as the current macOS user and can read:

- the Jev key stored in `~/.jev-router.env`;
- the Codex configuration in `~/.codex/config.toml` during setup and rollback;
- incoming Codex request headers and request bodies needed for routing and forwarding.

The local listener accepts only loopback Host values and rejects browser Origin requests. It is not designed to be exposed on a LAN or the public internet.

The adapter sends the latest user prompt, current model, approximate context size, and candidate model metadata to Jev. It does not intentionally send authorization headers or the full conversation to Jev. Do not place secrets in prompts if they must not leave the model backend's trust boundary.

## Credential handling

- Keep `~/.jev-router.env` mode `0600`.
- Never commit that file or a real ChatGPT/Codex credential.
- Review `git diff --cached` before publishing changes.
- Rotate any credential that appears in logs, screenshots, issues, or Git history.
