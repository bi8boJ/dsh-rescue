#!/usr/bin/env sh
# dsh-rescue launcher for macOS / Linux.
# Finds a Node.js 20+ runtime (PATH first, then anything DSH bundled), then runs the CLI.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

find_node() {
  if [ -n "${DSH_RESCUE_NODE:-}" ] && [ -x "${DSH_RESCUE_NODE}" ]; then
    printf '%s' "${DSH_RESCUE_NODE}"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    "${HOME}/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
  do
    if [ -x "${candidate}" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}

NODE_BIN=$(find_node) || {
  echo "[dsh-rescue] 找不到 node（需要 Node.js 20+）。" >&2
  echo "  安装 Node.js，或设置 DSH_RESCUE_NODE 指向 node 可执行文件。" >&2
  exit 2
}

exec "${NODE_BIN}" "${HERE}/dsh-rescue.mjs" "$@"