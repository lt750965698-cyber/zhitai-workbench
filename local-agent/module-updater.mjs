/* 织台 · 受控模块更新器
 *
 * 只更新明确列入白名单的上游模块。每次更新均使用官方 GitHub Release，先下载到
 * 旁路目录并完成模块级冒烟，再切换稳定入口；旧版本保留在 backups，失败时不碰当前版。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  hardenMatrixMediaAsar,
  matrixMediaAsarHeaderSha256,
  migrateMatrixMediaDataWithoutOverwrite,
} from "./matrixmedia-upgrade-hardening.mjs";

const RUNTIME_ROOT = resolve(process.env.ZHITAI_RUNTIME_ROOT
  || join(homedir(), ".local", "share", "zhitai-runtime"));
const APPLICATIONS_ROOT = resolve(process.env.ZHITAI_APPLICATIONS_DIR
  || join(homedir(), "Applications"));
const XIANYU_ROOT = resolve(process.env.ZHITAI_XIANYU_ROOT
  || join(APPLICATIONS_ROOT, "xianyu-auto-reply-fix"));
const ENGINE_ROOT = join(RUNTIME_ROOT, "engines");
const UPDATE_ROOT = join(RUNTIME_ROOT, "updates");
const BACKUP_ROOT = join(RUNTIME_ROOT, "backups");
const MATRIXMEDIA_LEGACY_DATA_ROOT = resolve(process.env.ZHITAI_MATRIXMEDIA_LEGACY_DATA_ROOT
  || join(homedir(), "Documents", "MatrixMedia", "data"));
const MATRIXMEDIA_USER_DATA_ROOT = resolve(process.env.ZHITAI_MATRIXMEDIA_USER_DATA_ROOT
  || join(homedir(), "Library", "Application Support", "matrix-video", "MatrixMedia", "data"));

const MODULES = {
  "mcp-video-analyzer": { repo: "guimatheus92/mcp-video-analyzer" },
  matrixmedia: { repo: "hanliang97/MatrixMedia" },
  "xianyu-auto-reply": { repo: "GuDong2003/xianyu-auto-reply-fix" },
  "wechat-mp-tools": { repo: "x554960766/wechat-mp-tools" },
};

function normalizedVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function safeRelativePath(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  const segments = raw.split("/");
  if (!raw || raw.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("更新清单包含不安全路径");
  }
  return raw;
}

function encodedPath(...parts) {
  return `/${parts.flatMap((part) => String(part).split("/")).map(encodeURIComponent).join("/")}`;
}

export function requireSha256(value, label = "更新文件") {
  const match = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(String(value || "").trim());
  if (!match) throw new Error(`${label} 缺少有效的 SHA-256 校验值`);
  return match[1].toLowerCase();
}

/**
 * Restrict every updater request to the repository and immutable release tag
 * selected by GitHub's release API. Redirects are accepted only for GitHub's
 * dedicated release-asset host or the matching codeload endpoint.
 */
export function assertTrustedGithubUrl(value, policy, redirect = false) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw new Error("更新地址无效"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error("更新地址不属于受信任的 GitHub Release");
  }
  const repo = String(policy?.repo || "");
  const tag = String(policy?.tag || "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !tag || /[/?#]/.test(tag)) {
    throw new Error("更新器缺少受信任的仓库或版本边界");
  }
  const [owner, repository] = repo.split("/");
  if (policy.kind === "release-asset") {
    if (!redirect) {
      const expected = encodedPath(owner, repository, "releases", "download", tag, policy.assetName);
      if (url.hostname !== "github.com" || url.pathname !== expected || url.search) {
        throw new Error("Release 资源地址与预期仓库或版本不匹配");
      }
    } else if (url.hostname !== "release-assets.githubusercontent.com") {
      throw new Error("Release 资源发生了非 GitHub 重定向");
    }
    return url;
  }
  if (policy.kind === "raw-file") {
    const expected = encodedPath(owner, repository, tag, safeRelativePath(policy.relativePath));
    if (url.hostname !== "raw.githubusercontent.com" || url.pathname !== expected || url.search) {
      throw new Error("热更新文件地址与预期仓库、版本或路径不匹配");
    }
    return url;
  }
  if (policy.kind === "tarball") {
    const apiPath = encodedPath("repos", owner, repository, "tarball", tag);
    const archivePath = encodedPath(owner, repository, "archive", "refs", "tags", `${tag}.tar.gz`);
    const codeloadPaths = new Set([
      encodedPath(owner, repository, "tar.gz", "refs", "tags", tag),
      encodedPath(owner, repository, "legacy.tar.gz", "refs", "tags", tag),
    ]);
    const matchesInitial = !redirect && (
      (url.hostname === "api.github.com" && url.pathname === apiPath && !url.search)
      || (url.hostname === "github.com" && url.pathname === archivePath && !url.search)
    );
    const matchesRedirect = redirect
      && url.hostname === "codeload.github.com"
      && codeloadPaths.has(url.pathname)
      && !url.search;
    if (!matchesInitial && !matchesRedirect) throw new Error("源码归档地址与预期仓库或版本不匹配");
    return url;
  }
  throw new Error("更新器缺少下载地址策略");
}

