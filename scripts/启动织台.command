#!/bin/zsh
set -euo pipefail

# 织台 V1 统一启动器（Finder 双击可用）
# 一次启动/检查：本地节点 17890、织台页面、ai-goofish 8000、xianyu-auto-reply 18090、
#              本机受管补充采集 5200、视频分析代理 17900；MatrixMedia 由可选外置 CLI 调用。
# 规则：单项失败只标红并给可读原因，不阻断其他项；绝不启动/占用/停止 3000。

script_dir="${0:A:h}"
project_dir="${script_dir:h}"
home_dir="${HOME:-$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')}"
log_dir="${home_dir}/Library/Logs"
mkdir -p "${log_dir}"

agent_log="${log_dir}/zhitai-launcher-agent.log"
ui_log="${log_dir}/zhitai-launcher-ui.log"
goofish_log="${log_dir}/zhitai-launcher-goofish.log"
reply_log="${log_dir}/zhitai-launcher-reply.log"
analyzer_log="${log_dir}/zhitai-launcher-analyzer.log"
mptools_log="${log_dir}/zhitai-launcher-mptools.log"
generator_log="${log_dir}/zhitai-launcher-generator.log"

agent_url="http://127.0.0.1:17890/health"
goofish_url="http://127.0.0.1:8000/"
reply_url="http://127.0.0.1:18090/"
mptools_url="http://127.0.0.1:5200/"
analyzer_url="http://127.0.0.1:17900/health"
generator_url="http://127.0.0.1:18080/openapi.json"

mptools_dir="${home_dir}/.local/share/zhitai-runtime/engines/wechat-mp-tools-current"
applications_dir="${ZHITAI_APPLICATIONS_DIR:-${home_dir}/Applications}"
goofish_dir="${ZHITAI_GOOFISH_ROOT:-${applications_dir}/ai-goofish-monitor}"
reply_dir="${ZHITAI_XIANYU_ROOT:-${applications_dir}/xianyu-auto-reply-fix}"
matrixmedia_binary="${home_dir}/.local/share/zhitai-runtime/engines/matrixmedia.app/Contents/MacOS/matrixmedia"
analyzer_dir="${home_dir}/.local/share/zhitai-runtime/engines/mcp-video-analyzer-current"
generator_dir="${home_dir}/.local/share/zhitai-runtime/engines/MoneyPrinterTurbo"

# 织台页面标记（内容校验，任何 200 都不算）
zhitai_markers=("织台 · 内容自动化工作台" "workbench-shell")

log_line() {
  print "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$1"
}

# HTTP 是否有响应（非 000 即算服务在线；4xx 也算活着）
is_http_up() {
  local code
  code="$(/usr/bin/curl --noproxy '*' -s -o /dev/null --max-time 1 -w '%{http_code}' "$1" 2>/dev/null || true)"
  [[ -n "${code}" && "${code}" != "000" ]]
}

is_zhitai_page() {
  local port="$1"
  local body
  body="$(/usr/bin/curl --noproxy '*' --silent --max-time 1 "http://localhost:${port}/" 2>/dev/null || true)"
  [[ -z "${body}" ]] && return 1
  local marker
  for marker in "${zhitai_markers[@]}"; do
    if print -r -- "${body}" | /usr/bin/grep -qF -- "${marker}"; then
      return 0
    fi
  done
  return 1
}

scan_zhitai_port() {
  local port
  for port in {3000..3010}; do
    # 3000 上运行的是其他软件：即使 200 也跳过，只认织台标记
    is_zhitai_page "${port}" && { print "${port}"; return 0; }
  done
  return 1
}

red()   { print -P "%F{red}$*%f"; }
green() { print -P "%F{green}$*%f"; }
dim()   { print -P "%F{240}$*%f"; }

# 定位 node（与 run-local-agent.command 相同的候选顺序）
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
  [[ -x "${candidate}" ]] && { node_bin="${candidate}"; break; }
done
if [[ -z "${node_bin}" ]]; then
  path_node="$(command -v node 2>/dev/null || true)"
  [[ -n "${path_node}" && -x "${path_node}" ]] && node_bin="${path_node}"
fi
if [[ -n "${node_bin}" ]]; then
  export PATH="${node_bin:h}:${PATH}"
fi

print "织台 V1 一键启动（模块化，单项失败不阻断）"
print "项目目录：${project_dir}"
print

ok=0; fail=0

# ---- 1) 本地节点 17890 ----
if is_http_up "${agent_url}"; then
  green "· 本地节点       ✓ 在线（${agent_url}）"
  ok=$((ok+1))
