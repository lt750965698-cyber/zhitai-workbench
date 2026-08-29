import { spawn as spawnChild } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import * as nativePath from "node:path";

export function writableAppRoot({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || (env.USERPROFILE
      ? nativePath.win32.join(env.USERPROFILE, "AppData", "Local")
      : nativePath.win32.join(home, "AppData", "Local"));
    return nativePath.win32.join(base, "Zhitai");
  }
  if (platform === "darwin") return nativePath.join(home, "Library", "Application Support", "Zhitai");
  return nativePath.join(env.XDG_DATA_HOME || nativePath.join(home, ".local", "share"), "zhitai");
}

export function runtimeRootForPlatform(options = {}) {
  if ((options.platform || process.platform) === "win32") {
    return nativePath.win32.join(writableAppRoot(options), "runtime");
  }
  const home = options.home || homedir();
  return nativePath.join(home, ".local", "share", "zhitai-runtime");
}

export function isPathInside(candidate, root, pathApi = nativePath) {
  if (typeof candidate !== "string" || typeof root !== "string" || !candidate || !root) return false;
  const absoluteCandidate = pathApi.resolve(candidate);
  const absoluteRoot = pathApi.resolve(root);
  const relative = pathApi.relative(absoluteRoot, absoluteCandidate);
  return relative === "" || (!relative.startsWith(`..${pathApi.sep}`)
    && relative !== ".."
    && !pathApi.isAbsolute(relative));
}

export function childEnvironment(overrides = {}, {
  source = process.env,
  platform = process.platform,
} = {}) {
  const names = new Set([
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "PYTHONPATH", "VIRTUAL_ENV",
    ...(platform === "win32"
      ? ["SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT"]
      : []),
  ]);
  const env = {};
  for (const [sourceKey, value] of Object.entries(source || {})) {
    const canonical = [...names].find((name) => name.toLowerCase() === sourceKey.toLowerCase());
    if (canonical && typeof value === "string") env[canonical] = value;
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (/^[A-Z][A-Z0-9_]{0,63}$/.test(key) && ["string", "number", "boolean"].includes(typeof value)) {
      env[key] = String(value);
    }
  }
  return env;
}

export function executableCandidates(command, {
  platform = process.platform,
  env = process.env,
  pathApi = platform === "win32" ? nativePath.win32 : nativePath,
} = {}) {
  const raw = String(command || "").trim();
  if (!raw) return [];
  const extensions = platform === "win32" && !pathApi.extname(raw)
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
      .split(";").map((value) => value.trim().toLowerCase()).filter(Boolean)
    : [""];
  const names = extensions.map((extension) => `${raw}${extension}`);
  if (pathApi.isAbsolute(raw) || raw.includes(pathApi.sep) || (platform === "win32" && /[\\/]/u.test(raw))) {
    return [...new Set(names.map((value) => pathApi.resolve(value)))];
  }
  const pathValue = Object.entries(env || {})
    .find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  return [...new Set(String(pathValue).split(pathApi.delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => pathApi.join(directory, name))))];
}

export async function resolveExecutablePath(command, options = {}) {
  const checkAccess = options.accessImpl || access;
  for (const candidate of executableCandidates(command, options)) {
    try {
      await checkAccess(candidate, (options.platform || process.platform) === "win32"
        ? fsConstants.F_OK
        : fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through the explicit PATH/PATHEXT candidate list.
    }
  }
  return null;
}

export async function openLocalPath(target, {
  platform = process.platform,
  env = process.env,
  spawnImpl = spawnChild,
  resolveExecutableImpl = resolveExecutablePath,
} = {}) {
  let command;
  let args;
  if (platform === "win32") {
    command = env.SystemRoot || env.SYSTEMROOT
      ? nativePath.win32.join(env.SystemRoot || env.SYSTEMROOT, "explorer.exe")
      : "explorer.exe";
    args = [target];
  } else if (platform === "darwin") {
    command = "/usr/bin/open";
    args = [target];
  } else {
    command = await resolveExecutableImpl("xdg-open", { platform, env });
    if (!command) return false;
    args = [target];
  }
  try {
    const child = spawnImpl(command, args, { shell: false, detached: true, stdio: "ignore" });
    child?.once?.("error", () => {});
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}
