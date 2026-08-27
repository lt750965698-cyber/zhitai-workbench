#!/bin/zsh
set -euo pipefail

# 织台桌面版 · Finder 双击启动（外置引擎托管，窗口内不显示 localhost/端口/终端）
script_dir="${0:A:h}"
cd "${script_dir}"

# 唯一可用运行时：node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
ELECTRON_BIN="${script_dir}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_LOG="${HOME}/Library/Logs/zhitai-desktop-electron.log"

if [[ ! -x "${ELECTRON_BIN}" ]]; then
  print "✗ 织台桌面版缺少 Electron 运行时。"
  print "  请先在终端运行：cd \"${script_dir}\" && npm install"
  print "  安装完成后再次双击本脚本。"
  read "?按回车键关闭…"
  exit 1
fi

# env -u ELECTRON_RUN_AS_NODE：移除该变量（仅存在即可能进入 Node 模式）
# 直接调用二进制，不经过需要 PATH 中 node 的 .bin/electron
# 应用参数必须是绝对目录 "$script_dir"（严禁裸 .，否则会打开 Electron 欢迎页）
nohup env -u ELECTRON_RUN_AS_NODE "${ELECTRON_BIN}" "${script_dir}" >>"${ELECTRON_LOG}" 2>&1 &
print "✓ 织台桌面版已启动（窗口内使用，可关闭本终端）。"
print "  运行日志：${ELECTRON_LOG}"