function run(command, args, {
  cwd,
  timeoutMs = 120_000,
  allowedCodes = [0],
  env: environment = {},
  unsetEnv = [],
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const childEnvironment = {
      ...process.env,
      PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      NO_PROXY: "localhost,127.0.0.1,::1,github.com,api.github.com,raw.githubusercontent.com",
      ...environment,
    };
    for (const key of unsetEnv) delete childEnvironment[key];
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? rejectPromise(error) : resolvePromise(value);
    };
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.on("data", (data) => { err += data; });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!allowedCodes.includes(Number(code))) {
        finish(new Error(`${basename(command)} 退出码 ${code}：${String(err || out).trim().slice(-500)}`));
        return;
      }
      finish(null, { code: Number(code), out, err });
    });
    timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* noop */ }
      finish(new Error(`${basename(command)} 执行超时`));
    }, timeoutMs);
  });
}

async function fetchJson(url, timeoutMs = 20_000) {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "zhitai-module-updater/1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`读取官方更新信息失败（HTTP ${response.status}）`);
  return response.json();
}

async function latestRelease(repo) {
  return fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
}

function fallbackRelease(moduleId, repo, expectedVersion) {
  const version = normalizedVersion(expectedVersion);
  if (!version) return null;
  const tag = String(expectedVersion).startsWith("v") ? String(expectedVersion) : `v${version}`;
  const release = {
    tag_name: tag,
    tarball_url: `https://github.com/${repo}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`,
    assets: [],
  };
  if (moduleId === "matrixmedia") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const name = `MatrixMedia-${version}-mac-${arch}.dmg`;
    release.assets.push({ name, browser_download_url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}` });
  }
  if (moduleId === "xianyu-auto-reply") {
    release.assets.push({ name: "update_files.json", browser_download_url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/update_files.json` });
  }
  return release;
}

async function fetchTrusted(url, policy, timeoutMs = 20 * 60_000) {
  let current = assertTrustedGithubUrl(url, policy, false);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const response = await fetch(current, {
      headers: { "User-Agent": "zhitai-module-updater/1" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === 4) throw new Error("GitHub 下载重定向无效或过多");
    current = assertTrustedGithubUrl(new URL(location, current), policy, true);
  }
  throw new Error("GitHub 下载重定向过多");
}

async function download(url, destination, expectedSize = 0, { sha256, policy } = {}) {
  // GitHub-generated source tarballs currently do not expose a release digest;
  // all executable assets and hot-update files must have one.
  const expectedSha256 = sha256
    ? requireSha256(sha256, "Release 资源")
    : (policy?.kind === "tarball" ? null : requireSha256(null, "Release 资源"));
  const response = await fetchTrusted(url, policy);
  if (!response.ok || !response.body) throw new Error(`下载安装包失败（HTTP ${response.status}）`);
  await mkdir(dirname(destination), { recursive: true });
  const digest = createHash("sha256");
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), hashingStream, createWriteStream(destination, { mode: 0o600 }));
    const size = (await lstat(destination)).size;
    if (expectedSize > 0 && size !== expectedSize) {
      throw new Error(`安装包大小校验失败（期望 ${expectedSize}，实际 ${size}）`);
    }
    const actualSha256 = digest.digest("hex");
    if (expectedSha256 && actualSha256 !== expectedSha256) throw new Error("Release 资源 SHA-256 校验失败");
  } catch (error) {
    await rm(destination, { force: true }).catch(() => null);
    throw error;
  }
  return destination;
}

