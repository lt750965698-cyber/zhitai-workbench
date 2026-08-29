#!/bin/zsh
set -euo pipefail
umask 077

script_dir="${0:A:h}"
user_id="$(id -u)"
user_name="$(id -un)"
user_dir="${HOME:-$(dscl . -read "/Users/${user_name}" NFSHomeDirectory | awk '{print $2}')}"
launch_agents_dir="${user_dir}/Library/LaunchAgents"
target_plist="${launch_agents_dir}/com.zhitai.local-agent.plist"
runtime_dir="${user_dir}/.local/share/zhitai-runtime"
engine_dir="${runtime_dir}/engines"
openclaw_runtime_dir="${ZHITAI_OPENCLAW_RUNTIME_DIR:-${user_dir}/Applications/openclaw-runtime}"
service_log_dir="${user_dir}/Library/Logs/zhitai"
service_stdout="${service_log_dir}/local-agent.log"
service_stderr="${service_log_dir}/local-agent.error.log"

mkdir -p "${launch_agents_dir}"
mkdir -p -m 700 "${runtime_dir}/local-agent" "${runtime_dir}/scripts" "${service_log_dir}"
chmod 700 "${runtime_dir}" "${runtime_dir}/local-agent" "${runtime_dir}/scripts" "${service_log_dir}" 2>/dev/null || true
touch "${service_stdout}" "${service_stderr}"
chmod 600 "${service_stdout}" "${service_stderr}"
# 模块更新使用稳定入口；首次升级前先把当前已验证版本接到稳定别名。
for alias_target in \
  "mcp-video-analyzer-current:mcp-video-analyzer-v0.9.0" \
  "wechat-mp-tools-current:wechat-mp-tools-v1.8.1"; do
  alias_name="${alias_target%%:*}"
  target_name="${alias_target#*:}"
  alias_path="${engine_dir}/${alias_name}"
  target_path="${engine_dir}/${target_name}"
  if [[ ! -e "${alias_path}" && ! -L "${alias_path}" && -d "${target_path}" ]]; then
    /bin/ln -s "${target_path}" "${alias_path}"
  fi
done
# server 的模块已拆分，必须整组同步；本机 Cookie 和既有运行配置不参与批量覆盖。
rsync -a \
  --exclude='config.local.json' --exclude='yuanbao-cookie' --exclude='data/' --exclude='diag/' \
  --exclude='*.log' --exclude='*.tmp' \
  --exclude='zhitai-kuaidian-bridge.user.js' --exclude='zhitai-edge-all-in-one.user.js' \
  "${script_dir}/../local-agent/" "${runtime_dir}/local-agent/"
if [[ -d "${script_dir}/../integrations/zhitai-clawbot-control" && -d "${openclaw_runtime_dir}" ]]; then
  mkdir -p "${openclaw_runtime_dir}/zhitai-inbox-bridge"
  rsync -a --delete "${script_dir}/../integrations/zhitai-clawbot-control/" "${openclaw_runtime_dir}/zhitai-inbox-bridge/"
  if [[ -f "${script_dir}/finish-openclaw-setup.command" ]]; then
    cp "${script_dir}/finish-openclaw-setup.command" "${openclaw_runtime_dir}/finish-openclaw-setup.command"
    chmod 700 "${openclaw_runtime_dir}/finish-openclaw-setup.command"
  fi
fi
if [[ -f "${script_dir}/../local-agent/config.local.json" ]]; then
  cp "${script_dir}/../local-agent/config.local.json" "${runtime_dir}/local-agent/config.local.json"
  chmod 600 "${runtime_dir}/local-agent/config.local.json"
fi
cp "${script_dir}/run-local-agent.command" "${runtime_dir}/scripts/run-local-agent.command"
chmod 700 "${runtime_dir}/scripts/run-local-agent.command"
chmod 700 "${runtime_dir}/local-agent/inbox-submit.mjs"
chmod 700 "${runtime_dir}/local-agent/launchagent-probe.mjs"