else
  red "· 本地节点       ✗ 未响应 ${agent_url}"
  print "   → 尝试后台启动 run-local-agent.command …"
  log_line "${agent_log}" "launcher：17890 离线，启动 run-local-agent.command"
  nohup "${script_dir}/run-local-agent.command" >>"${agent_log}" 2>&1 &
  sleep 1
  if is_http_up "${agent_url}"; then
    green "  ✓ 已恢复"
    ok=$((ok+1))
  else
    red "  ✗ 仍未恢复：查看 ${agent_log}"
    red "  → 若持续失败，请运行：${script_dir}/install-local-agent.command（同步 runtime 并重启节点）"
    fail=$((fail+1))
  fi
fi

# ---- 2) 织台页面（扫描 3000..3010，内容校验；3000 视为他物） ----
zhitai_port=""
zhitai_port="$(scan_zhitai_port || true)"
if [[ -n "${zhitai_port}" ]]; then
  green "· 织台页面       ✓ 已在线 localhost:${zhitai_port}"
  ok=$((ok+1))
else
  npm_bin="$(command -v npm 2>/dev/null || true)"
  if [[ -z "${npm_bin}" || ! -x "${npm_bin}" ]]; then
    for candidate in \
      "${ZHITAI_NPM_BIN:-}" \
      "${home_dir}/.local/share/zhitai-runtime/bin/npm" \
      "/opt/homebrew/bin/npm" \
      "/usr/local/bin/npm"; do
      [[ -x "${candidate}" ]] && { npm_bin="${candidate}"; break; }
    done
  fi
  if [[ -z "${npm_bin}" ]]; then
    red "· 织台页面       ✗ 未找到 npm（请安装 Node.js 22+）"
    fail=$((fail+1))
  else
    red "· 织台页面       ✗ 3000–3010 未发现织台，后台启动 npm run dev …"
    log_line "${ui_log}" "launcher：未发现织台页面，使用 ${npm_bin} run dev 启动"
    (cd "${project_dir}" && nohup "${npm_bin}" run dev >>"${ui_log}" 2>&1 &)
    deadline=$((SECONDS + 20))
    while ((SECONDS < deadline)); do
      zhitai_port="$(scan_zhitai_port || true)"
      [[ -n "${zhitai_port}" ]] && break
      sleep 0.5
    done
    if [[ -n "${zhitai_port}" ]]; then
      green "  ✓ 织台已在 localhost:${zhitai_port}"
      ok=$((ok+1))
    else
      red "  ✗ 20 秒内未就绪：查看 ${ui_log}，并确认已执行过 npm install"
      fail=$((fail+1))
    fi
  fi
fi

# ---- 3) ai-goofish-monitor 8000 ----
if is_http_up "${goofish_url}"; then
  green "· ai-goofish     ✓ 在线（${goofish_url}）"
  ok=$((ok+1))
elif [[ -x "${goofish_dir}/.venv/bin/python" && -f "${goofish_dir}/src/app.py" ]]; then
  red "· ai-goofish     ✗ 离线，后台启动（现有 .venv，显式绑定 127.0.0.1:8000）…"
  log_line "${goofish_log}" "launcher：8000 离线，启动 .venv/bin/python -c uvicorn 127.0.0.1:8000"
  (cd "${goofish_dir}" && nohup ./.venv/bin/python -c "from src.app import app; import uvicorn; uvicorn.run(app, host='127.0.0.1', port=8000)" >>"${goofish_log}" 2>&1 &)
  deadline=$((SECONDS + 15))
  while ((SECONDS < deadline)); do
    is_http_up "${goofish_url}" && break
    sleep 0.5
  done
  if is_http_up "${goofish_url}"; then
    green "  ✓ 已上线（${goofish_url}）"
    ok=$((ok+1))
  else
    red "  ✗ 15 秒未就绪：查看 ${goofish_log}"
    fail=$((fail+1))
  fi
else
  red "· ai-goofish     ✗ 未安装（缺 ${goofish_dir}/.venv 或 src/app.py）"
  fail=$((fail+1))
fi

# ---- 4) xianyu-auto-reply-fix（端口 18090 来自上游 .env 用户配置） ----
if is_http_up "${reply_url}"; then
  green "· xianyu-reply   ✓ 在线（${reply_url}）"
  ok=$((ok+1))