async function fetchVerifiedJsonAsset(asset, policy) {
  const expectedSize = Number(asset?.size) || 0;
  if (expectedSize < 2 || expectedSize > 2 * 1024 * 1024) throw new Error("热更新清单大小不合理");
  const workspace = await prepareWorkspace("manifest");
  const destination = join(workspace, "release-manifest.json");
  try {
    await download(asset?.browser_download_url, destination, expectedSize, {
      sha256: asset?.digest,
      policy,
    });
    return JSON.parse(await readFile(destination, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("官方热更新清单不是有效 JSON");
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => null);
  }
}

async function prepareWorkspace(moduleId) {
  await mkdir(UPDATE_ROOT, { recursive: true });
  return mkdtemp(join(UPDATE_ROOT, `${moduleId}-`));
}

async function cleanupModuleWorkspaces(moduleId) {
  try {
    const entries = await readdir(UPDATE_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(`${moduleId}-`)) {
        await rm(join(UPDATE_ROOT, entry.name), { recursive: true, force: true });
      }
    }
  } catch { /* 更新目录尚未创建 */ }
}

async function createBackupDir(moduleId, version) {
  const path = join(BACKUP_ROOT, moduleId, `${timestamp()}-${normalizedVersion(version) || "unknown"}`);
  await mkdir(path, { recursive: true });
  return path;
}

async function switchSymlink(alias, target) {
  await mkdir(dirname(alias), { recursive: true });
  const temporary = `${alias}.next-${process.pid}`;
  await rm(temporary, { force: true, recursive: true });
  await symlink(target, temporary, "dir");
  await rename(temporary, alias);
}

export function chooseReleaseAsset(moduleId, release, arch = process.arch) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  if (moduleId === "matrixmedia") {
    const marker = arch === "arm64" ? "mac-arm64.dmg" : "mac-x64.dmg";
    return assets.find((asset) => String(asset?.name || "").endsWith(marker)) || null;
  }
  if (moduleId === "xianyu-auto-reply") {
    return assets.find((asset) => asset?.name === "update_files.json") || null;
  }
  return null;
}

async function assertExpectedRelease(release, expectedVersion) {
  const latest = normalizedVersion(release?.tag_name);
  if (!latest) throw new Error("官方 Release 没有版本号");
  if (expectedVersion && latest !== normalizedVersion(expectedVersion)) {
    throw new Error(`检查后官方版本已变化（当前 ${release.tag_name}），请刷新更新列表后重试`);
  }
  return latest;
}

async function setMatrixMediaAsarIntegrity(plistPath, digest) {
  const plistBuddy = "/usr/libexec/PlistBuddy";
  const entry = ":ElectronAsarIntegrity:Resources/app.asar";
  const algorithm = await run(plistBuddy, ["-c", `Set ${entry}:algorithm SHA256`, plistPath], { allowedCodes: [0, 1] });
  const hash = await run(plistBuddy, ["-c", `Set ${entry}:hash ${digest}`, plistPath], { allowedCodes: [0, 1] });
  if (algorithm.code !== 0 || hash.code !== 0) {
    await run(plistBuddy, ["-c", `Delete ${entry}`, plistPath], { allowedCodes: [0, 1] });
    await run(plistBuddy, ["-c", "Add :ElectronAsarIntegrity dict", plistPath], { allowedCodes: [0, 1] });
    await run(plistBuddy, ["-c", `Add ${entry} dict`, plistPath]);
    await run(plistBuddy, ["-c", `Add ${entry}:algorithm string SHA256`, plistPath]);
    await run(plistBuddy, ["-c", `Add ${entry}:hash string ${digest}`, plistPath]);
  }
  const verifiedAlgorithm = (await run(plistBuddy, ["-c", `Print ${entry}:algorithm`, plistPath])).out.trim();
  const verifiedHash = (await run(plistBuddy, ["-c", `Print ${entry}:hash`, plistPath])).out.trim();
  if (verifiedAlgorithm !== "SHA256" || verifiedHash !== digest) {
    throw new Error("MatrixMedia ElectronAsarIntegrity 写入复核失败；拒绝更新");
  }
}

async function smokeMatrixMediaCli(binary) {
  const options = {
    timeoutMs: 30_000,
    env: { MATRIXMEDIA_DISABLE_TELEMETRY: "1" },
    unsetEnv: ["ELECTRON_RUN_AS_NODE"],
  };
  await run(binary, ["cli", "--help"], options);
  await run(binary, ["cli", "accounts", "--json"], options);
  await run(binary, ["cli", "history", "--json"], options);
}