node_binary=""
path_node="$(command -v node 2>/dev/null || true)"
node_candidates=(
  "${ZHITAI_NODE_BIN:-}"
  "${runtime_dir}/bin/node"
  "${path_node}"
  "/opt/homebrew/bin/node"
  "/usr/local/bin/node"
  "/usr/bin/node"
)
for candidate in "${node_candidates[@]}"; do
  if [[ -x "${candidate}" ]]; then
    node_binary="${candidate}"
    break
  fi
done
if [[ -z "${node_binary}" ]]; then
  print -u2 "未找到 Node.js，无法安装本地节点。"
  exit 1
fi
mkdir -p "${runtime_dir}/bin"
if [[ "${node_binary}" != "${runtime_dir}/bin/node" ]]; then
  ln -sf "${node_binary}" "${runtime_dir}/bin/node"
fi
wx_card_config="${engine_dir}/wx-video-card/config.yaml"
if [[ -f "${wx_card_config}" ]]; then
  "${node_binary}" "${runtime_dir}/local-agent/wx-card-config.mjs" "${wx_card_config}"
fi
"${node_binary}" "${runtime_dir}/local-agent/inbox-submit.mjs" --ensure-secret >/dev/null

# before_dispatch 需要显式授权第三方插件读取对话；只补充这一个字段，不覆盖扫码登录和其他用户配置。
openclaw_config="${openclaw_runtime_dir}/state/openclaw.json"
if [[ -f "${openclaw_config}" ]]; then
  "${node_binary}" - "${openclaw_config}" <<'NODE'
const { readFileSync, writeFileSync, renameSync, chmodSync } = require("node:fs");
const path = process.argv[2];
const config = JSON.parse(readFileSync(path, "utf8"));
config.plugins ??= {};
config.plugins.entries ??= {};
config.plugins.entries["zhitai-inbox-bridge"] ??= {};
config.plugins.entries["zhitai-inbox-bridge"].enabled = true;
config.plugins.entries["zhitai-inbox-bridge"].hooks ??= {};
config.plugins.entries["zhitai-inbox-bridge"].hooks.allowConversationAccess = true;
const tempPath = `${path}.zhitai.tmp`;
writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
renameSync(tempPath, path);
chmodSync(path, 0o600);
NODE
fi

cp "${script_dir}/com.zhitai.local-agent.plist" "${target_plist}"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:1 ${runtime_dir}/scripts/run-local-agent.command" "${target_plist}"
/usr/libexec/PlistBuddy -c "Set :StandardOutPath ${service_stdout}" "${target_plist}"
/usr/libexec/PlistBuddy -c "Set :StandardErrorPath ${service_stderr}" "${target_plist}"
chmod 600 "${target_plist}"
launchctl bootout "gui/${user_id}" "${target_plist}" 2>/dev/null || true
launchctl bootstrap "gui/${user_id}" "${target_plist}"
launchctl kickstart -k "gui/${user_id}/com.zhitai.local-agent"

ready=0
health_url="$("${node_binary}" -e 'const fs=require("node:fs");const p=process.argv[1];let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{};const h=c.host||"127.0.0.1";if(!["127.0.0.1","localhost","::1"].includes(h))process.exit(2);const host=h==="::1"?"[::1]":h;process.stdout.write(`http://${host}:${Number(c.port||17890)}/health`)' "${runtime_dir}/local-agent/config.local.json")"
for _attempt in {1..40}; do
  if /usr/bin/curl --fail --silent --max-time 1 "${health_url}" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done
if [[ "${ready}" -ne 1 ]]; then
  print -u2 "本地节点已安装，但健康检查未在 10 秒内通过。请查看 ~/Library/Logs/zhitai/local-agent.error.log。"
  exit 1
fi

print "织台本地节点已设为登录后自动运行。"
print "健康检查：${health_url}"
