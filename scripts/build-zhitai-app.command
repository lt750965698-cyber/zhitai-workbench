#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
project_dir="${script_dir:h}"
electron_app="${project_dir}/desktop/node_modules/electron/dist/Electron.app"
user_dir="${HOME:-$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{print $2}')}"
install_dir="${ZHITAI_APPLICATIONS_DIR:-${user_dir}/Applications}"
install_app="${install_dir}/织台.app"
runtime_root="${ZHITAI_RUNTIME_ROOT:-${user_dir}/.local/share/zhitai-runtime}"
runtime_web="${runtime_root}/web"
work_dir="$(mktemp -d /tmp/zhitai-app-build.XXXXXX)"
stage_app="${work_dir}/织台.app"
stage_web="${work_dir}/web"

cleanup() { /bin/rm -rf "${work_dir}"; }
trap cleanup EXIT

if [[ ! -d "${electron_app}" ]]; then
  print -u2 "未找到 Electron 运行时，请先在 desktop 目录安装依赖。"
  exit 1
fi

# 日常安装版不再直接读取“桌面/工作台”，避免 macOS 每次询问桌面文件夹权限。
# 先生成生产构建，再把完整的只读网页运行时一次性复制到 ~/.local/share/zhitai-runtime。
node_bin=""
path_node="$(command -v node 2>/dev/null || true)"
for candidate in \
  "${ZHITAI_NODE_BIN:-}" "${runtime_root}/bin/node" "${path_node}" \
  "/opt/homebrew/bin/node" "/usr/local/bin/node" "/usr/bin/node"; do
  if [[ -x "${candidate}" ]]; then node_bin="${candidate}"; break; fi
done
if [[ -z "${node_bin}" ]]; then
  print -u2 "未找到可用 Node，无法生成织台网页运行时。"
  exit 1
fi

/bin/mkdir -p "${runtime_root}/bin"
if [[ "${node_bin}" != "${runtime_root}/bin/node" ]]; then
  /bin/ln -sf "${node_bin}" "${runtime_root}/bin/node"
fi

(cd "${project_dir}" && \
  WRANGLER_LOG_PATH="${project_dir}/.wrangler/wrangler.log" \
  "${node_bin}" "${project_dir}/node_modules/vinext/dist/cli.js" build)

/bin/mkdir -p "${stage_web}"
/usr/bin/ditto "${project_dir}/dist" "${stage_web}/dist"
/bin/cp "${project_dir}/package.json" "${stage_web}/package.json"
# APFS clone 可用时不额外占一份完整空间；不支持时自动退回普通复制。
if ! /bin/cp -cR "${project_dir}/node_modules" "${stage_web}/node_modules" 2>/dev/null; then
  /usr/bin/ditto "${project_dir}/node_modules" "${stage_web}/node_modules"
fi

/bin/mkdir -p "${runtime_root}/scripts"
for helper in video-analysis-server.mjs audio-feature-analysis.py camera-motion-analysis.py \
  qwen-visual-analysis.py scene-detect.py seedance-watermark-remover.py vision-frame-analysis.swift whisperx-word-timestamps.py; do
  /bin/cp "${project_dir}/scripts/${helper}" "${runtime_root}/scripts/${helper}"
done

/bin/mkdir -p "${runtime_root}"
if [[ -e "${runtime_web}" ]]; then
  previous_web="${runtime_root}/web.previous"
  /bin/rm -rf "${previous_web}"
  /bin/mv "${runtime_web}" "${previous_web}"
fi
/bin/mv "${stage_web}" "${runtime_web}"

/usr/bin/ditto "${electron_app}" "${stage_app}"
/bin/rm -f "${stage_app}/Contents/Resources/default_app.asar"
/bin/mkdir -p "${stage_app}/Contents/Resources/app"

for file in package.json main.js preload.js launcher.js adapter.js npm-locate.js creative-runner.js audio-postprocessor.js x-bookmark-runner.js yuanbao-runner.js; do
  /bin/cp "${project_dir}/desktop/${file}" "${stage_app}/Contents/Resources/app/${file}"
done

# 从现有织台品牌图裁出正方形应用图标，不引入额外图片依赖。
/usr/bin/sips -c 630 630 --cropOffset 0 505 "${project_dir}/public/og.png" \
  --out "${stage_app}/Contents/Resources/zhitai-icon.png" >/dev/null
iconset="${work_dir}/zhitai.iconset"
/bin/mkdir -p "${iconset}"
for spec in "16 icon_16x16.png" "32 icon_16x16@2x.png" "32 icon_32x32.png" \
  "64 icon_32x32@2x.png" "128 icon_128x128.png" "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" "512 icon_256x256@2x.png" "512 icon_512x512.png" \
  "1024 icon_512x512@2x.png"; do
  size="${spec%% *}"
  name="${spec#* }"
  /usr/bin/sips -z "${size}" "${size}" "${stage_app}/Contents/Resources/zhitai-icon.png" \
    --out "${iconset}/${name}" >/dev/null
done
/usr/bin/iconutil -c icns "${iconset}" -o "${stage_app}/Contents/Resources/zhitai.icns"

plist="${stage_app}/Contents/Info.plist"
/bin/mv "${stage_app}/Contents/MacOS/Electron" "${stage_app}/Contents/MacOS/织台"
/usr/libexec/PlistBuddy -c "Set :CFBundleName 织台" "${plist}"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 织台" "${plist}"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable 织台" "${plist}"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.zhitai.desktop" "${plist}"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.1.0" "${plist}"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion 1" "${plist}"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile zhitai.icns" "${plist}"
/usr/libexec/PlistBuddy -c "Set :LSApplicationCategoryType public.app-category.productivity" "${plist}"
/usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" "${plist}" 2>/dev/null || true

# 本机安装版使用 ad-hoc 签名；将来对外分发时再换 Developer ID + 公证。
/usr/bin/codesign --force --deep --sign - "${stage_app}" >/dev/null
/bin/mkdir -p "${install_dir}"

if [[ -e "${install_app}" ]]; then
  backup="${install_dir}/织台.app.previous"
  /bin/rm -rf "${backup}"
  /bin/mv "${install_app}" "${backup}"
fi
/bin/mv "${stage_app}" "${install_app}"
/usr/bin/touch "${install_app}"

print "织台已安装：${install_app}"
