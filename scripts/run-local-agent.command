#!/bin/zsh
set -euo pipefail
umask 077

script_dir="${0:A:h}"
project_dir="${script_dir:h}"
user_name="$(id -un)"
user_dir="${HOME:-$(dscl . -read "/Users/${user_name}" NFSHomeDirectory | awk '{print $2}')}"
runtime_dir="${ZHITAI_RUNTIME_ROOT:-${user_dir}/.local/share/zhitai-runtime}"
path_node="$(command -v node 2>/dev/null || true)"

node_candidates=(
  "${ZHITAI_NODE_BIN:-}"
  "${runtime_dir}/bin/node"
  "${path_node}"
  "/opt/homebrew/bin/node"
  "/usr/local/bin/node"
  "/usr/bin/node"
)

for node_binary in "${node_candidates[@]}"; do
  if [[ -x "${node_binary}" ]]; then
    cd "${project_dir}"
    # 本地节点是文件传输助手的常驻接收端。阻止 Mac 因空闲进入系统睡眠；
    # 合上笔记本上盖仍会由 macOS 挂起，全天接收时需保持上盖打开并接电。
    exec /usr/bin/caffeinate -i "${node_binary}" "${project_dir}/local-agent/server.mjs"
  fi
done

print -u2 "未找到 Node.js 22+。请安装 Node.js，或通过 ZHITAI_NODE_BIN 指定可执行文件。"
exit 1
