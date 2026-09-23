#!/bin/bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${JEV_NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  printf '%s\n' 'Node.js was not found. Re-run: node scripts/manage.mjs install-service' >&2
  exit 1
fi
PROXY_INFO=$(/usr/sbin/scutil --proxy)
PROXY_ENABLED=$(printf '%s\n' "$PROXY_INFO" | /usr/bin/awk '/HTTPSEnable/ {print $3;exit}')
PROXY_HOST=$(printf '%s\n' "$PROXY_INFO" | /usr/bin/awk '/HTTPSProxy/ {print $3;exit}')
PROXY_PORT=$(printf '%s\n' "$PROXY_INFO" | /usr/bin/awk '/HTTPSPort/ {print $3;exit}')
if [[ "${PROXY_ENABLED:-0}" == 1 && -n "${PROXY_HOST:-}" && -n "${PROXY_PORT:-}" ]]; then
  export HTTP_PROXY="http://$PROXY_HOST:$PROXY_PORT" HTTPS_PROXY="http://$PROXY_HOST:$PROXY_PORT"
else
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
fi
export NODE_USE_ENV_PROXY=1
export NO_PROXY=127.0.0.1,localhost,::1,api.typesafe.ai,typesafe.ai,api.aicodemirror.ai
export no_proxy="$NO_PROXY"
exec "$NODE_BIN" "$TASK_ROOT/src/server.mjs"
