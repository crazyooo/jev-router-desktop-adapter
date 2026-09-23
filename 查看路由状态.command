#!/bin/zsh
set -eu
TASK_ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${JEV_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  printf '%s\n' '未找到 Node.js，请在终端运行 node scripts/manage.mjs status。'
  read -r
  exit 1
fi
"$NODE_BIN" "$TASK_ROOT/scripts/manage.mjs" status
printf '\n按回车关闭。'
read -r
