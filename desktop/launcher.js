#!/usr/bin/env node
/* 织台桌面版 · 轻量服务监管（外置引擎托管）
 * 原则：仅在端口未运行时按真实路径启动；记录自启 pid；stopOwned 只结束自启且仍存活的进程；
 *       不碰 3000；单项失败只记 error，不阻断其它模块。
 * 可注入（spawn/httpUp/sleep）供主进程与契约测试复用；同一 id 有 in-flight 防重入。
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const HOME = os.homedir();
const RUNTIME_ROOT = path.resolve(process.env.ZHITAI_RUNTIME_ROOT
  || path.join(HOME, ".local", "share", "zhitai-runtime"));
const APPLICATIONS_ROOT = path.resolve(process.env.ZHITAI_APPLICATIONS_DIR
  || path.join(HOME, "Applications"));

// Finder 的 PATH 通常很短：优先显式配置和织台稳定入口，再检查标准安装位置。
// Electron 自身可通过 ELECTRON_RUN_AS_NODE 作为最终后备，不依赖开发机工具目录。
const NODE_BIN = [
  process.env.ZHITAI_NODE_BIN,
  path.join(RUNTIME_ROOT, "bin", "node"),
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
].filter(Boolean).find((candidate) => fs.existsSync(candidate)) || process.execPath;

const WEB_MARKERS = ["织台 · 内容自动化工作台", "workbench-shell"];
const xhsStartLockDbs = new Map();

function electronRunAsNodeEnv(nodeBin) {
  let resolvedNodeBin = String(nodeBin || "");
  try { resolvedNodeBin = fs.realpathSync(resolvedNodeBin); } catch (_) { /* 按原路径继续判定 */ }

  // 开发版的 runtime/bin/node 可能是指向另一份 Electron 的符号链接，
  // 因此不能只和当前打包应用的 process.execPath 比较。
  const resolvedName = path.basename(resolvedNodeBin).replace(/\.exe$/i, "");
  if (/^electron$/i.test(resolvedName)) return { ELECTRON_RUN_AS_NODE: "1" };

  if (process.versions.electron) {
    let electronExecPath = process.execPath;
    try { electronExecPath = fs.realpathSync(electronExecPath); } catch (_) { /* 按原路径比较 */ }
    if (resolvedNodeBin === electronExecPath) return { ELECTRON_RUN_AS_NODE: "1" };
  }
  return {};
}

let ctx = {
  projectDir: path.resolve(__dirname, ".."),
  runtimeScript: path.join(HOME, ".local/share/zhitai-runtime/scripts/run-local-agent.command"),
  analyzerScript: path.join(__dirname, "..", "scripts", "video-analysis-server.mjs"),
  logDir: path.join(HOME, "Library", "Logs"),
  nodeBin: NODE_BIN,
  xhsAccountsDir: null,
  xhsLegacyCookiesPath: null,
  xhsBinary: null,
  xhsDefaultPort: null,
  spawn: require("node:child_process").spawn, // 可注入
  httpUp: null, // 可注入；默认实现见 httpUp
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function init(options = {}) {
  ctx = { ...ctx, ...options };
}

function logFile(name) {
  return path.join(ctx.logDir, `zhitai-desktop-${name}.log`);
}

async function httpUp(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || (res.status >= 300 && res.status < 400);
  } catch {
    return false;
  }
}

async function isZhitaiPage(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const text = await res.text();
    return WEB_MARKERS.some((m) => text.includes(m));
  } catch {
    return false;
  }
}

async function scanWebPort() {
  for (let port = 3000; port <= 3010; port++) {
    if (await isZhitaiPage(port)) return port;
  }
  return null;
}

// 同步打开日志 fd：createWriteStream 异步打开（fd 为 null），同一 tick 传给 spawn 的 stdio
// 会抛 ERR_INVALID_ARG_VALUE，导致 web/各服务 spawn 失败——必须用同步 fd。
function openLogFd(file, mode = null) {
  const fs = require("node:fs");
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
  const fd = fs.openSync(file, "a", mode || 0o644);
  if (mode) fs.chmodSync(file, mode);
  return fd;
}

function childLike(proc) {
  return proc; // spawn 返回 child；注入的 fake 也须实现 kill/pid/exitCode 语义
}

