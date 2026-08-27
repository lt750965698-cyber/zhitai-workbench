#!/bin/zsh
set -euo pipefail

# 织台 MVP v0.1 一键启动（双击可用）
# 只做四件事：探测已在线服务 → 离线才后台启动 → 最多等待 15 秒 → 打开内容库。
# 织台页面识别：HTML 必须包含「织台 · 内容自动化工作台」或 workbench-shell，
# 任何 200 响应（如 3000 上的 WeChat Decrypt API）都不会被当作织台。
# 不安装、不部署、不修改 LaunchAgent；不占用/不停止其他服务；不在已在线时重复启动。

script_dir="${0:A:h}"
project_dir="${script_dir:h}"
home_dir="${HOME:-$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')}"
log_dir="${home_dir}/Library/Logs"
agent_log="${log_dir}/zhitai-mvp-agent.log"
ui_log="${log_dir}/zhitai-mvp-ui.log"

agent_url="http://127.0.0.1:17890/health"

# 织台页面标记（两者命中其一即认为“这是织台页面”）
zhitai_markers=("织台 · 内容自动化工作台" "workbench-shell")

mkdir -p "${log_dir}"

log_line() {
  print "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$1"
}

is_online() {
  /usr/bin/curl --fail --silent --max-time 1 "$1" >/dev/null 2>&1
}

# 判断某端口是否是真正的织台页面（内容校验，不看状态码）
is_zhitai_page() {
  local port="$1"
  local body
  body="$(/usr/bin/curl --silent --max-time 1 "http://localhost:${port}/" 2>/dev/null || true)"
  [[ -z "${body}" ]] && return 1
  local marker
  for marker in "${zhitai_markers[@]}"; do
    if print -r -- "${body}" | /usr/bin/grep -qF -- "${marker}"; then
      return 0
    fi
  done
  return 1
}

# 扫描 3000..3010，返回第一个织台页面端口；找不到返回空
scan_zhitai_port() {
  local port
  for port in {3000..3010}; do
    if is_zhitai_page "${port}"; then
      print "${port}"
      return 0
    fi
  done
  return 1
}

print "织台 MVP 一键启动"
print "项目目录：${project_dir}"

# 1) 定位 node（与 run-local-agent.command 相同的候选顺序）
node_bin=""
path_node="$(command -v node 2>/dev/null || true)"
node_candidates=(
  "${ZHITAI_NODE_BIN:-}"
  "${home_dir}/.local/share/zhitai-runtime/bin/node"
  "${path_node}"
  "/opt/homebrew/bin/node"
  "/usr/local/bin/node"
  "/usr/bin/node"
)
for candidate in "${node_candidates[@]}"; do
  if [[ -x "${candidate}" ]]; then
    node_bin="${candidate}"
    break
  fi
done
if [[ -z "${node_bin}" ]]; then
  path_node="$(command -v node 2>/dev/null || true)"
  if [[ -n "${path_node}" && -x "${path_node}" ]]; then
    node_bin="${path_node}"
  fi
fi
if [[ -n "${node_bin}" ]]; then
  # 让 npm 的 #!/usr/bin/env node 能解析到同一套 node
  export PATH="${node_bin:h}:${PATH}"
fi

# 2) 本地节点 127.0.0.1:17890：健康探测保持不变，已在线绝不重复启动
agent_started=0
if is_online "${agent_url}"; then
  print "· 本地节点已在线（${agent_url}），跳过启动"
else
  print "· 本地节点离线，正在后台启动 run-local-agent.command …"
  log_line "${agent_log}" "start-mvp：本地节点离线，启动 run-local-agent.command"
  nohup "${script_dir}/run-local-agent.command" >>"${agent_log}" 2>&1 &
  agent_started=1
fi

# 3) 织台页面：先扫描 3000..3010；找到真实织台才跳过启动，否则后台 npm run dev 再扫
zhitai_port=""
zhitai_port="$(scan_zhitai_port || true)"
if [[ -n "${zhitai_port}" ]]; then
  print "· 已在 localhost:${zhitai_port} 找到织台页面，跳过页面启动"
else
  npm_bin="$(command -v npm 2>/dev/null || true)"
  if [[ -z "${npm_bin}" || ! -x "${npm_bin}" ]]; then
    for candidate in \
      "${ZHITAI_NPM_BIN:-}" \
      "${home_dir}/.local/share/zhitai-runtime/bin/npm" \
      "/opt/homebrew/bin/npm" \
      "/usr/local/bin/npm"; do
      if [[ -x "${candidate}" ]]; then
        npm_bin="${candidate}"
        break
      fi
    done
  fi
  if [[ -z "${npm_bin}" ]]; then
    print "✗ 未找到 npm。请安装 Node.js 22+，或通过 ZHITAI_NPM_BIN 指定 npm。"
    exit 1
  fi
  print "· localhost:3000–3010 未发现织台页面，正在后台启动 npm run dev …"
  log_line "${ui_log}" "start-mvp：未发现织台页面，使用 ${npm_bin} run dev 启动"
  (cd "${project_dir}" && nohup "${npm_bin}" run dev >>"${ui_log}" 2>&1 &)
  # 最多 15 秒内反复扫描 3000..3010
  deadline=$((SECONDS + 15))
  while ((SECONDS < deadline)); do
    zhitai_port="$(scan_zhitai_port || true)"
    if [[ -n "${zhitai_port}" ]]; then
      break
    fi
    sleep 0.5
  done
fi

# 4) 找到真实织台 → 打开对应端口的内容库；完全找不到才提示失败
if [[ -n "${zhitai_port}" ]]; then
  open_url="http://localhost:${zhitai_port}/?view=library&mvp=1"
  print "✓ 织台已就绪（localhost:${zhitai_port}），正在打开内容库…"
  open "${open_url}"
  print "提示：服务在后台继续运行。日志：${agent_log}、${ui_log}"
  exit 0
fi

print "✗ 15 秒内未在 localhost:3000–3010 找到织台页面："
print "  - 其他服务（如 3000 上的 WeChat Decrypt API）即使返回 200 也不会被当作织台；"
print "  - 页面日志：${ui_log}"
print "  - 请确认已在本项目目录执行过 npm install（node_modules 是否完整），再双击本脚本。"
if ! is_online "${agent_url}"; then
  print "  - 本地节点也未响应 ${agent_url}：查看 ${agent_log}，或手动运行 ${script_dir}/run-local-agent.command"
fi
print "请按上面提示处理后，再次双击本脚本。"
exit 1