elif [[ -x "${reply_dir}/.venv/bin/python" && -f "${reply_dir}/Start.py" ]]; then
  red "· xianyu-reply   ✗ 离线，后台启动（现有 .venv/Start.py）…"
  log_line "${reply_log}" "launcher：18090 离线，启动 .venv/bin/python Start.py"
  (cd "${reply_dir}" && nohup ./.venv/bin/python Start.py >>"${reply_log}" 2>&1 &)
  deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    is_http_up "${reply_url}" && break
    sleep 0.5
  done
  if is_http_up "${reply_url}"; then
    green "  ✓ 已上线（${reply_url}）"
    ok=$((ok+1))
  else
    red "  ✗ 20 秒未就绪：查看 ${reply_log}"
    fail=$((fail+1))
  fi
else
  red "· xianyu-reply   ✗ 未安装（缺 ${reply_dir}/.venv 或 Start.py）"
  fail=$((fail+1))
fi

# ---- 5) 本机受管补充采集 5200（可选外置源码，无外部窗口） ----
if is_http_up "${mptools_url}"; then
  green "· 补充采集引擎   ✓ 在线（本机受管）"
  ok=$((ok+1))
elif [[ -x "${mptools_dir}/.venv/bin/python" && -f "${mptools_dir}/app.py" ]]; then
  dim "· 补充采集引擎   ~ 正在后台启动（无窗口）…"
  (cd "${mptools_dir}" && nohup ./.venv/bin/python app.py --host 127.0.0.1 --port 5200 --no-browser >>"${mptools_log}" 2>&1 &)
  deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    is_http_up "${mptools_url}" && break
    sleep 0.5
  done
  if is_http_up "${mptools_url}"; then green "  ✓ 已上线并嵌入下载页"; ok=$((ok+1)); else red "  ✗ 启动失败：查看 ${mptools_log}"; fail=$((fail+1)); fi
else
  red "· 补充采集引擎   ✗ 可选外置源码或运行环境缺失"
  fail=$((fail+1))
fi

# ---- 6) 视频分析代理 17900（mcp-video-analyzer） ----
if is_http_up "${analyzer_url}"; then
  green "· 视频分析代理   ✓ 在线（${analyzer_url}）"
  ok=$((ok+1))
elif [[ -n "${node_bin}" && -f "${analyzer_dir}/dist/index.js" ]]; then
  red "· 视频分析代理   ✗ 离线，后台启动…"
  log_line "${analyzer_log}" "launcher：17900 离线，启动 video-analysis-server.mjs"
  (cd "${project_dir}" && nohup "${node_bin}" "${script_dir}/video-analysis-server.mjs" >>"${analyzer_log}" 2>&1 &)
  deadline=$((SECONDS + 10))
  while ((SECONDS < deadline)); do
    is_http_up "${analyzer_url}" && break
    sleep 0.5
  done
  if is_http_up "${analyzer_url}"; then
    green "  ✓ 已上线（${analyzer_url}）"
    ok=$((ok+1))
  else
    red "  ✗ 10 秒未就绪：查看 ${analyzer_log}"
    fail=$((fail+1))
  fi
else
  red "· 视频分析代理   ✗ mcp-video-analyzer 未安装（缺 ${analyzer_dir}/dist/index.js）"
  fail=$((fail+1))
fi

# ---- 7) 备用草稿引擎（MoneyPrinterTurbo，不再自启） ----
if is_http_up "${generator_url}"; then
  dim "· 备用草稿引擎   ~ 已由其它进程运行；主流程不依赖它"
elif [[ -x "${generator_dir}/.venv/bin/uvicorn" && -f "${generator_dir}/app/asgi.py" ]]; then
  dim "· 备用草稿引擎   · 已安装但不自启（主流程：GPT 图 → Seedance 2.0）"
else
  dim "· 备用草稿引擎   · 未安装，不影响主制作流程"
fi

# ---- 8) MatrixMedia 可选外置 CLI ----
if [[ -x "${matrixmedia_binary}" ]]; then
  green "· 发布引擎       ✓ 本机已安装（无 GUI / 无 Dock）"
  ok=$((ok+1))
else
  red "· 发布引擎       ✗ 可选 MatrixMedia 引擎未安装"
  fail=$((fail+1))
fi

print
print "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if ((fail == 0)); then
  green "全部模块已就绪（${ok} 项）。"
else
  red "有 ${fail} 项未就绪（${ok} 项正常）。请按上面红色提示逐项处理。"
fi
print "模块地址：知识库页 localhost:${zhitai_port:-未启动} · 下载 5200 · 分析/复刻 17900 · 闲鱼 8000/18090"
if [[ -n "${zhitai_port}" ]]; then
  print "正在打开织台…"
  open "http://localhost:${zhitai_port}/?view=inbox"
fi
