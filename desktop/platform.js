"use strict";

const os = require("node:os");
const path = require("node:path");

function windowsLocalAppData(env, home) {
  return env.LOCALAPPDATA || env.LocalAppData || path.win32.join(home, "AppData", "Local");
}

function desktopRuntimeRoot({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  pathApi = platform === "win32" ? path.win32 : path,
} = {}) {
  if (env.ZHITAI_RUNTIME_ROOT) return pathApi.resolve(env.ZHITAI_RUNTIME_ROOT);
  if (platform === "win32") return pathApi.join(windowsLocalAppData(env, home), "Zhitai", "runtime");
  return pathApi.join(home, ".local", "share", "zhitai-runtime");
}

function desktopLogRoot({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  pathApi = platform === "win32" ? path.win32 : path,
} = {}) {
  if (env.ZHITAI_LOG_DIR) return pathApi.resolve(env.ZHITAI_LOG_DIR);
  if (platform === "win32") return pathApi.join(windowsLocalAppData(env, home), "Zhitai", "logs");
  if (platform === "darwin") return pathApi.join(home, "Library", "Logs");
  return pathApi.join(env.XDG_STATE_HOME || pathApi.join(home, ".local", "state"), "zhitai", "logs");
}

function desktopProjectDir({
  platform = process.platform,
  env = process.env,
  isPackaged = false,
  appPath,
  moduleDir = __dirname,
  pathApi = platform === "win32" ? path.win32 : path,
} = {}) {
  if (env.ZHITAI_PROJECT_DIR) return pathApi.resolve(env.ZHITAI_PROJECT_DIR);
  if (isPackaged) {
    if (!appPath) throw new Error("packaged_app_path_required");
    return pathApi.resolve(appPath);
  }
  return pathApi.resolve(moduleDir, "..");
}

function desktopDataRoot(options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = options.pathApi || (platform === "win32" ? path.win32 : path);
  return pathApi.join(desktopRuntimeRoot({ ...options, pathApi }), "data");
}

function virtualEnvironmentExecutable(root, executable, platform = process.platform) {
  if (platform === "win32") return path.win32.join(root, ".venv", "Scripts", `${executable}.exe`);
  return path.join(root, ".venv", "bin", executable);
}

module.exports = {
  desktopDataRoot,
  desktopLogRoot,
  desktopProjectDir,
  desktopRuntimeRoot,
  virtualEnvironmentExecutable,
  windowsLocalAppData,
};
