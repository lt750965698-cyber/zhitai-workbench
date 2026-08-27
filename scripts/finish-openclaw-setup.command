#!/bin/zsh
set -u
setopt pipefail

user_name="$(/usr/bin/id -un)"
user_dir="${HOME:-$(/usr/bin/dscl . -read "/Users/${user_name}" NFSHomeDirectory | /usr/bin/awk '{print $2}')}"
runtime_dir="${ZHITAI_OPENCLAW_RUNTIME_DIR:-${user_dir}/Applications/openclaw-runtime}"
state_dir="${runtime_dir}/state"
config_path="${state_dir}/openclaw.json"
launch_plist="${user_dir}/Library/LaunchAgents/com.zhitai.openclaw-weixin.plist"
launch_label="com.zhitai.openclaw-weixin"
node_bin=""
path_node="$(command -v node 2>/dev/null || true)"
for candidate in \
  "${ZHITAI_NODE_BIN:-}" \
  "${user_dir}/.local/share/zhitai-runtime/bin/node" \
  "${path_node}" \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node" \
  "/usr/bin/node"; do
  if [[ -x "${candidate}" ]]; then
    node_bin="${candidate}"
    break
  fi
done
openclaw_bin="${runtime_dir}/node_modules/.bin/openclaw"
gateway_log="${state_dir}/logs/gateway.log"
user_id="$(/usr/bin/id -u)"
launch_domain="gui/${user_id}"
launch_service="${launch_domain}/${launch_label}"
setup_tty="$(/usr/bin/tty 2>/dev/null || true)"
restart_only=0

if [[ "${1:-}" == "--restart-only" ]]; then
  restart_only=1
fi

export PATH="${node_bin:h}:/usr/bin:/bin"
export OPENCLAW_STATE_DIR="${state_dir}"
export OPENCLAW_CONFIG_PATH="${config_path}"

fail() {
  print -u2 "\n启动失败：$1"
  print -u2 "这个窗口会保留，便于查看错误。"
  exit 1
}

close_own_terminal() {
  local tty_path="$1"
  [[ "${TERM_PROGRAM:-}" == "Apple_Terminal" ]] || return 0
  [[ -n "${tty_path}" && "${tty_path}" != "not a tty" ]] || return 0
  # 在 .command 进程退出前关闭所在标签；退出后 Terminal 可能只留下无标签的空窗口。
  /usr/bin/osascript - "${tty_path}" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    repeat with terminalWindow in windows
      repeat with terminalTab in tabs of terminalWindow
        try
          if (tty of terminalTab) is targetTty then
            if (count of tabs of terminalWindow) > 1 then
              close terminalTab
            else
              close terminalWindow
            end if
            return
          end if
        end try
      end repeat
    end repeat
  end tell
end run
APPLESCRIPT
}

[[ -x "${node_bin}" ]] || fail "未找到 Node.js 运行时。"
[[ -x "${openclaw_bin}" ]] || fail "OpenClaw 运行时不完整。"
[[ -f "${launch_plist}" ]] || fail "未找到 ClawBot 后台启动配置。"

ZHITAI_WEBHOOK_SECRET_FILE="${state_dir}/gateway-token" \
  "${node_bin}" \
  "${ZHITAI_SUBMITTER_PATH:-${user_dir}/.local/share/zhitai-runtime/local-agent/inbox-submit.mjs}" \
  --ensure-secret >/dev/null || fail "无法准备织台遥控密钥。"

if [[ "${restart_only}" -ne 1 ]]; then
  print "终端即将显示腾讯 ClawBot 授权二维码。请用微信扫码并在手机上确认。"
  "${openclaw_bin}" channels login --channel openclaw-weixin || fail "ClawBot 扫码授权未完成。"
fi

/usr/bin/find "${state_dir}" -type d -exec /bin/chmod 700 {} +
/usr/bin/find "${state_dir}" -type f -exec /bin/chmod 600 {} +

log_lines_before=0
if [[ -f "${gateway_log}" ]]; then
  log_lines_before="$(/usr/bin/wc -l < "${gateway_log}" | /usr/bin/tr -d ' ')"
fi

/bin/launchctl bootout "${launch_service}" >/dev/null 2>&1 || \
  /bin/launchctl bootout "${launch_domain}" "${launch_plist}" >/dev/null 2>&1 || true

for _attempt in {1..40}; do
  if ! /bin/launchctl print "${launch_service}" >/dev/null 2>&1; then
    break
  fi
  /bin/sleep 0.25
done

bootstrapped=0
for _attempt in {1..10}; do
  if /bin/launchctl print "${launch_service}" >/dev/null 2>&1; then
    bootstrapped=1
    break
  fi
  if /bin/launchctl bootstrap "${launch_domain}" "${launch_plist}" >/dev/null 2>&1; then
    bootstrapped=1
    break
  fi
  /bin/sleep 0.5
done
[[ "${bootstrapped}" -eq 1 ]] || fail "macOS 未能注册 ClawBot 后台服务。"

/bin/launchctl kickstart -k "${launch_service}" >/dev/null 2>&1 || fail "ClawBot 后台服务无法启动。"

ready=0
for _attempt in {1..120}; do
  job_running=0
  gateway_ready=0
  weixin_ready=0
  /bin/launchctl print "${launch_service}" 2>/dev/null | /usr/bin/grep -q 'state = running' && job_running=1
  /usr/bin/curl --noproxy '*' --fail --silent --max-time 1 http://127.0.0.1:18789/ >/dev/null 2>&1 && gateway_ready=1
  if [[ -f "${gateway_log}" ]]; then
    /usr/bin/tail -n "+$((log_lines_before + 1))" "${gateway_log}" 2>/dev/null | /usr/bin/grep -q 'weixin monitor started' && weixin_ready=1
  fi
  if [[ "${job_running}" -eq 1 && "${gateway_ready}" -eq 1 && "${weixin_ready}" -eq 1 ]]; then
    ready=1
    break
  fi
  /bin/sleep 0.5
done

[[ "${ready}" -eq 1 ]] || fail "ClawBot 进程已启动，但微信长轮询未在 60 秒内就绪。"

print "\nClawBot 已授权，织台手机遥控器已在后台运行。"
print "这个安装窗口将自动关闭。"
close_own_terminal "${setup_tty}"