async function installMatrixMedia(release, expectedVersion) {
  const version = await assertExpectedRelease(release, expectedVersion);
  const asset = chooseReleaseAsset("matrixmedia", release);
  if (!asset?.browser_download_url) throw new Error("官方 Release 中没有适用于本机的 MatrixMedia 安装包");
  const tag = String(release.tag_name || "");
  const assetName = String(asset.name || "");
  if (basename(assetName) !== assetName) throw new Error("MatrixMedia Release 资源名称无效");
  const workspace = await prepareWorkspace("matrixmedia");
  const dmg = join(workspace, assetName);
  const mount = join(workspace, "mount");
  const staged = join(workspace, "matrixmedia.app");
  await mkdir(mount, { recursive: true });
  await download(asset.browser_download_url, dmg, Number(asset.size) || 0, {
    sha256: asset.digest,
    policy: {
      kind: "release-asset",
      repo: MODULES.matrixmedia.repo,
      tag,
      assetName,
    },
  });
  let mounted = false;
  try {
    await run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg], { timeoutMs: 120_000 });
    mounted = true;
    const appEntry = (await readdir(mount, { withFileTypes: true })).find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
    if (!appEntry) throw new Error("MatrixMedia 安装包内没有应用程序");
    // fs.cp 会把 Electron Framework 内的相对软链接重写为指向 DMG 挂载点的绝对链接；
    // ditto 是 macOS 复制 .app 的原生方式，会原样保留 bundle 内部相对链接。
    await run("/usr/bin/ditto", [join(mount, appEntry.name), staged], { timeoutMs: 180_000 });
  } finally {
    if (mounted) await run("/usr/bin/hdiutil", ["detach", mount, "-force"], { timeoutMs: 60_000 }).catch(() => null);
  }
  const plist = await readFile(join(staged, "Contents", "Info.plist"), "utf8");
  const stagedVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (normalizedVersion(stagedVersion) !== version) throw new Error(`旁路版本校验失败（安装包 ${stagedVersion || "未知"}，Release ${version}）`);
  const stagedBinary = join(staged, "Contents", "MacOS", "matrixmedia");
  const stagedPlist = join(staged, "Contents", "Info.plist");
  const stagedAsar = join(staged, "Contents", "Resources", "app.asar");
  const frameworkLink = await readlink(join(staged, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"));
  if (frameworkLink.startsWith("/")) throw new Error("旁路应用包含指向临时挂载盘的绝对 Framework 链接，拒绝切换");
  await hardenMatrixMediaAsar(stagedAsar, workspace);
  await migrateMatrixMediaDataWithoutOverwrite(MATRIXMEDIA_LEGACY_DATA_ROOT, MATRIXMEDIA_USER_DATA_ROOT);
  await setMatrixMediaAsarIntegrity(stagedPlist, matrixMediaAsarHeaderSha256(stagedAsar));
  // 织台只使用 CLI；把官方 Electron bundle 标记为后台附件，避免每次
  // 账号查询/发布时 Dock 短暂出现图标。修改 plist 后用本机 ad-hoc 重签名。
  const setAgent = await run("/usr/libexec/PlistBuddy", ["-c", "Set :LSUIElement true", stagedPlist], { allowedCodes: [0, 1] });
  if (setAgent.code !== 0) await run("/usr/libexec/PlistBuddy", ["-c", "Add :LSUIElement bool true", stagedPlist]);
  await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", staged], { timeoutMs: 120_000 });
  await smokeMatrixMediaCli(stagedBinary);

  const target = join(ENGINE_ROOT, "matrixmedia.app");
  let currentVersion = "unknown";
  try {
    const currentPlist = await readFile(join(target, "Contents", "Info.plist"), "utf8");
    currentVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(currentPlist)?.[1] || "unknown";
  } catch { /* 首次安装 */ }
  const backupDir = await createBackupDir("matrixmedia", currentVersion);
  const backup = join(backupDir, "matrixmedia.app");
  if (await exists(target)) await rename(target, backup);
  try {
    await rename(staged, target);
    // 在最终路径再跑一次，防止旁路目录可用但切换后的 bundle 失效。
    await smokeMatrixMediaCli(join(target, "Contents", "MacOS", "matrixmedia"));
  }
  catch (error) {
    if (await exists(target)) await rename(target, join(workspace, "failed-matrixmedia.app"));
    if (await exists(backup)) await rename(backup, target);
    throw error;
  }
  return { version: `v${version}`, backupPath: backup, restartRequired: false, message: "发布引擎已切换，新登录和发布任务立即使用新版" };
}

function pnpmCliPath() {
  return join(dirname(dirname(process.execPath)), "node_modules", "pnpm", "bin", "pnpm.mjs");
}

async function npmCliPath() {
  const candidates = [
    process.env.ZHITAI_NPM_CLI,
    join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}

async function installSourceModule(moduleId, release, expectedVersion) {
  const version = await assertExpectedRelease(release, expectedVersion);
  if (!release?.tarball_url) throw new Error("官方 Release 没有源码安装包");
  const tag = String(release.tag_name || "");
  const repo = MODULES[moduleId]?.repo;
  const workspace = await prepareWorkspace(moduleId);
  const archive = join(workspace, "source.tar.gz");
  const staged = join(workspace, "source");
  await mkdir(staged, { recursive: true });
  await download(release.tarball_url, archive, 0, {
    policy: { kind: "tarball", repo, tag },
  });
  await run("/usr/bin/tar", ["-xzf", archive, "-C", staged, "--strip-components", "1"], { timeoutMs: 120_000 });

  if (moduleId === "mcp-video-analyzer") {
    const npm = await npmCliPath();
    if (npm && await exists(join(staged, "package-lock.json"))) {
      // 该上游使用 package-lock.json；npm ci 才是它的可复现安装方式。
      await run(process.execPath, [npm, "ci", "--ignore-scripts"], { cwd: staged, timeoutMs: 12 * 60_000 });
      await run(process.execPath, [npm, "run", "build"], { cwd: staged, timeoutMs: 5 * 60_000 });
    } else {
      const pnpm = pnpmCliPath();
      if (!(await exists(pnpm))) throw new Error("未找到织台随附的 npm/pnpm，不能安全安装视频分析依赖");
      await run(process.execPath, [pnpm, "install", "--no-frozen-lockfile", "--ignore-scripts"], { cwd: staged, timeoutMs: 12 * 60_000 });
      await run(process.execPath, [pnpm, "run", "build"], { cwd: staged, timeoutMs: 5 * 60_000 });
    }
    if (!(await exists(join(staged, "dist", "index.js")))) throw new Error("视频分析旁路构建没有生成 dist/index.js");
    const packageVersion = JSON.parse(await readFile(join(staged, "package.json"), "utf8")).version;
    if (normalizedVersion(packageVersion) !== version) throw new Error(`视频分析版本校验失败（${packageVersion} / ${version}）`);
    await run(process.execPath, [join(staged, "dist", "index.js"), "--help"], { cwd: staged, timeoutMs: 30_000 });
    const finalDir = join(ENGINE_ROOT, `mcp-video-analyzer-v${version}`);
    if (!(await exists(finalDir))) await rename(staged, finalDir);
    await switchSymlink(join(ENGINE_ROOT, "mcp-video-analyzer-current"), finalDir);
    return { version: `v${version}`, backupPath: join(ENGINE_ROOT, "mcp-video-analyzer-v0.9.0"), restartRequired: true, message: "视频分析新版已旁路安装；重启织台后切换分析进程" };
  }

  const sharedRoot = join(ENGINE_ROOT, "wechat-mp-tools");
  const python = join(sharedRoot, ".venv", "bin", "python");
  if (!(await exists(python))) throw new Error("补充采集现有 Python 环境缺失，不能安全更新");
  for (const name of [".venv", "data"]) {
    await rm(join(staged, name), { recursive: true, force: true });
    await symlink(join(sharedRoot, name), join(staged, name), "dir");
  }
  await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", join(staged, "requirements.txt")], { cwd: staged, timeoutMs: 12 * 60_000 });
  await run(python, ["-m", "compileall", "-q", "app.py", "backend"], { cwd: staged, timeoutMs: 120_000 });
  const configText = await readFile(join(staged, "backend", "config.py"), "utf8");
  const packageVersion = /^\s*APP_VERSION\s*=\s*["']([^"']+)["']/m.exec(configText)?.[1];
  if (normalizedVersion(packageVersion) !== version) throw new Error(`补充采集版本校验失败（${packageVersion || "未知"} / ${version}）`);
  const finalDir = join(ENGINE_ROOT, `wechat-mp-tools-v${version}`);
  if (!(await exists(finalDir))) await rename(staged, finalDir);
  await switchSymlink(join(ENGINE_ROOT, "wechat-mp-tools-current"), finalDir);
  return { version: `v${version}`, backupPath: join(ENGINE_ROOT, "wechat-mp-tools-v1.8.1"), restartRequired: true, message: "补充采集新版已安装并保留登录数据；重启织台后切换后台" };
}

export async function moduleUpdateBlocker(moduleId) {
  if (moduleId !== "xianyu-auto-reply") return null;
  const root = XIANYU_ROOT;
  if (!(await exists(join(root, ".git")))) return "闲鱼客服不是可核验的 Git 工作区，暂不自动覆盖";
  try {
    const { out } = await run("/usr/bin/git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], { timeoutMs: 15_000 });
    if (out.trim()) return "检测到本地代码改动；为避免覆盖你的修复，本模块暂不自动更新";
  } catch {
    return "无法核验闲鱼客服的本地改动，暂不自动更新";
  }
  return null;
}

async function installXianyu(release, expectedVersion) {
  const blocker = await moduleUpdateBlocker("xianyu-auto-reply");
  if (blocker) throw new Error(blocker);
  const version = await assertExpectedRelease(release, expectedVersion);
  const asset = chooseReleaseAsset("xianyu-auto-reply", release);
  if (!asset?.browser_download_url) throw new Error("官方 Release 没有热更新清单");
  const repo = MODULES["xianyu-auto-reply"].repo;
  const tag = String(release.tag_name || "");
  const manifest = await fetchVerifiedJsonAsset(asset, {
    kind: "release-asset",
    repo,
    tag,
    assetName: "update_files.json",
  });
  if (normalizedVersion(manifest?.version) !== version) throw new Error("热更新清单版本与 GitHub Release 不一致");
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  if (!files.length) throw new Error("官方热更新清单为空");
  const workspace = await prepareWorkspace("xianyu-auto-reply");
  const root = XIANYU_ROOT;
  const backupDir = await createBackupDir("xianyu-auto-reply", version);
  const stagedRows = [];
  for (const item of files) {
    const relative = safeRelativePath(item?.path);
    const staged = join(workspace, "files", relative);
    await download(String(item?.download_url || ""), staged, Number(item?.size) || 0, {
      sha256: item?.sha256,
      policy: { kind: "raw-file", repo, tag, relativePath: relative },
    });
    stagedRows.push({ relative, staged });
  }
  const changed = [];
  try {
    for (const row of stagedRows) {
      const target = resolve(root, row.relative);
      if (!target.startsWith(`${resolve(root)}/`)) throw new Error("更新目标越界");
      const backup = join(backupDir, row.relative);
      if (await exists(target)) { await mkdir(dirname(backup), { recursive: true }); await cp(target, backup, { recursive: true }); }
      const temporary = `${target}.zhitai-update-${process.pid}`;
      await mkdir(dirname(target), { recursive: true });
      await cp(row.staged, temporary);
      await rename(temporary, target);
      changed.push({ target, backup, hadOriginal: await exists(backup) });
    }
    await mkdir(join(root, "static"), { recursive: true });
    await writeFile(join(root, "static", "version.txt"), `v${version}\n`, "utf8");
  } catch (error) {
    for (const row of changed.reverse()) {
      if (row.hadOriginal) await cp(row.backup, row.target, { recursive: true });
      else await rm(row.target, { recursive: true, force: true });
    }
    throw error;
  }
  return { version: `v${version}`, backupPath: backupDir, restartRequired: true, message: "闲鱼客服代码已更新，.env、数据库和登录态未改；重启织台后生效" };
}

export async function installModuleUpdate({ moduleId, expectedVersion = null }) {
  const definition = MODULES[moduleId];
  if (!definition) throw new Error("该模块不支持织台直接更新");
  try {
    let release;
    try { release = await latestRelease(definition.repo); }
    catch (error) {
      release = fallbackRelease(moduleId, definition.repo, expectedVersion);
      if (!release) throw error;
    }
    let result;
    if (moduleId === "matrixmedia") result = await installMatrixMedia(release, expectedVersion);
    else if (moduleId === "xianyu-auto-reply") result = await installXianyu(release, expectedVersion);
    else result = await installSourceModule(moduleId, release, expectedVersion);
    return { ok: true, moduleId, ...result };
  } finally {
    await cleanupModuleWorkspaces(moduleId);
  }
}