function spawnDetached(command, args, logName, options = {}) {
  const fs = require("node:fs");
  const fd = openLogFd(options.logPath || logFile(logName), options.logMode || null);
  const child = ctx.spawn(command, args, {
    cwd: options.cwd || ctx.projectDir,
    env: options.env || { ...process.env },
    stdio: ["ignore", fd, fd],
  });
  if (child && typeof child.on === "function") {
    child.on("exit", () => { try { fs.closeSync(fd); } catch (_) {} });
  }
  return childLike(child);
}

function xhsDefaultConfig() {
  const accountsDir = path.resolve(ctx.xhsAccountsDir || process.env.ZHITAI_XHS_ACCOUNTS_DIR
    || path.join(HOME, ".local", "share", "zhitai-runtime", "accounts", "xiaohongshu"));
  const accountDir = path.join(accountsDir, "default");
  const port = Number(ctx.xhsDefaultPort || process.env.ZHITAI_XHS_DEFAULT_PORT || 18060);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("ZHITAI_XHS_DEFAULT_PORT_invalid");
  return {
    accountsDir,
    accountDir,
    port,
    cookiePath: path.join(accountDir, "cookies.json"),
    tokenPath: path.join(accountDir, "auth-token"),
    lockPath: path.join(accountDir, "engine-start.lock"),
    legacyCookiesPath: path.resolve(ctx.xhsLegacyCookiesPath || process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH
      || path.join(HOME, ".local", "share", "zhitai-runtime", "engines", "xiaohongshu-mcp-current", "cookies.json")),
    binary: path.resolve(ctx.xhsBinary || process.env.ZHITAI_XHS_ENGINE_BINARY
      || path.join(HOME, ".local", "share", "zhitai-runtime", "engines", "xiaohongshu-mcp-current", "xiaohongshu-mcp")),
  };
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function openNoFollow(file, flags, mode) {
  return fs.openSync(file, flags | (fs.constants.O_NOFOLLOW || 0), mode);
}

function closeQuietly(fd) {
  if (fd === null || fd === undefined) return;
  try { fs.closeSync(fd); } catch (_) { /* best effort */ }
}

function ensureXhsDefaultState() {
  const config = xhsDefaultConfig();
  ensurePrivateDirectory(config.accountsDir);
  ensurePrivateDirectory(config.accountDir);
  let cookieCreateFd = null;
  try {
    cookieCreateFd = openNoFollow(
      config.cookiePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    let initialCookies = "[]\n";
    if (config.legacyCookiesPath !== config.cookiePath) {
      let legacyFd = null;
      try {
        legacyFd = openNoFollow(config.legacyCookiesPath, fs.constants.O_RDONLY);
        initialCookies = fs.readFileSync(legacyFd);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      } finally {
        closeQuietly(legacyFd);
      }
    }
    fs.writeFileSync(cookieCreateFd, initialCookies);
  } catch (error) {
    // local-agent 可能同时进行首次迁移；复用原子创建的胜出文件。
    if (error?.code !== "EEXIST") throw error;
  } finally {
    closeQuietly(cookieCreateFd);
  }
  let cookieFd = null;
  try {
    cookieFd = openNoFollow(config.cookiePath, fs.constants.O_RDONLY);
    fs.fchmodSync(cookieFd, 0o600);
  } finally {
    closeQuietly(cookieFd);
  }

  let tokenCreateFd = null;
  try {
    tokenCreateFd = openNoFollow(
      config.tokenPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(tokenCreateFd, crypto.randomBytes(32).toString("base64url") + "\n", "utf8");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    closeQuietly(tokenCreateFd);
  }
  let tokenFd = null;
  let token = "";
  try {
    tokenFd = openNoFollow(config.tokenPath, fs.constants.O_RDONLY);
    fs.fchmodSync(tokenFd, 0o600);
    token = fs.readFileSync(tokenFd, "utf8").trim();
  } finally {
    closeQuietly(tokenFd);
  }
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("xhs_default_auth_token_invalid");
  return { ...config, token };
}

function acquireXhsStartLock(config) {
  if (xhsStartLockDbs.has(config.lockPath)) return false;
  const lockDbPath = `${config.lockPath}.sqlite`;
  let lockDb = null;
  try {
    lockDb = new DatabaseSync(lockDbPath);
    fs.chmodSync(lockDbPath, 0o600);
    lockDb.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
    xhsStartLockDbs.set(config.lockPath, lockDb);
    return true;
  } catch (error) {
    try { lockDb?.close(); } catch (_) { /* 未取得锁时只关闭自己的句柄 */ }
    if (/SQLITE_BUSY|database is locked/i.test(String(error?.code || error?.message || ""))) return false;
    throw error;
  }
}

function releaseXhsStartLock(lockPath) {
  if (!lockPath) return;
  const lockDb = xhsStartLockDbs.get(lockPath);
  if (!lockDb) return;
  xhsStartLockDbs.delete(lockPath);
  try { lockDb.exec("COMMIT;"); } catch (_) { /* close 仍会释放 OS 锁 */ }
  try { lockDb.close(); } catch (_) { /* 健康探测仍会防双启动 */ }
}

// 服务清单（真实路径）
function serviceDefs() {
  const xhsConfig = xhsDefaultConfig();
  const mptRoot = path.resolve(process.env.ZHITAI_MPT_ROOT
    || path.join(RUNTIME_ROOT, "engines", "MoneyPrinterTurbo"));
  const goofishRoot = path.resolve(process.env.ZHITAI_GOOFISH_ROOT
    || path.join(APPLICATIONS_ROOT, "ai-goofish-monitor"));
  const xianyuRoot = path.resolve(process.env.ZHITAI_XIANYU_ROOT
    || path.join(APPLICATIONS_ROOT, "xianyu-auto-reply-fix"));
  const wechatMpToolsRoot = path.resolve(process.env.ZHITAI_WECHAT_MP_TOOLS_ROOT
    || path.join(RUNTIME_ROOT, "engines", "wechat-mp-tools-current"));
  return [
    {
      id: "local-agent", label: "本地节点", port: 17890,
      url: "http://127.0.0.1:17890/health",
      start: () => spawnDetached("/bin/zsh", [ctx.runtimeScript], "agent"),
    },
    {
      id: "analyzer", label: "视频分析代理", port: 17900,
      url: "http://127.0.0.1:17900/health",
      // 主进程 process.execPath 是 Electron 二进制；子进程是纯 Node 脚本，必须显式进入 Node 模式
      start: () => spawnDetached(process.execPath, [ctx.analyzerScript], "analyzer", {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      }),
    },
    {
      id: "generator", label: "备用草稿引擎", port: 18080, autoStart: false,
      url: "http://127.0.0.1:18080/openapi.json",
      // MoneyPrinterTurbo 只保留为技术冒烟/备用草稿，不随织台启动；主流程是 GPT 图 → Seedance 2.0。
      start: () => spawnDetached(
        path.join(mptRoot, ".venv", "bin", "uvicorn"),
        ["app.asgi:app", "--host", "127.0.0.1", "--port", "18080"],
        "generator",
        {
          cwd: mptRoot,
          env: { ...process.env, PYTHONUNBUFFERED: "1", NO_PROXY: "localhost,127.0.0.1,::1" },
        },
      ),
    },
    {
      id: "goofish", label: "闲鱼监控", port: 8000,
      url: "http://127.0.0.1:8000/health",
      start: () => spawnDetached(
        path.join(goofishRoot, ".venv", "bin", "python"),
        ["-c", "from src.app import app; import uvicorn; uvicorn.run(app, host='127.0.0.1', port=8000)"],
        "goofish",
        { cwd: goofishRoot, env: { ...process.env, SERVER_PORT: "8000", PYTHONUNBUFFERED: "1" } },
      ),
    },
    {
      id: "reply", label: "闲鱼多账号", port: 18090,
      url: "http://127.0.0.1:18090/health", probeTimeoutMs: 8000,
      start: () => spawnDetached(
        path.join(xianyuRoot, ".venv", "bin", "python"),
        ["Start.py"],
        "reply",
        { cwd: xianyuRoot, env: { ...process.env, PYTHONUNBUFFERED: "1" } },
      ),
    },
    {
      id: "mptools", label: "织台补充采集引擎", port: 5200,
      url: "http://127.0.0.1:5200/",
      // 源码版 Flask 后台，无 pywebview、无独立窗口；页面直接嵌入织台下载页。
      start: () => spawnDetached(
        path.join(wechatMpToolsRoot, ".venv", "bin", "python"),
        ["app.py", "--host", "127.0.0.1", "--port", "5200", "--no-browser"],
        "mptools",
        { cwd: wechatMpToolsRoot, env: { ...process.env, PYTHONUNBUFFERED: "1" } },
      ),
    },
    {
      id: "xhs-publisher", label: "小红书图文发布", port: xhsConfig.port,
      url: `http://127.0.0.1:${xhsConfig.port}/health`,
      start: () => {
        const account = ensureXhsDefaultState();
        if (!acquireXhsStartLock(account)) {
          // local-agent 可能正在按需启动同一 default 实例；返回等待占位，不再双启动。
          return { pid: null, exitCode: null, zhitaiExternalStart: true };
        }
        try {
          const child = spawnDetached(
            account.binary,
            ["-headless=true", `-port=127.0.0.1:${account.port}`],
            "xhs-publisher",
            {
              cwd: account.accountDir,
              logPath: path.join(account.accountDir, "engine.log"),
              logMode: 0o600,
              env: {
                ...process.env,
                AUTH_TOKEN: account.token,
                COOKIES_PATH: account.cookiePath,
                NO_PROXY: "localhost,127.0.0.1,::1",
              },
            },
          );
          child.zhitaiStartLockPath = account.lockPath;
          return child;
        } catch (error) {
          releaseXhsStartLock(account.lockPath);
          throw error;
        }
      },
    },
    {
      id: "web", label: "织台页面", port: null,
      url: null,
      start: () => spawnWeb(),
    },
  ];
}

// 直接用明确 Node 启动 vinext CLI，绕过 npm 生命周期在 Finder 干净环境下偶发卡住的问题。
// PATH 仍前缀 node 目录，供 vinext/插件启动子进程使用。
// NO_PROXY 覆盖三个回环地址：避免本机代理劫持 localhost/127.0.0.1/::1 导致页面 500。
function spawnWeb() {
  const fs = require("node:fs");
  const fd = openLogFd(logFile("ui"));
  const vinextCli = path.join(ctx.projectDir, "node_modules", "vinext", "dist", "cli.js");
  const productionBuild = fs.existsSync(path.join(ctx.projectDir, "dist", "server", "BUILD_ID"));
  // 安装版固定使用 3001，永远不探测/占用 3000（该端口属于用户的其它应用）。
  // 源码调试若还没有 dist 才回退 dev；日常安装版始终运行已复制到 runtime 的生产构建。
  const args = productionBuild
    ? [vinextCli, "start", "--port", "3001", "--hostname", "127.0.0.1"]
    : [vinextCli, "dev", "--port", "3001", "--hostname", "127.0.0.1"];
  const child = ctx.spawn(ctx.nodeBin, args, {
    cwd: ctx.projectDir,
    env: {
      ...process.env,
      PATH: path.dirname(ctx.nodeBin) + (process.env.PATH ? path.delimiter + process.env.PATH : ""),
      ...electronRunAsNodeEnv(ctx.nodeBin),
      NO_PROXY: [
        ...new Set([
          "localhost",
          "127.0.0.1",
          "::1",
          ...String(process.env.NO_PROXY || "").split(",").map((s) => s.trim()).filter(Boolean),
        ]),
      ].join(","),
      WRANGLER_LOG_PATH: path.join(ctx.projectDir, ".wrangler", "wrangler.log"),
    },
    stdio: ["ignore", fd, fd],
  });
  if (child && typeof child.on === "function") {
    child.on("exit", () => { try { fs.closeSync(fd); } catch (_) {} });
  }
  return childLike(child);
}

const owned = new Map();    // id -> child（本次织台自启）
const inflight = new Map(); // id -> promise（防重入）

async function probeUp(def) {
  if (ctx.httpUp) return ctx.httpUp(def.url, def.probeTimeoutMs || 2000);
  return httpUp(def.url, def.probeTimeoutMs || 2000);
}

async function ensureService(defId) {
  // 防重入：同一 id 已有 in-flight 则复用
  if (inflight.has(defId)) return inflight.get(defId);
  const p = doEnsure(defId);
  inflight.set(defId, p);
  try { return await p; } finally { inflight.delete(defId); }
}

async function doEnsure(defId) {
  const def = serviceDefs().find((d) => d.id === defId);
  if (!def) return { id: defId, label: defId, online: false, owned: false, error: "未知服务" };
  const state = { id: def.id, label: def.label, port: def.port, url: def.url, online: false, owned: false, error: null };

  if (def.id === "web") {
    const port = await scanWebPort();
    if (port) { state.online = true; state.port = port; state.url = `http://localhost:${port}`; return state; }
    const child = def.start();
    if (!child) { state.error = "未找到 npm，无法启动织台页面"; return state; }
    owned.set(def.id, child);
    state.owned = true;
    for (let i = 0; i < 40; i++) {
      const p = await scanWebPort();
      if (p) { state.online = true; state.port = p; state.url = `http://localhost:${p}`; return state; }
      await ctx.sleep(750);
    }
    state.error = "织台页面 30 秒内未就绪（请查看桌面版 ui 日志）";
    return state;
  }

  if (await probeUp(def)) { state.online = true; return state; }

  let child;
  try {
    child = def.start();
  } catch (e) {
    state.error = "启动失败：" + String((e && e.message) || e);
    return state;
  }
  if (!child) { state.error = "启动失败：未找到可执行文件"; return state; }
  if (!child.zhitaiExternalStart) {
    owned.set(def.id, child);
    state.owned = true;
  }
  const readyTimeout = def.id === "reply" ? 25 : (def.id === "generator" ? 45 : (def.id === "mptools" ? 15 : (def.id === "xhs-publisher" ? 30 : 12)));
  try {
    for (let i = 0; i < Math.ceil(readyTimeout / 0.75); i++) {
      if (await probeUp(def)) { state.online = true; break; }
      await ctx.sleep(750);
    }
    if (!state.online) {
      state.error = `服务未在 ${readyTimeout} 秒内就绪（端口 ${def.port}），请查看桌面版 ${def.id} 日志`;
    }
  } finally {
    // 仅 launcher 自己取得的锁由 launcher 释放；外部启动占位绝不删除别人的锁。
    if (child.zhitaiStartLockPath) releaseXhsStartLock(child.zhitaiStartLockPath);
  }
  return state;
}

async function ensureServices() {
  const states = [];
  for (const def of serviceDefs()) {
    try {
      if (def.autoStart === false) {
        const online = await probeUp(def);
        states.push({
          id: def.id,
          label: def.label,
          port: def.port,
          url: def.url,
          online,
          owned: false,
          onDemand: true,
          error: null,
        });
        continue;
      }
      states.push(await ensureService(def.id));
    } catch (e) {
      states.push({ id: def.id, label: def.label, port: def.port, url: def.url, online: false, owned: false, error: String((e && e.message) || e) });
    }
  }
  return states;
}

async function getStates() {
  const out = [];
  for (const def of serviceDefs()) {
    let online = false;
    if (def.id === "web") {
      const port = await scanWebPort();
      online = Boolean(port);
      out.push({ id: def.id, label: def.label, port, url: port ? `http://localhost:${port}` : null, online, owned: owned.has(def.id), error: null });
      continue;
    }
    online = await probeUp(def);
    out.push({
      id: def.id,
      label: def.label,
      port: def.port,
      url: def.url,
      online,
      owned: owned.has(def.id),
      onDemand: def.autoStart === false || undefined,
      error: null,
    });
  }
  return out;
}

async function waitWebReady(seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const port = await scanWebPort();
    if (port) return `http://localhost:${port}`;
    await ctx.sleep(1000);
  }
  return null;
}

function isAlive(child) {
  if (!child || typeof child.pid !== "number") return false;
  try { process.kill(child.pid, 0); return true; } catch { return false; }
}

// 只结束本次真正自启且仍存活的子进程；原先已在线服务不在 owned 中，不会动
function stopOwned() {
  for (const [id, child] of owned) {
    // 本地节点承担文件传输助手的不定时接收，不能随织台窗口退出。
    // LaunchAgent 会继续监管；即使本次由桌面版临时拉起，也保留到系统接管。
    if (id === "local-agent") continue;
    try {
      if (child && typeof child.kill === "function" && isAlive(child)) child.kill("SIGTERM");
    } catch (_) { /* 尽力而为 */ }
  }
  const localAgent = owned.get("local-agent");
  owned.clear();
  if (localAgent) owned.set("local-agent", localAgent);
}

module.exports = {
  init, ensureServices, ensureService, getStates, stopOwned, waitWebReady,
  scanWebPort, isZhitaiPage, httpUp, isAlive, WEB_MARKERS, NODE_BIN,
};
