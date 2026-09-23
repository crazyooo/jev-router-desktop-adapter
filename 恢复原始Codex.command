#!/bin/zsh
set -eu
TASK_ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${JEV_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  printf '%s\n' '未找到 Node.js，请在终端运行 node scripts/manage.mjs disable。'
  read -r
  exit 1
fi
"$NODE_BIN" "$TASK_ROOT/scripts/manage.mjs" disable
printf '\n配置已恢复。请结束运行中的任务后重启 Codex 桌面端。代理暂时保留运行以免中断旧会话。\n按回车关闭。'
read -r
